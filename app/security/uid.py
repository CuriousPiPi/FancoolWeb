import hmac, hashlib, time, uuid
from flask import current_app, request, g, session

def _sign_uid_raw(value: str) -> str:
    key = current_app.secret_key.encode('utf-8') if not isinstance(current_app.secret_key,(bytes,bytearray)) else current_app.secret_key
    sig = hmac.new(key, value.encode('utf-8'), hashlib.sha256).hexdigest()[:16]
    return f"{value}.{sig}"

def _unsign_uid_raw(token: str) -> str | None:
    if not token or '.' not in token:
        return None
    raw, sig = token.split('.',1)
    expect = _sign_uid_raw(raw).split('.',1)[1]
    if hmac.compare_digest(sig, expect):
        return raw
    return None

def init_request_uid():
    """在 before_request 调用。"""
    if not hasattr(g, '_uid_source'):
        g._uid_source = None
    cookie_name = current_app.config['UID_COOKIE_NAME']
    token = request.cookies.get(cookie_name)
    uid = _unsign_uid_raw(token) if token else None
    if uid:
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
    session['user_identifier'] = uid
    session.permanent = True

    # 若无 cookie, 标记需要设置
    if not token:
        g._set_uid_cookie = _sign_uid_raw(uid)
        g._set_uid_refresh_now = True

def ensure_uid_cookie(resp):
    cfg = current_app.config
    cookie_name = cfg['UID_COOKIE_NAME']
    refresh_cookie = cfg['UID_COOKIE_REFRESH_TS_NAME']
    max_age = cfg['UID_COOKIE_MAX_AGE']
    now = int(time.time())

    token_to_set = getattr(g, '_set_uid_cookie', None)
    if token_to_set:
        resp.set_cookie(cookie_name, token_to_set,
                        max_age=max_age,
                        path='/', samesite=cfg['UID_COOKIE_SAMESITE'],
                        secure=cfg['UID_COOKIE_SECURE'],
                        httponly=cfg['UID_COOKIE_HTTPONLY'])
        if getattr(g, '_set_uid_refresh_now', False):
            resp.set_cookie(refresh_cookie, str(now),
                            max_age=max_age, path='/',
                            samesite=cfg['UID_COOKIE_SAMESITE'],
                            secure=cfg['UID_COOKIE_SECURE'],
                            httponly=cfg['UID_COOKIE_HTTPONLY'])
        return resp

    last_ts_raw = request.cookies.get(refresh_cookie)
    try:
        last_ts = int(last_ts_raw or '0')
    except ValueError:
        last_ts = 0

    if now - last_ts >= cfg['UID_COOKIE_REFRESH_INTERVAL']:
        existing_token = request.cookies.get(cookie_name)
        uid = _unsign_uid_raw(existing_token) if existing_token else None
        if uid:
            # 刷新有效期
            resp.set_cookie(cookie_name, existing_token,
                            max_age=max_age, path='/',
                            samesite=cfg['UID_COOKIE_SAMESITE'],
                            secure=cfg['UID_COOKIE_SECURE'],
                            httponly=cfg['UID_COOKIE_HTTPONLY'])
        elif getattr(g, '_active_uid', None):
            resp.set_cookie(cookie_name, _sign_uid_raw(g._active_uid),
                            max_age=max_age, path='/',
                            samesite=cfg['UID_COOKIE_SAMESITE'],
                            secure=cfg['UID_COOKIE_SECURE'],
                            httponly=cfg['UID_COOKIE_HTTPONLY'])
        resp.set_cookie(refresh_cookie, str(now),
                        max_age=max_age, path='/',
                        samesite=cfg['UID_COOKIE_SAMESITE'],
                        secure=cfg['UID_COOKIE_SECURE'],
                        httponly=cfg['UID_COOKIE_HTTPONLY'])
    return resp

def current_user_identifier() -> str:
    return getattr(g, '_active_uid', None) or session.get('user_identifier') or ''