from flask import Blueprint, render_template, request
from .core import bp as core_bp
from .search import bp as search_bp
from .like import bp as like_bp
from .share import bp as share_bp
from .misc import bp as misc_bp
from app.repositories.fan_repository import FanRepository
from app.services.state_service import assemble_state
from flask import current_app

ui = Blueprint('ui', __name__)
repo = FanRepository()

@ui.route('/')
def index():
    brands_rows = repo.fetch_all("SELECT DISTINCT brand_name_zh FROM fan_brand")
    brands = [r['brand_name_zh'] for r in brands_rows]
    all_res_types = repo.get_all_res_types()
    all_res_locs = repo.get_all_res_locs()
    top_queries = repo.get_top_queries(limit=current_app.config['TOP_QUERIES_LIMIT'])
    top_ratings = repo.get_top_ratings(limit=current_app.config['TOP_QUERIES_LIMIT'])

    # 保持原参数兼容（用于初次 GET 填充）
    url_search_res_type = request.args.get('search_res_type','')
    url_search_res_loc = request.args.get('search_res_loc','')
    url_sort_by = request.args.get('sort_by','none')
    url_sort_value = request.args.get('sort_value','')
    url_size_filter = request.args.get('size_filter','不限')
    url_thickness_min = request.args.get('thickness_min','25')
    url_thickness_max = request.args.get('thickness_max','50')

    return render_template('fancoolindex.html',
                           brands=brands, models=[], res_types=[], res_locs=[],
                           selected_fans=assemble_state().get('selected_fans', []),
                           top_queries=top_queries, top_ratings=top_ratings,
                           all_res_types=all_res_types, all_res_locs=all_res_locs,
                           search_results=[],
                           search_res_type=url_search_res_type,
                           search_res_loc=url_search_res_loc,
                           sort_by=url_sort_by, sort_value=url_sort_value,
                           size_options=current_app.config['SIZE_OPTIONS'],
                           size_filter=url_size_filter,
                           thickness_min=url_thickness_min,
                           thickness_max=url_thickness_max,
                           error_message=None,
                           max_chart_items=current_app.config['MAX_CHART_ITEMS'],
                           url_search_res_type=url_search_res_type,
                           url_search_res_loc=url_search_res_loc,
                           url_sort_by=url_sort_by, url_sort_value=url_sort_value,
                           url_size_filter=url_size_filter,
                           url_thickness_min=url_thickness_min,
                           url_thickness_max=url_thickness_max,
                           colors=current_app.config['COLORS_DEFAULT'],
                           click_cooldown_ms=current_app.config['CLICK_COOLDOWN_SECONDS'] * 1000)

def register_blueprints(app):
    app.register_blueprint(core_bp)
    app.register_blueprint(search_bp)
    app.register_blueprint(like_bp)
    app.register_blueprint(share_bp)
    app.register_blueprint(misc_bp)
    app.register_blueprint(ui)