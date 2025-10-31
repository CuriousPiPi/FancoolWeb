# -*- coding: utf-8 -*-

import os, re, math, json, sys
from typing import Dict, Any, List, Tuple, Optional

import numpy as np
import soundfile as sf
from scipy import signal

# 依赖 app/curves/pchip_cache
try:
    from app.curves.pchip_cache import build_pchip_model_with_opts as pchip_build, get_or_build_pchip as pchip_get
except Exception:
    CURVES_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../app/curves'))
    if CURVES_DIR not in sys.path:
        sys.path.append(CURVES_DIR)
    from pchip_cache import build_pchip_model_with_opts as pchip_build, get_or_build_pchip as pchip_get

P0 = 20e-6
AUDIO_EXTS = (".wav", ".flac", ".ogg", ".m4a", ".mp3", ".aac", ".wma")

AWA_NUM = r"([-+]?\d+(?:\.\d+)?)"
_R_RPM = re.compile(r'^[Rr](\d+)$')

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
    # 去掉自身频带
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

def _build_harmonic_models_from_anchors(centers: np.ndarray,
                                        n_per_oct: int,
                                        anchor_items: List[Dict[str, Any]],
                                        n_blade: int,
                                        h_max: Optional[int] = None,
                                        baseline_win_bands: int = 3,
                                        kernel_sigma_bands: float = 0.25) -> Dict[str, Any]:
    f1, f2 = band_edges_from_centers(centers, n_per_oct, grid="iec-decimal")
    rpm_list: List[float] = []
    bandE_by_rpm: Dict[float, np.ndarray] = {}
    for it in anchor_items:
        r = float(it.get("rpm") or float("nan"))
        spec = it.get("spectrum_db")
        if not np.isfinite(r) or not isinstance(spec, list) or len(spec) != centers.size:
            continue
        E = np.array([_dbA_band_to_pa2(v) for v in spec], dtype=float)
        bandE_by_rpm[r] = E
        rpm_list.append(r)
    if not rpm_list:
        return {}
    rpm_unique = sorted(set(rpm_list))
    rpm_min, rpm_max = min(rpm_unique), max(rpm_unique)
    if not h_max:
        fmax = float(f2[-1])
        bpf_max = (n_blade * rpm_max) / 60.0
        h_max = int(max(1, math.floor(fmax / max(1e-9, bpf_max))))
    models = []
    for h in range(1, int(h_max) + 1):
        xs: List[float] = []
        ys_db: List[float] = []
        for r in rpm_unique:
            E_k = bandE_by_rpm.get(r)
            if E_k is None: continue
            f_line = h * n_blade * (r / 60.0)
            idxs = np.where((f_line >= f1) & (f_line <= f2))[0]
            if idxs.size == 0:
                continue
            k = int(idxs[0])
            E_base = _local_baseline_pa2(E_k, k, win_bands=baseline_win_bands)
            E_line = max(0.0, float(E_k[k] - E_base))
            if E_line <= 0.0:
                continue
            xs.append(r)
            ys_db.append(10.0 * math.log10(max(E_line / (P0**2), 1e-30)))
        if len(xs) == 0:
            mdl = None
        elif len(xs) == 1:
            mdl = _build_pchip_anchor([rpm_min, rpm_max], [ys_db[0], ys_db[0]], nonneg=False)
        else:
            mdl = _build_pchip_anchor(xs, ys_db, nonneg=False)
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
    if x.ndim > 1:
        x = np.mean(x, axis=1)
    x = x.astype(np.float64)

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
        f, Pxx = signal.welch(seg, fs=fs, window='hann', nperseg=nperseg, noverlap=noverlap,
                              detrend='constant', return_onesided=True, scaling='spectrum')
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

def bands_time_energy_A(x: np.ndarray, fs: int, centers: np.ndarray, n_per_oct: int,
                        frame_sec: float, hop_ratio: float, grid: str = "iec-decimal") -> Tuple[np.ndarray, np.ndarray]:
    f1, f2 = band_edges_from_centers(centers, n_per_oct, grid=grid)
    f, psds = psd_frames_welch(x, fs, frame_sec, hop_ratio)
    if f.size == 0 or len(psds) == 0:
        return np.zeros((centers.size, 0)), np.zeros((0,))
    K = centers.size
    T = len(psds)
    E = np.zeros((K, T), dtype=float)
    Etot = np.zeros((T,), dtype=float)
    for t, Pxx in enumerate(psds):
        Eb = integrate_psd_to_bands_A(f, Pxx, f1, f2)
        E[:, t] = Eb
        Etot[t] = float(np.sum(Eb))
    return E, Etot

# ---------------- AWA/IO ----------------
def find_awa(folder: str) -> Optional[str]:
    cands = [os.path.join(folder, fn) for fn in os.listdir(folder) if fn.lower().endswith(".awa")]
    return cands[0] if cands else None

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
    return sorted([os.path.join(folder, fn) for fn in os.listdir(folder) if fn.lower().endswith(AUDIO_EXTS)])

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

# ---------------- 流水线：标定 → 频谱模型 ----------------
def calibrate_from_points_in_memory(root_dir: str, params: Dict[str, Any]) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    fs = int(params.get('fs', 48000) or 48000)
    n_per_oct = int(params.get('n_per_oct', 12))
    fmin = float(params.get('fmin_hz', 20.0))
    fmax = float(params.get('fmax_hz', 20000.0))
    frame_sec = float(params.get('frame_sec', 1.0))
    hop_sec = float(params.get('hop_sec', 0.5*frame_sec))
    hop_ratio = 1.0 - max(0.0, min(hop_sec/frame_sec if frame_sec>0 else 0.0, 1.0))
    band_grid = str(params.get('band_grid', 'iec-decimal'))

    trim_head_sec = float(params.get('trim_head_sec', 0.5))
    trim_tail_sec = float(params.get('trim_tail_sec', 0.5))
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

    root = os.path.abspath(root_dir)
    env_dir = os.path.join(root, "env")
    if not os.path.isdir(env_dir):
        raise RuntimeError("缺少 env/ 目录")

    centers = make_centers_iec61260(n_per_octave=n_per_oct, fmin=fmin, fmax=fmax) if band_grid == 'iec-decimal' else \
              make_centers_iec61260(n_per_octave=n_per_oct, fmin=fmin, fmax=fmax)
    if centers.size == 0:
        raise RuntimeError("频带中心为空，请调整 fmin/fmax")
    K = centers.size

    env_awa_path = find_awa(env_dir)
    if not env_awa_path:
        raise RuntimeError("env/ 缺少 .AWA")
    LAeq_env_awa = parse_awa_la(env_awa_path)
    if not np.isfinite(LAeq_env_awa):
        raise RuntimeError("env/.AWA 缺少 LAeq")

    env_files = list_audio(env_dir)
    if not env_files:
        raise RuntimeError("env/ 无音频文件")

    E_env_A_full_list = []
    for p in env_files:
        x_full, fs_full = read_audio_mono(p, fs, for_slm_like=True)
        E_A_full, _ = bands_time_energy_A(x_full, fs_full, centers, n_per_oct, frame_sec, hop_ratio, grid=band_grid)
        E_env_A_full_list.append(E_A_full)
    E_env_A_mean = np.mean(np.hstack(E_env_A_full_list), axis=1) if E_env_A_full_list else np.zeros((K,))
    sA_env = (P0 * 10.0**(LAeq_env_awa/20.0)) / math.sqrt(max(float(np.sum(E_env_A_mean)), 1e-30))
    s2A_env = sA_env**2

    E_env_A_proc_list, Etot_env_list = [], []
    for p in env_files:
        x_p, fs_p = read_audio_mono(p, fs, trim_head_sec, trim_tail_sec, highpass_hz, for_slm_like=False)
        E_A_p, Etot = bands_time_energy_A(x_p, fs_p, centers, n_per_oct, frame_sec, hop_ratio, grid=band_grid)
        E_env_A_proc_list.append(E_A_p); Etot_env_list.append(Etot)
    E_env_A_frames = np.hstack(E_env_A_proc_list) if E_env_A_proc_list else np.zeros((K,0))
    Etot_env = np.concatenate(Etot_env_list) if Etot_env_list else np.zeros((0,))

    E_env_FS_A_rob = aggregate_two_stage_with_preband_mad(
        E_env_A_frames, Etot_env, qf_percent=env_qf, qb_percent=env_qb, mad_tau=mad_tau, enable_mad_pre_band=env_mad_on
    )
    E_env12_A_pa2_base = s2A_env * E_env_FS_A_rob
    la_env_from_base = db10_from_energy(np.array([np.sum(E_env12_A_pa2_base)])).item()

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
        if not os.path.isdir(d) or os.path.basename(d).lower() == "env":
            continue
        m = _R_RPM.match(os.path.basename(d))
        rpm = float(m.group(1)) if m else parse_rpm_from_name(name)
        files = list_audio(d)
        if not files:
            continue

        awa_path = find_awa(d)
        LAeq_dir = parse_awa_la(awa_path) if awa_path else float("nan")

        E_raw_list_pa2: List[np.ndarray] = []
        E_sub_list_pa2: List[np.ndarray] = []
        la_raw_files: List[float] = []
        la_sub_files: List[float] = []

        for ap in files:
            x_full, fs_full = read_audio_mono(ap, fs, for_slm_like=True)
            E_A_full, _ = bands_time_energy_A(x_full, fs_full, centers, n_per_oct, frame_sec, hop_ratio, grid=band_grid)
            E_A_full_mean = np.mean(E_A_full, axis=1) if E_A_full.size else np.zeros((K,))
            if np.isfinite(LAeq_dir):
                sA_use = (P0 * 10.0**(LAeq_dir/20.0)) / math.sqrt(max(float(np.sum(E_A_full_mean)), 1e-30))
            else:
                sA_use = sA_env
            s2A_use = sA_use**2

            x_proc, fs_proc = read_audio_mono(ap, fs, trim_head_sec, trim_tail_sec, highpass_hz, for_slm_like=False)
            E_A_proc, Etot = bands_time_energy_A(x_proc, fs_proc, centers, n_per_oct, frame_sec, hop_ratio, grid=band_grid)
            E_A_rob = aggregate_two_stage_with_preband_mad(
                E_A_proc, Etot, qf_percent=meas_qf, qb_percent=meas_qb, mad_tau=mad_tau, enable_mad_pre_band=meas_mad_on
            )

            E_meas12_A_pa2 = s2A_use * E_A_rob
            E_env12_A_pa2 = E_env12_A_pa2_base * (s2A_use / s2A_env)
            none_mask = (E_meas12_A_pa2 <= (snr_ratio_min * E_env12_A_pa2))
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
            "note": "spectrum_db 为能量域扣环境后的 1/12 频带 dB（无效带为 null）"
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

    return calib, per_rpm_rows

def build_model_from_calib_in_memory(calib: Dict[str, Any],
                                     min_points_per_band: int = 1,
                                     single_point_policy: str = "flat",
                                     rpm_peak: Optional[float] = None,
                                     rpm_peak_tol: float = 50.0,
                                     model_id: Optional[int] = None,
                                     condition_id: Optional[int] = None) -> Dict[str, Any]:
    anchor = calib.get("anchor_spectra") or (calib.get("calibration") or {}).get("anchor_spectra")
    if not anchor or not anchor.get("items") or not anchor.get("centers_hz"):
        raise RuntimeError("calib 未包含 anchor_spectra.centers_hz/items")
    centers: List[float] = anchor["centers_hz"]
    items: List[Dict[str, Any]] = anchor["items"]
    n_bands = len(centers)

    rpm_list: List[float] = []
    spectra_by_rpm: Dict[float, List[Optional[float]]] = {}
    presence_by_rpm: Dict[str, List[int]] = {}
    for it in items:
        r = float(it["rpm"])
        spec = it.get("spectrum_db")
        if not isinstance(spec, list) or len(spec) != n_bands:
            continue
        rpm_list.append(r)
        vals = [None if (v is None or (isinstance(v,float) and v!=v)) else float(v) for v in spec]
        spectra_by_rpm[r] = vals
        presence_by_rpm[str(r)] = [0 if (v is None or (isinstance(v,float) and v!=v)) else 1 for v in spec]

    if not rpm_list:
        raise RuntimeError("anchor_spectra.items 为空或频谱缺失")
    rpm_unique = sorted(set(float(r) for r in rpm_list))
    rpm_min = float(min(rpm_unique)); rpm_max = float(max(rpm_unique))
    diffs = np.diff(np.sort(np.array(rpm_unique, float))); diffs = diffs[diffs>0]
    rpm_bin = float(np.median(diffs)) if diffs.size else None

    # 允许通过环境变量控制是否强制非负斜率（默认：允许负斜率更贴真）
    nonneg = (os.getenv("RPM_BAND_PCHIP_NONNEG", "0").strip() in ("1","true","True","YES","yes"))

    band_models: List[Optional[Dict[str, Any]]] = []
    points_per_band: List[int] = []
    for b in range(n_bands):
        xs: List[float] = []
        ys: List[float] = []
        for r in rpm_unique:
            v = spectra_by_rpm.get(r, [None]*n_bands)[b]
            if v is not None and np.isfinite(v):
                xs.append(float(r)); ys.append(float(v))
        points_per_band.append(len(xs))
        if len(xs) >= max(2, int(min_points_per_band)):
            mdl = _build_pchip_anchor(xs, ys, nonneg=nonneg)
            band_models.append(mdl)
        elif len(xs) == 1 and int(min_points_per_band) <= 1:
            r0, y0 = xs[0], ys[0]
            if single_point_policy == "drop":
                band_models.append(None)
            else:
                mdl = _build_pchip_anchor([rpm_min, rpm_max], [y0, y0], nonneg=nonneg)
                band_models.append(mdl)
        else:
            band_models.append(None)

    calib_model = calib.get("pchip_rpm_to_laeq_envsub")
    if not calib_model:
        nodes_rpm = calib.get("rpm_nodes") or []
        nodes_la  = calib.get("laeq_nodes_envsub_db") or []
        if isinstance(nodes_rpm, list) and isinstance(nodes_la, list) and len(nodes_rpm) >= 2 and len(nodes_rpm) == len(nodes_la):
            xs = [float(x) for x in nodes_rpm]
            ys = [float(y) for y in nodes_la]
            if (model_id is not None) and (condition_id is not None):
                calib_model = pchip_get(int(model_id), int(condition_id), "rpm", xs, ys)
            else:
                calib_model = pchip_build(xs, ys, axis="rpm")
        else:
            calib_model = None

    anchor_spectra_db = { str(float(r)): spectra_by_rpm[r] for r in rpm_unique }

    out_model = {
        "version": "rpm_spectral_from_anchors_v1",
        "centers_hz": centers,
        "rpm_min": rpm_min,
        "rpm_max": rpm_max,
        "rpm_bin": rpm_bin,
        "rpm_grid_centers": rpm_unique,
        "counts_per_bin": [],
        "calibration": {
            "laeq_env_db": float(calib.get("laeq_env_db")) if calib.get("laeq_env_db") is not None else None,
            "session_env_db": float(calib.get("laeq_env_db")) if calib.get("laeq_env_db") is not None else None,
            "session_delta_db": 0.0,
            "session_awa_db": None,
            "energy_scale": 1.0,
            "calib_model": calib_model,
            "rpm_peak": float(rpm_peak) if (rpm_peak is not None and np.isfinite(rpm_peak)) else float(rpm_max),
            "rpm_peak_tol": float(rpm_peak_tol),
            # 追加：保存 n_per_oct 方便推理
            "n_per_oct": int((anchor or {}).get("n_per_oct", 12))
        },
        "band_models_pchip": band_models,
        "anchor_presence": presence_by_rpm,
        "anchor_spectra_db": anchor_spectra_db,
        "single_point_policy": single_point_policy,
        "fit_meta": {
            "points_per_band": points_per_band,
            "n_bands": n_bands,
            "n_unique_rpms": len(rpm_unique),
            "min_points_per_band": int(min_points_per_band),
            "source": "anchor_spectra_only",
            "anchor_lock": True
        }
    }

     # 1) 总量闭合修正：构建 Δ 曲线（保留用于诊断；预测阶段使用动态闭合确保精确对齐）
    corr_pchip: Optional[Dict[str, Any]] = None
    try:
        if calib_model and isinstance(calib_model, dict) and (out_model.get("band_models_pchip") or []):
            rpms_eval = rpm_unique
            delta_list: List[float] = []
            for r in rpms_eval:
                E_sum = 0.0
                for mdl in out_model["band_models_pchip"]:
                    if mdl and isinstance(mdl, dict):
                        y_db = float(_eval_pchip_local(mdl, r))
                        E_sum += (P0**2) * (10.0 ** (y_db / 10.0))
                la_bands = 10.0 * math.log10(max(E_sum / (P0**2), 1e-30))
                la_tgt = float(_eval_pchip_local(calib_model, r))
                delta_list.append(la_tgt - la_bands)
            corr_pchip = _build_pchip_anchor(list(rpms_eval), delta_list, nonneg=False)
    except Exception:
        corr_pchip = None
    out_model["calibration"]["laeq_correction_db_pchip"] = corr_pchip
    out_model["calibration"]["laeq_correction_note"] = "Prediction applies exact dynamic closure: Δ=LA_fit−LA_synth at query RPM."

    # 2) 谐波注入模型（参数可由环境变量调节）
    try:
        n_blade_env = os.getenv("FAN_BLADE_COUNT", "0").strip()
        n_blade = int(n_blade_env) if n_blade_env else 0
    except Exception:
        n_blade = 0
    try:
        hb_win = int(os.getenv("HARMONICS_BASELINE_WIN_BANDS", "3"))
    except Exception:
        hb_win = 3
    try:
        hb_sigma = float(os.getenv("HARMONICS_SIGMA_BANDS", "0.1"))
    except Exception:
        hb_sigma = 0.25
    harmonics = _build_harmonic_models_from_anchors(
        centers=np.array(centers, float),
        n_per_oct=int((anchor or {}).get("n_per_oct", 12)),
        anchor_items=items,
        n_blade=n_blade,
        h_max=None,
        baseline_win_bands=hb_win,
        kernel_sigma_bands=hb_sigma
    )
    out_model["calibration"]["harmonics"] = harmonics

    return out_model

def run_calibration_and_model(root_dir: str,
                              params: Dict[str, Any],
                              out_dir: Optional[str]=None,
                              model_id: Optional[int] = None,
                              condition_id: Optional[int] = None) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    calib, per_rpm_rows = calibrate_from_points_in_memory(root_dir, params)
    model = build_model_from_calib_in_memory(calib,
                                             min_points_per_band=int(params.get('min_points_per_band', 1)),
                                             single_point_policy=str(params.get('single_point_policy', 'flat')),
                                             rpm_peak=None,
                                             rpm_peak_tol=float(params.get('rpm_peak_tol', 50.0)),
                                             model_id=model_id, condition_id=condition_id)
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

# ---------------- 推理辅助：按模型生成频带谱（含谐波与总量闭合） ----------------
def predict_spectrum_db_with_harmonics(model: Dict[str, Any], rpm: float) -> Tuple[List[Optional[float]], float]:
    """
    返回：校正后的每频带 dB 列表（None 表示无效），以及总 LAeq dB。
    基线频带 → 谐波注入 → 动态总量闭合 Δ=LA_fit−LA_synth（确保任意 RPM 精确对齐）。
    """
    if not model or not isinstance(model, dict):
        return [], float("nan")
    centers = np.array(model.get("centers_hz") or [], float)
    if centers.size == 0:
        return [], float("nan")
    calib = model.get("calibration") or {}
    n_per_oct = int(calib.get("n_per_oct", 12))
    f1, f2 = band_edges_from_centers(centers, n_per_oct, grid="iec-decimal")

    # 1) 基线频带（dB → 能量）
    bands = model.get("band_models_pchip") or []
    Es = np.zeros((centers.size,), dtype=float)
    for i, mdl in enumerate(bands):
        if mdl and isinstance(mdl, dict):
            y = float(_eval_pchip_local(mdl, float(rpm)))
            Es[i] = (P0**2) * (10.0 ** (y / 10.0))
        else:
            Es[i] = 0.0

    # 2) 谐波注入（能量叠加）
    harm = calib.get("harmonics") or {}
    if harm and isinstance(harm, dict) and harm.get("n_blade", 0) > 0:
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
            Lh_db = float(_eval_pchip_local(mdl, float(rpm)))
            if not np.isfinite(Lh_db):
                continue
            Eh = (P0**2) * (10.0 ** (Lh_db / 10.0))
            for k, w in _distribute_line_to_bands(f_line, centers, f1, f2, sigma_bands=sigma_b, topk=topk):
                Es[k] += Eh * w

    # 3) 动态总量闭合（严格对齐拟合曲线）
    la_now = 10.0 * math.log10(max(float(np.sum(Es)) / (P0**2), 1e-30))
    la_fit = None
    if calib.get("calib_model"):
        la_fit = float(_eval_pchip_local(calib["calib_model"], float(rpm)))
    if la_fit is not None and np.isfinite(la_fit):
        delta = la_fit - la_now
        Es *= (10.0 ** (delta / 10.0))
        la_now = la_fit
    elif isinstance(calib.get("laeq_correction_db_pchip"), dict):
        # 回退：若没有 calib_model，仅用预存 Δ 曲线近似闭合
        delta = float(_eval_pchip_local(calib["laeq_correction_db_pchip"], float(rpm)))
        Es *= (10.0 ** (delta / 10.0))
        la_now = 10.0 * math.log10(max(float(np.sum(Es)) / (P0**2), 1e-30))

    # 4) 输出 dB 频带
    out_db: List[Optional[float]] = []
    for i in range(centers.size):
        E = float(Es[i])
        out_db.append(None if E <= 0 else 10.0 * math.log10(max(E / (P0**2), 1e-30)))
    return out_db, la_now