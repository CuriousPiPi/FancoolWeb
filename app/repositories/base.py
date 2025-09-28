from typing import List, Dict, Any
from sqlalchemy import text
from app.extensions import get_engine

class BaseRepository:
    def __init__(self):
        self._engine = get_engine()

    def fetch_all(self, sql: str, params: dict | None = None) -> List[Dict[str, Any]]:
        with self._engine.begin() as conn:
            rows = conn.execute(text(sql), params or {})
            return [dict(r._mapping) for r in rows]

    def fetch_one(self, sql: str, params: dict | None = None) -> Dict[str, Any] | None:
        with self._engine.begin() as conn:
            row = conn.execute(text(sql), params or {}).mappings().first()
            return dict(row) if row else None

    def exec_write(self, sql: str, params: dict | None = None):
        with self._engine.begin() as conn:
            conn.execute(text(sql), params or {})