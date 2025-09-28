import os
from datetime import timedelta

class Config:
    # Flask 基础
    SECRET_KEY = os.getenv("APP_SECRET", "replace-me-in-prod")
    PERMANENT_SESSION_LIFETIME = timedelta(days=30)
    SESSION_COOKIE_SECURE   = os.getenv('SESSION_COOKIE_SECURE', '0') == '1'
    SESSION_COOKIE_HTTPONLY = os.getenv('SESSION_COOKIE_HTTPONLY', '1') == '1'
    SESSION_COOKIE_SAMESITE = os.getenv('SESSION_COOKIE_SAMESITE', 'Lax')
    SESSION_COOKIE_PATH = '/'

    # DB
    FANDB_DSN = os.getenv(
        'FANDB_DSN',
        'mysql+pymysql://localreader:12345678@127.0.0.1/FANDB?charset=utf8mb4'
    )

    # 业务常量
    MAX_CHART_ITEMS = 8
    MAX_RECENTLY_REMOVED = 20
    TOP_QUERIES_LIMIT = 10
    CLICK_COOLDOWN_SECONDS = float(os.getenv('CLICK_COOLDOWN_SECONDS', '0.1'))
    SIZE_OPTIONS = ["不限", "120", "140"]
    COLORS_DEFAULT = [
        "#1f77b4","#ff7f0e","#2ca02c","#d62728","#9467bd",
        "#8c564b","#e377c2","#7f7f7f","#bcbd22","#17becf"
    ]

    # UID Cookie
    UID_COOKIE_NAME = os.getenv('UID_COOKIE_NAME', 'fc_uid')
    UID_COOKIE_MAX_AGE = int(os.getenv('UID_COOKIE_MAX_AGE_SECONDS', str(60*60*24*365*2)))
    UID_COOKIE_SAMESITE = os.getenv('UID_COOKIE_SAMESITE', 'Lax')
    UID_COOKIE_SECURE = os.getenv('UID_COOKIE_SECURE', '0') == '1'
    UID_COOKIE_HTTPONLY = os.getenv('UID_COOKIE_HTTPONLY', '0') == '1'
    UID_COOKIE_REFRESH_INTERVAL = int(os.getenv('UID_COOKIE_REFRESH_INTERVAL_SECONDS', str(60*60*24*7)))
    UID_COOKIE_REFRESH_TS_NAME = os.getenv('UID_COOKIE_REFRESH_TS_NAME', 'fc_uid_refreshed_at')

    # 分享链接
    SHARE_TOKEN_VERSION = 2
    SHARE_TOKEN_EXPIRE_SECONDS = int(os.getenv('SHARE_TOKEN_EXPIRE_SECONDS', str(60*60*24*90)))  # 默认 90 天
    SHARE_TOKEN_SIG_PREFIX = "share"

    # Query Count 缓存刷新周期
    QUERY_COUNT_CACHE_REFRESH_SECONDS = 60

    # 模板自动刷新（开发模式）
    TEMPLATES_AUTO_RELOAD = True
    SEND_FILE_MAX_AGE_DEFAULT = 0

class ProductionConfig(Config):
    TEMPLATES_AUTO_RELOAD = False
    SEND_FILE_MAX_AGE_DEFAULT = 3600

class DevelopmentConfig(Config):
    DEBUG = True

def get_config():
    env = os.getenv("APP_ENV", "dev").lower()
    if env.startswith('prod'):
        return ProductionConfig
    return DevelopmentConfig