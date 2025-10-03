# Refactored backend using repository + state_service + signing
import os, uuid, logging, time
from datetime import datetime, timedelta
from flask import Flask, request, render_template, session, redirect, jsonify, url_for, g
from sqlalchemy import create_engine
from repositories.fan_repository import FanRepository
from security import signing
from services import state_service

app = Flask(__name__)
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=30)
app.secret_key = os.getenv('APP_SECRET', 'replace-me-in-prod')

DB_DSN = os.getenv('FANDB_DSN', 'mysql+pymysql://localreader:12345678@127.0.0.1/FANDB?charset=utf8mb4')
engine = create_engine(DB_DSN, pool_pre_ping=True, pool_recycle=1800, future=True)
fan_repo = FanRepository(engine)

MAX_CHART_ITEMS = 8
MAX_RECENTLY_REMOVED = 20

# ---------- Helpers ----------
def fan_key_from(info: dict) -> str:
    return f"{int(info['model_id'])}_{int(info['condition_id'])}"


def get_selected_dict():
    return session.setdefault('selected_fans', {})


def add_fan_to_session(info: dict):
    sel = get_selected_dict()
    sel[fan_key_from(info)] = {'info': {
        'brand': info['brand'],
        'model': info['model'],
        'res_type': info['res_type'],
        'res_loc': info['res_loc'],
        'model_id': int(info['model_id']),
        'condition_id': int(info['condition_id'])
    }}
    session.modified = True


def add_to_recently_removed(info: dict):
    removed = session.setdefault('recently_removed_fans', {})
    removed[fan_key_from(info)] = {'info': info, 'removed_time': datetime.now().isoformat()}
    if len(removed) > MAX_RECENTLY_REMOVED:
        oldest = min(removed.items(), key=lambda kv: kv[1]['removed_time'])[0]
        removed.pop(oldest, None)
    session.modified = True


def remove_fan_from_session(fk: str) -> bool:
    sel = get_selected_dict()
    if fk in sel:
        info = sel[fk]['info']
        add_to_recently_removed(info)
        sel.pop(fk, None)
        session.modified = True
        return True
    return False


def remove_fan_from_recently_removed(fk: str) -> bool:
    rem = session.get('recently_removed_fans', {})
    if fk in rem:
        rem.pop(fk)
        session.modified = True
        return True
    return False


def is_duplicate_in_session(info: dict) -> bool:
    return fan_key_from(info) in get_selected_dict()


# ---------- Signing wrappers ----------
def _sign_uid(value: str) -> str:
    return signing.sign_text('uid', value)


def _unsign_uid(token: str) -> str | None:
    return signing.verify_text('uid', token)


def sign_share_payload(payload: dict) -> str:
    return signing.sign_struct('share', payload, version=1)


def verify_share_token(token: str) -> dict | None:
    ok, data = signing.verify_struct('share', token)
    if not ok:
        return None
    if data.get('v') != 1:
        return None
    return data


# ---------- State assembly thin wrapper ----------
def assemble_state(extra=None):
    user_id = get_or_create_user_identifier()
    base = state_service.build_full_state(session=session, user_id=user_id, repo=fan_repo)
    if extra:
        base.update(extra)
    return base


# ---------- UID lifecycle ----------
UID_COOKIE_NAME = os.getenv('UID_COOKIE_NAME', 'fc_uid')
UID_COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 2
UID_COOKIE_SAMESITE = 'Lax'


@app.before_request
def _init_g_defaults():
    if not hasattr(g, '_uid_source'):
        g._uid_source = None


def get_or_create_user_identifier() -> str:
    token = request.cookies.get(UID_COOKIE_NAME)
    uid_from_cookie = _unsign_uid(token) if token else None
    if uid_from_cookie:
        uid = uid_from_cookie
        g._uid_source = 'cookie'
    else:
        uid = session.get('user_identifier')
        if uid:
            g._uid_source = 'session'
        else:
            uid = str(uuid.uuid4())
            g._uid_source = 'generated'
    g._active_uid = uid
    if not token:
        g._set_uid_cookie = _sign_uid(uid)
        g._set_uid_refresh_now = True
    session['user_identifier'] = uid
    session.permanent = True
    return uid


@app.after_request
def ensure_uid_cookie(resp):
    token_to_set = getattr(g, '_set_uid_cookie', None)
    if token_to_set:
        resp.set_cookie(
            UID_COOKIE_NAME, token_to_set,
            max_age=UID_COOKIE_MAX_AGE,
            samesite=UID_COOKIE_SAMESITE,
            secure=False, httponly=True, path='/'
        )
    return resp


# ---------- Add logic ----------
def handle_add_logic_inputs_ready(brand: str, model: str,
                                  res_type_filter: str | None,
                                  res_loc_filter: str | None) -> dict:
    start_count = len(get_selected_dict())
    pairs_info = fan_repo.fetch_distinct_pairs_for_add(brand, model, res_type_filter, res_loc_filter)
    if not pairs_info:
        return {'error_message': '没有匹配的数据组合（可能该型号在该位置/类型下无记录）'}
    to_add = []
    for r in pairs_info:
        info = dict(
            brand=r['brand_name_zh'],
            model=r['model_name'],
            res_type=r['resistance_type_zh'],
            res_loc=r['resistance_location_zh'],
            model_id=int(r['model_id']),
            condition_id=int(r['condition_id'])
        )
        if not is_duplicate_in_session(info):
            to_add.append(info)
    if not to_add:
        return {'error_message': '全部数据已存在，无新增'}
    if start_count + len(to_add) > MAX_CHART_ITEMS:
        return {'error_message': f'该选择将新增 {len(to_add)} 组，已存在 {start_count} 组，超出上限 {MAX_CHART_ITEMS}，请先移除部分。'}
    for info in to_add:
        add_fan_to_session(info)
    return {}


# ---------- Routes ----------
@app.route('/api/create_share', methods=['POST'])
def api_create_share():
    try:
        data = request.get_json(force=True) or {}
        fans = data.get('fans') or []
        x_axis_type = data.get('x_axis_type', 'rpm')
        show_raw = bool(data.get('show_raw', True))
        show_fit = bool(data.get('show_fit', False))
        pointer = data.get('pointer')
        legend_hidden = data.get('legend_hidden') or []
        color_indices = data.get('color_indices') or []
        if not isinstance(fans, list) or not fans:
            return jsonify({'success': False, 'error': 'fans 不能为空'})
        if len(fans) > MAX_CHART_ITEMS:
            return jsonify({'success': False, 'error': f'最多 {MAX_CHART_ITEMS} 组'})
        pairs = []
        for f in fans:
            m = int(f.get('m'))
            c = int(f.get('c'))
            pairs.append((m, c))
        hidden_idx = []
        for idx in legend_hidden:
            try:
                i = int(idx)
                if 0 <= i < len(pairs):
                    hidden_idx.append(i)
            except:
                pass
        clean_colors = []
        for i in range(len(pairs)):
            val = color_indices[i] if i < len(color_indices) else None
            clean_colors.append(val if isinstance(val, int) and val >= 0 else None)
        payload = {
            'f': pairs,
            'x': 'noise_db' if x_axis_type == 'noise_db' else 'rpm',
            'r': 1 if show_raw else 0,
            't': 1 if show_fit else 0,
            'p': pointer,
            'h': hidden_idx,
            'c': clean_colors
        }
        token = sign_share_payload(payload)
        url = url_for('share_view', token=token, _external=True)
        return jsonify({'success': True, 'url': url})
    except Exception as e:
        app.logger.exception(e)
        return jsonify({'success': False, 'error': str(e)})


@app.route('/share/<token>')
def share_view(token):
    data = verify_share_token(token)
    if not data:
        return '无效的分享链接', 400
    session.pop('selected_fans', None)
    session.pop('recently_removed_fans', None)
    session.pop('color_indices', None)
    pairs = data.get('f') or []
    color_indices = data.get('c') or []
    infos_map = {(int(i['model_id']), int(i['condition_id'])): i for i in fan_repo.fetch_infos_by_pairs(pairs)}
    added = 0
    color_map = {}
    for idx, (m, c) in enumerate(pairs):
        meta = infos_map.get((m, c))
        if not meta:
            continue
        if added >= MAX_CHART_ITEMS:
            break
        add_fan_to_session(dict(
            brand=meta['brand_name_zh'],
            model=meta['model_name'],
            res_type=meta['resistance_type_zh'],
            res_loc=meta['resistance_location_zh'],
            model_id=int(meta['model_id']),
            condition_id=int(meta['condition_id'])
        ))
        ci = color_indices[idx] if idx < len(color_indices) else None
        if isinstance(ci, int) and ci >= 0:
            color_map[f"{int(meta['model_id'])}_{int(meta['condition_id'])}"] = ci
        added += 1
    if color_map:
        session['color_indices'] = color_map
    session['x_axis_type'] = 'noise_db' if data.get('x') == 'noise_db' else 'rpm'
    session['show_raw_curves'] = bool(data.get('r', 1))
    session['show_fit_curves'] = bool(data.get('t', 0))
    pointer = data.get('p')
    if isinstance(pointer, (int, float)):
        session[f"pointer_x_{session['x_axis_type']}"] = float(pointer)
    hidden_idx_list = data.get('h', [])
    hidden_keys = []
    for i in hidden_idx_list:
        if isinstance(i, int) and 0 <= i < len(pairs):
            m, c = pairs[i]
            hidden_keys.append(f"{int(m)}_{int(c)}")
    if hidden_keys:
        session['legend_hidden_keys'] = hidden_keys
    else:
        session.pop('legend_hidden_keys', None)
    session.modified = True
    return redirect(url_for('index', share_loaded=1))


#@app.route('/api/state')
#def api_state():
#    return jsonify(assemble_state())
#
#
#@app.route('/api/add_fan', methods=['POST'])
#def api_add_fan():
#    data = request.get_json(force=True) or {}
#    brand = (data.get('brand') or '').strip()
#    model = (data.get('model') or '').strip()
#    res_type = (data.get('res_type') or '').strip()
#    res_loc_raw = data.get('res_loc')
#    res_loc = '' if res_loc_raw is None else str(res_loc_raw).strip()
#    if not brand or not model:
#        return jsonify(assemble_state({'error_message': '缺少品牌或型号'}))
#    if not res_type:
#        return jsonify(assemble_state({'error_message': '请选择风阻类型（或选择 全部）'}))
#    res_type_filter = None if res_type == '全部' else res_type
#    res_loc_filter = None if res_loc == '全部' else res_loc
#    result = handle_add_logic_inputs_ready(brand, model, res_type_filter, res_loc_filter)
#    success = not bool(result.get('error_message'))
#    return jsonify(assemble_state({**result, 'success': success}))
#
#
#@app.route('/api/remove_fan', methods=['POST'])
#def api_remove_fan():
#    data = request.get_json(force=True) or {}
#    fk = data.get('fan_key')
#    if not fk:
#        return jsonify(assemble_state({'error_message': '缺少 fan_key'}))
#    if not remove_fan_from_session(fk):
#        return jsonify(assemble_state({'error_message': '风扇不存在'}))
#    return jsonify(assemble_state())
#
#
#@app.route('/api/restore_fan', methods=['POST'])
#def api_restore_fan():
#    data = request.get_json(force=True) or {}
#    fk = data.get('fan_key')
#    if not fk:
#        return jsonify(assemble_state({'error_message': '缺少 fan_key'}))
#    rem = session.get('recently_removed_fans', {})
#    if fk not in rem:
#        return jsonify(assemble_state({'error_message': '该项不在最近移除列表'}))
#    if len(get_selected_dict()) >= MAX_CHART_ITEMS:
#        return jsonify(assemble_state({'error_message': f'已达到最大显示限制({MAX_CHART_ITEMS})'}))
#    info = rem[fk]['info']
#    if is_duplicate_in_session(info):
#        remove_fan_from_recently_removed(fk)
#        return jsonify(assemble_state({'error_message': '该数据已在图表中'}))
#    add_fan_to_session(info)
#    remove_fan_from_recently_removed(fk)
#    return jsonify(assemble_state())
#
#
#@app.route('/api/clear_all', methods=['POST'])
#def api_clear_all():
#    sel = get_selected_dict()
#    for k, v in list(sel.items()):
#        add_to_recently_removed(v['info'])
#    session.pop('selected_fans', None)
#    session.modified = True
#    return jsonify(assemble_state())


@app.route('/')
def index():
    brands_rows = fan_repo._fetch_all("SELECT DISTINCT brand_name_zh FROM fan_brand")
    brands = [r['brand_name_zh'] for r in brands_rows]
    all_res_types = fan_repo.fetch_all_res_types()
    all_res_locs = fan_repo.fetch_all_res_locs()
    top_queries = fan_repo.fetch_top_queries(limit=10)
    top_ratings = fan_repo.fetch_top_ratings(limit=10)
    selected_fans = state_service.build_selected_list(session)
    return render_template(
        'fancoolindex.html',
        brands=brands, models=[], res_types=[], res_locs=[],
        selected_fans=selected_fans, top_queries=top_queries, top_ratings=top_ratings,
        all_res_types=all_res_types, all_res_locs=all_res_locs,
        search_results=[], search_res_type='', search_res_loc='', sort_by='none', sort_value='',
        size_options=["不限", "120", "140"], size_filter='不限', thickness_min='25', thickness_max='50',
        error_message=None, max_chart_items=MAX_CHART_ITEMS,
        url_search_res_type='', url_search_res_loc='', url_sort_by='none', url_sort_value='',
        url_size_filter='不限', url_thickness_min='25', url_thickness_max='50',
        colors=["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd", "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf"],
        click_cooldown_ms=100
    )
  
if __name__ == '__main__':
    app.logger.setLevel(logging.INFO)
    app.run(host='0.0.0.0', port=5001, debug=True, use_reloader=False)
