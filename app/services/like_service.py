from app.repositories.fan_repository import FanRepository
from app.security.uid import current_user_identifier

_repo = FanRepository()

def like(model_id: int, condition_id: int):
    """
    点赞：写入数据库并返回当前用户全部点赞 key 列表。
    """
    uid = current_user_identifier()
    _repo.like(uid, model_id, condition_id)
    return _repo.get_user_like_keys(uid)

def unlike(model_id: int, condition_id: int):
    """
    取消点赞：删除记录并返回当前用户全部点赞 key 列表。
    """
    uid = current_user_identifier()
    _repo.unlike(uid, model_id, condition_id)
    return _repo.get_user_like_keys(uid)

def recent_likes(limit: int = 50):
    """
    最近点赞列表（包含元信息），用于“最近点赞”面板。
    """
    uid = current_user_identifier()
    return _repo.get_user_likes_full(uid, limit=limit)

def get_user_like_keys():
    """
    返回当前用户所有已点赞 (model_id_condition_id) 组合 key 列表。
    供前端初始化或刷新点赞状态。
    """
    uid = current_user_identifier()
    return _repo.get_user_like_keys(uid)