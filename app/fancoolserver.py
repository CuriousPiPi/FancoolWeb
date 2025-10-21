import os
import uuid
import logging
import time
import threading
import hmac
import hashlib
import math
import signal
from curves import pchip_cache
from datetime import datetime, timedelta
from typing import List, Dict, Tuple, Any

from flask import Flask, request, render_template, session, jsonify, g, make_response
from sqlalchemy import create_engine, text
from user_agents import parse as parse_ua
from werkzeug.middleware.proxy_fix import ProxyFix

from curves.pchip_cache import get_or_build_pchip, eval_pchip

# =========================================
# App / Config
# =========================================
from logging.config import dictConfig

dictConfig({
    'version': 1,
    'disable_existing_loggers': False,  # 不屏蔽第三方库，但我们会单独降级它们
    'formatters': {
        'default': {
            'format': '[%(asctime)s] %(levelname)s in %(name)s: %(message)s',
        },
    },
    'handlers': {
        'wsgi': {
            'class': 'logging.StreamHandler',
            'stream': 'ext://sys.stdout',
            'formatter': 'default',
        },
    },
    # 根 logger：WARNING（抑制 INFO/DEBUG）
    'root': {
        'level': 'WARNING',
        'handlers': ['wsgi']
    },
    'loggers': {
        # Flask/werkzeug 的请求日志
        'werkzeug': {'level': 'WARNING', 'propagate': True},
        # SQLAlchemy 引擎与连接池（避免打印 SQL/连接池 INFO）
        'sqlalchemy.engine': {'level': 'WARNING', 'propagate': False},
        'sqlalchemy.pool': {'level': 'WARNING', 'propagate': False},
        # 如果你有其他 noisy 的库，也可在此降级
    }
})

app = Flask(__name__)
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=30)
app.secret_key = os.getenv('APP_SECRET', 'replace-me-in-prod')
app.config['SESSION_COOKIE_SECURE'] = os.getenv('SESSION_COOKIE_SECURE', '0') == '1'
app.logger.setLevel('WARNING')

app.config['TEMPLATES_AUTO_RELOAD'] = True      #生产环境注释这行
#app.jinja_env.auto_reload = True                #生产环境注释这行
#app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0     #生产环境注释这行



def _on_sighup(signum, frame):
    try:
        pchip_cache.reload_curve_params_from_env()
        app.logger.info("Reloaded curve params from env via SIGHUP")
    except Exception as e:
        app.logger.exception("Reload curve params failed: %s", e)

try:
    signal.signal(signal.SIGHUP, _on_sighup)
except Exception:
    # Windows / 一些环境不支持 SIGHUP，可忽略
    pass

# 将 curves.pchip_cache 日志接到 Flask 的 handlers 上
def _hook_curve_logger_to_flask():
    import logging, os
    l = logging.getLogger("curves.pchip_cache")
    # 复用 Flask 的 handler，避免重复输出
    if not l.handlers:
        for h in app.logger.handlers:
            l.addHandler(h)
    l.setLevel(logging.INFO)
    l.propagate = False  # 不再向上冒泡到 root，避免重复
    # 打印一次路径信息，确认落盘位置
    app.logger.info("CWD = %s", os.path.abspath(os.getcwd()))
    app.logger.info("Curve cache dir = %s", os.path.abspath(os.getenv("CURVE_CACHE_DIR", "./curve_cache")))

# _hook_curve_logger_to_flask()

DB_DSN = os.getenv(
    'FANDB_DSN',
    'mysql+pymysql://localreader:12345678@127.0.0.1/FANDB?charset=utf8mb4'
)
engine = create_engine(
    DB_DSN,
    pool_pre_ping=True,
    pool_recycle=1800,
    future=True
)

SIZE_OPTIONS = ["不限", "120"] #, "140"]
TOP_QUERIES_LIMIT = 10
RECENT_LIKES_LIMIT = 50
CLICK_COOLDOWN_SECONDS = 0.5
RECENT_UPDATES_LIMIT = 50

query_count_cache = 0

# UID cookie config
UID_COOKIE_NAME = os.getenv('UID_COOKIE_NAME', 'fc_uid')
UID_COOKIE_MAX_AGE = int(os.getenv('UID_COOKIE_MAX_AGE_SECONDS', str(60 * 60 * 24 * 365 * 2)))
UID_COOKIE_SAMESITE = os.getenv('UID_COOKIE_SAMESITE', 'Lax')
UID_COOKIE_SECURE = os.getenv('UID_COOKIE_SECURE', '0') == '1'
UID_COOKIE_HTTPONLY = os.getenv('UID_COOKIE_HTTPONLY', '0') == '1'
UID_COOKIE_REFRESH_INTERVAL = int(os.getenv('UID_COOKIE_REFRESH_INTERVAL_SECONDS', str(60 * 60 * 24 * 7)))
UID_COOKIE_REFRESH_TS_NAME = os.getenv('UID_COOKIE_REFRESH_TS_NAME', 'fc_uid_refreshed_at')

# =========================================
# Middleware / Headers
# =========================================
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_for=1)
app.config['SESSION_COOKIE_HTTPONLY'] = os.getenv('SESSION_COOKIE_HTTPONLY', '1') == '1'
app.config['SESSION_COOKIE_SAMESITE'] = os.getenv('SESSION_COOKIE_SAMESITE', 'Lax')
app.config['SESSION_COOKIE_PATH'] = '/'


@app.after_request
def add_security_headers(resp):
    try:
        if request.is_secure:
            resp.headers.setdefault(
                'Strict-Transport-Security',
                'max-age=31536000; includeSubDomains; preload'
            )
        resp.headers.setdefault('X-Frame-Options', 'SAMEORIGIN')
        resp.headers.setdefault('X-Content-Type-Options', 'nosniff')
        resp.headers.setdefault('Referrer-Policy', 'strict-origin-when-cross-origin')
    except Exception:
        pass
    return resp

# =========================================
# Unified Response Helpers (旧字段兼容移除：不再复制顶层 extra)
# =========================================
def resp_ok(data: Any = None, message: str | None = None,
            meta: dict | None = None, http_status: int = 200):
    payload = {
        'success': True,
        'data': data,
        'message': message,
        'meta': meta or {}
    }
    return make_response(jsonify(payload), http_status)


def resp_err(error_code: str, error_message: str,
             http_status: int = 400, *,
             meta: dict | None = None):
    payload = {
        'success': False,
        'error_code': error_code,
        'error_message': error_message,
        'data': None,
        'meta': meta or {}
    }
    return make_response(jsonify(payload), http_status)


# =========================================
# UID Signing
# =========================================
def _sign_uid(value: str) -> str:
    key = app.secret_key.encode() if not isinstance(app.secret_key, (bytes, bytearray)) else app.secret_key
    sig = hmac.new(key, value.encode('utf-8'), hashlib.sha256).hexdigest()[:16]
    return f"{value}.{sig}"


def _unsign_uid(token: str) -> str | None:
    if not token:
        return None
    parts = token.split('.', 1)
    if len(parts) != 2:
        return None
    raw, sig = parts
    expect = _sign_uid(raw).split('.', 1)[1]
    if hmac.compare_digest(sig, expect):
        return raw
    return None


@app.before_request
def _init_g_defaults():
    if not hasattr(g, '_uid_source'):
        g._uid_source = None


def get_or_create_user_identifier() -> str:
    token = request.cookies.get(UID_COOKIE_NAME)
    uid_from_cookie = _unsign_uid(token) if token else None
    if uid_from_cookie:
        uid = uid_from_cookie
        g._uid_source = 'cookie'
    else:
        if token:
            g._uid_source = 'cookie_invalid'
        uid = session.get('user_identifier')
        if uid:
            g._uid_source = g._uid_source or 'session'
        else:
            uid = str(uuid.uuid4())
            g._uid_source = g._uid_source or 'generated'
    g._active_uid = uid
    if not token:
        g._set_uid_cookie = _sign_uid(uid)
        g._set_uid_refresh_now = True
    session['user_identifier'] = uid
    session.permanent = True
    return uid


@app.after_request
def ensure_uid_cookie(resp):
    now = int(time.time())
    token_to_set = getattr(g, '_set_uid_cookie', None)
    if token_to_set:
        resp.set_cookie(
            UID_COOKIE_NAME, token_to_set,
            max_age=UID_COOKIE_MAX_AGE,
            samesite=UID_COOKIE_SAMESITE,
            secure=UID_COOKIE_SECURE,
            httponly=UID_COOKIE_HTTPONLY,
            path='/'
        )
        if getattr(g, '_set_uid_refresh_now', False):
            resp.set_cookie(
                UID_COOKIE_REFRESH_TS_NAME, str(now),
                max_age=UID_COOKIE_MAX_AGE,
                samesite=UID_COOKIE_SAMESITE,
                secure=UID_COOKIE_SECURE,
                httponly=UID_COOKIE_HTTPONLY,
                path='/'
            )
        return resp

    last_ts_raw = request.cookies.get(UID_COOKIE_REFRESH_TS_NAME)
    try:
        last_ts = int(last_ts_raw or '0')
    except ValueError:
        last_ts = 0

    if now - last_ts >= UID_COOKIE_REFRESH_INTERVAL:
        existing_token = request.cookies.get(UID_COOKIE_NAME)
        uid = _unsign_uid(existing_token) if existing_token else None
        if uid:
            resp.set_cookie(
                UID_COOKIE_NAME, existing_token,
                max_age=UID_COOKIE_MAX_AGE,
                samesite=UID_COOKIE_SAMESITE,
                secure=UID_COOKIE_SECURE,
                httponly=UID_COOKIE_HTTPONLY,
                path='/'
            )
        elif getattr(g, '_active_uid', None):
            resp.set_cookie(
                UID_COOKIE_NAME, _sign_uid(g._active_uid),
                max_age=UID_COOKIE_MAX_AGE,
                samesite=UID_COOKIE_SAMESITE,
                secure=UID_COOKIE_SECURE,
                httponly=UID_COOKIE_HTTPONLY,
                path='/'
            )
        resp.set_cookie(
            UID_COOKIE_REFRESH_TS_NAME, str(now),
            max_age=UID_COOKIE_MAX_AGE,
            samesite=UID_COOKIE_SAMESITE,
            secure=UID_COOKIE_SECURE,
            httponly=UID_COOKIE_HTTPONLY,
            path='/'
        )
    return resp

# =========================================
# DB Helpers
# =========================================
def fetch_all(sql: str, params: dict = None) -> List[dict]:
    with engine.begin() as conn:
        rows = conn.execute(text(sql), params or {})
        return [dict(r._mapping) for r in rows]


def exec_write(sql: str, params: dict = None):
    with engine.begin() as conn:
        conn.execute(text(sql), params or {})

# =========================================
# Utilities
# =========================================
def _parse_device_basic(ua_string: str) -> dict:
    try:
        ua = parse_ua(ua_string or '')
        if ua.is_bot:
            dtype = 'bot'
        elif ua.is_mobile:
            dtype = 'mobile'
        elif ua.is_tablet:
            dtype = 'tablet'
        elif ua.is_pc:
            dtype = 'desktop'
        else:
            dtype = 'other'
        return dict(os_name=ua.os.family or None, device_type=dtype)
    except Exception:
        return dict(os_name=None, device_type='other')

# NEW: deprecated API call tracer
def _deprecated_called(name: str):
    try:
        app.logger.warning("DEPRECATED API called: %s %s %s args=%s", name, request.method, request.path, dict(request.args))
        print(f"[DEPRECATED] {name}: {request.method} {request.path} args={dict(request.args)}", flush=True)
    except Exception:
        # Avoid breaking response on logging errors
        pass

# =========================================
# FNV Fingerprint for Likes (保持 c/x/s)
# =========================================
FNV_OFFSET_64 = 0xCBF29CE484222325
FNV_PRIME_64 = 0x100000001B3
MASK_64 = 0xFFFFFFFFFFFFFFFF


def _fnv1a_64(s: str) -> int:
    h = FNV_OFFSET_64
    for ch in s:
        h ^= ord(ch)
        h = (h * FNV_PRIME_64) & MASK_64
    return h


def get_user_likes_full(user_identifier: str, limit: int | None = None) -> List[dict]:
    rows = fetch_all("""
        SELECT user_identifier, model_id, condition_id, brand_name_zh, model_name,
               condition_name_zh, resistance_type_zh, resistance_location_zh, max_speed, size, thickness
        FROM user_likes_view
        WHERE user_identifier=:u
    """, {'u': user_identifier})
    return rows if limit is None else rows[:limit]


def get_user_like_keys(user_identifier: str) -> List[str]:
    return [f"{int(r['model_id'])}_{int(r['condition_id'])}" for r in get_user_likes_full(user_identifier)]


def compute_like_fingerprint(user_id: str) -> dict:
    keys = get_user_like_keys(user_id)
    xor_v = 0
    sum_v = 0
    for k in keys:
        hv = _fnv1a_64(k)
        xor_v ^= hv
        sum_v = (sum_v + hv) & MASK_64
    return {'c': len(keys), 'x': f"{xor_v:016x}", 's': f"{sum_v:016x}"}

# =========================================
# Query Helpers
# =========================================
def get_top_queries(limit: int = TOP_QUERIES_LIMIT) -> List[dict]:
    sql = """SELECT model_id, condition_id,
                    brand_name_zh, model_name,
                    condition_name_zh,
                    query_count, size, thickness, max_speed,
                    reference_price
             FROM total_query_rank_d30
             ORDER BY query_count DESC
             LIMIT :l"""
    return fetch_all(sql, {'l': limit})

def get_top_ratings(limit: int = TOP_QUERIES_LIMIT) -> List[dict]:
    sql = """SELECT model_id, condition_id,
                    brand_name_zh, model_name,
                    condition_name_zh,
                    like_count, size, thickness, max_speed,
                    reference_price
             FROM total_like_d30
             ORDER BY like_count DESC
             LIMIT :l"""
    return fetch_all(sql, {'l': limit})

def _effective_value_for_series(series_rows: list, model_id: int, condition_id: int,
                                axis: str, limit_value: float | None):
    """
    输入：某个 (model_id, condition_id) 的所有行记录（含 rpm, noise_db, airflow）
    输出：effective_x, effective_airflow, source ('raw'|'fit'), axis ('rpm'|'noise_db')
    规则：
      - 未限制：取原始最大风量的点（raw）
      - 有限制：
         * 若 limit < min_x → 丢弃该条目（不显示）
         * 若存在 x==limit 的原始点 → raw
         * 若 limit >= max_x → 取 max_x 的原始点 → raw
         * 否则（位于域内且无原始点）→ 拟合值（fit, PCHIP）
    """
    ax = 'noise_db' if axis == 'noise' else axis
    xs, ys, rpm_list = [], [], []
    for r in series_rows:
        x = r[ax]
        y = r['airflow']
        rpm = r['rpm']
        try:
            xf = float(x) if x is not None else None
            yf = float(y) if y is not None else None
        except Exception:
            continue
        if xf is None or not math.isfinite(xf) or yf is None or not math.isfinite(yf):
            continue
        xs.append(xf); ys.append(yf); rpm_list.append(float(rpm) if r['rpm'] is not None else None)
    if not xs:
        return None

    x_min, x_max = min(xs), max(xs)

    # 未限制：取 y 最大的原始点
    if limit_value is None:
        idx = max(range(len(ys)), key=lambda i: ys[i])
        eff_x = xs[idx]
        eff_y = ys[idx]
        return {'effective_x': eff_x, 'effective_airflow': eff_y, 'effective_source': 'raw', 'effective_axis': ax,
                'effective_rpm_at_point': rpm_list[idx]}

    # 有限制：若限制值小于所有原始点的最小 x → 丢弃
    lv = float(limit_value)
    if lv < x_min - 1e-9:
        return None

    # 若 limit >= max_x → 取 max_x 原始点
    if lv >= x_max - 1e-9:
        idxs = [i for i, x in enumerate(xs) if abs(x - x_max) < 1e-9]
        best = max(idxs, key=lambda i: ys[i])
        return {'effective_x': xs[best], 'effective_airflow': ys[best], 'effective_source': 'raw', 'effective_axis': ax,
                'effective_rpm_at_point': rpm_list[best]}

    # 若存在原始点恰好等于 limit（整型 RPM 直接匹配，噪音允许 0.05 容差）
    tol = 0.05 if ax == 'noise_db' else 0.0
    for i, x in enumerate(xs):
        if (tol == 0.0 and x == lv) or (tol > 0.0 and abs(x - lv) <= tol):
            return {'effective_x': x, 'effective_airflow': ys[i], 'effective_source': 'raw', 'effective_axis': ax,
                    'effective_rpm_at_point': rpm_list[i]}

    # 位于域内且无原始点 → PCHIP 拟合
    model = get_or_build_pchip(model_id, condition_id, ax, xs, ys)
    if not model:
        # 回退：取最接近 limit 的原始点
        j = min(range(len(xs)), key=lambda i: abs(xs[i] - lv))
        return {'effective_x': xs[j], 'effective_airflow': ys[j], 'effective_source': 'raw', 'effective_axis': ax,
                'effective_rpm_at_point': rpm_list[j]}
    lx = max(model['x0'], min(lv, model['x1']))
    eff_y = eval_pchip(model, lx)
    return {'effective_x': lx, 'effective_airflow': float(eff_y), 'effective_source': 'fit', 'effective_axis': ax,
            'effective_rpm_at_point': None}


def search_fans_by_condition_with_fit(condition_id=None, condition_name=None, sort_by='none', sort_value=None,
                         size_filter=None, thickness_min=None, thickness_max=None,
                         price_min=None, price_max=None,  # NEW
                         limit=200) -> list[dict]:
    where = []
    params = {}

    # 工况过滤
    if condition_id is not None:
        where.append("g.condition_id=:cid"); params['cid'] = int(condition_id)
    elif (condition_name or '').strip() and condition_name != '全部':
        where.append("g.condition_name_zh=:cn"); params['cn'] = condition_name.strip()

    # 尺寸/厚度
    if size_filter and size_filter != '不限':
        where.append("g.size=:sz"); params['sz'] = int(size_filter)
    if thickness_min is not None and thickness_max is not None:
        where.append("g.thickness BETWEEN :tmin AND :tmax")
        params.update(tmin=int(thickness_min), tmax=int(thickness_max))

    # NEW: 参考价格（元），来自 fan_model.reference_price
    if price_min is not None and price_max is not None:
        where.append("reference_price BETWEEN :pmin AND :pmax")
        params.update(pmin=int(price_min), pmax=int(price_max))

    sql = f"""
      SELECT g.model_id, g.condition_id,
             g.brand_name_zh, g.model_name, g.condition_name_zh,
             g.size, g.thickness, g.rpm, g.noise_db, g.airflow_cfm AS airflow,
             COALESCE(g.like_count,0) AS like_count,
             reference_price
      FROM general_view g
      {"WHERE " + " AND ".join(where) if where else ""}
      ORDER BY g.model_id, g.condition_id, g.rpm
    """
    rows = fetch_all(sql, params)

    # 后续分组/拟合逻辑不变
    groups = {}
    for r in rows:
        mid = int(r['model_id']); cid = int(r['condition_id'])
        key = (mid, cid)
        g = groups.setdefault(key, {
            'rows': [], 'brand': r['brand_name_zh'], 'model': r['model_name'],
            'condition_name': r['condition_name_zh'], 'size': r['size'], 'thickness': r['thickness'],
            'like_count': 0, 'max_speed': None, 'reference_price': r['reference_price']
        })
        g['rows'].append({'rpm': r['rpm'], 'noise_db': r['noise_db'], 'airflow': r['airflow']})
        try:
            g['like_count'] = max(g['like_count'], int(r['like_count']))
        except Exception:
            pass
        try:
            if r['rpm'] is not None:
                g['max_speed'] = max(g['max_speed'] or 0, int(r['rpm']))
        except Exception:
            pass

    axis = 'rpm' if sort_by == 'rpm' or sort_by == 'none' else 'noise_db'
    lv = None if sort_by == 'none' else float(sort_value)

    items = []
    for (mid, cid), g in groups.items():
        eff = _effective_value_for_series(g['rows'], mid, cid, axis, lv)
        if not eff:
            continue
        items.append({
            'model_id': mid, 'condition_id': cid,
            'brand_name_zh': g['brand'], 'model_name': g['model'], 'condition_name_zh': g['condition_name'],
            'size': g['size'], 'thickness': g['thickness'], 'like_count': g['like_count'],
            'effective_airflow': eff['effective_airflow'], 'effective_x': eff['effective_x'],
            'effective_axis': eff['effective_axis'], 'effective_source': eff['effective_source'],
            'max_airflow': eff['effective_airflow'], 'max_speed': g['max_speed'],
            'reference_price': g['reference_price'] 
        })

    items.sort(key=lambda r: (r['effective_airflow'] if r['effective_airflow'] is not None else -1e9), reverse=True)
    return items[:limit]

def get_recent_updates(limit: int = RECENT_UPDATES_LIMIT) -> List[dict]:
    """
    从视图 FANDB.update_notice_d30_view 获取近30天内的更新记录。
    字段：model_id, condition_id, brand_name_zh, model_name, condition_name_zh, size, thickness, max_speed, update_date, description
    """
    sql = """
      SELECT
        model_id, condition_id,
        brand_name_zh, model_name,
        condition_name_zh,
        size, thickness, max_speed,
        description,
        CONCAT(
          DATE_FORMAT(update_date, '%Y-%m-%d %H:%i'),
          ''
        ) AS update_date
      FROM update_notice_d30_view
      ORDER BY update_date DESC
      LIMIT :l
    """
    return fetch_all(sql, {'l': limit})

# =========================================
# Visit Start
# =========================================
@app.route('/api/visit_start', methods=['POST'])
def api_visit_start():
    try:
        _ = get_or_create_user_identifier()
        uid = g._active_uid
        uid_source = getattr(g, '_uid_source', None)
        row = fetch_all("SELECT COUNT(*) AS c FROM visit_logs WHERE user_identifier=:u", {'u': uid})
        visit_index = int(row[0]['c']) + 1 if row else 1
        is_new_user = (visit_index == 1)

        data = request.get_json(force=True, silent=True) or {}
        screen_w = int(data.get('screen_w') or 0) or None
        screen_h = int(data.get('screen_h') or 0) or None
        dpr = float(data.get('device_pixel_ratio') or 0) or None
        language = (data.get('language') or '').strip() or None
        is_touch = 1 if data.get('is_touch') else 0
        ui_theme = (data.get('theme') or '').strip() or None   # NEW: 加载时主题

        ua_raw = request.headers.get('User-Agent', '') or None
        dev = _parse_device_basic(ua_raw or '')

        sql = """
        INSERT INTO visit_logs
        (user_identifier, uid_source, visit_index, is_new_user,
         user_agent_raw, os_name, device_type,
         screen_w, screen_h, device_pixel_ratio, language, is_touch,
         ui_theme)  -- NEW
        VALUES
        (:uid, :usrc, :vidx, :isnew,
         :ua, :osn, :dtype,
         :sw, :sh, :dpr, :lang, :touch,
         :theme)  -- NEW
        """
        exec_write(sql, {
            'uid': uid,
            'usrc': uid_source,
            'vidx': visit_index,
            'isnew': 1 if is_new_user else 0,
            'ua': ua_raw,
            'osn': dev['os_name'],
            'dtype': dev['device_type'],
            'sw': screen_w,
            'sh': screen_h,
            'dpr': dpr,
            'lang': language,
            'touch': is_touch,
            'theme': ui_theme     # NEW
        })
        return resp_ok({'visit_index': visit_index, 'is_new_user': is_new_user})
    except Exception as e:
        app.logger.exception(e)
        return resp_err('INTERNAL_ERROR', str(e), 500)

# =========================================
# Helpers for events (NEW)
# =========================================
def _get_latest_visit_id_for_user(uid: str) -> int | None:
    try:
        rows = fetch_all("SELECT id FROM visit_logs WHERE user_identifier=:u ORDER BY id DESC LIMIT 1", {'u': uid})
        if rows:
            return int(rows[0]['id'])
    except Exception:
        pass
    return None

# =========================================
# Event Logging API (NEW)
# =========================================
@app.post('/api/log_event')
def api_log_event():
    try:
        user_id = get_or_create_user_identifier()
        data = request.get_json(force=True, silent=True) or {}

        event_type_code = (data.get('event_type_code') or '').strip()
        if not event_type_code:
            return resp_err('INVALID_EVENT', '缺少 event_type_code')

        # 轻度清洗与长度保护
        if len(event_type_code) > 64:
            event_type_code = event_type_code[:64]
        page_key = (data.get('page_key') or 'home').strip() or 'home'
        if len(page_key) > 64:
            page_key = page_key[:64]
        target_url = (data.get('target_url') or '').strip() or None
        if target_url and len(target_url) > 512:
            target_url = target_url[:512]

        visit_id = _get_latest_visit_id_for_user(user_id)

        sql = """
        INSERT INTO event_logs
          (user_identifier, visit_id, event_type_code, occurred_at, page_key, target_url)
        VALUES
          (:u, :vid, :type, NOW(), :page_key, :target_url)
        """
        exec_write(sql, {
            'u': user_id,
            'vid': visit_id,
            'type': event_type_code,
            'page_key': page_key,
            'target_url': target_url
        })
        return resp_ok({'logged': 1})
    except Exception as e:
        app.logger.exception(e)
        return resp_err('INTERNAL_ERROR', str(e), 500)
    
# =========================================
# Like APIs
# =========================================
@app.route('/api/like_status', methods=['POST'])
def api_like_status():
    try:
        user_id = get_or_create_user_identifier()
        data = request.get_json(force=True, silent=True) or {}
        raw_pairs = data.get('pairs') or []
        cleaned, seen = [], set()
        for p in raw_pairs:
            try:
                mid = int(p.get('model_id'))
                cid = int(p.get('condition_id'))
            except Exception:
                continue
            t = (mid, cid)
            if t in seen:
                continue
            seen.add(t)
            cleaned.append(t)
        if not cleaned:
            fp = compute_like_fingerprint(user_id)
            return resp_ok({'like_keys': [], 'fp': fp})
        conds, params = [], {'u': user_id}
        for i, (m, c) in enumerate(cleaned, start=1):
            conds.append(f"(:m{i}, :c{i})")
            params[f"m{i}"] = m
            params[f"c{i}"] = c
        sql = f"""
          SELECT model_id, condition_id
          FROM user_likes_view
          WHERE user_identifier=:u AND (model_id, condition_id) IN ({",".join(conds)})
        """
        rows = fetch_all(sql, params)
        like_keys = [f"{int(r['model_id'])}_{int(r['condition_id'])}" for r in rows]
        fp = compute_like_fingerprint(user_id)
        return resp_ok({'like_keys': like_keys, 'fp': fp})
    except Exception as e:
        app.logger.exception(e)
        return resp_err('INTERNAL_ERROR', str(e), 500)


@app.route('/api/like_keys', methods=['GET'])
def api_like_keys():
    try:
        user_id = get_or_create_user_identifier()
        keys = get_user_like_keys(user_id)
        fp = compute_like_fingerprint(user_id)
        return resp_ok({'like_keys': keys, 'fp': fp})
    except Exception as e:
        app.logger.exception(e)
        return resp_err('INTERNAL_ERROR', str(e), 500)


@app.route('/api/like', methods=['POST'])
def api_like():
    data = request.get_json(force=True, silent=True) or {}
    model_id = data.get('model_id')
    condition_id = data.get('condition_id')
    user_id = get_or_create_user_identifier()
    if not model_id or not condition_id:
        return resp_err('LIKE_MISSING_IDS', '缺少 model_id 或 condition_id', 400)
    try:
        exec_write("""INSERT INTO rate_logs (user_identifier, model_id, condition_id, is_valid, rate_id)
                      VALUES (:u,:m,:c,1,1)
                      ON DUPLICATE KEY UPDATE is_valid=1, update_date=NOW()""",
                   {'u': user_id, 'm': model_id, 'c': condition_id})
        fp = compute_like_fingerprint(user_id)
        return resp_ok({'fp': fp})
    except Exception as e:
        app.logger.exception(e)
        return resp_err('LIKE_DB_WRITE_FAIL', str(e), 500)


@app.route('/api/unlike', methods=['POST'])
def api_unlike():
    data = request.get_json(force=True, silent=True) or {}
    model_id = data.get('model_id')
    condition_id = data.get('condition_id')
    user_id = get_or_create_user_identifier()
    if not model_id or not condition_id:
        return resp_err('LIKE_MISSING_IDS', '缺少 model_id 或 condition_id', 400)
    try:
        exec_write("""UPDATE rate_logs
                      SET is_valid=0, update_date=NOW()
                      WHERE rate_id=1 AND user_identifier=:u AND model_id=:m AND condition_id=:c""",
                   {'u': user_id, 'm': model_id, 'c': condition_id})
        fp = compute_like_fingerprint(user_id)
        return resp_ok({'fp': fp})
    except Exception as e:
        app.logger.exception(e)
        return resp_err('UNLIKE_DB_WRITE_FAIL', str(e), 500)

# =========================================
# Recent Likes
# =========================================
@app.route('/api/recent_likes', methods=['GET'])
def api_recent_likes():
    try:
        user_id = get_or_create_user_identifier()
        items = get_user_likes_full(user_id, limit=RECENT_LIKES_LIMIT)
        fp = compute_like_fingerprint(user_id)
        return resp_ok({'items': items, 'fp': fp})
    except Exception as e:
        app.logger.exception(e)
        return resp_err('INTERNAL_ERROR', str(e), 500)

# =========================================
# Curves
# =========================================
def get_curves_for_pairs(pairs: List[Tuple[int, int]]) -> Dict[str, dict]:
    if not pairs:
        return {}
    conds, params = [], {}
    for i, (m, c) in enumerate(pairs, start=1):
        conds.append(f"(:m{i}, :c{i})")
        params[f"m{i}"] = int(m)
        params[f"c{i}"] = int(c)
    sql = f"""
      SELECT model_id, condition_id, brand_name_zh, model_name,
             condition_name_zh, resistance_type_zh, resistance_location_zh,
             rpm, airflow_cfm AS airflow, noise_db
      FROM general_view
      WHERE (model_id, condition_id) IN ({",".join(conds)})
      ORDER BY model_id, condition_id, rpm
    """
    rows = fetch_all(sql, params)
    bucket = {}
    for r in rows:
        key = f"{int(r['model_id'])}_{int(r['condition_id'])}"
        b = bucket.setdefault(key, {
            'rpm': [], 'airflow': [], 'noise_db': [],
            'info': {
                'brand': r['brand_name_zh'],
                'model': r['model_name'],
                'condition': r['condition_name_zh'],
                'resistance_type': r['resistance_type_zh'],
                'resistance_location': r['resistance_location_zh'],
                'model_id': int(r['model_id']),
                'condition_id': int(r['condition_id'])
            }   
        })
        rpm = r.get('rpm')
        airflow = r.get('airflow')
        noise = r.get('noise_db')
        try:
            airflow_f = float(airflow)
            if airflow_f != airflow_f:  # NaN
                continue
        except Exception:
            continue
        if rpm is None and noise is None:
            continue
        b['rpm'].append(rpm)
        b['airflow'].append(airflow_f)
        b['noise_db'].append(noise)
    return bucket


@app.post('/api/curves')
def api_curves():
    try:
        data = request.get_json(force=True, silent=True) or {}
        raw_pairs = data.get('pairs') or []
        uniq, seen = [], set()
        for p in raw_pairs:
            try:
                mid = int(p.get('model_id'))
                cid = int(p.get('condition_id'))
            except Exception:
                continue
            t = (mid, cid)
            if t in seen:
                continue
            seen.add(t)
            uniq.append(t)

        bucket = get_curves_for_pairs(uniq)
        series = []
        missing = []  # 新增：记录在库中不存在的 pair

        def _thin_model(m: dict | None) -> dict | None:
            if not m or not isinstance(m, dict):
                return None
            return {
                'type': m.get('type', 'pchip_v1'),
                'axis': m.get('axis'),
                'x': m.get('x') or [],
                'y': m.get('y') or [],
                'm': m.get('m') or [],
                'x0': m.get('x0'),
                'x1': m.get('x1'),
            }

        def _collect_axis_points(b: dict, axis_key: str) -> tuple[list[float], list[float]]:
            xs, ys = [], []
            x_arr = b.get(axis_key) or []
            y_arr = b.get('airflow') or []
            n = min(len(x_arr), len(y_arr))
            for i in range(n):
                x = x_arr[i]
                y = y_arr[i]
                try:
                    xf = float(x) if x is not None else None
                    yf = float(y) if y is not None else None
                except Exception:
                    continue
                if xf is None or yf is None:
                    continue
                if not (math.isfinite(xf) and math.isfinite(yf)):
                    continue
                xs.append(xf)
                ys.append(yf)
            return xs, ys

        # 新增：对不存在的 pair 主动清理缓存，返回 missing
        wanted_keys = {f"{m}_{c}": (m, c) for (m, c) in uniq}
        existing_keys = set(bucket.keys())
        for key, (mid, cid) in wanted_keys.items():
            if key not in existing_keys:
                missing.append({'model_id': mid, 'condition_id': cid})
                try:
                    pchip_cache.delete_cached_model(mid, cid, 'rpm')
                    pchip_cache.delete_cached_model(mid, cid, 'noise_db')
                except Exception:
                    pass  # 日志已在 deleteCached 内部记录

        for mid, cid in uniq:
            k = f"{mid}_{cid}"
            b = bucket.get(k)
            if not b:
                continue
            info = b['info']

            # 构建/读取 PCHIP 模型（两个轴各一份）
            rpm_xs, rpm_ys = _collect_axis_points(b, 'rpm')
            noise_xs, noise_ys = _collect_axis_points(b, 'noise_db')

            # 新增：如果某轴已无点，清理该轴缓存
            if not rpm_xs:
                try: pchip_cache.delete_cached_model(info['model_id'], info['condition_id'], 'rpm')
                except Exception: pass
            if not noise_xs:
                try: pchip_cache.delete_cached_model(info['model_id'], info['condition_id'], 'noise_db')
                except Exception: pass

            rpm_model = get_or_build_pchip(info['model_id'], info['condition_id'], 'rpm', rpm_xs, rpm_ys) if rpm_xs else None
            noise_model = get_or_build_pchip(info['model_id'], info['condition_id'], 'noise_db', noise_xs, noise_ys) if noise_xs else None

            def _to_placeholder_array(arr):
                out = []
                for v in (arr or []):
                    try:
                        if v is None:
                            out.append(-1.0)
                        else:
                            fv = float(v)
                            if math.isnan(fv):
                                out.append(-1.0)
                            else:
                                out.append(fv)
                    except Exception:
                        out.append(-1.0)
                return out

            series.append(dict(
                key=k,
                name=f"{info['brand']} {info['model']} - {info['condition']}",
                brand=info['brand'], model=info['model'],
                condition=info['condition'],
                model_id=info['model_id'], condition_id=info['condition_id'],
                resistance_type=info.get('resistance_type'),
                resistance_location=info.get('resistance_location'),
                rpm=_to_placeholder_array(b['rpm']),
                noise_db=_to_placeholder_array(b['noise_db']),
                airflow=b['airflow'],
                pchip={'rpm': _thin_model(rpm_model), 'noise_db': _thin_model(noise_model)
                }
            ))
        return resp_ok({'series': series, 'missing': missing})
    except Exception as e:
        app.logger.exception(e)
        return resp_err('INTERNAL_ERROR', f'后端异常: {e}', 500)

# =========================================
# Log Query
# =========================================
@app.post('/api/log_query')
def api_log_query():
    try:
        data = request.get_json(force=True, silent=True) or {}
        source = (data.get('source') or '').strip() or None
        # 简单限制长度，避免异常值
        if source and len(source) > 64:
            source = source[:64]

        raw_pairs = data.get('pairs') or []
        cleaned, seen = [], set()
        for p in raw_pairs:
            try:
                mid = int(p.get('model_id'))
                cid = int(p.get('condition_id'))
            except Exception:
                continue
            t = (mid, cid)
            if t in seen:
                continue
            seen.add(t)
            cleaned.append({'model_id': mid, 'condition_id': cid})

        logged = 0
        if cleaned:
            user_id = get_or_create_user_identifier()
            sql = "INSERT INTO query_logs (user_identifier, model_id, condition_id, batch_id, source) VALUES (:u,:m,:c,:b,:s)"
            batch = str(uuid.uuid4())
            with engine.begin() as conn:
                for pair in cleaned:
                    conn.execute(text(sql), {
                        'u': user_id,
                        'm': pair['model_id'],
                        'c': pair['condition_id'],
                        'b': batch,
                        's': source
                    })
                    logged += 1
        return resp_ok({'logged': logged})
    except Exception as e:
        app.logger.exception(e)
        return resp_err('INTERNAL_ERROR', str(e), 500)

# =========================================
# Cascade / Simple Lists (raw=1 保留)
# =========================================
def _maybe_raw_array(data):
    if request.args.get('raw') == '1':
        return jsonify(data)
    return resp_ok(data)


@app.route('/search_models/<query>')
def search_models(query):
    rows = fetch_all(
        "SELECT DISTINCT brand_name_zh, model_name FROM general_view WHERE model_name LIKE :q LIMIT 20",
        {'q': f"%{query}%"}
    )
    data = [f"{r['brand_name_zh']} {r['model_name']}" for r in rows]
    return _maybe_raw_array(data)


@app.route('/get_models/<brand>')
def get_models(brand):
    rows = fetch_all(
        "SELECT DISTINCT model_name FROM fan_model m JOIN fan_brand b ON b.is_valid=1 AND b.brand_id=m.brand_id WHERE m.is_valid=1 AND b.brand_name_zh=:b",
        {'b': brand}
    )
    return _maybe_raw_array([r['model_name'] for r in rows])


@app.route('/get_conditions', defaults={'brand': None, 'model': None})
@app.route('/get_conditions/<brand>/<model>')
def get_conditions(brand=None, model=None):
    if brand and model:
        rows = fetch_all(
            "SELECT DISTINCT condition_id, condition_name_zh, resistance_type_zh, resistance_location_zh "
            "FROM general_view WHERE is_valid=1 AND brand_name_zh=:b AND model_name=:m "
            "ORDER BY condition_name_zh",
            {'b': brand, 'm': model}
        )
        # 返回 [{condition_id, condition_name_zh}, ...]
        return _maybe_raw_array(rows)
    else:
        rows = fetch_all(
            "SELECT condition_id, condition_name_zh, resistance_type_zh, resistance_location_zh "
            "FROM working_condition WHERE is_valid=1 "
            "ORDER BY condition_name_zh"
        )
        # 返回 [{condition_id, condition_name_zh}, ...]
        return _maybe_raw_array(rows)


# NEW: 通过 (model_id, condition_id) 批量获取显示所需元信息（品牌名、型号名、工况名等）
@app.post('/api/meta_by_ids')
def api_meta_by_ids():
    try:
        data = request.get_json(force=True, silent=True) or {}
        raw_pairs = data.get('pairs') or []
        uniq, seen = [], set()
        for p in raw_pairs:
            try:
                mid = int(p.get('model_id'))
                cid = int(p.get('condition_id'))
            except Exception:
                continue
            t = (mid, cid)
            if t in seen:
                continue
            seen.add(t)
            uniq.append(t)
        if not uniq:
            return resp_ok({'items': []})

        conds, params = [], {}
        for i, (m, c) in enumerate(uniq, start=1):
            conds.append(f"(:m{i}, :c{i})")
            params[f"m{i}"] = m
            params[f"c{i}"] = c

        sql = f"""
          SELECT
            model_id, condition_id,
            brand_name_zh, model_name, condition_name_zh,
            resistance_type_zh, resistance_location_zh,
            size, thickness, max_speed
          FROM meta_view
          WHERE (model_id, condition_id) IN ({",".join(conds)})
          ORDER BY model_id, condition_id
        """
        rows = fetch_all(sql, params)
        return resp_ok({'items': rows})
    except Exception as e:
        app.logger.exception(e)
        return resp_err('INTERNAL_ERROR', f'meta_by_ids 异常: {e}', 500)

# =========================================
# Search
# =========================================
@app.route('/api/search_fans', methods=['POST'])
def api_search_fans():
    try:
        data = request.get_json(force=True, silent=True) or {}
        mode = (data.get('mode') or 'filter').strip()
        if mode == 'expand':
            model_id = data.get('model_id')
            condition_id = data.get('condition_id')
            brand = (data.get('brand') or '').strip()
            model = (data.get('model') or '').strip()
            condition = (data.get('condition') or '').strip()

            if model_id:
                where = ["model_id=:m"]; params = {'m': int(model_id)}
                if condition_id: where.append("condition_id=:c"); params['c'] = int(condition_id)
            else:
                if not brand or not model:
                    return resp_err('EXPAND_MISSING_MODEL', '缺少 model_id 或（品牌+型号）')
                where = ["brand_name_zh=:b", "model_name=:m"]; params = {'b': brand, 'm': model}
                if condition and condition != '全部': where.append("condition_name_zh=:cn"); params['cn'] = condition

            sql = f"""
              SELECT model_id, condition_id, brand_name_zh, model_name, condition_name_zh,
                     size, thickness, MAX(rpm) AS max_speed, MAX(airflow_cfm) AS max_airflow,
                     COALESCE(MAX(like_count),0) AS like_count
              FROM general_view
              WHERE {" AND ".join(where)}
              GROUP BY model_id, condition_id, brand_name_zh, model_name, condition_name_zh, size, thickness
              ORDER BY model_id, condition_id
            """
            rows = fetch_all(sql, params)
            items = []
            for r in rows:
                items.append({
                    'model_id': int(r['model_id']), 'condition_id': int(r['condition_id']),
                    'brand_name_zh': r['brand_name_zh'], 'model_name': r['model_name'],
                    'condition_name_zh': r['condition_name_zh'],
                    'size': r['size'], 'thickness': r['thickness'],
                    'max_speed': r['max_speed'],
                    'max_airflow': float(r['max_airflow']) if r['max_airflow'] is not None else None,
                    'like_count': r['like_count'],
                    'effective_airflow': float(r['max_airflow']) if r['max_airflow'] is not None else None,
                    'effective_axis': 'rpm', 'effective_x': r['max_speed'], 'effective_source': 'raw'
                })
            return resp_ok({'mode': 'expand', 'items': items, 'count': len(items)})

        # Filter mode（优先 condition_id）
        condition_id = data.get('condition_id')
        condition = (data.get('condition') or '').strip()
        size_filter = (data.get('size_filter') or '').strip()
        thickness_min = (data.get('thickness_min') or '').strip()
        thickness_max = (data.get('thickness_max') or '').strip()
        sort_by = (data.get('sort_by') or 'none').strip()
        sort_value_raw = (data.get('sort_value') or '').strip()

        # NEW: 参考价格区间（默认 0-999），仅 0~999 的整数
        price_min_raw = (data.get('price_min') or '0').strip()
        price_max_raw = (data.get('price_max') or '999').strip()

        if not condition_id and not condition:
            return resp_err('SEARCH_MISSING_CONDITION', '请选择工况名称')

        try:
            tmin = int(thickness_min); tmax = int(thickness_max)
        except ValueError:
            return resp_err('SEARCH_INVALID_THICKNESS_FORMAT', '厚度必须为整数')
        if tmin < 1 or tmax < 1 or tmin > 99 or tmin > tmax:
            return resp_err('SEARCH_INVALID_THICKNESS_RANGE', '厚度区间不合法 (1~99 且最小不大于最大)')

        # NEW: 验证价格
        try:
            pmin = int(price_min_raw); pmax = int(price_max_raw)
        except ValueError:
            return resp_err('SEARCH_INVALID_PRICE_FORMAT', '参考价格必须为整数')
        if pmin < 0 or pmax < 0 or pmin > 999 or pmax > 999 or pmin > pmax:
            return resp_err('SEARCH_INVALID_PRICE_RANGE', '参考价格区间不合法 (0~999 且最小不大于最大)')
        
        sort_value = None
        if sort_by != 'none':
            if not sort_value_raw: return resp_err('SEARCH_MISSING_SORT_VALUE', '请输入限制值')
            try: sort_value = float(sort_value_raw)
            except ValueError: return resp_err('SEARCH_INVALID_SORT_VALUE', '限制值必须是数字')

        results = search_fans_by_condition_with_fit(
            condition_id= int(condition_id) if condition_id else None,
            condition_name= condition if (not condition_id) else None,
            sort_by=sort_by, sort_value=sort_value,
            size_filter=size_filter, thickness_min=tmin, thickness_max=tmax, 
            price_min=pmin, price_max=pmax, 
            limit=200
        )

        if sort_by == 'rpm':
            label = f'条件限制：转速 ≤ {sort_value_raw} RPM（原始优先，无原始则拟合）'
        elif sort_by == 'noise':
            label = f'条件限制：噪音 ≤ {sort_value_raw} dB（原始优先，无原始则拟合）'
        else:
            label = '条件：全速运行（取原始最大风量）'

        return resp_ok({'search_results': results, 'condition_label': label})
    except Exception as e:
        app.logger.exception(e)
        return resp_err('INTERNAL_ERROR', f'搜索异常: {e}', 500)

@app.get('/api/brands')
def api_brands():
    try:
        rows = fetch_all("SELECT brand_id, brand_name_zh FROM fan_brand WHERE is_valid=1 ORDER BY brand_name_zh")
        return resp_ok({'items': rows})
    except Exception as e:
        app.logger.exception(e); return resp_err('INTERNAL_ERROR', str(e), 500)

@app.get('/api/models_by_brand')
def api_models_by_brand():
    try:
        bid = int(request.args.get('brand_id') or '0')
        if not bid: return resp_err('BAD_REQUEST', 'brand_id 缺失或非法')
        rows = fetch_all("SELECT model_id, model_name FROM fan_model WHERE is_valid=1 AND brand_id=:b ORDER BY model_name", {'b': bid})
        return resp_ok({'items': rows})
    except Exception as e:
        app.logger.exception(e); return resp_err('INTERNAL_ERROR', str(e), 500)

@app.get('/api/conditions_by_model')
def api_conditions_by_model():
    try:
        mid = int(request.args.get('model_id') or '0')
        if not mid: return resp_err('BAD_REQUEST', 'model_id 缺失或非法')
        rows = fetch_all("SELECT DISTINCT condition_id, condition_name_zh, resistance_type_zh, resistance_location_zh FROM general_view WHERE model_id=:m ORDER BY condition_name_zh", {'m': mid})
        return resp_ok({'items': rows})
    except Exception as e:
        app.logger.exception(e); return resp_err('INTERNAL_ERROR', str(e), 500)
    
# =========================================
# Rankings
# =========================================
@app.route('/api/top_ratings', methods=['GET'])
def api_top_ratings():
    try:
        data = get_top_ratings(limit=10)
        return resp_ok({'items': data})
    except Exception as e:
        app.logger.exception(e)
        return resp_err('INTERNAL_ERROR', str(e), 500)

# =========================================
# Query Count (去除顶层旧兼容字段)
# =========================================
@app.route('/api/query_count')
def get_query_count():
    return resp_ok({'count': query_count_cache})


def update_query_count():
    global query_count_cache
    while True:
        try:
            result = fetch_all("SELECT COUNT(DISTINCT batch_id) AS c FROM query_logs")
            query_count_cache = result[0]['c'] if result else 0
        except Exception as e:
            print(f"更新查询次数失败: {e}")
        time.sleep(60)


threading.Thread(target=update_query_count, daemon=True).start()

# =========================================
# Theme & Config (去除 extra)
# =========================================
@app.route('/api/theme', methods=['POST'])
def api_theme():
    data = request.get_json(force=True, silent=True) or {}
    theme = data.get('theme', 'light')
    session['theme'] = theme
    session.modified = True
    return resp_ok({'theme': theme})


@app.route('/api/config')
def api_config():
    cfg = {
        'click_cooldown_ms': CLICK_COOLDOWN_SECONDS * 1000,
        'recent_likes_limit': RECENT_LIKES_LIMIT
    }
    return resp_ok(cfg)

@app.route('/source-info')
def source_info():
    return render_template('source-info.html')

@app.route('/legal')
def legal():
    return render_template(
        'legal.html',
        current_year=datetime.now().year,
        update_date='2025-10-08'
    )

# =========================================
# Index
# =========================================
@app.route('/')
def index():
    brands_rows = fetch_all("SELECT DISTINCT brand_name_zh FROM fan_brand WHERE is_valid=1")
    brands = [r['brand_name_zh'] for r in brands_rows]
    conditions_rows = fetch_all("SELECT DISTINCT condition_name_zh FROM working_condition WHERE is_valid=1")
    top_queries = get_top_queries(limit=TOP_QUERIES_LIMIT)
    top_ratings = get_top_ratings(limit=TOP_QUERIES_LIMIT)

    html_content = render_template(
        'fancoolindex.html',
        brands=brands,
        all_conditions=[r['condition_name_zh'] for r in conditions_rows],
        top_queries=top_queries,
        top_ratings=top_ratings,
        size_options=SIZE_OPTIONS,
        current_year=datetime.now().year
    )
    response = make_response(html_content)
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, proxy-revalidate'
    response.headers['Expires'] = '0'
    response.headers['Pragma'] = 'no-cache'
    return response

# 3) 新增：近期更新 API（懒加载页签调用）
@app.route('/api/recent_updates', methods=['GET'])
def api_recent_updates():
    try:
        items = get_recent_updates(limit=RECENT_UPDATES_LIMIT)
        # 直接返回标准结构，前端用 normalizeApiResponse 解析
        return resp_ok({'items': items})
    except Exception as e:
        app.logger.exception(e)
        return resp_err('INTERNAL_ERROR', str(e), 500)
    
# =========================================
# Entrypoint
# =========================================
if __name__ == '__main__':
    app.logger.setLevel(logging.INFO)
    app.run(host='0.0.0.0', port=5001, debug=False, use_reloader=False)