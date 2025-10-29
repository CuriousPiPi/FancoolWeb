# -*- coding: utf-8 -*-
import os
import re
import json
import uuid
import shutil
import zipfile
import hashlib
import tempfile
import subprocess
import sys
from typing import Dict, Any, List, Tuple

from flask import Blueprint, request, current_app, jsonify, make_response, session
from sqlalchemy import text

calib_admin_bp = Blueprint('calib_admin', __name__)

APP_DIR = os.path.abspath(os.path.dirname(__file__))
AUDIO_ROOT = os.path.abspath(os.getenv('CALIB_AUDIO_BASE', os.path.join(APP_DIR, '../..', 'data', 'audio')))

CODE_VERSION = os.getenv('CODE_VERSION', '')

_R_RPM = re.compile(r'^(?:[Rr])?(\d+(?:\.\d+)?)$')

def _parse_rpm_loose(part: str) -> float | None:
    """宽松解析目录名中的 RPM：支持 Rxxxx、rxxxx、纯数字，或名称中包含数字"""
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
    
# 新增：严格结构校验 + 路径无关多重集合哈希（仅音频 + .awa）
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
    """
    在目录内“恰好一对”同名不同后缀的 (音频, .awa)，返回相对该目录的文件名。
    若不满足条件则抛出 ValueError。
    """
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
    """
    在逻辑根下搜集 env/ 与 rpm 目录（Rxxxx/rxxxx/纯数字/名称含数字均可，最终取整）。
    返回 env_abs, [(rpm_int, abs_path)...]；若缺 env 或无 rpm 则抛出 ValueError。
    """
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
    # 去重并按 rpm 排序
    uniq = {}
    for r, d in rpm_dirs:
        uniq[r] = d
    rpm_dirs = sorted([(r, uniq[r]) for r in uniq.keys()], key=lambda t: t[0])
    return env_abs, rpm_dirs

def _scan_strict_and_hash(base_path: str) -> Tuple[List[Dict[str, Any]], str]:
    """
    严格结构校验后，返回用于写表的 files 列表（仅音频+awa，带 rpm），以及“路径无关多重集合哈希” data_hash。
    """
    logical_root = _find_logical_root(base_path)
    env_abs, rpm_dirs = _collect_env_and_rpms(logical_root)

    entries: List[Dict[str, Any]] = []
    multiset_lines: List[str] = []

    # env（rpm=0）
    a_name, w_name = _strict_pick_pair(env_abs)
    for fn, ftype in [(a_name, 'audio'), (w_name, 'awa')]:
        abs_p = os.path.join(env_abs, fn)
        st = os.stat(abs_p)
        sha = _sha256_file(abs_p)
        rel = os.path.relpath(abs_p, logical_root)
        entries.append({'rpm': 0, 'file_type': ftype, 'rel_path': rel.replace(os.sep, '/'),
                        'size_bytes': int(st.st_size), 'sha256': sha})
        multiset_lines.append(f'{sha}:{int(st.st_size)}')  # 路径无关

    # 各 rpm
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

    # 路径无关多重集合哈希
    multiset_lines.sort()
    data_hash = _sha1_str('\n'.join(multiset_lines))
    return entries, data_hash

# -------- 通用响应 --------
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

# 替换 _scan_extracted：任意层识别 env 与 RPM；RPM 采用宽松解析
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

def _load_params() -> Dict[str, Any]:
    try:
        with _engine().begin() as conn:
            row = conn.execute(text("SELECT params_json FROM calibration_params WHERE is_default=1 ORDER BY updated_at DESC LIMIT 1")).fetchone()
            if row:
                val = row._mapping.get('params_json')
                if isinstance(val, dict): return val
                if isinstance(val, str) and val.strip():
                    try: return json.loads(val)
                    except Exception: current_app.logger.warning('[calib] params_json TEXT invalid JSON, fallback')
    except Exception: pass
    env_json = os.getenv('CALIB_PARAMS_JSON')
    if env_json:
        try: return json.loads(env_json)
        except Exception: current_app.logger.warning('[calib] CALIB_PARAMS_JSON invalid JSON, fallback')
    return {
        "env_agg_per_frame": 40, "env_agg_per_band": 20, "env_mad_pre_band": True, "env_smooth_bands": 0,
        "meas_agg_per_frame": 40, "meas_agg_per_band": 100, "meas_mad_pre_band": True, "mad_tau": 3.0,
        "snr_ratio_min": 1.0, "trim_head_sec": 0.5, "trim_tail_sec": 0.5, "highpass_hz": 20,
        "n_per_oct": 12, "fmin_hz": 20, "fmax_hz": 20000, "frame_sec": 0.02, "hop_sec": 0.01,
        "band_grid": "iec-decimal", "perfile_median": False
    }

# -------- 内存版优先（健壮导入）--------
def _run_inproc_and_collect(work_dir: str, params: Dict[str, Any], model_id: int, condition_id: int) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    # 1) 绝对导入（admin 是包时）
    try:
        from admin.audio_calib.pipeline import run_calibration_and_model as _rcm
        run_calibration_and_model = _rcm
    except Exception:
        # 2) 相对导入（作为包子模块时）
        try:
            from .audio_calib.pipeline import run_calibration_and_model as _rcm
            run_calibration_and_model = _rcm
        except Exception:
            # 3) 路径导入（无包上下文时）
            audio_dir = os.path.join(APP_DIR, 'audio_calib')
            import importlib.util
            spec = importlib.util.spec_from_file_location("audio_calib_pipeline", os.path.join(audio_dir, "pipeline.py"))
            if not spec or not spec.loader:
                raise ImportError("cannot load audio_calib/pipeline.py")
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            run_calibration_and_model = getattr(mod, 'run_calibration_and_model')
    model, rows = run_calibration_and_model(work_dir, params, out_dir=None, model_id=model_id, condition_id=condition_id)
    return model, rows

# ---------------- 上传zip并处理 ----------------
@calib_admin_bp.post('/admin/api/calib/upload_zip')
def api_calib_upload_zip():
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

    # 严格结构校验 + 路径无关多重集合哈希（仅音频+.awa）
    try:
        files, data_hash = _scan_strict_and_hash(base_path)
    except ValueError as ve:
        try:
            shutil.rmtree(base_path, ignore_errors=True)
        except Exception:
            pass
        return resp_err('INVALID_STRUCTURE', str(ve))

    # 内容级去重：audio_batch.data_hash 唯一（命中则直接复用已有模型并删除临时目录）
    try:
        with _engine().begin() as conn:
            existed = conn.execute(text("SELECT batch_id FROM audio_batch WHERE data_hash=:dh LIMIT 1"),
                                   {'dh': data_hash}).fetchone()
            if existed:
                exist_abid = existed._mapping['batch_id']
                # 最近一次 run
                r = conn.execute(text("""
                    SELECT id, model_hash, preview_model_json, finished_at
                    FROM calib_run
                    WHERE batch_id=:bid
                    ORDER BY finished_at DESC
                    LIMIT 1
                """), {'bid': exist_abid}).fetchone()
                if not r:
                    # 极端：有 audio_batch 无 calib_run，仍视为不可用
                    try: shutil.rmtree(base_path, ignore_errors=True)
                    except Exception: pass
                    return resp_err('AUDIO_EXISTS_NO_RUN', '音频已存在但未找到对应模型')
                rid = int(r._mapping['id'])
                mh  = (r._mapping.get('model_hash') or '').strip()
    
                # 绑定数量
                with _engine().begin() as conn2:
                    bcnt = conn2.execute(text("""
                        SELECT COUNT(1) FROM perf_model_binding WHERE model_hash=:mh
                    """), {'mh': mh}).scalar() or 0
                    # rpm_noise from report
                    rpm_rows = conn2.execute(text("""
                        SELECT rpm, la_post_env_db
                        FROM calib_report_item
                        WHERE run_id=:rid AND rpm IS NOT NULL AND rpm > 0 AND la_post_env_db IS NOT NULL
                        ORDER BY rpm
                    """), {'rid': rid}).fetchall()
                rpm_noise = [{'rpm': int(rr._mapping['rpm']), 'noise_db': float(rr._mapping['la_post_env_db'])} for rr in rpm_rows or []]
    
                # 预览范围（尽力从模型中取）
                try:
                    pm = r._mapping.get('preview_model_json')
                    model_json = json.loads(pm) if isinstance(pm, str) else (pm or {})
                    rpm_min = model_json.get('rpm_min'); rpm_max = model_json.get('rpm_max')
                except Exception:
                    rpm_min = None; rpm_max = None
    
                # 清理刚解包目录
                try: shutil.rmtree(base_path, ignore_errors=True)
                except Exception: pass
    
                return resp_ok({
                    'duplicated': 1,
                    'bound_count': int(bcnt),
                    'batch_id': exist_abid,           # 用于 CalibPreview 预览（按 batchId）
                    'run_id': rid,
                    'model_hash': mh,
                    'rpm_noise': rpm_noise,
                    'rpm_min': rpm_min,
                    'rpm_max': rpm_max
                }, message='音频已存在，复用现有模型')
    except Exception:
        pass
           
    params = _load_params()
    param_hash = hashlib.sha1(json.dumps(params, sort_keys=True, separators=(',',':')).encode('utf-8')).hexdigest()

    # 内存版优先，失败直接报错（不再回退 CLI）
    try:
        preview_model_json, per_rpm_rows = _run_inproc_and_collect(base_path, params, model_id, condition_id)
    except Exception as e_inproc:
        current_app.logger.exception('[calib] in-proc failed: %s', e_inproc)
        with _engine().begin() as conn:
            _insert_audio_batch(conn, batch_id=batch_id, model_id=model_id, condition_id=condition_id, base_path=base_path, data_hash=data_hash)
        return resp_err('CALIB_FAIL', f'处理失败: {e_inproc}', 500)

    with _engine().begin() as conn:
        _insert_audio_batch(conn, batch_id=batch_id, model_id=model_id, condition_id=condition_id, base_path=base_path, data_hash=data_hash)
        _insert_audio_files(conn, batch_id, files)
        run_id = _insert_calib_run(conn, batch_id=batch_id, params_json=params, param_hash=param_hash, data_hash=data_hash, preview_model_json=preview_model_json or {})
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
        'batch_id': batch_id,
        'run_id': run_id,
        'model_hash': _calc_model_hash(data_hash, param_hash, CODE_VERSION or None),
        'rpm_noise': rpm_noise,
        'rpm_min': rpm_min,
        'rpm_max': rpm_max,
    }, message='上传并处理完成')

# ---- DB 写入工具（保持与之前一致） ----
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

def _calc_model_hash(data_hash: str, param_hash: str, code_ver: str|None) -> str:
    s = f"dh={data_hash}|ph={param_hash}|cv={code_ver or ''}"
    return hashlib.sha1(s.encode('utf-8')).hexdigest()

def _insert_calib_run(conn, *, batch_id: str, params_json: Dict[str, Any], param_hash: str, data_hash: str, preview_model_json: Dict[str, Any]) -> int:
    model_hash = _calc_model_hash(data_hash, param_hash, CODE_VERSION or None)
    conn.execute(text("""
        INSERT INTO calib_run (batch_id, param_hash, params_json, data_hash, model_hash, code_version, status, preview_model_json, created_at, finished_at)
        VALUES (:bid,:ph,:pj,:dh,:mh,:ver,'done',:pm, NOW(), NOW())
        ON DUPLICATE KEY UPDATE
          params_json=VALUES(params_json),
          code_version=VALUES(code_version),
          model_hash=VALUES(model_hash),
          status='done',
          preview_model_json=VALUES(preview_model_json),
          finished_at=VALUES(finished_at)
    """), {
        'bid': batch_id,
        'ph': param_hash,
        'pj': json.dumps(params_json, ensure_ascii=False),
        'dh': data_hash,
        'mh': model_hash,
        'ver': CODE_VERSION or None,
        'pm': json.dumps(preview_model_json, ensure_ascii=False)
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

    # 1) DB: 拿 run + model_json
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

    # 2) FS: 目录结构与文件统计（深度扫描）
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

    # 3) Model 关键字段统计
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

    with _engine().begin() as conn:
        row = conn.execute(text("""
            SELECT r.preview_model_json, b.model_id, b.condition_id
            FROM calib_run r
            JOIN audio_batch b ON b.batch_id = r.batch_id
            WHERE r.batch_id = :bid
            ORDER BY r.finished_at DESC
            LIMIT 1
        """), {'bid': batch_id}).fetchone()
        if not row:
            return resp_err('NOT_FOUND', '预览数据不存在', 404)

        raw_model = row._mapping.get('preview_model_json')
        if isinstance(raw_model, str):
            try:
                model_json = json.loads(raw_model)
            except Exception:
                model_json = {}
        else:
            model_json = raw_model or {}
        mid = int(row._mapping['model_id']); cid = int(row._mapping['condition_id'])

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

    # 取出绑定列表；补充该绑定对应的 audio_batch.batch_id（用于预览组件）与 run_id（若能关联）
    sql = """
      SELECT
        b.perf_batch_id,
        b.model_hash,
        b.calib_run_id,
        b.created_at,
        -- 用 model_hash 找到最近一次 calib_run 的 batch_id（音频批次号）
        (SELECT ab.batch_id
         FROM calib_run cr
         JOIN audio_batch ab ON ab.batch_id = cr.batch_id
         WHERE cr.model_hash = b.model_hash
         ORDER BY cr.finished_at DESC
         LIMIT 1) AS audio_batch_id
      FROM perf_model_binding b
      WHERE b.model_id=:m AND b.condition_id=:c
      ORDER BY b.created_at DESC
      LIMIT 20
    """
    rows = []
    with _engine().begin() as conn:
        rows = conn.execute(text(sql), {'m': mid, 'c': cid}).fetchall()

    items = []
    for r in rows or []:
        mp = getattr(r, '_mapping', {})
        items.append({
            'perf_batch_id': mp.get('perf_batch_id'),
            'model_hash': mp.get('model_hash'),
            'calib_run_id': (mp.get('calib_run_id') and int(mp.get('calib_run_id'))) or None,
            'audio_batch_id': mp.get('audio_batch_id') or None,
            'created_at': str(mp.get('created_at')) if mp.get('created_at') else None
        })
    return resp_ok({'items': items})

@calib_admin_bp.get('/admin/api/calib/rpm-noise')
def api_admin_calib_rpm_noise():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    run_id = request.args.get('run_id')
    model_hash = (request.args.get('model_hash') or '').strip()
    rid = None
    if run_id:
        try:
            rid = int(run_id)
        except Exception:
            return resp_err('INVALID_INPUT', 'run_id 非法')
    if not rid and not model_hash:
        return resp_err('INVALID_INPUT', '请提供 run_id 或 model_hash')

    with _engine().begin() as conn:
        if not rid and model_hash:
            rid = conn.execute(text("""
                SELECT id FROM calib_run WHERE model_hash=:mh ORDER BY finished_at DESC LIMIT 1
            """), {'mh': model_hash}).scalar()
            rid = int(rid or 0) if rid else None
        if not rid:
            return resp_err('NOT_FOUND', '未找到 run', 404)
        rows = conn.execute(text("""
            SELECT rpm, la_post_env_db
            FROM calib_report_item
            WHERE run_id=:rid AND rpm IS NOT NULL AND rpm > 0 AND la_post_env_db IS NOT NULL
            ORDER BY rpm
        """), {'rid': rid}).fetchall()

    items = [{'rpm': int(r._mapping['rpm']), 'noise_db': float(r._mapping['la_post_env_db'])} for r in rows or []]
    return resp_ok({'items': items, 'run_id': rid})