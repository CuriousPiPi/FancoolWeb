import threading, time
from flask import current_app
from app.repositories.fan_repository import FanRepository

_query_count_cache = 0
_repo = FanRepository()

def get_query_count_cache():
    return _query_count_cache

def _loop():
    global _query_count_cache
    while True:
        try:
            _query_count_cache = _repo.get_query_count_distinct_batch()
        except Exception:
            pass
        try:
            time.sleep(current_app.config['QUERY_COUNT_CACHE_REFRESH_SECONDS'])
        except Exception:
            time.sleep(60)

def start_background_tasks(app):
    t = threading.Thread(target=lambda: _run_with_app_context(app), daemon=True)
    t.start()

def _run_with_app_context(app):
    with app.app_context():
        _loop()