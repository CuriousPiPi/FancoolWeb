"""
Unified short-signature helper with namespaced context.

Usage:
  token = sign_text('uid', 'plain-user-id')
  plain = verify_text('uid', token)

  share_token = sign_struct('share', {'f': [...], 'x': 'rpm'}, version=1)
  ok, data_or_err = verify_struct('share', share_token)
"""
from __future__ import annotations
import hmac, hashlib, json, base64
from typing import Tuple
from flask import current_app as app


def _secret_bytes(secret) -> bytes:
    return secret.encode('utf-8') if not isinstance(secret, (bytes, bytearray)) else secret


def _short_sig(raw: bytes, key: bytes, ctx: str) -> str:
    # ctx 参与 HMAC，隔离不同业务 token 的命名空间
    return hmac.new(key, ctx.encode('utf-8') + b':' + raw, hashlib.sha256).hexdigest()[:16]


# ----------------- Plain text -----------------
def sign_text(ctx: str, plain: str, secret=None) -> str:
    key = _secret_bytes(secret or app.secret_key)
    raw = plain.encode('utf-8')
    sig = _short_sig(raw, key, ctx)
    return f"{plain}.{sig}"


def verify_text(ctx: str, token: str, secret=None) -> str | None:
    if not token or '.' not in token:
        return None
    plain, sig = token.rsplit('.', 1)
    key = _secret_bytes(secret or app.secret_key)
    expect = _short_sig(plain.encode('utf-8'), key, ctx)
    if hmac.compare_digest(sig, expect):
        return plain
    return None


# ----------------- Structured payload -----------------
def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def _b64url_decode(s: str) -> bytes:
    pad = '=' * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def sign_struct(ctx: str, payload: dict, version: int = 1, secret=None) -> str:
    body = json.dumps({'v': version, **payload}, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    b64 = _b64url(body)
    key = _secret_bytes(secret or app.secret_key)
    sig = _short_sig(b64.encode('utf-8'), key, ctx)
    return f"{b64}.{sig}"


def verify_struct(ctx: str, token: str, secret=None) -> Tuple[bool, dict | str]:
    if not token or '.' not in token:
        return False, 'format'
    b64, sig = token.split('.', 1)
    key = _secret_bytes(secret or app.secret_key)
    expect = _short_sig(b64.encode('utf-8'), key, ctx)
    if not hmac.compare_digest(sig, expect):
        return False, 'sig'
    try:
        data = _b64url_decode(b64)
        obj = json.loads(data)
    except Exception:
        return False, 'decode'
    return True, obj
