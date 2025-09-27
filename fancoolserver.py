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
#app.config['TEMPLATES_AUTO_RELOAD'] = True
#app.jinja_env.auto_reload = True
#app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0  


# DB 连接（环境变量 FANDB_DSN 优先）
# 例：export FANDB_DSN="mysql+pymysql://user:pass@127.0.0.1/FANDB?charset=utf8mb4"
DB_DSN = os.getenv('FANDB_DSN', 'mysql+pymysql://localreader:12345678@127.0.0.1/FANDB?charset=utf8mb4')
engine = create_engine(
    DB_DSN,
    pool_pre_ping=True,
    pool_recycle=1800,
    future=True
)


# 常量
MAX_CHART_ITEMS = 8
MAX_RECENTLY_REMOVED = 20
TOP_QUERIES_LIMIT = 10
SIZE_OPTIONS = ["不限", "120", "140"]
CLICK_COOLDOWN_SECONDS = 0.1

# 统一调色板前端管理，这里仅保留给前端参考的默认
COLORS_DEFAULT = ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd",
                  "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf"]

# 查询次数缓存初值，避免首次访问 /api/query_count 报未定义
query_count_cache = 0


UID_COOKIE_NAME = os.getenv('UID_COOKIE_NAME', 'fc_uid')
UID_COOKIE_MAX_AGE = int(os.getenv('UID_COOKIE_MAX_AGE_SECONDS', str(60 * 60 * 24 * 365 * 2)))  # 默认 2 年
UID_COOKIE_SAMESITE = os.getenv('UID_COOKIE_SAMESITE', 'Lax')  # Lax/Strict/None
UID_COOKIE_SECURE = os.getenv('UID_COOKIE_SECURE', '0') == '1'  # HTTPS 下应为 True
UID_COOKIE_HTTPONLY = os.getenv('UID_COOKIE_HTTPONLY', '0') == '1'

# “滑动过期”刷新节流：默认 7 天刷新一次
UID_COOKIE_REFRESH_INTERVAL = int(os.getenv('UID_COOKIE_REFRESH_INTERVAL_SECONDS', str(60 * 60 * 24 * 7)))  # 7 天
UID_COOKIE_REFRESH_TS_NAME = os.getenv('UID_COOKIE_REFRESH_TS_NAME', 'fc_uid_refreshed_at')

# ==== HTTPS PATCH START ====

# 让 Flask 信任来自反向代理的第一个 X-Forwarded-Proto / For 头
# 如果你的部署链有多层代理，只增加对应数量；常见一层就 x_proto=1,x_for=1
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_for=1)

# 基于环境变量应用 session cookie 安全设置（也可直接硬编码 True）
app.config['SESSION_COOKIE_SECURE']   = os.getenv('SESSION_COOKIE_SECURE', '0') == '1'
app.config['SESSION_COOKIE_HTTPONLY'] = os.getenv('SESSION_COOKIE_HTTPONLY', '1') == '1'
# Flask 默认 Lax；如果需要 None 记得同时 Secure
app.config['SESSION_COOKIE_SAMESITE'] = os.getenv('SESSION_COOKIE_SAMESITE', 'Lax')

# （可选）显式关闭跨站脚本注入到 session 的风险（默认就是 True，写上更直观）
app.config['SESSION_COOKIE_PATH'] = '/'

# 安全响应头（与 ensure_uid_cookie 并存，不会互相覆盖）
@app.after_request
def add_security_headers(resp):
    # 只在 HTTPS 请求上添加 HSTS，避免本地 http 调试污染浏览器
    try:
        if request.is_secure:
            # 初次可用较短时间，例如 max-age=300 做验证，确认无误再调大
            resp.headers.setdefault('Strict-Transport-Security',
                                    'max-age=31536000; includeSubDomains; preload')
        resp.headers.setdefault('X-Content-Type-Options', 'nosniff')
        resp.headers.setdefault('Referrer-Policy', 'strict-origin-when-cross-origin')
        # 可按需加：resp.headers.setdefault('Permissions-Policy','camera=(),microphone=()')
    except Exception:
        pass
    return resp

# 强制一次性为旧的非 Secure UID Cookie 重新下发（仅 HTTPS 环境）
# 说明：浏览器不会告诉你一个 cookie 是否“曾经不带 Secure”，所以我们用一个标记 cookie 来判断是否已升级过。
UPGRADE_FLAG_COOKIE = 'fc_uid_upgraded_secure'

@app.before_request
def _force_upgrade_uid_cookie():
    """
    如果已经切到 HTTPS 且启用 Secure 并且还没写入过升级标记，则强制标记重新下发 UID Cookie。
    利用后续 ensure_uid_cookie 的逻辑 + 手动设置 g._set_uid_cookie。
    """
    try:
        if not request.is_secure:
            return
        if not (os.getenv('UID_COOKIE_SECURE', '0') == '1'):
            return
        if request.cookies.get(UPGRADE_FLAG_COOKIE):
            return  # 已升级
        # 触发行内逻辑：确保我们有一个 active uid
        uid = get_or_create_user_identifier()
        # 标记重新发（即便本来就有）——设置 g._set_uid_cookie 让 ensure_uid_cookie 执行
        g._set_uid_cookie = _sign_uid(uid)
        g._set_uid_refresh_now = True
        g._need_upgrade_flag_cookie = True
    except Exception:
        pass

@app.after_request
def _set_upgrade_flag(resp):
    if getattr(g, '_need_upgrade_flag_cookie', False):
        # 这个标记只需要存在即可；不必 HttpOnly（无敏感信息）
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
    """
    对 uid 做简易签名，防止篡改。
    返回格式: "<uuid>.<sig16>"
    """
    if not isinstance(app.secret_key, (bytes, bytearray)):
        key = str(app.secret_key).encode('utf-8')
    else:
        key = app.secret_key
    sig = hmac.new(key, value.encode('utf-8'), hashlib.sha256).hexdigest()[:16]
    return f"{value}.{sig}"

def _unsign_uid(token: str) -> str | None:
    """
    校验签名，返回原始 uuid（通过）或 None（失败）。
    同时兼容未签名的旧值（若决定允许则直接返回）。
    """
    if not token:
        return None
    parts = token.split('.', 1)
    if len(parts) != 2:
        # 如果想强制签名，直接返回 None；如果想兼容未签名老值，可以直接返回 token
        # 这里选择兼容未签名老值（可按需改为严格）
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
    """
    优先使用长期 Cookie（fc_uid）；无则回退到 session；再无则生成。
    如本次没有可用 Cookie，则在本次响应中下发（g._set_uid_cookie）。
    同时在 g._uid_source 标注来源（cookie/session/generated/cookie_invalid）。
    """
    uid_from_cookie_token = request.cookies.get(UID_COOKIE_NAME)
    uid_from_cookie = _unsign_uid(uid_from_cookie_token) if uid_from_cookie_token else None

    if uid_from_cookie:
        uid = uid_from_cookie
        g._uid_source = 'cookie'
    else:
        # 记录是否携带了无效签名的 cookie
        if uid_from_cookie_token:
            g._uid_source = 'cookie_invalid'
        uid = session.get('user_identifier')
        if uid:
            # 如果有 cookie_invalid 也保留这个信息，否则标注为 session
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
    """
    1) 若本次标记需要下发（首次创建或从 session 迁移），立即下发并记录刷新时间戳；
    2) 否则进入“滑动过期”节流：超过阈值（默认 7 天）才刷新 Cookie（同值）以延长 max_age。
    """
    now = int(time.time())

    # Case 1: 首次创建/迁移（get_or_create_user_identifier 设置的标记）
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
                httponly=UID_COOKIE_HTTPONLY,  # 可设为 True；不需要前端读取
                path='/'
            )
        return resp
    
    # Case 2: 滑动过期节流（仅当已有 Cookie 时考虑刷新）
    last_ts_raw = request.cookies.get(UID_COOKIE_REFRESH_TS_NAME)
    try:
        last_ts = int(last_ts_raw or '0')
    except ValueError:
        last_ts = 0

    # 超过阈值才刷新（同值），以延长 max_age
    if now - last_ts >= UID_COOKIE_REFRESH_INTERVAL:
        existing_token = request.cookies.get(UID_COOKIE_NAME)
        # 验证现有 token；若无效则用 g._active_uid 重新签名下发
        uid = _unsign_uid(existing_token) if existing_token else None
        if uid:
            # 直接用原 token 刷新（值不变）
            resp.set_cookie(
                UID_COOKIE_NAME, existing_token,
                max_age=UID_COOKIE_MAX_AGE,
                samesite=UID_COOKIE_SAMESITE,
                secure=UID_COOKIE_SECURE,
                httponly=UID_COOKIE_HTTPONLY,
                path='/'
            )
        elif getattr(g, '_active_uid', None):
            # 有效 uid，但客户端 token 无效/缺失，重新签发
            resp.set_cookie(
                UID_COOKIE_NAME, _sign_uid(g._active_uid),
                max_age=UID_COOKIE_MAX_AGE,
                samesite=UID_COOKIE_SAMESITE,
                secure=UID_COOKIE_SECURE,
                httponly=UID_COOKIE_HTTPONLY,
                path='/'
            )
        # 同步更新时间戳
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
    """
    前端每个标签页仅调用一次（刷新不重复）。
    记录字段：uuid(user_identifier)、uid_source、visit_index、is_new_user、
             user_agent_raw、os_name、device_type、screen_w、screen_h、device_pixel_ratio、
             language、is_touch
    注：started_at 由数据库自动填充，这里不插入。
    """
    try:
      _ = get_or_create_user_identifier()
      uid = g._active_uid
      uid_source = getattr(g, '_uid_source', None)

      # 计算该用户第几次访问（简单计数）
      row = fetch_all("SELECT COUNT(*) AS c FROM visit_logs WHERE user_identifier=:u", {'u': uid})
      visit_index = int(row[0]['c']) + 1 if row else 1
      is_new_user = 1 if (visit_index == 1) else 0

      # 客户端上报的可观测字段
      data = request.get_json(force=True, silent=True) or {}
      screen_w = int(data.get('screen_w') or 0) or None
      screen_h = int(data.get('screen_h') or 0) or None
      dpr      = float(data.get('device_pixel_ratio') or 0) or None
      language = (data.get('language') or '').strip() or None
      is_touch = 1 if data.get('is_touch') else 0

      # 服务端可得
      ua_raw = request.headers.get('User-Agent','') or None
      dev = _parse_device_basic(ua_raw or '')

      # 入库：去掉 started_at 列与 :st 参数
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
    """执行查询并返回 list[dict]（无 Pandas 依赖）"""
    with engine.begin() as conn:
        rows = conn.execute(text(sql), params or {})
        return [dict(r._mapping) for r in rows]

def _is_empty_loc_value(v: str | None) -> bool:
    if v is None:
        return False  # None 代表“不筛位置”（等价“全部”），与“空值过滤”不同
    s = str(v).strip()
    return s == '' or s == '无'

def exec_write(sql: str, params: dict = None):
    with engine.begin() as conn:
        conn.execute(text(sql), params or {})

def fan_key_from(info: dict) -> str:
    return f"{int(info['model_id'])}_{int(info['condition_id'])}"

# 数值转换：统一保证 JSON 输出为“真数字”，并按要求取整/四舍五入 1 位小数
def to_int(v):
    try:
        return int(v) if v is not None else None
    except (TypeError, ValueError):
        return None

def to_float1(v):
    """四舍五入到 1 位小数；None/非法返回 None"""
    try:
        f = float(v)
        if f != f or f in (float('inf'), float('-inf')):
            return None
        return round(f, 1)
    except (TypeError, ValueError):
        return None

# ========== 数据访问（DAO）==========
def get_res_locs_by_res_type(res_type: str) -> List[str]:
    rows = fetch_all(
        "SELECT DISTINCT resistance_location_zh FROM general_view WHERE resistance_type_zh=:rt",
        {'rt': res_type}
    )
    return [r['resistance_location_zh'] for r in rows]

def get_top_queries(limit: int = TOP_QUERIES_LIMIT) -> List[dict]:
    sql = """SELECT brand_name_zh, model_name, resistance_type_zh, resistance_location_zh,
                    query_count, size, thickness, max_speed
             FROM total_query_rank_d30
             ORDER BY query_count DESC
             LIMIT :l"""
    return fetch_all(sql, {'l': limit})

def get_top_ratings(limit: int = TOP_QUERIES_LIMIT) -> List[dict]:
    sql = """SELECT brand_name_zh, model_name, resistance_type_zh, resistance_location_zh,
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
        "SELECT brand_name_zh, model_name, resistance_type_zh, resistance_location_zh,",
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

    base.append("GROUP BY brand_name_zh, model_name, resistance_type_zh, resistance_location_zh, size, thickness")
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
    """
    根据四种组合返回唯一 (model_id, condition_id) 及元信息：
      - res_type 为 None 表示不按类型筛选
      - res_loc  为 None 表示不按位置筛选（“全部”）
      - res_loc  为空串或 '无' 表示“仅空值位置”
    """
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
    """
    批量获取曲线点：返回 { "modelId_conditionId": { rpm:[], airflow:[], noise_db:[], info:{...}} }
    要求：
      - 保证 rpm/int、noise_db/float(1)、airflow/float(1) 均为“数字类型”（JSON number）；
      - 允许 rpm 或 noise_db 单侧为空；当 airflow 为空或 rpm、noise_db 同时为空时跳过该点。
    """
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
        # 安全数值转换 + 取整/四舍五入
        rpm_v = to_int(r.get('rpm'))
        airflow_v = to_float1(r.get('airflow'))
        noise_v = to_float1(r.get('noise_db'))

        # 跳过不可绘制点
        if airflow_v is None:
            continue
        if rpm_v is None and noise_v is None:
            continue

        # 统一为“JSON 数字或 null”
        b['rpm'].append(rpm_v)
        b['airflow'].append(airflow_v)
        b['noise_db'].append(noise_v)
    return bucket

# ========== 会话模型（只保存选择的元信息，不保存曲线数组）==========

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
    # 截断
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
    """
    根据已选 keys 批量查库生成前端所需曲线，
    不含颜色；x 轴模式交给前端（仍传当前 session 的默认值，便于首屏）。
    """
    x_axis_type = session.get('x_axis_type', 'rpm')
    sel = get_selected_dict()
    pairs = []
    order_keys = []  # 保持与已选列表顺序一致
    for k, v in sel.items():
        info = v['info']
        pairs.append((info['model_id'], info['condition_id']))
        order_keys.append(k)

    bucket = get_curves_for_pairs(pairs)
    series = []
    for k in order_keys:
        b = bucket.get(k)
        if not b:
            # 数据库无该曲线（被删或过滤），跳过
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
    """
    统一处理四种组合：
      1) res_type == 全部, res_loc == 全部
      2) res_type == 全部, res_loc != 全部
      3) res_type != 全部, res_loc == 全部
      4) res_type != 全部, res_loc != 全部
    返回 dict，可包含 error_message
    """
    start_count = len(get_selected_dict())
    # 汇总唯一 pair
    pairs_info = get_distinct_pairs_for_add(
        brand, model,
        None if res_type == '全部' else res_type,
        None if (not res_loc or res_loc == '全部') else res_loc
    )
    if not pairs_info:
        return {'error_message': '没有匹配的数据组合（可能该型号在该位置/类型下无记录）'}

    # 过滤掉已经存在的
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
    """每分钟更新查询次数缓存（使用现有的数据库连接）"""
    global query_count_cache
    while True:
        try:
            sql = "SELECT COUNT(DISTINCT batch_id) FROM query_logs"
            result = fetch_all(sql)
            query_count_cache = result[0]['COUNT(DISTINCT batch_id)'] if result else 0
        except Exception as e:
            print(f"更新查询次数失败: {e}")
        time.sleep(60)  # 每分钟更新一次

# 启动后台线程
query_count_thread = threading.Thread(target=update_query_count, daemon=True)
query_count_thread.start()


# ========== 路由 ==========
@app.route('/api/query_count')
def get_query_count():
    return jsonify({'count': query_count_cache})


@app.route('/api/theme', methods=['POST'])
def api_theme():
    data = request.get_json(force=True, silent=True) or {}
    session['theme'] = data.get('theme', 'light')
    session.modified = True
    return jsonify({'success': True})

@app.route('/api/update_x_axis', methods=['POST'])
def api_update_x_axis():
    data = request.get_json(force=True) or {}
    t = data.get('type', 'rpm')
    # 仅保存默认值，前端仍可覆盖
    session['x_axis_type'] = 'rpm' if t == 'rpm' else 'noise_db'
    session.modified = True
    return jsonify(assemble_state())

@app.route('/api/top_ratings', methods=['GET'])
def api_top_ratings():
    try:
        return jsonify({'success': True, 'data': get_top_ratings(limit=10)})
    except Exception as e:
        app.logger.exception(e)
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/recent_likes', methods=['GET'])
def api_recent_likes():
    try:
        user_id = get_or_create_user_identifier()
        items = get_user_likes_full(user_id, limit=50)
        return jsonify({'success': True, 'data': items})
    except Exception as e:
        app.logger.exception(e)
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/search_fans', methods=['POST'])
def api_search_fans():
    try:
        data = request.get_json(force=True) or {}
        res_type = (data.get('search_res_type') or '').strip()
        res_loc  = (data.get('search_res_loc') or '').strip()
        size_filter = (data.get('size_filter') or '').strip()
        thickness_min = (data.get('thickness_min') or '').strip()
        thickness_max = (data.get('thickness_max') or '').strip()
        sort_by  = (data.get('sort_by') or 'none').strip()
        sort_value_raw = (data.get('sort_value') or '').strip()

        # 校验：非空载要求位置，空载不强制选择（默认按“空值位置”过滤）
        if not res_type:
            return jsonify({'success': False,'error_message': '请选择风阻类型'})
        if res_type != '空载' and not res_loc:
            return jsonify({'success': False,'error_message': '请选择风阻位置'})

        try:
            tmin = int(thickness_min); tmax = int(thickness_max)
            if tmin < 1 or tmax < 1 or tmin > 99 or tmax > 99 or tmin > tmax:
                return jsonify({'success': False,'error_message':'厚度区间不合法 (1~99 且最小不大于最大)'})
        except ValueError:
            return jsonify({'success': False,'error_message':'厚度必须为整数'})

        sort_value = None
        if sort_by != 'none':
            if not sort_value_raw:
                return jsonify({'success': False,'error_message':'请输入限制值'})
            try:
                sort_value = float(sort_value_raw)
            except ValueError:
                return jsonify({'success': False,'error_message':'限制值必须是数字'})

        # 空载：按“空值位置”过滤；其它类型沿用传入值
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
    rows = get_res_locs_by_res_type(res_type)  # 可能包含 None/''

    out = []
    has_empty = False
    for v in rows:
        s = '' if v is None else str(v).strip()
        if s == '':
            has_empty = True
        else:
            out.append(s)
    if res_type == '空载' or has_empty:
        out.insert(0, '无')  # 把空值暴露为“无”
    return jsonify(out)

@app.route('/api/add_fan', methods=['POST'])
def api_add_fan():
    try:
        data = request.get_json(force=True) or {}
        brand    = (data.get('brand') or '').strip()
        model    = (data.get('model') or '').strip()
        res_type = (data.get('res_type') or '').strip()
        # 注意：这里不要用 or '' 再次覆盖，保持前端传来的空串以便空值筛选
        res_loc_raw  = data.get('res_loc')
        res_loc = '' if res_loc_raw is None else str(res_loc_raw).strip()

        if not brand or not model:
            return jsonify(assemble_state({'error_message': '缺少品牌或型号'}))
        if not res_type:
            return jsonify(assemble_state({'error_message': '请选择风阻类型（或选择 全部）'}))

        # 传参时：
        # - res_type == '全部' -> None（不筛类型）
        # - res_loc == '全部'  -> None（不筛位置）
        # - res_loc 为空串    -> 仅空值位置
        res_type_filter = None if res_type == '全部' else res_type
        res_loc_filter  = None if res_loc == '全部' else res_loc

        result = handle_add_logic_inputs_ready(brand, model, res_type_filter, res_loc_filter)
        success = not bool(result.get('error_message'))
        return jsonify(assemble_state({**result, 'success': success}))
    except Exception as e:
        app.logger.exception(e)
        return jsonify(assemble_state({'error_message': f'后端未捕获异常: {e}', 'success': False}))
    
# 12.1) 拆出一个包装，避免改动原签名到处连锁
def handle_add_logic_inputs_ready(brand: str, model: str,
                                  res_type_filter: str | None,
                                  res_loc_filter: str | None) -> dict:
    start_count = len(get_selected_dict())
    pairs_info = get_distinct_pairs_for_add(brand, model, res_type_filter, res_loc_filter)
    if not pairs_info:
        return {'error_message': '没有匹配的数据组合（可能该型号在该位置/类型下无记录）'}

    # 过滤掉已经存在的
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

@app.route('/api/remove_fan', methods=['POST'])
def api_remove_fan():
    data = request.get_json(force=True) or {}
    fk = data.get('fan_key')
    if not fk:
        return jsonify(assemble_state({'error_message': '缺少 fan_key'}))
    if not remove_fan_from_session(fk):
        return jsonify(assemble_state({'error_message': '风扇不存在'}))
    return jsonify(assemble_state())

@app.route('/api/restore_fan', methods=['POST'])
def api_restore_fan():
    data = request.get_json(force=True) or {}
    fk = data.get('fan_key')
    if not fk:
        return jsonify(assemble_state({'error_message': '缺少 fan_key'}))
    rem = session.get('recently_removed_fans', {})
    if fk not in rem:
        return jsonify(assemble_state({'error_message': '该项不在最近移除列表'}))
    current_count = len(get_selected_dict())
    if current_count >= MAX_CHART_ITEMS:
        return jsonify(assemble_state({'error_message': f'已达到最大显示限制({MAX_CHART_ITEMS})'}))

    info = rem[fk]['info']
    if is_duplicate_in_session(info):
        remove_fan_from_recently_removed(fk)
        return jsonify(assemble_state({'error_message': '该数据已在图表中'}))

    add_fan_to_session(info)
    remove_fan_from_recently_removed(fk)
    log_query(info)
    return jsonify(assemble_state())

@app.route('/api/clear_all', methods=['POST'])
def api_clear_all():
    sel = get_selected_dict()
    # 将当前所选加入最近移除（只存 info）
    for k, v in list(sel.items()):
        add_to_recently_removed(v['info'])
    session.pop('selected_fans', None)
    session.modified = True
    return jsonify(assemble_state())

@app.route('/api/state')
def api_state():
    return jsonify(assemble_state())

@app.route('/search_models/<query>')
def search_models(query):
    sql = "SELECT DISTINCT brand_name_zh, model_name FROM general_view WHERE model_name LIKE :q LIMIT 20"
    rows = fetch_all(sql, {'q': f"%{query}%"})
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
        sql = """INSERT INTO rate_logs (user_identifier, model_id, condition_id, is_valid)
                 VALUES (:u,:m,:c,1)
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
                 WHERE user_identifier=:u AND model_id=:m AND condition_id=:c"""
        exec_write(sql, {'u': user_id, 'm': model_id, 'c': condition_id})
        return jsonify({'success': True, 'like_keys': get_user_like_keys(user_id)})
    except Exception as e:
        app.logger.exception(e)
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/config')
def api_config():
    return jsonify({'success': True, 'click_cooldown_ms': CLICK_COOLDOWN_SECONDS * 1000})

@app.route('/')
def index():
    # 基础数据
    brands_rows = fetch_all("SELECT DISTINCT brand_name_zh FROM fan_brand")
    brands = [r['brand_name_zh'] for r in brands_rows]
    all_res_types = get_all_resistance_types()
    all_res_locs  = get_all_resistance_locations()
    top_queries = get_top_queries(limit=10)
    top_ratings = get_top_ratings(limit=10)

    # 左侧搜索条件 URL 显示（保持原行为）
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

    # GET 直达查询（与原来一致，仅用于首屏右侧表格）
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
                           url_thickness_max=url_thickness_max, colors=COLORS_DEFAULT,
                           click_cooldown_ms=CLICK_COOLDOWN_SECONDS * 1000)

@app.route('/clear_session')
def clear_session():
    # 清空时也仅存 info 到最近移除
    sel = get_selected_dict()
    for k, v in list(sel.items()):
        add_to_recently_removed(v['info'])
    session.pop('selected_fans', None)
    session.modified = True
    return redirect(url_for('index'))

if __name__ == '__main__':
    # 生产不要启用 debug
    app.logger.setLevel(logging.INFO)
    app.run(host='0.0.0.0', port=5001, debug=False, use_reloader=False)