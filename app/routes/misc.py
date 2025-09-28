from flask import Blueprint, jsonify, request, session, current_app
from app.background.tasks import get_query_count_cache

bp = Blueprint('misc', __name__)

@bp.route('/api/query_count')
def api_query_count():
    return jsonify({'count': get_query_count_cache()})

@bp.route('/api/theme', methods=['POST'])
def api_theme():
    data = request.get_json(force=True, silent=True) or {}
    session['theme'] = data.get('theme','light')
    session.modified = True
    return jsonify({'success':True})

@bp.route('/api/config')
def api_config():
    return jsonify({
        'success': True,
        'click_cooldown_ms': current_app.config['CLICK_COOLDOWN_SECONDS'] * 1000
    })