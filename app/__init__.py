from flask import Flask, request
from werkzeug.middleware.proxy_fix import ProxyFix
from .config import get_config
from .extensions import get_engine
from .routes import register_blueprints
from .background.tasks import start_background_tasks
from .security.uid import init_request_uid, ensure_uid_cookie

def create_app():
    app = Flask(__name__)
    app.config.from_object(get_config())

    # Proxy
    app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_for=1)

    # 模板自动刷新
    app.jinja_env.auto_reload = app.config.get('TEMPLATES_AUTO_RELOAD', False)

    # 安全响应头
    @app.after_request
    def add_security_headers(resp):
        try:
            if request.is_secure:
                resp.headers.setdefault(
                    'Strict-Transport-Security',
                    'max-age=31536000; includeSubDomains; preload'
                )
            resp.headers['X-Frame-Options'] = 'SAMEORIGIN'
            resp.headers.setdefault('X-Content-Type-Options','nosniff')
            resp.headers.setdefault('Referrer-Policy','strict-origin-when-cross-origin')
        except Exception:
            pass
        return resp

    # UID 生命周期
    @app.before_request
    def _uid_before():
        init_request_uid()

    @app.after_request
    def _uid_after(resp):
        return ensure_uid_cookie(resp)

    register_blueprints(app)
    start_background_tasks(app)

    return app