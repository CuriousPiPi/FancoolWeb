"""
新版分享令牌：
结构： base64url( JSON({"v":version,"iat":ts,"exp":ts+ttl,"data":{...}}) ).sig16
签名: HMAC_SHA256( secret_key, prefix + '.' + body )
改进:
- 包含到期时间 exp
- 明确版本 v
- iat 签发时间
"""
import json, base64, hmac, hashlib, time
from flask import current_app

def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')

def _b64url_decode(s: str) -> bytes:
    pad = '=' * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)

def sign_share(payload: dict) -> str:
    cfg = current_app.config
    now = int(time.time())
    body_obj = {
        "v": cfg["SHARE_TOKEN_VERSION"],
        "iat": now,
        "exp": now + cfg["SHARE_TOKEN_EXPIRE_SECONDS"],
        "data": payload
    }
    body_bytes = json.dumps(body_obj, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    body_b64 = _b64url(body_bytes)
    key = current_app.secret_key.encode('utf-8') if not isinstance(current_app.secret_key,(bytes,bytearray)) else current_app.secret_key
    prefix = cfg['SHARE_TOKEN_SIG_PREFIX']
    sig = hmac.new(key, f"{prefix}.{body_b64}".encode('utf-8'), hashlib.sha256).hexdigest()[:16]
    return f"{body_b64}.{sig}"

def verify_share(token: str) -> dict | None:
    if not token or '.' not in token:
        return None
    body_b64, sig = token.split('.', 1)
    cfg = current_app.config
    key = current_app.secret_key.encode('utf-8') if not isinstance(current_app.secret_key,(bytes,bytearray)) else current_app.secret_key
    prefix = cfg['SHARE_TOKEN_SIG_PREFIX']
    expect = hmac.new(key, f"{prefix}.{body_b64}".encode('utf-8'), hashlib.sha256).hexdigest()[:16]
    if not hmac.compare_digest(sig, expect):
        return None
    try:
        data = json.loads(_b64url_decode(body_b64))
    except Exception:
        return None
    if data.get('v') != cfg['SHARE_TOKEN_VERSION']:
        return None
    now = int(time.time())
    if now >= int(data.get('exp', 0)):
        return None
    return data  # 包含 v / iat / exp / data