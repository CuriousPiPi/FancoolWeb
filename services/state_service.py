from __future__ import annotations
from typing import List, Tuple, Dict
from repositories.fan_repository import FanRepository


def collect_share_meta(sess) -> dict | None:
    meta = {
        'show_raw_curves': sess.get('show_raw_curves'),
        'show_fit_curves': sess.get('show_fit_curves'),
        'pointer_x_rpm': sess.get('pointer_x_rpm'),
        'pointer_x_noise_db': sess.get('pointer_x_noise_db'),
        'legend_hidden_keys': sess.get('legend_hidden_keys'),
        'color_indices': sess.get('color_indices')
    }
    if any(v is not None for v in meta.values()):
        return meta
    return None


def build_selected_list(sess) -> List[dict]:
    sel = sess.setdefault('selected_fans', {})
    out = []
    for k, v in sel.items():
        info = v['info']
        out.append(dict(
            key=k,
            brand=info['brand'], model=info['model'],
            res_type=info['res_type'], res_loc=info['res_loc'],
            model_id=info['model_id'], condition_id=info['condition_id']
        ))
    return out


def build_recently_removed_list(sess) -> List[dict]:
    rem = sess.get('recently_removed_fans', {})
    items = list(rem.items())
    items.sort(key=lambda kv: kv[1]['removed_time'], reverse=True)
    out = []
    for k, v in items:
        info = v['info']
        out.append(dict(
            key=k, brand=info['brand'], model=info['model'],
            res_type=info['res_type'], res_loc=info['res_loc']
        ))
    return out


def extract_pairs_in_order(sess) -> Tuple[List[Tuple[int, int]], List[str]]:
    sel = sess.setdefault('selected_fans', {})
    pairs, order_keys = [], []
    for k, v in sel.items():
        info = v['info']
        pairs.append((info['model_id'], info['condition_id']))
        order_keys.append(k)
    return pairs, order_keys


def build_chart_data(sess, repo: FanRepository, cache=None) -> dict:
    x_axis_type = sess.get('x_axis_type', 'rpm')
    pairs, order_keys = extract_pairs_in_order(sess)
    bucket = repo.fetch_curve_points(pairs)
    series = []
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
    return dict(x_axis_type=x_axis_type, series=series)


def build_full_state(session, user_id: str, repo: FanRepository, extra: dict | None = None) -> dict:
    base = {
        'chart_data': build_chart_data(session, repo),
        'selected_fans': build_selected_list(session),
        'recently_removed_fans': build_recently_removed_list(session),
        'like_keys': repo.fetch_user_like_keys(user_id),
        'max_chart_items': 8,
        'error_message': None
    }
    sm = collect_share_meta(session)
    if sm:
        base['share_meta'] = sm
    if extra:
        base.update(extra)
    return base
