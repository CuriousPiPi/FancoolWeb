from app.repositories.fan_repository import FanRepository

repo = FanRepository()

def search(res_type:str, res_loc:str|None, sort_by:str, sort_value:float|None,
           size_filter:str|None, thickness_min:int, thickness_max:int, limit=200):
    return repo.search_fans_by_condition(
        res_type, res_loc, sort_by, sort_value,
        size_filter, thickness_min, thickness_max, limit
    )