from flask import session
from typing import Dict, List, Tuple
from app.repositories.fan_repository import FanRepository
from app.security.uid import current_user_identifier
from app.services.query_log_service import log_query
from flask import current_app

repo = FanRepository()
MAX_CHART_ITEMS = None  # 将在第一次调用时从 config 读取
MAX_RECENTLY_REMOVED = None

def _lazy_load_constants():
    global MAX_CHART_ITEMS, MAX_RECENTLY_REMOVED
    if MAX_CHART_ITEMS is None:
        cfg = current_app.config
        MAX_CHART_ITEMS = cfg['MAX_CHART_ITEMS']
        MAX_RECENTLY_REMOVED = cfg['MAX_RECENTLY_REMOVED']

def get_selected_dict() -> Dict[str, dict]:
    return session.setdefault('selected_fans', {})

def fan_key_from_info(info: dict) -> str:
    return f"{int(info['model_id'])}_{int(info['condition_id'])}"

def add_fan_to_session(info: dict):
    _lazy_load_constants()
    sel = get_selected_dict()
    sel[fan_key_from_info(info)] = {'info': {
        'brand': info['brand'],
        'model': info['model'],
        'res_type': info['res_type'],
        'res_loc': info['res_loc'],
        'model_id': int(info['model_id']),
        'condition_id': int(info['condition_id'])
    }}
    session.modified = True

def add_to_recently_removed(info: dict):
    _lazy_load_constants()
    removed = session.setdefault('recently_removed_fans', {})
    from datetime import datetime
    removed[fan_key_from_info(info)] = {
        'info': info,
        'removed_time': datetime.now().isoformat()
    }
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

def build_selected_list() -> List[dict]:
    sel = get_selected_dict()
    out = []
    for k,v in sel.items():
        info = v['info']
        out.append(dict(
            key=k, brand=info['brand'], model=info['model'],
            res_type=info['res_type'], res_loc=info['res_loc'],
            model_id=info['model_id'], condition_id=info['condition_id']
        ))
    return out

def build_recently_removed_list() -> List[dict]:
    rem = session.get('recently_removed_fans', {})
    items = list(rem.items())
    items.sort(key=lambda kv: kv[1]['removed_time'], reverse=True)
    out=[]
    for k,v in items:
        info = v['info']
        out.append(dict(
            key=k, brand=info['brand'], model=info['model'],
            res_type=info['res_type'], res_loc=info['res_loc']
        ))
    return out

def get_curves_chart_data(selected_pairs: List[Tuple[int,int]], order_keys: List[str]):
    bucket = repo.get_curves_for_pairs(selected_pairs)
    series=[]
    for k in order_keys:
        b = bucket.get(k)
        if not b:
            continue
        info = b['info']
        series.append(dict(
            key=k,
            name=f"{info['brand']} {info['model']} - {info['res_type']}({info['res_loc']})",
            brand=info['brand'], model=info['model'],
            res_type=info['res_type'], res_loc=info['res_loc'],
            model_id=info['model_id'], condition_id=info['condition_id'],
            rpm=b['rpm'], noise_db=b['noise_db'], airflow=b['airflow']
        ))
    x_axis_type = session.get('x_axis_type','rpm')
    return dict(x_axis_type=x_axis_type, series=series)

def is_duplicate(info: dict) -> bool:
    return fan_key_from_info(info) in get_selected_dict()

def handle_add_logic(brand:str, model:str, res_type:str|None, res_loc:str|None) -> dict:
    _lazy_load_constants()
    start_count = len(get_selected_dict())
    pairs_info = repo.get_distinct_pairs_for_add(brand, model, res_type, res_loc)
    if not pairs_info:
        return {'error_message': '没有匹配的数据组合（可能该型号在该位置/类型下无记录）'}
    to_add=[]
    for r in pairs_info:
        info = dict(
            brand=r['brand_name_zh'],
            model=r['model_name'],
            res_type=r['resistance_type_zh'],
            res_loc=r['resistance_location_zh'],
            model_id=int(r['model_id']),
            condition_id=int(r['condition_id'])
        )
        if not is_duplicate(info):
            to_add.append(info)
    if not to_add:
        return {'error_message': '全部数据已存在，无新增'}
    if start_count + len(to_add) > MAX_CHART_ITEMS:
        return {'error_message': f'该选择将新增 {len(to_add)} 组，已存在 {start_count} 组，超出上限 {MAX_CHART_ITEMS}，请先移除部分。'}

    for info in to_add:
        add_fan_to_session(info)
    log_query(to_add)
    return {}

def assemble_state(extra: dict|None=None) -> dict:
    _lazy_load_constants()
    uid = current_user_identifier()
    like_keys = repo.get_user_like_keys(uid)
    sel_dict = get_selected_dict()
    pairs=[]
    order_keys=[]
    for k,v in sel_dict.items():
        info = v['info']
        pairs.append((info['model_id'], info['condition_id']))
        order_keys.append(k)
    chart_data = get_curves_chart_data(pairs, order_keys)
    state = dict(
        chart_data=chart_data,
        selected_fans=build_selected_list(),
        recently_removed_fans=build_recently_removed_list(),
        like_keys=like_keys,
        max_chart_items=current_app.config['MAX_CHART_ITEMS'],
        error_message=None
    )
    share_meta = {
        'show_raw_curves': session.get('show_raw_curves'),
        'show_fit_curves': session.get('show_fit_curves'),
        'pointer_x_rpm': session.get('pointer_x_rpm'),
        'pointer_x_noise_db': session.get('pointer_x_noise_db'),
        'legend_hidden_keys': session.get('legend_hidden_keys'),
        'color_indices': session.get('color_indices'),
    }
    if any(v is not None for v in share_meta.values()):
        state['share_meta'] = share_meta
    if extra:
        state.update(extra)
    return state