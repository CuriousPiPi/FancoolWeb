from flask import Blueprint, request, jsonify, session, current_app
from app.services import state_service as ss
from app.services.query_log_service import log_query

bp = Blueprint('core', __name__)

@bp.route('/api/state')
def api_state():
    return jsonify(ss.assemble_state())

@bp.route('/api/add_fan', methods=['POST'])
def api_add_fan():
    data = request.get_json(force=True) or {}
    brand = (data.get('brand') or '').strip()
    model = (data.get('model') or '').strip()
    res_type = (data.get('res_type') or '').strip()
    res_loc_raw = data.get('res_loc')
    res_loc = '' if res_loc_raw is None else str(res_loc_raw).strip()

    if not brand or not model:
        return jsonify(ss.assemble_state({'error_message': '缺少品牌或型号'}))
    if not res_type:
        return jsonify(ss.assemble_state({'error_message': '请选择风阻类型（或选择 全部）'}))

    res_type_filter = None if res_type == '全部' else res_type
    res_loc_filter = None if res_loc == '全部' else res_loc

    result = ss.handle_add_logic(brand, model, res_type_filter, res_loc_filter)
    success = not bool(result.get('error_message'))
    return jsonify(ss.assemble_state({**result, 'success': success}))

@bp.route('/api/remove_fan', methods=['POST'])
def api_remove_fan():
    data = request.get_json(force=True) or {}
    fk = data.get('fan_key')
    if not fk:
        return jsonify(ss.assemble_state({'error_message': '缺少 fan_key'}))
    if not ss.remove_fan_from_session(fk):
        return jsonify(ss.assemble_state({'error_message': '风扇不存在'}))
    return jsonify(ss.assemble_state())

@bp.route('/api/restore_fan', methods=['POST'])
def api_restore_fan():
    data = request.get_json(force=True) or {}
    fk = data.get('fan_key')
    if not fk:
        return jsonify(ss.assemble_state({'error_message': '缺少 fan_key'}))

    rem = session.get('recently_removed_fans', {})
    if fk not in rem:
        return jsonify(ss.assemble_state({'error_message': '该项不在最近移除列表'}))

    current_count = len(ss.get_selected_dict())
    max_items = current_app.config['MAX_CHART_ITEMS']
    if current_count >= max_items:
        return jsonify(ss.assemble_state({'error_message': f'已达到最大显示限制({max_items})'}))

    info = rem[fk]['info']
    if ss.is_duplicate(info):
        ss.remove_fan_from_recently_removed(fk)
        return jsonify(ss.assemble_state({'error_message': '该数据已在图表中'}))

    ss.add_fan_to_session(info)
    ss.remove_fan_from_recently_removed(fk)
    log_query(info)
    return jsonify(ss.assemble_state())

@bp.route('/api/clear_all', methods=['POST'])
def api_clear_all():
    sel = ss.get_selected_dict()
    for k, v in list(sel.items()):
        ss.add_to_recently_removed(v['info'])
    session.pop('selected_fans', None)
    session.modified = True
    return jsonify(ss.assemble_state())