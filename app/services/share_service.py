from typing import List, Tuple
from flask import session, current_app
from app.repositories.fan_repository import FanRepository
from app.security.share_signer import sign_share, verify_share

repo = FanRepository()

def create_share_token(pairs: List[Tuple[int, int]],
                       x_axis_type: str,
                       show_raw: bool,
                       show_fit: bool,
                       pointer: float | None,
                       hidden_keys_indices: List[int],
                       color_indices: List[int | None]) -> str:
    """
    pairs: [(model_id, condition_id)...]
    """
    payload = {
        "pairs": pairs,
        "x": "noise_db" if x_axis_type == "noise_db" else "rpm",
        "raw": 1 if show_raw else 0,
        "fit": 1 if show_fit else 0,
        "p": pointer,
        "h": hidden_keys_indices,
        "c": [ci if isinstance(ci, int) and ci >= 0 else None for ci in color_indices]
    }
    return sign_share(payload)


def load_share_into_session(token: str) -> tuple[bool, str]:
    """
    验证分享 token 并将数据放入当前会话。
    返回 (True, '') 表示成功；(False, '错误原因') 表示失败。
    """
    data = verify_share(token)
    if not data:
        return False, "无效或已过期的分享链接"

    body = data.get('data') or {}
    pairs = body.get('pairs') or []
    if not isinstance(pairs, list):
        return False, "分享数据格式错误"

    # 清理旧状态
    session.pop('selected_fans', None)
    session.pop('recently_removed_fans', None)
    session.pop('color_indices', None)

    # 查询信息映射
    infos_map = {
        (int(r['model_id']), int(r['condition_id'])): r
        for r in repo.get_infos_by_pairs(pairs)
    }

    color_indices = body.get('c') or []
    color_map = {}

    max_items = current_app.config['MAX_CHART_ITEMS']
    added = 0
    for idx, (m, c) in enumerate(pairs):
        meta = infos_map.get((m, c))
        if not meta:
            continue
        if added >= max_items:
            break
        info = dict(
            brand=meta['brand_name_zh'],
            model=meta['model_name'],
            res_type=meta['resistance_type_zh'],
            res_loc=meta['resistance_location_zh'],
            model_id=int(meta['model_id']),
            condition_id=int(meta['condition_id'])
        )
        add_fan_to_session(info)
        try:
            ci = color_indices[idx] if idx < len(color_indices) else None
            if isinstance(ci, int) and ci >= 0:
                color_map[fan_key_from_info(info)] = ci
        except Exception:
            pass
        added += 1

    if color_map:
        session['color_indices'] = color_map

    # 还原图表配置
    session['x_axis_type'] = 'noise_db' if body.get('x') == 'noise_db' else 'rpm'
    session['show_raw_curves'] = bool(body.get('raw', 1))
    session['show_fit_curves'] = bool(body.get('fit', 0))
    pointer = body.get('p')
    if isinstance(pointer, (int, float)):
        axis = session['x_axis_type']
        session[f"pointer_x_{axis}"] = float(pointer)

    # 隐藏图例
    hidden_keys = []
    hidden_idx_list = body.get('h', [])
    for i in hidden_idx_list:
        if isinstance(i, int) and 0 <= i < len(pairs):
            m, c = pairs[i]
            hidden_keys.append(f"{int(m)}_{int(c)}")
    if hidden_keys:
        session['legend_hidden_keys'] = hidden_keys
    else:
        session.pop('legend_hidden_keys', None)

    session.modified = True
    return True, ""