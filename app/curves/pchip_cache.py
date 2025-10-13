import os
import json
import math
import hashlib
import logging
import threading
from collections import OrderedDict
from datetime import datetime
from typing import List, Dict, Any, Optional

logger = logging.getLogger("curves.pchip_cache")  # 继承上层日志配置


# =========================
# 配置（通过环境变量可调）
# =========================

#CURVE_SMOOTH_ALPHA_RPM / CURVE_SMOOTH_ALPHA_NOISE：0.0~1.0
#0.0：严格贴近单调矫正后的节点（几乎“穿”原始趋势）
#1.0：节点被拉向全局线性趋势（更“直”）
#CURVE_TENSION_TAU_RPM / CURVE_TENSION_TAU_NOISE：0.0~1.0
#0.0：保持原始 PCHIP 段斜率
#1.0：将段斜率压为 0（段内近似直线，但仍穿“平滑后的节点”）
_ALPHA = {
    "rpm": float(os.getenv("CURVE_SMOOTH_ALPHA_RPM", "0.2")),
    "noise_db": float(os.getenv("CURVE_SMOOTH_ALPHA_NOISE", "0.5")),
}
_TAU = {
    "rpm": float(os.getenv("CURVE_TENSION_TAU_RPM", "0.0")),
    "noise_db": float(os.getenv("CURVE_TENSION_TAU_NOISE", "0.0")),
}   

def reload_curve_params_from_env():
    """
    重新从环境变量加载平滑/张力参数。
    - 无需重启进程即可生效新参数。
    - 不需要清理内存/磁盘缓存：α/τ 已参与缓存键，后续请求会自动 MISS 并重建覆盖。
    """
    old_alpha = dict(_ALPHA)
    old_tau = dict(_TAU)

    _ALPHA["rpm"]      = float(os.getenv("CURVE_SMOOTH_ALPHA_RPM",      str(_ALPHA["rpm"])))
    _ALPHA["noise_db"] = float(os.getenv("CURVE_SMOOTH_ALPHA_NOISE",    str(_ALPHA["noise_db"])))
    _TAU["rpm"]        = float(os.getenv("CURVE_TENSION_TAU_RPM",       str(_TAU["rpm"])))
    _TAU["noise_db"]   = float(os.getenv("CURVE_TENSION_TAU_NOISE",     str(_TAU["noise_db"])))

    logger.info("curve-cache PARAMS RELOADED: ALPHA %s -> %s, TAU %s -> %s", old_alpha, _ALPHA, old_tau, _TAU)

def _env_alpha_for_axis(axis: str) -> float:
    # 从模块常量读取，并夹取到 [0,1]
    ax = _axis_norm(axis)
    val = float(_ALPHA.get(ax, 0.0))
    return max(0.0, min(1.0, val))

def _env_tau_for_axis(axis: str) -> float:
    # 从模块常量读取，并夹取到 [0,1]
    ax = _axis_norm(axis)
    val = float(_TAU.get(ax, 0.0))
    return max(0.0, min(1.0, val))

def _axis_norm(axis: str) -> str:
    return "noise_db" if axis == "noise" else axis

def curve_cache_dir() -> str:
    d = os.getenv("CURVE_CACHE_DIR", "./curve_cache")
    os.makedirs(d, exist_ok=True)
    return d

def _abs_cache_dir() -> str:
    try:
        return os.path.abspath(curve_cache_dir())
    except Exception:
        return curve_cache_dir()

def _env_bool(name: str, default: str = "1") -> bool:
    return (os.getenv(name, default) or "").strip() in ("1", "true", "True", "YES", "yes")

def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except Exception:
        return default

def _env_samples_n() -> int:
    # 可选：将采样点写入缓存文件（开发调试用，生产建议为 0）
    n = _env_int("CURVE_CACHE_SAMPLES_N", 0)
    return max(0, min(2001, n))

def _env_inmem_enable() -> bool:
    return _env_bool("CURVE_CACHE_INMEM_ENABLE", "1")

def _env_inmem_max_models() -> int:
    # 进程内最多缓存多少个模型（按模型个数）
    return max(0, _env_int("CURVE_CACHE_INMEM_MAX_MODELS", 2000))

def _env_inmem_max_points() -> int:
    # 进程内缓存的总“结点数”上限（所有模型的 len(x) 之和），粗略代表内存体量
    return max(0, _env_int("CURVE_CACHE_INMEM_MAX_POINTS", 200000))

def _env_inmem_admit_hits() -> int:
    # 准入策略：同一 key 命中多少次后才放入内存（避免冷门一次性数据占位）
    return max(1, _env_int("CURVE_CACHE_INMEM_ADMIT_HITS", 2))

def _env_inmem_hits_window() -> int:
    # 命中计数字典的最大大小（超限时随机或 FIFO 丢弃旧计数，避免计数字典无限膨胀）
    return max(512, _env_int("CURVE_CACHE_INMEM_HITS_WINDOW", 4096))


# =========================
# In-memory LRU（带权重、双上限）
# =========================
class _InMemLRU:
    def __init__(self, max_models: int, max_points: int):
        self.max_models = int(max_models)
        self.max_points = int(max_points)
        self._lock = threading.Lock()
        self._map: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
        self._points_sum = 0

    def _weight(self, model: Dict[str, Any]) -> int:
        try:
            return int(len(model.get("x", []) or []))
        except Exception:
            return 0

    def get(self, key: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            m = self._map.get(key)
            if m is None:
                return None
            # LRU：最近使用放到尾部
            self._map.move_to_end(key, last=True)
            return m

    def put(self, key: str, model: Dict[str, Any]):
        if self.max_models <= 0 or self.max_points <= 0:
            return
        w = self._weight(model)
        with self._lock:
            # 如果已存在，先删除旧的再插入
            old = self._map.pop(key, None)
            if old is not None:
                self._points_sum -= self._weight(old)
            self._map[key] = model
            self._points_sum += w
            # 逐出直到满足双上限
            evicted = 0
            while (len(self._map) > self.max_models) or (self._points_sum > self.max_points):
                k, v = self._map.popitem(last=False)
                self._points_sum -= self._weight(v)
                evicted += 1
            if evicted:
                logger.info("curve-cache INMEM EVICT: count=%d size=%d pts=%d", evicted, len(self._map), self._points_sum)

    def stats(self) -> Dict[str, int]:
        with self._lock:
            return {"size": len(self._map), "points": self._points_sum}


_INMEM = _InMemLRU(_env_inmem_max_models(), _env_inmem_max_points()) if _env_inmem_enable() else None
_ADMIT_HITS = _env_inmem_admit_hits()
_HITS_WINDOW = _env_inmem_hits_window()
_HITS: Dict[str, int] = {}
_HITS_LOCK = threading.Lock()


def _inmem_key(model_id: int, condition_id: int, axis: str, raw_hash: str) -> str:
    return f"{int(model_id)}|{int(condition_id)}|{_axis_norm(axis)}|{raw_hash}"


def _note_hit(key: str) -> int:
    # 轻量命中计数，控制上限窗口，避免无界增长
    if not _INMEM or _ADMIT_HITS <= 1:
        return _ADMIT_HITS  # 视为已满足
    with _HITS_LOCK:
        cnt = _HITS.get(key, 0) + 1
        _HITS[key] = cnt
        # 简单窗口控制：超窗一半时随机/顺序清理一批（这里用 FIFO 式清理）
        if len(_HITS) > _HITS_WINDOW:
            # 清理前 10% 键
            n_purge = max(1, _HITS_WINDOW // 10)
            for i, k in enumerate(list(_HITS.keys())):
                _HITS.pop(k, None)
                if i + 1 >= n_purge:
                    break
        return cnt


# =========================
# PCHIP 基础
# =========================
def raw_points_hash(xs: List[float], ys: List[float]) -> str:
    pairs = sorted([(float(x), float(y)) for x, y in zip(xs, ys)])
    buf = ";".join(f"{x:.6f}|{y:.6f}" for x, y in pairs)
    return hashlib.sha1(buf.encode("utf-8")).hexdigest()


def _pava_isotonic_non_decreasing(ys: List[float]) -> List[float]:
    n = len(ys)
    if n <= 1:
        return ys[:]
    y = [float(v) for v in ys]
    level = y[:]
    weight = [1.0] * n
    i = 0
    curr_n = n
    while i < curr_n - 1:
        if level[i] > level[i + 1]:
            w = weight[i] + weight[i + 1]
            v = (level[i] * weight[i] + level[i + 1] * weight[i + 1]) / w
            level[i] = v
            weight[i] = w
            j = i
            while j > 0 and level[j - 1] > level[j]:
                w2 = weight[j - 1] + weight[j]
                v2 = (level[j - 1] * weight[j - 1] + level[j] * weight[j]) / w2
                level[j - 1] = v2
                weight[j - 1] = w2
                for k in range(j, curr_n - 1):
                    level[k] = level[k + 1]
                    weight[k] = weight[k + 1]
                curr_n -= 1
                j -= 1
            for k in range(i + 1, curr_n - 1):
                level[k] = level[k + 1]
                weight[k] = weight[k + 1]
            curr_n -= 1
        else:
            i += 1
    out: List[float] = []
    for w, v in zip(weight[:curr_n], level[:curr_n]):
        cnt = int(round(w))
        for _ in range(max(1, cnt)):
            out.append(v)
    if len(out) >= n:
        return out[:n]
    else:
        out.extend([out[-1]] * (n - len(out)))
        return out


def _pchip_slopes_fritsch_carlson(xs: List[float], ys: List[float]) -> List[float]:
    n = len(xs)
    if n < 2:
        return [0.0] * n
    h = [xs[i + 1] - xs[i] for i in range(n - 1)]
    delta = [(ys[i + 1] - ys[i]) / h[i] if h[i] != 0 else 0.0 for i in range(n - 1)]
    m = [0.0] * n
    m[0] = delta[0]
    m[-1] = delta[-1]
    for i in range(1, n - 1):
        if delta[i - 1] * delta[i] > 0:
            m[i] = (delta[i - 1] + delta[i]) / 2.0
        else:
            m[i] = 0.0
    for i in range(n - 1):
        if delta[i] == 0.0:
            m[i] = 0.0
            m[i + 1] = 0.0
        else:
            a = m[i] / delta[i]
            b = m[i + 1] / delta[i]
            s = a * a + b * b
            if s > 9.0:
                t = 3.0 / math.sqrt(s)
                m[i] = t * a * delta[i]
                m[i + 1] = t * b * delta[i]
        if m[i] < 0:
            m[i] = 0.0
        if m[i + 1] < 0:
            m[i + 1] = 0.0
    return m

def eval_pchip(model: Dict[str, Any], x: float) -> float:
    xs = model["x"]
    ys = model["y"]
    ms = model["m"]
    n = len(xs)
    if n == 0:
        return float("nan")
    if n == 1:
        return ys[0]
    if x <= xs[0]:
        x = xs[0]
    if x >= xs[-1]:
        x = xs[-1]
    lo, hi = 0, n - 2
    i = 0
    while lo <= hi:
        mid = (lo + hi) // 2
        if xs[mid] <= x <= xs[mid + 1]:
            i = mid
            break
        if x < xs[mid]:
            hi = mid - 1
        else:
            lo = mid + 1
    else:
        i = max(0, min(n - 2, lo))
    x0 = xs[i]
    x1 = xs[i + 1]
    h = x1 - x0
    t = (x - x0) / h if h != 0 else 0.0
    y0 = ys[i]
    y1 = ys[i + 1]
    m0 = ms[i] * h
    m1 = ms[i + 1] * h
    h00 = (2 * t**3 - 3 * t**2 + 1)
    h10 = (t**3 - 2 * t**2 + t)
    h01 = (-2 * t**3 + 3 * t**2)
    h11 = (t**3 - t**2)
    return h00 * y0 + h10 * m0 + h01 * y1 + h11 * m1

def _ols_linear(xs: List[float], ys: List[float]) -> tuple[float, float]:
    n = len(xs)
    if n == 0:
        return (0.0, 0.0)
    sx = sum(xs); sy = sum(ys)
    sxx = sum(x*x for x in xs)
    sxy = sum(x*y for x, y in zip(xs, ys))
    denom = n * sxx - sx * sx
    if abs(denom) < 1e-12:
        return (sy / n if n else 0.0, 0.0)
    b = (n * sxy - sx * sy) / denom
    a = (sy - b * sx) / n
    return (a, b)

def _blend_nodes_with_trend(xs: List[float], ys_mono: List[float], axis: str) -> List[float]:
    alpha = _env_alpha_for_axis(axis)
    if alpha <= 1e-9:
        return ys_mono[:]
    a, b = _ols_linear(xs, ys_mono)
    ys_lin = [a + b * x for x in xs]
    # 线性插值到“更直”的趋势
    return [(1.0 - alpha) * ym + alpha * yl for ym, yl in zip(ys_mono, ys_lin)]

def _scale_slopes(m: List[float], axis: str) -> List[float]:
    tau = _env_tau_for_axis(axis)
    if tau <= 1e-9:
        return m
    return [(1.0 - tau) * v for v in m]

def build_pchip_model_with_opts(xs_in: List[float], ys_in: List[float], axis: str) -> Optional[Dict[str, Any]]:
    # 清洗/排序/合并同 x
    pairs = []
    for x, y in zip(xs_in, ys_in):
        try:
            xf = float(x); yf = float(y)
            if math.isfinite(xf) and math.isfinite(yf):
                pairs.append((xf, yf))
        except Exception:
            continue
    if not pairs:
        return None
    pairs.sort(key=lambda t: t[0])
    xs: List[float] = []
    ys: List[float] = []
    for x, y in pairs:
        if xs and abs(x - xs[-1]) < 1e-9:
            ys[-1] = (ys[-1] + y) / 2.0
        else:
            xs.append(x); ys.append(y)
    if len(xs) == 1:
        return {"x": xs, "y": ys, "m": [0.0], "x0": xs[0], "x1": xs[0]}

    # 单调矫正（强约束），再按轴做“可控平滑”到线性趋势
    ys_mono = _pava_isotonic_non_decreasing(ys)
    ys_target = _blend_nodes_with_trend(xs, ys_mono, axis)

    # 斜率（保形）并可按轴缩放“曲率”
    m = _pchip_slopes_fritsch_carlson(xs, ys_target)
    m = _scale_slopes(m, axis)

    return {"x": xs, "y": ys_target, "m": m, "x0": xs[0], "x1": xs[-1]}
# =========================
# 磁盘缓存
# =========================
def _model_cache_path(model_id: int, condition_id: int, axis: str) -> str:
    return os.path.join(curve_cache_dir(), f"{int(model_id)}_{int(condition_id)}_{_axis_norm(axis)}.json")

# 新增：删除某轴缓存（包含磁盘 + 进程内 LRU）
def delete_cached_model(model_id: int, condition_id: int, axis: str) -> bool:
    """
    删除指定 (model_id, condition_id, axis) 的缓存文件，并尽量从进程内 LRU 清理该轴的所有版本。
    返回 True 表示磁盘文件被删除（或原本不存在），False 表示删除过程中发生了错误。
    """
    axis = _axis_norm(axis)
    ok = True
    # 磁盘
    p = _model_cache_path(model_id, condition_id, axis)
    try:
        if os.path.exists(p):
            os.remove(p)
            logger.info("curve-cache DELETE: key=%s path=%s", f"{model_id}/{condition_id}/{axis}", p)
    except Exception as e:
        ok = False
        logger.warning("curve-cache DELETE ERROR: key=%s path=%s err=%s", f"{model_id}/{condition_id}/{axis}", p, repr(e))

    # 进程内 LRU：按前缀逐出（raw_hash 不同，但前缀固定）
    try:
        if _INMEM:
            prefix = f"{int(model_id)}|{int(condition_id)}|{axis}|"
            evicted = 0
            # 复制 key 列表避免遍历时修改
            for k in list(_INMEM._map.keys()):
                if k.startswith(prefix):
                    m = _INMEM._map.pop(k, None)
                    if m is not None:
                        _INMEM._points_sum -= _INMEM._weight(m)
                        evicted += 1
            if evicted:
                logger.info("curve-cache INMEM PURGE: prefix=%s evicted=%d size=%d pts=%d",
                            prefix, evicted, len(_INMEM._map), _INMEM._points_sum)
    except Exception as e:
        ok = False
        logger.warning("curve-cache INMEM PURGE ERROR: key=%s err=%s",
                       f"{model_id}/{condition_id}/{axis}", repr(e))
    return ok

def _load_cached_model_if_valid(model_id: int, condition_id: int, axis: str, xs: List[float], ys: List[float]):
    p = _model_cache_path(model_id, condition_id, axis)
    if not os.path.exists(p):
        logger.info("curve-cache MISS (no file): key=%s dir=%s path=%s", f"{model_id}/{condition_id}/{_axis_norm(axis)}", _abs_cache_dir(), p)
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
        expect = _compose_cache_key(xs, ys, axis)
        if not isinstance(data, dict):
            logger.info("curve-cache STALE (not a dict): key=%s path=%s", f"{model_id}/{condition_id}/{_axis_norm(axis)}", p)
            return None
        if data.get("type") != "pchip_v1":
            logger.info("curve-cache STALE (type != pchip_v1): key=%s path=%s type=%s", f"{model_id}/{condition_id}/{_axis_norm(axis)}", p, data.get("type"))
            return None
        req = ("x", "y", "m", "x0", "x1", "axis")
        if any(k not in data for k in req):
            logger.info("curve-cache STALE (missing fields): key=%s path=%s", f"{model_id}/{condition_id}/{_axis_norm(axis)}", p)
            return None
        if data.get("raw_hash") != expect:
            logger.info("curve-cache STALE (hash mismatch): key=%s path=%s expect=%s got=%s",
                        f"{model_id}/{condition_id}/{_axis_norm(axis)}", p, expect, data.get("raw_hash"))
            return None
        logger.info("curve-cache HIT: key=%s path=%s points=%d hash=%s",
                    f"{model_id}/{condition_id}/{_axis_norm(axis)}", p, len(data.get("x") or []), data.get("raw_hash"))
        return data
    except Exception as e:
        logger.warning("curve-cache READ ERROR: key=%s path=%s err=%s", f"{model_id}/{condition_id}/{_axis_norm(axis)}", p, repr(e))
        return None

def _sample_model(model: Dict[str, Any], n: int) -> Dict[str, list]:
    if not model or n <= 0:
        return {"x": [], "y": []}
    x0 = float(model["x0"]); x1 = float(model["x1"])
    if x1 <= x0:
        return {"x": [], "y": []}
    if n == 1:
        grid = [x0]
    elif n == 2:
        grid = [x0, x1]
    else:
        step = (x1 - x0) / (n - 1)
        grid = [x0 + step * i for i in range(n)]
    yv = [float(eval_pchip(model, x)) for x in grid]
    return {"x": grid, "y": yv}

def _save_cached_model(model: Dict[str, Any], model_id: int, condition_id: int, axis: str, raw_hash: str):
    model_out = dict(model)
    model_out["type"] = "pchip_v1"
    model_out["raw_hash"] = raw_hash
    model_out["axis"] = _axis_norm(axis)
    model_out["meta"] = {
        "model_id": int(model_id),
        "condition_id": int(condition_id),
        "created_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }
    n = _env_samples_n()
    if n > 0:
        samples = _sample_model(model, n)
        model_out["samples"] = {"n": n, **samples}
        logger.info("curve-cache SAVE: key=%s add samples n=%d", f"{model_id}/{condition_id}/{_axis_norm(axis)}", n)

    p = _model_cache_path(model_id, condition_id, axis)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(model_out, f, ensure_ascii=False)
    logger.info("curve-cache SAVE: key=%s path=%s hash=%s", f"{model_id}/{condition_id}/{_axis_norm(axis)}", p, raw_hash)


# =========================
# 统一入口：含内存 LRU + 磁盘缓存
# =========================
def _compose_cache_key(xs: List[float], ys: List[float], axis: str) -> str:
    """
    基于“原始点 + 轴 + 平滑/张力参数”生成稳定的缓存键。
    注意：只基于原始点（未平滑）做点哈希，确保装载时不必重做预处理。
    """
    base = raw_points_hash(xs, ys)
    ax = _axis_norm(axis)
    alpha = _env_alpha_for_axis(ax)
    tau = _env_tau_for_axis(ax)
    s = f"{base}|axis={ax}|alpha={alpha:.6f}|tau={tau:.6f}"
    return hashlib.sha1(s.encode("utf-8")).hexdigest()

def get_or_build_pchip(model_id: int, condition_id: int, axis: str, xs: List[float], ys: List[float]) -> Optional[Dict[str, Any]]:
    axis = _axis_norm(axis)
    # 改：用“原始点 + 轴 + α/τ”组合键
    expect_key = _compose_cache_key(xs, ys, axis)

    # 进程内 LRU 优先
    ikey = _inmem_key(model_id, condition_id, axis, expect_key)
    if _INMEM:
        m = _INMEM.get(ikey)
        if m is not None:
            logger.info("curve-cache INMEM HIT: key=%s size=%d pts=%d", ikey, _INMEM.stats()["size"], _INMEM.stats()["points"])
            _note_hit(ikey)
            return m

    # 磁盘命中
    cached = _load_cached_model_if_valid(model_id, condition_id, axis, xs, ys)
    if cached:
        if _INMEM and _note_hit(ikey) >= _ADMIT_HITS:
            _INMEM.put(ikey, cached)
            logger.info("curve-cache INMEM PUT (from-disk): key=%s size=%d pts=%d",
                        ikey, _INMEM.stats()["size"], _INMEM.stats()["points"])
        return cached

    # 构建
    p = _model_cache_path(model_id, condition_id, axis)
    logger.info("curve-cache BUILD: key=%s dir=%s path=%s points=%d",
                f"{model_id}/{condition_id}/{axis}", _abs_cache_dir(), p, len(xs or []))
    model = build_pchip_model_with_opts(xs, ys, axis)
    if not model:
        if os.path.exists(p):
            try:
                os.remove(p)
                logger.warning("curve-cache DELETE (stale & rebuild failed): key=%s path=%s",
                               f"{model_id}/{condition_id}/{axis}", p)
            except Exception as e:
                logger.warning("curve-cache DELETE ERROR: key=%s path=%s err=%s",
                               f"{model_id}/{condition_id}/{axis}", p, repr(e))
        return None

    # 保存时直接用组合键作为 raw_hash
    _save_cached_model(model, model_id, condition_id, axis, expect_key)
    model["type"] = "pchip_v1"
    model["axis"] = axis
    model["raw_hash"] = expect_key

    if _INMEM and _note_hit(ikey) >= _ADMIT_HITS:
        _INMEM.put(ikey, model)
        logger.info("curve-cache INMEM PUT (from-build): key=%s size=%d pts=%d",
                    ikey, _INMEM.stats()["size"], _INMEM.stats()["points"])
    return model