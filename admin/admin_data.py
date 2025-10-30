from flask import Blueprint, render_template, request, session, redirect, current_app, jsonify, make_response
from sqlalchemy import text
import uuid
from decimal import Decimal, ROUND_HALF_UP

data_mgmt_bp = Blueprint('data_mgmt', __name__)

# ========== 通用响应工具 ==========
def resp_ok(data=None, message=None, meta=None, http_status=200):
    payload = {'success': True, 'data': data, 'message': message, 'meta': meta or {}}
    return make_response(jsonify(payload), http_status)

def resp_err(code: str, msg: str, http_status=400, meta=None):
    payload = {'success': False, 'error_code': code, 'error_message': msg, 'data': None, 'meta': meta or {}}
    return make_response(jsonify(payload), http_status)

def _engine():
    eng = current_app.config.get('ADMIN_ENGINE')
    if not eng:
        raise RuntimeError('ADMIN_ENGINE is not configured on app')
    return eng

def _fetch_all(sql: str, params: dict = None):
    with _engine().begin() as conn:
        rows = conn.execute(text(sql), params or {})
        return [dict(r._mapping) for r in rows]

def _round1(x):
    if x is None:
        return None
    return float(Decimal(str(x)).quantize(Decimal('0.0'), rounding=ROUND_HALF_UP))

# ========== 页面 ==========
@data_mgmt_bp.get('/admin/data')
def page_data_mgmt():
    if not session.get('is_admin'):
        return redirect('/admin/login', code=302)
    # 不再在这里拼装 admin_name，由入口程序的 context_processor 注入
    return render_template('data_management.html')

@data_mgmt_bp.get('/admin/logout')
def admin_logout():
    # 清理会话并跳转登录页
    session.clear()
    return redirect('/admin/login', code=302)
# ========== 品牌相关 ==========
@data_mgmt_bp.post('/admin/api/data/brand/add')
def api_add_brand():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    data = request.get_json(force=True, silent=True) or {}
    zh = (data.get('brand_name_zh') or '').strip()
    en = (data.get('brand_name_en') or '').strip()
    try:
        is_valid = int(data.get('is_valid') if data.get('is_valid') in (0, 1, '0', '1') else 0)
    except Exception:
        is_valid = 0
    if not zh or not en:
        return resp_err('INVALID_INPUT', '中文品牌名与英文品牌名均为必填')

    existed = _fetch_all("""
        SELECT brand_id FROM fan_brand
        WHERE brand_name_zh = :zh OR brand_name_en = :en
        LIMIT 1
    """, {'zh': zh, 'en': en})
    if existed:
        return resp_err('BRAND_EXISTS', '该品牌已存在')
    try:
        with _engine().begin() as conn:
            r = conn.execute(
                text("INSERT INTO fan_brand (brand_name_zh, brand_name_en, is_valid) VALUES (:zh, :en, :v)"),
                {'zh': zh, 'en': en, 'v': is_valid}
            )
            bid = r.lastrowid
    except Exception as e:
        return resp_err('DB_WRITE_FAIL', f'写入失败: {e}', 500)
    return resp_ok({'brand_id': bid}, message=f'添加成功，brand_id：{bid}')

@data_mgmt_bp.get('/admin/api/data/brand/search')
def api_search_brand():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    q = (request.args.get('q') or '').strip()
    if not q:
        return resp_ok({'items': []})
    rows = _fetch_all("""
        SELECT brand_id, brand_name_zh, brand_name_en, COALESCE(is_valid,0) AS is_valid
        FROM fan_brand
        WHERE brand_name_zh LIKE :q OR brand_name_en LIKE :q
        ORDER BY brand_name_zh
        LIMIT 10
    """, {'q': f'%{q}%'})
    items = [{
        'brand_id': int(r['brand_id']),
        'label': f"{(r.get('brand_name_zh') or '').strip()} / {(r.get('brand_name_en') or '').strip()}".strip(' /'),
        'is_valid': int(r.get('is_valid') or 0)
    } for r in rows]
    return resp_ok({'items': items})

@data_mgmt_bp.get('/admin/api/data/brand/all')
def api_brand_all():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    rows = _fetch_all("""
        SELECT brand_id, brand_name_zh, brand_name_en, COALESCE(is_valid,0) AS is_valid
        FROM fan_brand
        ORDER BY brand_name_zh, brand_name_en
    """)
    items = [{
        'brand_id': int(r['brand_id']),
        'brand_name_zh': r['brand_name_zh'],
        'brand_name_en': r['brand_name_en'],
        'is_valid': int(r['is_valid'] or 0),
        'label': f"{(r.get('brand_name_zh') or '').strip()} / {(r.get('brand_name_en') or '').strip()}".strip(' /')
    } for r in rows]
    return resp_ok({'items': items})

@data_mgmt_bp.get('/admin/api/data/brand/detail')
def api_brand_detail():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    try:
        bid = int(request.args.get('brand_id') or 0)
    except Exception:
        bid = 0
    if bid <= 0:
        return resp_err('INVALID_INPUT', '缺少 brand_id')
    rows = _fetch_all("""
        SELECT brand_id, brand_name_zh, brand_name_en, COALESCE(is_valid,0) AS is_valid
        FROM fan_brand WHERE brand_id = :bid LIMIT 1
    """, {'bid': bid})
    if not rows:
        return resp_err('NOT_FOUND', '未找到该品牌', 404)
    r = rows[0]
    return resp_ok({
        'brand_id': int(r['brand_id']),
        'brand_name_zh': r['brand_name_zh'],
        'brand_name_en': r['brand_name_en'],
        'is_valid': int(r['is_valid'] or 0)
    })

@data_mgmt_bp.post('/admin/api/data/brand/update')
def api_brand_update():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    data = request.get_json(force=True, silent=True) or {}
    try:
        brand_id = int(data.get('brand_id') or 0)
    except Exception:
        brand_id = 0
    zh = (data.get('brand_name_zh') or '').strip()
    en = (data.get('brand_name_en') or '').strip()
    try:
        is_valid = int(data.get('is_valid') if data.get('is_valid') in (0, 1, '0', '1') else 0)
    except Exception:
        is_valid = 0

    if brand_id <= 0:
        return resp_err('INVALID_INPUT', '缺少 brand_id')
    if not zh or not en:
        return resp_err('INVALID_INPUT', '中文品牌名与英文品牌名均为必填')

    existed = _fetch_all("""
        SELECT brand_id FROM fan_brand
        WHERE (brand_name_zh = :zh OR brand_name_en = :en) AND brand_id <> :bid
        LIMIT 1
    """, {'zh': zh, 'en': en, 'bid': brand_id})
    if existed:
        return resp_err('BRAND_EXISTS', '已存在同名（中文或英文）品牌')

    try:
        with _engine().begin() as conn:
            conn.execute(text("""
                UPDATE fan_brand
                SET brand_name_zh=:zh, brand_name_en=:en, is_valid=:v
                WHERE brand_id=:bid
            """), {'zh': zh, 'en': en, 'v': is_valid, 'bid': brand_id})
    except Exception as e:
        return resp_err('DB_WRITE_FAIL', f'写入失败: {e}', 500)
    return resp_ok({'brand_id': brand_id}, message='更新成功')

@data_mgmt_bp.get('/admin/api/data/model/by-brand')
def api_models_by_brand():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    try:
        bid = int(request.args.get('brand_id') or 0)
    except Exception:
        bid = 0
    if bid <= 0:
        return resp_ok({'items': []})
    rows = _fetch_all("""
        SELECT model_id, model_name, COALESCE(is_valid,0) AS is_valid
        FROM fan_model
        WHERE brand_id = :bid
        ORDER BY model_name
        LIMIT 200
    """, {'bid': bid})
    return resp_ok({'items': [{
        'model_id': int(r['model_id']),
        'model_name': r['model_name'],
        'is_valid': int(r['is_valid'] or 0)
    } for r in rows]})

# ========== 型号相关 ==========
@data_mgmt_bp.get('/admin/api/data/model/exist')
def api_model_exist():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    name = (request.args.get('name') or '').strip()
    if not name:
        return resp_ok({'exists': False})
    rows = _fetch_all("SELECT model_id FROM fan_model WHERE model_name = :n LIMIT 1", {'n': name})
    return resp_ok({'exists': bool(rows)})

@data_mgmt_bp.get('/admin/api/data/model/detail')
def api_model_detail():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    try:
        mid = int(request.args.get('model_id') or 0)
    except Exception:
        mid = 0
    if mid <= 0:
        return resp_err('INVALID_INPUT', '缺少 model_id')
    rows = _fetch_all("""
        SELECT m.model_id, m.brand_id, m.model_name, m.max_speed, m.size, m.thickness, m.rgb_light,
               m.reference_price, m.comment, m.is_valid,
               b.brand_name_zh, b.brand_name_en
        FROM fan_model m
        LEFT JOIN fan_brand b ON b.brand_id = m.brand_id
        WHERE m.model_id = :mid
        LIMIT 1
    """, {'mid': mid})
    if not rows:
        return resp_err('NOT_FOUND', '未找到该型号', 404)
    r = rows[0]
    data = {
        'model_id': int(r['model_id']),
        'brand_id': int(r['brand_id']) if r['brand_id'] is not None else None,
        'brand_label': f"{(r.get('brand_name_zh') or '').strip()} / {(r.get('brand_name_en') or '').strip()}".strip(' /'),
        'model_name': r['model_name'],
        'max_speed': int(r['max_speed']) if r['max_speed'] is not None else None,
        'size': int(r['size']) if r['size'] is not None else None,
        'thickness': int(r['thickness']) if r['thickness'] is not None else None,
        'rgb_light': r['rgb_light'],
        'reference_price': float(r['reference_price']) if r['reference_price'] is not None else None,
        'comment': r['comment'] or '',
        'is_valid': int(r['is_valid'] or 0)
    }
    return resp_ok(data)

@data_mgmt_bp.post('/admin/api/data/model/update')
def api_model_update():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    data = request.get_json(force=True, silent=True) or {}
    try:
        model_id = int(data.get('model_id') or 0)
    except Exception:
        return resp_err('INVALID_INPUT', 'ID参数格式错误')

    model_name = (data.get('model_name') or '').strip()
    rgb_light = (data.get('rgb_light') or '无').strip()
    reference_price_raw = (data.get('reference_price') or '').strip()
    comment = (data.get('comment') or '').strip()
    try:
        is_valid = int(data.get('is_valid') if data.get('is_valid') in (0, 1, '0', '1') else 0)
    except Exception:
        is_valid = 0

    def _to_int(v, field):
        if v is None or str(v).strip() == '':
            raise ValueError(f'{field} 为必填')
        try:
            return int(str(v).strip())
        except Exception:
            raise ValueError(f'{field} 必须是整数')

    if model_id <= 0:
        return resp_err('INVALID_INPUT', '缺少 model_id')
    if not model_name:
        return resp_err('INVALID_INPUT', '型号为必填')

    try:
        max_speed = _to_int(data.get('max_speed'), '最大转速')
        size = _to_int(data.get('size'), '尺寸(mm)')
        thickness = _to_int(data.get('thickness'), '厚度(mm)')
        reference_price = None
        if reference_price_raw:
            reference_price = float(reference_price_raw)
    except ValueError as ve:
        return resp_err('INVALID_INPUT', str(ve))

    existed = _fetch_all("SELECT model_id FROM fan_model WHERE model_name = :n AND model_id <> :mid LIMIT 1", {'n': model_name, 'mid': model_id})
    if existed:
        return resp_err('MODEL_EXISTS', '已存在同名型号')

    try:
        with _engine().begin() as conn:
            conn.execute(text("""
                UPDATE fan_model
                SET model_name=:name, max_speed=:maxs, size=:size, thickness=:th,
                    rgb_light=:rgb, reference_price=:refp, comment=:cmt, is_valid=:valid
                WHERE model_id=:mid
            """), {
                'name': model_name,
                'maxs': max_speed,
                'size': size,
                'th': thickness,
                'rgb': rgb_light,
                'refp': reference_price,
                'cmt': (comment or None),
                'valid': is_valid,
                'mid': model_id
            })
    except Exception as e:
        return resp_err('DB_WRITE_FAIL', f'写入失败: {e}', 500)

    return resp_ok({'model_id': model_id}, message='更新成功')

@data_mgmt_bp.post('/admin/api/data/model/add')
def api_add_model():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    data = request.get_json(force=True, silent=True) or {}
    try:
        brand_id = int(data.get('brand_id') or 0)
    except Exception:
        brand_id = 0
    model_name = (data.get('model_name') or '').strip()
    rgb_light = (data.get('rgb_light') or '无').strip()
    reference_price_raw = (data.get('reference_price') or '').strip()
    comment = (data.get('comment') or '').strip()
    try:
        is_valid = int(data.get('is_valid') if data.get('is_valid') in (0, 1, '0', '1') else 0)
    except Exception:
        is_valid = 0

    def _to_int(v, field):
        if v is None or str(v).strip() == '':
            raise ValueError(f'{field} 为必填')
        try:
            return int(str(v).strip())
        except Exception:
            raise ValueError(f'{field} 必须是整数')

    try:
        if brand_id <= 0:
            return resp_err('INVALID_INPUT', '请先选择品牌')
        if not model_name:
            return resp_err('INVALID_INPUT', '型号为必填')
        max_speed = _to_int(data.get('max_speed'), '最大转速')
        size = _to_int(data.get('size'), '尺寸(mm)')
        thickness = _to_int(data.get('thickness'), '厚度(mm)')
        reference_price = None
        if reference_price_raw:
            reference_price = float(reference_price_raw)
    except ValueError as ve:
        return resp_err('INVALID_INPUT', str(ve))

    existed = _fetch_all("SELECT model_id FROM fan_model WHERE model_name = :n LIMIT 1", {'n': model_name})
    if existed:
        return resp_err('MODEL_EXISTS', '已存在该型号')

    try:
        with _engine().begin() as conn:
            r = conn.execute(text("""
                INSERT INTO fan_model
                (brand_id, model_name, max_speed, size, thickness, rgb_light, reference_price, comment, is_valid)
                VALUES (:bid,:name,:maxs,:size,:th,:rgb,:refp,:cmt,:valid)
            """), {
                'bid': brand_id,
                'name': model_name,
                'maxs': max_speed,
                'size': size,
                'th': thickness,
                'rgb': rgb_light,
                'refp': reference_price,
                'cmt': (comment or None),
                'valid': is_valid
            })
            mid = r.lastrowid
    except Exception as e:
        return resp_err('DB_WRITE_FAIL', f'写入失败: {e}', 500)

    return resp_ok({'model_id': mid}, message=f'添加成功，model_id：{mid}')

# 修改：添加工况 —— 不再插入 resistance_location_en，由数据库根据中文位置自动生成
@data_mgmt_bp.post('/admin/api/data/condition/add')
def api_add_condition():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    data = request.get_json(force=True, silent=True) or {}
    name_zh = (data.get('condition_name_zh') or '').strip()
    rt_zh = (data.get('resistance_type_zh') or '').strip()
    rt_en = (data.get('resistance_type_en') or '').strip()
    loc_zh = (data.get('resistance_location_zh') or '').strip()  # '出风' | '进风'
    try:
        is_valid = int(data.get('is_valid') if data.get('is_valid') in (0, 1, '0', '1') else 0)
    except Exception:
        is_valid = 0

    if not name_zh or not rt_zh or not rt_en or not loc_zh:
        return resp_err('INVALID_INPUT', '工况名称、风阻类型中文/英文与风阻位置均为必填')

    # 工况名称唯一
    existed_name = _fetch_all("""
        SELECT condition_id FROM working_condition WHERE condition_name_zh = :n LIMIT 1
    """, {'n': name_zh})
    if existed_name:
        return resp_err('CONDITION_NAME_EXISTS', '该工况名称已存在')

    # 组合唯一：风阻类型中文 + 风阻位置
    existed_comb = _fetch_all("""
        SELECT condition_id FROM working_condition
        WHERE resistance_type_zh = :tzh AND resistance_location_zh = :lzh
        LIMIT 1
    """, {'tzh': rt_zh, 'lzh': loc_zh})
    if existed_comb:
        return resp_err('CONDITION_COMB_EXISTS', '已存在该组合')

    # 位置取值校验
    if loc_zh not in ('出风', '进风'):
        return resp_err('INVALID_INPUT', '风阻位置仅支持 出风/进风')

    try:
        with _engine().begin() as conn:
            r = conn.execute(text("""
                INSERT INTO working_condition
                (condition_name_zh, resistance_type_zh, resistance_type_en,
                 resistance_location_zh, is_valid)
                VALUES (:name, :tzh, :ten, :lzh, :v)
            """), {'name': name_zh, 'tzh': rt_zh, 'ten': rt_en, 'lzh': loc_zh, 'v': is_valid})
            cid = r.lastrowid
    except Exception as e:
        return resp_err('DB_WRITE_FAIL', f'写入失败: {e}', 500)

    return resp_ok({'condition_id': cid}, message=f'添加成功，condition_id：{cid}')

# 修改：编辑页下拉 —— 不再查询/显示 resistance_location_en
@data_mgmt_bp.get('/admin/api/data/condition/types')
def api_condition_types():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    rows = _fetch_all("""
        SELECT condition_id, condition_name_zh, resistance_type_zh, resistance_type_en,
               resistance_location_zh
        FROM working_condition
        ORDER BY condition_name_zh, resistance_type_zh, resistance_location_zh
        LIMIT 500
    """)
    items = [{
        'condition_id': int(r['condition_id']),
        'name_zh': r['condition_name_zh'],
        'type_zh': r['resistance_type_zh'],
        'type_en': r['resistance_type_en'],
        'loc_zh': r['resistance_location_zh'],
        # 标签：工况名称 - 类型中/英 - 位置（中文）
        'label': " - ".join([
            (r['condition_name_zh'] or '').strip(),
            f"{(r['resistance_type_zh'] or '').strip()} / {(r['resistance_type_en'] or '').strip()}".strip(' /'),
            (r['resistance_location_zh'] or '').strip()
        ]).strip(' -')
    } for r in rows]
    return resp_ok({'items': items})

# 新增：获取单条工况详情（按 condition_id）
@data_mgmt_bp.get('/admin/api/data/condition/detail')
def api_condition_detail():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    try:
        cid = int(request.args.get('condition_id') or 0)
    except Exception:
        cid = 0
    if cid <= 0:
        return resp_err('INVALID_INPUT', '缺少 condition_id')

    rows = _fetch_all("""
        SELECT condition_id, condition_name_zh, resistance_type_zh, resistance_type_en,
               resistance_location_zh, resistance_location_en, COALESCE(is_valid,0) AS is_valid
        FROM working_condition
        WHERE condition_id = :cid
        LIMIT 1
    """, {'cid': cid})
    if not rows:
        return resp_err('NOT_FOUND', '未找到该工况', 404)
    r = rows[0]
    return resp_ok({
        'condition_id': int(r['condition_id']),
        'condition_name_zh': r['condition_name_zh'],
        'resistance_type_zh': r['resistance_type_zh'],
        'resistance_type_en': r['resistance_type_en'],
        'resistance_location_zh': r['resistance_location_zh'],
        'resistance_location_en': r['resistance_location_en'],
        'is_valid': int(r['is_valid'] or 0)
    })

# 修改：上传测试数据页的工况下拉项标签为“名称 - 类型中文 - 位置中文”
@data_mgmt_bp.get('/admin/api/data/conditions/all')
def api_conditions_all():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    rows = _fetch_all("""
        SELECT condition_id, condition_name_zh, resistance_type_zh, resistance_location_zh
        FROM working_condition
        ORDER BY condition_name_zh, resistance_type_zh, resistance_location_zh
    """)
    items = [{
        'condition_id': int(r['condition_id']),
        'label': " - ".join([
            (r.get('condition_name_zh') or '').strip(),
            (r.get('resistance_type_zh') or '').strip(),
            (r.get('resistance_location_zh') or '').strip()
        ]).strip(' -')
    } for r in rows]
    return resp_ok({'items': items})

# 修改：更新工况 —— 不再更新 resistance_location_en，由数据库自动生成
@data_mgmt_bp.post('/admin/api/data/condition/update')
def api_condition_update():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    payload = request.get_json(force=True, silent=True) or {}
    try:
        cid = int(payload.get('condition_id') or 0)
    except Exception:
        cid = 0
    name_zh = (payload.get('condition_name_zh') or '').strip()
    tzh = (payload.get('resistance_type_zh') or '').strip()
    ten = (payload.get('resistance_type_en') or '').strip()
    loc_zh = (payload.get('resistance_location_zh') or '').strip()
    try:
        is_valid = int(payload.get('is_valid') if payload.get('is_valid') in (0,1,'0','1') else 0)
    except Exception:
        is_valid = 0

    if cid <= 0:
        return resp_err('INVALID_INPUT', '缺少 condition_id')
    if not name_zh or not tzh or not ten or not loc_zh:
        return resp_err('INVALID_INPUT', '工况名称、风阻类型中文/英文与风阻位置均为必填')

    # 名称唯一（排除自身）
    existed_name = _fetch_all("""
        SELECT condition_id FROM working_condition
        WHERE condition_name_zh = :n AND condition_id <> :cid
        LIMIT 1
    """, {'n': name_zh, 'cid': cid})
    if existed_name:
        return resp_err('CONDITION_NAME_EXISTS', '该工况名称已存在')

    # 组合唯一：类型中文 + 位置（排除自身）
    existed_comb = _fetch_all("""
        SELECT condition_id FROM working_condition
        WHERE resistance_type_zh = :tzh AND resistance_location_zh = :lzh AND condition_id <> :cid
        LIMIT 1
    """, {'tzh': tzh, 'lzh': loc_zh, 'cid': cid})
    if existed_comb:
        return resp_err('CONDITION_COMB_EXISTS', '已存在该组合')

    if loc_zh not in ('出风', '进风'):
        return resp_err('INVALID_INPUT', '风阻位置仅支持 出风/进风')

    try:
        with _engine().begin() as conn:
            conn.execute(text("""
                UPDATE working_condition
                SET condition_name_zh=:name,
                    resistance_type_zh=:tzh,
                    resistance_type_en=:ten,
                    resistance_location_zh=:lzh,
                    is_valid=:v
                WHERE condition_id=:cid
            """), {'name': name_zh, 'tzh': tzh, 'ten': ten, 'lzh': loc_zh, 'v': is_valid, 'cid': cid})
    except Exception as e:
        return resp_err('DB_WRITE_FAIL', f'写入失败: {e}', 500)

    return resp_ok({'condition_id': cid}, message='更新成功')

@data_mgmt_bp.post('/admin/api/data/condition/type-update')
def api_condition_type_update():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    payload = request.get_json(force=True, silent=True) or {}
    new_name = (payload.get('condition_name_zh') or '').strip()
    new_zh = (payload.get('resistance_type_zh') or '').strip()
    new_en = (payload.get('resistance_type_en') or '').strip()
    outlet = payload.get('outlet') or {}
    inlet = payload.get('inlet') or {}
    try:
        out_id = int(outlet.get('condition_id') or 0)
        in_id = int(inlet.get('condition_id') or 0)
        out_valid = int(outlet.get('is_valid') if outlet.get('is_valid') in (0,1,'0','1') else 0)
        in_valid = int(inlet.get('is_valid') if inlet.get('is_valid') in (0,1,'0','1') else 0)
    except Exception:
        return resp_err('INVALID_INPUT', '参数格式错误')

    if out_id <= 0 and in_id <= 0:
        return resp_err('INVALID_INPUT', '缺少可更新的记录ID')
    if not new_name or not new_zh or not new_en:
        return resp_err('INVALID_INPUT', '工况名称、风阻类型中文与英文均为必填')

    # 重名检查：工况名称或类型中/英任一重名即冲突（排除被更新的自身 ID）
    existed = _fetch_all("""
        SELECT condition_id FROM working_condition
        WHERE condition_name_zh = :name OR resistance_type_zh = :zh OR resistance_type_en = :en
    """, {'name': new_name, 'zh': new_zh, 'en': new_en})
    provided_ids = set([i for i in (out_id, in_id) if i > 0])
    conflict = any(int(r['condition_id']) not in provided_ids for r in existed)
    if conflict:
        return resp_err('CONDITION_EXISTS', '已存在同名工况或风阻类型（中文或英文）')

    try:
        with _engine().begin() as conn:
            ids_to_update = [i for i in (out_id, in_id) if i > 0]
            if ids_to_update:
                # 同步更新名称与类型字段
                placeholders = ','.join([':id'+str(i) for i in range(len(ids_to_update))])
                params = {'name': new_name, 'zh': new_zh, 'en': new_en, **{('id'+str(i)): ids_to_update[i] for i in range(len(ids_to_update))}}
                conn.execute(text(f"""
                    UPDATE working_condition
                    SET condition_name_zh = :name, resistance_type_zh = :zh, resistance_type_en = :en
                    WHERE condition_id IN ({placeholders})
                """), params)

            if out_id > 0:
                conn.execute(text("""UPDATE working_condition SET is_valid=:v WHERE condition_id=:id"""),
                             {'v': out_valid, 'id': out_id})
            if in_id > 0:
                conn.execute(text("""UPDATE working_condition SET is_valid=:v WHERE condition_id=:id"""),
                             {'v': in_valid, 'id': in_id})
    except Exception as e:
        return resp_err('DB_WRITE_FAIL', f'写入失败: {e}', 500)

    return resp_ok({'outlet_id': out_id or None, 'inlet_id': in_id or None}, message='更新成功')

# ========== 测试数据上传（原有） ==========
@data_mgmt_bp.get('/admin/api/data/perf/check')
def api_perf_check():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    try:
        mid = int(request.args.get('model_id') or 0)
        cid = int(request.args.get('condition_id') or 0)
    except Exception:
        return resp_err('INVALID_INPUT', '参数格式错误')
    if mid <= 0 or cid <= 0:
        return resp_err('INVALID_INPUT', '缺少 model_id 或 condition_id')

    any_rows = _fetch_all("""
        SELECT 1
        FROM fan_performance_data
        WHERE model_id=:m AND condition_id=:c
        LIMIT 1
    """, {'m': mid, 'c': cid})

    active = _fetch_all("""
        SELECT DISTINCT batch_id
        FROM fan_performance_data
        WHERE model_id=:m AND condition_id=:c AND is_valid=1
        LIMIT 1
    """, {'m': mid, 'c': cid})

    return resp_ok({
        'exists': bool(any_rows),
        'active_group_key': (active[0]['batch_id'] if active else None)
    })

@data_mgmt_bp.get('/admin/api/data/perf/groups')
def api_perf_groups():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    try:
        mid = int(request.args.get('model_id') or 0)
        cid = int(request.args.get('condition_id') or 0)
    except Exception:
        return resp_err('INVALID_INPUT', '参数格式错误')
    if mid <= 0 or cid <= 0:
        return resp_err('INVALID_INPUT', '缺少 model_id 或 condition_id')

    rows = _fetch_all("""
        SELECT
          batch_id,
          MIN(create_date) AS create_date,
          SUM(CASE WHEN is_valid=1 THEN 1 ELSE 0 END) AS valid_rows,
          COUNT(*) AS row_count
        FROM fan_performance_data
        WHERE model_id=:m AND condition_id=:c
        GROUP BY batch_id
        ORDER BY create_date DESC
    """, {'m': mid, 'c': cid})

    groups = [{
        'group_key': r['batch_id'],
        'create_date': r['create_date'].strftime('%Y-%m-%d %H:%M:%S') if hasattr(r['create_date'], 'strftime') else str(r['create_date']),
        'is_valid': 1 if int(r['valid_rows'] or 0) > 0 else 0,
        'row_count': int(r['row_count'] or 0),
    } for r in rows]

    active_key = None
    for g in groups:
        if g['is_valid'] == 1:
            active_key = g['group_key']
            break

    return resp_ok({'groups': groups, 'active_group_key': active_key})

@data_mgmt_bp.get('/admin/api/data/perf/group-rows')
def api_perf_group_rows():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    try:
        mid = int(request.args.get('model_id') or 0)
        cid = int(request.args.get('condition_id') or 0)
    except Exception:
        return resp_err('INVALID_INPUT', '参数格式错误')
    batch_id = (request.args.get('group_key') or '').strip()
    if not batch_id:
        batch_id = (request.args.get('batch_id') or '').strip()
    if not batch_id:
        return resp_err('INVALID_INPUT', '缺少 batch_id')

    rows = _fetch_all("""
        SELECT data_id, model_id, condition_id, batch_id,
               DATE_FORMAT(create_date, '%Y-%m-%d %H:%i:%s') AS create_date,
               DATE_FORMAT(update_date, '%Y-%m-%d %H:%i:%s') AS update_date,
               rpm, airflow_cfm, noise_db, is_valid
        FROM fan_performance_data
        WHERE model_id=:m AND condition_id=:c AND batch_id=:bid
        ORDER BY rpm
    """, {'m': mid, 'c': cid, 'bid': batch_id})

    if not rows:
        return resp_err('NOT_FOUND', '未找到该组数据', 404)

    active = any(int(r['is_valid'] or 0) == 1 for r in rows)
    return resp_ok({
        'rows': rows,
        'group_key': batch_id,
        'group_is_valid': 1 if active else 0
    })

@data_mgmt_bp.get('/admin/api/data/condition/name-exist')
def api_condition_name_exist():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    name = (request.args.get('name') or '').strip()
    try:
        exclude_id = int(request.args.get('exclude_id') or 0)
    except Exception:
        exclude_id = 0
    if not name:
        return resp_ok({'exists': False})
    rows = _fetch_all("""
        SELECT condition_id FROM working_condition
        WHERE condition_name_zh = :n {exclude}
        LIMIT 1
    """.format(exclude="AND condition_id <> :eid" if exclude_id > 0 else ""),
        {'n': name, 'eid': exclude_id} if exclude_id > 0 else {'n': name}
    )
    return resp_ok({'exists': bool(rows)})

# 新增：风阻类型中文 + 风阻位置 组合唯一性校验
@data_mgmt_bp.get('/admin/api/data/condition/comb-exist')
def api_condition_comb_exist():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    tzh = (request.args.get('type_zh') or '').strip()
    loc_zh = (request.args.get('location_zh') or '').strip()
    try:
        exclude_id = int(request.args.get('exclude_id') or 0)
    except Exception:
        exclude_id = 0
    if not tzh or not loc_zh:
        return resp_ok({'exists': False})
    rows = _fetch_all("""
        SELECT condition_id FROM working_condition
        WHERE resistance_type_zh = :tzh AND resistance_location_zh = :lzh {exclude}
        LIMIT 1
    """.format(exclude="AND condition_id <> :eid" if exclude_id > 0 else ""),
        {'tzh': tzh, 'lzh': loc_zh, 'eid': exclude_id} if exclude_id > 0 else {'tzh': tzh, 'lzh': loc_zh}
    )
    return resp_ok({'exists': bool(rows)})

# 新增：批量管理 - 型号候选（支持多品牌过滤与关键字，默认限制返回200条）
@data_mgmt_bp.get('/admin/api/data/batch/models')
def api_batch_models():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    q = (request.args.get('q') or '').strip()
    # 支持 brand_ids=1,2 或 brand_ids[]=1&brand_ids[]=2 两种形式
    raw_ids = request.args.getlist('brand_ids') or request.args.getlist('brand_ids[]')
    if not raw_ids:
        one = request.args.get('brand_ids')
        if one:
            raw_ids = one.split(',')
    brand_ids = []
    for x in raw_ids or []:
        try:
            brand_ids.append(int(str(x).strip()))
        except Exception:
            pass
    try:
        limit = int(request.args.get('limit') or 200)
    except Exception:
        limit = 200
    if limit <= 0 or limit > 500:
        limit = 200

    where = []
    params = {}
    if q:
        where.append("m.model_name LIKE :q")
        params['q'] = f"%{q}%"
    if brand_ids:
        marks = ','.join([f":b{i}" for i in range(len(brand_ids))])
        where.append(f"m.brand_id IN ({marks})")
        for i, bid in enumerate(brand_ids):
            params[f"b{i}"] = bid

    sql = f"""
        SELECT m.model_id, m.model_name, m.brand_id, COALESCE(m.is_valid,0) AS is_valid,
               b.brand_name_zh, b.brand_name_en
        FROM fan_model m
        LEFT JOIN fan_brand b ON b.brand_id = m.brand_id
        {"WHERE " + " AND ".join(where) if where else ""}
        ORDER BY m.model_name
        LIMIT :lim
    """
    params['lim'] = limit
    rows = _fetch_all(sql, params)
    items = [{
        'model_id': int(r['model_id']),
        'model_name': r['model_name'],
        'brand_id': int(r['brand_id']),
        'brand_label': f"{(r.get('brand_name_zh') or '').strip()} / {(r.get('brand_name_en') or '').strip()}".strip(' /'),
        'is_valid': int(r.get('is_valid') or 0)
    } for r in rows]
    return resp_ok({'items': items})

# 新增：批量管理 - 批次搜索（默认按 create_date 倒序分页）
@data_mgmt_bp.post('/admin/api/data/batch/search')
def api_batch_search():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    payload = request.get_json(force=True, silent=True) or {}

    def _ints(lst):
        out = []
        for x in lst or []:
            try:
                out.append(int(x))
            except Exception:
                try:
                    out.append(int(str(x).strip()))
                except Exception:
                    pass
        return out

    brand_ids = _ints(payload.get('brand_ids') or [])
    model_ids = _ints(payload.get('model_ids') or [])
    condition_ids = _ints(payload.get('condition_ids') or [])
    is_valid_list = payload.get('is_valid')
    if is_valid_list is None:
        is_valid_list = [0, 1]
    is_valid_list = [int(v) for v in is_valid_list if str(v) in ('0', '1', 0, 1)]

    date_from = (payload.get('date_from') or '').strip()
    date_to = (payload.get('date_to') or '').strip()
    # 若前端未传，默认近7天
    if not date_from or not date_to:
        rows = _fetch_all("SELECT DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 7 DAY), '%Y-%m-%d 00:00:00') AS df, DATE_FORMAT(NOW(), '%Y-%m-%d 23:59:59') AS dt")
        date_from = rows[0]['df']; date_to = rows[0]['dt']

    try:
        page = int(payload.get('page') or 1)
        size = int(payload.get('page_size') or 50)
    except Exception:
        page, size = 1, 50
    page = max(1, page); size = max(1, min(200, size))
    offset = (page - 1) * size

    # 构建 SQL（当存在品牌筛选时，显式 join fan_model 以使用 brand_id）
    base_from = " FROM data_by_batch_view v "
    where = ["v.create_date BETWEEN :df AND :dt"]
    params = {'df': date_from, 'dt': date_to}

    if model_ids:
        marks = ','.join([f":m{i}" for i in range(len(model_ids))])
        where.append(f"v.model_id IN ({marks})")
        for i, mid in enumerate(model_ids):
            params[f"m{i}"] = mid
    if condition_ids:
        marks = ','.join([f":c{i}" for i in range(len(condition_ids))])
        where.append(f"v.condition_id IN ({marks})")
        for i, cid in enumerate(condition_ids):
            params[f"c{i}"] = cid
    if is_valid_list and len(is_valid_list) in (1, 2) and len(is_valid_list) != 2:
        where.append("v.is_valid = :iv")
        params['iv'] = int(is_valid_list[0])

    if brand_ids:
        base_from += " JOIN fan_model m ON m.model_id = v.model_id "
        marks = ','.join([f":b{i}" for i in range(len(brand_ids))])
        where.append(f"m.brand_id IN ({marks})")
        for i, bid in enumerate(brand_ids):
            params[f"b{i}"] = bid

    where_sql = " WHERE " + " AND ".join(where) if where else ""

    # 统计总数
    total_row = _fetch_all(f"SELECT COUNT(1) AS cnt {base_from} {where_sql}", params)
    total = int(total_row[0]['cnt'] if total_row else 0)

    # 拉取数据
    rows = _fetch_all(f"""
        SELECT
          v.batch_id, v.model_id, v.condition_id, COALESCE(v.is_valid,0) AS is_valid,
          v.brand_name_zh, v.model_name, v.condition_name_zh,
          v.data_count, DATE_FORMAT(v.create_date, '%Y-%m-%d %H:%i') AS create_date
        {base_from}
        {where_sql}
        ORDER BY v.create_date DESC
        LIMIT :lim OFFSET :off
    """, {**params, 'lim': size, 'off': offset})

    items = []
    for r in rows:
        items.append({
            'batch_id': r['batch_id'],
            'model_id': int(r['model_id']),
            'condition_id': int(r['condition_id']),
            'is_valid': int(r.get('is_valid') or 0),
            'brand_name': r.get('brand_name_zh') or '',
            'model_name': r.get('model_name') or '',
            'condition_name': r.get('condition_name_zh') or '',
            'data_count': int(r.get('data_count') or 0),
            'create_date': r.get('create_date')
        })
    return resp_ok({'items': items, 'page': page, 'page_size': size, 'total': total})

# 新增：批量管理 - 批量更新 is_valid（逐批事务，失败跳过并返回原因）
@data_mgmt_bp.post('/admin/api/data/batch/update-state')
def api_batch_update_state():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    payload = request.get_json(force=True, silent=True) or {}
    batch_ids = payload.get('batch_ids') or []
    try:
        target = int(payload.get('target_is_valid') if payload.get('target_is_valid') in (0, 1, '0', '1') else 0)
    except Exception:
        return resp_err('INVALID_INPUT', 'target_is_valid 非法')
    desc = (payload.get('description') or '').strip()

    if not batch_ids or not isinstance(batch_ids, list):
        return resp_err('INVALID_INPUT', '缺少 batch_ids')
    if desc == '':
        return resp_err('INVALID_INPUT', '更新描述必填')

    updated_success = []
    unchanged = []
    updated_failed = []  # {batch_id, reason}

    for bid in batch_ids:
        bid_s = str(bid).strip()
        if not bid_s:
            continue
        try:
            # 每个批次单独事务，保证“部分成功、部分失败”
            with _engine().begin() as conn:
                # 获取该批次的 model_id/condition_id 以及当前是否有对外行
                meta = conn.execute(text("""
                    SELECT model_id, condition_id,
                           SUM(CASE WHEN is_valid=1 THEN 1 ELSE 0 END) AS active_rows
                    FROM fan_performance_data
                    WHERE batch_id=:bid
                    GROUP BY model_id, condition_id
                    LIMIT 1
                """), {'bid': bid_s}).fetchone()
                if not meta:
                    unchanged.append(bid_s)
                    continue
                model_id = int(meta._mapping['model_id'])
                condition_id = int(meta._mapping['condition_id'])

                # 仅在状态发生变化时更新
                res = conn.execute(text("""
                    UPDATE fan_performance_data
                    SET is_valid=:v, update_date=NOW()
                    WHERE batch_id=:bid AND is_valid<>:v
                """), {'v': target, 'bid': bid_s})

                if (res.rowcount or 0) > 0:
                    action = 'batch_activate' if target == 1 else 'batch_close'
                    conn.execute(text("""
                        INSERT INTO data_update_log (model_id, condition_id, affected_batch, is_valid, action, description)
                        VALUES (:m, :c, :bid, :v, :act, :desc)
                    """), {'m': model_id, 'c': condition_id, 'bid': bid_s, 'v': target, 'act': action, 'desc': desc})
                    updated_success.append(bid_s)
                else:
                    # 没有实际变化（可能本就同状态）
                    unchanged.append(bid_s)
        except Exception as e:
            updated_failed.append({'batch_id': bid_s, 'reason': str(e)})

    return resp_ok({
        'updated_success': updated_success,
        'unchanged': unchanged,
        'updated_failed': updated_failed
    }, message=('部分条目更新状态失败' if updated_failed else '批量更新完成'))

# 新增：批量管理 - 批次状态确认（按 batch_id 列表返回 is_valid 与 create_date）
@data_mgmt_bp.post('/admin/api/data/batch/status')
def api_batch_status():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    payload = request.get_json(force=True, silent=True) or {}
    batch_ids = payload.get('batch_ids') or []
    if not batch_ids or not isinstance(batch_ids, list):
        return resp_err('INVALID_INPUT', '缺少 batch_ids')

    # 动态 IN 占位
    bset = []
    params = {}
    for i, bid in enumerate(batch_ids):
        key = f"b{i}"
        bset.append(f":{key}")
        params[key] = str(bid).strip()
    if not bset:
        return resp_ok({'items': []})

    rows = _fetch_all(f"""
        SELECT batch_id, COALESCE(is_valid,0) AS is_valid, DATE_FORMAT(create_date, '%Y-%m-%d %H:%i') AS create_date
        FROM data_by_batch_view
        WHERE batch_id IN ({",".join(bset)})
    """, params)
    items = [{
        'batch_id': r['batch_id'],
        'is_valid': int(r.get('is_valid') or 0),
        'create_date': r.get('create_date')
    } for r in rows]
    return resp_ok({'items': items})

@data_mgmt_bp.post('/admin/api/data/perf/group-edit')
def api_perf_group_edit():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    payload = request.get_json(force=True, silent=True) or {}
    try:
        model_id = int(payload.get('model_id') or 0)
        condition_id = int(payload.get('condition_id') or 0)
        desired_is_valid = int(payload.get('is_valid') if payload.get('is_valid') in (0, 1, '0', '1') else 0)
    except Exception:
        return resp_err('INVALID_INPUT', '参数格式错误')

    # 接收前端更新描述（用于“激活/关闭/替换时”的新批次记录）
    desc_front = (payload.get('description') or '').strip()

    batch_id = (payload.get('group_key') or '').strip()
    if not batch_id:
        batch_id = (payload.get('batch_id') or '').strip()
    changes = payload.get('changes') or []
    if model_id <= 0 or condition_id <= 0 or not batch_id:
        return resp_err('INVALID_INPUT', '缺少必要参数')

    chk = _fetch_all("""
        SELECT DISTINCT batch_id FROM fan_performance_data
        WHERE model_id=:m AND condition_id=:c AND is_valid=1
        LIMIT 1
    """, {'m': model_id, 'c': condition_id})
    active_key = chk[0]['batch_id'] if chk else None
    target_is_valid = 0 if (active_key and active_key != batch_id) else desired_is_valid

    updated_rows = 0
    state_changed_rows = 0

    with _engine().begin() as conn:
        # 数据补空（与 is_valid 无关）
        for ch in changes:
            try:
                did = int(ch.get('data_id'))
            except Exception:
                return resp_err('INVALID_CHANGE', '变更项 data_id 无效')

            cur = conn.execute(text("""
                SELECT data_id, airflow_cfm, noise_db
                FROM fan_performance_data
                WHERE data_id=:id AND model_id=:m AND condition_id=:c AND batch_id=:bid
                LIMIT 1
            """), {'id': did, 'm': model_id, 'c': condition_id, 'bid': batch_id}).fetchone()
            if not cur:
                return resp_err('INVALID_CHANGE', f'变更项 data_id 不在该组内: {did}')

            to_set_air = ch.get('airflow_cfm')
            to_set_noise = ch.get('noise_db')
            if to_set_air not in (None, ''):
                try:
                    to_set_air = float(str(to_set_air).strip())
                except Exception:
                    return resp_err('INVALID_CHANGE', f'data_id={did} airflow_cfm 非法')
                if to_set_air <= 0:
                    return resp_err('INVALID_CHANGE', f'data_id={did} airflow_cfm 必须>0')
            else:
                to_set_air = None
            if to_set_noise not in (None, ''):
                try:
                    to_set_noise = _round1(float(str(to_set_noise).strip()))
                except Exception:
                    return resp_err('INVALID_CHANGE', f'data_id={did} noise_db 非法')
            else:
                to_set_noise = None

            if to_set_air is not None:
                res = conn.execute(text("""
                    UPDATE fan_performance_data
                    SET airflow_cfm = :air, update_date = NOW()
                    WHERE data_id=:id AND airflow_cfm IS NULL
                """), {'air': to_set_air, 'id': did})
                updated_rows += res.rowcount or 0
            if to_set_noise is not None:
                res2 = conn.execute(text("""
                    UPDATE fan_performance_data
                    SET noise_db = :ndb, update_date = NOW()
                    WHERE data_id=:id AND noise_db IS NULL
                """), {'ndb': to_set_noise, 'id': did})
                updated_rows += res2.rowcount or 0

        if target_is_valid == 1:
            # 将要激活当前批次：找出将被关闭的其它对外批次
            prev_rows = conn.execute(text("""
                SELECT DISTINCT batch_id
                FROM fan_performance_data
                WHERE model_id=:m AND condition_id=:c AND is_valid=1 AND batch_id<>:bid
            """), {'m': model_id, 'c': condition_id, 'bid': batch_id}).fetchall()
            prev_batches = [ (getattr(r, '_mapping', None) and r._mapping.get('batch_id')) or r[0] for r in prev_rows ]

            # 为每个被替换的历史批次写一条 notice：replaced
            for old_bid in prev_batches:
                conn.execute(text("""
                    INSERT INTO data_update_log (model_id, condition_id, affected_batch, is_valid, action, description)
                    VALUES (:m, :c, :affected, 0, 'replaced', :desc)
                """), {
                    'm': model_id,
                    'c': condition_id,
                    'affected': old_bid,
                    'desc': batch_id  # 被哪个批次替换
                })

            # 关闭其它对外批次
            res_off = conn.execute(text("""
                UPDATE fan_performance_data
                SET is_valid=0, update_date=NOW()
                WHERE model_id=:m AND condition_id=:c AND is_valid=1 AND batch_id<>:bid
            """), {'m': model_id, 'c': condition_id, 'bid': batch_id})
            state_changed_rows += res_off.rowcount or 0

            # 将当前批次开启（仅 0->1）
            res_on = conn.execute(text("""
                UPDATE fan_performance_data
                SET is_valid=1, update_date=NOW()
                WHERE model_id=:m AND condition_id=:c AND batch_id=:bid AND is_valid=0
            """), {'m': model_id, 'c': condition_id, 'bid': batch_id})
            state_changed_rows += res_on.rowcount or 0

            # 若确有状态变更，记录当前批次激活 notice：activate
            if (res_on.rowcount or 0) > 0 or prev_batches:
                conn.execute(text("""
                    INSERT INTO data_update_log (model_id, condition_id, affected_batch, is_valid, action, description)
                    VALUES (:m, :c, :affected, 1, 'activate', :desc)
                """), {
                    'm': model_id,
                    'c': condition_id,
                    'affected': batch_id,
                    'desc': desc_front
                })
        else:
            # 关闭当前批次（仅 1->0）
            res_off_cur = conn.execute(text("""
                UPDATE fan_performance_data
                SET is_valid=0, update_date=NOW()
                WHERE model_id=:m AND condition_id=:c AND batch_id=:bid AND is_valid=1
            """), {'m': model_id, 'c': condition_id, 'bid': batch_id})
            state_changed_rows += res_off_cur.rowcount or 0

            # 仅当有实际状态变化时记录 close
            if (res_off_cur.rowcount or 0) > 0:
                conn.execute(text("""
                    INSERT INTO data_update_log (model_id, condition_id, affected_batch, is_valid, action, description)
                    VALUES (:m, :c, :affected, 0, 'close', :desc)
                """), {
                    'm': model_id,
                    'c': condition_id,
                    'affected': batch_id,
                    'desc': desc_front
                })

    return resp_ok(
        {
            'updated_rows': int(updated_rows),
            'state_changed_rows': int(state_changed_rows),
            'final_is_valid': int(target_is_valid)
        },
        message='编辑提交成功'
    )

@data_mgmt_bp.post('/admin/api/data/perf/add')
def api_perf_add():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    payload = request.get_json(force=True, silent=True) or {}
    try:
        model_id = int(payload.get('model_id') or 0)
        condition_id = int(payload.get('condition_id') or 0)
        is_valid = int(payload.get('is_valid') if payload.get('is_valid') in (0, 1, '0', '1') else 0)
    except Exception:
        return resp_err('INVALID_INPUT', 'ID或is_valid格式错误')
    
    # 必填：前端生成 batch_id（UUIDv4）
    batch_id = (payload.get('batch_id') or '').strip()
    try:
        parsed = uuid.UUID(batch_id, version=4)
        if str(parsed) != batch_id:
            raise ValueError()
    except Exception:
        return resp_err('INVALID_INPUT', 'batch_id 非法（需 UUIDv4）')
    # 全局唯一：任意 model/condition 下均不得重复
    try:
        with _engine().begin() as conn:
            dup = conn.execute(text("SELECT 1 FROM fan_performance_data WHERE batch_id=:bid LIMIT 1"),
                               {'bid': batch_id}).fetchone()
            if dup:
                return resp_err('BATCH_ID_EXISTS', 'batch_id 已存在')
    except Exception as e:
        return resp_err('DB_READ_FAIL', f'校验 batch_id 失败: {e}', 500)

    # 前端更新描述（用于新批次的 notice）
    desc_front = (payload.get('description') or '').strip()

    rows_in = payload.get('rows') or []
    if model_id <= 0 or condition_id <= 0:
        return resp_err('INVALID_INPUT', '缺少 model_id 或 condition_id')
    if not rows_in:
        return resp_err('INVALID_INPUT', '请至少录入一行数据')

    cleaned = []
    seen_rpm = set()
    try:
        for i, r in enumerate(rows_in, start=1):
            rpm = int(str(r.get('rpm')).strip())
            if rpm <= 0: raise ValueError(f'第{i}行：rpm 必须为>0的整数')
            if rpm in seen_rpm: raise ValueError(f'第{i}行：rpm 重复（同一提交内不允许重复）')
            seen_rpm.add(rpm)
            airflow = float(str(r.get('airflow_cfm')).strip())
            if airflow <= 0: raise ValueError(f'第{i}行：airflow_cfm 必须>0')
            noise_raw = r.get('noise_db'); noise_db = None
            if noise_raw not in (None, ''): noise_db = _round1(float(str(noise_raw).strip()))
            cleaned.append({'rpm': rpm, 'airflow_cfm': airflow, 'noise_db': noise_db})
    except Exception as e:
        return resp_err('INVALID_ROW', str(e))

    try:
        with _engine().begin() as conn:
            prev_batches = []
            if is_valid == 1:
                # 找出现有对外批次
                prev_rows = conn.execute(text("""
                    SELECT DISTINCT batch_id
                    FROM fan_performance_data
                    WHERE model_id=:m AND condition_id=:c AND is_valid=1
                """), {'m': model_id, 'c': condition_id}).fetchall()
                prev_batches = [ (getattr(r, '_mapping', None) and r._mapping.get('batch_id')) or r[0] for r in prev_rows ]

                # 先记录“被替换”的 notice：replaced
                for old_bid in prev_batches:
                    conn.execute(text("""
                        INSERT INTO data_update_log (model_id, condition_id, affected_batch, is_valid, action, description)
                        VALUES (:m, :c, :affected, 0, 'replaced', :desc)
                    """), {
                        'm': model_id,
                        'c': condition_id,
                        'affected': old_bid,
                        'desc': batch_id  # 被哪个新批次替换
                    })

                # 关闭旧批次
                conn.execute(text("""
                    UPDATE fan_performance_data
                    SET is_valid=0, update_date=NOW()
                    WHERE model_id=:m AND condition_id=:c AND is_valid=1
                """), {'m': model_id, 'c': condition_id})

            # 插入新批次（可能为草稿或对外）
            for r in cleaned:
                conn.execute(text("""
                    INSERT INTO fan_performance_data
                    (model_id, condition_id, batch_id, rpm, airflow_cfm, noise_db, is_valid)
                    VALUES (:mid,:cid,:bid,:rpm,:air,:ndb,:valid)
                """), {
                    'mid': model_id, 'cid': condition_id, 'bid': batch_id,
                    'rpm': r['rpm'], 'air': r['airflow_cfm'], 'ndb': r['noise_db'], 'valid': is_valid
                })

            # 写“新批次”的 notice：
            # - 若替换了旧批次：action='replace'
            # - 若无旧批次直接对外：action='upload'
            if is_valid == 1:
                action_value = 'replace' if prev_batches else 'upload'
                conn.execute(text("""
                    INSERT INTO data_update_log (model_id, condition_id, affected_batch, is_valid, action, description)
                    VALUES (:m, :c, :affected, 1, :action, :desc)
                """), {
                    'm': model_id,
                    'c': condition_id,
                    'affected': batch_id,
                    'action': action_value,
                    'desc': desc_front
                })
    except Exception as e:
        return resp_err('DB_WRITE_FAIL', f'写入失败: {e}', 500)

    return resp_ok({'inserted': len(cleaned), 'batch_id': batch_id}, message=f'成功插入 {len(cleaned)} 行')
