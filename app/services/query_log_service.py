from app.repositories.fan_repository import FanRepository
from app.security.uid import current_user_identifier

repo = FanRepository()

def log_query(fan_infos):
    if not fan_infos:
        return
    if isinstance(fan_infos, dict):
        fan_infos = [fan_infos]
    uid = current_user_identifier()
    repo.insert_query_logs(uid, fan_infos)