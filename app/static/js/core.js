/* core.js
 * Phase 3 Commit 2
 * 已移除：layout / overlay / 手势 / splitter / resizer / tabs / marquee / tooltip / focus trap / 自动高度 等外壳逻辑
 * 保留：数据/状态/搜索/排行/点赞/添加移除/表单级联/最近点赞/缓存/Toast 等业务逻辑
 * 交互壳相关功能统一依赖 layout.js (window.__APP.layout.*)
 */

window.APP_CONFIG = window.APP_CONFIG || { clickCooldownMs: 2000, maxItems: 0 };
window.__APP = window.__APP || {};

/* -------------------------------------------------------
 * DOM 缓存
 * ----------------------------------------------------- */
(function initDomCache(){
  const cache = Object.create(null);
  function one(sel, scope){
    if (!sel) return null;
    if (!scope && cache[sel]) return cache[sel];
    const el = (scope||document).querySelector(sel);
    if (!scope) cache[sel] = el;
    return el;
  }
  function all(sel, scope){ return Array.from((scope||document).querySelectorAll(sel)); }
  function clear(sel){ if(sel) delete cache[sel]; else Object.keys(cache).forEach(k=>delete cache[k]); }
  window.__APP.dom = { one, all, clear };
})();
const $ = s => window.__APP.dom.one(s);

/* -------------------------------------------------------
 * 帧写入调度
 * ----------------------------------------------------- */
window.__APP.scheduler = (function(){
  const writeQueue = [];
  let scheduled = false;
  function flush(){
    scheduled = false;
    for (let i=0;i<writeQueue.length;i++){
      try { writeQueue[i](); } catch(e){ console.error('[scheduler write error]', e); }
    }
    writeQueue.length = 0;
  }
  function write(fn){
    writeQueue.push(fn);
    if (!scheduled){
      scheduled = true;
      requestAnimationFrame(flush);
    }
  }
  return { write };
})();

/* -------------------------------------------------------
 * TTL 缓存
 * ----------------------------------------------------- */
window.__APP.cache = (function(){
  const store = new Map();
  const DEFAULT_TTL = 180000;
  const key = (ns, payload) => ns + '::' + JSON.stringify(payload||{});
  function get(ns, payload){
    const k = key(ns, payload);
    const rec = store.get(k);
    if (!rec) return null;
    if (Date.now() > rec.expire){ store.delete(k); return null; }
    return rec.value;
  }
  function set(ns, payload, value, ttl=DEFAULT_TTL){
    store.set(key(ns,payload), { value, expire: Date.now()+ttl });
    return value;
  }
  function clear(ns){
    if (!ns){ store.clear(); return; }
    for (const k of store.keys()){
      if (k.startsWith(ns+'::')) store.delete(k);
    }
  }
  return { get, set, clear };
})();

/* -------------------------------------------------------
 * Polyfills / safeClosest
 * ----------------------------------------------------- */
(function(){
  if (typeof Element !== 'undefined'){
    if (!Element.prototype.matches){
      Element.prototype.matches =
        Element.prototype.msMatchesSelector ||
        Element.prototype.webkitMatchesSelector ||
        function(selector){
          const list = (this.document || this.ownerDocument).querySelectorAll(selector);
          let i=0; while(list[i] && list[i] !== this) i++; return !!list[i];
        };
    }
    if (!Element.prototype.closest){
      Element.prototype.closest = function(selector){
        let el = this;
        while (el && el.nodeType === 1){
          if (el.matches(selector)) return el;
            el = el.parentElement;
        }
        return null;
      };
    }
  }
  window.safeClosest = function safeClosest(start, selector){
    if (!start) return null;
    let el = start;
    if (el.nodeType && el.nodeType !== 1) el = el.parentElement;
    if (!el) return null;
    if (el.closest){
      try { return el.closest(selector); } catch(_){}
    }
    while (el && el.nodeType === 1){
      if (el.matches && el.matches(selector)) return el;
      el = el.parentElement;
    }
    return null;
  };
})();

/* -------------------------------------------------------
 * Toast / Loading / Throttle / HTML Escaping
 * ----------------------------------------------------- */
const toastContainerId = 'toastContainer';
function ensureToastRoot(){
  let r = document.getElementById(toastContainerId);
  if (!r){ r = document.createElement('div'); r.id = toastContainerId; document.body.appendChild(r); }
  return r;
}
let toastIdCounter = 0;
const activeLoadingKeys = new Set();
const loadingTimeoutMap = new Map();

function createToast(msg, type='info', opts={}){
  const container = ensureToastRoot();
  const { autoClose=(type==='loading'?false:2600), id='t_'+(++toastIdCounter) } = opts;
  while (document.getElementById(id)) document.getElementById(id).remove();
  const iconMap = {
    success:'<i class="icon fa-solid fa-circle-check" style="color:var(--toast-success)"></i>',
    error:'<i class="icon fa-solid fa-circle-xmark" style="color:var(--toast-error)"></i>',
    loading:'<i class="icon fa-solid fa-spinner fa-spin" style="color:var(--toast-loading)"></i>',
    info:'<i class="icon fa-solid fa-circle-info" style="color:#3B82F6"></i>'
  };
  const div = document.createElement('div');
  div.className = 'toast '+type;
  div.id = id;
  div.innerHTML = `${iconMap[type]||iconMap.info}<div class="msg">${msg}</div><span class="close-btn" data-close="1">&times;</span>`;
  container.appendChild(div);
  if (autoClose) setTimeout(()=>closeToast(id), autoClose);
  return id;
}
function closeToast(id){
  const el = document.getElementById(id);
  if (!el) return;
  el.style.animation='toast-out .25s forwards';
  setTimeout(()=>el.remove(),240);
}
document.addEventListener('click', e=>{
  if (e.target.closest && e.target.closest('[data-close]')){
    const t = e.target.closest('.toast');
    if (t) closeToast(t.id);
  }
});

function showLoading(key,text='加载中...'){
  if (activeLoadingKeys.has(key)){
    const existing = document.getElementById('loading_'+key);
    const msgEl = existing?.querySelector('.msg');
    if (msgEl) msgEl.textContent = text;
    return;
  }
  activeLoadingKeys.add(key);
  createToast(text,'loading',{ id:'loading_'+key });
  const to = setTimeout(()=>{ if (activeLoadingKeys.has(key)) hideLoading(key); },12000);
  loadingTimeoutMap.set(key,to);
}
function hideLoading(key){
  activeLoadingKeys.delete(key);
  const id='loading_'+key;
  while (document.getElementById(id)) document.getElementById(id).remove();
  const t = loadingTimeoutMap.get(key);
  if (t){ clearTimeout(t); loadingTimeoutMap.delete(key); }
}
function autoCloseOpLoading(){
  hideLoading('op');
  document.querySelectorAll('.toast.loading').forEach(t=>{
    const msgEl=t.querySelector('.msg');
    if(!msgEl) return;
    const text=(msgEl.textContent||'').trim();
    if (/^(添加中|移除中)/.test(text)) t.remove();
  });
}

const showSuccess = m=>createToast(m,'success');
const showError   = m=>createToast(m,'error');
const showInfo    = m=>createToast(m,'info',{autoClose:1800});

let lastGlobalAction = 0;
function globalThrottle(){
  const cd = Number(window.APP_CONFIG.clickCooldownMs||2000);
  const now = Date.now();
  if (now - lastGlobalAction < cd){
    showInfo('操作过于频繁，请稍后');
    return false;
  }
  lastGlobalAction = now;
  return true;
}
const NO_THROTTLE_ACTIONS = new Set(['add','remove','restore','xaxis']);
const needThrottle = action => !NO_THROTTLE_ACTIONS.has(action);

const ESC_MAP = { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' };
function escapeHtml(s){ return String(s??'').replace(/[&<>"']/g,c=>ESC_MAP[c]); }
function unescapeHtml(s){
  const map = {'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':'\''};
  return String(s??'').replace(/&(amp|lt|gt|quot|#39);/g,m=>map[m]);
}

/* -------------------------------------------------------
 * 选中 / 快速按钮索引与构建
 * ----------------------------------------------------- */
let selectedMapSet = new Set();
let selectedKeySet = new Set();
function rebuildSelectedIndex(){
  selectedMapSet.clear();
  selectedKeySet.clear();
  window.__APP.dom.all('#selectedFansList .fan-item').forEach(div=>{
    const key = div.getAttribute('data-fan-key');
    if (key) selectedKeySet.add(key);
    const map = div.getAttribute('data-map');
    if (map) selectedMapSet.add(map);
  });
}
rebuildSelectedIndex();

function formatScenario(rt, rl){
  const rtype = escapeHtml(rt||'');
  const raw = rl ?? '';
  const blank = (String(raw).trim()==='' || String(raw).trim()==='无');
  return blank ? rtype : `${rtype}(${escapeHtml(raw)})`;
}

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
  btn.className = 'btn-add tooltip-btn ' + (
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
  window.__APP.dom.all('.btn-add.tooltip-btn').forEach(btn=>{
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

/* -------------------------------------------------------
 * Rebuild 选中 / 移除列表
 * ----------------------------------------------------- */
const selectedListEl    = $('#selectedFansList');
const removedListEl     = $('#recentlyRemovedList');
const selectedCountEl   = $('#selectedCount');
const clearAllContainer = $('#clearAllContainer');

function rebuildSelectedFans(fans){
  if (!selectedListEl) return;
  selectedListEl.innerHTML='';
  ensureColorIndicesForSelected(fans||[]);
  if (!fans || fans.length===0){
    if (selectedCountEl) selectedCountEl.textContent='0';
    clearAllContainer?.classList.add('hidden');
    rebuildSelectedIndex();
    if (typeof window.applySidebarColors === 'function')
      requestAnimationFrame(window.applySidebarColors);
    window.__APP.layout?.refreshMarquees?.();
    window.__APP.layout?.scheduleAdjust?.();
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
    const div = document.createElement('div');
    div.className='fan-item flex items-center justify-between p-3 border border-gray-200 rounded-md';
    div.dataset.fanKey = item.key;
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
}

/* -------------------------------------------------------
 * 最近点赞（懒加载 + 重建）
 * ----------------------------------------------------- */
let recentLikesLoaded = false;
const recentLikesListEl = $('#recentLikesList');

function rebuildRecentLikes(list){
  if (!recentLikesListEl) return;
  recentLikesListEl.innerHTML='';
  if (!list || list.length===0){
    recentLikesListEl.innerHTML='<p class="text-gray-500 text-center py-6">暂无最近点赞</p>';
    window.__APP.layout?.refreshMarquees?.();
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
    const metaParts = [];
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
    const groupDiv = document.createElement('div');
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
}
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

/* -------------------------------------------------------
 * 排行（点赞榜） + 缓存
 * ----------------------------------------------------- */
let likesTabLoaded = false;
let likesTabLastLoad = 0;
const LIKES_TTL = 120000;
function needReloadLikes(){
  if (!likesTabLoaded) return true;
  return (Date.now() - likesTabLastLoad) > LIKES_TTL;
}
let _rtPending = false;
let _rtDebounce = null;

function reloadTopRatings(debounce=true){
  if (debounce){
    if (_rtDebounce) clearTimeout(_rtDebounce);
    return new Promise(resolve=>{
      _rtDebounce = setTimeout(()=>resolve(reloadTopRatings(false)), 250);
    });
  }
  if (_rtPending) return Promise.resolve();
  _rtPending = true;

  const cacheNS = 'top_ratings';
  const payload = {};
  const cached = window.__APP.cache.get(cacheNS, payload);
  if (cached && !needReloadLikes()){
    applyRatingTable(cached);
    _rtPending=false;
    return Promise.resolve();
  }

  const tbody = document.getElementById('ratingRankTbody');
  if (tbody && !likesTabLoaded){
    tbody.innerHTML='<tr><td colspan="7" class="text-center text-gray-500 py-6">加载中...</td></tr>';
  }

  return fetch('/api/top_ratings')
    .then(r=>r.json())
    .then(data=>{
      if (!data.success){ showError('更新点赞排行失败'); return; }
      window.__APP.cache.set(cacheNS, payload, data, LIKES_TTL);
      applyRatingTable(data);
    })
    .catch(err=>showError('获取点赞排行异常: '+err.message))
    .finally(()=>{ _rtPending=false; });
}

function applyRatingTable(data){
  const list = data.data || [];
  const tbody = document.getElementById('ratingRankTbody');
  if (!tbody) return;
  if (!list.length){
    tbody.innerHTML='<tr><td colspan="7" class="text-center text-gray-500 py-6">暂无点赞排行数据</td></tr>';
    return;
  }
  let html='';
  list.forEach((r,idx)=>{
    const rank = idx+1;
    const medal = rank===1?'gold':rank===2?'silver':rank===3?'bronze':'';
    const rankCell = medal?`<i class="fa-solid fa-medal ${medal} text-2xl"></i>`:`<span class="font-medium">${rank}</span>`;
    const locRaw = r.resistance_location_zh || '';
    const scen = formatScenario(r.resistance_type_zh, locRaw);
    const locForKey = locRaw || '全部';
    const mapKey = `${escapeHtml(r.brand_name_zh)}||${escapeHtml(r.model_name)}||${escapeHtml(r.resistance_type_zh)}||${escapeHtml(locForKey)}`;
    const isDup = selectedMapSet.has(mapKey);
    const btnMode = isDup?'remove':'add';
    const btnClass = isDup?'js-list-remove':'js-rating-add';
    const btnTitle = isDup?'从图表移除':'添加到图表';
    const btnIcon  = isDup?'<i class="fa-solid fa-xmark"></i>':'<i class="fa-solid fa-plus"></i>';
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
  tbody.innerHTML = html;
  likesTabLoaded = true;
  likesTabLastLoad = Date.now();
  syncQuickActionButtons();
  // 跑马灯 DOM 包裹由 layout.js 接管：refreshMarquees
  window.__APP.layout?.refreshMarquees?.();
}

function loadLikesIfNeeded(){
  if (!needReloadLikes()) return;
  showLoading('rating-refresh','加载好评榜...');
  reloadTopRatings(false).finally(()=>hideLoading('rating-refresh'));
}

/* -------------------------------------------------------
 * 搜索
 * ----------------------------------------------------- */
const searchForm = $('#searchForm');
const searchAirflowTbody = $('#searchAirflowTbody');
const searchLikesTbody   = $('#searchLikesTbody');
let SEARCH_RESULTS_RAW = [];

function fillSearchTable(tbody, list){
  if (!tbody) return;
  if (!list.length){
    tbody.innerHTML='<tr><td colspan="7" class="text-center text-gray-500 py-6">没有符合条件的结果</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(r=>{
    const brand = r.brand_name_zh;
    const model = r.model_name;
    const resType = r.resistance_type_zh;
    const resLocRaw = r.resistance_location_zh || '';
    const scenLabel = formatScenario(resType, resLocRaw);
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
  const byLikes   = SEARCH_RESULTS_RAW.slice().sort((a,b)=>(b.like_count||0)-(a.like_count||0));
  const labelEl = document.getElementById('searchConditionLabel');
  if (labelEl) labelEl.textContent = conditionLabel;
  fillSearchTable(searchAirflowTbody, byAirflow);
  fillSearchTable(searchLikesTbody, byLikes);
  syncQuickActionButtons();
  window.__APP.layout?.refreshMarquees?.();
}

if (searchForm){
  searchForm.addEventListener('submit', async e=>{
    e.preventDefault();
    if (!searchForm.reportValidity()) return;
    if (needThrottle('search') && !globalThrottle()) return;
    const fd = new FormData(searchForm);
    const payload = {}; fd.forEach((v,k)=>payload[k]=v);

    const cacheNS='search';
    const cached = window.__APP.cache.get(cacheNS, payload);

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
          window.__APP.cache.set(cacheNS, payload, fresh);
          if (!cached || JSON.stringify(cached.search_results)!==JSON.stringify(fresh.search_results)){
            renderSearchResults(fresh.search_results, fresh.condition_label);
            showInfo('已刷新最新结果');
          }
        }
      } catch(_){}
    }

    if (cached){
      renderSearchResults(cached.search_results, cached.condition_label);
      showInfo('已使用缓存结果，后台刷新中...');
      refreshFromServer();
    } else {
      showLoading('op','搜索中...');
      try {
        const data = await doFetch();
        if (!data.success){
          hideLoading('op'); showError(data.error_message||'搜索失败');
          searchAirflowTbody.innerHTML='<tr><td colspan="7" class="text-center text-gray-500 py-6">搜索失败</td></tr>';
          searchLikesTbody.innerHTML  ='<tr><td colspan="7" class="text-center text-gray-500 py-6">搜索失败</td></tr>';
          return;
        }
        window.__APP.cache.set(cacheNS, payload, data);
        renderSearchResults(data.search_results, data.condition_label);
        hideLoading('op'); showSuccess('搜索完成');
        document.querySelector('.tab-nav[data-tab-group="right-panel"] .tab-nav-item[data-tab="search-results"]')?.click();
      } catch(err){
        hideLoading('op'); showError('搜索异常: '+err.message);
        searchAirflowTbody.innerHTML='<tr><td colspan="7" class="text-center text-gray-500 py-6">搜索失败</td></tr>';
        searchLikesTbody.innerHTML  ='<tr><td colspan="7" class="text-center text-gray-500 py-6">搜索失败</td></tr>';
      }
    }
  });
}

/* -------------------------------------------------------
 * 添加表单级联 (fanForm)
 * ----------------------------------------------------- */
const fanForm = $('#fanForm');
const brandSelect   = $('#brandSelect');
const modelSelect   = $('#modelSelect');
const resTypeSelect = $('#resTypeSelect');
const resLocSelect  = $('#resLocSelect');

if (brandSelect){
  brandSelect.addEventListener('change', ()=>{
    const b = (brandSelect.value || '').trim();
    modelSelect.innerHTML   = `<option value="">${b ? '-- 选择型号 --' : '-- 请先选择品牌 --'}</option>`;
    modelSelect.disabled    = !b;
    resTypeSelect.innerHTML = `<option value="">${b ? '-- 请先选择型号 --' : '-- 请先选择品牌 --'}</option>`;
    resTypeSelect.disabled  = true;
    resLocSelect.innerHTML  = `<option value="">${b ? '-- 请先选择型号 --' : '-- 请先选择品牌 --'}</option>`;
    resLocSelect.disabled   = true;
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
    resTypeSelect.disabled  = !m;
    resLocSelect.innerHTML = m
      ? '<option value="">-- 请先选择风阻类型 --</option>'
      : '<option value="">-- 请先选择型号 --</option>';
    resLocSelect.disabled = true;
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
brandSelect && brandSelect.dispatchEvent(new Event('change'));

/* 型号搜索建议 */
const modelSearchInput = $('#modelSearchInput');
const searchSuggestions = $('#searchSuggestions');
let modelDebounceTimer;
if (modelSearchInput && searchSuggestions){
  modelSearchInput.addEventListener('input', ()=>{
    clearTimeout(modelDebounceTimer);
    const q = modelSearchInput.value.trim();
    if (q.length < 2){
      searchSuggestions.classList.add('hidden');
      return;
    }
    modelDebounceTimer = setTimeout(()=>{
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

/* -------------------------------------------------------
 * 共享 / 点赞 / 添加 / 移除 操作
 * ----------------------------------------------------- */
let likedKeysSet = new Set();

function mapKeyFromRowDataset(d){
  return `${unescapeHtml(d.brand||'')}||${unescapeHtml(d.model||'')}||${unescapeHtml(d.resType||'')}||${unescapeHtml(d.resLoc||'')}`;
}

function updateLikeIcons(modelId, conditionId, isLiked){
  window.__APP.dom.all(`.like-button[data-model-id="${modelId}"][data-condition-id="${conditionId}"]`)
    .forEach(btn=>{
      const ic = btn.querySelector('i');
      if (!ic) return;
      ic.classList.toggle('text-red-500', isLiked);
      ic.classList.toggle('text-gray-400', !isLiked);
    });
}

/* MAX Items 限制 */
const MAX_ITEMS = Number(window.APP_CONFIG.maxItems || 0);
function currentSelectedCount(){
  return selectedKeySet.size || parseInt(selectedCountEl?.textContent||'0',10);
}
function ensureCanAdd(countToAdd=1){
  if (!MAX_ITEMS) return true;
  const curr = currentSelectedCount();
  if (curr + countToAdd > MAX_ITEMS){
    showInfo(`已达上限（${MAX_ITEMS})`);
    return false;
  }
  return true;
}

/* ========== 事件委托 ========== */
document.addEventListener('click', async e=>{   
  /* 点赞 / 取消 */
  const likeBtn = safeClosest(e.target, '.like-button');
  if (likeBtn) {
    if (needThrottle('like') && !globalThrottle()) return;
    const modelId = likeBtn.dataset.modelId;
    const conditionId = likeBtn.dataset.conditionId;
    if (!modelId || !conditionId) { showError('缺少点赞标识'); return; }

    // 当前状态（按钮内 <i>）
    const icon = likeBtn.querySelector('i');
    const prevLiked = icon.classList.contains('text-red-500');
    const nextLiked = !prevLiked;
    const url = prevLiked ? '/api/unlike' : '/api/like';

    // 1) 乐观更新（立刻切换 UI ）
    updateLikeIcons(modelId, conditionId, nextLiked);

    // 2) 维护本地 likedKeysSet（乐观）
    const keyStr = `${modelId}_${conditionId}`;
    if (nextLiked) likedKeysSet.add(keyStr); else likedKeysSet.delete(keyStr);

    // 3) 不再 showLoading（避免频繁 Toast），改为轻量提示（可选）
    // showInfo(nextLiked ? '点赞中...' : '取消点赞中...');

    // 4) 发请求
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_id: modelId, condition_id: conditionId })
    })
      .then(r => r.json())
      .then(d => {
        if (!d.success) {
          // 回滚 UI
            updateLikeIcons(modelId, conditionId, prevLiked);
            if (prevLiked) likedKeysSet.add(keyStr); else likedKeysSet.delete(keyStr);
            showError(d.error_message || '点赞操作失败');
            return;
        }
        // 以服务端回传为准更新 likedKeysSet（防止并发误差）
        if (Array.isArray(d.like_keys)) {
          likedKeysSet = new Set(d.like_keys);
          // 统一再刷新一次对应图标（确保与服务器最终一致）
          const finalLiked = likedKeysSet.has(keyStr);
          updateLikeIcons(modelId, conditionId, finalLiked);
        }

        // 不再立即 reloadRecentLikes / reloadTopRatings
        // 改为延迟合并刷新（如果对应面板已加载过）
        scheduleRecentLikesRefresh();
        scheduleTopRatingsRefresh();

        showSuccess(prevLiked ? '已取消点赞' : '已点赞');
      })
      .catch(err => {
        // 网络错误回滚
        updateLikeIcons(modelId, conditionId, prevLiked);
        if (prevLiked) likedKeysSet.add(keyStr); else likedKeysSet.delete(keyStr);
        showError('网络错误：' + err.message);
      });

    return;
  }

  /* 快速移除 */
  const quickRemove = safeClosest(e.target, '.js-list-remove');
  if (quickRemove){
    const { brand, model, resType, resLoc } = quickRemove.dataset;
    const keyStr = `${unescapeHtml(brand)}||${unescapeHtml(model)}||${unescapeHtml(resType)}||${unescapeHtml(resLoc)}`;
    const targetRow = window.__APP.dom.all('#selectedFansList .fan-item')
      .find(div=>div.getAttribute('data-map')===keyStr);
    if (!targetRow){ showInfo('该数据已不在图表中'); syncQuickActionButtons(); return; }
    const fanKey = targetRow.getAttribute('data-fan-key');
    if (!fanKey){ showError('未找到可移除的条目'); return; }
    showLoading('op','移除中...');
    try{
      const data = await apiPost('/api/remove_fan',{ fan_key:fanKey });
      processState(data,'已移除');
    }catch(err){ hideLoading('op'); showError('移除失败: '+err.message); }
    return;
  }

  /* 快速添加 (ranking/search/rating/likes) */
  const addSelectors = ['.js-ranking-add','.js-search-add','.js-rating-add','.js-likes-add'];
  for (const sel of addSelectors){
    const btn = safeClosest(e.target, sel);
    if (btn){
      const key = mapKeyFromDataset(btn.dataset);
      if (selectedMapSet.has(key)){
        showInfo('该数据已添加');
        syncQuickActionButtons();
        return;
      }
      if (!ensureCanAdd()) return;
      showLoading('op','添加中...');
      try{
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
      }catch(err){ hideLoading('op'); showError('添加失败: '+err.message); }
      return;
    }
  }

  /* 已选列表单行移除 */
  const removeBtn = safeClosest(e.target, '.js-remove-fan');
  if (removeBtn){
    showLoading('op','移除中...');
    try{
      const data = await apiPost('/api/remove_fan',{ fan_key: removeBtn.dataset.fanKey });
      processState(data,'已移除');
    }catch(err){ hideLoading('op'); showError('移除失败: '+err.message); }
    return;
  }

  /* 恢复 */
  const restoreBtn = safeClosest(e.target, '.js-restore-fan');
  if (restoreBtn){
    const fanKey = restoreBtn.dataset.fanKey;
    if (selectedKeySet.has(fanKey)){
      const row = restoreBtn.closest('.fan-item');
      if (row) row.remove();
      showInfo('该数据已在图表中，已从最近移除列表移除');
      return;
    }
    showLoading('op','恢复中...');
    try{
      const data = await apiPost('/api/restore_fan',{ fan_key:fanKey });
      processState(data,'已恢复');
    }catch(err){ hideLoading('op'); showError('恢复失败: '+err.message); }
    return;
  }

  /* 清空确认 */
  if (e.target.id === 'clearAllBtn'){
    const state = e.target.getAttribute('data-state') || 'normal';
    if (state === 'normal'){
      e.target.setAttribute('data-state','confirming');
      e.target.innerHTML = `
        <div class="clear-confirm-wrapper">
          <button id="confirmClearAll" class="bg-red-600 text-white hover:bg-red-700">确认</button>
          <button id="cancelClearAll" class="bg-gray-400 text-white hover:bg-gray-500">取消</button>
        </div>`;
      window.__APP.layout?.scheduleAdjust?.();
    }
    return;
  }
  if (e.target.id === 'cancelClearAll'){
    const btn = $('#clearAllBtn');
    if (btn){
      btn.setAttribute('data-state','normal');
      btn.textContent='移除所有';
    }
    window.__APP.layout?.scheduleAdjust?.();
    return;
  }
  if (e.target.id === 'confirmClearAll'){
    const btn = $('#clearAllBtn');
    showLoading('op','清空中...');
    try{
      const data = await apiPost('/api/clear_all',{});
      processState(data,'已全部移除');
    }catch(err){ hideLoading('op'); showError('清空失败: '+err.message); }
    finally {
      if (btn){
        btn.setAttribute('data-state','normal');
        btn.textContent='移除所有';
      }
      window.__APP.layout?.scheduleAdjust?.();
    }
    return;
  }
});

/* 添加表单提交 */
if (fanForm){
  fanForm.addEventListener('submit', async e=>{
    e.preventDefault();
    const brand = brandSelect.value.trim();
    const model = modelSelect.value.trim();
    const res_type = resTypeSelect.value.trim();
    let res_loc = resLocSelect.value.trim();
    if (!brand || !model){ showError('请先选择品牌与型号'); return; }
    if (!res_type){ showError('请选择风阻类型'); return; }
    if (res_type === '空载') res_loc = '无';
    if (!res_loc) res_loc='全部';
    if (res_type !== '全部' && res_loc !== '全部'){
      const mapKey = `${brand}||${model}||${res_type}||${res_loc}`;
      if (selectedMapSet.has(mapKey)){ showInfo('该数据已添加'); return; }
    }
    if (!ensureCanAdd()) return;
    showLoading('op','添加中...');
    try{
      const res_loc_payload = (res_loc === '无') ? '' : res_loc;
      const data = await apiPost('/api/add_fan',{ brand, model, res_type, res_loc: res_loc_payload });
      processState(data, data.error_message ? '' : '添加成功');
      maybeAutoOpenSidebarOnAdd();
    }catch(err){ hideLoading('op'); showError('添加失败: '+err.message); }
  });
}

/* -------------------------------------------------------
 * Recent Likes / Top Ratings 延迟刷新调度（点赞后合并刷新）
 * ----------------------------------------------------- */
// === PATCH: 点赞 & 最近点赞 延迟刷新调度 ===
let recentLikesRefreshTimer = null;
const RECENT_LIKES_REFRESH_DELAY = 650;   // 可调：合并多次点赞后再刷新列表
let topRatingsRefreshTimer = null;
const TOP_RATINGS_REFRESH_DELAY = 800;

// 统一调度最近点赞刷新（仅当最近点赞面板曾经加载过再做刷新）
function scheduleRecentLikesRefresh() {
  if (!recentLikesLoaded) return; // 未加载过，不必刷新
  clearTimeout(recentLikesRefreshTimer);
  recentLikesRefreshTimer = setTimeout(() => {
    reloadRecentLikes();
  }, RECENT_LIKES_REFRESH_DELAY);
}

// 同理：好评榜（likesTabLoaded 为 true 后才刷新）
function scheduleTopRatingsRefresh() {
  if (!likesTabLoaded) return;
  clearTimeout(topRatingsRefreshTimer);
  topRatingsRefreshTimer = setTimeout(() => {
    reloadTopRatings(false);
  }, TOP_RATINGS_REFRESH_DELAY);
}

// 批量更新所有出现该 (model_id, condition_id) 的点赞图标
function updateLikeIcons(modelId, conditionId, isLiked) {
  window.__APP.dom.all(`.like-button[data-model-id="${modelId}"][data-condition-id="${conditionId}"]`)
    .forEach(btn => {
      const ic = btn.querySelector('i');
      if (!ic) return;
      ic.classList.toggle('text-red-500', isLiked);
      ic.classList.toggle('text-gray-400', !isLiked);
    });
}

/* -------------------------------------------------------
 * API & 状态处理
 * ----------------------------------------------------- */
async function apiPost(url, payload){
  const resp = await fetch(url, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(payload||{})
  });
  if (!resp.ok) throw new Error('HTTP '+resp.status);
  return resp.json();
}

let pendingShareMeta = null;
let __isShareLoaded = (function(){
  try {
    const usp = new URLSearchParams(window.location.search);
    return usp.get('share_loaded') === '1';
  } catch(_) { return false; }
})();
let __shareAxisApplied = false;

function processState(data, successMsg){
  const prevSelectedKeys = new Set(selectedKeySet);

  if (data.error_message){
    hideLoading('op');
    showError(data.error_message);
  } else {
    if (successMsg) showSuccess(successMsg);
    hideLoading('op');
    autoCloseOpLoading();
  }

  let pendingChart = null;
  if ('chart_data' in data) pendingChart = data.chart_data;

  if ('share_meta' in data && data.share_meta){
    // 颜色索引映射
    applyServerStatePatchColorIndices(data.share_meta);
  }

  if ('like_keys' in data) likedKeysSet = new Set(data.like_keys||[]);

  if ('selected_fans' in data){
    const incomingKeys = new Set((data.selected_fans || []).map(f=>f.key).filter(Boolean));
    try {
      prevSelectedKeys.forEach(k=>{ if (!incomingKeys.has(k)) releaseColorIndexForKey(k); });
    }catch(_){}
    assignUniqueIndicesForSelection(data.selected_fans);
    rebuildSelectedFans(data.selected_fans);
  }

  if ('recently_removed_fans' in data) rebuildRemovedFans(data.recently_removed_fans);

  if ('share_meta' in data && data.share_meta){
    if (window.__APP.chart && typeof window.__APP.chart.setPendingShareMeta === 'function'){
      window.__APP.chart.setPendingShareMeta({
        show_raw_curves: data.share_meta.show_raw_curves,
        show_fit_curves: data.share_meta.show_fit_curves,
        pointer_x_rpm: data.share_meta.pointer_x_rpm,
        pointer_x_noise_db: data.share_meta.pointer_x_noise_db,
        legend_hidden_keys: data.share_meta.legend_hidden_keys
      });
    }
    if (__isShareLoaded && data.chart_data && data.chart_data.x_axis_type){
      const axisCandidate = (data.chart_data.x_axis_type === 'noise')
        ? 'noise_db'
        : data.chart_data.x_axis_type;
      if (window.__APP.chart?.forceAxis) window.__APP.chart.forceAxis(axisCandidate);
    }
  }

  if (pendingChart) postChartData(pendingChart);

  syncQuickActionButtons();
  window.__APP.layout?.refreshMarquees?.();
  window.__APP.layout?.scheduleAdjust?.();
}

/* -------------------------------------------------------
 * 初始加载
 * ----------------------------------------------------- */
fetch('/api/state')
  .then(r=>r.json())
  .then(d=>processState(d,''))
  .catch(()=>{});

/* 自动打开侧栏（仅当用户没点过侧栏按钮且成功添加） */
const LS_KEY_SIDEBAR_TOGGLE_CLICKED = 'sidebar_toggle_clicked';
function userHasClickedSidebarToggle(){
  try { return localStorage.getItem(LS_KEY_SIDEBAR_TOGGLE_CLICKED) === '1'; } catch(_) { return false; }
}
function maybeAutoOpenSidebarOnAdd(){
  if (userHasClickedSidebarToggle()) return;
  window.__APP.layout?.openSidebar?.();
}

/* 查询次数显示 */
function loadQueryCount(){
  fetch('/api/query_count')
    .then(r=>r.json())
    .then(data=>{
      const el = document.getElementById('query-count');
      if (el) el.textContent = data.count;
    })
    .catch(()=>{});
}
document.addEventListener('DOMContentLoaded', loadQueryCount);

/* 访问起点上报（一次） */
(function initVisitStart(){
  try { if (sessionStorage.getItem('visit_started') === '1') return; } catch(_){}
  const payload = {
    screen_w: (screen && screen.width) || null,
    screen_h: (screen && screen.height) || null,
    device_pixel_ratio: window.devicePixelRatio || null,
    language: (navigator.languages && navigator.languages[0]) || navigator.language || null,
    is_touch: ('ontouchstart' in window) || (navigator.maxTouchPoints > 0)
  };
  fetch('/api/visit_start', {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify(payload),
    keepalive:true
  }).catch(()=>{}).finally(()=>{
    try { sessionStorage.setItem('visit_started','1'); } catch(_){}
  });
})();

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

/* -------------------------------------------------------
 * 统一模块引用注册（保持对旧调用的最小兼容）
 * ----------------------------------------------------- */
window.__APP.modules = {
  layout: {
    scheduleAdjust: ()=>window.__APP.layout?.scheduleAdjust?.(),
    refreshMarquees: ()=>window.__APP.layout?.refreshMarquees?.()
  },
  search: {
    render: typeof renderSearchResults === 'function' ? renderSearchResults : function(){},
    cache: window.__APP.cache
  },
  rankings: {
    reloadTopRatings: reloadTopRatings,
    loadLikesIfNeeded: loadLikesIfNeeded
  },
  state: {
    processState
  },
  chart: {
    postChartData: typeof postChartData === 'function' ? postChartData : function(){},
    resizeChart: typeof resizeChart === 'function' ? resizeChart : function(){}
  }
};
