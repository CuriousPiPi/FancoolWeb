import os
import time
import hmac
import hashlib
from datetime import datetime, timedelta
from flask import Flask, request, jsonify, make_response, session, render_template, g, redirect
from sqlalchemy import create_engine, text
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import check_password_hash
from admin_data import data_mgmt_bp
from admin_calib import calib_admin_bp

# =========================
# Config
# =========================
app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_for=1)
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=30)
app.secret_key = os.getenv('APP_SECRET', 'replace-me-in-prod')  # 与前台保持一致的 secret
app.register_blueprint(data_mgmt_bp)
app.logger.setLevel('INFO')

# 调整：支持环境变量控制日志级别（默认 INFO）
_log_level = os.getenv('ADMIN_LOG_LEVEL', 'INFO').upper()
try:
    import logging
    app.logger.setLevel(getattr(logging, _log_level, logging.INFO))
except Exception:
    app.logger.setLevel('INFO')

app.register_blueprint(calib_admin_bp)

# 新增：启动时打印路由表和日志级别
def _dump_routes(_app: Flask):
    try:
        lines = []
        for rule in sorted(_app.url_map.iter_rules(), key=lambda r: r.rule):
            methods = ','.join(sorted([m for m in rule.methods if m not in ('HEAD','OPTIONS')]))
            lines.append(f"{methods:10s} {rule.rule}  -> {rule.endpoint}")
        _app.logger.info("Registered routes:\n" + "\n".join(lines))
        _app.logger.info(f"Admin logger level: {_log_level}")
    except Exception:
        pass

_dump_routes(app)

app.config['TEMPLATES_AUTO_RELOAD'] = True
#app.jinja_env.auto_reload = True

# 将后台会话与前台隔离（独立 Cookie 名称与 Path）
app.config['SESSION_COOKIE_NAME'] = os.getenv('ADMIN_SESSION_COOKIE_NAME', 'fc_admin_sess')
app.config['SESSION_COOKIE_SAMESITE'] = os.getenv('ADMIN_SESSION_COOKIE_SAMESITE', 'Lax')
app.config['SESSION_COOKIE_SECURE'] = os.getenv('ADMIN_SESSION_COOKIE_SECURE', '0') == '1'
app.config['SESSION_COOKIE_HTTPONLY'] = os.getenv('ADMIN_SESSION_COOKIE_HTTPONLY', '1') == '1'
app.config['SESSION_COOKIE_PATH'] = '/admin'

# Cookie 参数（尽量与前台保持一致，名称从环境变量继承）
UID_COOKIE_NAME = os.getenv('UID_COOKIE_NAME', 'fc_uid')
UID_COOKIE_MAX_AGE = int(os.getenv('UID_COOKIE_MAX_AGE_SECONDS', str(60 * 60 * 24 * 365 * 2)))
UID_COOKIE_SAMESITE = os.getenv('UID_COOKIE_SAMESITE', 'Lax')
UID_COOKIE_SECURE = os.getenv('UID_COOKIE_SECURE', '0') == '1'
UID_COOKIE_HTTPONLY = os.getenv('UID_COOKIE_HTTPONLY', '0') == '1'
UID_COOKIE_REFRESH_INTERVAL = int(os.getenv('UID_COOKIE_REFRESH_INTERVAL_SECONDS', str(60 * 60 * 24 * 7)))
UID_COOKIE_REFRESH_TS_NAME = os.getenv('UID_COOKIE_REFRESH_TS_NAME', 'fc_uid_refreshed_at')

# 独立数据库账号（最小权限），仅需读写 admin 相关表
ADMIN_DB_DSN = os.getenv(
    'ADMIN_DB_DSN',
    'mysql+pymysql://fancool_admin:12345678@127.0.0.1/FANDB?charset=utf8mb4'
)
engine = create_engine(ADMIN_DB_DSN, pool_pre_ping=True, pool_recycle=1800, future=True, echo=False)
app.config['ADMIN_ENGINE'] = engine

# 登录/锁定/限流参数
LOGIN_MAX_ATTEMPTS = int(os.getenv('LOGIN_MAX_ATTEMPTS', '5'))
LOGIN_LOCK_MINUTES = int(os.getenv('LOGIN_LOCK_MINUTES', '15'))
RATE_LIMIT_WINDOW_SEC = int(os.getenv('LOGIN_RATE_LIMIT_WINDOW_SEC', '60'))
RATE_LIMIT_MAX_ATTEMPTS = int(os.getenv('LOGIN_RATE_LIMIT_MAX_ATTEMPTS', '10'))

# 空闲超时：10 分钟无任何请求则登出
IDLE_TIMEOUT_SECONDS = int(os.getenv('ADMIN_IDLE_TIMEOUT_SECONDS', '600'))

# =========================
# 安全响应头
# =========================
@app.after_request
def add_security_headers(resp):
    try:
        if request.is_secure:
            resp.headers.setdefault('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload')
        resp.headers.setdefault('X-Frame-Options', 'SAMEORIGIN')
        resp.headers.setdefault('X-Content-Type-Options', 'nosniff')
        resp.headers.setdefault('Referrer-Policy', 'strict-origin-when-cross-origin')
        # dev 环境可按需添加 CSP（生产建议开启严格 CSP）
    except Exception:
        pass
    return resp

# =========================
# 小工具
# =========================
def fetch_all(sql: str, params: dict = None):
    with engine.begin() as conn:
        rows = conn.execute(text(sql), params or {})
        return [dict(r._mapping) for r in rows]

def exec_write(sql: str, params: dict = None):
    with engine.begin() as conn:
        conn.execute(text(sql), params or {})

def resp_ok(data=None, message=None, meta=None, http_status=200):
    payload = {'success': True, 'data': data, 'message': message, 'meta': meta or {}}
    return make_response(jsonify(payload), http_status)

def resp_err(code: str, msg: str, http_status=400, meta=None):
    payload = {'success': False, 'error_code': code, 'error_message': msg, 'data': None, 'meta': meta or {}}
    return make_response(jsonify(payload), http_status)

# 与前台一致的签名/验签（可将截断长度提高到 32 hex 后逐步迁移；此处沿用 16 兼容）
def _sign_uid(value: str) -> str:
    key = app.secret_key.encode() if not isinstance(app.secret_key, (bytes, bytearray)) else app.secret_key
    sig = hmac.new(key, value.encode('utf-8'), hashlib.sha256).hexdigest()[:16]
    return f"{value}.{sig}"

def _unsign_uid(token: str) -> str | None:
    if not token: return None
    parts = token.split('.', 1)
    if len(parts) != 2: return None
    raw, sig = parts
    expect = _sign_uid(raw).split('.', 1)[1]
    if hmac.compare_digest(sig, expect): return raw
    return None

@app.before_request
def _init_g():
    if not hasattr(g, '_active_uid'):
        g._active_uid = None

def get_or_create_user_identifier():
    # 与前台逻辑对齐：不存在就生成一个 uid 并设置 cookie
    token = request.cookies.get(UID_COOKIE_NAME)
    uid = _unsign_uid(token) if token else None
    if not uid:
        # 生成一个新的 uid（可直接用 session sid 或 uuid4）
        import uuid
        uid = str(uuid.uuid4())
        # 设置 cookie
        g._set_uid_cookie = _sign_uid(uid)
        g._set_uid_refresh_now = True
    session['user_identifier'] = uid
    session.permanent = True
    g._active_uid = uid
    return uid

@app.after_request
def ensure_uid_cookie(resp):
    # 刷新/设置 fc_uid & 刷新时间戳
    token_to_set = getattr(g, '_set_uid_cookie', None)
    now = int(time.time())
    if token_to_set:
        resp.set_cookie(UID_COOKIE_NAME, token_to_set, max_age=UID_COOKIE_MAX_AGE,
                        samesite=UID_COOKIE_SAMESITE, secure=UID_COOKIE_SECURE,
                        httponly=UID_COOKIE_HTTPONLY, path='/')
        if getattr(g, '_set_uid_refresh_now', False):
            resp.set_cookie(UID_COOKIE_REFRESH_TS_NAME, str(now), max_age=UID_COOKIE_MAX_AGE,
                            samesite=UID_COOKIE_SAMESITE, secure=UID_COOKIE_SECURE,
                            httponly=UID_COOKIE_HTTPONLY, path='/')
        return resp

    last_ts_raw = request.cookies.get(UID_COOKIE_REFRESH_TS_NAME)
    try: last_ts = int(last_ts_raw or '0')
    except ValueError: last_ts = 0
    if now - last_ts >= UID_COOKIE_REFRESH_INTERVAL:
        token = request.cookies.get(UID_COOKIE_NAME)
        uid = _unsign_uid(token) if token else None
        if uid:
            resp.set_cookie(UID_COOKIE_NAME, token, max_age=UID_COOKIE_MAX_AGE,
                            samesite=UID_COOKIE_SAMESITE, secure=UID_COOKIE_SECURE,
                            httponly=UID_COOKIE_HTTPONLY, path='/')
        elif getattr(g, '_active_uid', None):
            resp.set_cookie(UID_COOKIE_NAME, _sign_uid(g._active_uid), max_age=UID_COOKIE_MAX_AGE,
                            samesite=UID_COOKIE_SAMESITE, secure=UID_COOKIE_SECURE,
                            httponly=UID_COOKIE_HTTPONLY, path='/')
        resp.set_cookie(UID_COOKIE_REFRESH_TS_NAME, str(now), max_age=UID_COOKIE_MAX_AGE,
                        samesite=UID_COOKIE_SAMESITE, secure=UID_COOKIE_SECURE,
                        httponly=UID_COOKIE_HTTPONLY, path='/')
    return resp

@app.get('/admin')
def admin_root_redirect():
    return redirect('/admin/login', code=302)

@app.get('/admin/')
def admin_root_redirect2():
    return redirect('/admin/login', code=302)

# =========================
# 设备白名单与绑定
# =========================
WHITELIST_CACHE_TTL = 10  # 秒，开发环境短缓存即可
_whitelist_cache = {}

def _fetch_whitelist(uid: str) -> dict | None:
    """获取白名单行，含 admin_user_id 绑定信息"""
    now = time.time()
    c = _whitelist_cache.get(('row', uid))
    if c and now - c['ts'] < WHITELIST_CACHE_TTL:
        return c['row']
    rows = fetch_all("""
        SELECT id, user_identifier, is_active, allow_until, admin_user_id
        FROM admin_device_whitelist
        WHERE user_identifier=:u
        LIMIT 1
    """, {'u': uid})
    row = rows[0] if rows else None
    _whitelist_cache[('row', uid)] = {'ts': now, 'row': row}
    return row

def _check_in_whitelist(uid: str) -> bool:
    row = _fetch_whitelist(uid)
    if not row: 
        return False
    if int(row.get('is_active') or 0) != 1:
        return False
    allow_until = row.get('allow_until')
    if allow_until:
        try:
            if isinstance(allow_until, str):
                allow_until_dt = datetime.strptime(allow_until, '%Y-%m-%d %H:%M:%S')
            else:
                allow_until_dt = allow_until
            if datetime.now() > allow_until_dt:
                return False
        except Exception:
            pass
    return True

def _bind_device_to_admin(uid: str, admin_id: int) -> bool:
    """将设备绑定到 admin；若已绑定他人则返回 False；若未绑定则绑定并返回 True"""
    row = _fetch_whitelist(uid)
    if not row or int(row.get('is_active') or 0) != 1:
        return False
    bound = row.get('admin_user_id')
    if bound is None:
        try:
            exec_write("""
                UPDATE admin_device_whitelist
                SET admin_user_id=:aid, updated_at=NOW()
                WHERE user_identifier=:u AND admin_user_id IS NULL
            """, {'aid': admin_id, 'u': uid})
            # 清缓存
            _whitelist_cache.pop(('row', uid), None)
            return True
        except Exception:
            return False
    try:
        if int(bound) == int(admin_id):
            return True
    except Exception:
        pass
    return False  # 已绑定不同 admin

@app.before_request
def device_gate():
    # 放行静态资源与基础页面/API（登录页、健康检查等）
    path = request.path or ''
    bypass_prefix = (
        '/admin/unauthorized', '/admin/device-id', '/admin/api/health',
        '/admin/api/login', '/admin/api/me', '/admin/api/logout',
        '/favicon.ico', '/static/'
    )
    if any(path.startswith(p) for p in bypass_prefix):
        return None

    # 仅对 /admin 与 /admin/api 开头的路由做设备预检
    if not (path.startswith('/admin') or path.startswith('/admin/api')):
        return None

    uid = get_or_create_user_identifier()
    if not _check_in_whitelist(uid):
        # 未授权：返回 403，并显示当前设备的 user_identifier，便于人工入白名单
        return render_template('unauthorized.html', user_identifier=uid), 403

    # 若已登录，则验证绑定；首次登录后可在 login 成功时自动绑定，这里兜底校验
    if session.get('is_admin'):
        aid = int(session.get('admin_id') or 0)
        if aid > 0:
            if not _bind_device_to_admin(uid, aid):
                # 已绑定给其他管理员
                return resp_err('DEVICE_BOUND_CONFLICT', '该设备已绑定到其他管理员，请联系管理员处理', 403)
    return None

# =========================
# 空闲超时（30分钟无请求踢出登录）
# =========================
@app.before_request
def enforce_admin_idle_timeout():
    path = request.path or ''
    # 仅对 /admin* 生效；但放行登录/健康等免干扰
    bypass_prefix = (
        '/admin/unauthorized', '/admin/device-id', '/admin/api/health',
        '/admin/api/login', '/favicon.ico', '/static/'
    )
    if not path.startswith('/admin'):
        return None
    if any(path.startswith(p) for p in bypass_prefix):
        return None

    now = int(time.time())
    last = session.get('admin_last_seen')
    if session.get('is_admin'):
        if last and (now - int(last) > IDLE_TIMEOUT_SECONDS):
            # 超时，清理会话
            _clear_admin_session()
            # 对 API 返回 401；对页面重定向到登录
            if path.startswith('/admin/api/'):
                return resp_err('SESSION_TIMEOUT', '登录已超时，请重新登录', 401)
            return redirect('/admin/login', code=302)
        # 刷新活跃时间
        session['admin_last_seen'] = now
    return None

def _clear_admin_session():
    session.pop('is_admin', None)
    session.pop('admin_id', None)
    session.pop('admin_login_name', None)
    session.pop('admin_last_seen', None)

# =========================
# 登录会话与限流/锁定
# =========================
# 简易内存限流（开发环境足够；生产应换为 Redis）
_rate_bucket = {}  # key -> [count, window_start_ts]

def _rate_limit(key: str, window_sec: int, max_attempts: int) -> bool:
    now = int(time.time())
    c, ts = _rate_bucket.get(key, (0, now))
    if now - ts >= window_sec:
        c, ts = 0, now
    c += 1
    _rate_bucket[key] = (c, ts)
    return c <= max_attempts

def _lock_until_str(minutes: int) -> str:
    return (datetime.utcnow() + timedelta(minutes=minutes)).strftime('%Y-%m-%d %H:%M:%S')

def _is_locked(row: dict) -> tuple[bool, int]:
    lu = row.get('locked_until')
    if not lu:
        return (False, 0)
    # 统一按 UTC 判断（假设 DB 使用本地时间也问题不大，仅用于提示）
    try:
        # MySQL 返回 datetime 或 str，这里做兼容
        if isinstance(lu, str):
            # 允许 'YYYY-MM-DD HH:MM:SS' 字符串
            lt = datetime.strptime(lu, '%Y-%m-%d %H:%M:%S')
        else:
            lt = lu
        now = datetime.utcnow()
        if now < lt:
            left = int((lt - now).total_seconds() // 60) + 1
            return (True, max(left, 1))
    except Exception:
        pass
    return (False, 0)

# =========================
# 基础路由（设备通过后才可见）
# =========================
@app.context_processor
def inject_admin_vars():
    return {
        # 从会话中注入 admin_user.login_name（登录成功时已写入 session['admin_login_name']）
        'admin_name': session.get('admin_login_name') or '管理员'
    }

@app.get('/admin/device-id')
def page_device_id():
    # 任何设备都可查看自己 uid，便于登记白名单
    uid = get_or_create_user_identifier()
    return render_template('device_id.html', user_identifier=uid)

@app.get('/admin/login')
def page_login():
    if session.get('is_admin'):
        return redirect('/admin/data', code=302)
    return render_template('login.html')

@app.post('/admin/api/login')
def api_login():
    data = request.get_json(force=True, silent=True) or {}
    login = (data.get('login') or '').strip()
    password = data.get('password') or ''

    # 基本参数校验
    if not login or not password:
        return resp_err('LOGIN_MISSING', '请输入用户名和密码')

    # 简易限流（按 IP+账号）
    rl_key = f"login:{request.remote_addr}:{login}"
    if not _rate_limit(rl_key, RATE_LIMIT_WINDOW_SEC, RATE_LIMIT_MAX_ATTEMPTS):
        return resp_err('TOO_MANY_REQUESTS', '尝试过于频繁，请稍后再试', 429)

    # 查询用户
    rows = fetch_all("""
        SELECT id, login_name, password_hash, is_active, failed_attempts, locked_until
        FROM admin_user
        WHERE login_name=:ln
        LIMIT 1
    """, {'ln': login})
    if not rows:
        # 模拟耗时，防止用户名枚举（可选）
        time.sleep(0.2)
        return resp_err('LOGIN_INVALID', '用户名或密码不正确')

    u = rows[0]
    if int(u.get('is_active') or 0) != 1:
        return resp_err('LOGIN_INVALID', '用户名或密码不正确')

    locked, left_min = _is_locked(u)
    if locked:
        return resp_err('ACCOUNT_LOCKED', f'账户被临时锁定，请 {left_min} 分钟后再试', 423)

    # 校验密码
    ok = False
    try:
        ok = check_password_hash(u['password_hash'], password)
    except Exception:
        pass

    if ok:
        # 重置失败计数，记录登录时间
        exec_write("""
            UPDATE admin_user
            SET failed_attempts=0, locked_until=NULL, last_login_at=NOW()
            WHERE id=:id
        """, {'id': u['id']})
        session['is_admin'] = True
        session['admin_id'] = int(u['id'])
        session['admin_login_name'] = u['login_name']
        session['admin_last_seen'] = int(time.time())

        # 首次登录自动绑定设备（如未绑定）；若设备已绑定他人则返回错误
        uid = g._active_uid or get_or_create_user_identifier()
        if not _bind_device_to_admin(uid, int(u['id'])):
            return resp_err('DEVICE_BOUND_CONFLICT', '该设备已绑定到其他管理员，请联系管理员处理', 403)

        # 告知前端跳转位置
        return resp_ok({'login_name': u['login_name'], 'redirect_to': '/admin/data'}, message='登录成功')
    else:
        # 增加失败次数，必要时锁定
        rows2 = fetch_all("SELECT failed_attempts FROM admin_user WHERE id=:id", {'id': u['id']})
        curr = int(rows2[0]['failed_attempts']) + 1 if rows2 else 1
        if curr >= LOGIN_MAX_ATTEMPTS:
            exec_write("""
                UPDATE admin_user
                SET failed_attempts=0, locked_until=:lu
                WHERE id=:id
            """, {'id': u['id'], 'lu': _lock_until_str(LOGIN_LOCK_MINUTES)})
            return resp_err('ACCOUNT_LOCKED', f'因多次失败，账户已锁定 {LOGIN_LOCK_MINUTES} 分钟', 423)
        else:
            exec_write("""
                UPDATE admin_user
                SET failed_attempts=:fa
                WHERE id=:id
            """, {'id': u['id'], 'fa': curr})
            return resp_err('LOGIN_INVALID', '用户名或密码不正确')

@app.post('/admin/api/logout')
def api_logout():
    _clear_admin_session()
    return resp_ok(message='已退出登录')

@app.get('/admin/api/me')
def api_me():
    return resp_ok({
        'is_admin': bool(session.get('is_admin')),
        'login_name': session.get('admin_login_name')
    })

@app.get('/admin/api/health')
def api_health():
    return resp_ok({'status': 'ok'})

# =========================
# Entrypoint（开发环境）
# =========================
if __name__ == '__main__':
    # 仅用于开发调试；生产请用 gunicorn + Nginx，并将 ADMIN_SESSION_COOKIE_* 设置为安全值
    port = int(os.getenv('ADMIN_PORT', '6001'))
    app.run(host='0.0.0.0', port=port, debug=True, use_reloader=False)