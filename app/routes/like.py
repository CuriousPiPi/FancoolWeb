from flask import Blueprint, request, jsonify
from app.services.like_service import like as do_like, unlike as do_unlike, recent_likes
from app.repositories.fan_repository import FanRepository
from app.security.uid import current_user_identifier

bp = Blueprint('like', __name__)
repo = FanRepository()

@bp.route('/api/like', methods=['POST'])
def api_like():
    data = request.get_json(force=True) or {}
    mid = data.get('model_id')
    cid = data.get('condition_id')
    if not mid or not cid:
        return jsonify({'success': False, 'error': '缺少 model_id 或 condition_id'})
    try:
        keys = do_like(int(mid), int(cid))
        return jsonify({'success': True, 'like_keys': keys})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@bp.route('/api/unlike', methods=['POST'])
def api_unlike():
    data = request.get_json(force=True) or {}
    mid = data.get('model_id')
    cid = data.get('condition_id')
    if not mid or not cid:
        return jsonify({'success': False, 'error': '缺少 model_id 或 condition_id'})
    try:
        keys = do_unlike(int(mid), int(cid))
        return jsonify({'success': True, 'like_keys': keys})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@bp.route('/api/recent_likes')
def api_recent_likes():
    try:
        items = recent_likes(limit=50)
        return jsonify({'success': True, 'data': items})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@bp.route('/api/top_ratings')
def api_top_ratings():
    try:
        data = repo.get_top_ratings(limit=10)
        return jsonify({'success': True, 'data': data})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})