from flask import Blueprint, request, jsonify, current_app
from typing import List, Tuple, Dict

# 直接使用仓库层（原先 core.py 依赖 state_service 的逻辑全部移除）
from app.repositories.fan_repository import FanRepository

bp = Blueprint('core', __name__)

# 统一实例（简单方式：直接实例化；若已有全局单例也可以保持一致，这里直接创建）
_repo = FanRepository()


def _parse_pairs(raw) -> List[Tuple[int, int]]:
    pairs: List[Tuple[int, int]] = []
    if not isinstance(raw, list):
        return pairs
    for item in raw:
        if not isinstance(item, dict):
            continue
        try:
            m = int(item.get('model_id'))
            c = int(item.get('condition_id'))
            pairs.append((m, c))
        except Exception:
            continue
    return pairs


@bp.route('/api/curves_by_pairs', methods=['POST'])
def api_curves_by_pairs():
    """
    无状态曲线数据接口
    请求体:
      {
        "pairs": [
          {"model_id": 1, "condition_id": 10},
          ...
        ]
      }
    响应:
      {
        "success": true,
        "series": [
          {
            "key": "1_10",
            "brand": "...",
            "model": "...",
            "res_type": "...",
            "res_loc": "...",
            "model_id": 1,
            "condition_id": 10,
            "rpm": [...],
            "noise_db": [...],
            "airflow": [...]
          }, ...
        ]
      }
    """
    try:
        body = request.get_json(force=True) or {}
        pairs = _parse_pairs(body.get('pairs'))
        if not pairs:
            return jsonify({"success": True, "series": []})
        bucket = _repo.get_curves_for_pairs(pairs)
        series = []
        for key, pack in bucket.items():
            info = pack["info"]
            series.append({
                "key": key,
                "brand": info["brand"],
                "model": info["model"],
                "res_type": info["res_type"],
                "res_loc": info["res_loc"],
                "model_id": info["model_id"],
                "condition_id": info["condition_id"],
                "rpm": pack["rpm"],
                "noise_db": pack["noise_db"],
                "airflow": pack["airflow"]
            })
        return jsonify({"success": True, "series": series})
    except Exception as e:
        current_app.logger.exception(e)
        return jsonify({"success": False, "error": str(e)}), 500


@bp.route('/api/pairs_by_filters', methods=['POST'])
def api_pairs_by_filters():
    """
    级联或“全部添加”场景使用。
    请求体:
      {
        "brand": "...",
        "model": "...",
        "res_type": "全部" | "空载" | 具体类型 | "",
        "res_loc": "全部" | "无" | 具体位置 | ""
      }
    返回:
      {
        "success": true,
        "list": [
          {
            "model_id": 1,
            "condition_id": 10,
            "brand": "...",
            "model": "...",
            "res_type": "...",
            "res_loc": ""
          }, ...
        ]
      }
    """
    try:
        body = request.get_json(force=True) or {}
        brand = (body.get('brand') or '').strip()
        model = (body.get('model') or '').strip()
        res_type_raw = (body.get('res_type') or '').strip()
        res_loc_raw = (body.get('res_loc') or '').strip()

        if not brand or not model:
            return jsonify({"success": False, "error": "缺少 brand 或 model"})

        # 统一“全部”为空 => 让仓库层不加该条件
        res_type = None if (res_type_raw in ['', '全部']) else res_type_raw
        res_loc = None if (res_loc_raw in ['', '全部']) else res_loc_raw

        rows = _repo.get_distinct_pairs_for_add(
            brand=brand,
            model=model,
            res_type=res_type,
            res_loc=res_loc
        )
        out = []
        for r in rows:
            out.append({
                "model_id": int(r["model_id"]),
                "condition_id": int(r["condition_id"]),
                "brand": r["brand_name_zh"],
                "model": r["model_name"],
                "res_type": r["resistance_type_zh"],
                "res_loc": r["resistance_location_zh"] or ''
            })
        return jsonify({"success": True, "list": out})
    except Exception as e:
        current_app.logger.exception(e)
        return jsonify({"success": False, "error": str(e)}), 500
