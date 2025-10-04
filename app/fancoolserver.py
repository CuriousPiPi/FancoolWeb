import os
import uuid
import logging
from datetime import datetime, timedelta
from collections import defaultdict
from typing import List, Dict, Tuple
import threading
from flask import Flask, request, render_template, session, redirect, jsonify, url_for, g
from sqlalchemy import create_engine, text
import time
import hmac, hashlib 
from user_agents import parse as parse_ua

from werkzeug.middleware.proxy_fix import ProxyFix

# ========== 基础配置 ==========
app = Flask(__name__)
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=30)
app.secret_key = os.getenv('APP_SECRET', 'replace-me-in-prod')

app.config['SESSION_COOKIE_SECURE'] = os.getenv('SESSION_COOKIE_SECURE', '0') == '1' 

# 仅开发期
app.config['TEMPLATES_AUTO_RELOAD'] = True
app.jinja_env.auto_reload = True
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0  


# DB 连接
DB_DSN = os.getenv('FANDB_DSN', 'mysql+pymysql://localreader:12345678@127.0.0.1/FANDB?charset=utf8mb4')
engine = create_engine(
    DB_DSN,
    pool_pre_ping=True,
    pool_recycle=1800,
    future=True
)

# 常量
MAX_CHART_ITEMS = 8
TOP_QUERIES_LIMIT = 10
RECENT_LIKES_LIMIT = 3   # 与前端同步，让前端判断是否“可能截断”
SIZE_OPTIONS = ["不限", "120", "140"]
CLICK_COOLDOWN_SECONDS = 0.1

query_count_cache = 0

UID_COOKIE_NAME = os.getenv('UID_COOKIE_NAME', 'fc_uid')
UID_COOKIE_MAX_AGE = int(os.getenv('UID_COOKIE_MAX_AGE_SECONDS', str(60 * 60 * 24 * 365 * 2)))
UID_COOKIE_SAMESITE = os.getenv('UID_COOKIE_SAMESITE', 'Lax')
UID_COOKIE_SECURE = os.getenv('UID_COOKIE_SECURE', '0') == '1'
UID_COOKIE_HTTPONLY = os.getenv('UID_COOKIE_HTTPONLY', '0') == '1'
UID_COOKIE_REFRESH_INTERVAL = int(os.getenv('UID_COOKIE_REFRESH_INTERVAL_SECONDS', str(60 * 60 * 24 * 7)))
UID_COOKIE_REFRESH_TS_NAME = os.getenv('UID_COOKIE_REFRESH_TS_NAME', 'fc_uid_refreshed_at')

# ==== HTTPS PATCH START ====
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_for=1)
app.config['SESSION_COOKIE_SECURE']   = os.getenv('SESSION_COOKIE_SECURE', '0') == '1'
app.config['SESSION_COOKIE_HTTPONLY'] = os.getenv('SESSION_COOKIE_HTTPONLY', '1') == '1'
app.config['SESSION_COOKIE_SAMESITE'] = os.getenv('SESSION_COOKIE_SAMESITE', 'Lax')
app.config['SESSION_COOKIE_PATH'] = '/'

@app.after_request
def add_security_headers(resp):
    try:
        if request.is_secure:
            resp.headers.setdefault('Strict-Transport-Security',
                                    'max-age=31536000; includeSubDomains; preload')
        resp.headers.setdefault('X-Frame-Options', 'SAMEORIGIN')
        resp.headers.setdefault('X-Content-Type-Options', 'nosniff')
        resp.headers.setdefault('Referrer-Policy', 'strict-origin-when-cross-origin')
    except Exception:
        pass
    return resp

UPGRADE_FLAG_COOKIE = 'fc_uid_upgraded_secure'

@app.before_request
def _force_upgrade_uid_cookie():
    try:
        if not request.is_secure:
            return
        if not (os.getenv('UID_COOKIE_SECURE', '0') == '1'):
            return
        if request.cookies.get(UPGRADE_FLAG_COOKIE):
            return
        uid = get_or_create_user_identifier()
        g._set_uid_cookie = _sign_uid(uid)
        g._set_uid_refresh_now = True
        g._need_upgrade_flag_cookie = True
    except Exception:
        pass

@app.after_request
def _set_upgrade_flag(resp):
    if getattr(g, '_need_upgrade_flag_cookie', False):
        resp.set_cookie(
            UPGRADE_FLAG_COOKIE, '1',
            max_age=3600*24*30,
            samesite=UID_COOKIE_SAMESITE,
            secure=os.getenv('UID_COOKIE_SECURE','0') == '1',
            httponly=False,
            path='/'
        )
    return resp
# ==== HTTPS PATCH END ====

# ========== 签名 ==========
def _sign_uid(value: str) -> str:
    if not isinstance(app.secret_key, (bytes, bytearray)):
        key = str(app.secret_key).encode('utf-8')
    else:
        key = app.secret_key
    sig = hmac.new(key, value.encode('utf-8'), hashlib.sha256).hexdigest()[:16]
    return f"{value}.{sig}"

def _unsign_uid(token: str) -> str | None:
    if not token:
        return None
    parts = token.split('.', 1)
    if len(parts) != 2:
        return None
    raw, sig = parts[0], parts[1]
    expect = _sign_uid(raw).split('.', 1)[1]
    if hmac.compare_digest(sig, expect):
        return raw
    return None

# ========== 工具 ==========
@app.before_request
def _init_g_defaults():
    if not hasattr(g, '_uid_source'):
        g._uid_source = None

def get_or_create_user_identifier() -> str:
    uid_from_cookie_token = request.cookies.get(UID_COOKIE_NAME)
    uid_from_cookie = _unsign_uid(uid_from_cookie_token) if uid_from_cookie_token else None

    if uid_from_cookie:
        uid = uid_from_cookie
        g._uid_source = 'cookie'
    else:
        if uid_from_cookie_token:
            g._uid_source = 'cookie_invalid'
        uid = session.get('user_identifier')
        if uid:
            g._uid_source = g._uid_source or 'session'
        else:
            uid = str(uuid.uuid4())
            g._uid_source = g._uid_source or 'generated'

    g._active_uid = uid

    if not uid_from_cookie_token:
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

@app.route('/api/visit_start', methods=['POST'])
def api_visit_start():
    try:
        _ = get_or_create_user_identifier()
        uid = g._active_uid
        uid_source = getattr(g, '_uid_source', None)
        row = fetch_all("SELECT COUNT(*) AS c FROM visit_logs WHERE user_identifier=:u", {'u': uid})
        visit_index = int(row[0]['c']) + 1 if row else 1
        is_new_user = 1 if (visit_index == 1) else 0

        data = request.get_json(force=True, silent=True) or {}
        screen_w = int(data.get('screen_w') or 0) or None
        screen_h = int(data.get('screen_h') or 0) or None
        dpr      = float(data.get('device_pixel_ratio') or 0) or None
        language = (data.get('language') or '').strip() or None
        is_touch = 1 if data.get('is_touch') else 0

        ua_raw = request.headers.get('User-Agent','') or None
        dev = _parse_device_basic(ua_raw or '')

        sql = """
        INSERT INTO visit_logs
        (user_identifier, uid_source, visit_index, is_new_user,
         user_agent_raw, os_name, device_type,
         screen_w, screen_h, device_pixel_ratio, language, is_touch)
        VALUES
        (:uid, :usrc, :vidx, :isnew,
         :ua, :osn, :dtype,
         :sw, :sh, :dpr, :lang, :touch)
        """
        exec_write(sql, {
          'uid': uid,
          'usrc': uid_source,
          'vidx': visit_index,
          'isnew': is_new_user,
          'ua': ua_raw,
          'osn': dev['os_name'],
          'dtype': dev['device_type'],
          'sw': screen_w,
          'sh': screen_h,
          'dpr': dpr,
          'lang': language,
          'touch': is_touch
        })
        return jsonify({'success': True, 'visit_index': visit_index, 'is_new_user': bool(is_new_user)})
    except Exception as e:
        app.logger.exception(e)
        return jsonify({'success': False, 'error': str(e)}), 500

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
        return dict(
            os_name=ua.os.family or None,
            device_type=dtype
        )
    except Exception:
        return dict(os_name=None, device_type='other')

def fetch_all(sql: str, params: dict = None) -> List[dict]:
    with engine.begin() as conn:
        rows = conn.execute(text(sql), params or {})
        return [dict(r._mapping) for r in rows]

def _is_empty_loc_value(v: str | None) -> bool:
    if v is None:
        return False
    s = str(v).strip()
    return s == '' or s == '无'

def exec_write(sql: str, params: dict = None):
    with engine.begin() as conn:
        conn.execute(text(sql), params or {})

def fan_key_from(info: dict) -> str:
    return f"{int(info['model_id'])}_{int(info['condition_id'])}"

def to_int(v):
    try:
        return int(v) if v is not None else None
    except (TypeError, ValueError):
        return None

def to_float1(v):
    try:
        f = float(v)
        if f != f or f in (float('inf'), float('-inf')):
            return None
        return round(f, 1)
    except (TypeError, ValueError):
        return None

# ========== DAO ==========
def get_res_locs_by_res_type(res_type: str) -> List[str]:
    rows = fetch_all(
        "SELECT DISTINCT resistance_location_zh FROM general_view WHERE resistance_type_zh=:rt",
        {'rt': res_type}
    )
    return [r['resistance_location_zh'] for r in rows]

def get_top_queries(limit: int = TOP_QUERIES_LIMIT) -> List[dict]:
    sql = """SELECT model_id, condition_id,
                    brand_name_zh, model_name, resistance_type_zh, resistance_location_zh,
                    query_count, size, thickness, max_speed
             FROM total_query_rank_d30
             ORDER BY query_count DESC
             LIMIT :l"""
    return fetch_all(sql, {'l': limit})

def get_top_ratings(limit: int = TOP_QUERIES_LIMIT) -> List[dict]:
    sql = """SELECT model_id, condition_id,
                    brand_name_zh, model_name, resistance_type_zh, resistance_location_zh,
                    like_count, size, thickness, max_speed
             FROM total_like_d30
             ORDER BY like_count DESC
             LIMIT :l"""
    return fetch_all(sql, {'l': limit})

def get_all_resistance_types() -> List[str]:
    rows = fetch_all("SELECT DISTINCT resistance_type_zh FROM working_condition")
    return [r['resistance_type_zh'] for r in rows]

def get_all_resistance_locations() -> List[str]:
    rows = fetch_all("SELECT DISTINCT resistance_location_zh FROM working_condition")
    return [r['resistance_location_zh'] for r in rows]

def search_fans_by_condition(res_type, res_loc, sort_by, sort_value,
                             size_filter=None, thickness_min=None, thickness_max=None,
                             limit=200) -> List[dict]:
    base = [
        "SELECT model_id, condition_id, brand_name_zh, model_name, resistance_type_zh, resistance_location_zh,",
        "MAX(airflow_cfm) AS max_airflow, size, thickness, MAX(rpm) AS max_speed,",
        "MAX(COALESCE(like_count,0)) AS like_count, NULL AS constraint_value, '无' AS constraint_type",
        "FROM general_view",
        "WHERE resistance_type_zh=:rt"
    ]
    params = {'rt': res_type, 'limit': limit}

    if res_loc is not None:
        s = str(res_loc).strip()
        if s not in ('全部',):
            if _is_empty_loc_value(s):
                base.append("AND COALESCE(NULLIF(TRIM(resistance_location_zh),''),'') = ''")
            else:
                base.append("AND resistance_location_zh=:rl")
                params['rl'] = s

    if size_filter and size_filter != '不限':
        base.append("AND size=:sz"); params['sz'] = int(size_filter)
    if thickness_min is not None and thickness_max is not None:
        base.append("AND thickness BETWEEN :tmin AND :tmax")
        params.update(tmin=int(thickness_min), tmax=int(thickness_max))
    if sort_by == 'rpm':
        base.append("AND rpm <= :sv"); params['sv'] = float(sort_value)
    elif sort_by == 'noise':
        base.append("AND noise_db <= :sv"); params['sv'] = float(sort_value)

    base.append("GROUP BY model_id, condition_id, brand_name_zh, model_name, resistance_type_zh, resistance_location_zh, size, thickness")
    base.append("ORDER BY max_airflow DESC LIMIT :limit")
    sql = "\n".join(base)
    return fetch_all(sql, params)

def get_user_likes_full(user_identifier: str, limit: int | None = None) -> List[dict]:
    sql = """
    SELECT user_identifier, model_id, condition_id, brand_name_zh, model_name,
           resistance_type_zh, resistance_location_zh, max_speed, size, thickness
    FROM user_likes_view
    WHERE user_identifier=:u
    """
    rows = fetch_all(sql, {'u': user_identifier})
    return rows if limit is None else rows[:limit]

def get_user_like_keys(user_identifier: str) -> List[str]:
    recs = get_user_likes_full(user_identifier)
    return [f"{int(r['model_id'])}_{int(r['condition_id'])}" for r in recs]

def get_models_by_brand(brand: str) -> List[str]:
    sql = """SELECT DISTINCT m.model_name
             FROM fan_model m JOIN fan_brand b ON b.brand_id=m.brand_id
             WHERE b.brand_name_zh=:b"""
    rows = fetch_all(sql, {'b': brand})
    return [r['model_name'] for r in rows]

def get_res_types_by_brand_model(brand: str, model: str) -> List[str]:
    sql = "SELECT DISTINCT resistance_type_zh FROM general_view WHERE brand_name_zh=:b AND model_name=:m"
    rows = fetch_all(sql, {'b': brand, 'm': model})
    return [r['resistance_type_zh'] for r in rows]

def get_res_locs_by_bmr(brand: str, model: str, res_type: str) -> List[str]:
    sql = """SELECT DISTINCT resistance_location_zh
             FROM general_view WHERE brand_name_zh=:b AND model_name=:m AND resistance_type_zh=:rt"""
    rows = fetch_all(sql, {'b': brand, 'm': model, 'rt': res_type})
    return [r['resistance_location_zh'] for r in rows]

def get_distinct_pairs_for_add(brand: str, model: str,
                               res_type: str | None, res_loc: str | None) -> List[dict]:
    where = ["brand_name_zh=:b", "model_name=:m"]
    params = {'b': brand, 'm': model}
    if res_type:
        where.append("resistance_type_zh=:rt"); params['rt'] = res_type

    if res_loc is not None:
        s = str(res_loc).strip()
        if s not in ('全部',):
            if _is_empty_loc_value(s):
                where.append("COALESCE(NULLIF(TRIM(resistance_location_zh),''),'') = ''")
            else:
                where.append("resistance_location_zh=:rl"); params['rl'] = s

    sql = f"""
      SELECT DISTINCT model_id, condition_id, brand_name_zh, model_name,
                      resistance_type_zh, resistance_location_zh
      FROM general_view
      WHERE {" AND ".join(where)}
    """
    return fetch_all(sql, params)

def get_curves_for_pairs(pairs: List[Tuple[int,int]]) -> Dict[str, dict]:
    if not pairs:
        return {}
    conds, params = [], {}
    for i, (m, c) in enumerate(pairs, start=1):
        conds.append(f"(:m{i}, :c{i})")
        params[f"m{i}"] = int(m)
        params[f"c{i}"] = int(c)

    sql = f"""
      SELECT model_id, condition_id, brand_name_zh, model_name,
             resistance_type_zh, resistance_location_zh,
             rpm, airflow_cfm AS airflow, noise_db
      FROM general_view
      WHERE (model_id, condition_id) IN ({",".join(conds)})
      ORDER BY model_id, condition_id, rpm
    """
    rows = fetch_all(sql, params)
    bucket: Dict[str, dict] = {}
    for r in rows:
        key = f"{int(r['model_id'])}_{int(r['condition_id'])}"
        b = bucket.setdefault(key, {
            'rpm': [], 'airflow': [], 'noise_db': [],
            'info': {
                'brand': r['brand_name_zh'],
                'model': r['model_name'],
                'res_type': r['resistance_type_zh'],
                'res_loc': r['resistance_location_zh'],
                'model_id': int(r['model_id']),
                'condition_id': int(r['condition_id'])
            }
        })
        rpm_v = to_int(r.get('rpm'))
        airflow_v = to_float1(r.get('airflow'))
        noise_v = to_float1(r.get('noise_db'))
        if airflow_v is None:
            continue
        if rpm_v is None and noise_v is None:
            continue
        b['rpm'].append(rpm_v)
        b['airflow'].append(airflow_v)
        b['noise_db'].append(noise_v)
    return bucket

# ========== 会话模型 ==========
def get_selected_dict() -> Dict[str, dict]:
    return session.setdefault('selected_fans', {})

def add_fan_to_session(info: dict):
    sel = get_selected_dict()
    sel[fan_key_from(info)] = {
        'info': {
            'brand': info['brand'],
            'model': info['model'],
            'res_type': info['res_type'],
            'res_loc': info['res_loc'],
            'model_id': int(info['model_id']),
            'condition_id': int(info['condition_id'])
        }
    }
    session.modified = True

def add_to_recently_removed(info: dict):
    removed = session.setdefault('recently_removed_fans', {})
    removed[fan_key_from(info)] = {
        'info': info,
        'removed_time': datetime.now().isoformat()
    }
    if len(removed) > MAX_RECENTLY_REMOVED:
        oldest = min(removed.items(), key=lambda kv: kv[1]['removed_time'])[0]
        removed.pop(oldest, None)
    session.modified = True

def remove_fan_from_session(fk: str) -> bool:
    sel = get_selected_dict()
    if fk in sel:
        info = sel[fk]['info']
        add_to_recently_removed(info)
        sel.pop(fk, None)
        session.modified = True
        return True
    return False

def remove_fan_from_recently_removed(fk: str) -> bool:
    rem = session.get('recently_removed_fans', {})
    if fk in rem:
        rem.pop(fk)
        session.modified = True
        return True
    return False

# ========== 业务装配 ==========
def build_selected_fans_list() -> List[dict]:
    sel = get_selected_dict()
    res = []
    for k, v in sel.items():
        info = v['info']
        res.append(dict(
            key=k, brand=info['brand'], model=info['model'],
            res_type=info['res_type'], res_loc=info['res_loc'],
            model_id=info['model_id'], condition_id=info['condition_id']
        ))
    return res

def build_recently_removed_list() -> List[dict]:
    rem = session.get('recently_removed_fans', {})
    items = list(rem.items())
    items.sort(key=lambda kv: kv[1]['removed_time'], reverse=True)
    res = []
    for k, v in items:
        info = v['info']
        res.append(dict(
            key=k, brand=info['brand'], model=info['model'],
            res_type=info['res_type'], res_loc=info['res_loc']
        ))
    return res

def build_chart_data() -> dict:
    x_axis_type = session.get('x_axis_type', 'rpm')
    sel = get_selected_dict()
    pairs = []
    order_keys = []
    for k, v in sel.items():
        info = v['info']
        pairs.append((info['model_id'], info['condition_id']))
        order_keys.append(k)

    bucket = get_curves_for_pairs(pairs)
    series = []
    for k in order_keys:
        b = bucket.get(k)
        if not b:
            continue
        info = b['info']
        series.append(dict(
            key=k,
            name=f"{info['brand']} {info['model']} - {info['res_type']}({info['res_loc']})",
            brand=info['brand'], model=info['model'],
            res_type=info['res_type'], res_loc=info['res_loc'],
            model_id=info['model_id'], condition_id=info['condition_id'],
            rpm=b['rpm'], noise_db=b['noise_db'], airflow=b['airflow']
        ))
    return dict(x_axis_type=x_axis_type, series=series)

def assemble_state(extra: dict | None = None) -> dict:
    user_id = get_or_create_user_identifier()
    state = dict(
        chart_data=build_chart_data(),
        selected_fans=build_selected_fans_list(),
        recently_removed_fans=build_recently_removed_list(),
        like_keys=get_user_like_keys(user_id),
        max_chart_items=MAX_CHART_ITEMS,
        error_message=None
    )
    if extra:
        state.update(extra)
    return state

# ========== 日志 ==========
def log_query(fan_infos):
    if isinstance(fan_infos, dict):
        fan_infos = [fan_infos]
    user_id = get_or_create_user_identifier()
    batch = str(uuid.uuid4())
    sql = "INSERT INTO query_logs (user_identifier, model_id, condition_id, batch_id) VALUES (:u,:m,:c,:b)"
    try:
        with engine.begin() as conn:
            for info in fan_infos:
                conn.execute(text(sql), {'u': user_id, 'm': info['model_id'], 'c': info['condition_id'], 'b': batch})
    except Exception as e:
        app.logger.warning('记录查询日志出错: %s', e)

# ========== 业务操作 ==========
def is_duplicate_in_session(info: dict) -> bool:
    return fan_key_from(info) in get_selected_dict()

def handle_add_logic(brand: str, model: str, res_type: str, res_loc: str) -> dict:
    start_count = len(get_selected_dict())
    pairs_info = get_distinct_pairs_for_add(
        brand, model,
        None if res_type == '全部' else res_type,
        None if (not res_loc or res_loc == '全部') else res_loc
    )
    if not pairs_info:
        return {'error_message': '没有匹配的数据组合（可能该型号在该位置/类型下无记录）'}

    to_add = []
    for r in pairs_info:
        info = dict(
            brand=r['brand_name_zh'],
            model=r['model_name'],
            res_type=r['resistance_type_zh'],
            res_loc=r['resistance_location_zh'],
            model_id=int(r['model_id']),
            condition_id=int(r['condition_id'])
        )
        if not is_duplicate_in_session(info):
            to_add.append(info)

    if not to_add:
        return {'error_message': '全部数据已存在，无新增'}

    if start_count + len(to_add) > MAX_CHART_ITEMS:
        return {'error_message': f'该选择将新增 {len(to_add)} 组，已存在 {start_count} 组，超出上限 {MAX_CHART_ITEMS}，请先移除部分。'}

    for info in to_add:
        add_fan_to_session(info)

    log_query(to_add)
    return {}

def update_query_count():
    global query_count_cache
    while True:
        try:
            sql = "SELECT COUNT(DISTINCT batch_id) FROM query_logs"
            result = fetch_all(sql)
            query_count_cache = result[0]['COUNT(DISTINCT batch_id)'] if result else 0
        except Exception as e:
            print(f"更新查询次数失败: {e}")
        time.sleep(60)

query_count_thread = threading.Thread(target=update_query_count, daemon=True)
query_count_thread.start()

# === 扩展模式查询辅助 ===
def expand_model_conditions(brand: str, model: str,
                            res_type_raw: str, res_loc_raw: str) -> List[dict]:
    where = ["brand_name_zh=:b", "model_name=:m"]
    params = {'b': brand, 'm': model}

    if res_type_raw and res_type_raw != '全部':
        where.append("resistance_type_zh=:rt")
        params['rt'] = res_type_raw

    if res_loc_raw is not None:
        s = str(res_loc_raw).strip()
        if s not in ('全部',):
            if s in ('无', ''):
                where.append("COALESCE(NULLIF(TRIM(resistance_location_zh),''),'') = ''")
            else:
                where.append("resistance_location_zh=:rl")
                params['rl'] = s

    sql = f"""
      SELECT model_id, condition_id,
             brand_name_zh, model_name,
             resistance_type_zh, resistance_location_zh,
             size, thickness,
             MAX(rpm) AS max_speed,
             MAX(airflow_cfm) AS max_airflow,
             COALESCE(MAX(like_count),0) AS like_count
      FROM general_view
      WHERE {" AND ".join(where)}
      GROUP BY model_id, condition_id, brand_name_zh, model_name,
               resistance_type_zh, resistance_location_zh, size, thickness
      ORDER BY model_id, condition_id
    """
    return fetch_all(sql, params)

# === 新增：批量点赞状态查询 ===
def get_user_like_entries(user_identifier: str, pairs: list[tuple[int,int]]) -> list[str]:
    """
    返回用户在给定 (model_id, condition_id) 列表中已点赞的 key（"model_id_condition_id"）列表。
    """
    if not pairs:
        return []
    conds = []
    params = {'u': user_identifier}
    for i, (m, c) in enumerate(pairs, start=1):
        conds.append(f"(:m{i}, :c{i})")
        params[f"m{i}"] = int(m)
        params[f"c{i}"] = int(c)
    sql = f"""
      SELECT model_id, condition_id
      FROM user_likes_view
      WHERE user_identifier=:u
        AND (model_id, condition_id) IN ({",".join(conds)})
    """
    rows = fetch_all(sql, params)
    return [f"{int(r['model_id'])}_{int(r['condition_id'])}" for r in rows]

# ========== 路由 ==========
@app.route('/api/like_status', methods=['POST'])
def api_like_status():
    """
    输入: { "pairs": [ { "model_id": 1, "condition_id": 2 }, ... ] }
    输出: { "success": true, "liked_keys": ["1_2","..."] }
    仅返回在给定集合里用户已点赞的键。
    """
    t_start = time.time()
    try:
        user_id = get_or_create_user_identifier()
        data = request.get_json(force=True, silent=True) or {}
        raw_pairs = data.get('pairs') or []

        cleaned = []
        seen = set()
        for p in raw_pairs:
            try:
                mid = int(p.get('model_id'))
                cid = int(p.get('condition_id'))
            except Exception:
                continue
            key_tuple = (mid, cid)
            if key_tuple in seen:
                continue
            seen.add(key_tuple)
            cleaned.append(key_tuple)

        liked_keys = get_user_like_entries(user_id, cleaned)
        dur_ms = int((time.time() - t_start) * 1000)

        # 日志：包含调用来源 IP/用户、请求数量、去重后数量、命中点赞数（仅打印前 8 个示例键）
        sample_keys = liked_keys[:8]
        app.logger.info(
            "[like_status] uid=%s ip=%s raw=%d dedup=%d liked=%d sample=%s time=%dms",
            user_id,
            request.headers.get('X-Forwarded-For', request.remote_addr),
            len(raw_pairs),
            len(cleaned),
            len(liked_keys),
            sample_keys,
            dur_ms
        )

        return jsonify({'success': True, 'liked_keys': liked_keys})
    except Exception as e:
        app.logger.exception(e)
        return jsonify({'success': False, 'error': str(e)}), 500
    
@app.post('/api/pairs')
def api_pairs():
    return jsonify({
        'success': False,
        'error_code': 'DEPRECATED',
        'error_message': '接口已废弃：请使用 /api/search_fans(mode="expand") 获取 (model_id, condition_id) 列表',
        'data': None
    }), 410

@app.post('/api/curves')
def api_curves():
    try:
        data = request.get_json(force=True) or {}
        raw_pairs = data.get('pairs') or []
        uniq = []
        seen = set()
        for p in raw_pairs:
            try:
                mid = int(p.get('model_id'))
                cid = int(p.get('condition_id'))
            except Exception:
                continue
            key = (mid, cid)
            if key in seen:
                continue
            seen.add(key)
            uniq.append(key)

        bucket = get_curves_for_pairs(uniq)
        series = []
        for mid, cid in uniq:
            k = f"{mid}_{cid}"
            b = bucket.get(k)
            if not b:
                continue
            info = b['info']
            series.append(dict(
                key=k,
                name=f"{info['brand']} {info['model']} - {info['res_type']}({info['res_loc']})",
                brand=info['brand'],
                model=info['model'],
                res_type=info['res_type'],
                res_loc=info['res_loc'],
                model_id=info['model_id'],
                condition_id=info['condition_id'],
                rpm=b['rpm'],
                noise_db=b['noise_db'],
                airflow=b['airflow']
            ))
        return jsonify({'success': True, 'series': series})
    except Exception as e:
        app.logger.exception(e)
        return jsonify({'success': False, 'error': f'后端异常: {e}'})

@app.post('/api/log_query')
def api_log_query():
    try:
        data = request.get_json(force=True) or {}
        raw_pairs = data.get('pairs') or []
        cleaned = []
        seen = set()
        for p in raw_pairs:
            try:
                mid = int(p.get('model_id'))
                cid = int(p.get('condition_id'))
            except Exception:
                continue
            key = (mid, cid)
            if key in seen:
                continue
            seen.add(key)
            cleaned.append({'model_id': mid, 'condition_id': cid})
        if cleaned:
            log_query(cleaned)
        return jsonify({'success': True, 'logged': len(cleaned)})
    except Exception as e:
        app.logger.exception(e)
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/query_count')
def get_query_count():
    return jsonify({'count': query_count_cache})

@app.route('/api/theme', methods=['POST'])
def api_theme():
    data = request.get_json(force=True, silent=True) or {}
    session['theme'] = data.get('theme', 'light')
    session.modified = True
    return jsonify({'success': True})

@app.post('/api/update_x_axis')
def api_update_x_axis_deprecated():
    return jsonify({'success': False, 'error': '接口已废弃：X轴模式改为前端本地存储'}), 410

@app.route('/api/top_ratings', methods=['GET'])
def api_top_ratings():
    try:
        return jsonify({'success': True, 'data': get_top_ratings(limit=10)})
    except Exception as e:
        app.logger.exception(e)
        return jsonify({'success': False, 'error': str(e)})

# === 改造：recent_likes 支持 ?model_id=&condition_id= 精确查询 ===
@app.route('/api/recent_likes', methods=['GET'])
def api_recent_likes():
    try:
        user_id = get_or_create_user_identifier()
        items = get_user_likes_full(user_id, limit=RECENT_LIKES_LIMIT)
        return jsonify({'success': True, 'data': items})
    except Exception as e:
        app.logger.exception(e)
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/search_fans', methods=['POST'])
def api_search_fans():
    try:
        data = request.get_json(force=True) or {}
        mode = (data.get('mode') or 'filter').strip()

        if mode == 'expand':
            brand = (data.get('brand') or '').strip()
            model = (data.get('model') or '').strip()
            res_type = (data.get('res_type') or '').strip()
            res_loc = data.get('res_loc')
            if not brand or not model:
                return jsonify({
                    'success': False,
                    'error_code': 'INVALID_PARAM',
                    'error_message': '缺少品牌或型号',
                    'data': None
                })

            rows = expand_model_conditions(brand, model, res_type, '' if res_loc == '无' else (res_loc or ''))
            items = []
            for r in rows:
                items.append({
                    'model_id': int(r['model_id']),
                    'condition_id': int(r['condition_id']),
                    'brand_name_zh': r['brand_name_zh'],
                    'model_name': r['model_name'],
                    'resistance_type_zh': r['resistance_type_zh'],
                    'resistance_location_zh': r['resistance_location_zh'],
                    'size': r['size'],
                    'thickness': r['thickness'],
                    'max_speed': r['max_speed'],
                    'max_airflow': to_float1(r['max_airflow']),
                    'like_count': r['like_count']
                })
            return jsonify({
                'success': True,
                'error_code': None,
                'error_message': None,
                'data': {
                    'mode': 'expand',
                    'items': items,
                    'count': len(items)
                }
            })

        res_type = (data.get('search_res_type') or '').strip()
        res_loc  = (data.get('search_res_loc') or '').strip()
        size_filter = (data.get('size_filter') or '').strip()
        thickness_min = (data.get('thickness_min') or '').strip()
        thickness_max = (data.get('thickness_max') or '').strip()
        sort_by  = (data.get('sort_by') or 'none').strip()
        sort_value_raw = (data.get('sort_value') or '').strip()

        if not res_type:
            return jsonify({'success': False, 'error_message': '请选择风阻类型'})
        if res_type != '空载' and not res_loc:
            return jsonify({'success': False, 'error_message': '请选择风阻位置'})

        try:
            tmin = int(thickness_min); tmax = int(thickness_max)
            if tmin < 1 or tmax < 1 or tmin > 99 or tmax > 99 or tmin > tmax:
                return jsonify({'success': False, 'error_message': '厚度区间不合法 (1~99 且最小不大于最大)'})
        except ValueError:
            return jsonify({'success': False, 'error_message': '厚度必须为整数'})

        sort_value = None
        if sort_by != 'none':
            if not sort_value_raw:
                return jsonify({'success': False, 'error_message': '请输入限制值'})
            try:
                sort_value = float(sort_value_raw)
            except ValueError:
                return jsonify({'success': False, 'error_message': '限制值必须是数字'})

        res_loc_filter = '' if res_type == '空载' else res_loc

        results = search_fans_by_condition(
            res_type, res_loc_filter,
            sort_by, sort_value,
            size_filter,
            tmin, tmax,
            limit=200
        )

        if sort_by == 'rpm':
            condition_label = f'条件限制：转速 ≤ {sort_value_raw} RPM'
        elif sort_by == 'noise':
            condition_label = f'条件限制：噪音 ≤ {sort_value_raw} dB'
        else:
            condition_label = '条件：全速运行'

        return jsonify({
            'success': True,
            'search_results': results,
            'condition_label': condition_label
        })
    except Exception as e:
        app.logger.exception(e)
        return jsonify({'success': False, 'error_message': f'搜索异常: {e}'})

@app.route('/get_resistance_locations_by_type/<res_type>')
def get_resistance_locations_by_type(res_type):
    if not res_type:
        return jsonify([])
    rows = get_res_locs_by_res_type(res_type)
    out = []
    has_empty = False
    for v in rows:
        s = '' if v is None else str(v).strip()
        if s == '':
            has_empty = True
        else:
            out.append(s)
    if res_type == '空载' or has_empty:
        out.insert(0, '无')
    return jsonify(out)

@app.post('/api/add_fan')
def api_add_fan_deprecated():
    return jsonify({'success': False, 'error': '接口已废弃：请使用 /api/pairs + 前端本地状态 + /api/curves'}), 410

def handle_add_logic_inputs_ready(brand: str, model: str,
                                  res_type_filter: str | None,
                                  res_loc_filter: str | None) -> dict:
    start_count = len(get_selected_dict())
    pairs_info = get_distinct_pairs_for_add(brand, model, res_type_filter, res_loc_filter)
    if not pairs_info:
        return {'error_message': '没有匹配的数据组合（可能该型号在该位置/类型下无记录）'}
    to_add = []
    for r in pairs_info:
        info = dict(
            brand=r['brand_name_zh'],
            model=r['model_name'],
            res_type=r['resistance_type_zh'],
            res_loc=r['resistance_location_zh'],
            model_id=int(r['model_id']),
            condition_id=int(r['condition_id'])
        )
        if not is_duplicate_in_session(info):
            to_add.append(info)
    if not to_add:
        return {'error_message': '全部数据已存在，无新增'}
    if start_count + len(to_add) > MAX_CHART_ITEMS:
        return {'error_message': f'该选择将新增 {len(to_add)} 组，已存在 {start_count} 组，超出上限 {MAX_CHART_ITEMS}，请先移除部分。'}
    for info in to_add:
        add_fan_to_session(info)
    log_query(to_add)
    return {}

@app.post('/api/remove_fan')
def api_remove_fan_deprecated():
    return jsonify({'success': False, 'error': '接口已废弃：前端本地维护 selected/removed'}), 410

@app.post('/api/restore_fan')
def api_restore_fan_deprecated():
    return jsonify({'success': False, 'error': '接口已废弃：前端本地维护 selected/removed'}), 410

@app.post('/api/clear_all')
def api_clear_all_deprecated():
    return jsonify({'success': False, 'error': '接口已废弃：前端本地维护 selected/removed'}), 410

@app.get('/api/state')
def api_state_deprecated():
    return jsonify({'success': False, 'error': '接口已废弃：本地状态已前端化'}), 410

@app.route('/search_models/<query>')
def search_models(query):
    sql = "SELECT DISTINCT brand_name_zh, model_name FROM general_view WHERE model_name LIKE :q LIMIT 20"
    rows = fetch_all(sql, {'q': f"%{query}%"} )
    models = [f"{r['brand_name_zh']} {r['model_name']}" for r in rows]
    return jsonify(models)

@app.route('/get_models/<brand>')
def get_models(brand):
    return jsonify(get_models_by_brand(brand))

@app.route('/get_resistance_types/<brand>/<model>')
def get_resistance_types(brand, model):
    return jsonify(get_res_types_by_brand_model(brand, model))

@app.route('/get_resistance_locations/<brand>/<model>/<res_type>')
def get_resistance_locations(brand, model, res_type):
    rows = get_res_locs_by_bmr(brand, model, res_type)
    out = []
    has_empty = False
    for v in rows:
        s = '' if v is None else str(v).strip()
        if s == '':
            has_empty = True
        else:
            out.append(s)
    if has_empty or res_type == '空载':
        out.insert(0, '无')
    return jsonify(out)

@app.route('/api/like', methods=['POST'])
def api_like():
    data = request.get_json(force=True) or {}
    model_id = data.get('model_id')
    condition_id = data.get('condition_id')
    user_id = get_or_create_user_identifier()
    if not model_id or not condition_id:
        return jsonify({'success': False, 'error': '缺少 model_id 或 condition_id'})
    try:
        sql = """INSERT INTO rate_logs (user_identifier, model_id, condition_id, is_valid, rate_id)
                 VALUES (:u,:m,:c,1,1)
                 ON DUPLICATE KEY UPDATE is_valid=1, update_date=NOW()"""
        exec_write(sql, {'u': user_id, 'm': model_id, 'c': condition_id})
        return jsonify({'success': True, 'like_keys': get_user_like_keys(user_id)})
    except Exception as e:
        app.logger.exception(e)
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/unlike', methods=['POST'])
def api_unlike():
    data = request.get_json(force=True) or {}
    model_id = data.get('model_id')
    condition_id = data.get('condition_id')
    user_id = get_or_create_user_identifier()
    if not model_id or not condition_id:
        return jsonify({'success': False, 'error': '缺少 model_id 或 condition_id'})
    try:
        sql = """UPDATE rate_logs SET is_valid=0, update_date=NOW()
                 WHERE rate_id=1 AND user_identifier=:u AND model_id=:m AND condition_id=:c"""
        exec_write(sql, {'u': user_id, 'm': model_id, 'c': condition_id})
        return jsonify({'success': True, 'like_keys': get_user_like_keys(user_id)})
    except Exception as e:
        app.logger.exception(e)
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/config')
def api_config():
    return jsonify({
        'success': True,
        'click_cooldown_ms': CLICK_COOLDOWN_SECONDS * 1000,
        'recent_likes_limit': RECENT_LIKES_LIMIT
    })

@app.route('/')
def index():
    brands_rows = fetch_all("SELECT DISTINCT brand_name_zh FROM fan_brand")
    brands = [r['brand_name_zh'] for r in brands_rows]
    all_res_types = get_all_resistance_types()
    all_res_locs  = get_all_resistance_locations()
    top_queries = get_top_queries(limit=10)
    top_ratings = get_top_ratings(limit=10)

    url_search_res_type = request.args.get('search_res_type','')
    url_search_res_loc  = request.args.get('search_res_loc','')
    url_sort_by   = request.args.get('sort_by','none')
    url_sort_value= request.args.get('sort_value','')
    url_size_filter = request.args.get('size_filter','不限')
    url_thickness_min = request.args.get('thickness_min','25')
    url_thickness_max = request.args.get('thickness_max','50')

    search_res_type=url_search_res_type
    search_res_loc=url_search_res_loc
    sort_by=url_sort_by; sort_value=url_sort_value
    size_filter=url_size_filter; thickness_min=url_thickness_min; thickness_max=url_thickness_max

    error_message=None; search_results=[]
    if request.method=='GET' and search_res_type and search_res_loc:
        try:
            tmin=float(thickness_min); tmax=float(thickness_max)
            if sort_by=='none':
                search_results=search_fans_by_condition(search_res_type, search_res_loc, sort_by, None, size_filter, tmin, tmax, 10)
            elif sort_value:
                search_results=search_fans_by_condition(search_res_type, search_res_loc, sort_by, float(sort_value), size_filter, tmin, tmax, 10)
        except ValueError:
            error_message='厚度或限制值需为数字'

    selected_fans = build_selected_fans_list()

    return render_template('fancoolindex.html',
                           brands=brands, models=[], res_types=[], res_locs=[],
                           selected_fans=selected_fans, top_queries=top_queries, top_ratings=top_ratings,
                           all_res_types=all_res_types, all_res_locs=all_res_locs, search_results=search_results,
                           search_res_type=search_res_type, search_res_loc=search_res_loc, sort_by=sort_by,
                           sort_value=sort_value, size_options=SIZE_OPTIONS, size_filter=size_filter,
                           thickness_min=thickness_min, thickness_max=thickness_max, error_message=error_message,
                           max_chart_items=MAX_CHART_ITEMS, url_search_res_type=url_search_res_type,
                           url_search_res_loc=url_search_res_loc, url_sort_by=url_sort_by, url_sort_value=url_sort_value,
                           url_size_filter=url_size_filter, url_thickness_min=url_thickness_min,
                           url_thickness_max=url_thickness_max,
                           click_cooldown_ms=CLICK_COOLDOWN_SECONDS * 1000)

@app.route('/clear_session')
def clear_session():
    sel = get_selected_dict()
    for k, v in list(sel.items()):
        add_to_recently_removed(v['info'])
    session.pop('selected_fans', None)
    session.modified = True
    return redirect(url_for('index'))

if __name__ == '__main__':
    app.logger.setLevel(logging.INFO)
    app.run(host='0.0.0.0', port=5001, debug=True, use_reloader=False)