/* state-ui.js
 * 业务层：选中列表 / 最近移除 / 最近点赞 / 点赞排行 / 搜索 / 点赞行为 / 添加移除 / 表单级联 / 状态合并
 * 依赖：core.js (__APP.dom/__APP.cache/__APP.util)、color.js (__APP.color.*)、chart.js (__APP.chart.*)、layout.js (__APP.layout.*)
 */

(function initStateUIModule(){
  window.__APP = window.__APP || {};
  if (window.__APP.stateUI) return; // 避免重复初始化

  const dom = window.__APP.dom;
  const $ = sel => dom.one(sel);

  /* ---------- 工具与跨模块依赖安全包装 ---------- */
  const {
    escapeHtml, unescapeHtml, formatScenario,
    showSuccess, showError, showInfo,
    showLoading, hideLoading, autoCloseOpLoading,
    globalThrottle, needThrottle
  } = window.__APP.util || {};

  // 颜色模块函数兼容（若 color.js 尚未加载，用空操作降级）
  const colorNS = window.__APP.color || {};
  const colorForKey = colorNS.colorForKey || function(){ return '#888'; };
  const assignUniqueIndicesForSelection = colorNS.assignUniqueIndicesForSelection || function(){};
  const ensureColorIndicesForSelected = colorNS.ensureColorIndicesForSelected || function(){};
  const releaseColorIndexForKey = colorNS.releaseColorIndexForKey || function(){};
  const applyServerStatePatchColorIndices = colorNS.applyServerStatePatchColorIndices || function(){};

  // 图表模块
  const chartNS = window.__APP.chart || {};
  const postChartData = chartNS.postChartData || function(){};

  // Local stores module
  const localStores = window.__APP.localStores || {};
  const selectionStore = localStores.selectionStore;
  const removedStore = localStores.removedStore;
  const shareMetaStore = localStores.shareMetaStore;
  const likeStore = localStores.likeStore;
  const colorStore = localStores.colorStore;
  const makeKey = localStores.makeKey || function(mid, cid){ return `${mid}_${cid}`; };

  /* ========================================================
   * 选中集合索引
   * ====================================================== */
  let selectedMapSet = new Set();
  let selectedKeySet = new Set();
  
  // Track last selected fans for diff computation (F-02)
  let lastSelectedFans = [];
  
  function rebuildSelectedIndex(){
    selectedMapSet.clear();
    selectedKeySet.clear();
    dom.all('#selectedFansList .fan-item').forEach(div=>{
      const key = div.getAttribute('data-fan-key');
      if (key) selectedKeySet.add(key);
      const map = div.getAttribute('data-map');
      if (map) selectedMapSet.add(map);
    });
  }
  rebuildSelectedIndex();
  const bus = window.__APP.bus;

  /* ========================================================
   * 快速按钮构建
   * ====================================================== */
  function buildQuickBtnHTML(addType, brand, model, resType, resLocRaw){
    const normLoc = (resLocRaw && String(resLocRaw).trim() !== '') ? resLocRaw : '无';
    const mapKey = `${escapeHtml(brand)}||${escapeHtml(model)}||${escapeHtml(resType)}||${escapeHtml(normLoc)}`;
    const isDup = selectedMapSet.has(mapKey);
    const mode = isDup?'remove':'add';
    const title = isDup?'从图表移除':'添加到图表';
    const icon = isDup?'<i class="fa-solid fa-xmark"></i>':'<i class="fa-solid fa-plus"></i>';
    let cls;
    if (isDup) cls='js-list-remove';
    else if (addType==='search') cls='js-search-add';
    else if (addType==='rating') cls='js-rating-add';
    else if (addType==='ranking') cls='js-ranking-add';
    else cls='js-likes-add';
    return `
      <button class="btn-add ${cls} tooltip-btn"
              title="${title}"
              data-mode="${mode}"
              data-add-type="${addType}"
              data-brand="${escapeHtml(brand)}"
              data-model="${escapeHtml(model)}"
              data-res-type="${escapeHtml(resType)}"
              data-res-loc="${escapeHtml(normLoc)}">
        ${icon}
      </button>`;
  }
  function toRemoveState(btn){
    btn.dataset.mode='remove';
    btn.classList.remove('js-ranking-add','js-rating-add','js-search-add','js-likes-add');
    btn.classList.add('js-list-remove');
    btn.title='从图表移除';
    btn.innerHTML='<i class="fa-solid fa-xmark"></i>';
  }
  function toAddState(btn){
    const addType = btn.dataset.addType || (btn.classList.contains('js-rating-add')?'rating'
      : btn.classList.contains('js-ranking-add')?'ranking'
        : btn.classList.contains('js-search-add')?'search':'likes');
    btn.dataset.mode='add';
    btn.className='btn-add tooltip-btn '+(
      addType==='rating' ? 'js-rating-add'
        : addType==='ranking' ? 'js-ranking-add'
          : addType==='search' ? 'js-search-add'
            : 'js-likes-add'
    );
    btn.title='添加到图表';
    btn.innerHTML='<i class="fa-solid fa-plus"></i>';
  }
  function mapKeyFromDataset(d){
    const b=unescapeHtml(d.brand||''), m=unescapeHtml(d.model||''), rt=unescapeHtml(d.resType||''), rl=unescapeHtml(d.resLoc||'');
    return `${b}||${m}||${rt}||${rl}`;
  }
  function syncQuickActionButtons(){
    dom.all('.btn-add.tooltip-btn').forEach(btn=>{
      if (!btn.dataset.addType){
        if (btn.classList.contains('js-rating-add')) btn.dataset.addType='rating';
        else if (btn.classList.contains('js-ranking-add')) btn.dataset.addType='ranking';
        else if (btn.classList.contains('js-search-add')) btn.dataset.addType='search';
        else if (btn.classList.contains('js-likes-add')) btn.dataset.addType='likes';
      }
      const key = mapKeyFromDataset(btn.dataset);
      if (selectedMapSet.has(key)) toRemoveState(btn); else toAddState(btn);
    });
  }

  /* ========================================================
   * Rebuild 选中 / 移除列表
   * ====================================================== */
  const selectedListEl    = $('#selectedFansList');
  const removedListEl     = $('#recentlyRemovedList');
  const selectedCountEl   = $('#selectedCount');
  const clearAllContainer = $('#clearAllContainer');

  let likedKeysSet = new Set();

  function rebuildSelectedFans(fans){
    if (!selectedListEl) return;
    selectedListEl.innerHTML='';

    // 事件驱动模式下，颜色唯一化已在 color.js 的 selection:changed 处理。
    // 兜底：如果 color 模块尚未加载（无索引），尝试即时确保。
    if (!window.__APP.color?.recycleRemovedKeys){
      try { assignUniqueIndicesForSelection(fans||[]); } catch(_){}
    }

    if (!fans || fans.length===0){
      if (selectedCountEl) selectedCountEl.textContent='0';
      clearAllContainer?.classList.add('hidden');
      rebuildSelectedIndex();
      requestAnimationFrame(()=>{
        window.__APP.color?.applySidebarColors?.();
        window.__APP.layout?.refreshMarquees?.();
        window.__APP.layout?.scheduleAdjust?.();
      });
      return;
    }
    fans.forEach(f=>{
      const keyStr = `${f.model_id}_${f.condition_id}`;
      const isLiked = likedKeysSet.has(keyStr);
      const div = document.createElement('div');
      div.className='fan-item flex items-center justify-between p-3 border border-gray-200 rounded-md';
      div.dataset.fanKey = f.key;
      const normLoc = (f.res_loc && String(f.res_loc).trim() !== '') ? f.res_loc : '无';
      div.dataset.map = `${f.brand}||${f.model}||${f.res_type}||${normLoc}`;
      div.innerHTML=`
        <div class="flex items-center min-w-0">
          <div class="w-3 h-3 rounded-full mr-2 flex-shrink-0 js-color-dot"></div>
          <div class="truncate">
            <span class="font-medium">${escapeHtml(f.brand)} ${escapeHtml(f.model)}</span> - 
            <span class="text-gray-600 text-sm">${formatScenario(f.res_type, f.res_loc)}</span>
          </div>
        </div>
        <div class="flex items-center flex-shrink-0">
          <button class="like-button mr-3" data-fan-key="${f.key}" data-model-id="${f.model_id}" data-condition-id="${f.condition_id}">
            <i class="fa-solid fa-thumbs-up ${isLiked?'text-red-500':'text-gray-400'}"></i>
          </button>
          <button class="remove-icon text-lg js-remove-fan" data-fan-key="${f.key}" title="移除">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>`;
      selectedListEl.appendChild(div);
      const dot = div.querySelector('.js-color-dot');
      if (dot) dot.style.backgroundColor = colorForKey(f.key);
    });
    if (selectedCountEl) selectedCountEl.textContent = fans.length.toString();
    clearAllContainer?.classList.remove('hidden');
    rebuildSelectedIndex();
    window.__APP.layout?.refreshMarquees?.();
    window.__APP.layout?.scheduleAdjust?.();
    bus?.emit('selectedFans:rebuilt', { count: fans?.length||0, ts: Date.now() });
  }

  function rebuildRemovedFans(list){
    if (!removedListEl) return;
    removedListEl.innerHTML='';
    if (!list || list.length===0){
      removedListEl.innerHTML='<p class="text-gray-500 text-center py-6 empty-removed">暂无最近移除的风扇</p>';
      window.__APP.layout?.refreshMarquees?.();
      return;
    }
    list.forEach(item=>{
      if (selectedKeySet.has(item.key)) return;
      const div=document.createElement('div');
      div.className='fan-item flex items-center justify-between p-3 border border-gray-200 rounded-md';
      div.dataset.fanKey=item.key;
      div.innerHTML=`
        <div class="truncate">
          <span class="font-medium">${escapeHtml(item.brand)} ${escapeHtml(item.model)}</span> - 
          <span class="text-gray-600 text-sm">${formatScenario(item.res_type, item.res_loc)}</span>
        </div>
        <button class="restore-icon text-lg js-restore-fan" data-fan-key="${item.key}" title="恢复至图表">
          <i class="fa-solid fa-rotate-left"></i>
        </button>`;
      removedListEl.appendChild(div);
    });
    window.__APP.layout?.refreshMarquees?.();
    if (bus) bus.emit('removedFans:rebuilt', { count: list?.length||0, ts: Date.now() });
  }

  // New function to rebuild removed fans from local store (F-02)
  function rebuildRemovedFansFromStore(){
    if (!removedStore) {
      console.warn('[state-ui] removedStore not available, cannot rebuild from store');
      return;
    }
    const list = removedStore.list();
    rebuildRemovedFans(list);
  }

  // Subscribe to removedStore changes (F-02)
  if (removedStore && removedStore.onChange) {
    removedStore.onChange(function() {
      rebuildRemovedFansFromStore();
    });
    // Initialize the removed fans UI from store on load
    rebuildRemovedFansFromStore();
  }

  /* ========================================================
   * 最近点赞
   * ====================================================== */
  // === 最近点赞渲染 & 遮罩（整块替换原来的 rebuildRecentLikes + 相关代码） ===
  let recentLikesLoaded = false;
  const recentLikesListEl = $('#recentLikesList');
  
  /**
   * 计算并设置最近点赞每组标题遮罩的 CSS 变量
   * 原逻辑来自 layout.js: applyRecentLikesTitleMask
   */
  function applyRecentLikesTitleMask() {
    const groups = document.querySelectorAll('#recentLikesList .recent-like-group');
    groups.forEach(g => {
      const titleWrap = g.querySelector('.group-header .title-wrap');
      const titleBox  = titleWrap?.querySelector('.truncate');
      if (!titleWrap || !titleBox) return;
      const w = Math.max(0, Math.ceil(titleBox.getBoundingClientRect().width));
      titleWrap.style.setProperty('--title-w', w + 'px');
      // 如需统一 fade 宽度可以解开下面：
      // titleWrap.style.setProperty('--fade-w', '28px');
    });
  }
  // 对外仍可调用（保持兼容）
  window.applyRecentLikesTitleMask = applyRecentLikesTitleMask;
  
  /**
   * 重建最近点赞列表，并在渲染完成后调遮罩测量
   */
  let rebuildRecentLikes = function(list){
    if (!recentLikesListEl) return;
    recentLikesListEl.innerHTML='';
    if (!list || list.length===0){
      recentLikesListEl.innerHTML='<p class="text-gray-500 text-center py-6">暂无最近点赞</p>';
      window.__APP.layout?.refreshMarquees?.();
      // 仍然尝试清除旧变量，防止空状态残留
      requestAnimationFrame(()=>applyRecentLikesTitleMask());
      return;
    }
    const groups = new Map();
    list.forEach(item=>{
      const brand = item.brand_name_zh || item.brand;
      const model = item.model_name || item.model;
      const size = item.size ?? item.model_size ?? '';
      const thickness = item.thickness ?? item.model_thickness ?? '';
      const maxSpeed = item.max_speed ?? item.maxSpeed ?? '';
      const rt = item.resistance_type_zh || item.res_type || item.resistance_type || '';
      const rl = item.resistance_location_zh || item.res_loc || item.resistance_location || '';
      const mid = item.model_id ?? item.modelId ?? item.mid ?? '';
      const cid = item.condition_id ?? item.conditionId ?? item.cid ?? '';
      if (!brand || !model || !rt) return;
      const key = `${brand}||${model}||${size}||${thickness}||${maxSpeed}`;
      if (!groups.has(key)) groups.set(key,{ brand, model, size, thickness, maxSpeed, scenarios:[] });
      const g = groups.get(key);
      if (!g.scenarios.some(s=>s.rt===rt && s.rl===rl)) g.scenarios.push({ rt, rl, mid, cid });
    });
  
    groups.forEach(g=>{
      const metaParts=[];
      if (g.maxSpeed) metaParts.push(`${escapeHtml(g.maxSpeed)} RPM`);
      if (g.size && g.thickness) metaParts.push(`${escapeHtml(g.size)}x${escapeHtml(g.thickness)}`);
      const metaRight = metaParts.join(' · ');
      const scenariosHtml = g.scenarios.map(s=>{
        const scenText = s.rl ? `${escapeHtml(s.rt)} ${escapeHtml(s.rl)}` : `${escapeHtml(s.rt)}`;
        return `
          <div class="flex items-center justify-between scenario-row">
            <div class="scenario-text text-sm text-gray-700">${scenText}</div>
            <div class="actions">
              <button class="like-button recent-like-button" title="取消点赞"
                      data-model-id="${escapeHtml(s.mid||'')}"
                      data-condition-id="${escapeHtml(s.cid||'')}">
                <i class="fa-solid fa-thumbs-up text-red-500"></i>
              </button>
              ${buildQuickBtnHTML('likes', g.brand, g.model, s.rt, s.rl)}
            </div>
          </div>`;
      }).join('');
      const groupDiv=document.createElement('div');
      groupDiv.className='recent-like-group p-3 border border-gray-200 rounded-md';
      groupDiv.innerHTML=`
        <div class="group-header">
          <div class="title-wrap flex items-center min-w-0">
            <div class="truncate font-medium">${escapeHtml(g.brand)} ${escapeHtml(g.model)}</div>
          </div>
          <div class="meta-right text-sm text-gray-600">${metaRight}</div>
        </div>
        <div class="group-scenarios mt-2 space-y-1">${scenariosHtml}</div>`;
      recentLikesListEl.appendChild(groupDiv);
    });
  
    syncQuickActionButtons();
    window.__APP.layout?.refreshMarquees?.();
    recentLikesLoaded = true;
    let totalScenarios = 0; groups.forEach(g=> totalScenarios += g.scenarios.length );
    if (bus) bus.emit('recentLikes:rebuilt', { groups: groups.size, scenarios: totalScenarios, ts: Date.now() });
  
    // 关键：双 RAF 以保证布局稳定后测量宽度
    requestAnimationFrame(()=>requestAnimationFrame(()=>applyRecentLikesTitleMask()));
  };
  
  function reloadRecentLikes(){
    showLoading('recent-likes','加载最近点赞...');
    fetch('/api/recent_likes')
      .then(r=>r.json())
      .then(d=>{
        if (!d.success){ showError('获取最近点赞失败'); return; }
        rebuildRecentLikes(d.data||[]);
      })
      .catch(err=>showError('获取最近点赞异常: '+err.message))
      .finally(()=>hideLoading('recent-likes'));
  }
  function loadRecentLikesIfNeeded(){ if (!recentLikesLoaded) reloadRecentLikes(); }

  /* ========================================================
   * 点赞排行
   * ====================================================== */
  let likesTabLoaded = false;
  let likesTabLastLoad = 0;
  const LIKES_TTL = 120000;
  function needReloadLikes(){
    if (!likesTabLoaded) return true;
    return (Date.now() - likesTabLastLoad) > LIKES_TTL;
  }
  let _rtPending=false;
  let _rtDebounce=null;

  function reloadTopRatings(debounce=true){
    if (debounce){
      if (_rtDebounce) clearTimeout(_rtDebounce);
      return new Promise(resolve=>{
        _rtDebounce=setTimeout(()=>resolve(reloadTopRatings(false)),250);
      });
    }
    if (_rtPending) return Promise.resolve();
    _rtPending=true;

    const cacheNS='top_ratings';
    const payload={};
    const cached=window.__APP.cache.get(cacheNS,payload);
    if (cached && !needReloadLikes()){
      applyRatingTable(cached);
      _rtPending=false;
      return Promise.resolve();
    }

    const tbody=document.getElementById('ratingRankTbody');
    if (tbody && !likesTabLoaded){
      tbody.innerHTML='<tr><td colspan="7" class="text-center text-gray-500 py-6">加载中...</td></tr>';
    }

    return fetch('/api/top_ratings')
      .then(r=>r.json())
      .then(data=>{
        if (!data.success){ showError('更新点赞排行失败'); return; }
        window.__APP.cache.set(cacheNS,payload,data,LIKES_TTL);
        applyRatingTable(data);
      })
      .catch(err=>showError('获取点赞排行异常: '+err.message))
      .finally(()=>{ _rtPending=false; });
  }

  function applyRatingTable(data){
    const list = data.data || [];
    const tbody=document.getElementById('ratingRankTbody');
    if (!tbody) return;
    if (!list.length){
      tbody.innerHTML='<tr><td colspan="7" class="text-center text-gray-500 py-6">暂无点赞排行数据</td></tr>';
      return;
    }
    let html='';
    list.forEach((r,idx)=>{
      const rank=idx+1;
      const medal=rank===1?'gold':rank===2?'silver':rank===3?'bronze':'';
      const rankCell = medal?`<i class="fa-solid fa-medal ${medal} text-2xl"></i>`:`<span class="font-medium">${rank}</span>`;
      const locRaw = r.resistance_location_zh || '';
      const scen = formatScenario(r.resistance_type_zh, locRaw);
      const locForKey = locRaw || '全部';
      const mapKey = `${escapeHtml(r.brand_name_zh)}||${escapeHtml(r.model_name)}||${escapeHtml(r.resistance_type_zh)}||${escapeHtml(locForKey)}`;
      const isDup = selectedMapSet.has(mapKey);
      const btnMode = isDup?'remove':'add';
      const btnClass = isDup?'js-list-remove':'js-rating-add';
      const btnTitle = isDup?'从图表移除':'添加到图表';
      const btnIcon = isDup?'<i class="fa-solid fa-xmark"></i>':'<i class="fa-solid fa-plus"></i>';
      html += `
        <tr class="hover:bg-gray-50">
          <td class="rank-cell">${rankCell}</td>
          <td class="nowrap marquee-cell"><span class="marquee-inner">${escapeHtml(r.brand_name_zh)}</span></td>
          <td class="nowrap marquee-cell"><span class="marquee-inner">${escapeHtml(r.model_name)} (${r.max_speed} RPM)</span></td>
          <td class="nowrap marquee-cell"><span class="marquee-inner">${escapeHtml(r.size)}x${escapeHtml(r.thickness)}</span></td>
          <td class="nowrap marquee-cell"><span class="marquee-inner">${scen}</span></td>
          <td class="text-blue-600 font-medium">${escapeHtml(r.like_count)}</td>
          <td>
            <button class="btn-add ${btnClass} tooltip-btn"
                    title="${btnTitle}"
                    data-mode="${btnMode}"
                    data-add-type="rating"
                    data-brand="${escapeHtml(r.brand_name_zh)}"
                    data-model="${escapeHtml(r.model_name)}"
                    data-res-type="${escapeHtml(r.resistance_type_zh)}"
                    data-res-loc="${escapeHtml(locForKey)}">
              ${btnIcon}
            </button>
          </td>
        </tr>`;
    });
    tbody.innerHTML=html;
    likesTabLoaded = true;
    likesTabLastLoad = Date.now();
    syncQuickActionButtons();
    window.__APP.layout?.refreshMarquees?.();
    if (bus) bus.emit('topRatings:rebuilt', { count: list.length, ts: Date.now() });
  }

  function loadLikesIfNeeded(){
    if (!needReloadLikes()) return;
    showLoading('rating-refresh','加载好评榜...');
    reloadTopRatings(false).finally(()=>hideLoading('rating-refresh'));
  }

  /* ========================================================
   * 搜索
   * ====================================================== */
  const searchForm = $('#searchForm');
  const searchAirflowTbody = $('#searchAirflowTbody');
  const searchLikesTbody   = $('#searchLikesTbody');
  let SEARCH_RESULTS_RAW=[];

  function fillSearchTable(tbody, list){
    if (!tbody) return;
    if (!list.length){
      tbody.innerHTML='<tr><td colspan="7" class="text-center text-gray-500 py-6">没有符合条件的结果</td></tr>';
      return;
    }
    tbody.innerHTML = list.map(r=>{
      const brand=r.brand_name_zh;
      const model=r.model_name;
      const resType=r.resistance_type_zh;
      const resLocRaw = r.resistance_location_zh || '';
      const scenLabel = formatScenario(resType,resLocRaw);
      return `
        <tr class="hover:bg-gray-50">
          <td class="nowrap marquee-cell"><span class="marquee-inner">${escapeHtml(brand)}</span></td>
          <td class="nowrap marquee-cell"><span class="marquee-inner">${escapeHtml(model)} (${r.max_speed} RPM)</span></td>
          <td class="nowrap marquee-cell"><span class="marquee-inner">${escapeHtml(r.size)}x${escapeHtml(r.thickness)}</span></td>
          <td class="nowrap marquee-cell"><span class="marquee-inner">${scenLabel}</span></td>
          <td class="text-blue-600 font-medium text-sm">${Number(r.max_airflow).toFixed(1)}</td>
          <td class="text-blue-600 font-medium">${r.like_count ?? 0}</td>
          <td>${buildQuickBtnHTML('search', brand, model, resType, resLocRaw)}</td>
        </tr>`;
    }).join('');
  }

  function renderSearchResults(results, conditionLabel){
    SEARCH_RESULTS_RAW = results.slice();
    const byAirflow = SEARCH_RESULTS_RAW;
    const byLikes = SEARCH_RESULTS_RAW.slice().sort((a,b)=>(b.like_count||0)-(a.like_count||0));
    const labelEl=document.getElementById('searchConditionLabel');
    if (labelEl) labelEl.textContent = conditionLabel;
    fillSearchTable(searchAirflowTbody, byAirflow);
    fillSearchTable(searchLikesTbody, byLikes);
    syncQuickActionButtons();
    window.__APP.layout?.refreshMarquees?.();
    if (bus) bus.emit('search:rendered', { airflowCount: byAirflow.length, ts: Date.now() });
  }

  if (searchForm){
    searchForm.addEventListener('submit', async e=>{
      e.preventDefault();
      if (!searchForm.reportValidity()) return;
      if (needThrottle('search') && !globalThrottle()) return;
      const fd=new FormData(searchForm);
      const payload={}; fd.forEach((v,k)=>payload[k]=v);

      const cacheNS='search';
      const cached=window.__APP.cache.get(cacheNS,payload);

      async function doFetch(){
        return fetch('/api/search_fans',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify(payload)
        }).then(r=>r.json());
      }

      async function refreshFromServer(){
        try {
          const fresh = await doFetch();
            if (fresh.success){
              window.__APP.cache.set(cacheNS,payload,fresh);
              if (!cached || JSON.stringify(cached.search_results)!==JSON.stringify(fresh.search_results)){
                renderSearchResults(fresh.search_results,fresh.condition_label);
                showInfo('已刷新最新结果');
              }
            }
        }catch(_){}
      }

      if (cached){
        renderSearchResults(cached.search_results,cached.condition_label);
        showInfo('已使用缓存结果，后台刷新中...');
        refreshFromServer();
      } else {
        showLoading('op','搜索中...');
        try{
          const data=await doFetch();
          if (!data.success){
            hideLoading('op'); showError(data.error_message||'搜索失败');
            searchAirflowTbody.innerHTML='<tr><td colspan="7" class="text-center text-gray-500 py-6">搜索失败</td></tr>';
            searchLikesTbody.innerHTML  ='<tr><td colspan="7" class="text-center text-gray-500 py-6">搜索失败</td></tr>';
            return;
          }
          window.__APP.cache.set(cacheNS,payload,data);
          renderSearchResults(data.search_results,data.condition_label);
          hideLoading('op'); showSuccess('搜索完成');
          document.querySelector('.tab-nav[data-tab-group="right-panel"] .tab-nav-item[data-tab="search-results"]')?.click();
        }catch(err){
          hideLoading('op'); showError('搜索异常: '+err.message);
          searchAirflowTbody.innerHTML='<tr><td colspan="7" class="text-center text-gray-500 py-6">搜索失败</td></tr>';
          searchLikesTbody.innerHTML  ='<tr><td colspan="7" class="text-center text-gray-500 py-6">搜索失败</td></tr>';
        }
      }
    });
  }

  /* ========================================================
   * 添加表单级联
   * ====================================================== */
  const fanForm = $('#fanForm');
  const brandSelect   = $('#brandSelect');
  const modelSelect   = $('#modelSelect');
  const resTypeSelect = $('#resTypeSelect');
  const resLocSelect  = $('#resLocSelect');

  if (brandSelect){
    brandSelect.addEventListener('change', ()=>{
      const b=(brandSelect.value||'').trim();
      modelSelect.innerHTML = `<option value="">${b ? '-- 选择型号 --' : '-- 请先选择品牌 --'}</option>`;
      modelSelect.disabled = !b;
      resTypeSelect.innerHTML = `<option value="">${b ? '-- 请先选择型号 --' : '-- 请先选择品牌 --'}</option>`;
      resTypeSelect.disabled = true;
      resLocSelect.innerHTML = `<option value="">${b ? '-- 请先选择型号 --' : '-- 请先选择品牌 --'}</option>`;
      resLocSelect.disabled = true;
      if (!b) return;
      fetch(`/get_models/${encodeURIComponent(b)}`)
        .then(r=>r.json())
        .then(models=>{
          models.forEach(m=>{
            const o=document.createElement('option'); o.value=m; o.textContent=m; modelSelect.appendChild(o);
          });
          modelSelect.disabled=false;
        });
    });
  }

  if (modelSelect){
    modelSelect.addEventListener('change', ()=>{
      const b=(brandSelect.value||'').trim(), m=(modelSelect.value||'').trim();
      resTypeSelect.innerHTML = m
        ? '<option value="">-- 选择风阻类型 --</option><option value="全部">全部</option>'
        : '<option value="">-- 请先选择型号 --</option>';
      resTypeSelect.disabled=!m;
      resLocSelect.innerHTML = m
        ? '<option value="">-- 请先选择风阻类型 --</option>'
        : '<option value="">-- 请先选择型号 --</option>';
      resLocSelect.disabled=true;
      if (!b || !m) return;
      fetch(`/get_resistance_types/${encodeURIComponent(b)}/${encodeURIComponent(m)}`)
        .then(r=>r.json())
        .then(types=>{
          types.forEach(t=>{
            const o=document.createElement('option'); o.value=t; o.textContent=t; resTypeSelect.appendChild(o);
          });
          resTypeSelect.disabled=false;
        });
    });
  }

  if (resTypeSelect){
    resTypeSelect.addEventListener('change', ()=>{
      const b=(brandSelect.value||'').trim(), m=(modelSelect.value||'').trim(), rt=(resTypeSelect.value||'').trim();
      if (!rt){
        resLocSelect.innerHTML='<option value="">-- 请先选择风阻类型 --</option>';
        resLocSelect.disabled=true;
        return;
      }
      resLocSelect.innerHTML='<option value="">-- 选择风阻位置 --</option><option value="全部">全部</option>';
      resLocSelect.disabled=true;
      if (!b || !m || !rt) return;
      if (rt === '空载'){
        resLocSelect.innerHTML='<option value="无" selected>无</option>';
        resLocSelect.disabled=true;
        return;
      }
      if (rt === '全部'){
        resLocSelect.innerHTML='<option value="全部" selected>全部</option>';
        resLocSelect.disabled=true;
        return;
      }
      fetch(`/get_resistance_locations/${encodeURIComponent(b)}/${encodeURIComponent(m)}/${encodeURIComponent(rt)}`)
        .then(r=>r.json())
        .then(locs=>{
          locs.forEach(l=>{
            const o=document.createElement('option'); o.value=l; o.textContent=l; resLocSelect.appendChild(o);
          });
          resLocSelect.disabled=false;
        });
    });
  }
  if (brandSelect) brandSelect.dispatchEvent(new Event('change'));

  /* 型号搜索建议 */
  const modelSearchInput = $('#modelSearchInput');
  const searchSuggestions = $('#searchSuggestions');
  let modelDebounceTimer;
  if (modelSearchInput && searchSuggestions){
    modelSearchInput.addEventListener('input', ()=>{
      clearTimeout(modelDebounceTimer);
      const q=modelSearchInput.value.trim();
      if (q.length < 2){
        searchSuggestions.classList.add('hidden');
        return;
      }
      modelDebounceTimer=setTimeout(()=>{
        fetch(`/search_models/${encodeURIComponent(q)}`)
          .then(r=>r.json())
          .then(list=>{
            searchSuggestions.innerHTML='';
            if (!list.length){
              searchSuggestions.classList.add('hidden');
              return;
            }
            list.forEach(full=>{
              const div=document.createElement('div');
              div.className='cursor-pointer';
              div.textContent=full;
              div.addEventListener('click', ()=>{
                const parts=full.split(' ');
                const brand=parts[0];
                const model=parts.slice(1).join(' ');
                brandSelect.value=brand;
                brandSelect.dispatchEvent(new Event('change'));
                setTimeout(()=>{
                  modelSelect.value=model;
                  modelSelect.dispatchEvent(new Event('change'));
                  modelSearchInput.value='';
                  searchSuggestions.classList.add('hidden');
                },300);
              });
              searchSuggestions.appendChild(div);
            });
            searchSuggestions.classList.remove('hidden');
          })
          .catch(()=>searchSuggestions.classList.add('hidden'));
      },280);
    });
    document.addEventListener('click', e=>{
      if (!modelSearchInput.contains(e.target) && !searchSuggestions.contains(e.target)){
        searchSuggestions.classList.add('hidden');
      }
    });
  }

  /* 搜索表单场景级联（简化版：若存在独立 search_res_type / search_res_loc） */
(function initScenarioCascading(){
  const form = document.getElementById('searchForm');
  if (!form) return;
  const typeSel = form.querySelector('select[name="search_res_type"]');
  const locSel  = form.querySelector('select[name="search_res_loc"]');
  if (!typeSel || !locSel) return;

  function setLocOptions(options, enable){
    const prev = locSel.value;
    locSel.innerHTML = enable
      ? '<option value="">-- 选择风阻位置 --</option>'
      : '<option value="">-- 请先选择风阻类型 --</option>';
    (options||[]).forEach(v=>{
      const o=document.createElement('option');
      o.value=v; o.textContent=v; locSel.appendChild(o);
    });
    if (enable && prev && options && options.includes(prev)){
      locSel.value=prev;
    } else if (!enable){
      locSel.value='';
    }
    locSel.disabled=!enable;
  }

  async function refreshLocByType(rt){
    if (!rt){ setLocOptions([], false); return; }
    if (rt === '空载'){
      locSel.innerHTML='<option value="无" selected>无</option>';
      locSel.disabled=true;
      return;
    }
    try{
      const rsp = await fetch(`/get_resistance_locations_by_type/${encodeURIComponent(rt)}`);
      const list = await rsp.json();
      setLocOptions(Array.isArray(list)?list:[], true);
    }catch(_){
      setLocOptions([], false);
    }
  }

  locSel.innerHTML='<option value="">-- 请先选择风阻类型 --</option>';
  locSel.disabled=true;
  refreshLocByType((typeSel.value||'').trim());
  typeSel.addEventListener('change', ()=>refreshLocByType((typeSel.value||'').trim()));
})();

  /* ========================================================
   * Like / Add / Remove / Restore / Clear 事件委托
   * ====================================================== */
  function updateLikeIcons(modelId, conditionId, isLiked){
    dom.all(`.like-button[data-model-id="${modelId}"][data-condition-id="${conditionId}"]`)
      .forEach(btn=>{
        const ic = btn.querySelector('i');
        if (!ic) return;
        ic.classList.toggle('text-red-500', isLiked);
        ic.classList.toggle('text-gray-400', !isLiked);
      });
  }

  const MAX_ITEMS = Number(window.APP_CONFIG.maxItems||0);
  function currentSelectedCount(){
    return selectedKeySet.size || parseInt(selectedCountEl?.textContent||'0',10);
  }
  function ensureCanAdd(countToAdd=1){
    if (!MAX_ITEMS) return true;
    const curr=currentSelectedCount();
    if (curr + countToAdd > MAX_ITEMS){
      showInfo(`已达上限（${MAX_ITEMS})`);
      return false;
    }
    return true;
  }

  /* 延迟刷新调度 */
  let recentLikesRefreshTimer=null;
  const RECENT_LIKES_REFRESH_DELAY=650;
  let topRatingsRefreshTimer=null;
  const TOP_RATINGS_REFRESH_DELAY=800;

  function scheduleRecentLikesRefresh(){
    if (!recentLikesLoaded) return;
    clearTimeout(recentLikesRefreshTimer);
    recentLikesRefreshTimer=setTimeout(()=>reloadRecentLikes(), RECENT_LIKES_REFRESH_DELAY);
  }
  function scheduleTopRatingsRefresh(){
    if (!likesTabLoaded) return;
    clearTimeout(topRatingsRefreshTimer);
    topRatingsRefreshTimer=setTimeout(()=>reloadTopRatings(false), TOP_RATINGS_REFRESH_DELAY);
  }

  /* API Post */
  async function apiPost(url, payload){
    const resp=await fetch(url,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload||{})
    });
    if (!resp.ok) throw new Error('HTTP '+resp.status);
    return resp.json();
  }

  /* 侧栏自动打开逻辑 */
  const LS_KEY_SIDEBAR_TOGGLE_CLICKED = 'sidebar_toggle_clicked';
  function userHasClickedSidebarToggle(){
    try { return localStorage.getItem(LS_KEY_SIDEBAR_TOGGLE_CLICKED)==='1'; } catch(_) { return false; }
  }
  function maybeAutoOpenSidebarOnAdd(){
    if (userHasClickedSidebarToggle()) return;
    window.__APP.layout?.openSidebar?.();
  }

  /* 主状态合并 */
  let __isShareLoaded = (function(){
    try {
      const usp=new URLSearchParams(window.location.search);
      return usp.get('share_loaded')==='1';
    }catch(_){ return false; }
  })();
  let __shareAxisApplied=false;

/* ========= State Patch Subsystem: Diff + Conditional Legacy Aliases ========= */

/* 快照容器（若热更新不覆盖） */
window.__APP.stateSnapshot = window.__APP.stateSnapshot || {
  likeKeysHash: null,
  selectedFanKeys: new Set(),
  removedFanKeys: new Set(),
  shareMetaHash: null,
  chartSignature: null
};
const __SS = window.__APP.stateSnapshot;

/* 简易哈希（避免引入重型算法；长度大时用首尾采样） */
function quickHashList(list){
  if (!Array.isArray(list)) return '[]';
  const len = list.length;
  if (len === 0) return 'len:0';
  if (len <= 40) return 'len:'+len+'|'+list.join(',');
  // 采样前 15 + 后 15
  const head = list.slice(0,15);
  const tail = list.slice(-15);
  return 'len:'+len+'|h:'+head.join(',')+'|t:'+tail.join(',');
}

/* ---------- Patch: like keys ---------- */
function patchLikeKeys(data){
  if (!('like_keys' in data)) return { changed:false, count: __SS.likeKeysHash? Number(__SS.likeKeysHash.split(':')[1]) : likedKeysSet.size, skipped:true };

  const incoming = Array.isArray(data.like_keys) ? data.like_keys : [];
  const newHash = quickHashList(incoming);
  const changed = newHash !== __SS.likeKeysHash;

  if (changed){
    likedKeysSet = new Set(incoming);
    __SS.likeKeysHash = newHash;
  }
  return { changed, skipped: !changed, count: incoming.length };
}

/* ---------- Patch: selected fans ---------- */
function patchSelectedFans(data){
  if (!('selected_fans' in data)) {
    return { changed:false, skipped:true, count: __SS.selectedFanKeys.size, added:[], removed:[] };
  }
  const fans = Array.isArray(data.selected_fans) ? data.selected_fans : [];
  const incomingKeys = new Set(fans.map(f=>f.key).filter(Boolean));
  const prevKeys = __SS.selectedFanKeys;

  let changed = false;
  const added = [];
  const removed = [];

  if (incomingKeys.size !== prevKeys.size) changed = true;
  if (!changed){
    for (const k of incomingKeys){
      if (!prevKeys.has(k)){ changed = true; break; }
    }
  }

  if (changed){
    for (const k of incomingKeys) if (!prevKeys.has(k)) added.push(k);
    for (const k of prevKeys) if (!incomingKeys.has(k)) removed.push(k);

    // F-02: Compute diff with lastSelectedFans and update local stores
    if (selectionStore && removedStore) {
      // Build map of last selected fans by key for quick lookup
      const lastFansMap = {};
      lastSelectedFans.forEach(fan => {
        if (fan && fan.key) {
          lastFansMap[fan.key] = fan;
        }
      });

      // Build map of incoming fans by key
      const incomingFansMap = {};
      fans.forEach(fan => {
        if (fan && fan.key) {
          incomingFansMap[fan.key] = fan;
        }
      });

      // Process removed items: add to removedStore
      removed.forEach(key => {
        const fan = lastFansMap[key];
        if (fan && fan.model_id && fan.condition_id) {
          removedStore.push({
            key: key,
            model_id: fan.model_id,
            condition_id: fan.condition_id,
            brand: fan.brand || '',
            model: fan.model || '',
            res_type: fan.res_type || '',
            res_loc: fan.res_loc || '',
            removed_at: new Date().toISOString()
          });
        }
      });

      // Process added items: update selectionStore (store only model_id, condition_id)
      added.forEach(key => {
        const fan = incomingFansMap[key];
        if (fan && fan.model_id && fan.condition_id) {
          selectionStore.add({
            model_id: fan.model_id,
            condition_id: fan.condition_id
          });
        }
      });

      // Update selectionStore to match current state
      // Build current selection list from incoming fans
      const currentSelection = fans
        .filter(f => f.model_id && f.condition_id)
        .map(f => ({
          model_id: f.model_id,
          condition_id: f.condition_id
        }));
      selectionStore.replace(currentSelection);
    }

    const diffPayload = {
      added,
      removed,
      current: Array.from(incomingKeys)
    };
    // 缓存最近一次 diff（便于调试）
    window.__APP.__latestSelectionDiff = diffPayload;
    // 若 color.js 尚未加载，做一个 pending 以便其加载后消费
    if (!window.__APP.color?.recycleRemovedKeys){
      window.__APP.__pendingSelectionDiff = diffPayload;
    }
    bus?.emit('selection:changed', diffPayload);

    __SS.selectedFanKeys = incomingKeys;
    rebuildSelectedFans(fans);
    
    // Update lastSelectedFans for next diff (F-02)
    lastSelectedFans = fans.slice();
  }

  return { changed, skipped: !changed, count: fans.length, added, removed };
}


/* ---------- Patch: recently removed (F-01, F-02: ignore server data) ---------- */
function patchRemovedFans(data){
  // F-01: No longer consume server's recently_removed_fans
  // The removed list is now managed entirely by local removedStore
  // Server may still send recently_removed_fans but we ignore it
  
  // Always return skipped since we no longer process this from server
  return { changed:false, skipped:true, count: removedStore ? removedStore.list().length : 0 };
}

/* ---------- Patch: share meta ---------- */
function patchShareMeta(data){
  if (!('share_meta' in data) || !data.share_meta) {
    return { changed:false, skipped:true, axisApplied:false };
  }
  const meta = data.share_meta;
  const raw = JSON.stringify([
    meta.show_raw_curves, meta.show_fit_curves,
    meta.pointer_x_rpm, meta.pointer_x_noise_db,
    meta.legend_hidden_keys
  ]);
  const changed = raw !== __SS.shareMetaHash;
  let axisApplied = false;

  if (changed){
    applyServerStatePatchColorIndices(meta);
    if (window.__APP.chart && typeof window.__APP.chart.setPendingShareMeta === 'function'){
      window.__APP.chart.setPendingShareMeta({
        show_raw_curves: meta.show_raw_curves,
        show_fit_curves: meta.show_fit_curves,
        pointer_x_rpm: meta.pointer_x_rpm,
        pointer_x_noise_db: meta.pointer_x_noise_db,
        legend_hidden_keys: meta.legend_hidden_keys
      });
    }
    if (__isShareLoaded && data.chart_data && data.chart_data.x_axis_type){
      const axisCandidate = (data.chart_data.x_axis_type==='noise') ? 'noise_db' : data.chart_data.x_axis_type;
      if (window.__APP.chart?.forceAxis){
        window.__APP.chart.forceAxis(axisCandidate);
        axisApplied = true;
      }
    }
    __SS.shareMetaHash = raw;
  }
  return { changed, skipped: !changed, axisApplied };
}

/* ---------- Patch: chart data ---------- */
function patchChartData(data){
  if (!('chart_data' in data) || !data.chart_data){
    return { changed:false, skipped:true, series:0 };
  }
  const cd = data.chart_data;
  const seriesCount = Array.isArray(cd.series) ? cd.series.length
    : Array.isArray(cd.datasets) ? cd.datasets.length
    : 0;
  const firstKey = (cd.series && cd.series[0]?.key) || (cd.datasets && cd.datasets[0]?.key) || '';
  const sig = `${cd.x_axis_type||''}|${seriesCount}|${firstKey}`;
  const changed = sig !== __SS.chartSignature;
  if (changed){
    postChartData(cd);
    __SS.chartSignature = sig;
  }
  return { changed, skipped: !changed, series: seriesCount, xAxis: cd.x_axis_type };
}

/* ---------- Patch: error & toast ---------- */
function patchErrorAndToast(data, successMsg){
  if (data.error_message){
    hideLoading('op');
    showError(data.error_message);
    return { abort:true };
  } else {
    if (successMsg) showSuccess(successMsg);
    hideLoading('op');
    autoCloseOpLoading();
    return { abort:false };
  }
}

/* ---------- 主调度 processState (增强版) ---------- */
function processState(data, successMsg){
  const bus = window.__APP.bus;
  bus?.emit('state:beforeApply', { raw:data });

  const toast = patchErrorAndToast(data, successMsg);
  if (toast.abort){
    bus?.emit('state:error', { message: data.error_message });
    return;
  }

  const likeSummary     = patchLikeKeys(data);           bus?.emit('state:patch:likeKeys', likeSummary);
  const selectedSummary = patchSelectedFans(data);       bus?.emit('state:patch:selectedFans', selectedSummary);
  const removedSummary  = patchRemovedFans(data);        bus?.emit('state:patch:removedFans', removedSummary);
  const shareSummary    = patchShareMeta(data);          bus?.emit('state:patch:shareMeta', shareSummary);
  const chartSummary    = patchChartData(data);          bus?.emit('state:patch:chartData', chartSummary);

  // 只有其中有变化时才做 UI 调整，减少不必要的 reflow
  if (!(likeSummary.skipped && selectedSummary.skipped && removedSummary.skipped && shareSummary.skipped && chartSummary.skipped)){
    syncQuickActionButtons();
    window.__APP.layout?.refreshMarquees?.();
    window.__APP.layout?.scheduleAdjust?.();
  }

  const summary = {
    likeKeys: likeSummary,
    selectedFans: selectedSummary,
    removedFans: removedSummary,
    shareMeta: shareSummary,
    chartData: chartSummary,
    skipped: {
      likeKeys: likeSummary.skipped,
      selectedFans: selectedSummary.skipped,
      removedFans: removedSummary.skipped,
      shareMeta: shareSummary.skipped,
      chartData: chartSummary.skipped
    }
  };
  bus?.emit('state:afterApply', { summary });
}

  /* 点击事件委托 */
  document.addEventListener('click', async e=>{
    /* 点赞 / 取消 */
    const likeBtn = safeClosest(e.target, '.like-button');
    if (likeBtn){
      if (needThrottle('like') && !globalThrottle()) return;
      const modelId=likeBtn.dataset.modelId;
      const conditionId=likeBtn.dataset.conditionId;
      if (!modelId || !conditionId){ showError('缺少点赞标识'); return; }

      const icon = likeBtn.querySelector('i');
      const prevLiked = icon.classList.contains('text-red-500');
      const nextLiked = !prevLiked;
      const url = prevLiked ? '/api/unlike' : '/api/like';

      updateLikeIcons(modelId, conditionId, nextLiked);
      const keyStr = `${modelId}_${conditionId}`;
      if (nextLiked) likedKeysSet.add(keyStr); else likedKeysSet.delete(keyStr);

      fetch(url,{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ model_id:modelId, condition_id:conditionId })
      })
        .then(r=>r.json())
        .then(d=>{
          if (!d.success){
            updateLikeIcons(modelId, conditionId, prevLiked);
            if (prevLiked) likedKeysSet.add(keyStr); else likedKeysSet.delete(keyStr);
            showError(d.error_message||'点赞操作失败');
            return;
          }
          if (Array.isArray(d.like_keys)){
            likedKeysSet=new Set(d.like_keys);
            const finalLiked = likedKeysSet.has(keyStr);
            updateLikeIcons(modelId, conditionId, finalLiked);
          }
          scheduleRecentLikesRefresh();
          scheduleTopRatingsRefresh();
          showSuccess(prevLiked ? '已取消点赞':'已点赞');
        })
        .catch(err=>{
          updateLikeIcons(modelId, conditionId, prevLiked);
            if (prevLiked) likedKeysSet.add(keyStr); else likedKeysSet.delete(keyStr);
            showError('网络错误：'+err.message);
        });
      return;
    }

    /* 快速移除 */
    const quickRemove = safeClosest(e.target, '.js-list-remove');
    if (quickRemove){
      const { brand, model, resType, resLoc } = quickRemove.dataset;
      const keyStr = `${unescapeHtml(brand)}||${unescapeHtml(model)}||${unescapeHtml(resType)}||${unescapeHtml(resLoc)}`;
      const targetRow = dom.all('#selectedFansList .fan-item').find(div=>div.getAttribute('data-map')===keyStr);
      if (!targetRow){ showInfo('该数据已不在图表中'); syncQuickActionButtons(); return; }
      const fanKey = targetRow.getAttribute('data-fan-key');
      if (!fanKey){ showError('未找到可移除的条目'); return; }
      showLoading('op','移除中...');
      try {
        const data = await apiPost('/api/remove_fan',{ fan_key:fanKey });
        processState(data,'已移除');
      } catch(err){
        hideLoading('op'); showError('移除失败: '+err.message);
      }
      return;
    }

    /* 快速添加 */
    const addSelectors=['.js-ranking-add','.js-search-add','.js-rating-add','.js-likes-add'];
    for (const sel of addSelectors){
      const btn=safeClosest(e.target, sel);
      if (btn){
        const key=mapKeyFromDataset(btn.dataset);
        if (selectedMapSet.has(key)){
          showInfo('该数据已添加');
          syncQuickActionButtons();
          return;
        }
        if (!ensureCanAdd()) return;
        showLoading('op','添加中...');
        try {
          const { brand, model, resType, resLoc } = btn.dataset;
          const rl = unescapeHtml(resLoc);
          const resLocPayload = (rl === '无') ? '' : rl;
          const data = await apiPost('/api/add_fan',{
            brand: unescapeHtml(brand),
            model: unescapeHtml(model),
            res_type: unescapeHtml(resType),
            res_loc: resLocPayload
          });
          processState(data,'添加成功');
          maybeAutoOpenSidebarOnAdd();
        } catch(err){
          hideLoading('op'); showError('添加失败: '+err.message);
        }
        return;
      }
    }

    /* 已选单行移除 */
    const removeBtn = safeClosest(e.target,'.js-remove-fan');
    if (removeBtn){
      showLoading('op','移除中...');
      try {
        const data=await apiPost('/api/remove_fan',{ fan_key: removeBtn.dataset.fanKey });
        processState(data,'已移除');
      }catch(err){
        hideLoading('op'); showError('移除失败: '+err.message);
      }
      return;
    }

    /* 恢复 */
    const restoreBtn = safeClosest(e.target,'.js-restore-fan');
    if (restoreBtn){
      const fanKey=restoreBtn.dataset.fanKey;
      if (selectedKeySet.has(fanKey)){
        const row=restoreBtn.closest('.fan-item');
        if (row) row.remove();
        showInfo('该数据已在图表中，已从最近移除列表移除');
        return;
      }
      showLoading('op','恢复中...');
      try {
        const data=await apiPost('/api/restore_fan',{ fan_key:fanKey });
        processState(data,'已恢复');
      }catch(err){
        hideLoading('op'); showError('恢复失败: '+err.message);
      }
      return;
    }

    /* 清空确认 */
    if (e.target.id === 'clearAllBtn'){
      const state=e.target.getAttribute('data-state') || 'normal';
      if (state==='normal'){
        e.target.setAttribute('data-state','confirming');
        e.target.innerHTML=`
          <div class="clear-confirm-wrapper">
            <button id="confirmClearAll" class="bg-red-600 text-white hover:bg-red-700">确认</button>
            <button id="cancelClearAll" class="bg-gray-400 text-white hover:bg-gray-500">取消</button>
          </div>`;
        window.__APP.layout?.scheduleAdjust?.();
      }
      return;
    }
    if (e.target.id === 'cancelClearAll'){
      const btn=$('#clearAllBtn');
      if (btn){
        btn.setAttribute('data-state','normal');
        btn.textContent='移除所有';
      }
      window.__APP.layout?.scheduleAdjust?.();
      return;
    }
    if (e.target.id === 'confirmClearAll'){
      const btn=$('#clearAllBtn');
      showLoading('op','清空中...');
      try {
        const data=await apiPost('/api/clear_all',{});
        processState(data,'已全部移除');
      }catch(err){
        hideLoading('op'); showError('清空失败: '+err.message);
      }finally{
        if (btn){
          btn.setAttribute('data-state','normal');
          btn.textContent='移除所有';
        }
        window.__APP.layout?.scheduleAdjust?.();
      }
      return;
    }
  });

  /* 表单提交（添加） */
  if (fanForm){
    fanForm.addEventListener('submit', async e=>{
      e.preventDefault();
      const brand = brandSelect.value.trim();
      const model = modelSelect.value.trim();
      const res_type = resTypeSelect.value.trim();
      let res_loc = resLocSelect.value.trim();
      if (!brand || !model){ showError('请先选择品牌与型号'); return; }
      if (!res_type){ showError('请选择风阻类型'); return; }
      if (res_type === '空载') res_loc='无';
      if (!res_loc) res_loc='全部';
      if (res_type !== '全部' && res_loc !== '全部'){
        const mapKey = `${brand}||${model}||${res_type}||${res_loc}`;
        if (selectedMapSet.has(mapKey)){ showInfo('该数据已添加'); return; }
      }
      if (!ensureCanAdd()) return;
      showLoading('op','添加中...');
      try {
        const res_loc_payload = (res_loc === '无') ? '' : res_loc;
        const data = await apiPost('/api/add_fan',{ brand, model, res_type, res_loc: res_loc_payload });
        processState(data, data.error_message ? '' : '添加成功');
        maybeAutoOpenSidebarOnAdd();
      }catch(err){
        hideLoading('op'); showError('添加失败: '+err.message);
      }
    });
  }
  
  /* ========================================================
   * API 导出
   * ====================================================== */
  window.__APP.stateUI = {
    rebuildSelectedFans,
    rebuildRemovedFans,
    rebuildRecentLikes,
    reloadRecentLikes,
    loadRecentLikesIfNeeded,
    reloadTopRatings,
    loadLikesIfNeeded,
    renderSearchResults,
    processState,
    syncQuickActionButtons
  };
  
})();
