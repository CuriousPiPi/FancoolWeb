from sqlalchemy import create_engine
from .config import Config

engine = create_engine(
    Config.FANDB_DSN,
    pool_pre_ping=True,
    pool_recycle=1800,
    future=True
)

def get_engine():
    return engine