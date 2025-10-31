# -*- coding: utf-8 -*-
"""
curves.spectrum_builder
- 面向前台接口的异步频谱重建调度与落盘
"""
from __future__ import annotations
import os
import json
import hashlib
import threading
import time
import logging   # 新增日志
from datetime import datetime
from typing import Dict, Any, Optional, Tuple
from concurrent.futures import ThreadPoolExecutor, Future

from sqlalchemy import create_engine, text

try:
    from . import spectrum_cache
    from .pchip_cache import curve_cache_dir
except Exception:
    import sys
    CURVES_DIR = os.path.abspath(os.path.dirname(__file__))
    if CURVES_DIR not in sys.path:
        sys.path.append(CURVES_DIR)
    import spectrum_cache  # type: ignore
    from pchip_cache import curve_cache_dir  # type: ignore

try:
    import portalocker  # type: ignore
    _HAS_PORTALOCKER = True
except Exception:
    _HAS_PORTALOCKER = False

log = logging.getLogger('curves.spectrum_builder')  # 新增：模块日志

FANDB_DSN = os.getenv('FANDB_DSN', 'mysql+pymysql://localreader:12345678@127.0.0.1/FANDB?charset=utf8mb4')
_engine = create_engine(FANDB_DSN, pool_pre_ping=True, pool_recycle=1800, future=True)
CODE_VERSION = os.getenv('CODE_VERSION', '')

def load_default_params() -> Dict[str, Any]:
    """
    仅从数据库读取默认校准参数；不再提供环境变量或内置默认值的回退。
    读取失败或格式不合法将抛出 ValueError（调用方自行处理）。
    """
    with _engine.begin() as conn:
        row = conn.execute(text("""
            SELECT params_json FROM calibration_params
            WHERE is_default=1
            ORDER BY updated_at DESC
            LIMIT 1
        """)).fetchone()
        if not row:
            raise ValueError("未在数据库中找到默认的校准参数记录（calibration_params.is_default=1）")
        val = row._mapping.get('params_json')
        if isinstance(val, dict):
            return val
        if isinstance(val, str) and val.strip():
            try:
                return json.loads(val)
            except json.JSONDecodeError as e:
                raise ValueError(f"数据库中 params_json 字段解析失败（JSON 格式错误）：{str(e)}") from e
        raise ValueError("数据库中 params_json 字段为空或类型无效（需为 dict 或非空 JSON 字符串）")

def compute_param_hash(params: Dict[str, Any]) -> str:
    s = json.dumps(params, sort_keys=True, separators=(',', ':'))
    return hashlib.sha1(s.encode('utf-8')).hexdigest()

def _calc_model_hash(data_hash: str, param_hash: str, code_ver: Optional[str]) -> str:
    s = f"dh={data_hash}|ph={param_hash}|cv={code_ver or ''}"
    return hashlib.sha1(s.encode('utf-8')).hexdigest()

_LOCK_TIMEOUT_DB = int(os.getenv('CURVE_LOCK_DB_TIMEOUT_SEC', '5'))

def _db_get_lock(key: str, timeout: int) -> bool:
    try:
        with _engine.begin() as conn:
            r = conn.execute(text("SELECT GET_LOCK(:k, :t) AS v"), {'k': key, 't': int(timeout)}).fetchone()
            v = r._mapping.get('v') if r else None
            return bool(v == 1)
    except Exception as e:
        log.warning("GET_LOCK failed: %s", e)
        return False

def _db_release_lock(key: str):
    try:
        with _engine.begin() as conn:
            conn.execute(text("SELECT RELEASE_LOCK(:k)"), {'k': key})
    except Exception:
        pass

class _FileLockCtx:
    def __init__(self, lock_name: str, timeout: int):
        self.lock_name = lock_name
        self.timeout = timeout
        self._fh = None
        self._path = None
    def __enter__(self):
        d = os.path.abspath(curve_cache_dir())
        os.makedirs(d, exist_ok=True)
        self._path = os.path.join(d, f"{self.lock_name}.lock")
        if _HAS_PORTALOCKER:
            self._fh = open(self._path, "a+")
            start = time.time()
            while True:
                try:
                    portalocker.lock(self._fh, portalocker.LOCK_EX | portalocker.LOCK_NB)
                    break
                except Exception:
                    if time.time() - start >= self.timeout:
                        raise TimeoutError("file lock acquire timeout")
                    time.sleep(0.1)
        else:
            start = time.time()
            while True:
                try:
                    fd = os.open(self._path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                    os.close(fd)
                    break
                except FileExistsError:
                    if time.time() - start >= self.timeout:
                        raise TimeoutError("file lock acquire timeout")
                    time.sleep(0.1)
        return self
    def __exit__(self, exc_type, exc_val, exc_tb):
        if _HAS_PORTALOCKER and self._fh:
            try: portalocker.unlock(self._fh)
            except Exception: pass
            try: self._fh.close()
            except Exception: pass
        if self._path:
            try:
                if os.path.isfile(self._path):
                    os.remove(self._path)
            except Exception:
                pass

class _CrossProcessLock:
    def __init__(self, key: str, timeout: int):
        self.key = key
        self.timeout = timeout
        self._db_locked = False
        self._file_lock_ctx: Optional[_FileLockCtx] = None
    def __enter__(self):
        self._db_locked = _db_get_lock(self.key, self.timeout)
        if self._db_locked:
            return self
        self._file_lock_ctx = _FileLockCtx(lock_name=self.key, timeout=self.timeout)
        self._file_lock_ctx.__enter__()
        return self
    def __exit__(self, exc_type, exc_val, exc_tb):
        if self._db_locked:
            _db_release_lock(self.key)
            self._db_locked = False
        if self._file_lock_ctx:
            self._file_lock_ctx.__exit__(exc_type, exc_val, exc_tb)
            self._file_lock_ctx = None

def _run_pipeline_and_collect(work_dir: str, params: Dict[str, Any], model_id: int, condition_id: int) -> Tuple[Dict[str, Any], list[Dict[str, Any]]]:
    """
    优先从项目根目录 pipeline.py 导入 run_calibration_and_model；
    """
    try:
        from audio_calib.pipeline import run_calibration_and_model  # type: ignore
        log.info("pipeline imported from top-level pipeline.py")
        model, rows = run_calibration_and_model(work_dir, params, out_dir=None, model_id=model_id, condition_id=condition_id)
        return model, rows
    except Exception as e:
        log.exception("import/run pipeline failed: %s", e)

    # 动态兜底
    import importlib.util
    cand_paths = [
        os.path.abspath(os.path.join(os.getcwd(), 'pipeline.py')),
    ]
    for p in cand_paths:
        if os.path.isfile(p):
            spec = importlib.util.spec_from_file_location("audio_calib_pipeline_autoload", p)
            if spec and spec.loader:
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)
                fn = getattr(mod, 'run_calibration_and_model', None)
                if fn:
                    log.info("pipeline loaded via importlib from %s", p)
                    model, rows = fn(work_dir, params, out_dir=None, model_id=model_id, condition_id=condition_id)
                    return model, rows
    raise ImportError("cannot locate run_calibration_and_model (pipeline.py)")

def _rebuild_once_and_save(model_id: int, condition_id: int, audio_batch_id: str, base_path: str,
                           params: Dict[str, Any], perf_batch_id: Optional[str] = None) -> Dict[str, Any]:
    param_hash = compute_param_hash(params)
    code_ver = CODE_VERSION or ''

    # 获取 audio_data_hash
    with _engine.begin() as conn:
        row_ab = conn.execute(text("""
            SELECT batch_id, data_hash
            FROM audio_batch
            WHERE batch_id=:bid
            LIMIT 1
        """), {'bid': audio_batch_id}).fetchone()
        if not row_ab:
            log.warning("audio_batch not found: %s", audio_batch_id)
            return {'ok': False, 'error': 'audio_batch_not_found'}

        audio_data_hash = (row_ab._mapping.get('data_hash') or '').strip()
        model_hash = _calc_model_hash(audio_data_hash, param_hash, code_ver or None)

        # 写 running
        conn.execute(text("""
            INSERT INTO calib_run (batch_id, param_hash, params_json, data_hash, model_hash, code_version, status, preview_model_json, created_at, finished_at)
            VALUES (:bid,:ph,:pj,:dh,:mh,:ver,'running',NULL,NOW(),NULL)
            ON DUPLICATE KEY UPDATE
              param_hash=VALUES(param_hash),
              params_json=VALUES(params_json),
              data_hash=VALUES(data_hash),
              model_hash=VALUES(model_hash),
              code_version=VALUES(code_version),
              status='running',
              preview_model_json=NULL,
              finished_at=NULL
        """), {
            'bid': audio_batch_id,
            'ph': param_hash,
            'pj': json.dumps(params, ensure_ascii=False),
            'dh': audio_data_hash,
            'mh': model_hash,
            'ver': code_ver or None
        })

    log.info("rebuild start mid=%s cid=%s batch=%s base_path=%s", model_id, condition_id, audio_batch_id, base_path)

    try:
        model_json, per_rpm_rows = _run_pipeline_and_collect(base_path, params, model_id, condition_id)

        meta_out = {
            'perf_batch_id': perf_batch_id,
            'audio_batch_id': audio_batch_id,
            'audio_data_hash': audio_data_hash,
            'param_hash': param_hash,
            'code_version': code_ver,
            'built_at': datetime.utcnow().isoformat(timespec='seconds') + 'Z'
        }
        saved = spectrum_cache.save(model_json or {}, model_id=model_id, condition_id=condition_id, extra_meta=meta_out)
        out_path = saved.get('path')

        # 写 done + report
        with _engine.begin() as conn:
            rid = conn.execute(text("""
                SELECT id FROM calib_run
                WHERE batch_id=:bid AND param_hash=:ph AND data_hash=:dh
                ORDER BY created_at DESC
                LIMIT 1
            """), {'bid': audio_batch_id, 'ph': param_hash, 'dh': audio_data_hash}).scalar()
            run_id = int(rid or 0)

            if run_id:
                conn.execute(text("DELETE FROM calib_report_item WHERE run_id=:rid"), {'rid': run_id})
                for r in per_rpm_rows or []:
                    conn.execute(text("""
                        INSERT INTO calib_report_item
                        (run_id, rpm, la_awa_db, la_raw_db, delta_raw_db, la_post_env_db, delta_post_env_db)
                        VALUES (:rid, :rpm, :awa, :row, :dr, :post, :dp)
                    """), {
                        'rid': run_id,
                        'rpm': int(r.get('rpm') or 0),
                        'awa': r.get('la_env_db'),
                        'row': r.get('la_raw_db'),
                        'dr': r.get('delta_raw_db'),
                        'post': r.get('la_post_env_db'),
                        'dp': r.get('delta_post_env_db')
                    })
                conn.execute(text("""
                    UPDATE calib_run
                    SET status='done', finished_at=NOW()
                    WHERE id=:rid
                """), {'rid': run_id})

        ok_ids = bool(out_path and os.path.isfile(out_path))
        log.info("rebuild done mid=%s cid=%s ok=%s path=%s", model_id, condition_id, ok_ids, out_path)
        return {'ok': True if ok_ids else False, 'path': out_path}
    except Exception as e:
        log.exception("rebuild failed mid=%s cid=%s: %s", model_id, condition_id, e)
        try:
            with _engine.begin() as conn:
                conn.execute(text("""
                    UPDATE calib_run
                    SET status='fail', finished_at=NOW()
                    WHERE batch_id=:bid
                    ORDER BY created_at DESC
                    LIMIT 1
                """), {'bid': audio_batch_id})
        except Exception:
            pass
        return {'ok': False, 'error': str(e)}

_EXEC_WORKERS = int(os.getenv('CURVE_REBUILD_WORKERS', '4'))
_EXEC = ThreadPoolExecutor(max_workers=max(1, _EXEC_WORKERS))
_INFLIGHT: dict[str, Future] = {}
_INFLIGHT_GUARD = threading.Lock()

def _make_key(mid: int, cid: int) -> str:
    return f"{int(mid)}_{int(cid)}"

def schedule_rebuild(model_id: int, condition_id: int, audio_batch_id: str, base_path: str,
                     params: Optional[Dict[str, Any]] = None, perf_batch_id: Optional[str] = None) -> Future:
    if params is None:
        params = load_default_params()

    key = _make_key(model_id, condition_id)

    with _INFLIGHT_GUARD:
        fut = _INFLIGHT.get(key)
        if fut and not fut.done():
            log.info("reuse inflight rebuild mid=%s cid=%s", model_id, condition_id)
            return fut

        def _job():
            lock_key = f"spectrum_{key}"
            log.info("acquire lock %s", lock_key)
            with _CrossProcessLock(lock_key, _LOCK_TIMEOUT_DB):
                return _rebuild_once_and_save(
                    model_id=model_id,
                    condition_id=condition_id,
                    audio_batch_id=audio_batch_id,
                    base_path=base_path,
                    params=params,
                    perf_batch_id=perf_batch_id
                )

        fut = _EXEC.submit(_job)
        _INFLIGHT[key] = fut

        def _cleanup(_f: Future, _k: str = key):
            with _INFLIGHT_GUARD:
                cur = _INFLIGHT.get(_k)
                if cur is _f:
                    _INFLIGHT.pop(_k, None)
        fut.add_done_callback(_cleanup)

        return fut