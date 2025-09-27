from __future__ import annotations
from typing import List, Dict, Tuple
from sqlalchemy import text


class FanRepository:
    def __init__(self, engine):
        self.engine = engine

    # --- helpers ---
    def _fetch_all(self, sql: str, params: dict | None = None) -> List[dict]:
        with self.engine.begin() as conn:
            rows = conn.execute(text(sql), params or {})
            return [dict(r._mapping) for r in rows]

    def _exec(self, sql: str, params: dict | None = None):
        with self.engine.begin() as conn:
            conn.execute(text(sql), params or {})

    # --- queries ---
    def fetch_infos_by_pairs(self, pairs: List[Tuple[int, int]]) -> List[dict]:
        if not pairs:
            return []
        conds, params = [], {}
        for i, (m, c) in enumerate(pairs, start=1):
            conds.append(f"(:m{i}, :c{i})")
            params[f"m{i}"] = int(m)
            params[f"c{i}"] = int(c)
        sql = f"""
          SELECT DISTINCT model_id, condition_id, brand_name_zh, model_name,
                          resistance_type_zh, resistance_location_zh
          FROM general_view
          WHERE (model_id, condition_id) IN ({",".join(conds)})
        """
        return self._fetch_all(sql, params)

    def fetch_res_locs_by_type(self, rt: str) -> List[str]:
        rows = self._fetch_all(
            "SELECT DISTINCT resistance_location_zh FROM general_view WHERE resistance_type_zh=:rt",
            {'rt': rt}
        )
        return [r['resistance_location_zh'] for r in rows]

    def fetch_top_queries(self, limit: int) -> List[dict]:
        sql = """SELECT brand_name_zh, model_name, resistance_type_zh, resistance_location_zh,
                        query_count, size, thickness, max_speed
                 FROM total_query_rank_d30
                 ORDER BY query_count DESC
                 LIMIT :l"""
        return self._fetch_all(sql, {'l': limit})

    def fetch_top_ratings(self, limit: int) -> List[dict]:
        sql = """SELECT brand_name_zh, model_name, resistance_type_zh, resistance_location_zh,
                        like_count, size, thickness, max_speed
                 FROM total_like_d30
                 ORDER BY like_count DESC
                 LIMIT :l"""
        return self._fetch_all(sql, {'l': limit})

    def fetch_all_res_types(self) -> List[str]:
        rows = self._fetch_all("SELECT DISTINCT resistance_type_zh FROM working_condition")
        return [r['resistance_type_zh'] for r in rows]

    def fetch_all_res_locs(self) -> List[str]:
        rows = self._fetch_all("SELECT DISTINCT resistance_location_zh FROM working_condition")
        return [r['resistance_location_zh'] for r in rows]

    def fetch_models_by_brand(self, brand: str) -> List[str]:
        sql = """SELECT DISTINCT m.model_name
                 FROM fan_model m JOIN fan_brand b ON b.brand_id=m.brand_id
                 WHERE b.brand_name_zh=:b"""
        rows = self._fetch_all(sql, {'b': brand})
        return [r['model_name'] for r in rows]

    def fetch_res_types_for_brand_model(self, brand: str, model: str) -> List[str]:
        sql = "SELECT DISTINCT resistance_type_zh FROM general_view WHERE brand_name_zh=:b AND model_name=:m"
        rows = self._fetch_all(sql, {'b': brand, 'm': model})
        return [r['resistance_type_zh'] for r in rows]

    def fetch_res_locs_for_bmr(self, brand: str, model: str, res_type: str) -> List[str]:
        sql = """SELECT DISTINCT resistance_location_zh
                 FROM general_view WHERE brand_name_zh=:b AND model_name=:m AND resistance_type_zh=:rt"""
        rows = self._fetch_all(sql, {'b': brand, 'm': model, 'rt': res_type})
        return [r['resistance_location_zh'] for r in rows]

    def fetch_distinct_pairs_for_add(self, brand: str, model: str,
                                     rt_filter: str | None, rl_filter: str | None) -> List[dict]:
        where = ["brand_name_zh=:b", "model_name=:m"]
        params = {'b': brand, 'm': model}
        if rt_filter:
            where.append("resistance_type_zh=:rt")
            params['rt'] = rt_filter
        if rl_filter is not None:
            s = str(rl_filter).strip()
            if s not in ('全部',):
                if s in ('', '无'):
                    where.append("COALESCE(NULLIF(TRIM(resistance_location_zh),''),'') = ''")
                else:
                    where.append("resistance_location_zh=:rl")
                    params['rl'] = s
        sql = f"""
          SELECT DISTINCT model_id, condition_id, brand_name_zh, model_name,
                          resistance_type_zh, resistance_location_zh
          FROM general_view
          WHERE {" AND ".join(where)}
        """
        return self._fetch_all(sql, params)

    def fetch_curve_points(self, pairs: List[Tuple[int, int]]) -> Dict[str, dict]:
        if not pairs:
            return {}
        conds, params = [], {}
        for i, (m, c) in enumerate(pairs, start=1):
            conds.append(f"(:m{i}, :c{i})")
            params[f"m{i}"] = int(m)
            params[f"c{i}"] = int(c)
        sql = f"""
          SELECT model_id, condition_id, brand_name_zh, model_name,
                 resistance_type_zh, resistance_location_zh,
                 rpm, airflow_cfm AS airflow, noise_db
          FROM general_view
          WHERE (model_id, condition_id) IN ({",".join(conds)})
          ORDER BY model_id, condition_id, rpm
        """
        rows = self._fetch_all(sql, params)
        bucket: Dict[str, dict] = {}
        for r in rows:
            key = f"{int(r['model_id'])}_{int(r['condition_id'])}"
            b = bucket.setdefault(key, {
                'rpm': [], 'airflow': [], 'noise_db': [], 'info': {
                    'brand': r['brand_name_zh'],
                    'model': r['model_name'],
                    'res_type': r['resistance_type_zh'],
                    'res_loc': r['resistance_location_zh'],
                    'model_id': int(r['model_id']),
                    'condition_id': int(r['condition_id'])
                }
            })
            rpm_v = r.get('rpm')
            airflow_v = r.get('airflow')
            noise_v = r.get('noise_db')
            if airflow_v is None:
                continue
            if rpm_v is None and noise_v is None:
                continue
            b['rpm'].append(rpm_v)
            b['airflow'].append(round(float(airflow_v), 1) if airflow_v is not None else None)
            b['noise_db'].append(noise_v)
        return bucket

    def fetch_user_likes(self, user_id: str, limit: int | None = None) -> List[dict]:
        sql = """
        SELECT user_identifier, model_id, condition_id, brand_name_zh, model_name,
               resistance_type_zh, resistance_location_zh, max_speed, size, thickness
        FROM user_likes_view
        WHERE user_identifier=:u
        """
        rows = self._fetch_all(sql, {'u': user_id})
        return rows if limit is None else rows[:limit]

    def fetch_user_like_keys(self, user_id: str) -> List[str]:
        recs = self.fetch_user_likes(user_id)
        return [f"{int(r['model_id'])}_{int(r['condition_id'])}" for r in recs]

    def search_fans(self, *, res_type: str, res_loc: str | None, sort_by: str, sort_value: float | None,
                    size_filter: str | None, thickness_min: int, thickness_max: int, limit: int = 200) -> List[dict]:
        parts = [
            "SELECT brand_name_zh, model_name, resistance_type_zh, resistance_location_zh,",
            "MAX(airflow_cfm) AS max_airflow, size, thickness, MAX(rpm) AS max_speed,",
            "MAX(COALESCE(like_count,0)) AS like_count, NULL AS constraint_value, '无' AS constraint_type",
            "FROM general_view",
            "WHERE resistance_type_zh=:rt"
        ]
        params = {'rt': res_type, 'limit': limit}
        if res_loc is not None:
            s = str(res_loc).strip()
            if s not in ('全部',):
                if s in ('', '无'):
                    parts.append("AND COALESCE(NULLIF(TRIM(resistance_location_zh),''),'') = ''")
                else:
                    parts.append("AND resistance_location_zh=:rl")
                    params['rl'] = s
        if size_filter and size_filter != '不限':
            parts.append("AND size=:sz")
            params['sz'] = int(size_filter)
        if thickness_min is not None and thickness_max is not None:
            parts.append("AND thickness BETWEEN :tmin AND :tmax")
            params.update(tmin=int(thickness_min), tmax=int(thickness_max))
        if sort_by == 'rpm':
            parts.append("AND rpm <= :sv")
            params['sv'] = float(sort_value)
        elif sort_by == 'noise':
            parts.append("AND noise_db <= :sv")
            params['sv'] = float(sort_value)
        parts.append("GROUP BY brand_name_zh, model_name, resistance_type_zh, resistance_location_zh, size, thickness")
        parts.append("ORDER BY max_airflow DESC LIMIT :limit")
        return self._fetch_all("\n".join(parts), params)
