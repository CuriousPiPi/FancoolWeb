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

# ========== 工况相关 ==========
@data_mgmt_bp.post('/admin/api/data/condition/add')
def api_add_condition():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    data = request.get_json(force=True, silent=True) or {}
    rt_zh = (data.get('resistance_type_zh') or '').strip()
    rt_en = (data.get('resistance_type_en') or '').strip()
    try:
        is_valid = int(data.get('is_valid') if data.get('is_valid') in (0, 1, '0', '1') else 0)
    except Exception:
        is_valid = 0
    if not rt_zh or not rt_en:
        return resp_err('INVALID_INPUT', '风阻类型中文与英文均为必填')

    existed = _fetch_all("""
        SELECT condition_id FROM working_condition
        WHERE resistance_type_zh = :zh OR resistance_type_en = :en
        LIMIT 1
    """, {'zh': rt_zh, 'en': rt_en})
    if existed:
        return resp_err('CONDITION_EXISTS', '该风阻类型已存在')

    try:
        with _engine().begin() as conn:
            r1 = conn.execute(text("""
                INSERT INTO working_condition
                (resistance_type_zh,resistance_type_en,resistance_location_zh,resistance_location_en,is_valid)
                VALUES (:tzh,:ten,'出风','Outlet',:v)
            """), {'tzh': rt_zh, 'ten': rt_en, 'v': is_valid})
            id_out = r1.lastrowid
            r2 = conn.execute(text("""
                INSERT INTO working_condition
                (resistance_type_zh,resistance_type_en,resistance_location_zh,resistance_location_en,is_valid)
                VALUES (:tzh,:ten,'进风','Inlet',:v)
            """), {'tzh': rt_zh, 'ten': rt_en, 'v': is_valid})
            id_in = r2.lastrowid
    except Exception as e:
        return resp_err('DB_WRITE_FAIL', f'写入失败: {e}', 500)

    return resp_ok({'condition_ids': [id_out, id_in]}, message=f'添加成功，condition_id：{id_out}, {id_in}')

@data_mgmt_bp.get('/admin/api/data/conditions/all')
def api_conditions_all():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    rows = _fetch_all("""
        SELECT condition_id, resistance_type_zh, resistance_location_zh
        FROM working_condition
        ORDER BY resistance_type_zh, resistance_location_zh
    """)
    items = [{'condition_id': int(r['condition_id']), 'label': f"{r['resistance_type_zh']} - {r['resistance_location_zh']}"} for r in rows]
    return resp_ok({'items': items})

@data_mgmt_bp.get('/admin/api/data/condition/types')
def api_condition_types():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    rows = _fetch_all("""
        SELECT resistance_type_zh, resistance_type_en
        FROM working_condition
        GROUP BY resistance_type_zh, resistance_type_en
        ORDER BY resistance_type_zh, resistance_type_en
    """)
    items = [{
        'type_zh': r['resistance_type_zh'],
        'type_en': r['resistance_type_en'],
        'label': f"{(r['resistance_type_zh'] or '').strip()} / {(r['resistance_type_en'] or '').strip()}".strip(' /')
    } for r in rows]
    return resp_ok({'items': items})

@data_mgmt_bp.get('/admin/api/data/condition/type-detail')
def api_condition_type_detail():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    tzh = (request.args.get('type_zh') or '').strip()
    ten = (request.args.get('type_en') or '').strip()
    if not tzh or not ten:
        return resp_err('INVALID_INPUT', '缺少风阻类型（中/英）')
    rows = _fetch_all("""
        SELECT condition_id, resistance_type_zh, resistance_type_en,
               resistance_location_zh, resistance_location_en, COALESCE(is_valid,0) AS is_valid
        FROM working_condition
        WHERE resistance_type_zh = :tzh AND resistance_type_en = :ten
        ORDER BY resistance_location_zh
        LIMIT 2
    """, {'tzh': tzh, 'ten': ten})
    if not rows:
        return resp_err('NOT_FOUND', '未找到该风阻类型', 404)

    # 判定是否为“空载/No Load”等不区分进/出风的特殊类型：
    # 条件：仅有1条记录，或位置字段为空/NULL
    single_mode = False
    single_row = None
    if len(rows) == 1:
        single_mode = True
        single_row = rows[0]
    else:
        # 若两条均无位置或任一条位置为空也视为单条（向后兼容）
        cand = next((r for r in rows if not (r.get('resistance_location_zh') or '').strip()), None)
        if cand:
            single_mode = True
            single_row = cand

    # 正常识别出风/进风
    out = next((r for r in rows if r.get('resistance_location_zh') == '出风'), None)
    inm = next((r for r in rows if r.get('resistance_location_zh') == '进风'), None)

    data = {
        'type_zh': tzh,
        'type_en': ten,
        'outlet': out and {
            'condition_id': int(out['condition_id']),
            'is_valid': int(out['is_valid'] or 0),
            'location_zh': out['resistance_location_zh'],
            'location_en': out['resistance_location_en']
        },
        'inlet': inm and {
            'condition_id': int(inm['condition_id']),
            'is_valid': int(inm['is_valid'] or 0),
            'location_zh': inm['resistance_location_zh'],
            'location_en': inm['resistance_location_en']
        },
        'single': 1 if single_mode else 0
    }
    if single_mode and single_row:
        data['single_condition'] = {
            'condition_id': int(single_row['condition_id']),
            'is_valid': int(single_row['is_valid'] or 0)
        }
        # 明确置空 outlet/inlet，避免前端误判
        data['outlet'] = None
        data['inlet'] = None

    return resp_ok(data)

@data_mgmt_bp.post('/admin/api/data/condition/type-update')
def api_condition_type_update():
    if not session.get('is_admin'):
        return resp_err('UNAUTHORIZED', '请先登录', 401)
    payload = request.get_json(force=True, silent=True) or {}
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
    if not new_zh or not new_en:
        return resp_err('INVALID_INPUT', '风阻类型中文与英文均为必填')

    # 重名检查（排除自身已提供的ID）
    existed = _fetch_all("""
        SELECT condition_id FROM working_condition
        WHERE resistance_type_zh = :zh OR resistance_type_en = :en
    """, {'zh': new_zh, 'en': new_en})
    provided_ids = set([i for i in (out_id, in_id) if i > 0])
    conflict = any(int(r['condition_id']) not in provided_ids for r in existed)
    if conflict:
        return resp_err('CONDITION_EXISTS', '已存在同名风阻类型（中文或英文）')

    try:
        with _engine().begin() as conn:
            ids_to_update = [i for i in (out_id, in_id) if i > 0]
            # 名称更新：仅更新实际提交的那几条
            conn.execute(text(f"""
                UPDATE working_condition
                SET resistance_type_zh = :zh, resistance_type_en = :en
                WHERE condition_id IN ({','.join([':id'+str(i) for i in range(len(ids_to_update))])})
            """), {'zh': new_zh, 'en': new_en, **{('id'+str(i)): ids_to_update[i] for i in range(len(ids_to_update))}})

            # 分别更新 is_valid（存在才更新）
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

    new_batch = str(uuid.uuid4())
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
                        'desc': new_batch  # 被哪个新批次替换
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
                    'mid': model_id, 'cid': condition_id, 'bid': new_batch,
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
                    'affected': new_batch,
                    'action': action_value,
                    'desc': desc_front
                })
    except Exception as e:
        return resp_err('DB_WRITE_FAIL', f'写入失败: {e}', 500)


    return resp_ok({'inserted': len(cleaned), 'batch_id': new_batch}, message=f'成功插入 {len(cleaned)} 行')