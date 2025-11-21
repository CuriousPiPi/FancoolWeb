import os
import json
import hashlib
import threading
from dataclasses import dataclass, asdict
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, Future
from typing import Dict, Any, List, Tuple

import psutil
from sqlalchemy import text

from app.curves import spectrum_cache
from app.curves.spectrum_builder import _calc_model_hash as sb_calc_model_hash

# 由 fancoolserver 传入的 SQLAlchemy engine（全局共享）
engine = None  # 由宿主进程在启动时注入
CODE_VERSION = os.getenv('CODE_VERSION', '')

_CALIB_EXEC = ThreadPoolExecutor(max_workers=int(os.getenv('CALIB_JOB_WORKERS', '2')))
_CALIB_INFLIGHT: dict[int, Future] = {}
_CALIB_LOCK = threading.Lock()


@dataclass
class _CpuStats:
    wall_seconds: float
    cpu_core_seconds: float
    mean_total_percent: float
    peak_total_percent: float
    peak_concurrent_cores: float
    peak_threads: int
    samples: int
    details: dict


class _CpuMonitor:
    def __init__(self, interval=0.2):
        self.interval = float(interval)
        self._proc = psutil.Process()
        self._stop = threading.Event()
        self._thread = None
        self._t0 = 0.0
        self._t1 = 0.0
        self._samples = 0
        self._sum_area = 0.0
        self._sum_percent_dt = 0.0
        self._sum_dt = 0.0
        self._peak_percent = 0.0
        self._peak_threads = 0

    def _all(self):
        procs = [self._proc]
        try:
            procs += self._proc.children(recursive=True)
        except Exception:
            pass
        out = []
        for p in procs:
            try:
                if p.is_running() and p.status() != psutil.STATUS_ZOMBIE:
                    out.append(p)
            except Exception:
                continue
        return out

    def _prime(self):
        for p in self._all():
            try:
                p.cpu_percent(None)
            except Exception:
                pass

    def _loop(self):
        import time as _time
        self._t0 = _time.perf_counter()
        self._prime()
        last = _time.perf_counter()
        while not self._stop.is_set():
            now = _time.perf_counter()
            dt = now - last
            if dt <= 0:
                dt = self.interval
            last = now
            total_percent = 0.0
            threads_total = 0
            for p in self._all():
                try:
                    total_percent += p.cpu_percent(None)
                    threads_total += p.num_threads()
                except Exception:
                    continue
            self._samples += 1
            self._sum_area += (total_percent / 100.0) * dt
            self._sum_percent_dt += total_percent * dt
            self._sum_dt += dt
            if total_percent > self._peak_percent:
                self._peak_percent = total_percent
            if threads_total > self._peak_threads:
                self._peak_threads = threads_total
            _time.sleep(self.interval)
        self._t1 = _time.perf_counter()

    def start(self):
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="CpuMon", daemon=True)
        self._thread.start()

    def stop(self) -> _CpuStats:
        self._stop.set()
        if self._thread:
            self._thread.join()
        wall = (self._t1 or __import__('time').perf_counter()) - self._t0
        mean_percent = (self._sum_percent_dt / self._sum_dt) if self._sum_dt > 0 else 0.0
        return _CpuStats(
            wall_seconds=wall,
            cpu_core_seconds=self._sum_area,
            mean_total_percent=mean_percent,
            peak_total_percent=self._peak_percent,
            peak_concurrent_cores=self._peak_percent / 100.0,
            peak_threads=self._peak_threads,
            samples=self._samples,
            details={
                "cpu_count_logical": psutil.cpu_count(logical=True),
                "cpu_count_physical": psutil.cpu_count(logical=False),
            }
        )


def _engine():
    if engine is None:
        raise RuntimeError("calib_worker.engine is not initialized")
    return engine


def _load_default_calib_params() -> Dict[str, Any]:
    """
    从 audio_calibration_params 中取 is_default=1 最新一条。
    """
    with _engine().begin() as conn:
        row = conn.execute(text("""
            SELECT params_json
            FROM audio_calibration_params
            WHERE is_default = 1
            ORDER BY updated_at DESC
            LIMIT 1
        """)).fetchone()
    if not row:
        raise RuntimeError('未在 audio_calibration_params 中找到 is_default=1 的默认参数记录')
    val = row._mapping.get('params_json')
    if isinstance(val, dict):
        return val
    if isinstance(val, str) and val.strip():
        return json.loads(val)
    raise RuntimeError('默认参数记录 params_json 为空或类型非法')


def _run_inproc_and_collect(work_dir: str,
                            params: Dict[str, Any],
                            model_id: int,
                            condition_id: int) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """
    在进程内调用 audio_calib.pipeline.run_calibration_and_model，并注入 CPU 统计。
    """
    import sys
    CURVES_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    if CURVES_DIR not in sys.path:
        sys.path.append(CURVES_DIR)
    from app.audio_calib.pipeline import run_calibration_and_model as _rcm  # 调整为包内导入

    mon = _CpuMonitor(interval=0.2)
    mon.start()
    try:
        model, rows = _rcm(work_dir, params, out_dir=None,
                           model_id=model_id, condition_id=condition_id)
    finally:
        cpu_stats = mon.stop()

    try:
        calib = model.get("calibration") or {}
        timings = calib.get("timings") or {}
        timings["cpu_stats_overall"] = asdict(cpu_stats)
        calib["timings"] = timings
        model["calibration"] = calib
    except Exception:
        pass

    return model, rows


def ensure_calib_job(audio_batch_id: str,
                     model_id: int,
                     condition_id: int) -> Dict[str, Any]:
    """
    根据 (audio_batch_id, model_id, condition_id, param_hash, CODE_VERSION)
    创建或复用一条 audio_calib_job 记录。
    """
    params = _load_default_calib_params()
    param_hash = hashlib.sha1(
        json.dumps(params, sort_keys=True, separators=(',', ':')).encode('utf-8')
    ).hexdigest()
    code_ver = CODE_VERSION or ''

    with _engine().begin() as conn:
        ab = conn.execute(text("""
            SELECT audio_batch_id, fs_state
            FROM audio_batch
            WHERE audio_batch_id = :abid
            LIMIT 1
        """), {'abid': audio_batch_id}).fetchone()
        if not ab:
            raise RuntimeError('audio_batch 不存在')
        if ab._mapping.get('fs_state') != 'present':
            raise RuntimeError('该音频批次已被清理，无法创建标定任务')

        row = conn.execute(text("""
            SELECT *
            FROM audio_calib_job
            WHERE audio_batch_id = :abid
              AND model_id = :mid
              AND condition_id = :cid
              AND param_hash = :ph
              AND code_version = :cv
            ORDER BY created_at DESC
            LIMIT 1
        """), {
            'abid': audio_batch_id,
            'mid': model_id,
            'cid': condition_id,
            'ph': param_hash,
            'cv': code_ver
        }).fetchone()
        if row:
            return dict(row._mapping)

        r = conn.execute(text("""
            INSERT INTO audio_calib_job
              (audio_batch_id, model_id, condition_id, param_hash, code_version,
               status, priority, created_at)
            VALUES
              (:abid, :mid, :cid, :ph, :cv, 'pending', 'normal', NOW())
        """), {
            'abid': audio_batch_id,
            'mid': model_id,
            'cid': condition_id,
            'ph': param_hash,
            'cv': code_ver
        })
        job_id = int(r.lastrowid)
        row2 = conn.execute(text("""
            SELECT *
            FROM audio_calib_job
            WHERE job_id = :jid
            LIMIT 1
        """), {'jid': job_id}).fetchone()
        return dict(row2._mapping)


def _calib_worker_inner(app_logger, job_id: int):
    """
    单个 job 的执行逻辑（不依赖 Flask 上下文，只用 logger）。
    """
    app_logger.info('[calib] worker start job_id=%s, pid=%s', job_id, os.getpid())
    eng = _engine()

    try:
        with eng.begin() as conn:
            row = conn.execute(text("""
                SELECT j.*, b.fs_path, b.data_hash
                FROM audio_calib_job j
                JOIN audio_batch b ON b.audio_batch_id = j.audio_batch_id
                WHERE j.job_id = :jid
                LIMIT 1
            """), {'jid': job_id}).fetchone()
            if not row:
                return
            mp = row._mapping
            fs_path = mp.get('fs_path')
            data_hash = mp.get('data_hash')
            audio_batch_id = mp.get('audio_batch_id')
            model_id = int(mp.get('model_id'))
            condition_id = int(mp.get('condition_id'))
            param_hash = mp.get('param_hash')
            code_ver = mp.get('code_version')

            conn.execute(text("""
                UPDATE audio_calib_job
                SET status = 'running',
                    queued_at = COALESCE(queued_at, NOW()),
                    started_at = NOW()
                WHERE job_id = :jid AND status IN ('pending','running')
            """), {'jid': job_id})

        params = _load_default_calib_params()
        real_hash = hashlib.sha1(
            json.dumps(params, sort_keys=True, separators=(',', ':')).encode('utf-8')
        ).hexdigest()
        if real_hash != param_hash:
            raise RuntimeError(
                f'参数哈希不一致：job.param_hash={param_hash}, current={real_hash}'
            )

        model_json, per_rpm_rows = _run_inproc_and_collect(
            fs_path, params, model_id, condition_id
        )

        model_hash = sb_calc_model_hash(data_hash, param_hash, code_ver or None)
        built_at = datetime.utcnow().isoformat(timespec='seconds') + 'Z'
        cache_saved = spectrum_cache.save(
            model_json or {},
            model_id=model_id,
            condition_id=condition_id,
            extra_meta={
                'audio_batch_id': audio_batch_id,
                'audio_data_hash': data_hash,
                'param_hash': param_hash,
                'code_version': code_ver,
                'built_at': built_at,
            }
        )
        cache_path = cache_saved.get('path') or spectrum_cache.path(model_id, condition_id)

        rpms = [int(r['rpm']) for r in per_rpm_rows
                if isinstance(r.get('rpm'), int) and r['rpm'] > 0]
        rpm_min = min(rpms) if rpms else None
        rpm_max = max(rpms) if rpms else None
        rpm_noise = []
        for r in per_rpm_rows:
            if not isinstance(r.get('rpm'), int) or r['rpm'] <= 0:
                continue
            noise_db = r.get('la_post_env_db')
            if noise_db is None:
                continue
            rpm_noise.append({
                'rpm': int(r['rpm']),
                'noise_db': round(float(noise_db), 1)
            })
        rpm_noise.sort(key=lambda x: x['rpm'])

        summary = {
            'rpm_min': rpm_min,
            'rpm_max': rpm_max,
            'rpm_noise': rpm_noise,
            'env_la_db': None
        }

        with eng.begin() as conn:
            conn.execute(text("""
                INSERT INTO audio_spectrum_model
                  (model_hash, model_id, condition_id, audio_batch_id, job_id,
                   param_hash, data_hash, code_version, cache_path, built_at, last_used_at)
                VALUES
                  (:mh, :mid, :cid, :abid, :jid,
                   :ph, :dh, :cv, :cp, NOW(), NOW())
                ON DUPLICATE KEY UPDATE
                  audio_batch_id = VALUES(audio_batch_id),
                  job_id        = VALUES(job_id),
                  param_hash    = VALUES(param_hash),
                  data_hash     = VALUES(data_hash),
                  code_version  = VALUES(code_version),
                  cache_path    = VALUES(cache_path),
                  built_at      = VALUES(built_at),
                  last_used_at  = NOW()
            """), {
                'mh': model_hash,
                'mid': model_id,
                'cid': condition_id,
                'abid': audio_batch_id,
                'jid': job_id,
                'ph': param_hash,
                'dh': data_hash,
                'cv': code_ver,
                'cp': cache_path,
            })

            conn.execute(text("""
                UPDATE audio_calib_job
                SET status = 'success',
                    model_hash = :mh,
                    summary_json = :sj,
                    finished_at = NOW(),
                    error_message = NULL
                WHERE job_id = :jid
            """), {
                'mh': model_hash,
                'sj': json.dumps(summary, ensure_ascii=False),
                'jid': job_id
            })

    except Exception as e:
        app_logger.exception('[calib] calib_worker failed for job_id=%s', job_id)
        try:
            with _engine().begin() as conn:
                conn.execute(text("""
                    UPDATE audio_calib_job
                    SET status = 'failed',
                        finished_at = NOW(),
                        error_message = :msg
                    WHERE job_id = :jid
                """), {'msg': str(e), 'jid': job_id})
        except Exception:
            app_logger.exception('[calib] failed to update job status to failed')
    finally:
        with _CALIB_LOCK:
            fut = _CALIB_INFLIGHT.get(job_id)
            if fut and fut.done():
                _CALIB_INFLIGHT.pop(job_id, None)


def submit_calib_job(app_logger, job_id: int):
    """
    调度 job 执行：若未在运行则提交到线程池。
    """
    with _CALIB_LOCK:
        fut = _CALIB_INFLIGHT.get(job_id)
        if not fut or fut.done():
            app_logger.info('[calib] submit worker for job_id=%s', job_id)
            _CALIB_INFLIGHT[job_id] = _CALIB_EXEC.submit(
                _calib_worker_inner, app_logger, job_id
            )
        else:
            app_logger.info('[calib] worker already inflight for job_id=%s', job_id)