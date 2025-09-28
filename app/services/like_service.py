from app.repositories.fan_repository import FanRepository
from app.security.uid import current_user_identifier

repo = FanRepository()

def like(model_id:int, condition_id:int):
    uid = current_user_identifier()
    repo.like(uid, model_id, condition_id)
    return repo.get_user_like_keys(uid)

def unlike(model_id:int, condition_id:int):
    uid = current_user_identifier()
    repo.unlike(uid, model_id, condition_id)
    return repo.get_user_like_keys(uid)

def recent_likes(limit:int=50):
    uid = current_user_identifier()
    return repo.get_user_likes_full(uid, limit=limit)