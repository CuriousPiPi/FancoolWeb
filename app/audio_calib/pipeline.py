# -*- coding: utf-8 -*-
import os, re, math, json, sys
from typing import Dict, Any, List, Tuple, Optional

import numpy as np
import soundfile as sf
from scipy import signal
from app.curves.pchip_cache import eval_pchip as pchip_eval
from functools import lru_cache

# 依赖 app/curves/pchip_cache
try:
    from app.curves.pchip_cache import build_pchip_model_with_opts as pchip_build
except Exception:
    CURVES_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../app/curves'))
    if CURVES_DIR not in sys.path:
        sys.path.append(CURVES_DIR)
    from pchip_cache import build_pchip_model_with_opts as pchip_build  # type: ignore

P0 = 20e-6
AUDIO_EXTS = (".wav", ".flac", ".ogg", ".m4a", ".mp3", ".aac", ".wma")

AWA_NUM = r"([-+]?\d+(?:\.\d+)?)"
_R_RPM = re.compile(r'^[Rr](\d+)$')

def _fb_kwargs(params: Dict[str, Any]) -> Dict[str, Any]:
    """
    统一解析滤波器参数：
      - bands_filter_order: IIR Butterworth 阶数（总阶数），默认 4
      - use_fir_cpb: 是否启用 FIR，默认 False（优先 IIR 以追求速度）
      - fir_base_taps: FIR 基准 taps（按带宽缩放），默认 256
    """
    def as_int(v, d): 
        try: return int(v)
        except Exception: return d
    def as_bool(v, d):
        try: return bool(v)
        except Exception: return d

    order = as_int(params.get('bands_filter_order', 6), 6)
    use_fir = as_bool(params.get('use_fir_cpb', False), False)
    base_taps = as_int(params.get('fir_base_taps', 256), 256)

    if order < 2: order = 2
    if base_taps < 64: base_taps = 64

    return {
        'bands_filter_order': order,
        'use_fir_cpb': use_fir,
        'fir_base_taps': base_taps
    }

# ---------------- 滤波器组缓存 ----------------
@lru_cache(maxsize=64)
def _cached_iir_bank(fs: int, n_per_oct: int, centers_key: Tuple[float, ...], order: int) -> Tuple[Optional[np.ndarray], ...]:
    centers = np.array(centers_key, dtype=float)
    bank = _design_cpb_filterbank_iir(centers, fs, n_per_oct, order=order)
    # lru_cache 需要可哈希，这里转为 tuple
    return tuple(bank)

@lru_cache(maxsize=64)
def _cached_fir_bank(fs: int, n_per_oct: int, centers_key: Tuple[float, ...], base_taps: int) -> Tuple[Optional[np.ndarray], ...]:
    centers = np.array(centers_key, dtype=float)
    bank = _design_cpb_filterbank_fir(centers, fs, n_per_oct, base_taps=base_taps)
    return tuple(bank)

# ---------------- 频带工具 ----------------
def a_weight_db(freq_hz: np.ndarray) -> np.ndarray:
    f = np.asarray(freq_hz, dtype=float)
    f2 = f**2
    ra_num = (12200.0**2) * (f2**2)
    ra_den = (f2 + 20.6**2) * np.sqrt((f2 + 107.7**2) * (f2 + 737.9**2)) * (f2 + 12200.0**2)
    ra = ra_num / np.maximum(ra_den, 1e-30)
    return 20.0 * np.log10(np.maximum(ra, 1e-30)) + 2.0

def bands_per_decade_from_npo(n_per_octave: int) -> int:
    return int(round((n_per_octave * 10.0) / 3.0))

RENARD_MANTISSAS = {
    3:  [1.00, 2.00, 5.00],
    10: [1.00, 1.25, 1.60, 2.00, 2.50, 3.15, 4.00, 5.00, 6.30, 8.00],
    20: [1.00, 1.12, 1.25, 1.40, 1.60, 1.80, 2.00, 2.24, 2.50, 2.80,
         3.15, 3.55, 4.00, 4.50, 5.00, 5.60, 6.30, 7.10, 8.00, 9.00],
    40: [1.00, 1.06, 1.12, 1.18, 1.25, 1.32, 1.40, 1.50, 1.60, 1.70,
         1.80, 1.90, 2.00, 2.12, 2.24, 2.36, 2.50, 2.65, 2.80, 3.00,
         3.15, 3.35, 3.55, 3.75, 4.00, 4.25, 4.50, 4.75, 5.00, 5.30,
         5.60, 6.00, 6.30, 6.70, 7.10, 7.50, 8.00, 8.50, 9.00, 9.50]
}

def snap_to_renard_nominal(vals: np.ndarray, bpd: int) -> np.ndarray:
    mans = RENARD_MANTISSAS.get(bpd)
    if not mans:
        return vals
    mans = np.asarray(mans, float)
    out = np.zeros_like(vals, dtype=float)
    for i, f in enumerate(vals):
        if f <= 0 or not np.isfinite(f):
            out[i] = f; continue
        e = int(math.floor(math.log10(f)))
        m = f / (10.0 ** e)
        j = int(np.argmin(np.abs(mans - m)))
        out[i] = mans[j] * (10.0 ** e)
    out = np.array(sorted(set(float(x) for x in out if x > 0)))
    return out

def make_centers_iec61260(n_per_octave=12, fmin=20.0, fmax=20000.0) -> np.ndarray:
    bpd = bands_per_decade_from_npo(n_per_octave)
    k_min = int(math.ceil(bpd * math.log10(max(fmin, 1e-12))))
    k_max = int(math.floor(bpd * math.log10(max(fmax, 1e-12))))
    if k_max < k_min:
        return np.zeros((0,), dtype=float)
    ks = np.arange(k_min, k_max + 1)
    centers_exact = 10.0 ** (ks / float(bpd))
    centers_nom = snap_to_renard_nominal(centers_exact, bpd)
    centers_nom = centers_nom[(centers_nom >= fmin) & (centers_nom <= fmax)]
    return centers_nom

def band_edges_from_centers(centers: np.ndarray, n_per_octave=12, grid: str = "iec-decimal") -> Tuple[np.ndarray, np.ndarray]:
    centers = np.asarray(centers, float)
    if centers.size == 0:
        return np.zeros_like(centers), np.zeros_like(centers)
    if grid == "iec-decimal":
        bpd = bands_per_decade_from_npo(n_per_octave)
        g = 10.0 ** (1.0 / (2.0 * float(bpd)))
    else:
        g = 2.0 ** (1.0 / (2.0 * float(n_per_octave)))
    return centers / g, centers * g

def db10_from_energy(E: np.ndarray, floor=1e-30) -> np.ndarray:
    E = np.asarray(E, dtype=float)
    out = np.full_like(E, np.nan, dtype=float)
    mask = E > 0
    out[mask] = 10.0 * np.log10(np.maximum(E[mask] / (P0**2), floor))
    return out

# ---------------- DB: 获取叶片数（按 model_id） ----------------
def _get_fan_blades_from_db(model_id: Optional[int]) -> int:
    if not model_id:
        return 0
    try:
        from sqlalchemy import create_engine, text
        dsn = os.getenv('FANDB_DSN', 'mysql+pymysql://localreader:12345678@127.0.0.1/FANDB?charset=utf8mb4')
        eng = create_engine(dsn, pool_pre_ping=True, future=True)
        with eng.begin() as conn:
            rows = conn.execute(text("SELECT fan_blades FROM fan_model WHERE model_id=:m LIMIT 1"), {'m': int(model_id)}).fetchall()
            if rows:
                v = rows[0]._mapping.get('fan_blades')
                try:
                    return int(v or 0)
                except Exception:
                    return 0
    except Exception:
        return 0
    return 0

# ---------------- 辅助：PCHIP 评估与能量/谐波工具 ----------------
def _eval_pchip_local(model: Dict[str, Any], x: float) -> float:
    if not model or not isinstance(model, dict):
        return float("nan")
    xs = model.get("x") or []
    ys = model.get("y") or []
    ms = model.get("m") or []
    n = len(xs)
    if n == 0:
        return float("nan")
    if n == 1:
        return float(ys[0])
    if x <= xs[0]:
        x = xs[0]
    if x >= xs[-1]:
        x = xs[-1]
    lo, hi = 0, n - 2
    i = 0
    while lo <= hi:
        mid = (lo + hi) // 2
        if xs[mid] <= x <= xs[mid + 1]:
            i = mid; break
        if x < xs[mid]:
            hi = mid - 1
        else:
            lo = mid + 1
    else:
        i = max(0, min(n - 2, lo))
    x0 = float(xs[i]); x1 = float(xs[i + 1])
    h = x1 - x0
    t = (x - x0) / h if h != 0 else 0.0
    y0 = float(ys[i]); y1 = float(ys[i + 1])
    m0 = float(ms[i]) * h; m1 = float(ms[i + 1]) * h
    h00 = (2 * t**3 - 3 * t**2 + 1)
    h10 = (t**3 - 2 * t**2 + t)
    h01 = (-2 * t**3 + 3 * t**2)
    h11 = (t**3 - t**2)
    return h00 * y0 + h10 * m0 + h01 * y1 + h11 * m1

def _dbA_band_to_pa2(db_val: Optional[float]) -> float:
    if db_val is None or (isinstance(db_val, float) and not np.isfinite(db_val)):
        return 0.0
    return (P0**2) * (10.0 ** (float(db_val) / 10.0))

def _local_baseline_pa2(band_E: np.ndarray, k: int, win_bands: int = 3) -> float:
    n = band_E.size
    lo = max(0, k - win_bands)
    hi = min(n, k + win_bands + 1)
    arr = band_E[lo:hi].copy()
    rm_idx = min(k - lo, arr.size - 1)
    arr = np.delete(arr, rm_idx) if arr.size > 0 else arr
    if arr.size == 0:
        return 0.0
    return float(np.median(arr))

def _distribute_line_to_bands(f_line: float, centers: np.ndarray, f1: np.ndarray, f2: np.ndarray,
                              sigma_bands: float = 0.25, topk: int = 3) -> List[Tuple[int, float]]:
    if not np.isfinite(f_line) or f_line <= 0.0:
        return []
    logc = np.log(np.maximum(centers, 1e-30))
    w = np.exp(-0.5 * ((np.log(max(f_line, 1e-30)) - logc) / max(1e-6, sigma_bands))**2)
    inside = ((f_line >= f1) & (f_line <= f2)).astype(float)
    w = w * inside
    if np.all(w <= 0):
        return []
    idx = np.argsort(-w)[:max(1, int(topk))]
    ww = w[idx]
    ww = ww / max(1e-30, np.sum(ww))
    return [(int(i), float(v)) for i, v in zip(idx.tolist(), ww.tolist())]

def _build_harmonic_models_from_nodes(centers: np.ndarray,
                                      n_per_oct: int,
                                      rpm_nodes: List[float],
                                      per_frame_bandE: np.ndarray,
                                      per_frame_rpm: np.ndarray,
                                      n_blade: int,
                                      h_max: Optional[int] = None,
                                      baseline_win_bands: int = 3,
                                      kernel_sigma_bands: float = 0.25) -> Dict[str, Any]:
    f1, f2 = band_edges_from_centers(centers, n_per_oct, grid="iec-decimal")
    T = per_frame_bandE.shape[1]
    if T <= 0 or n_blade <= 0:
        return {}
    rpm_min = float(np.nanmin(per_frame_rpm)); rpm_max = float(np.nanmax(per_frame_rpm))
    if not np.isfinite(rpm_min) or not np.isfinite(rpm_max) or rpm_max <= rpm_min:
        return {}
    if not h_max:
        fmax = float(f2[-1])
        bpf_max = (n_blade * rpm_max) / 60.0
        h_max = int(max(1, math.floor(fmax / max(1e-9, bpf_max))))
    models = []
    xs_centers = np.array(sorted(set(float(r) for r in rpm_nodes)), float)
    if xs_centers.size < 2:
        xs_centers = np.linspace(rpm_min, rpm_max, num=max(3, int(round((rpm_max-rpm_min)/50.0))), dtype=float)
    bin_step = float(np.median(np.diff(xs_centers))) if xs_centers.size >= 2 else max(1.0, (rpm_max-rpm_min)/20.0)
    halfw = max(1.0, bin_step)
    def tri_w(x, c):
        d = abs(x - c)
        return max(0.0, 1.0 - d/halfw)
    for h in range(1, int(h_max) + 1):
        ys_nodes: List[float] = []
        xs_nodes: List[float] = []
        for c in xs_centers:
            wsum = 0.0
            E_line_acc = 0.0
            for t in range(T):
                rpm_t = float(per_frame_rpm[t])
                if not np.isfinite(rpm_t):
                    continue
                w = tri_w(rpm_t, c)
                if w <= 0:
                    continue
                f_line = h * n_blade * (rpm_t / 60.0)
                idxs = np.where((f_line >= f1) & (f_line <= f2))[0]
                if idxs.size == 0:
                    continue
                k = int(idxs[0])
                Es = float(per_frame_bandE[k, t])
                base = _local_baseline_pa2(per_frame_bandE[:, t], k, win_bands=baseline_win_bands)
                E_line = max(0.0, Es - base)
                if E_line > 0.0:
                    E_line_acc += w * E_line
                    wsum += w
            if wsum > 0:
                Eh = E_line_acc / wsum
                Lh_db = 10.0 * math.log10(max(Eh/(P0**2), 1e-30))
                xs_nodes.append(float(c))
                ys_nodes.append(float(Lh_db))
        if len(xs_nodes) == 0:
            mdl = None
        elif len(xs_nodes) == 1:
            mdl = _build_pchip_anchor([xs_centers[0], xs_centers[-1]], [ys_nodes[0], ys_nodes[0]], nonneg=False)
        else:
            mdl = _build_pchip_anchor(xs_nodes, ys_nodes, nonneg=False)
        models.append({"h": h, "amp_pchip_db": mdl})
    return {
        "n_blade": int(n_blade),
        "h_max": int(h_max),
        "kernel": {"type": "gauss-logf", "sigma_bands": float(kernel_sigma_bands), "topk": 3},
        "models": models
    }

# ---------------- 音频/PSD ----------------
def read_audio_mono(path: str,
                    target_fs: Optional[int] = None,
                    trim_head_sec: float = 0.5,
                    trim_tail_sec: float = 0.5,
                    highpass_hz: float = 20.0,
                    for_slm_like: bool = False) -> Tuple[np.ndarray, int]:
    x, fs = sf.read(path, always_2d=False)
    if hasattr(x, "ndim") and np.ndim(x) > 1:
        x = np.mean(x, axis=1)
    x = np.asarray(x, dtype=np.float64)

    if for_slm_like:
        x = x - np.mean(x)
    else:
        n_head = int(max(0.0, trim_head_sec) * fs)
        n_tail = int(max(0.0, trim_tail_sec) * fs)
        if x.size > n_head + n_tail:
            x = x[n_head: x.size - n_tail]
        elif x.size > n_head:
            x = x[n_head:]
        x = x - np.mean(x)
        if highpass_hz and highpass_hz > 0 and fs > 2 * highpass_hz:
            sos = signal.butter(2, float(highpass_hz), btype='highpass', fs=fs, output='sos')
            x = signal.sosfilt(sos, x)

    if target_fs and target_fs > 0 and fs != target_fs:
        g = math.gcd(int(fs), int(target_fs))
        up = target_fs // g
        down = fs // g
        x = signal.resample_poly(x, up, down)
        fs = target_fs
    return x, int(fs)

def psd_frames_welch(x: np.ndarray, fs: int, frame_sec=1.0, hop_ratio=0.5) -> Tuple[np.ndarray, List[np.ndarray]]:
    N = len(x)
    win = int(max(256, round(frame_sec * fs)))
    hop_samp = int(round(win * (1.0 - hop_ratio)))
    if hop_samp <= 0:
        hop_samp = win
    starts = np.arange(0, max(0, N - win + 1), hop_samp, dtype=int)
    psds: List[np.ndarray] = []
    freqs: Optional[np.ndarray] = None
    for s in starts:
        seg = x[s:s+win]
        if seg.size < win:
            break
        nperseg = max(256, win // 2)
        noverlap = nperseg // 2
        # 使用密度，与带内 df 积分一致
        f, Pxx = signal.welch(seg, fs=fs, window='hann', nperseg=nperseg, noverlap=noverlap,
                              detrend='constant', return_onesided=True, scaling='density')
        if freqs is None:
            freqs = f
        psds.append(Pxx.astype(np.float64))
    return freqs if freqs is not None else np.array([]), psds

def integrate_psd_to_bands_A(freq_hz: np.ndarray, psd: np.ndarray,
                             f1: np.ndarray, f2: np.ndarray) -> np.ndarray:
    f = freq_hz
    P = psd
    df = np.diff(f); df = np.append(df, df[-1] if df.size else 0.0)
    A_db = a_weight_db(f)
    W = 10.0 ** (A_db / 10.0)
    P_eff = P * W
    out = np.zeros_like(f1, dtype=float)
    for i, (lo, hi) in enumerate(zip(f1, f2)):
        m = (f >= lo) & (f <= hi)
        out[i] = float(np.sum(P_eff[m] * df[m])) if np.any(m) else 0.0
    return out

# ---------------- AWA/IO ----------------
def find_awa(folder: str) -> Optional[str]:
    try:
        cands = [os.path.join(folder, fn) for fn in os.listdir(folder) if fn.lower().endswith(".awa")]
        return cands[0] if cands else None
    except Exception:
        return None

def parse_awa_la(path: str) -> float:
    if not path or not os.path.exists(path):
        return float("nan")
    for enc in ("utf-8","gbk","latin-1"):
        try:
            s = open(path, "r", encoding=enc, errors="ignore").read()
            break
        except Exception:
            s = None
    if not s: return float("nan")
    s = s.replace("\x00"," ")
    m = re.search(r"LAeq\s*,?\s*T\s*=\s*"+AWA_NUM, s)
    return float(m.group(1)) if m else float("nan")

def list_audio(folder: str) -> List[str]:
    try:
        return sorted([os.path.join(folder, fn) for fn in os.listdir(folder) if fn.lower().endswith(AUDIO_EXTS)])
    except Exception:
        return []

def parse_rpm_from_name(name: str) -> Optional[float]:
    try:
        return float(re.sub(r"[^\d.]+","", name))
    except Exception:
        return None

# ---------------- 统计/聚合工具 ----------------
def select_frames_by_quantile(Etot: np.ndarray, q_percent: float) -> np.ndarray:
    T = Etot.size
    if T == 0:
        return np.zeros((0,), dtype=bool)
    if q_percent >= 100.0:
        return np.ones((T,), dtype=bool)
    q = max(0.0, min(q_percent/100.0, 1.0))
    thr = float(np.quantile(Etot, q))
    return (Etot <= thr)

def mad_clip_both_mask(v: np.ndarray, tau: float) -> np.ndarray:
    v = np.asarray(v, float)
    if v.size < 3:
        return np.ones(v.shape, dtype=bool)
    med = np.median(v)
    mad = np.median(np.abs(v - med))
    sigma = 1.4826 * mad
    if sigma <= 0:
        return np.ones(v.shape, dtype=bool)
    return np.abs(v - med) <= (tau * sigma)

def aggregate_two_stage_with_preband_mad(E_frames: np.ndarray,
                                         Etot: np.ndarray,
                                         qf_percent: float,
                                         qb_percent: float,
                                         mad_tau: float,
                                         enable_mad_pre_band: bool) -> np.ndarray:
    if E_frames.size == 0:
        return np.zeros((0,), dtype=float)
    mask_frames = select_frames_by_quantile(Etot, qf_percent)
    E_sel = E_frames[:, mask_frames] if np.any(mask_frames) else E_frames
    K, _ = E_sel.shape
    out = np.zeros((K,), dtype=float)
    use_quantile = (qb_percent < 100.0)
    q = max(0.0, min(qb_percent/100.0, 1.0))
    for k in range(K):
        vk = E_sel[k, :]
        if enable_mad_pre_band:
            keep = mad_clip_both_mask(vk, mad_tau)
            vk = vk[keep] if np.any(keep) else vk
        out[k] = float(np.quantile(vk, q)) if use_quantile else float(np.mean(vk))
    return out

# 新增：env 每频带低分位（MAD 后）作为基线，默认取 30% 分位，避免过度扣除
def env_band_baseline_low_quantile(E_frames: np.ndarray,
                                   Etot: np.ndarray,
                                   low_percent: float = 30.0,
                                   mad_tau: float = 3.0,
                                   enable_mad_pre_band: bool = True) -> np.ndarray:
    if E_frames.size == 0:
        return np.zeros((0,), dtype=float)
    mask_frames = select_frames_by_quantile(Etot, 40.0)
    E_sel = E_frames[:, mask_frames] if np.any(mask_frames) else E_frames
    K, _ = E_sel.shape
    out = np.zeros((K,), dtype=float)
    q = max(0.0, min(low_percent/100.0, 1.0))
    for k in range(K):
        vk = E_sel[k, :]
        if enable_mad_pre_band and vk.size >= 3:
            keep = mad_clip_both_mask(vk, mad_tau)
            vk = vk[keep] if np.any(keep) else vk
        out[k] = float(np.quantile(vk, q)) if vk.size else 0.0
    out = np.maximum(out, 0.0)
    return out

# ---------------- 本地 PCHIP（锚点保持，可选单调） ----------------
def _pchip_slopes_fritsch_carlson(xs: List[float], ys: List[float], *, nonneg: bool = True) -> List[float]:
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
        if nonneg:
            if m[i] < 0:
                m[i] = 0.0
            if m[i + 1] < 0:
                m[i + 1] = 0.0
    return m

def _build_pchip_anchor(xs_in: List[float], ys_in: List[float], *, nonneg: bool = True) -> Optional[Dict[str, Any]]:
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
    m = _pchip_slopes_fritsch_carlson(xs, ys, nonneg=nonneg)
    return {"x": xs, "y": ys, "m": m, "x0": xs[0], "x1": xs[-1]}

# ---------------- 流水线：标定（env + 短录音） ----------------
def calibrate_from_points_in_memory(root_dir: str, params: Dict[str, Any]) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    import time
    t0_all = time.perf_counter()
    timings = {
        "env_abs_scale_sec": 0.0,
        "env_frames_sec": 0.0,
        "env_agg_sec": 0.0,
        "short_full_sec": 0.0,
        "short_frames_sec": 0.0,
        "short_agg_sec": 0.0,
        "files_env": 0,
        "files_short": 0,
        "bands": 0,
        "env_frames_total": 0,
        "short_frames_total": 0
    }

    fs = int(params.get('fs', 48000) or 48000)
    n_per_oct = int(params.get('n_per_oct', 12))
    fmin = float(params.get('fmin_hz', 20.0))
    fmax = float(params.get('fmax_hz', 20000.0))
    frame_sec = float(params.get('frame_sec', 1.0))
    hop_sec = float(params.get('hop_sec', 0.5*frame_sec))
    hop_ratio = 1.0 - max(0.0, min(hop_sec/frame_sec if frame_sec>0 else 0.0, 1.0))
    band_grid = str(params.get('band_grid', 'iec-decimal'))

    # 建议：AWA 校正后再截去首尾 0.5~1.0 s（默认 0.75）
    trim_head_sec = float(params.get('trim_head_sec', 0.75))
    trim_tail_sec = float(params.get('trim_tail_sec', 0.75))
    highpass_hz   = float(params.get('highpass_hz', 20.0))

    env_qf = float(params.get('env_agg_per_frame', 40.0))
    env_qb = float(params.get('env_agg_per_band', 20.0))
    meas_qf = float(params.get('meas_agg_per_frame', 40.0))
    meas_qb = float(params.get('meas_agg_per_band', 100.0))
    env_mad_on = bool(params.get('env_mad_pre_band', True))
    meas_mad_on = bool(params.get('meas_mad_pre_band', True))
    mad_tau = float(params.get('mad_tau', 3.0))
    snr_ratio_min = float(params.get('snr_ratio_min', 1.0))
    perfile_median = bool(params.get('perfile_median', False))
    env_band_percentile = float(params.get('env_band_percentile', 30.0))

    root = os.path.abspath(root_dir)
    env_dir = os.path.join(root, "env")
    if not os.path.isdir(env_dir):
        raise RuntimeError("缺少 env/ 目录")

    centers = make_centers_iec61260(n_per_octave=n_per_oct, fmin=fmin, fmax=fmax)
    if centers.size == 0:
        raise RuntimeError("频带中心为空，请调整 fmin/fmax")
    K = centers.size
    timings["bands"] = int(K)

    env_awa_path = find_awa(env_dir)
    if not env_awa_path:
        raise RuntimeError("env/ 缺少 .AWA")
    LAeq_env_awa = parse_awa_la(env_awa_path)
    if not np.isfinite(LAeq_env_awa):
        raise RuntimeError("env/.AWA 缺少 LAeq")

    env_files = list_audio(env_dir)
    if not env_files:
        raise RuntimeError("env/ 无音频文件")
    timings["files_env"] = int(len(env_files))

    # AWA 绝对刻度（整段）用于能量尺度
    t1 = time.perf_counter()
    E_env_A_full_list = []
    for p in env_files:
        x_full, fs_full = read_audio_mono(p, fs, for_slm_like=True)
        E_A_full, _ = bands_time_energy_A(
            x_full, fs_full, centers, n_per_oct, frame_sec, hop_ratio,
            grid=band_grid, **_fb_kwargs(params)
        )
        E_env_A_full_list.append(E_A_full)
    timings["env_abs_scale_sec"] += (time.perf_counter() - t1)

    E_env_A_mean = np.mean(np.hstack(E_env_A_full_list), axis=1) if E_env_A_full_list else np.zeros((K,))
    sA_env = (P0 * 10.0**(LAeq_env_awa/20.0)) / math.sqrt(max(float(np.sum(E_env_A_mean)), 1e-30))
    s2A_env = sA_env**2

    # 帧级统计：MAD + 低分位作为带级基线
    t1 = time.perf_counter()
    E_env_A_proc_list, Etot_env_list = [], []
    for p in env_files:
        x_p, fs_p = read_audio_mono(p, fs, trim_head_sec, trim_tail_sec, highpass_hz, for_slm_like=False)
        E_A_p, Etot = bands_time_energy_A(
            x_p, fs_p, centers, n_per_oct, frame_sec, hop_ratio,
            grid=band_grid, **_fb_kwargs(params)
        )
        E_env_A_proc_list.append(E_A_p); Etot_env_list.append(Etot)
        if E_A_p.size:
            timings["env_frames_total"] += int(E_A_p.shape[1])
    timings["env_frames_sec"] += (time.perf_counter() - t1)

    t1 = time.perf_counter()
    E_env_A_frames = np.hstack(E_env_A_proc_list) if E_env_A_proc_list else np.zeros((K,0))
    Etot_env = np.concatenate(Etot_env_list) if Etot_env_list else np.zeros((0,))

    E_env_FS_A_rob = aggregate_two_stage_with_preband_mad(
        E_env_A_frames, Etot_env, qf_percent=env_qf, qb_percent=env_qb, mad_tau=mad_tau, enable_mad_pre_band=env_mad_on
    )
    la_env_from_base = db10_from_energy(np.array([np.sum(s2A_env * E_env_FS_A_rob)])).item()

    E_env12_A_pa2_base = s2A_env * env_band_baseline_low_quantile(
        E_env_A_frames, Etot_env, low_percent=env_band_percentile, mad_tau=mad_tau, enable_mad_pre_band=env_mad_on
    )
    timings["env_agg_sec"] += (time.perf_counter() - t1)

    rpm_nodes: List[float] = []
    la_nodes_raw: List[float] = []
    la_nodes_envsub: List[float] = []
    per_rpm_counts: Dict[float, int] = {}
    invalid_band_stats: Dict[float, int] = {}
    anchor_items: List[Dict] = []

    report_rows: List[Dict[str, object]] = []
    report_rows.append({
        "scope": "env",
        "rpm": "",
        "file": "",
        "awa_la_db": LAeq_env_awa,
        "proc_la_raw_db": la_env_from_base,
        "proc_la_post_env_db": "",
        "delta_raw_db": (la_env_from_base - LAeq_env_awa) if np.isfinite(LAeq_env_awa) else "",
        "delta_post_env_db": ""
    })

    for name in sorted(os.listdir(root)):
        d = os.path.join(root, name)
        if not os.path.isdir(d) or os.path.basename(d).lower() in ("env", "sweep"):
            continue
        m = _R_RPM.match(os.path.basename(d))
        rpm = float(m.group(1)) if m else parse_rpm_from_name(name)
        files = list_audio(d)
        if not files:
            continue

        timings["files_short"] += int(len(files))

        awa_path = find_awa(d)
        LAeq_dir = parse_awa_la(awa_path) if awa_path else float("nan")

        E_raw_list_pa2: List[np.ndarray] = []
        E_sub_list_pa2: List[np.ndarray] = []
        la_raw_files: List[float] = []
        la_sub_files: List[float] = []

        for ap in files:
            # full（绝对刻度）
            t1 = time.perf_counter()
            x_full, fs_full = read_audio_mono(ap, fs, for_slm_like=True)
            E_A_full, _ = bands_time_energy_A(
                x_full, fs_full, centers, n_per_oct, frame_sec, hop_ratio,
                grid=band_grid, **_fb_kwargs(params)
            )
            timings["short_full_sec"] += (time.perf_counter() - t1)

            E_A_full_mean = np.mean(E_A_full, axis=1) if E_A_full.size else np.zeros((K,))
            if np.isfinite(LAeq_dir):
                sA_use = (P0 * 10.0**(LAeq_dir/20.0)) / math.sqrt(max(float(np.sum(E_A_full_mean)), 1e-30))
            else:
                sA_use = sA_env
            s2A_use = sA_use**2

            # 裁剪段帧级能量
            t1 = time.perf_counter()
            x_proc, fs_proc = read_audio_mono(ap, fs, trim_head_sec, trim_tail_sec, highpass_hz, for_slm_like=False)
            E_A_proc, Etot = bands_time_energy_A(
                x_proc, fs_proc, centers, n_per_oct, frame_sec, hop_ratio,
                grid=band_grid, **_fb_kwargs(params)
            )
            timings["short_frames_sec"] += (time.perf_counter() - t1)
            if E_A_proc.size:
                timings["short_frames_total"] += int(E_A_proc.shape[1])

            # 带级聚合
            t1 = time.perf_counter()
            E_A_rob = aggregate_two_stage_with_preband_mad(
                E_A_proc, Etot, qf_percent=meas_qf, qb_percent=meas_qb, mad_tau=mad_tau, enable_mad_pre_band=meas_mad_on
            )
            timings["short_agg_sec"] += (time.perf_counter() - t1)

            E_meas12_A_pa2 = s2A_use * E_A_rob
            E_env12_A_pa2 = E_env12_A_pa2_base * (s2A_use / s2A_env)
            E_sub_pos = np.maximum(E_meas12_A_pa2 - E_env12_A_pa2, 0.0)

            E_raw_list_pa2.append(E_meas12_A_pa2)
            E_sub_list_pa2.append(E_sub_pos)

            la_raw = db10_from_energy(np.array([np.sum(E_meas12_A_pa2)])).item()
            la_sub = db10_from_energy(np.array([np.sum(E_sub_pos)])).item()
            la_raw_files.append(la_raw)
            la_sub_files.append(la_sub)

            report_rows.append({
                "scope": "file",
                "rpm": ("" if rpm is None else int(round(rpm))),
                "file": os.path.basename(ap),
                "awa_la_db": LAeq_dir if np.isfinite(LAeq_dir) else "",
                "proc_la_raw_db": la_raw,
                "proc_la_post_env_db": la_sub,
                "delta_raw_db": (la_raw - LAeq_dir) if np.isfinite(LAeq_dir) else "",
                "delta_post_env_db": (la_sub - LAeq_dir) if np.isfinite(LAeq_dir) else ""
            })

        E_raw_stack = np.stack(E_raw_list_pa2, axis=0)
        E_sub_stack = np.stack(E_sub_list_pa2, axis=0)
        if perfile_median:
            E_anchor_raw_pa2 = np.median(E_raw_stack, axis=0)
            E_anchor_pa2 = np.median(E_sub_stack, axis=0)
            la_raw_rpm = float(np.median(np.array(la_raw_files, float)))
            la_sub_rpm = float(np.median(np.array(la_sub_files, float)))
        else:
            E_anchor_raw_pa2 = np.mean(E_raw_stack, axis=0)
            E_anchor_pa2 = np.mean(E_sub_stack, axis=0)
            la_raw_rpm = float(np.mean(np.array(la_raw_files, float)))
            la_sub_rpm = float(np.mean(np.array(la_sub_files, float)))

        L_band_db = db10_from_energy(E_anchor_pa2)
        spectrum_db: List[Optional[float]] = []
        invalid_count = 0
        for v_E, v_dB in zip(E_anchor_pa2.tolist(), L_band_db.tolist()):
            if v_E <= 0.0 or (v_dB is None) or (isinstance(v_dB, float) and not np.isfinite(v_dB)):
                spectrum_db.append(None); invalid_count += 1
            else:
                spectrum_db.append(float(v_dB))

        rpm_val = float(rpm) if (rpm is not None and np.isfinite(rpm)) else float("nan")
        rpm_nodes.append(rpm_val)
        la_nodes_raw.append(la_raw_rpm)
        la_nodes_envsub.append(la_sub_rpm)
        per_rpm_counts[rpm_val] = len(files)
        invalid_band_stats[rpm_val] = invalid_count

        anchor_items.append({
            "rpm": rpm_val,
            "spectrum_db": spectrum_db,
            "label": name,
            "n_files": len(files),
            "source": "short_recordings_envsub_A",
            "laeq_envsub_from_bands_db": db10_from_energy(np.array([np.sum(E_anchor_pa2)])).item()
        })

        report_rows.append({
            "scope": "rpm",
            "rpm": ("" if rpm is None else int(round(rpm))),
            "file": "",
            "awa_la_db": LAeq_dir if np.isfinite(LAeq_dir) else "",
            "proc_la_raw_db": la_raw_rpm,
            "proc_la_post_env_db": la_sub_rpm,
            "delta_raw_db": (la_raw_rpm - LAeq_dir) if np.isfinite(LAeq_dir) else "",
            "delta_post_env_db": (la_sub_rpm - LAeq_dir) if np.isfinite(LAeq_dir) else ""
        })

    if not rpm_nodes:
        raise RuntimeError("未找到任何 RPM 挡位数据")

    pairs = sorted(zip(rpm_nodes, la_nodes_envsub, la_nodes_raw, anchor_items), key=lambda t:t[0])
    rpm_nodes = [p[0] for p in pairs]
    la_nodes_envsub = [p[1] for p in pairs]
    la_nodes_raw = [p[2] for p in pairs]
    anchor_items = [p[3] for p in pairs]
    model_pchip = pchip_build(rpm_nodes, la_nodes_envsub, axis="rpm")

    calib = {
        "version": "rpm_calib_v1",
        "rpm_nodes": rpm_nodes,
        "laeq_nodes_raw_db": la_nodes_raw,
        "laeq_nodes_envsub_db": la_nodes_envsub,
        "laeq_env_db": float(LAeq_env_awa),
        "rpm_min": float(min(rpm_nodes)),
        "rpm_max": float(max(rpm_nodes)),
        "pchip_rpm_to_laeq_envsub": model_pchip,
        "anchor_spectra": {
            "centers_hz": centers.tolist(),
            "items": anchor_items,
            "n_per_oct": int(n_per_oct),
            "fmin": float(fmin),
            "fmax": float(fmax),
            "weighting": "A",
            "grid": band_grid,
            "env_band_energy_A": np.asarray(E_env12_A_pa2_base, float).tolist(),
            "note": "spectrum_db 为能量域扣环境后的倍频程频带 dB（无效带为 null）；env 基线采用 MAD + 低分位（保守扣除）"
        },
        "stats": {
            "per_rpm_counts": {str(k): int(v) for k, v in per_rpm_counts.items()},
            "invalid_bands_per_rpm": {str(k): int(v) for k, v in invalid_band_stats.items()},
            "env_la_from_base_db": float(la_env_from_base),
            "env_awa_la_db": float(LAeq_env_awa),
            "env_la_base_minus_awa_db": float(la_env_from_base - LAeq_env_awa),
            "env_agg_per_frame_percent": env_qf,
            "env_agg_per_band_percent": env_qb,
            "meas_agg_per_frame_percent": meas_qf,
            "meas_agg_per_band_percent": meas_qb,
            "env_mad_pre_band": bool(env_mad_on),
            "meas_mad_pre_band": bool(meas_mad_on),
            "mad_tau": mad_tau,
            "snr_ratio_min": snr_ratio_min,
            "env_band_percentile": env_band_percentile,
            "trim_head_sec": trim_head_sec,
            "trim_tail_sec": trim_tail_sec,
            "highpass_hz": highpass_hz,
            "band_grid": band_grid
        }
    }

    per_rpm_rows: List[Dict[str, Any]] = []
    per_rpm_rows.append({
        'rpm': 0,
        'la_env_db': float(LAeq_env_awa),
        'la_raw_db': float(la_env_from_base),
        'la_post_env_db': None,
        'delta_raw_db': float(la_env_from_base - LAeq_env_awa),
        'delta_post_env_db': None,
        'used_env_awa': 1,
        'used_rpm_awa': None
    })
    for idx, r in enumerate(rpm_nodes):
        per_rpm_rows.append({
            'rpm': int(round(r)),
            'la_env_db': None,
            'la_raw_db': float(la_nodes_raw[idx]),
            'la_post_env_db': float(la_nodes_envsub[idx]),
            'delta_raw_db': None,
            'delta_post_env_db': None,
            'used_env_awa': None,
            'used_rpm_awa': None
        })

    # 写入阶段耗时统计
    timings["total_sec"] = float(time.perf_counter() - t0_all)
    stats = calib.get("stats") or {}
    stats["timings"] = timings
    calib["stats"] = stats

    return calib, per_rpm_rows

# ---------------- sweep 长录音增强的模型 ----------------
def build_model_from_calib_with_sweep_in_memory(root_dir: str,
                                                calib: Dict[str, Any],
                                                params: Dict[str, Any]) -> Dict[str, Any]:
    import time
    t_all = time.perf_counter()
    timing = {
        "read_raw_sec": 0.0,
        "full_la_sec": 0.0,
        "read_proc_sec": 0.0,
        "frames_filter_sec": 0.0,
        "invert_la_sec": 0.0,
        "invert_hybrid_sec": 0.0,
        "post_process_sec": 0.0,
        "binning_sec": 0.0,
        "harmonics_sec": 0.0,
        "delta_bake_sec": 0.0,
        "bands": 0,
        "frames": 0
    }

    fs = int(params.get('fs', 48000) or 48000)
    n_per_oct = int((calib.get("anchor_spectra") or {}).get("n_per_oct", params.get('n_per_oct', 12)))
    fmin = float(params.get('fmin_hz', 20.0))
    fmax = float(params.get('fmax_hz', 20000.0))
    frame_sec = float(params.get('frame_sec', 1.0))
    hop_sec = float(params.get('hop_sec', 0.5*frame_sec))
    hop_ratio = 1.0 - max(0.0, min(hop_sec/frame_sec if frame_sec>0 else 0.0, 1.0))
    band_grid = str(params.get('band_grid', 'iec-decimal'))
    trim_head_sec = float(params.get('trim_head_sec', 0.75))
    trim_tail_sec = float(params.get('trim_tail_sec', 0.75))
    highpass_hz   = float(params.get('highpass_hz', 20.0))

    rpm_bin_orig = float(params.get('sweep_rpm_bin', 50.0))
    stable_only = bool(params.get('sweep_stable_only', True))
    max_rpm_deriv = float(params.get('sweep_max_rpm_deriv', 80.0))  # rpm/s
    max_la_deriv  = float(params.get('sweep_max_la_deriv', 6.0))    # dB/s

    sweep_snr_ratio_min = float(params.get('sweep_snr_ratio_min', 1))
    head_align_sec = float(params.get('sweep_head_align_sec', 10.0))
    tail_align_sec = float(params.get('sweep_tail_align_sec', 10.0))

    sweep_low_freq_hz = float(params.get('sweep_low_freq_hz', 100.0))
    sweep_snr_ratio_min_low = float(params.get('sweep_snr_ratio_min_low', 3.0))

    auto_widen_min_med = float(params.get('auto_widen_min_med', 8.0))
    auto_widen_factor  = float(params.get('auto_widen_factor', 1.5))

    lowfreq_mean_smooth_below_hz = float(params.get('lowfreq_mean_smooth_below_hz', 0.0))
    lowfreq_mean_min_points      = int(params.get('lowfreq_mean_min_points', 16))
    lowfreq_mean_max_span_bands  = int(params.get('lowfreq_mean_max_span_bands', 32))

    sweep_bin_qf_percent = float(params.get('sweep_bin_qf_percent', 60.0))
    sweep_env_floor_dbA  = float(params.get('sweep_env_floor_dbA', -60.0))

    closure_mode = str(params.get('closure_mode', 'none')).strip().lower()

    # 谐波：显式开关（默认 False）
    harmonics_enable = bool(params.get('harmonics_enable', False))

    # 反演模式与基准权重（默认混合）
    rpm_invert_mode = str(params.get('rpm_invert_mode', 'hybrid')).strip().lower()
    rpm_invert_w_la = float(params.get('rpm_invert_w_la', 1.0))
    rpm_invert_w_h  = float(params.get('rpm_invert_w_h', 1.2))
    rpm_invert_h_max = int(params.get('rpm_invert_h_max', 6))

    # 新增：谐波权重自适应参数
    rpm_invert_adapt_enable   = bool(params.get('rpm_invert_adapt_enable', True))
    snr_db_lo = float(params.get('rpm_invert_adapt_snr_db_lo', 5.0))    # 低于此阈值几乎不用谐波
    snr_db_hi = float(params.get('rpm_invert_adapt_snr_db_hi', 20.0))   # 高于此阈值按满权重
    if not np.isfinite(snr_db_lo): snr_db_lo = 0.0
    if not np.isfinite(snr_db_hi) or snr_db_hi <= snr_db_lo: snr_db_hi = snr_db_lo + 1.0

    anchor = calib.get("anchor_spectra") or {}
    centers = np.array(anchor.get("centers_hz") or make_centers_iec61260(n_per_octave=n_per_oct, fmin=fmin, fmax=fmax), float)
    if centers.size == 0:
        raise RuntimeError("频带中心为空")
    timing["bands"] = int(centers.size)
    rpm_min = float(calib.get("rpm_min", np.nanmin(np.array(calib.get("rpm_nodes") or [], float))))
    rpm_max = float(calib.get("rpm_max", np.nanmax(np.array(calib.get("rpm_nodes") or [], float))))
    calib_model = calib.get("pchip_rpm_to_laeq_envsub")
    la_env_calib = float(calib.get("laeq_env_db"))
    E_envA_band = np.maximum(np.array((anchor.get("env_band_energy_A") or []), float), 0.0)
    if E_envA_band.size != centers.size:
        E_envA_band = np.zeros((centers.size,), float)

    # 叶片数（用于谐波辅助）
    try:
        model_id_param = params.get('model_id', None)
        model_id = int(model_id_param) if model_id_param is not None else None
    except Exception:
        model_id = None
    n_blade = _get_fan_blades_from_db(model_id)

    root = os.path.abspath(root_dir)
    sweep_dir = None
    for name in os.listdir(root):
        if name.lower() == "sweep":
            sweep_dir = os.path.join(root, name)
            break
    if not sweep_dir or not os.path.isdir(sweep_dir):
        raise RuntimeError("缺少 sweep/ 目录，已移除 anchor-only 回退")

    auds = list_audio(sweep_dir)
    if not auds:
        raise RuntimeError("sweep/ 无音频文件")

    wav_path = auds[0]
    awa_path = find_awa(sweep_dir)
    session_awadb = parse_awa_la(awa_path) if awa_path else float("nan")

    # 整段绝对口径
    t1 = time.perf_counter()
    x_raw, fs0 = read_audio_mono(wav_path, target_fs=fs, trim_head_sec=0.0, trim_tail_sec=0.0, highpass_hz=0.0, for_slm_like=True)
    timing["read_raw_sec"] += (time.perf_counter() - t1)

    t1 = time.perf_counter()
    la_full_bands, E_full_bands = laeq_full_via_bands_filterbank(
        x_raw, fs0, centers, n_per_oct, **_fb_kwargs(params)
    )
    timing["full_la_sec"] += (time.perf_counter() - t1)

    E_scale = 1.0
    if np.isfinite(session_awadb) and np.isfinite(E_full_bands) and E_full_bands > 0.0:
        target_E = (P0**2) * (10.0 ** (float(session_awadb) / 10.0))
        E_scale = float(target_E / E_full_bands)

    # 逐帧
    t1 = time.perf_counter()
    x, fs1 = read_audio_mono(wav_path, target_fs=fs, trim_head_sec=trim_head_sec, trim_tail_sec=trim_tail_sec,
                             highpass_hz=highpass_hz, for_slm_like=False)
    timing["read_proc_sec"] += (time.perf_counter() - t1)

    t1 = time.perf_counter()
    E_A_frames, _ = bands_time_energy_A(
        x, fs1, centers, n_per_oct, frame_sec, hop_ratio,
        grid=band_grid, **_fb_kwargs(params)
    )
    timing["frames_filter_sec"] += (time.perf_counter() - t1)

    K, T = E_A_frames.shape if E_A_frames.ndim == 2 else (centers.size, 0)
    timing["frames"] = int(T)
    if E_scale != 1.0:
        E_A_frames *= E_scale

    if T <= 2:
        raise RuntimeError("sweep 有效帧过少，无法建模")

    E_tot_frames = np.sum(E_A_frames, axis=0)
    LA_total_frames = db10_from_energy(E_tot_frames)

    # 绝对 LA 拟合所需的环境参考能量
    E_env_ref = (P0**2) * (10.0 ** (la_env_calib / 10.0))

    def _E_sub_fit_from_R(R: float) -> float:
        la_envsub = float(pchip_eval(calib_model, float(R))) if calib_model else float('nan')
        return (P0**2) * (10.0 ** (la_envsub / 10.0)) if np.isfinite(la_envsub) else float('nan')
    def LAabs_fit(R: float) -> float:
        E_sub = _E_sub_fit_from_R(R)
        if not np.isfinite(E_sub): return float('nan')
        return 10.0 * math.log10(max((E_env_ref + E_sub) / (P0**2), 1e-30))

    def _rpm_grid(rmin: float, rmax: float, step: float=1.0) -> np.ndarray:
        return np.arange(rmin, rmax+1e-9, max(0.5, step), dtype=float)

    def frames_from_secs(sec: float) -> int:
        hop_local = frame_sec * (1.0 - hop_ratio) if frame_sec > 0 else 0.0
        return max(1, int(round(sec / max(hop_local, 1e-6))))
    head_n = frames_from_secs(head_align_sec)
    tail_n = frames_from_secs(tail_align_sec)

    valid_mask = np.ones((T,), dtype=bool)
    if head_n > 0:  valid_mask[:min(T, head_n)] = False
    if tail_n > 0:  valid_mask[max(0, T - tail_n):] = False

    # 会话 Δ（诊断）
    head_med = float("nan"); tail_med = float("nan")
    head_fit = float("nan"); tail_fit = float("nan")
    head_delta = float("nan"); tail_delta = float("nan")
    deltas: List[float] = []
    if head_n > 0:
        m = min(T, head_n)
        head_med = float(np.median(LA_total_frames[:m])); head_fit = float(LAabs_fit(rpm_min))
        if np.isfinite(head_med) and np.isfinite(head_fit): deltas.append(head_med - head_fit)
    if tail_n > 0:
        m = min(T, tail_n)
        tail_med = float(np.median(LA_total_frames[T-m:])); tail_fit = float(LAabs_fit(rpm_max))
        if np.isfinite(tail_med) and np.isfinite(tail_fit): deltas.append(tail_med - tail_fit)
    delta_session = float(np.median(np.array(deltas, float))) if deltas else 0.0

    # 频带边界（谐波辅助所需）
    f1_edges, f2_edges = band_edges_from_centers(centers, n_per_oct, grid="iec-decimal")

    # 纯 LA 反演
    t1 = time.perf_counter()
    def _invert_track_la() -> np.ndarray:
        xs = _rpm_grid(rpm_min, rpm_max, 1.0)
        ys = np.array([LAabs_fit(float(x)) for x in xs], float)
        R_hat = np.zeros((T,), float)
        for t in range(T):
            y = float(LA_total_frames[t])
            if not valid_mask[t]:
                R_hat[t] = R_hat[t-1] if t>0 else rpm_min
            else:
                i = int(np.argmin(np.abs(ys - y)))
                R_hat[t] = float(xs[i])
        return R_hat
    R_hat_la = _invert_track_la()
    timing["invert_la_sec"] += (time.perf_counter() - t1)

    # 谐波辅助/混合反演（自适应权重）
    t1 = time.perf_counter()
    def _invert_track_hybrid() -> np.ndarray:
        if (rpm_invert_mode == 'la') or (n_blade is None) or (int(n_blade) <= 0):
            return _invert_track_la()

        xs = _rpm_grid(rpm_min, rpm_max, 1.0)
        la_abs_vec = np.array([LAabs_fit(float(x)) for x in xs], dtype=float)

        # 每帧邻带基线（避免重复）
        base_all = np.zeros_like(E_A_frames)
        for t in range(T):
            for k in range(K):
                base_all[k, t] = _local_baseline_pa2(E_A_frames[:, t], k, win_bands=3)

        def clamp01(v: float) -> float:
            return 0.0 if v<=0 else (1.0 if v>=1.0 else v)

        R_hat = np.zeros((T,), float)
        for t in range(T):
            if not valid_mask[t]:
                R_hat[t] = R_hat[t-1] if t > 0 else rpm_min
                continue
            y_db = float(LA_total_frames[t])
            if not np.isfinite(y_db):
                R_hat[t] = R_hat[t-1] if t > 0 else rpm_min
                continue

            E_t = E_A_frames[:, t]
            base_t = base_all[:, t]
            costs = np.zeros_like(xs)

            for iR, R in enumerate(xs):
                la_cost = abs(y_db - la_abs_vec[iR]) if np.isfinite(la_abs_vec[iR]) else 1e9

                # 计算谐波线谱和基线的加权和（与原逻辑一致的高阶衰减）
                f0 = float(n_blade) * (float(R) / 60.0)
                E_line_sum = 0.0
                E_base_sum = 0.0
                h_cost = 40.0  # 默认“找不到线谱”的较大代价
                if np.isfinite(f0) and f0 > 0.0:
                    h_max_eff = max(1, int(min(rpm_invert_h_max, math.floor((float(f2_edges[-1]) / max(1e-9, f0))))))
                    for h in range(1, h_max_eff + 1):
                        f_line = h * f0
                        idxs = np.where((f_line >= f1_edges) & (f_line <= f2_edges))[0]
                        if idxs.size == 0:
                            continue
                        k = int(idxs[0])
                        decay = 1.0 / (1.0 + 0.15*(h-1))
                        e_line = max(0.0, float(E_t[k] - base_t[k])) * decay
                        b_line = float(base_t[k]) * decay
                        E_line_sum += e_line
                        E_base_sum += max(0.0, b_line)
                    if E_line_sum > 0.0:
                        L_lines = 10.0 * math.log10(max(E_line_sum / (P0**2), 1e-30))
                        h_cost = -L_lines

                # 自适应权重：线谱相对邻带基线的 SNR（dB）→ [0,1]
                if rpm_invert_adapt_enable:
                    if E_line_sum <= 0.0:
                        alpha = 0.0
                    elif E_base_sum <= 0.0:
                        alpha = 1.0
                    else:
                        snr_db = 10.0 * math.log10(max(E_line_sum / max(E_base_sum, 1e-30), 1e-30))
                        alpha = clamp01((snr_db - snr_db_lo) / (snr_db_hi - snr_db_lo))
                    w_h_eff = rpm_invert_w_h * alpha
                else:
                    w_h_eff = rpm_invert_w_h

                costs[iR] = rpm_invert_w_la * la_cost + w_h_eff * h_cost

            j = int(np.argmin(costs))
            R_hat[t] = float(xs[j])
        return R_hat
    R_hat_hyb = _invert_track_hybrid()
    timing["invert_hybrid_sec"] += (time.perf_counter() - t1)

    # 头尾锁定/平滑/限速（略，保持原逻辑，同之前版本）
    t1 = time.perf_counter()
    def _post_process_track(R_hat: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
        R_proc = R_hat.copy()
        if head_n > 0:
            for t in range(min(T, head_n)): R_proc[t] = rpm_min
        if tail_n > 0:
            for t in range(max(0, T - tail_n), T): R_proc[t] = rpm_max
        if T >= 5:
            from collections import deque
            buf = deque(maxlen=5); tmp = np.zeros_like(R_proc)
            for i in range(T):
                buf.append(R_proc[i]); tmp[i] = np.median(np.array(list(buf)))
            R_proc = tmp
        hop = frame_sec * (1.0 - hop_ratio) if frame_sec > 0 else 0.0
        max_step = max_rpm_deriv * max(hop, 1e-6)
        for i in range(1, T):
            dr = R_proc[i] - R_proc[i-1]
            if abs(dr) > max_step:
                R_proc[i] = R_proc[i-1] + np.sign(dr) * max_step
        if head_n > 0:
            for t in range(min(T, head_n)): R_proc[t] = rpm_min
        if tail_n > 0:
            for t in range(max(0, T - tail_n), T): R_proc[t] = rpm_max

        stable_mask = np.ones((T,), bool)
        if stable_only and T >= 2:
            dR  = np.zeros((T,), float); dR[1:]  = np.diff(R_proc) / max(hop, 1e-6)
            dLA = np.zeros((T,), float); dLA[1:] = np.diff(LA_total_frames) / max(hop, 1e-6)
            stable_mask = (np.abs(dR) <= max_rpm_deriv) & (np.abs(dLA) <= max_la_deriv)
        return R_proc, stable_mask

    R_smooth_la,  stable_mask_la  = _post_process_track(R_hat_la)
    R_smooth_hyb, stable_mask_hyb = _post_process_track(R_hat_hyb)
    timing["post_process_sec"] += (time.perf_counter() - t1)

    # 分箱
    t1 = time.perf_counter()
    def do_binning(rpm_bin_val: float, R_track: np.ndarray, stable_mask_use: np.ndarray):
        rpm_min_local = float(np.nanmin(R_track)); rpm_max_local = float(np.nanmax(R_track))
        edges = np.arange(rpm_min, rpm_max + rpm_bin_val, rpm_bin_val, dtype=float)
        if edges.size < 2:
            edges = np.array([rpm_min, rpm_max], float)
        ctrs = (edges[:-1] + edges[1:]) / 2.0
        halfw = rpm_bin_val

        def tri_w(x, c):
            d = abs(x - c); return max(0.0, 1.0 - d/halfw)

        def weighted_quantile(v: np.ndarray, w: np.ndarray, q: float) -> float:
            v = np.asarray(v, float); w = np.asarray(w, float)
            m = np.isfinite(v) & np.isfinite(w) & (w > 0)
            if not np.any(m): return float("nan")
            vv = v[m]; ww = w[m]
            idx = np.argsort(vv); vv = vv[idx]; ww = ww[idx]
            c = np.cumsum(ww)
            if c[-1] <= 0: return float("nan")
            t = max(0.0, min(q, 1.0)) * c[-1]
            j = int(np.searchsorted(c, t, side='left'))
            j = max(0, min(j, vv.size - 1))
            return float(vv[j])

        env_floor_pa2 = (P0**2) * (10.0 ** (float(sweep_env_floor_dbA) / 10.0)) if np.isfinite(sweep_env_floor_dbA) else None

        Kloc = centers.size
        L_nodes_pre: List[List[float]] = [[] for _ in range(Kloc)]
        L_nodes_post: List[List[float]] = [[] for _ in range(Kloc)]
        counts: List[int] = []

        for c in ctrs:
            idx = np.arange(T)
            ws = np.array([
                tri_w(R_track[t], c) if ((not stable_only or stable_mask_use[t]) and valid_mask[t]) else 0.0
                for t in idx
            ], float)
            good = np.where(ws > 0)[0]
            counts.append(int(good.size))
            if int(good.size) < int(params.get('sweep_min_count_per_bin', 5)):
                for k in range(Kloc): L_nodes_pre[k].append(float("nan")); L_nodes_post[k].append(float("nan"))
                continue

            w_sel_full = ws[good]
            if np.sum(w_sel_full) <= 0:
                for k in range(Kloc): L_nodes_pre[k].append(float("nan")); L_nodes_post[k].append(float("nan"))
                continue

            Etot_sel = E_tot_frames[good]
            qf = max(0.0, min(sweep_bin_qf_percent / 100.0, 1.0))
            thr_Etot = weighted_quantile(Etot_sel, w_sel_full, qf) if qf < 1.0 else float("inf")
            frame_keep = np.ones_like(good, dtype=bool) if qf >= 1.0 else (Etot_sel <= thr_Etot)
            good2_idx = good[frame_keep]
            w_sel = w_sel_full[frame_keep]
            if w_sel.size == 0 or np.sum(w_sel) <= 0:
                for k in range(Kloc): L_nodes_pre[k].append(float("nan")); L_nodes_post[k].append(float("nan"))
                continue

            E_sel = E_A_frames[:, good2_idx]

            for k in range(Kloc):
                arr = E_sel[k, :].astype(float)
                ww  = w_sel.astype(float)
                envk = float(E_envA_band[k])
                if (env_floor_pa2 is not None) and np.isfinite(env_floor_pa2):
                    envk = max(envk, env_floor_pa2)
                ratio_req = sweep_snr_ratio_min_low if float(centers[k]) < sweep_low_freq_hz else sweep_snr_ratio_min
                m_snr = (arr > ratio_req * envk)
                if not np.any(m_snr):
                    L_nodes_pre[k].append(float("nan")); L_nodes_post[k].append(float("nan")); continue
                arr_keep = arr[m_snr]; w_keep = ww[m_snr]
                if np.sum(w_keep) <= 0:
                    L_nodes_pre[k].append(float("nan")); L_nodes_post[k].append(float("nan")); continue
                # pre：未做低频均值平滑
                E_stat_pre = float(np.average(arr_keep, weights=w_keep))
                E_stat_pre = max(0.0, E_stat_pre - envk)
                L_nodes_pre[k].append(float(10.0 * math.log10(max(E_stat_pre/(P0**2), 1e-30))))
                # post：低频均值平滑（后续一并做，提高一致性）
                L_nodes_post[k].append(L_nodes_pre[k][-1])

        # 低频跨带均值平滑（仅作用于 L_nodes_post）
        if len(ctrs) > 0:
            mask_low_mean = (centers < lowfreq_mean_smooth_below_hz)
            max_span = max(0, int(lowfreq_mean_max_span_bands))
            need_pts = max(1, int(lowfreq_mean_min_points))
            for j in range(len(ctrs)):
                col_pre = [L_nodes_post[k][j] for k in range(Kloc)]
                new_col = col_pre[:]
                for k in range(Kloc):
                    if not mask_low_mean[k]: continue
                    span = 0
                    while span <= max_span:
                        lo = max(0, k - span); hi = min(Kloc - 1, k + span)
                        vals = []
                        for ii in range(lo, hi + 1):
                            if centers[ii] >= lowfreq_mean_smooth_below_hz: continue
                            v = col_pre[ii]
                            if v is not None and np.isfinite(v):
                                vals.append(float(v))
                        if len(vals) >= need_pts or span == max_span:
                            if len(vals) > 0:
                                new_col[k] = float(np.mean(np.array(vals, dtype=float)))
                            break
                        span += 1
                for k in range(Kloc):
                    L_nodes_post[k][j] = new_col[k]

        def build_band_models_from_nodes(nodes_2d: List[List[float]]) -> List[Optional[Dict[str, Any]]]:
            out: List[Optional[Dict[str, Any]]] = []
            xs = ctrs.copy()
            for k in range(Kloc):
                ys = np.array(nodes_2d[k], float)
                msk = np.isfinite(ys)
                if np.sum(msk) < 2:
                    out.append(None)
                else:
                    mdl = _build_pchip_anchor(xs[msk].tolist(), ys[msk].tolist(), nonneg=False)
                    out.append(mdl)
            return out

        band_models_pre  = build_band_models_from_nodes(L_nodes_pre)
        band_models_post = build_band_models_from_nodes(L_nodes_post)
        return ctrs, counts, band_models_pre, band_models_post

    # 初次分箱（LA、Hybrid 各一套）
    ctrs_la, counts_la, band_models_pre_la, band_models_la = do_binning(rpm_bin_orig, R_smooth_la, stable_mask_la)
    ctrs_hy, counts_hy, band_models_pre_hy, band_models_hy = do_binning(rpm_bin_orig, R_smooth_hyb, stable_mask_hyb)
    timing["binning_sec"] += (time.perf_counter() - t1)

    # 自适应加宽（以 hybrid 计数为判据）
    auto_widen_applied = False
    final_rpm_bin = rpm_bin_orig
    ctrs, counts_per_bin = ctrs_hy, counts_hy
    band_models_pre, band_models = band_models_pre_hy, band_models_hy
    if counts_per_bin:
        med_cnt = float(np.median(np.array(counts_per_bin, float)))
        if np.isfinite(med_cnt) and med_cnt < auto_widen_min_med:
            t1 = time.perf_counter()
            final_rpm_bin = float(max(rpm_bin_orig * auto_widen_factor, rpm_bin_orig + 1.0))
            ctrs_la, counts_la, band_models_pre_la, band_models_la = do_binning(final_rpm_bin, R_smooth_la, stable_mask_la)
            ctrs_hy, counts_hy, band_models_pre_hy, band_models_hy = do_binning(final_rpm_bin, R_smooth_hyb, stable_mask_hyb)
            timing["binning_sec"] += (time.perf_counter() - t1)
            auto_widen_applied = True
            ctrs, counts_per_bin = ctrs_hy, counts_hy
            band_models_pre, band_models = band_models_pre_hy, band_models_hy

    # 谐波模型（受 harmonics_enable 控制）
    harmonics = {}
    if harmonics_enable:
        t1 = time.perf_counter()
        harmonics = _build_harmonic_models_from_nodes(
            centers=centers, n_per_oct=n_per_oct,
            rpm_nodes=ctrs.tolist(), per_frame_bandE=E_A_frames, per_frame_rpm=R_smooth_hyb,
            n_blade=n_blade, h_max=None, baseline_win_bands=3, kernel_sigma_bands=0.25
        )
        timing["harmonics_sec"] += (time.perf_counter() - t1)

    # Δ_pchip（以 hybrid 为准），并烘焙到 hybrid 与 la 两套模型
    t1 = time.perf_counter()
    corr_pchip: Optional[Dict[str, Any]] = None
    try:
        if calib_model and isinstance(calib_model, dict):
            delta_list: List[float] = []
            for r in ctrs:
                E_sum = 0.0
                for mdl in band_models:
                    if mdl and isinstance(mdl, dict):
                        y_db = float(pchip_eval(mdl, float(r)))
                        E_sum += (P0**2) * (10.0 ** (y_db / 10.0))
                # 谐波注入仅在 harmonics_enable 时考虑到总量
                if harmonics_enable and harmonics and harmonics.get("n_blade", 0) > 0:
                    f1e, f2e = f1_edges, f2_edges
                    sigma_b = float((harmonics.get("kernel") or {}).get("sigma_bands", 0.25))
                    topk = int((harmonics.get("kernel") or {}).get("topk", 3))
                    bpf = harmonics["n_blade"] * (float(r) / 60.0)
                    for item in (harmonics.get("models") or []):
                        mdlh = item.get("amp_pchip_db"); h = int(item.get("h", 0) or 0)
                        if h <= 0 or not mdlh: continue
                        Lh = float(pchip_eval(mdlh, float(r)))
                        if not np.isfinite(Lh): continue
                        Eh = (P0**2) * (10.0 ** (Lh/10.0))
                        for k, w in _distribute_line_to_bands(h*bpf, centers, f1e, f2e, sigma_bands=sigma_b, topk=topk):
                            E_sum += Eh * w
                la_synth = 10.0 * math.log10(max(E_sum/(P0**2), 1e-30))
                la_tgt = float(pchip_eval(calib_model, float(r)))
                delta_list.append(la_tgt - la_synth)
            corr_pchip = _build_pchip_anchor(ctrs.tolist(), delta_list, nonneg=False)
    except Exception:
        corr_pchip = None
    timing["delta_bake_sec"] += (time.perf_counter() - t1)

    def _apply_bake(models: List[Optional[Dict[str, Any]]]) -> List[Optional[Dict[str, Any]]]:
        return _apply_closure_bake_to_bands(models, corr_pchip) if corr_pchip else models

    band_models_baked_hy  = _apply_bake(band_models)
    band_models_baked_la  = _apply_bake(band_models_la)

    out_model = {
        "version": "rpm_spectral_from_sweep_v1",
        "centers_hz": centers.tolist(),
        "rpm_min": float(rpm_min), "rpm_max": float(rpm_max),
        "rpm_bin": float(final_rpm_bin),
        "rpm_grid_centers": ctrs.tolist(),
        "counts_per_bin": counts_per_bin,
        "calibration": {
            "laeq_env_db": la_env_calib,
            "session_env_db": la_env_calib,
            "session_delta_db": float(delta_session),
            "session_delta_method": "absolute-la",
            "session_awa_db": float(session_awadb) if np.isfinite(session_awadb) else None,
            "energy_scale": float(E_scale),
            "calib_model": calib_model,
            "rpm_peak": float(rpm_max),
            "rpm_peak_tol": 50.0,
            "n_per_oct": int(n_per_oct),
            "env_source": "calib",
            "harmonics_enabled": bool(harmonics_enable),
            "harmonics": harmonics if harmonics_enable else {},
            "fan_blades": int(n_blade),              # 新增：无论谐波是否启用都输出叶片数
            "laeq_correction_db_pchip": corr_pchip,
            "closure_mode": "none",
            "closure": { "applied": bool(corr_pchip is not None), "method": "baked-pchip" },
            "sweep_params": {
                "sweep_bin_qf_percent": float(sweep_bin_qf_percent),
                "sweep_env_floor_dbA": float(sweep_env_floor_dbA),
                "sweep_snr_ratio_min": float(sweep_snr_ratio_min),
                "sweep_snr_ratio_min_low": float(sweep_snr_ratio_min_low),
                "sweep_low_freq_hz": float(sweep_low_freq_hz),
                "sweep_rpm_bin": float(final_rpm_bin),
                "auto_widen_min_med": float(auto_widen_min_med),
                "auto_widen_factor": float(auto_widen_factor),
                "auto_widen_applied": bool(auto_widen_applied)
            },
            "rpm_invert": {
                "mode": rpm_invert_mode,
                "w_la": float(rpm_invert_w_la),
                "w_h": float(rpm_invert_w_h),
                "track_final": "hybrid" if rpm_invert_mode != 'la' and n_blade and n_blade > 0 else "la",
                "adapt": {
                    "enabled": bool(rpm_invert_adapt_enable),
                    "snr_db_lo": float(snr_db_lo),
                    "snr_db_hi": float(snr_db_hi)
                }
            },
            "session_align": {
                "head": {
                    "frames_used": int(min(T, head_n)),
                    "sec": float(min(T, head_n)) * float(frame_sec * (1.0 - hop_ratio) if frame_sec>0 else 0.0),
                    "la_total_med_db": float(head_med) if np.isfinite(head_med) else None,
                    "la_fit_abs_db": float(head_fit) if np.isfinite(head_fit) else None,
                    "delta_db": float(head_delta) if np.isfinite(head_delta) else None
                },
                "tail": {
                    "frames_used": int(min(T, tail_n)),
                    "sec": float(min(T, tail_n)) * float(frame_sec * (1.0 - hop_ratio) if frame_sec>0 else 0.0),
                    "la_total_med_db": float(tail_med) if np.isfinite(tail_med) else None,
                    "la_fit_abs_db": float(tail_fit) if np.isfinite(tail_fit) else None,
                    "delta_db": float(tail_delta) if np.isfinite(tail_delta) else None
                },
                "head_align_sec": float(head_align_sec),
                "tail_align_sec": float(tail_align_sec),
                "definition": "absolute LA: Δ=median(LA_total) - LAabs_fit(rpm_min/max)"
            },
            "sweep_auto_widen": {
                "applied": bool(auto_widen_applied),
                "orig_rpm_bin": float(rpm_bin_orig),
                "final_rpm_bin": float(final_rpm_bin)
            }
        },
        "band_models_pchip_la": band_models_baked_la,
        "band_models_pchip_hybrid": band_models_baked_hy,
        "band_models_pchip": band_models_baked_hy,
        "band_models_pchip_pre": band_models_pre_hy
    }

    # 汇总阶段耗时（包含校准阶段来自 calib.stats.timings）
    timing["total_sec"] = float(time.perf_counter() - t_all)
    calib_stats = calib.get("stats") or {}
    out_model["calibration"]["timings"] = {
        "calibration_phase": (calib_stats.get("timings") or {}),
        "sweep_phase": timing,
        "overall_sec": float(
            (calib_stats.get("timings") or {}).get("total_sec", 0.0) + timing["total_sec"]
        )
    }

    # 诊断 CSV（保持原逻辑）
    if bool(params.get('dump_anchor_fit_csv', False)):
        try:
            import csv
            out_base = os.path.join(os.path.abspath(root_dir), str(params.get('dump_anchor_fit_dir', 'anchor_fit_csv')))
            os.makedirs(out_base, exist_ok=True)
            path_time = os.path.join(out_base, 'sweep_time_rpm_la.csv')
            bin_ctrs_arr = np.array(out_model["rpm_grid_centers"], dtype=float)
            with open(path_time, 'w', newline='', encoding='utf-8') as f:
                w = csv.writer(f)
                w.writerow(["frame_idx","t_start_sec","t_center_sec","rpm_la","rpm_hybrid","valid","la_total_db"])
                hop = frame_sec * (1.0 - hop_ratio) if frame_sec>0 else 0.0
                for t in range(timing["frames"]):
                    t_start = float(t * hop)
                    t_center = float(t * hop + 0.5 * frame_sec)
                    la_now = float(LA_total_frames[t]) if np.isfinite(LA_total_frames[t]) else ""
                    v = int(bool(valid_mask[t]))
                    w.writerow([t, t_start, t_center, float(R_smooth_la[t]), float(R_smooth_hyb[t]), v, la_now])
        except Exception:
            pass

    return out_model

# ---------------- 统一入口 ----------------
def run_calibration_and_model(root_dir: str,
                              params: Dict[str, Any],
                              out_dir: Optional[str]=None,
                              model_id: Optional[int] = None,
                              condition_id: Optional[int] = None) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    calib, per_rpm_rows = calibrate_from_points_in_memory(root_dir, params)

    # 将 model_id 透传给 sweep 构模（用于 DB 读取叶片数）
    if model_id is not None:
        params = dict(params)  # 复制一份，避免外部字典被修改
        params['model_id'] = int(model_id)

    has_sweep = os.path.isdir(os.path.join(os.path.abspath(root_dir), "sweep"))
    if not has_sweep:
        raise RuntimeError("缺少 sweep/ 长录音，anchor-only 回退已移除")

    model = build_model_from_calib_with_sweep_in_memory(root_dir, calib, params)

    # 可选导出“锚点原生 vs 拟合”同倍频程 CSV
    if bool(params.get('dump_anchor_fit_csv', False)):
        try:
            dump_anchor_fit_csv(root_dir, model, calib,
                                with_harmonics=bool(params.get('dump_anchor_fit_with_harmonics', True)),
                                subdir=str(params.get('dump_anchor_fit_dir', 'anchor_fit_csv')))
        except Exception:
            # 忽略导出失败，保证主流程不受影响
            pass

    if out_dir:
        try:
            os.makedirs(out_dir, exist_ok=True)
            with open(os.path.join(out_dir, 'calib.json'), 'w', encoding='utf-8') as f:
                json.dump(calib, f, ensure_ascii=False, indent=2)
            import csv
            with open(os.path.join(out_dir, 'calibration_report.csv'), 'w', newline='', encoding='utf-8') as f:
                w = csv.DictWriter(f, fieldnames=[
                    "scope","rpm","file",
                    "awa_la_db","proc_la_raw_db","proc_la_post_env_db",
                    "delta_raw_db","delta_post_env_db"
                ])
                w.writeheader()
                env = next((r for r in per_rpm_rows if int(r['rpm'])==0), None)
                if env:
                    w.writerow({
                        "scope":"env","rpm":"","file":"",
                        "awa_la_db": env.get('la_env_db'),
                        "proc_la_raw_db": env.get('la_raw_db'),
                        "proc_la_post_env_db": "",
                        "delta_raw_db": env.get('delta_raw_db'),
                        "delta_post_env_db": ""
                    })
                for r in per_rpm_rows:
                    if int(r['rpm']) == 0: continue
                    w.writerow({
                        "scope":"rpm","rpm":int(r['rpm']),"file":"",
                        "awa_la_db": "",
                        "proc_la_raw_db": r.get('la_raw_db'),
                        "proc_la_post_env_db": r.get('la_post_env_db'),
                        "delta_raw_db": "",
                        "delta_post_env_db": ""
                    })
        except Exception:
            pass
    return model, per_rpm_rows

# ---------------- 推理辅助：按模型生成频带谱（含谐波；闭合可选） ----------------
def predict_spectrum_db_with_harmonics(model: Dict[str, Any], rpm: float) -> Tuple[List[Optional[float]], float]:
    if not model or not isinstance(model, dict):
        return [], float("nan")
    centers = np.array(model.get("centers_hz") or [], float)
    if centers.size == 0:
        return [], float("nan")
    calib = model.get("calibration") or {}
    n_per_oct = int(calib.get("n_per_oct", 12))
    f1, f2 = band_edges_from_centers(centers, n_per_oct, grid="iec-decimal")

    bands = model.get("band_models_pchip") or []
    Es = np.zeros((centers.size,), dtype=float)
    for i, mdl in enumerate(bands):
        if mdl and isinstance(mdl, dict):
            y = float(pchip_eval(mdl, float(rpm)))
            Es[i] = (P0**2) * (10.0 ** (y / 10.0))
        else:
            Es[i] = 0.0

    harm = (calib.get("harmonics") or {})
    harmonics_enabled = bool(calib.get("harmonics_enabled", False))
    if harmonics_enabled and harm and isinstance(harm, dict) and harm.get("n_blade", 0) > 0:
        n_blade = int(harm["n_blade"])
        kernel = harm.get("kernel") or {}
        sigma_b = float(kernel.get("sigma_bands", 0.25))
        topk = int(kernel.get("topk", 3))
        bpf = n_blade * (float(rpm) / 60.0)
        for item in (harm.get("models") or []):
            mdl = item.get("amp_pchip_db")
            h = int(item.get("h", 0) or 0)
            if h <= 0 or not mdl or not isinstance(mdl, dict):
                continue
            f_line = h * bpf
            Lh_db = float(pchip_eval(mdl, float(rpm)))
            if not np.isfinite(Lh_db):
                continue
            Eh = (P0**2) * (10.0 ** (Lh_db / 10.0))
            # 使用与建模阶段相同的分配
            logc = np.log(np.maximum(centers, 1e-30))
            w = np.exp(-0.5 * ((np.log(max(f_line, 1e-30)) - logc) / max(1e-6, sigma_b))**2)
            inside = ((f_line >= f1) & (f_line <= f2)).astype(float)
            w = w * inside
            if np.all(w <= 0):
                continue
            idx = np.argsort(-w)[:max(1, int(topk))]
            ww = w[idx]; ww = ww / max(1e-30, np.sum(ww))
            for k_i, w_i in zip(idx.tolist(), ww.tolist()):
                Es[k_i] += Eh * w_i

    la_now = 10.0 * math.log10(max(float(np.sum(Es)) / (P0**2), 1e-30))
    out_db: List[Optional[float]] = []
    for i in range(centers.size):
        E = float(Es[i])
        out_db.append(None if E <= 0 else 10.0 * math.log10(max(E / (P0**2), 1e-30)))
    return out_db, la_now

# ---------------- 新增：导出“锚点原生 vs 拟合”同倍频程 CSV ----------------
def dump_anchor_fit_csv(root_dir: str,
                        model: Dict[str, Any],
                        calib: Dict[str, Any],
                        with_harmonics: bool = True,
                        subdir: str = "anchor_fit_csv"):
    """
    为每个锚点转速导出 CSV：band_idx, center_hz, orig_db, fit_db, diff_db
    - with_harmonics=True: 使用 predict_spectrum_db_with_harmonics（模型已烘焙闭合）
    - with_harmonics=False: 仅用 band_models_pchip（基线），不注入谐波
    """
    anchor = calib.get("anchor_spectra") or {}
    items = anchor.get("items") or []
    centers_anchor = np.array(anchor.get("centers_hz") or [], float)
    centers_model = np.array(model.get("centers_hz") or [], float)
    if centers_anchor.size == 0 or centers_model.size == 0 or not items:
        return

    # 频带对齐：最近且相对误差 ≤1%
    pairs = []
    for ia, fa in enumerate(centers_anchor):
        if not np.isfinite(fa): continue
        im = int(np.argmin(np.abs(centers_model - fa)))
        if abs(centers_model[im] - fa) / max(1e-9, fa) <= 0.01:
            pairs.append((ia, im))
    if len(pairs) < 1:
        return

    out_base = os.path.join(os.path.abspath(root_dir), subdir)
    os.makedirs(out_base, exist_ok=True)

    def baseline_only_spectrum(model_json: Dict[str, Any], rpm: float) -> List[Optional[float]]:
        bands = model_json.get("band_models_pchip") or []
        out = []
        for mdl in bands:
            if mdl and isinstance(mdl, dict):
                v = float(_eval_pchip_local(mdl, float(rpm)))
                out.append(v if np.isfinite(v) else None)
            else:
                out.append(None)
        return out

    for it in items:
        rpm0 = float(it.get("rpm"))
        orig_spec = it.get("spectrum_db") or []
        if with_harmonics:
            fit_spec, _ = predict_spectrum_db_with_harmonics(model, rpm0)
        else:
            fit_spec = baseline_only_spectrum(model, rpm0)

        # 写 CSV
        fn = f"R{int(round(rpm0))}_fit_compare.csv"
        path = os.path.join(out_base, fn)
        with open(path, "w", encoding="utf-8") as f:
            f.write("band_idx,center_hz,orig_db,fit_db,diff_db\n")
            for ia, im in pairs:
                c = centers_anchor[ia]
                o = orig_spec[ia] if ia < len(orig_spec) else None
                v = fit_spec[im] if im < len(fit_spec) else None
                if o is None or (isinstance(o,float) and (o!=o)):
                    o_s = ""
                else:
                    o_s = f"{float(o):.3f}"
                if v is None or (isinstance(v,float) and (v!=v)):
                    v_s = ""; d_s = ""
                else:
                    v_s = f"{float(v):.3f}"
                    if o_s != "":
                        d = float(v) - float(o)
                        d_s = f"{d:+.3f}"
                    else:
                        d_s = ""
                f.write(f"{im},{c:.6f},{o_s},{v_s},{d_s}\n")

# 新增一次性工具：把 Δ(R) 烘焙到每个频带的 PCHIP 中
def _apply_closure_bake_to_bands(band_models: List[Optional[Dict[str, Any]]],
                                 delta_pchip: Optional[Dict[str, Any]]) -> List[Optional[Dict[str, Any]]]:
    if not isinstance(delta_pchip, dict) or not band_models:
        return band_models
    out: List[Optional[Dict[str, Any]]] = []
    for mdl in band_models:
        if not (mdl and isinstance(mdl, dict)):
            out.append(mdl); continue
        xs = mdl.get("x") or []
        ys = mdl.get("y") or []
        if not (isinstance(xs, list) and isinstance(ys, list) and len(xs) == len(ys) and len(xs) >= 2):
            out.append(mdl); continue
        ys_new: List[float] = []
        for x, y in zip(xs, ys):
            d = float(pchip_eval(delta_pchip, float(x)))
            ys_new.append(float(y) + (d if np.isfinite(d) else 0.0))
        baked = _build_pchip_anchor([float(v) for v in xs], ys_new, nonneg=False)
        out.append(baked)
    return out

def bands_time_energy_A(x: np.ndarray,
                        fs: int,
                        centers: np.ndarray,
                        n_per_oct: int,
                        frame_sec: float,
                        hop_ratio: float,
                        grid: str = "iec-decimal",
                        *,
                        bands_filter_order: int = 4,
                        use_fir_cpb: bool = False,
                        fir_base_taps: int = 256) -> Tuple[np.ndarray, np.ndarray]:
    centers = np.asarray(centers, float)
    K = int(centers.size)
    if K == 0 or x.size == 0 or fs <= 0 or frame_sec <= 0:
        return np.zeros((K, 0), dtype=float), np.zeros((0,), dtype=float)

    centers_key = tuple(float(c) for c in centers.tolist())
    if use_fir_cpb:
        fb = list(_cached_fir_bank(fs, n_per_oct, centers_key, fir_base_taps))
        is_fir = True
    else:
        fb = list(_cached_iir_bank(fs, n_per_oct, centers_key, bands_filter_order))
        is_fir = False

    win = int(max(256, round(frame_sec * fs)))
    hop_samp = int(round(win * (1.0 - hop_ratio))) or win
    N = int(x.size)
    # 计算所有帧起点
    starts = np.arange(0, max(0, N - win + 1), hop_samp, dtype=int)
    T = int(starts.size)

    A_db = a_weight_db(centers)
    W_A = (10.0 ** (A_db / 10.0)).astype(float)
    E_A = np.zeros((K, T), dtype=float)

    # 预生成“均方滑窗”的卷积核用于向量化帧均方（避免 Python 内层循环）
    # 先做 y^2 的滑动平均：用一维箱型核做 oaconvolve，再在帧起点抽样
    box = np.ones(win, dtype=float) / float(win)

    xf = x.astype(float, copy=False)
    for k in range(K):
        filt = fb[k]
        if filt is None:
            continue
        if is_fir:
            # 用重叠-相加 FFT 卷积，长序列/长 taps 明显快于 lfilter
            y = signal.oaconvolve(xf, np.asarray(filt, dtype=float), mode='same')
        else:
            y = signal.sosfilt(np.asarray(filt), xf)
        y2 = y * y
        # 对 y2 做滑动平均（能量窗），再等间隔抽样
        avg = signal.oaconvolve(y2, box, mode='valid')  # 长度 N - win + 1
        if avg.size <= 0 or T <= 0:
            continue
        E_A[k, :] = avg[starts] * float(W_A[k])

    Etot_A = np.sum(E_A, axis=0) if T > 0 else np.zeros((0,), dtype=float)
    return E_A, Etot_A


def laeq_full_via_bands_filterbank(x: np.ndarray,
                                   fs: int,
                                   centers: np.ndarray,
                                   n_per_oct: int,
                                   *,
                                   bands_filter_order: int = 4,
                                   use_fir_cpb: bool = False,
                                   fir_base_taps: int = 256) -> Tuple[float, float]:
    centers = np.asarray(centers, float)
    if centers.size == 0 or x.size == 0 or fs <= 0:
        return float('nan'), 0.0

    centers_key = tuple(float(c) for c in centers.tolist())
    if use_fir_cpb:
        fb = list(_cached_fir_bank(fs, n_per_oct, centers_key, fir_base_taps))
        is_fir = True
    else:
        fb = list(_cached_iir_bank(fs, n_per_oct, centers_key, bands_filter_order))
        is_fir = False

    A_db = a_weight_db(centers)
    W_A = (10.0 ** (A_db / 10.0)).astype(float)

    xf = x.astype(float, copy=False)
    E_bands_A = np.zeros((centers.size,), dtype=float)
    for k, filt in enumerate(fb):
        if filt is None:
            continue
        if is_fir:
            y = signal.oaconvolve(xf, np.asarray(filt, dtype=float), mode='same')
        else:
            y = signal.sosfilt(np.asarray(filt), xf)
        E_bands_A[k] = float(np.mean(y * y)) * float(W_A[k])

    Etot = float(np.sum(E_bands_A))
    LAeq = 10.0 * math.log10(max(Etot / (P0**2), 1e-30)) if Etot > 0 else float('nan')
    return LAeq, Etot

def _design_cpb_filterbank_iir(centers: np.ndarray,
                               fs: int,
                               n_per_oct: int,
                               order: int = 4,
                               f_lo_limit: float = 0.5) -> List[Optional[np.ndarray]]:
    """
    设计 IIR (Butterworth) 1/n 倍频程带通滤波器组，返回 sos 列表。
    order 为 butter 的阶数（总阶数），推荐 4~8。
    """
    centers = np.asarray(centers, float)
    nyq = fs * 0.5
    if centers.size == 0 or fs <= 0:
        return [None] * int(centers.size)
    g = 2.0 ** (1.0 / (2.0 * float(n_per_oct)))  # f1=fc/g f2=fc*g
    sos_list: List[Optional[np.ndarray]] = []
    for fc in centers:
        if not (np.isfinite(fc) and fc > 0):
            sos_list.append(None); continue
        f1 = max(f_lo_limit, float(fc) / g)
        f2 = float(fc) * g
        if f1 >= f2 or f1 >= nyq or f2 <= 0:
            sos_list.append(None); continue
        wn1 = f1 / nyq
        wn2 = min(0.999, f2 / nyq)
        if wn1 <= 0 or wn1 >= wn2:
            sos_list.append(None); continue
        try:
            sos = signal.butter(int(order), [wn1, wn2], btype='band', output='sos')
        except Exception:
            sos = None
        sos_list.append(sos if sos is not None else None)
    return sos_list

def _design_cpb_filterbank_fir(centers: np.ndarray,
                               fs: int,
                               n_per_oct: int,
                               base_taps: int = 256,
                               f_lo_limit: float = 0.5,
                               window: str = 'hann') -> List[Optional[np.ndarray]]:
    """
    FIR 线性相位 1/n 倍频程滤波器组设计（窗函数法）。
    返回每个频带的 (taps, delay) 形式：存放 numpy 数组（coeff），不使用 sos。
    base_taps: 基准 taps 数，实际按带宽缩放：taps_scale = ref_bw / bw
              ref_bw 取最宽带的带宽；最终 taps = int(base_taps * taps_scale)，并夹在 [base_taps//2, base_taps*2]
    """
    centers = np.asarray(centers, float)
    nyq = fs * 0.5
    if centers.size == 0 or fs <= 0:
        return [None] * int(centers.size)

    g = 2.0 ** (1.0 / (2.0 * float(n_per_oct)))
    # 计算每带理论带宽
    bw_list = []
    for fc in centers:
        f1 = max(f_lo_limit, fc / g)
        f2 = fc * g
        bw_list.append(max(1e-9, f2 - f1))
    bw_arr = np.array(bw_list)
    ref_bw = float(np.max(bw_arr))  # 最宽带作为参考

    fir_bank: List[Optional[np.ndarray]] = []
    for i, fc in enumerate(centers):
        if not (np.isfinite(fc) and fc > 0):
            fir_bank.append(None); continue
        f1 = max(f_lo_limit, fc / g)
        f2 = fc * g
        if f1 >= f2 or f1 >= nyq or f2 <= 0:
            fir_bank.append(None); continue
        bw = max(1e-9, f2 - f1)
        taps_scale = ref_bw / bw
        taps = int(base_taps * taps_scale)
        taps = max(base_taps // 2, min(taps, base_taps * 2))  # 限制范围
        # 归一化到 [0,1]
        pass_lo = f1 / nyq
        pass_hi = min(0.999, f2 / nyq)
        if pass_lo <= 0 or pass_lo >= pass_hi:
            fir_bank.append(None); continue
        try:
            # firwin 带通：使用带阻两个截止 (low, high)，默认窗函数
            coeff = signal.firwin(taps, [pass_lo, pass_hi], pass_zero=False, window=window)
        except Exception:
            coeff = None
        fir_bank.append(coeff if coeff is not None else None)
    return fir_bank

def _get_progress_hook(params: Dict[str, Any]):
    """从 params 取出可选的进度回调。要求签名：hook(percent_0_100: float, message: str='')"""
    if not isinstance(params, dict):
        return None
    h = params.get('_progress_hook')
    return h if callable(h) else None

def _emit_progress(hook, base: float, span: float, frac: float, msg: str = ''):
    """
    将局部进度 frac[0,1] 映射为总进度：percent = base + span * frac，并调用 hook。
    """
    if not hook: 
        return
    try:
        frac = 0.0 if frac < 0 else (1.0 if frac > 1 else float(frac))
        percent = base + span * frac
        percent = max(0.0, min(100.0, float(percent)))
        hook(percent, msg or '')
    except Exception:
        pass