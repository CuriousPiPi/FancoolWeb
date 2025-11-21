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
import psutil
import threading
from dataclasses import dataclass, asdict
from concurrent.futures import ThreadPoolExecutor, Future

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

def _find_logical_root(fs_path: str) -> str:
    try:
        names = os.listdir(fs_path)
    except Exception:
        return fs_path
    dirs = [n for n in names if os.path.isdir(os.path.join(fs_path, n))]
    files = [n for n in names if os.path.isfile(os.path.join(fs_path, n))]
    if not files and len(dirs) == 1:
        return os.path.join(fs_path, dirs[0])
    return fs_path

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

def _scan_strict_and_hash(fs_path: str) -> Tuple[List[Dict[str, Any]], str]:
    logical_root = _find_logical_root(fs_path)
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

def _cleanup_unbound_audio_internal():
    """
    后台内部清理逻辑：
      - 枚举 AUDIO_ROOT 下 UUIDv4 目录；
      - 找出未出现在 audio_perf_binding.audio_batch_id 中的目录；
      - 对每个未绑定目录：
          * 删除物理目录；
          * 若 audio_batch 中存在同名记录，则将 fs_state='missing', fs_path 置空（或保留旧值）；
      - 仅用于后端自调（如 upload_zip 成功后），不返回 HTTP 响应。
    """
    try:
        eng = _engine()
    except Exception:
        # 没有 ADMIN_ENGINE 就直接返回
        return

    try:
        with eng.begin() as conn:
            rows = conn.execute(text("""
                SELECT DISTINCT audio_batch_id
                FROM audio_perf_binding
                WHERE audio_batch_id IS NOT NULL AND audio_batch_id <> ''
            """)).fetchall()
        bound_ids = {
            (getattr(r, '_mapping', {}) or {}).get('audio_batch_id')
            for r in rows
            if (getattr(r, '_mapping', {}) or {}).get('audio_batch_id')
        }
    except Exception as e:
        current_app.logger.exception('[calib] cleanup-unbound-audio: read bindings failed: %s', e)
        return

    def _is_uuid4(name: str) -> bool:
        try:
            u = uuid.UUID(name, version=4)
            return str(u) == name
        except Exception:
            return False

    deleted = 0
    total_dirs = 0

    try:
        if not os.path.isdir(AUDIO_ROOT):
            _log('cleanup-unbound-audio:skip', reason='no-audio-root')
            return

        for entry in os.listdir(AUDIO_ROOT):
            abs_path = os.path.join(AUDIO_ROOT, entry)
            if not os.path.isdir(abs_path):
                continue
            if not _is_uuid4(entry):
                continue
            total_dirs += 1
            if entry in bound_ids:
                continue

            # 未绑定 -> 删除物理目录
            try:
                shutil.rmtree(abs_path, ignore_errors=True)
            except Exception:
                current_app.logger.exception('[calib] cleanup-unbound-audio: rmtree failed for %s', abs_path)
                continue

            deleted += 1

            # 同步 audio_batch：标记为 missing 并清空 fs_path
            try:
                with eng.begin() as conn:
                    conn.execute(
                        text("""
                            UPDATE audio_batch
                            SET fs_state = 'missing',
                                fs_path  = ''
                            WHERE audio_batch_id = :abid
                        """),
                        {'abid': entry}
                    )
            except Exception:
                current_app.logger.exception('[calib] cleanup-unbound-audio: mark missing failed for %s', entry)

        _log('cleanup-unbound-audio:done', deleted=deleted, total=total_dirs, bound=len(bound_ids))
    except Exception:
        current_app.logger.exception('[calib] cleanup-unbound-audio:fs-scan-failed')
        
@calib_admin_bp.post('/admin/api/calib/upload_zip')
def api_calib_upload_zip():
    """
    新版上传接口（upload-only）：
      - 只负责：解压 + 扫描 + 写入 audio_batch/audio_file；
      - 不再调用 pipeline，不创建 calib_job，不生成频谱；
      - 若命中已有 data_hash，则复用原 audio_batch_id：
          * 若 fs_state != 'present' 或目录不存在，则使用本次上传目录“逻辑复活”该批次；
          * 若 fs_state = 'present' 且目录存在，则删除新解包目录，仅返回已有批次信息；
      - 同时返回该 audio_batch_id 下已有的 audio_perf_binding 绑定，用于前端提示。
    响应 data：
      {
        "audio_batch_id": "...",
        "data_hash": "...",
        "duplicated": 0 or 1,
        "bindings": [
          {
            "model_id": 123,
            "model_name": "XXX",
            "condition_id": 456,
            "condition_name_zh": "YYY",
            "perf_batch_id": "perf-batch-uuid",
            "created_at": "2025-01-01 12:34:56"
          },
          ...
        ]
      }
    """
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)

    # model_id / condition_id 目前只用于校验与日志，可按需改为可选
    model_id_raw = (request.form.get('model_id') or '').strip()
    condition_id_raw = (request.form.get('condition_id') or '').strip()
    try:
        model_id = int(model_id_raw)
        condition_id = int(condition_id_raw)
    except Exception:
        return resp_err('INVALID_INPUT', 'model_id / condition_id 非法')

    f = request.files.get('file')
    if not f:
        return resp_err('INVALID_INPUT', '缺少 zip 文件')

    audio_batch_id = _norm_uuid()
    fs_path = os.path.abspath(os.path.join(AUDIO_ROOT, audio_batch_id))
    _ensure_dir(fs_path)

    # 解压 zip 到 fs_path
    zip_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix='.zip') as tf:
            f.save(tf)
            zip_path = tf.name
        with zipfile.ZipFile(zip_path, 'r') as zf:
            zf.extractall(fs_path)
    except Exception as e:
        try:
            shutil.rmtree(fs_path, ignore_errors=True)
        except Exception:
            pass
        return resp_err('UNZIP_FAIL', f'解包失败: {e}', 500)
    finally:
        if zip_path and os.path.isfile(zip_path):
            try:
                os.remove(zip_path)
            except Exception:
                pass

    # 严格结构扫描 + data_hash
    try:
        files, data_hash = _scan_strict_and_hash(fs_path)
    except ValueError as ve:
        try:
            shutil.rmtree(fs_path, ignore_errors=True)
        except Exception:
            pass
        return resp_err('INVALID_STRUCTURE', str(ve))

    engine = _engine()

    # 先尝试命中已有 data_hash
    exist_abid = None
    try:
        with engine.begin() as conn:
            row = conn.execute(
                text("""
                    SELECT audio_batch_id, fs_state, fs_path
                    FROM audio_batch
                    WHERE data_hash = :dh
                    ORDER BY created_at DESC
                    LIMIT 1
                """),
                {'dh': data_hash}
            ).fetchone()

        if row:
            exist_abid = row._mapping['audio_batch_id']
            old_fs_state = (row._mapping.get('fs_state') or '').strip()
            old_fs_path = (row._mapping.get('fs_path') or '').strip()

            # 判断旧目录是否仍然存在
            old_dir_exists = bool(old_fs_path and os.path.isdir(old_fs_path))

            # 统一策略：
            # - 若旧记录 fs_state != 'present' 或 目录已不存在：
            #     使用本次上传目录“逻辑复活”：更新 fs_path、fs_state='present'
            # - 若旧记录 fs_state='present' 且目录存在：
            #     认为旧目录有效，保留旧目录；删除新 fs_path 目录
            if old_fs_state != 'present' or not old_dir_exists:
                # 逻辑复活：挂载到本次上传目录
                with engine.begin() as conn:
                    conn.execute(
                        text("""
                            UPDATE audio_batch
                            SET fs_path   = :p,
                                fs_state  = 'present',
                                last_used_at = NOW()
                            WHERE audio_batch_id = :abid
                        """),
                        {'p': fs_path, 'abid': exist_abid}
                    )
                # 此时保留新目录，不删除 fs_path
            else:
                # 保留旧目录，删除这次新解压出来的目录
                try:
                    shutil.rmtree(fs_path, ignore_errors=True)
                except Exception:
                    pass
                # 为避免后续混淆，将 fs_path 变量重置为旧路径（虽然后续不再使用）
                fs_path = old_fs_path

            # 查询该 audio_batch 的绑定列表
            bindings = []
            with engine.begin() as conn:
                bind_rows = conn.execute(
                    text("""
                        SELECT 
                          b.model_id, m.model_name,
                          b.condition_id, c.condition_name_zh,
                          b.perf_batch_id, b.created_at
                        FROM audio_perf_binding b
                        LEFT JOIN fan_model m ON m.model_id = b.model_id
                        LEFT JOIN working_condition c ON c.condition_id = b.condition_id
                        WHERE b.audio_batch_id = :ab
                        ORDER BY b.created_at DESC
                    """),
                    {'ab': exist_abid}
                ).fetchall()

            for br in bind_rows or []:
                mp = br._mapping
                bindings.append({
                    'model_id': int(mp['model_id']),
                    'model_name': mp.get('model_name') or None,
                    'condition_id': int(mp['condition_id']),
                    'condition_name_zh': mp.get('condition_name_zh') or None,
                    'perf_batch_id': mp.get('perf_batch_id'),
                    'created_at': str(mp.get('created_at')) if mp.get('created_at') else None,
                })

            # 命中 data_hash：复用已有批次
            resp = resp_ok({
                'audio_batch_id': exist_abid,
                'data_hash': data_hash,
                'duplicated': 1,
                'bindings': bindings,
            }, message='音频已存在，复用已有批次')

            # 上传成功后在后台异步触发一次清理（best-effort，不影响主流程）
            try:
                threading.Thread(
                    target=_cleanup_unbound_audio_internal,
                    name='cleanup-unbound-audio',
                    daemon=True
                ).start()
            except Exception:
                current_app.logger.exception('[calib] spawn cleanup-unbound-audio failed')

            return resp
    except Exception as e:
        current_app.logger.exception('[calib] upload_zip duplicate-check failed: %s', e)
        # 命中检查失败时，继续走“创建新批次”，不当成致命错误

    # 未命中 data_hash：创建新的 audio_batch + audio_file
    try:
        admin_name, _admin_id = _admin_actor()
        with engine.begin() as conn:
            # 插入 audio_batch
            conn.execute(
                text("""
                    INSERT INTO audio_batch
                      (audio_batch_id, data_hash, fs_path, fs_state, created_at, created_by, last_used_at, source_zip_name, comment)
                    VALUES
                      (:abid, :dh, :p, 'present', NOW(), :by, NOW(), :zipname, NULL)
                """),
                {
                    'abid': audio_batch_id,
                    'dh': data_hash,
                    'p': fs_path,
                    'by': admin_name,
                    'zipname': getattr(f, 'filename', None) or None,
                }
            )

            # 插入 audio_file 明细（只保留 audio/awa 且 rpm 不为 None）
            for fi in files or []:
                if fi.get('file_type') not in ('audio', 'awa'):
                    continue
                rpm = fi.get('rpm')
                if rpm is None:
                    continue
                conn.execute(
                    text("""
                        INSERT INTO audio_file
                          (audio_batch_id, rpm, file_type, rel_path, size_bytes, sha256, created_at)
                        VALUES
                          (:abid, :rpm, :tp, :rp, :sz, :sh, NOW())
                    """),
                    {
                        'abid': audio_batch_id,
                        'rpm': int(rpm),
                        'tp': fi['file_type'],
                        'rp': fi['rel_path'],
                        'sz': int(fi['size_bytes']),
                        'sh': fi['sha256'],
                    }
                )

        resp = resp_ok({
            'audio_batch_id': audio_batch_id,
            'data_hash': data_hash,
            'duplicated': 0,
            'bindings': [],
        }, message='上传成功，已创建音频批次（未执行标定）')

        # 上传成功后在后台异步触发一次清理（best-effort，不影响主流程）
        try:
            threading.Thread(
                target=_cleanup_unbound_audio_internal,
                name='cleanup-unbound-audio',
                daemon=True
            ).start()
        except Exception as e:
            current_app.logger.exception('[calib] spawn cleanup-unbound-audio failed: %s', e)

        return resp
    except Exception as e:
        # 写库失败时，尽量清理刚刚解压的目录
        current_app.logger.exception('[calib] upload_zip insert audio_batch failed: %s', e)
        try:
            shutil.rmtree(fs_path, ignore_errors=True)
        except Exception:
            pass
        return resp_err('DB_WRITE_FAIL', f'写入音频批次失败: {e}', 500)

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

    # 新：查询 audio_perf_binding（替代 perf_model_binding）
    sql = """
      SELECT
        b.perf_batch_id,
        b.audio_batch_id,
        b.created_at,
        b.created_by
      FROM audio_perf_binding b
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
            'created_at': str(mp.get('created_at')) if mp.get('created_at') else None,
            'created_by': mp.get('created_by') or None
        })
    return resp_ok({'items': items})

@calib_admin_bp.post('/admin/api/calib/bind-model')
def api_bind_model_to_perf():
    """
    绑定 perf_batch_id 与 audio_batch_id。
    仅写 audio_perf_binding，不再直接执行 pipeline。
    如需预热频谱，可在前端调用 /admin/api/calib/jobs 或直接依赖前台 /api/spectrum-models 自愈。
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

    with _engine().begin() as conn:
        ok = conn.execute(text("""
            SELECT 1 FROM fan_performance_data
            WHERE model_id=:m AND condition_id=:c AND batch_id=:bid
            LIMIT 1
        """), {'m': model_id, 'c': condition_id, 'bid': perf_batch_id}).fetchone()
        if not ok:
            return resp_err('NOT_FOUND', '性能批次不存在或不属于该型号/工况', 404)

        row_ab = conn.execute(text("""
            SELECT audio_batch_id, fs_path, data_hash
            FROM audio_batch
            WHERE audio_batch_id=:abid
            LIMIT 1
        """), {'abid': audio_batch_id}).fetchone()
        if not row_ab:
            return resp_err('NOT_FOUND', '音频批次不存在', 404)

        bound_others = conn.execute(text("""
            SELECT 
              b.model_id, m.model_name,
              b.condition_id, c.condition_name_zh
            FROM audio_perf_binding b
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
                return resp_err('AUDIO_BOUND_CONFLICT',
                                '该音频批次已绑定到其他型号/工况，禁止绑定',
                                409, meta={'bindings': binds})

        admin_name, _admin_id = _admin_actor()
        conn.execute(text("""
            INSERT INTO audio_perf_binding
              (model_id, condition_id, perf_batch_id, audio_batch_id, created_at, created_by)
            VALUES
              (:m,:c,:pb,:ab, NOW(), :by)
            ON DUPLICATE KEY UPDATE
              audio_batch_id=VALUES(audio_batch_id),
              created_by=VALUES(created_by),
              created_at=VALUES(created_at)
        """), {
            'm': model_id, 'c': condition_id, 'pb': perf_batch_id,
            'ab': audio_batch_id,
            'by': admin_name
        })

    # 这里不再预热频谱，交给前台 /api/spectrum-models 或后台手动触发 job
    return resp_ok({
        'perf_batch_id': perf_batch_id,
        'audio_batch_id': audio_batch_id
    }, message='绑定成功')

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

@calib_admin_bp.post('/admin/api/calib/jobs')
def api_calib_create_job():
    """
    管理侧仅作为客户端：转发到用户侧 /api/calib/jobs。
    """
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)

    payload = request.get_json(force=True, silent=True) or {}
    audio_batch_id = (payload.get('audio_batch_id') or '').strip()
    model_id = payload.get('model_id')
    condition_id = payload.get('condition_id')

    if not audio_batch_id or not model_id or not condition_id:
        return resp_err('INVALID_INPUT', '缺少 audio_batch_id / model_id / condition_id')

    import requests
    base = os.getenv('USER_SIDE_BASE_URL', 'http://127.0.0.1:5001')
    try:
        resp = requests.post(
            f"{base}/api/calib/jobs",
            json={
                'audio_batch_id': audio_batch_id,
                'model_id': model_id,
                'condition_id': condition_id
            },
            timeout=10
        )
    except Exception as e:
        return resp_err('UPSTREAM_ERROR', f'调用用户侧标定服务失败: {e}', 502)

    return make_response(resp.content, resp.status_code, resp.headers.items())

@calib_admin_bp.get('/admin/api/calib/jobs/<int:job_id>')
def api_calib_get_job(job_id: int):
    """
    查询单个标定任务状态：转发到用户侧 /api/calib/jobs/<job_id>。
    """
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)

    import requests
    base = os.getenv('USER_SIDE_BASE_URL', 'http://127.0.0.1:5001')
    try:
        resp = requests.get(f"{base}/api/calib/jobs/{job_id}", timeout=10)
    except Exception as e:
        return resp_err('UPSTREAM_ERROR', f'调用用户侧标定服务失败: {e}', 502)

    return make_response(resp.content, resp.status_code, resp.headers.items())

@calib_admin_bp.get('/admin/api/calib/preview')
def api_calib_preview():
    """
    新版预览接口：不再直接调用 pipeline，只读取 audio_spectrum_model 缓存文件。
    入参（query）：
      - job_id (优先)
      - audio_batch_id + model_id + condition_id（备用）
    返回：
      { model: <model_json>, model_id, condition_id }
    """
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)

    job_id_raw = (request.args.get('job_id') or '').strip()
    audio_batch_id = (request.args.get('audio_batch_id') or '').strip()
    mid_raw = (request.args.get('model_id') or '').strip()
    cid_raw = (request.args.get('condition_id') or '').strip()

    job_id = None
    if job_id_raw:
        try:
            job_id = int(job_id_raw)
        except Exception:
            return resp_err('INVALID_INPUT', 'job_id 非法')

    model_id = None
    condition_id = None
    if mid_raw and cid_raw:
        try:
            model_id = int(mid_raw)
            condition_id = int(cid_raw)
        except Exception:
            return resp_err('INVALID_INPUT', 'model_id/condition_id 非法')

    with _engine().begin() as conn:
        if job_id is not None:
            row = conn.execute(text("""
                SELECT j.job_id, j.status, j.model_id, j.condition_id, j.model_hash
                FROM audio_calib_job j
                WHERE j.job_id = :jid
                LIMIT 1
            """), {'jid': job_id}).fetchone()
        elif audio_batch_id and model_id and condition_id:
            row = conn.execute(text("""
                SELECT j.job_id, j.status, j.model_id, j.condition_id, j.model_hash
                FROM audio_calib_job j
                WHERE j.audio_batch_id = :abid
                  AND j.model_id = :mid
                  AND j.condition_id = :cid
                ORDER BY j.finished_at DESC, j.created_at DESC
                LIMIT 1
            """), {'abid': audio_batch_id, 'mid': model_id, 'cid': condition_id}).fetchone()
        else:
            return resp_err('INVALID_INPUT', '请提供 job_id 或 (audio_batch_id, model_id, condition_id)')

    if not row:
        return resp_err('NOT_FOUND', '标定任务不存在', 404)

    mp = row._mapping
    if mp.get('status') != 'success':
        return resp_err('JOB_NOT_READY', f'标定任务尚未成功完成，当前状态: {mp.get("status")}', 400)

    mid = int(mp['model_id'])
    cid = int(mp['condition_id'])

    # 直接从 spectrum_cache 读取模型（里面已经带 meta）
    try:
        cur = spectrum_cache.load(mid, cid)
        if not cur or not isinstance(cur, dict):
            return resp_err('MODEL_NOT_FOUND', '频谱模型缓存不存在', 404)
        model_json = cur.get('model') or cur  # 兼容两种结构
    except Exception as e:
        current_app.logger.exception('[calib] preview:load_cache_fail')
        return resp_err('CACHE_LOAD_FAIL', f'读取频谱缓存失败: {e}', 500)

    return resp_ok({
        'model': model_json or {},
        'model_id': mid,
        'condition_id': cid
    })

@calib_admin_bp.get('/admin/api/calib/rpm-noise')
def api_admin_calib_rpm_noise():
    """
    新版 rpm-noise 接口：从 audio_calib_job.summary_json 读取 rpm_noise。
    入参优先级：
      - job_id
      - audio_batch_id + model_id + condition_id
    返回：
      {
        items: [{rpm, noise_db}, ...],
        job_id: 123
      }
    """
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)

    job_id_raw = (request.args.get('job_id') or '').strip()
    audio_batch_id = (request.args.get('audio_batch_id') or '').strip()
    mid_raw = (request.args.get('model_id') or '').strip()
    cid_raw = (request.args.get('condition_id') or '').strip()

    job_id = None
    if job_id_raw:
        try:
            job_id = int(job_id_raw)
        except Exception:
            return resp_err('INVALID_INPUT', 'job_id 非法')

    model_id = None
    condition_id = None
    if mid_raw and cid_raw:
        try:
            model_id = int(mid_raw)
            condition_id = int(cid_raw)
        except Exception:
            return resp_err('INVALID_INPUT', 'model_id/condition_id 非法')

    with _engine().begin() as conn:
        if job_id is not None:
            row = conn.execute(text("""
                SELECT job_id, status, summary_json
                FROM audio_calib_job
                WHERE job_id = :jid
                LIMIT 1
            """), {'jid': job_id}).fetchone()
        elif audio_batch_id and model_id and condition_id:
            row = conn.execute(text("""
                SELECT job_id, status, summary_json
                FROM audio_calib_job
                WHERE audio_batch_id = :abid
                  AND model_id = :mid
                  AND condition_id = :cid
                ORDER BY finished_at DESC, created_at DESC
                LIMIT 1
            """), {'abid': audio_batch_id, 'mid': model_id, 'cid': condition_id}).fetchone()
        else:
            return resp_err('INVALID_INPUT', '请提供 job_id 或 (audio_batch_id, model_id, condition_id)')

    if not row:
        return resp_err('NOT_FOUND', '标定任务不存在', 404)

    mp = row._mapping
    if mp.get('status') != 'success':
        return resp_err('JOB_NOT_READY', f'标定任务尚未成功完成，当前状态: {mp.get("status")}', 400)

    summary = None
    raw_summary = mp.get('summary_json')
    if isinstance(raw_summary, str):
        try:
            summary = json.loads(raw_summary)
        except Exception:
            summary = None
    elif isinstance(raw_summary, dict):
        summary = raw_summary

    items = []
    if summary and isinstance(summary.get('rpm_noise'), list):
        for it in summary['rpm_noise']:
            try:
                rpm = int(it.get('rpm'))
                noise_db = float(it.get('noise_db'))
            except Exception:
                continue
            items.append({'rpm': rpm, 'noise_db': noise_db})

    _log('rpm_noise:result', job_id=int(mp['job_id']), count=len(items))
    return resp_ok({'items': items, 'job_id': int(mp['job_id'])})