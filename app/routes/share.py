from flask import Blueprint, request, jsonify, url_for, redirect, current_app

bp = Blueprint('share', __name__)

@bp.route('/api/create_share', methods=['POST'])
def api_create_share():
    data = request.get_json(force=True) or {}
    fans = data.get('fans') or []
    x_axis_type = data.get('x_axis_type', 'rpm')
    show_raw = bool(data.get('show_raw', True))
    show_fit = bool(data.get('show_fit', False))
    pointer = data.get('pointer')
    legend_hidden = data.get('legend_hidden') or []
    color_indices = data.get('color_indices') or []

    max_items = current_app.config['MAX_CHART_ITEMS']
    if not isinstance(fans, list) or not fans:
        return jsonify({'success': False, 'error': 'fans 不能为空'})
    if len(fans) > max_items:
        return jsonify({'success': False, 'error': f'最多 {max_items} 组'})

    pairs = []
    for f in fans:
        try:
            m = int(f.get('m')); c = int(f.get('c'))
        except Exception:
            return jsonify({'success': False, 'error': 'fans 数据格式错误'})
        pairs.append((m, c))

    hidden_idx = []
    for idx in legend_hidden:
        try:
            i = int(idx)
            if 0 <= i < len(pairs):
                hidden_idx.append(i)
        except:
            pass

    token = create_share_token(pairs, x_axis_type, show_raw, show_fit, pointer, hidden_idx, color_indices)
    url = url_for('share.share_view', token=token, _external=True)
    return jsonify({'success': True, 'url': url})

@bp.route('/share/<token>')
def share_view(token):
    ok, msg = load_share_into_session(token)
    if not ok:
        return f"分享链接不可用: {msg}", 400
    return redirect(url_for('ui.index', share_loaded=1))