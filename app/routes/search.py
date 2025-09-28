from flask import Blueprint, request, jsonify
from app.repositories.fan_repository import FanRepository
from app.services.search_service import search

bp = Blueprint('search', __name__)
repo = FanRepository()

@bp.route('/api/search_fans', methods=['POST'])
def api_search_fans():
    try:
        data = request.get_json(force=True) or {}
        res_type = (data.get('search_res_type') or '').strip()
        res_loc = (data.get('search_res_loc') or '').strip()
        size_filter = (data.get('size_filter') or '').strip()
        thickness_min = (data.get('thickness_min') or '').strip()
        thickness_max = (data.get('thickness_max') or '').strip()
        sort_by = (data.get('sort_by') or 'none').strip()
        sort_value_raw = (data.get('sort_value') or '').strip()

        if not res_type:
            return jsonify({'success':False,'error_message':'请选择风阻类型'})
        if res_type != '空载' and not res_loc:
            return jsonify({'success':False,'error_message':'请选择风阻位置'})
        try:
            tmin = int(thickness_min); tmax = int(thickness_max)
            if tmin < 1 or tmax < 1 or tmin > 99 or tmax > 99 or tmin > tmax:
                return jsonify({'success':False,'error_message':'厚度区间不合法 (1~99 且最小不大于最大)'})
        except ValueError:
            return jsonify({'success':False,'error_message':'厚度必须为整数'})

        sort_value = None
        if sort_by != 'none':
            if not sort_value_raw:
                return jsonify({'success':False,'error_message':'请输入限制值'})
            try:
                sort_value = float(sort_value_raw)
            except ValueError:
                return jsonify({'success':False,'error_message':'限制值必须是数字'})

        res_loc_filter = '' if res_type == '空载' else res_loc

        results = search(res_type, res_loc_filter, sort_by, sort_value,
                         size_filter, tmin, tmax, limit=200)

        if sort_by == 'rpm':
            condition_label = f'条件限制：转速 ≤ {sort_value_raw} RPM'
        elif sort_by == 'noise':
            condition_label = f'条件限制：噪音 ≤ {sort_value_raw} dB'
        else:
            condition_label = '条件：全速运行'

        return jsonify({'success':True,'search_results':results,'condition_label':condition_label})
    except Exception as e:
        return jsonify({'success':False,'error_message':f'搜索异常: {e}'})

# 级联 + 型号搜索
@bp.route('/search_models/<query>')
def search_models(query):
    rows = repo.search_models(query)
    return jsonify([f"{r['brand_name_zh']} {r['model_name']}" for r in rows])

@bp.route('/get_models/<brand>')
def get_models(brand):
    return jsonify(repo.get_models_by_brand(brand))

@bp.route('/get_resistance_types/<brand>/<model>')
def get_res_types(brand, model):
    return jsonify(repo.get_res_types_by_brand_model(brand, model))

@bp.route('/get_resistance_locations/<brand>/<model>/<res_type>')
def get_res_locs(brand, model, res_type):
    rows = repo.get_res_locs_by_bmr(brand, model, res_type)
    out=[]
    has_empty=False
    for v in rows:
        s = '' if v is None else str(v).strip()
        if s == '':
            has_empty=True
        else:
            out.append(s)
    if has_empty or res_type == '空载':
        out.insert(0,'无')
    return jsonify(out)

@bp.route('/get_resistance_locations_by_type/<res_type>')
def get_res_locs_by_type(res_type):
    if not res_type:
        return jsonify([])
    rows = repo.get_res_locs_by_res_type(res_type)
    out=[]
    has_empty=False
    for v in rows:
        s = '' if v is None else str(v).strip()
        if s == '':
            has_empty=True
        else:
            out.append(s)
    if res_type == '空载' or has_empty:
        out.insert(0,'无')
    return jsonify(out)