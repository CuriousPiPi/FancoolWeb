from typing import List, Dict, Tuple
from .base import BaseRepository

class FanRepository(BaseRepository):

    # --- 基础信息与级联 ---

    def get_models_by_brand(self, brand: str) -> List[str]:
        sql = """SELECT DISTINCT m.model_name
                 FROM fan_model m
                 JOIN fan_brand b ON b.brand_id=m.brand_id
                 WHERE b.brand_name_zh=:b"""
        rows = self.fetch_all(sql, {'b': brand})
        return [r['model_name'] for r in rows]

    def get_res_types_by_brand_model(self, brand: str, model: str) -> List[str]:
        sql = """SELECT DISTINCT resistance_type_zh
                 FROM general_view
                 WHERE brand_name_zh=:b AND model_name=:m"""
        rows = self.fetch_all(sql, {'b': brand, 'm': model})
        return [r['resistance_type_zh'] for r in rows]

    def get_res_locs_by_bmr(self, brand:str, model:str, res_type:str) -> List[str]:
        sql = """SELECT DISTINCT resistance_location_zh
                 FROM general_view
                 WHERE brand_name_zh=:b AND model_name=:m AND resistance_type_zh=:rt"""
        rows = self.fetch_all(sql, {'b': brand, 'm': model, 'rt': res_type})
        return [r['resistance_location_zh'] for r in rows]

    def get_res_locs_by_res_type(self, res_type:str) -> List[str]:
        sql = "SELECT DISTINCT resistance_location_zh FROM general_view WHERE resistance_type_zh=:rt"
        rows = self.fetch_all(sql, {'rt': res_type})
        return [r['resistance_location_zh'] for r in rows]

    def get_all_res_types(self) -> List[str]:
        rows = self.fetch_all("SELECT DISTINCT resistance_type_zh FROM working_condition")
        return [r['resistance_type_zh'] for r in rows]

    def get_all_res_locs(self) -> List[str]:
        rows = self.fetch_all("SELECT DISTINCT resistance_location_zh FROM working_condition")
        return [r['resistance_location_zh'] for r in rows]

    def search_models(self, query:str) -> List[Dict]:
        rows = self.fetch_all(
            "SELECT DISTINCT brand_name_zh, model_name FROM general_view WHERE model_name LIKE :q LIMIT 20",
            {'q': f"%{query}%"}
        )
        return rows

    # --- 查询榜 & 点赞榜 ---
    def get_top_queries(self, limit:int) -> List[Dict]:
        sql = """SELECT brand_name_zh, model_name, resistance_type_zh, resistance_location_zh,
                        query_count, size, thickness, max_speed
                 FROM total_query_rank_d30
                 ORDER BY query_count DESC
                 LIMIT :l"""
        return self.fetch_all(sql, {'l': limit})

    def get_top_ratings(self, limit:int) -> List[Dict]:
        sql = """SELECT brand_name_zh, model_name, resistance_type_zh, resistance_location_zh,
                        like_count, size, thickness, max_speed
                 FROM total_like_d30
                 ORDER BY like_count DESC
                 LIMIT :l"""
        return self.fetch_all(sql, {'l': limit})

    # --- 添加时获取唯一组合 ---
    def get_distinct_pairs_for_add(self, brand:str, model:str,
                                   res_type: str | None,
                                   res_loc: str | None) -> List[Dict]:
        where = ["brand_name_zh=:b", "model_name=:m"]
        params = {'b': brand, 'm': model}
        if res_type:
            where.append("resistance_type_zh=:rt"); params['rt'] = res_type
        if res_loc is not None:
            s = str(res_loc).strip()
            if s not in ('全部',):
                if s == '' or s == '无':
                    where.append("COALESCE(NULLIF(TRIM(resistance_location_zh),''),'') = ''")
                else:
                    where.append("resistance_location_zh=:rl"); params['rl'] = s
        sql = f"""
          SELECT DISTINCT model_id, condition_id, brand_name_zh, model_name,
                          resistance_type_zh, resistance_location_zh
          FROM general_view
          WHERE {" AND ".join(where)}
        """
        return self.fetch_all(sql, params)

    def get_infos_by_pairs(self, pairs: List[Tuple[int,int]]) -> List[Dict]:
        if not pairs:
            return []
        conds, params = [], {}
        for i,(m,c) in enumerate(pairs, start=1):
            conds.append(f"(:m{i}, :c{i})")
            params[f"m{i}"] = int(m); params[f"c{i}"] = int(c)
        sql = f"""
          SELECT DISTINCT model_id, condition_id, brand_name_zh, model_name,
                          resistance_type_zh, resistance_location_zh
          FROM general_view
          WHERE (model_id, condition_id) IN ({",".join(conds)})
        """
        return self.fetch_all(sql, params)

    def get_curves_for_pairs(self, pairs: List[Tuple[int,int]]) -> Dict[str, dict]:
        if not pairs:
            return {}
        conds, params = [],{}
        for i,(m,c) in enumerate(pairs, start=1):
            conds.append(f"(:m{i}, :c{i})")
            params[f"m{i}"] = int(m); params[f"c{i}"] = int(c)
        sql = f"""
          SELECT model_id, condition_id, brand_name_zh, model_name,
                 resistance_type_zh, resistance_location_zh,
                 rpm, airflow_cfm AS airflow, noise_db
          FROM general_view
          WHERE (model_id, condition_id) IN ({",".join(conds)})
          ORDER BY model_id, condition_id, rpm
        """
        rows = self.fetch_all(sql, params)
        from math import isfinite
        bucket: Dict[str, dict] = {}
        for r in rows:
            key = f"{int(r['model_id'])}_{int(r['condition_id'])}"
            b = bucket.setdefault(key, {
                'rpm': [], 'airflow': [], 'noise_db': [],
                'info': {
                    'brand': r['brand_name_zh'],
                    'model': r['model_name'],
                    'res_type': r['resistance_type_zh'],
                    'res_loc': r['resistance_location_zh'],
                    'model_id': int(r['model_id']),
                    'condition_id': int(r['condition_id'])
                }
            })
            try:
                airflow = float(r['airflow']) if r['airflow'] is not None else None
            except:
                airflow = None
            try:
                rpm_v = int(r['rpm']) if r['rpm'] is not None else None
            except:
                rpm_v = None
            try:
                noise_v = float(r['noise_db']) if r['noise_db'] is not None else None
            except:
                noise_v = None

            def valid(v):
                return v is not None and v == v and v not in (float('inf'), float('-inf'))

            if not valid(airflow):
                continue
            if rpm_v is None and noise_v is None:
                continue
            b['rpm'].append(rpm_v)
            b['airflow'].append(round(airflow,1) if valid(airflow) else None)
            b['noise_db'].append(noise_v if valid(noise_v) else None)
        return bucket

    # --- 点赞 / 最近点赞 ---
    def like(self, user_id:str, model_id:int, condition_id:int):
        sql = """INSERT INTO rate_logs (user_identifier, model_id, condition_id, is_valid)
                 VALUES (:u,:m,:c,1)
                 ON DUPLICATE KEY UPDATE is_valid=1, update_date=NOW()"""
        self.exec_write(sql, {'u': user_id, 'm': model_id, 'c': condition_id})

    def unlike(self, user_id:str, model_id:int, condition_id:int):
        sql = """UPDATE rate_logs SET is_valid=0, update_date=NOW()
                 WHERE user_identifier=:u AND model_id=:m AND condition_id=:c"""
        self.exec_write(sql, {'u': user_id, 'm': model_id, 'c': condition_id})

    def get_user_likes_full(self, user_id:str, limit:int|None=None) -> List[Dict]:
        sql = """
        SELECT user_identifier, model_id, condition_id, brand_name_zh, model_name,
               resistance_type_zh, resistance_location_zh, max_speed, size, thickness
        FROM user_likes_view
        WHERE user_identifier=:u
        """
        rows = self.fetch_all(sql, {'u': user_id})
        return rows if limit is None else rows[:limit]

    def get_user_like_keys(self, user_id:str) -> List[str]:
        return [f"{int(r['model_id'])}_{int(r['condition_id'])}" for r in self.get_user_likes_full(user_id)]

    # --- 搜索 ---
    def search_fans_by_condition(self, res_type:str, res_loc:str|None,
                                 sort_by:str, sort_value:float|None,
                                 size_filter:str|None,
                                 thickness_min:int, thickness_max:int,
                                 limit:int=200) -> List[Dict]:
        base = [
            "SELECT brand_name_zh, model_name, resistance_type_zh, resistance_location_zh,",
            "MAX(airflow_cfm) AS max_airflow, size, thickness, MAX(rpm) AS max_speed,",
            "MAX(COALESCE(like_count,0)) AS like_count",
            "FROM general_view",
            "WHERE resistance_type_zh=:rt"
        ]
        params = {'rt': res_type, 'limit': limit}
        if res_loc is not None:
            s = str(res_loc).strip()
            if s not in ('全部',):
                if s == '' or s == '无':
                    base.append("AND COALESCE(NULLIF(TRIM(resistance_location_zh),''),'') = ''")
                else:
                    base.append("AND resistance_location_zh=:rl")
                    params['rl'] = s
        if size_filter and size_filter != '不限':
            base.append("AND size=:sz")
            params['sz'] = int(size_filter)
        if thickness_min is not None and thickness_max is not None:
            base.append("AND thickness BETWEEN :tmin AND :tmax")
            params.update(tmin=int(thickness_min), tmax=int(thickness_max))
        if sort_by == 'rpm':
            base.append("AND rpm <= :sv"); params['sv'] = float(sort_value)
        elif sort_by == 'noise':
            base.append("AND noise_db <= :sv"); params['sv'] = float(sort_value)

        base.append("GROUP BY brand_name_zh, model_name, resistance_type_zh, resistance_location_zh, size, thickness")
        base.append("ORDER BY max_airflow DESC LIMIT :limit")
        return self.fetch_all("\n".join(base), params)

    # --- 查询日志 ---
    def insert_query_logs(self, user_id:str, fan_infos:list):
        sql = "INSERT INTO query_logs (user_identifier, model_id, condition_id, batch_id) VALUES (:u,:m,:c,:b)"
        from uuid import uuid4
        batch = str(uuid4())
        try:
            from sqlalchemy import text
            with self._engine.begin() as conn:
                for info in fan_infos:
                    conn.execute(
                        text(sql),
                        {'u': user_id, 'm': info['model_id'], 'c': info['condition_id'], 'b': batch}
                    )
        except Exception:
            pass

    def get_query_count_distinct_batch(self) -> int:
        row = self.fetch_one("SELECT COUNT(DISTINCT batch_id) AS c FROM query_logs")
        return int(row['c']) if row else 0