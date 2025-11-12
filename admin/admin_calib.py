# -*- coding: utf-8 -*-
import os
import re
import json
import uuid
import shutil
import zipfile
import hashlib
import tempfile
import sys
from typing import Dict, Any, List, Tuple
from datetime import datetime
import time

from flask import Blueprint, request, current_app, jsonify, make_response, session
from sqlalchemy import text

# 频谱缓存与曲线缓存目录（共享模块 + 目录函数）
try:
    from app.curves import spectrum_cache
    from app.curves.pchip_cache import curve_cache_dir
    # 复用统一实现：默认参数与模型 hash
    from app.curves.spectrum_builder import load_default_params as sb_load_default_params, _calc_model_hash as sb_calc_model_hash
except Exception:
    CURVES_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '../app/curves'))
    if CURVES_DIR not in sys.path:
        sys.path.append(CURVES_DIR)
    import spectrum_cache  # type: ignore
    from pchip_cache import curve_cache_dir  # type: ignore
    # 回退导入（同目录）
    from spectrum_builder import load_default_params as sb_load_default_params, _calc_model_hash as sb_calc_model_hash  # type: ignore

calib_admin_bp = Blueprint('calib_admin', __name__)

def _log(stage: str, **kw):
    """
    统一轻量日志：INFO 级别，用于关键阶段标记。
    用法：_log('preview:start', batch_id=batch_id)
    """
    try:
        current_app.logger.info("[calib] %s | %s", stage, json.dumps(kw, ensure_ascii=False, default=str))
    except Exception:
        # 兜底：即使 JSON 序列化失败也不要中断
        current_app.logger.info("[calib] %s | %s", stage, kw)

# 新增：统一获取当前管理员标识（优先 login_name）
def _admin_actor():
    name = (session.get('admin_login_name') or session.get('admin_name') or 'admin')
    try:
        aid = int(session.get('admin_id') or 0)
    except Exception:
        aid = 0
    return name, aid

APP_DIR = os.path.abspath(os.path.dirname(__file__))
AUDIO_ROOT = os.path.abspath(os.getenv('CALIB_AUDIO_BASE', os.path.join(APP_DIR, '../..', 'data', 'audio')))

CODE_VERSION = os.getenv('CODE_VERSION', '')

_R_RPM = re.compile(r'^(?:[Rr])?(\d+(?:\.\d+)?)$')

def _parse_rpm_loose(part: str) -> float | None:
    m = _R_RPM.match(part)
    if m:
        try:
            return float(m.group(1))
        except Exception:
            return None
    try:
        s = re.sub(r'[^0-9.]', '', part)
        return float(s) if s else None
    except Exception:
        return None

def _find_logical_root(base_path: str) -> str:
    try:
        names = os.listdir(base_path)
    except Exception:
        return base_path
    dirs = [n for n in names if os.path.isdir(os.path.join(base_path, n))]
    files = [n for n in names if os.path.isfile(os.path.join(base_path, n))]
    if not files and len(dirs) == 1:
        return os.path.join(base_path, dirs[0])
    return base_path

def _strict_pick_pair(dir_abs: str) -> Tuple[str, str]:
    try:
        names = os.listdir(dir_abs)
    except Exception:
        raise ValueError(f'无法读取目录: {dir_abs}')
    audio = [n for n in names if _guess_is_audio(n)]
    awa   = [n for n in names if _is_awa(n)]
    if len(audio) != 1 or len(awa) != 1:
        raise ValueError('目录内必须恰好存在一对：一个音频文件与一个 .AWA')
    a_base = os.path.splitext(audio[0])[0]
    w_base = os.path.splitext(awa[0])[0]
    if a_base != w_base:
        raise ValueError('音频与 .AWA 的基础文件名必须一致')
    return audio[0], awa[0]

def _collect_env_and_rpms(root_dir: str) -> Tuple[str, List[Tuple[int, str]]]:
    env_abs = None
    rpm_dirs: List[Tuple[int, str]] = []
    for name in os.listdir(root_dir):
        p = os.path.join(root_dir, name)
        if not os.path.isdir(p):
            continue
        if name.lower() == 'env':
            env_abs = p
            continue
        val = _parse_rpm_loose(name)
        if val is not None:
            rpm_dirs.append((int(round(val)), p))
    if not env_abs:
        raise ValueError('根目录下必须存在 env/ 目录')
    if not rpm_dirs:
        raise ValueError('根目录下至少存在一个转速目录（如 R1200 或 1200）')
    uniq = {}
    for r, d in rpm_dirs:
        uniq[r] = d
    rpm_dirs = sorted([(r, uniq[r]) for r in uniq.keys()], key=lambda t: t[0])
    return env_abs, rpm_dirs

def _scan_strict_and_hash(base_path: str) -> Tuple[List[Dict[str, Any]], str]:
    logical_root = _find_logical_root(base_path)
    env_abs, rpm_dirs = _collect_env_and_rpms(logical_root)

    entries: List[Dict[str, Any]] = []
    multiset_lines: List[str] = []

    a_name, w_name = _strict_pick_pair(env_abs)
    for fn, ftype in [(a_name, 'audio'), (w_name, 'awa')]:
        abs_p = os.path.join(env_abs, fn)
        st = os.stat(abs_p)
        sha = _sha256_file(abs_p)
        rel = os.path.relpath(abs_p, logical_root)
        entries.append({'rpm': 0, 'file_type': ftype, 'rel_path': rel.replace(os.sep, '/'),
                        'size_bytes': int(st.st_size), 'sha256': sha})
        multiset_lines.append(f'{sha}:{int(st.st_size)}')

    for rpm, dir_abs in rpm_dirs:
        a_name, w_name = _strict_pick_pair(dir_abs)
        for fn, ftype in [(a_name, 'audio'), (w_name, 'awa')]:
            abs_p = os.path.join(dir_abs, fn)
            st = os.stat(abs_p)
            sha = _sha256_file(abs_p)
            rel = os.path.relpath(abs_p, logical_root)
            entries.append({'rpm': int(rpm), 'file_type': ftype, 'rel_path': rel.replace(os.sep, '/'),
                            'size_bytes': int(st.st_size), 'sha256': sha})
            multiset_lines.append(f'{sha}:{int(st.st_size)}')

    multiset_lines.sort()
    data_hash = _sha1_str('\n'.join(multiset_lines))
    return entries, data_hash

def resp_ok(data=None, message=None, meta=None, http_status=200):
    payload = {'success': True, 'data': data, 'message': message, 'meta': meta or {}}
    return make_response(jsonify(payload), http_status)
def resp_err(code: str, msg: str, http_status=400, meta=None):
    payload = {'success': False, 'error_code': code, 'error_message': msg, 'data': None, 'meta': meta or {}}
    return make_response(jsonify(payload), http_status)

def _engine():
    eng = current_app.config.get('ADMIN_ENGINE')
    if not eng:
        raise RuntimeError('ADMIN_ENGINE is not configured on app')
    return eng

def _norm_uuid() -> str: return str(uuid.uuid4())
def _ensure_dir(p: str): os.makedirs(p, exist_ok=True)

def _sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()
def _sha1_str(s: str) -> str: return hashlib.sha1(s.encode('utf-8')).hexdigest()

def _guess_is_audio(fn: str) -> bool:
    ext = os.path.splitext(fn)[1].lower()
    return ext in ('.wav', '.flac', '.mp3', '.m4a', '.aac', '.ogg')
def _is_awa(fn: str) -> bool: return os.path.splitext(fn)[1].lower() == '.awa'

def _scan_extracted(root_dir: str) -> Tuple[List[Dict[str, Any]], str]:
    files: List[Dict[str, Any]] = []; triples = []
    for base, dirs, fns in os.walk(root_dir):
        rel_base = os.path.relpath(base, root_dir)
        parts = [p for p in rel_base.split(os.sep) if p not in ('.', '')]

        rpm = None
        for part in parts:
            if part.lower() == 'env':
                rpm = 0
                break
            val = _parse_rpm_loose(part)
            if val is not None:
                rpm = int(round(val))
                break

        for fn in fns:
            rel_path = os.path.normpath(os.path.join(rel_base, fn)) if rel_base != '.' else fn
            abspath = os.path.join(root_dir, rel_path)
            try:
                st = os.stat(abspath)
            except FileNotFoundError:
                continue
            size = int(st.st_size); sha = _sha256_file(abspath)
            ftype = 'awa' if _is_awa(fn) else ('audio' if _guess_is_audio(fn) else 'other')
            files.append({
                'rpm': int(rpm) if rpm is not None else None,
                'file_type': ftype,
                'rel_path': rel_path,
                'size_bytes': size,
                'sha256': sha
            })
            triples.append(f'{rel_path}|{size}|{sha}')
    triples.sort()
    return files, _sha1_str('\n'.join(triples))

def _run_inproc_and_collect(work_dir: str, params: Dict[str, Any], model_id: int, condition_id: int) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    CURVES_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '../app'))
    if CURVES_DIR not in sys.path:
        sys.path.append(CURVES_DIR)
    from audio_calib.pipeline import run_calibration_and_model as _rcm
    model, rows = _rcm(work_dir, params, out_dir=None, model_id=model_id, condition_id=condition_id)
    return model, rows

@calib_admin_bp.post('/admin/api/calib/upload_zip')
def api_calib_upload_zip():
    """
    关键变更：
      - 保留 calib_run/report 以便预览与 rpm-noise 明细，但响应不再返回 model_hash；
      - “重复音频”判断依旧通过 audio_batch.data_hash 复用；
      - duplicated=1 分支下，bound_count 统计来自 perf_audio_binding（按 audio_batch_id）。
    """
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)

    model_id = request.form.get('model_id', '').strip()
    condition_id = request.form.get('condition_id', '').strip()
    try:
        model_id = int(model_id); condition_id = int(condition_id)
    except Exception:
        return resp_err('INVALID_INPUT', 'model_id / condition_id 非法')

    f = request.files.get('file')
    if not f:
        return resp_err('INVALID_INPUT', '缺少 zip 文件')

    batch_id = _norm_uuid()
    base_path = os.path.abspath(os.path.join(AUDIO_ROOT, batch_id))
    _ensure_dir(base_path)

    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix='.zip') as tf:
            f.save(tf); zip_path = tf.name
        with zipfile.ZipFile(zip_path, 'r') as zf:
            zf.extractall(base_path)
    except Exception as e:
        try: shutil.rmtree(base_path, ignore_errors=True)
        except Exception: pass
        return resp_err('UNZIP_FAIL', f'解包失败: {e}', 500)
    finally:
        try:
            if os.path.isfile(zip_path): os.remove(zip_path)
        except Exception:
            pass

    try:
        files, data_hash = _scan_strict_and_hash(base_path)
    except ValueError as ve:
        try:
            shutil.rmtree(base_path, ignore_errors=True)
        except Exception:
            pass
        return resp_err('INVALID_STRUCTURE', str(ve))

    # 重复音频复用
    try:
        with _engine().begin() as conn:
            existed = conn.execute(text("SELECT batch_id FROM audio_batch WHERE data_hash=:dh LIMIT 1"),
                                   {'dh': data_hash}).fetchone()
            if existed:
                exist_abid = existed._mapping['batch_id']
                # 取最近一条 calib_run 作为 rpm-noise 来源
                r = conn.execute(text("""
                    SELECT id
                    FROM calib_run
                    WHERE batch_id=:bid
                    ORDER BY finished_at DESC
                    LIMIT 1
                """), {'bid': exist_abid}).fetchone()
                rid = int(r._mapping['id']) if r else None

                with _engine().begin() as conn2:
                    # 新增：取出所有绑定过的 mid,cid，用于前端一致性校验
                    bind_rows = conn2.execute(text("""
                        SELECT 
                          b.model_id, m.model_name,
                          b.condition_id, c.condition_name_zh,
                          b.perf_batch_id, b.created_at
                        FROM perf_audio_binding b
                        LEFT JOIN fan_model m ON m.model_id = b.model_id
                        LEFT JOIN working_condition c ON c.condition_id = b.condition_id
                        WHERE b.audio_batch_id = :ab
                        ORDER BY b.created_at DESC
                    """), {'ab': exist_abid}).fetchall()

                    bindings = []
                    for br in bind_rows or []:
                        mp = getattr(br, '_mapping', {})
                        bindings.append({
                            'model_id': int(mp.get('model_id')),
                            'model_name': mp.get('model_name') or None,
                            'condition_id': int(mp.get('condition_id')),
                            'condition_name_zh': mp.get('condition_name_zh') or None,
                            'perf_batch_id': mp.get('perf_batch_id'),
                            'created_at': str(mp.get('created_at')) if mp.get('created_at') else None
                        })


                    rpm_rows = []
                    if rid:
                        rpm_rows = conn2.execute(text("""
                            SELECT rpm, la_post_env_db
                            FROM calib_report_item
                            WHERE run_id=:rid AND rpm IS NOT NULL AND rpm > 0 AND la_post_env_db IS NOT NULL
                            ORDER BY rpm
                        """), {'rid': rid}).fetchall()
                rpm_noise = [{'rpm': int(rr._mapping['rpm']), 'noise_db': float(rr._mapping['la_post_env_db'])} for rr in rpm_rows or []]
                rpms = [int(rr._mapping['rpm']) for rr in rpm_rows or []]
                rpm_min = min(rpms) if rpms else None
                rpm_max = max(rpms) if rpms else None

                try: shutil.rmtree(base_path, ignore_errors=True)
                except Exception as e:
                    current_app.logger.warning(f"Failed to remove directory {base_path}: {e}")

                # 并确保响应里返回 bindings 字段
                return resp_ok({
                    'duplicated': 1,
                    'bound_count': int(len(bindings)),
                    'bindings': bindings,
                    'batch_id': exist_abid,
                    'run_id': rid,
                    'rpm_noise': rpm_noise,
                    'rpm_min': rpm_min,
                    'rpm_max': rpm_max
                }, message='音频已存在，复用现有模型')
    except Exception:
        pass

    # 首次上传音频：照常运行一次 pipeline，并写入 audio_batch / calib_run / report
    params = sb_load_default_params()
    param_hash = hashlib.sha1(json.dumps(params, sort_keys=True, separators=(',',':')).encode('utf-8')).hexdigest()

    try:
        preview_model_json, per_rpm_rows = _run_inproc_and_collect(base_path, params, model_id, condition_id)
    except Exception as e_inproc:
        with _engine().begin() as conn:
            _insert_audio_batch(conn, batch_id=batch_id, model_id=model_id, condition_id=condition_id, base_path=base_path, data_hash=data_hash)
        return resp_err('CALIB_FAIL', f'处理失败: {e_inproc}', 500)

    with _engine().begin() as conn:
        _insert_audio_batch(conn, batch_id=batch_id, model_id=model_id, condition_id=condition_id, base_path=base_path, data_hash=data_hash)
        _insert_audio_files(conn, batch_id, files)
        run_id = _insert_calib_run(conn, batch_id=batch_id, params_json=params, param_hash=param_hash, data_hash=data_hash, preview_model_json=None)
        _insert_report_items(conn, run_id, per_rpm_rows)

    rpms = [r['rpm'] for r in per_rpm_rows if isinstance(r.get('rpm'), int)]
    rpm_min = min(rpms) if rpms else None; rpm_max = max(rpms) if rpms else None
    rpm_noise = []
    for r in per_rpm_rows:
        if r.get('rpm') is None: continue
        rpm_noise.append({
            'rpm': int(r['rpm']),
            'noise_db': round(float(r['la_post_env_db']), 1) if r.get('la_post_env_db') is not None else None
        })
    rpm_noise.sort(key=lambda x: x['rpm'])

    return resp_ok({
        'batch_id': batch_id,   # audio_batch_id
        'run_id': run_id,
        'rpm_noise': rpm_noise,
        'rpm_min': rpm_min,
        'rpm_max': rpm_max,
        'preview_model': preview_model_json or {}
    }, message='上传并处理完成')

def _insert_audio_batch(conn, *, batch_id, model_id, condition_id, base_path, data_hash):
    conn.execute(text("""
        INSERT INTO audio_batch (batch_id, model_id, condition_id, base_path, data_hash, code_version, is_valid)
        VALUES (:bid, :mid, :cid, :bp, :dh, :ver, 0)
        ON DUPLICATE KEY UPDATE
          model_id=VALUES(model_id), condition_id=VALUES(condition_id),
          base_path=VALUES(base_path), data_hash=VALUES(data_hash),
          code_version=VALUES(code_version), updated_at=NOW()
    """), {'bid': batch_id, 'mid': model_id, 'cid': condition_id, 'bp': base_path, 'dh': data_hash, 'ver': CODE_VERSION or None})

def _insert_audio_files(conn, batch_id: str, files: List[Dict[str, Any]]):
    if not files: return
    to_insert = [f for f in files if f.get('file_type') in ('audio', 'awa') and f.get('rpm') is not None]
    for f in to_insert:
        conn.execute(text("""
            INSERT INTO audio_file (batch_id, rpm, file_type, rel_path, size_bytes, sha256)
            VALUES (:bid,:rpm,:tp,:rp,:sz,:sh)
        """), {'bid': batch_id, 'rpm': int(f['rpm']), 'tp': f['file_type'], 'rp': f['rel_path'], 'sz': int(f['size_bytes']), 'sh': f['sha256']})

def _insert_calib_run(conn, *, batch_id: str, params_json: Dict[str, Any], param_hash: str, data_hash: str, preview_model_json: Dict[str, Any] | None) -> int:
    model_hash = sb_calc_model_hash(data_hash, param_hash, CODE_VERSION or None)
    conn.execute(text("""
        INSERT INTO calib_run (batch_id, param_hash, params_json, data_hash, model_hash, code_version, status, preview_model_json, created_at, finished_at)
        VALUES (:bid,:ph,:pj,:dh,:mh,:ver,'done',NULL, NOW(), NOW())
        ON DUPLICATE KEY UPDATE
          params_json=VALUES(params_json),
          code_version=VALUES(code_version),
          model_hash=VALUES(model_hash),
          status='done',
          preview_model_json=NULL,
          finished_at=VALUES(finished_at)
    """), {
        'bid': batch_id,
        'ph': param_hash,
        'pj': json.dumps(params_json, ensure_ascii=False),
        'dh': data_hash,
        'mh': model_hash,
        'ver': CODE_VERSION or None
    })
    rid = conn.execute(text("""
        SELECT id FROM calib_run WHERE batch_id=:bid AND param_hash=:ph AND data_hash=:dh LIMIT 1
    """), {'bid': batch_id, 'ph': param_hash, 'dh': data_hash}).scalar()
    return int(rid or 0)

def _insert_report_items(conn, run_id: int, per_rpm_rows: List[Dict[str, Any]]):
    if not run_id: return
    conn.execute(text("DELETE FROM calib_report_item WHERE run_id=:rid"), {'rid': run_id})
    for r in per_rpm_rows:
        conn.execute(text("""
            INSERT INTO calib_report_item
            (run_id, rpm, la_awa_db, la_raw_db, delta_raw_db, la_post_env_db, delta_post_env_db)
            VALUES (:rid, :rpm, :awa, :row, :dr, :post, :dp)
        """), {
            'rid': run_id,
            'rpm': int(r.get('rpm') or 0),
            'awa': r.get('la_env_db'),
            'row': r.get('la_raw_db'),
            'dr':  r.get('delta_raw_db'),
            'post': r.get('la_post_env_db'),
            'dp':  r.get('delta_post_env_db')
        })

@calib_admin_bp.get('/admin/api/calib/preview/debug')
def api_calib_preview_debug():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    batch_id = (request.args.get('batch_id') or '').strip()
    if not batch_id:
        return resp_err('INVALID_INPUT', '缺少 batch_id')

    with _engine().begin() as conn:
        row = conn.execute(text("""
            SELECT r.preview_model_json, b.base_path, b.model_id, b.condition_id
            FROM calib_run r
            JOIN audio_batch b ON b.batch_id = r.batch_id
            WHERE r.batch_id = :bid
            ORDER BY r.finished_at DESC LIMIT 1
        """), {'bid': batch_id}).fetchone()
        if not row:
            return resp_err('NOT_FOUND', 'calib_run 未找到该 batch_id', 404)
        raw_model = row._mapping.get('preview_model_json')
        if isinstance(raw_model, str):
            try:
                model_json = json.loads(raw_model)
            except Exception:
                model_json = {}
        else:
            model_json = raw_model or {}
        base_path = row._mapping.get('base_path') or ''
        mid = int(row._mapping['model_id']); cid = int(row._mapping['condition_id'])

    env_dir = os.path.join(base_path, 'env')
    r_dirs = []
    audio_counts = {}

    if os.path.isdir(base_path):
        for base2, dirnames, _ in os.walk(base_path):
            for name in dirnames:
                full = os.path.join(base2, name)
                if name.lower() == 'env':
                    env_dir = full
                else:
                    val = _parse_rpm_loose(name)
                    if val is not None:
                        rel = os.path.relpath(full, base_path).replace(os.sep, '/')
                        r_dirs.append(rel)

        def _cnt(folder):
            if not os.path.isdir(folder): return {'audio': 0, 'awa': 0}
            try:
                fns = os.listdir(folder)
            except Exception:
                return {'audio': 0, 'awa': 0}
            a = sum(1 for fn in fns if _guess_is_audio(fn))
            w = sum(1 for fn in fns if _is_awa(fn))
            return {'audio': a, 'awa': w}

        audio_counts['env'] = _cnt(env_dir)
        for d in r_dirs:
            audio_counts[d] = _cnt(os.path.join(base_path, d))

    centers = model_json.get('centers_hz') or []
    bands = model_json.get('band_models_pchip') or []
    valid_bands = sum(1 for p in bands if p and isinstance(p, dict) and p.get('x'))
    rpm_min = model_json.get('rpm_min'); rpm_max = model_json.get('rpm_max')

    return resp_ok({
        'batch_id': batch_id,
        'db': { 'model_id': mid, 'condition_id': cid },
        'fs': {
            'base_path_exists': bool(os.path.isdir(base_path)),
            'base_path': base_path,
            'env_exists': bool(os.path.isdir(env_dir)),
            'r_dirs': sorted(r_dirs),
            'file_counts': audio_counts
        },
        'model_stats': {
            'centers_len': len(centers),
            'bands_len': len(bands),
            'valid_bands': valid_bands,
            'rpm_min': rpm_min,
            'rpm_max': rpm_max
        }
    }, message='debug')

@calib_admin_bp.get('/admin/api/calib/preview')
def api_calib_preview():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    batch_id = (request.args.get('batch_id') or '').strip()
    if not batch_id:
        return resp_err('INVALID_INPUT', '缺少 batch_id')
    _log('preview:start', batch_id=batch_id)

    with _engine().begin() as conn:
        row = conn.execute(text("""
            SELECT r.batch_id, b.base_path, b.model_id, b.condition_id
            FROM calib_run r
            JOIN audio_batch b ON b.batch_id = r.batch_id
            WHERE r.batch_id = :bid
            ORDER BY r.finished_at DESC
            LIMIT 1
        """), {'bid': batch_id}).fetchone()
        if not row:
            _log('preview:calib_run_missing', batch_id=batch_id)
            return resp_err('NOT_FOUND', '预览数据不存在', 404)
        base_path = row._mapping.get('base_path')
        mid = int(row._mapping['model_id']); cid = int(row._mapping['condition_id'])
    _log('preview:resolved_base', base_path=base_path, model_id=mid, condition_id=cid, base_exists=os.path.isdir(base_path))

    try:
        params = sb_load_default_params()
        t0 = time.time()
        _log('pipeline:start', where='preview', base_path=base_path, model_id=mid, condition_id=cid, code_version=CODE_VERSION)
        model_json, _rows = _run_inproc_and_collect(base_path, params, mid, cid)
        _log('pipeline:done', where='preview', ms=int((time.time()-t0)*1000), rows=len(_rows or []))
    except Exception as e:
        current_app.logger.exception('[calib] preview:build_fail')
        return resp_err('CALIB_FAIL', f'预览生成失败: {e}', 500)

    return resp_ok({
        'model': model_json or {},
        'model_id': mid,
        'condition_id': cid
    })

@calib_admin_bp.get('/admin/api/calib/bindings')
def api_admin_calib_bindings_by_mid_cid():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    try:
        mid = int((request.args.get('model_id') or '0').strip())
        cid = int((request.args.get('condition_id') or '0').strip())
    except Exception:
        return resp_err('INVALID_INPUT', 'model_id/condition_id 非法')
    if mid <= 0 or cid <= 0:
        return resp_err('INVALID_INPUT', '缺少 model_id 或 condition_id')

    # 新：查询 perf_audio_binding（替代 perf_model_binding）
    sql = """
      SELECT
        b.perf_batch_id,
        b.audio_batch_id,
        b.audio_data_hash,
        b.created_at,
        b.created_by
      FROM perf_audio_binding b
      WHERE b.model_id=:m AND b.condition_id=:c
      ORDER BY b.created_at DESC
      LIMIT 20
    """
    with _engine().begin() as conn:
        rows = conn.execute(text(sql), {'m': mid, 'c': cid}).fetchall()

    items = []
    for r in rows or []:
        mp = getattr(r, '_mapping', {})
        items.append({
            'perf_batch_id': mp.get('perf_batch_id'),
            'audio_batch_id': mp.get('audio_batch_id'),
            'audio_data_hash': mp.get('audio_data_hash'),
            'created_at': str(mp.get('created_at')) if mp.get('created_at') else None,
            'created_by': mp.get('created_by') or None
        })
    return resp_ok({'items': items})

@calib_admin_bp.get('/admin/api/calib/rpm-noise')
def api_admin_calib_rpm_noise():
    """
    新增支持 audio_batch_id 查询，便于前端仅基于音频批次取噪音明细。
    优先级：run_id > model_hash > audio_batch_id
    """
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    run_id = request.args.get('run_id')
    model_hash = (request.args.get('model_hash') or '').strip()
    audio_batch_id = (request.args.get('audio_batch_id') or '').strip()

    rid = None
    if run_id:
        try:
            rid = int(run_id)
        except Exception:
            return resp_err('INVALID_INPUT', 'run_id 非法')
    with _engine().begin() as conn:
        if not rid and model_hash:
            rid = conn.execute(text("""
                SELECT id FROM calib_run WHERE model_hash=:mh ORDER BY finished_at DESC LIMIT 1
            """), {'mh': model_hash}).scalar()
            rid = int(rid or 0) if rid else None
        if not rid and audio_batch_id:
            rid = conn.execute(text("""
                SELECT id FROM calib_run WHERE batch_id=:bid ORDER BY finished_at DESC LIMIT 1
            """), {'bid': audio_batch_id}).scalar()
            rid = int(rid or 0) if rid else None
        if not rid:
            return resp_err('INVALID_INPUT', '请提供 run_id 或 audio_batch_id', 400)

        with _engine().begin() as conn:
            rows = conn.execute(text("""
                SELECT rpm, la_post_env_db
                FROM calib_report_item
                WHERE run_id=:rid AND rpm IS NOT NULL AND rpm > 0 AND la_post_env_db IS NOT NULL
                ORDER BY rpm
            """), {'rid': rid}).fetchall()

        items = [{'rpm': int(r._mapping['rpm']), 'noise_db': float(r._mapping['la_post_env_db'])} for r in rows or []]
        _log('rpm_noise:result', run_id=rid, count=len(items))
        return resp_ok({'items': items, 'run_id': rid})

@calib_admin_bp.post('/admin/api/calib/bind-model')
def api_bind_model_to_perf():
    """
    新版绑定：将性能批次(perf_batch_id)绑定到音频批次(audio_batch_id)，并预热频谱缓存。
    入参：model_id, condition_id, perf_batch_id, audio_batch_id
    行为：
      - 校验 perf_batch_id 属于该 mid/cid，校验 audio_batch_id 存在；
      - UPSERT 到 perf_audio_binding（唯一约束 uq_pab_mcp）；
      - 预热频谱缓存：
         * 若现有 {mid}_{cid}_spectrum.json 的 meta 与当前 (audio_data_hash, param_hash, code_version) 一致，仅更新 meta.perf_batch_id；
         * 否则从 audio_batch.base_path 跑一遍 pipeline，生成并覆盖写入（带完整 meta）。
    """
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    data = request.get_json(force=True, silent=True) or {}
    try:
        model_id = int(data.get('model_id') or 0)
        condition_id = int(data.get('condition_id') or 0)
    except Exception:
        return resp_err('INVALID_INPUT', 'model_id/condition_id 非法')

    perf_batch_id = (data.get('perf_batch_id') or '').strip()
    audio_batch_id = (data.get('audio_batch_id') or '').strip()

    if model_id <= 0 or condition_id <= 0 or not perf_batch_id or not audio_batch_id:
        return resp_err('INVALID_INPUT', '缺少必要参数（model_id/condition_id/perf_batch_id/audio_batch_id）')

    # 校验 perf_batch_id 是否属于该 mid/cid
    with _engine().begin() as conn:
        ok = conn.execute(text("""
            SELECT 1 FROM fan_performance_data
            WHERE model_id=:m AND condition_id=:c AND batch_id=:bid
            LIMIT 1
        """), {'m': model_id, 'c': condition_id, 'bid': perf_batch_id}).fetchone()
        if not ok:
            return resp_err('NOT_FOUND', '性能批次不存在或不属于该型号/工况', 404)

        # 读取音频批次信息
        row_ab = conn.execute(text("""
            SELECT batch_id, base_path, data_hash
            FROM audio_batch
            WHERE batch_id=:abid
            LIMIT 1
        """), {'abid': audio_batch_id}).fetchone()
        if not row_ab:
            return resp_err('NOT_FOUND', '音频批次不存在', 404)
        base_path = row_ab._mapping.get('base_path') or ''
        audio_data_hash = (row_ab._mapping.get('data_hash') or '').strip()

        # 新增：强校验同一 audio_batch 仅允许绑定同一 mid,cid
        bound_others = conn.execute(text("""
            SELECT 
              b.model_id, m.model_name,
              b.condition_id, c.condition_name_zh
            FROM perf_audio_binding b
            LEFT JOIN fan_model m ON m.model_id = b.model_id
            LEFT JOIN working_condition c ON c.condition_id = b.condition_id
            WHERE b.audio_batch_id=:ab
        """), {'ab': audio_batch_id}).fetchall()
        if bound_others:
            binds = [{
                'model_id': int(r._mapping['model_id']),
                'model_name': r._mapping.get('model_name'),
                'condition_id': int(r._mapping['condition_id']),
                'condition_name_zh': r._mapping.get('condition_name_zh')
            } for r in bound_others]
            any_diff = any(b['model_id'] != model_id or b['condition_id'] != condition_id for b in binds)
            if any_diff:
                # 将可读的绑定清单放到 meta 里返回，便于前端提示
                return resp_err('AUDIO_BOUND_CONFLICT', '该音频批次已绑定到其他型号/工况，禁止绑定', 409, meta={'bindings': binds})
            
        admin_name, _admin_id = _admin_actor()

        # 建立/更新绑定关系（唯一：model_id, condition_id, perf_batch_id）
        conn.execute(text("""
            INSERT INTO perf_audio_binding
              (model_id, condition_id, perf_batch_id, audio_batch_id, audio_data_hash, created_at, created_by)
            VALUES
              (:m,:c,:pb,:ab,:dh, NOW(), :by)
            ON DUPLICATE KEY UPDATE
              audio_batch_id=VALUES(audio_batch_id),
              audio_data_hash=VALUES(audio_data_hash),
              created_by=VALUES(created_by),
              created_at=VALUES(created_at)
        """), {
            'm': model_id, 'c': condition_id, 'pb': perf_batch_id,
            'ab': audio_batch_id, 'dh': audio_data_hash,
            'by': admin_name
        })

    # 预热：读取当前默认参数，计算 param_hash/code_version
    params = sb_load_default_params()
    param_hash = hashlib.sha1(json.dumps(params, sort_keys=True, separators=(',',':')).encode('utf-8')).hexdigest()
    code_ver = CODE_VERSION or ''

    # 若已存在频谱文件，且 (audio_data_hash,param_hash,code_version) 一致，仅更新 perf_batch_id，避免重算
    cur = spectrum_cache.load(model_id, condition_id)
    if cur and isinstance(cur, dict):
        meta = (cur.get('meta') or {})
        if str(meta.get('audio_data_hash') or '') == audio_data_hash \
           and str(meta.get('param_hash') or '') == param_hash \
           and str(meta.get('code_version') or '') == code_ver:
            # 仅切换 perf_batch_id
            new_meta = dict(meta)
            new_meta['perf_batch_id'] = perf_batch_id
            new_meta['audio_batch_id'] = audio_batch_id
            new_meta['updated_at'] = datetime.utcnow().isoformat(timespec='seconds') + 'Z'
            # 直接复用旧 model 内容，重新落盘
            try:
                spectrum_cache.save(
                    cur.get('model') or {},
                    model_id=model_id,
                    condition_id=condition_id,
                    extra_meta=new_meta
                )
                out_path = spectrum_cache.path(model_id, condition_id)
                return resp_ok({
                    'perf_batch_id': perf_batch_id,
                    'audio_batch_id': audio_batch_id,
                    'audio_data_hash': audio_data_hash,
                    'cache_saved': True,
                    'cache_dir': os.path.abspath(curve_cache_dir()),
                    'cache_path': out_path,
                    'reused_model': True
                }, message='绑定成功（频谱缓存已更新元数据，无需重建）')
            except Exception as e:
                # 明确返回错误，避免静默成功
                return resp_err('CACHE_SAVE_FAIL', f'频谱缓存更新失败: {e}', 500)

    # 重建（音频 + 当前默认参数）
    try:
        model_json, _rows = _run_inproc_and_collect(base_path, params, model_id, condition_id)
        meta_out = {
            'perf_batch_id': perf_batch_id,
            'audio_batch_id': audio_batch_id,
            'audio_data_hash': audio_data_hash,
            'param_hash': param_hash,
            'code_version': code_ver,
            'built_at': datetime.utcnow().isoformat(timespec='seconds') + 'Z'
        }
        saved = spectrum_cache.save(
            model_json or {},
            model_id=model_id,
            condition_id=condition_id,
            extra_meta=meta_out
        )
        out_path = saved.get('path')
        ok_ids = bool(out_path and os.path.isfile(out_path))
        if not ok_ids:
            return resp_err('CACHE_SAVE_FAIL', '频谱缓存落盘失败', 500)
        return resp_ok({
            'perf_batch_id': perf_batch_id,
            'audio_batch_id': audio_batch_id,
            'audio_data_hash': audio_data_hash,
            'cache_saved': True,
            'cache_dir': os.path.abspath(curve_cache_dir()),
            'cache_path': out_path
        }, message='绑定成功')
    except Exception as e:
        # 失败时返回错误，促使前端明确告警（避免“成功但未落盘”）
        return resp_err('PIPELINE_OR_SAVE_FAIL', f'频谱模型重建/落盘失败: {e}', 500)

@calib_admin_bp.get('/admin/api/calib/cache/inspect')
def api_calib_cache_inspect():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    cache_dir_env = os.getenv('CURVE_CACHE_DIR', None)
    cache_dir = os.path.abspath(curve_cache_dir())
    cwd = os.getcwd()
    exists = os.path.isdir(cache_dir)
    files = []
    if exists:
        try:
            for fn in sorted(os.listdir(cache_dir))[:200]:
                p = os.path.join(cache_dir, fn)
                try:
                    st = os.stat(p)
                    files.append({
                        "name": fn,
                        "size": st.st_size,
                        "mtime": datetime.utcfromtimestamp(int(st.st_mtime)).isoformat() + "Z",
                        "is_file": os.path.isfile(p)
                    })
                except Exception:
                    files.append({"name": fn, "error": "stat-failed"})
        except Exception as e:
            return resp_err('IO_ERROR', f'列举缓存目录失败: {e}', 500, meta={"cache_dir": cache_dir, "cwd": cwd, "env": cache_dir_env})
    return resp_ok({
        "env_CURVE_CACHE_DIR": cache_dir_env,
        "cache_dir": cache_dir,
        "cwd": cwd,
        "exists": exists,
        "files": files
    }, message="curve-cache inspect")

@calib_admin_bp.post('/admin/api/calib/cleanup-unbound-audio')
def api_calib_cleanup_unbound_audio():
    """
    前置清理接口：删除音频根目录下未在 perf_audio_binding 中出现的批次目录。

    逻辑：
      1. 查询 perf_audio_binding 中所有 distinct audio_batch_id（已绑定的音频批次）。
      2. 枚举 AUDIO_ROOT 下的一级子目录（仅考虑 UUIDv4 命名的目录）。
      3. 若目录名不在绑定集合中，则递归删除该目录。
      4. 返回删除的目录列表、保留数量及统计信息。

    安全措施：
      - 仅删除目录名符合 UUIDv4 格式且未被绑定的目录。
      - 不依赖 audio_batch 表，严格按“是否已绑定”判定孤儿目录。
      - 如需更严格，可再校验目录是否存在于 audio_batch；此处按需求省略。

    返回:
      {
        deleted: [<目录名>],
        kept: [<目录名>],
        bound_ids_count: <绑定ID数量>,
        total_dirs: <扫描到的符合 UUID 格式的目录总数>
      }
    """
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)

    try:
        with _engine().begin() as conn:
            rows = conn.execute(text("""
                SELECT DISTINCT audio_batch_id
                FROM perf_audio_binding
                WHERE audio_batch_id IS NOT NULL AND audio_batch_id <> ''
            """)).fetchall()
        bound_ids = { (getattr(r, '_mapping', {}) or {}).get('audio_batch_id') for r in rows if (getattr(r, '_mapping', {}) or {}).get('audio_batch_id') }
    except Exception as e:
        return resp_err('DB_READ_FAIL', f'读取绑定记录失败: {e}', 500)

    deleted = []
    kept = []
    total_dirs = 0

    def _is_uuid4(name: str) -> bool:
        try:
            u = uuid.UUID(name, version=4)
            return str(u) == name
        except Exception:
            return False

    try:
        if not os.path.isdir(AUDIO_ROOT):
            return resp_ok({
                'deleted': [],
                'kept': [],
                'bound_ids_count': len(bound_ids),
                'total_dirs': 0
            }, message='音频根目录不存在，跳过清理')

        for entry in os.listdir(AUDIO_ROOT):
            abs_path = os.path.join(AUDIO_ROOT, entry)
            if not os.path.isdir(abs_path):
                continue
            if not _is_uuid4(entry):
                # 仅统计符合 UUIDv4 的音频批次目录
                continue
            total_dirs += 1
            if entry in bound_ids:
                kept.append(entry)
                continue
            # 未绑定 -> 删除
            try:
                shutil.rmtree(abs_path, ignore_errors=True)
                deleted.append(entry)
            except Exception:
                # 删除失败也视为保留（可在后续运维处理）
                kept.append(entry)

    except Exception as e:
        return resp_err('FS_SCAN_FAIL', f'扫描或删除目录失败: {e}', 500)

    # 可选：记录日志
    _log('cleanup-unbound-audio', deleted=len(deleted), kept=len(kept), bound_ids=len(bound_ids), total=total_dirs)

    return resp_ok({
        'deleted': deleted,
        'kept': kept,
        'bound_ids_count': len(bound_ids),
        'total_dirs': total_dirs
    }, message=f'清理完成：删除 {len(deleted)} 个未绑定目录')