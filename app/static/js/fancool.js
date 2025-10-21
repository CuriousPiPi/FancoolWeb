window.APP_CONFIG = window.APP_CONFIG || { clickCooldownMs: 2000, maxItems: 0 };
/* ==== 命名空间根 ==== */
window.__APP = window.__APP || {};

const FRONT_MAX_ITEMS = (window.APP_CONFIG && window.APP_CONFIG.maxItems) || 8;
const LIKESET_VERIFY_MAX_AGE_MS = 5 * 60 * 1000;      // 5 分钟指纹过期
const PERIODIC_VERIFY_INTERVAL_MS = 3 * 60 * 1000;    // 3 分钟后台触发一次检查
const LIKE_FULL_FETCH_THRESHOLD = 20;

/* 在最前阶段就写入上限标签，避免闪烁 */
(function initMaxItemsLabel(){
  function apply(){
    const el = document.getElementById('maxItemsLabel');
    if (el && !el.dataset._inited){
      el.textContent = FRONT_MAX_ITEMS;
      el.dataset._inited = '1';
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply, { once:true });
  } else {
    apply();
  }
})();

(async function fetchAppConfig(){
  try {
    const r = await fetch('/api/config');
    const j = await r.json();
    const resp = normalizeApiResponse(j);
    if (resp.ok) {
      const cfg = resp.data || {};
      window.APP_CONFIG.clickCooldownMs = cfg.click_cooldown_ms ?? window.APP_CONFIG.clickCooldownMs;
      window.APP_CONFIG.recentLikesLimit = cfg.recent_likes_limit ?? 50;
    }
  } catch(_){}
})();

window.DisplayCache = (function(){
  const map = new Map(); // key => { brand, model, condition, rt, rl }
  function k(mid,cid){ return `${Number(mid)}_${Number(cid)}`; }
  return {
    setFromSeries(series){
      (series||[]).forEach(s=>{
        const mid = s.model_id, cid = s.condition_id;
        if (mid==null || cid==null) return;
        map.set(k(mid,cid), {
          brand: s.brand || s.brand_name_zh || '',
          model: s.model || s.model_name || '',
          condition: s.condition || s.condition_name_zh || '',
          rt: s.resistance_type || s.resistance_type_zh || s.res_type || s.rt || '',
          rl: s.resistance_location || s.resistance_location_zh || s.res_loc || s.rl || ''
        });
      });
    },
    setFromMeta(items){
      (items||[]).forEach(it=>{
        const mid = it.model_id, cid = it.condition_id;
        if (mid==null || cid==null) return;
        map.set(k(mid,cid), {
          brand: it.brand_name_zh || '',
          model: it.model_name || '',
          condition: it.condition_name_zh || '',
          rt: it.resistance_type_zh || '',
          rl: it.resistance_location_zh || ''
        });
      });
    },
    get(mid,cid){ return map.get(k(mid,cid)) || null; },
    clear(){ map.clear(); }
  };
})();

function installRemovedRenderHookOnce(){
  try{
    const mod = window.__APP && window.__APP.features && window.__APP.features.recentlyRemoved;
    if (!mod || !mod.rebuild) return false;
    if (mod.__ID_PATCHED__) return true;
    const orig = mod.rebuild;
    mod.rebuild = function(list){
      const enriched = (list||[]).map(it=>{
        const info = window.DisplayCache && window.DisplayCache.get(it.model_id, it.condition_id);
        return { ...it, brand: info?.brand || '', model: info?.model || '', condition: info?.condition || '加载中...' };
      });
      return orig(enriched);
    };
    mod.__ID_PATCHED__ = true;
    return true;
  }catch(_){ return false; }
}
// 若模块已可用，先试一次；否则在后续生命周期再兜底调用
installRemovedRenderHookOnce();

/* ==== P1-4 DOM 缓存与工具 ==== */
(function initDomCache(){
  const cache = Object.create(null);
  function one(sel, scope){
    if (!sel) return null;
    if (!scope && cache[sel]) return cache[sel];
    const el = (scope||document).querySelector(sel);
    if (!scope) cache[sel] = el;
    return el;
  }
  function all(sel, scope){
    return Array.from((scope||document).querySelectorAll(sel));
  }
  function clear(sel){ if(sel) delete cache[sel]; else Object.keys(cache).forEach(k=>delete cache[k]); }
  window.__APP.dom = { one, all, clear };
})();

/* ==== P1-5 帧写入调度器 ==== */
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

/* ==== 工具：通用延迟/防抖调度器 ==== */
function createDelayed(fn, delay){
  let timer = null;
  return function(){
    clearTimeout(timer);
    timer = setTimeout(fn, delay);
  };
}

/* ==== 工具：Snap 分页初始化（复用 left-panel / sidebar-top） ==== */
function initSnapTabScrolling(opts){
  const {
    containerId,
    group,
    persistKey,
    vertical = false,
    onActiveChange,
    clickScrollBehavior = 'smooth',
    defaultTab 
  } = opts || {};
  const container = document.getElementById(containerId);
  const nav = document.querySelector(`.fc-tabs[data-tab-group="${group}"]`);
  if (!container || !nav) return;
  const tabs = Array.from(nav.querySelectorAll('.fc-tabs__item'));
  if (!tabs.length) return;

  function go(idx, smooth=true){
    const w = vertical ? container.clientHeight : container.clientWidth;
    container.scrollTo({ [vertical?'top':'left']: w * idx, behavior: smooth?clickScrollBehavior:'auto' });
  }

  function activateIdx(idx, smooth=true, fromScroll=false){
    idx = Math.max(0, Math.min(idx, tabs.length-1));
    tabs.forEach((t,i)=>t.classList.toggle('active', i===idx));
    const tabName = tabs[idx]?.dataset.tab;
    if (!fromScroll) go(idx, smooth);
    if (persistKey && tabName) {
      try { localStorage.setItem(persistKey, tabName); } catch(_){}
    }
    if (typeof onActiveChange === 'function' && tabName){
      onActiveChange(tabName);
    }
  }

  nav.addEventListener('click', e=>{
    const item = e.target.closest('.fc-tabs__item');
    if (!item) return;
    const idx = tabs.indexOf(item);
    if (idx < 0) return;
    activateIdx(idx, true, false);
  });

  container.addEventListener('scroll', ()=>{
    clearTimeout(container._snapTimer);
    container._snapTimer = setTimeout(()=>{
      const w = vertical ? (container.clientHeight || 1) : (container.clientWidth || 1);
      const idx = Math.round( (vertical?container.scrollTop:container.scrollLeft) / w );
      activateIdx(idx, false, true);
    }, 80);
   }, { passive: true });

  let initIdx = 0;

  // 1) persistKey 优先
  if (persistKey){
    try {
      const saved = localStorage.getItem(persistKey);
      if (saved){
        const found = tabs.findIndex(t=>t.dataset.tab === saved);
        if (found >= 0) initIdx = found;
      }
    } catch(_){}
  }

  // 2) 没命中持久化，用 defaultTab
  if (initIdx === 0 && defaultTab) {
    const foundByDefault = tabs.findIndex(t=>t.dataset.tab === defaultTab);
    if (foundByDefault >= 0) initIdx = foundByDefault;
  }

  // 3) 没有 defaultTab，且导航自带 .active，则跟随 .active
  if (initIdx === 0) {
    const activeIdx = tabs.findIndex(t=>t.classList.contains('active'));
    if (activeIdx >= 0) initIdx = activeIdx;
  }

  // 4) 兜底 0
  requestAnimationFrame(()=>activateIdx(initIdx, false, false));
}

/* ==== P1-7 通用缓存 (内存+TTL) ==== */
window.__APP.cache = (function(){
  const store = new Map();
  const DEFAULT_TTL = 180000;
  function key(ns, payload){
    return ns + '::' + JSON.stringify(payload||{});
  }
  function get(ns, payload){
    const k = key(ns, payload);
    const rec = store.get(k);
    if (!rec) return null;
    if (Date.now() > rec.expire) { store.delete(k); return null; }
    return rec.value;
  }
  function set(ns, payload, value, ttl=DEFAULT_TTL){
    const k = key(ns, payload);
    store.set(k, { value, expire: Date.now()+ttl });
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

const $ = (s) => window.__APP.dom.one(s);

// POLYFILL + safeClosest
(function() {
  if (typeof Element !== 'undefined') {
    if (!Element.prototype.matches) {
      Element.prototype.matches =
        Element.prototype.msMatchesSelector ||
        Element.prototype.webkitMatchesSelector ||
        function(selector) {
          const list = (this.document || this.ownerDocument).querySelectorAll(selector);
          let i = 0;
          while (list[i] && list[i] !== this) i++;
          return !!list[i];
        };
    }
    if (!Element.prototype.closest) {
      Element.prototype.closest = function(selector) {
        let el = this;
        while (el && el.nodeType === 1) {
          if (el.matches(selector)) return el;
          el = el.parentElement;
        }
        return null;
      };
    }
  }
  window.safeClosest = function safeClosest(start, selector) {
    if (!start) return null;
    let el = start;
    if (el.nodeType && el.nodeType !== 1) el = el.parentElement;
    if (!el) return null;
    if (el.closest) {
      try { return el.closest(selector); } catch(_) {}
    }
    while (el && el.nodeType === 1) {
      if (el.matches && el.matches(selector)) return el;
      el = el.parentElement;
    }
    return null;
  };
})();


/* =========================================================
   工具函数 / Toast / Throttle / HTML 转义
   ========================================================= */
function verifyLikeFingerprintIfStale(){
  try {
    if (!LocalState.likes.needRefresh(LIKESET_VERIFY_MAX_AGE_MS)) return;
    fetch('/api/like_status', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ pairs: [] })
    })
      .then(r=>r.json())
      .then(j=>{
        const resp = normalizeApiResponse(j);
        if (!resp.ok) return;
        const data = resp.data || {};
        if (data.fp){
          LocalState.likes.updateServerFP(data.fp);
          LocalState.likes.logCompare();
        }
      })
      .catch(()=>{});
  } catch(_){}
}
setInterval(verifyLikeFingerprintIfStale, PERIODIC_VERIFY_INTERVAL_MS);

const toastContainerId = 'toastContainer';
function ensureToastRoot() {
  let r = document.getElementById(toastContainerId);
  if (!r) { r = document.createElement('div'); r.id = toastContainerId; document.body.appendChild(r); }
  return r;
}
let toastIdCounter = 0;
const activeLoadingKeys = new Set();

function normalizeToastType(t){
  return ['success','error','loading','info'].includes(t) ? t : 'info';
}
function createToast(msg, type='info', opts={}) {
  type = normalizeToastType(type);
  const container = ensureToastRoot();
  const { autoClose = (type === 'loading' ? false : 2600), id = 't_'+(++toastIdCounter) } = opts;

  while (document.getElementById(id)) {
    document.getElementById(id).remove();
  }

  const iconMap = {
    success:'<i class="icon fa-solid fa-circle-check" style="color:var(--toast-success)"></i>',
    error:'<i class="icon fa-solid fa-circle-xmark" style="color:var(--toast-error)"></i>',
    loading:'<i class="icon fa-solid fa-spinner fa-spin" style="color:var(--toast-loading)"></i>',
    info:'<i class="icon fa-solid fa-circle-info" style="color:#3B82F6"></i>'
  };

  const div = document.createElement('div');
  div.className = 'fc-toast fc-toast--'+type;
  div.id = id;
  div.innerHTML = `${iconMap[type]||iconMap.info}<div class="msg">${msg}</div><span class="fc-toast__close" data-close="1">&times;</span>`;
  container.appendChild(div);

  if (autoClose) {
    setTimeout(()=>closeToast(id), autoClose);
  }
  return id;
}
function closeToast(id){
  const el = document.getElementById(id);
  if (!el) return;
  el.style.animation = 'toast-out .25s forwards';
  setTimeout(()=>el.remove(), 240);
}
document.addEventListener('click', (e)=>{
  if (e.target.closest && e.target.closest('[data-close]')) {
    const t = e.target.closest('.fc-toast'); if (t) closeToast(t.id);
  }
});

const loadingTimeoutMap = new Map();
function showLoading(key, text='加载中...') {
  if (activeLoadingKeys.has(key)) {
    const existing = document.getElementById('loading_'+key);
    if (existing) {
      const msgEl = existing.querySelector('.msg');
      if (msgEl) msgEl.textContent = text;
    }
    return;
  }
  activeLoadingKeys.add(key);
  createToast(text, 'loading', { id: 'loading_' + key });
  const to = setTimeout(()=>{
    if (activeLoadingKeys.has(key)) {
      hideLoading(key);
    }
  }, 12000);
  loadingTimeoutMap.set(key, to);
}
function hideLoading(key) {
  activeLoadingKeys.delete(key);
  const id = 'loading_' + key;
  const el = document.getElementById(id);
  if (el) el.remove();
  const t = loadingTimeoutMap.get(key);
  if (t) {
    clearTimeout(t);
    loadingTimeoutMap.delete(key);
  }
}
function autoCloseOpLoading() {
  hideLoading('op');
  document.querySelectorAll('.fc-toast.fc-toast--loading').forEach(t => {
    const msgEl = t.querySelector('.msg');
    if (!msgEl) return;
    const text = (msgEl.textContent || '').trim();
    if (/^(添加中|移除中)/.test(text)) {
      t.remove();
    }
  });
}
const showSuccess = (m)=>createToast(m,'success');
const showError   = (m)=>createToast(m,'error');
const showInfo    = (m)=>createToast(m,'info', {autoClose:1800});
// 显式挂到 window，供独立模块通过 window.showXXX 调用
window.showSuccess = showSuccess;
window.showError   = showError;
window.showInfo    = showInfo;

let lastGlobalAction = 0;
function globalThrottle(){
  const cd = Number(window.APP_CONFIG.clickCooldownMs || 2000);
  const now = Date.now();
  if (now - lastGlobalAction < cd) { showInfo('操作过于频繁，请稍后'); return false; }
  lastGlobalAction = now; return true;
}
const NO_THROTTLE_ACTIONS = new Set(['add','remove','restore','xaxis']);
const needThrottle = (action)=>!NO_THROTTLE_ACTIONS.has(action);

const ESC_MAP = { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' };
function escapeHtml(s){ return String(s??'').replace(/[&<>"']/g,c=>ESC_MAP[c]); }
function unescapeHtml(s){
  const map = {'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'"};
  return String(s??'').replace(/&(amp|lt|gt|quot|#39);/g,m=>map[m]);
}

/* =========================================================
   统一 API 响应归一化
   ========================================================= */
function normalizeApiResponse(json){
  if (!json || typeof json !== 'object') {
    return { ok:false, error_code:'INVALID', error_message:'响应格式错误', raw:json };
  }
  if (json.success === true) {
    return { ok:true, data: json.data, raw: json };
  }
  if (json.success === false) {
    return {
      ok:false,
      error_code: json.error_code || 'ERR',
      error_message: json.error_message || '操作失败',
      raw: json
    };
  }
  // 非标准直接认定失败（已去除旧兼容）
  return { ok:false, error_code:'LEGACY_FORMAT', error_message:'不支持的旧响应格式', raw: json };
}
function asArray(maybe){
  if (Array.isArray(maybe)) return maybe;
  if (maybe && Array.isArray(maybe.data)) return maybe.data;
  // 某些接口旧格式可能是 { items: [...] }
  if (maybe && Array.isArray(maybe.items)) return maybe.items;
  return [];
}
function extractLikeKeys(dataObj){
  if (!dataObj || typeof dataObj !== 'object') return [];
  return dataObj.like_keys || dataObj.liked_keys || [];
}

function withFrontColors(chartData) {
  if (__isShareLoaded && !__shareAxisApplied && chartData && chartData.x_axis_type) {
    frontXAxisType = (chartData.x_axis_type === 'noise') ? 'noise_db' : chartData.x_axis_type;
    try { localStorage.setItem('x_axis_type', frontXAxisType); } catch (_) {}
    __shareAxisApplied = true;
  }
  const series = (chartData.series || []).map(s => {
    return {
      ...s,
      color: ColorManager.getColor(s.key),
      color_index: ColorManager.getIndex(s.key)
    };
  });
  return { ...chartData, x_axis_type: frontXAxisType, series };
}


let lastChartData = null;
let frontXAxisType = 'rpm';

(function initPersistedXAxisType(){
  try {
    const saved = localStorage.getItem('x_axis_type');
    if (saved === 'rpm' || saved === 'noise_db' || saved === 'noise') {
      frontXAxisType = (saved === 'noise') ? 'noise_db' : saved;
    }
  } catch(_) {}
})();

function getChartBg(){
  const host = document.getElementById('chart-settings') || document.body;
  let bg = '';
  try { bg = getComputedStyle(host).backgroundColor; } catch(_) {}
  if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') {
    try { bg = getComputedStyle(document.body).backgroundColor; } catch(_) {}
  }
  return bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : '#ffffff';
}

const currentThemeStr = () =>
  (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');

window.applySidebarColors = function() {
  const rows = window.__APP.dom.all('#selectedFansList .fan-item');
  window.__APP.scheduler.write(()=> {
    rows.forEach(div => {
      const key = div.getAttribute('data-fan-key');
      const dot = div.querySelector('.js-color-dot');
      // 使用新的 ColorManager 接口
      if (key && dot) dot.style.backgroundColor = ColorManager.getColor(key);
    });
  });
};

function isValidNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}
function filterChartDataForAxis(chartData) {
  const axis = chartData.x_axis_type === 'noise' ? 'noise_db' : chartData.x_axis_type;
  const cleaned = { ...chartData, series: [] };
  chartData.series.forEach((s) => {
    const rpmArr   = Array.isArray(s.rpm) ? s.rpm : [];
    const noiseArr = Array.isArray(s.noise_db) ? s.noise_db : [];
    const flowArr  = Array.isArray(s.airflow) ? s.airflow : [];
    const xArr = axis === 'noise_db' ? noiseArr : rpmArr;
    const rpmNew = [];
    const noiseNew = [];
    const flowNew = [];
    for (let i = 0; i < xArr.length; i++) {
      const x = xArr[i];
      const y = flowArr[i];
      if (isValidNum(x) && isValidNum(y)) {
        rpmNew.push(isValidNum(rpmArr[i]) ? rpmArr[i] : null);
        noiseNew.push(isValidNum(noiseArr[i]) ? noiseArr[i] : null);
        flowNew.push(y);
      }
    }
    const hasAxisPoints = axis === 'noise_db'
      ? noiseNew.some(isValidNum)
      : rpmNew.some(isValidNum);
    if (flowNew.length > 0 && hasAxisPoints) {
      cleaned.series.push({
        ...s,
        rpm: rpmNew,
        noise_db: noiseNew,
        airflow: flowNew
      });
    }
  });
  return cleaned;
}

function postChartData(chartData){
  lastChartData = chartData;

  const prepared = withFrontColors(chartData);
  const filtered = filterChartDataForAxis(prepared);
  const payload = {
    chartData: filtered,
    theme: currentThemeStr(),
    chartBg: getChartBg()
  };
  if (pendingShareMeta) {
    payload.shareMeta = pendingShareMeta;
    pendingShareMeta = null;
  }

  if (window.ChartRenderer && typeof ChartRenderer.render === 'function') {
    ChartRenderer.render(payload);
  }
}

function resizeChart(){
  if (window.ChartRenderer && typeof ChartRenderer.resize === 'function') {
    ChartRenderer.resize();
  }
}

/* =========================================================
   子段 UI
   ========================================================= */
const rightSubsegContainer = $('#rightSubsegContainer');
const segQueriesOrig = document.querySelector('#top-queries-pane .fc-seg');
const segSearchOrig  = document.querySelector('#search-results-pane .fc-seg');
if (segQueriesOrig && rightSubsegContainer){ segQueriesOrig.dataset.paneId='top-queries-pane'; rightSubsegContainer.appendChild(segQueriesOrig); }
if (segSearchOrig && rightSubsegContainer){ segSearchOrig.dataset.paneId='search-results-pane'; rightSubsegContainer.appendChild(segSearchOrig); }
function updateRightSubseg(activeTab){
  if (segQueriesOrig) segQueriesOrig.style.display = (activeTab==='top-queries')?'inline-flex':'none';
  if (segSearchOrig)  segSearchOrig.style.display  = (activeTab==='search-results')?'inline-flex':'none';
}

/* =========================================================
   最近点赞懒加载
   ========================================================= */
let recentLikesLoaded = false;
let recentLikesLoadedCount = 0;
const recentLikesListEl = $('#recentLikesList');

function needFullLikeKeyFetch() {
  const fp = LocalState.likes.getServerFP && LocalState.likes.getServerFP();
  if (!fp) return false;
  if (fp.c >= LIKE_FULL_FETCH_THRESHOLD) return false;
  if (!LocalState.likes.isSynced() || !LocalState.likes.shouldSkipStatus(LIKESET_VERIFY_MAX_AGE_MS)) {
    return true;
  }
  return false;
}
function fetchAllLikeKeys(){
  if (fetchAllLikeKeys._pending) return;
  fetchAllLikeKeys._pending = true;
  fetch('/api/like_keys')
    .then(r=>r.json())
    .then(j=>{
      const resp = normalizeApiResponse(j);
      if (!resp.ok) return;
      const data = resp.data || {};
      const arr = extractLikeKeys(data);
      if (Array.isArray(arr)){
        LocalState.likes.setAll(arr);
        arr.forEach(k=>{
          const [m,c] = k.split('_');
          if (m && c) updateLikeIcons(m, c, true);
        });
      }
      if (data.fp){
        LocalState.likes.updateServerFP(data.fp);
      }
      LocalState.likes.logCompare();
    })
    .catch(()=>{})
    .finally(()=>{ fetchAllLikeKeys._pending = false; });
}
// 修改处：最近点赞列表，工况后追加风阻信息
function rebuildRecentLikes(list){
  const wrap = recentLikesListEl;
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!list || list.length===0){
    wrap.innerHTML = '<p class="text-gray-500 text-center py-6">暂无最近点赞</p>';
    requestAnimationFrame(prepareRecentLikesMarquee);
    return;
  }
  const groups = new Map();
  list.forEach(item=>{
    const brand = item.brand_name_zh || item.brand;
    const model = item.model_name || item.model;
    const size = item.size ?? item.model_size ?? '';
    const thickness = item.thickness ?? item.model_thickness ?? '';
    const maxSpeed = item.max_speed ?? item.maxSpeed ?? '';
    const condition = item.condition_name_zh || item.condition || '';
    const rt = item.resistance_type_zh || item.rt || '';
    const rl = item.resistance_location_zh || item.rl || '';
    const mid = item.model_id ?? item.modelId ?? item.mid ?? '';
    const cid = item.condition_id ?? item.conditionId ?? item.cid ?? '';
    if (!brand || !model || !condition) return;
    const key = `${brand}||${model}||${size}||${thickness}||${maxSpeed}`;
    if (!groups.has(key)) groups.set(key, { brand, model, size, thickness, maxSpeed, scenarios:[] });
    const g = groups.get(key);
    if (!g.scenarios.some(s=>s.condition===condition && s.rt===rt && s.rl===rl)) {
      g.scenarios.push({ condition, rt, rl, mid, cid });
    }
  });

  groups.forEach(g=>{
    const metaParts = [];
    if (g.maxSpeed) metaParts.push(`${escapeHtml(g.maxSpeed)} RPM`);
    if (g.size && g.thickness) metaParts.push(`${escapeHtml(g.size)}x${escapeHtml(g.thickness)}`);
    const metaRight = metaParts.join(' · ');
    const scenariosHtml = g.scenarios.map(s=>{
      const extra = (typeof formatScenario === 'function') ? formatScenario(s.rt, s.rl) : '';
      const label = extra ? `${s.condition} - ${extra}` : s.condition;
      const scenText = escapeHtml(label);
      return `
        <div class="flex items-center justify-between scenario-row">
          <div class="scenario-text text-sm text-gray-700">${scenText}</div>
          <div class="actions">
            <button class="like-button recent-like-button" title="取消点赞"
                    data-model-id="${escapeHtml(s.mid||'')}"
                    data-condition-id="${escapeHtml(s.cid||'')}">
              <i class="fa-solid fa-thumbs-up text-red-500"></i>
            </button>
            ${buildQuickBtnHTML('likes', g.brand, g.model, s.mid, s.cid, s.condition, 'liked')}
          </div>
        </div>`;
    }).join('');
    const groupDiv = document.createElement('div');
    groupDiv.className='recent-like-group p-3 border border-gray-200 rounded-md';
    groupDiv.innerHTML = `
      <div class="fc-group-header">
        <div class="fc-title-wrap flex items-center min-w-0">
          <div class="truncate font-medium">${escapeHtml(g.brand)} ${escapeHtml(g.model)}</div>
        </div>
        <div class="fc-meta-right text-sm text-gray-600">${metaRight}</div>
      </div>
      <div class="group-scenarios mt-2 space-y-1">${scenariosHtml}</div>`;
    wrap.appendChild(groupDiv);
  });

  syncQuickActionButtons();
  requestAnimationFrame(prepareRecentLikesMarquee);
}
async function ensureLikeStatusBatch(pairs){
  if (!Array.isArray(pairs) || !pairs.length) return;
  if (needFullLikeKeyFetch()) {
    fetchAllLikeKeys();
    return;
  }
  const limit = window.APP_CONFIG.recentLikesLimit || 50;
  const need = [];
  const seen = new Set();
  for (const p of pairs){
    if (!p) continue;
    const mid = Number(p.model_id);
    const cid = Number(p.condition_id);
    if (!Number.isInteger(mid) || !Number.isInteger(cid)) continue;
    const key = `${mid}_${cid}`;
    if (LocalState.likes.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    need.push({ model_id: mid, condition_id: cid });
  }
  if (!need.length) return;
  if (recentLikesLoaded && recentLikesLoadedCount < limit) return;
  if (LocalState.likes.shouldSkipStatus(LIKESET_VERIFY_MAX_AGE_MS)) return;
  if (needFullLikeKeyFetch()) {
    fetchAllLikeKeys();
    return;
  }
  try {
    const resp = await fetch('/api/like_status', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ pairs: need })
    });
    if (!resp.ok) return;
    const j = await resp.json();
    const rdata = normalizeApiResponse(j);
    if (!rdata.ok) return;
    const data = rdata.data || {};
    if (data.fp) { LocalState.likes.updateServerFP(data.fp); LocalState.likes.logCompare(); }
    const list = extractLikeKeys(data);
    if (!list.length) return;
    list.forEach(k=>{
      if (!LocalState.likes.has(k)){
        LocalState.likes.add(k);
        const [m,c] = k.split('_');
        if (m && c) updateLikeIcons(m, c, true);
      }
    });
  } catch(_) {}
}
function reloadRecentLikes(){
  showLoading('recent-likes','加载最近点赞...');
  fetch('/api/recent_likes')
    .then(r=>r.json())
    .then(j=>{
      const resp = normalizeApiResponse(j);
      if (!resp.ok){ showError(resp.error_message||'获取最近点赞失败'); return; }
      const data = resp.data || {};
      if (data.fp){ LocalState.likes.updateServerFP(data.fp); LocalState.likes.logCompare(); }
      const list = data.items || data.data || [];
      recentLikesLoaded = true;
      recentLikesLoadedCount = list.length;

      let changed = false;
      list.forEach(it=>{
        if (it.model_id != null && it.condition_id != null){
          const k = `${it.model_id}_${it.condition_id}`;
          if (!LocalState.likes.has(k)){
            LocalState.likes.add(k);
            changed = true;
          }
        }
      });
      if (changed){
        list.forEach(it=>{
          if (it.model_id != null && it.condition_id != null){
            updateLikeIcons(it.model_id, it.condition_id, true);
          }
        });
      }
      rebuildRecentLikes(list);
    })
    .catch(err=>showError('获取最近点赞异常: '+err.message))
    .finally(()=>hideLoading('recent-likes'));
}
function loadRecentLikesIfNeeded(){
  if (recentLikesLoaded) return;
  reloadRecentLikes();
}

/* =========================================================
   顶部 / 左 / 右三个 Tab 管理
   ========================================================= */
(function initRightPanelSnapTabs(){
  function run(){
    const card = document.querySelector('.fc-right-card');
    if (!card) return;
    const container = card.querySelector('.fc-tab-container');
    const wrapper   = card.querySelector('.fc-tab-wrapper');
    if (!container || !wrapper) return;

    // 确保有 id（与下方其它调用保持一致）
    if (!container.id) container.id = 'right-panel-container';
    if (!wrapper.id)   wrapper.id   = 'right-panel-wrapper';

    // 标记：右侧页签已启用 Scroll Snap，供 activateTab 等逻辑识别
    window.__RIGHT_PANEL_SNAP_ON = true;

    // 初始化（不保存状态），默认激活“近期热门”
    initSnapTabScrolling({
      containerId: container.id,
      group: 'right-panel',
      persistKey: null,
      defaultTab: 'top-queries',
      onActiveChange: (tab) => {
        // 保持既有副作用：子页签显隐 + 懒加载
        if (typeof updateRightSubseg === 'function') updateRightSubseg(tab);
        if (tab === 'recent-updates' && typeof loadRecentUpdatesIfNeeded === 'function') {
          loadRecentUpdatesIfNeeded();
        }
      },
      clickScrollBehavior: 'smooth'
    });
  }
  if (document.readyState !== 'loading') run();
  else document.addEventListener('DOMContentLoaded', run, { once:true });
})();

function activateTab(group, tabName, animate = false) {
  // 右侧主容器启用 snap 后，交由 initSnapTabScrolling 接管
  if (group === 'sidebar-top' || group === 'left-panel' || (group === 'right-panel' && window.__RIGHT_PANEL_SNAP_ON)) return;

  const nav = document.querySelector(`.fc-tabs[data-tab-group="${group}"]`);
  const wrapper = document.getElementById(`${group}-wrapper`);
  if (!nav || !wrapper) return;
  const items = [...nav.querySelectorAll('.fc-tabs__item')];

  if (group === 'right-panel' && !animate) {
    tabName = items[0]?.dataset.tab || tabName;
  }
  let idx = items.findIndex(i => i.dataset.tab === tabName);
  if (idx < 0) { idx = 0; tabName = items[0]?.dataset.tab || ''; }
  items.forEach((it, i) => it.classList.toggle('active', i === idx));

  const percent = idx * 50;
  if (!animate) wrapper.style.transition = 'none';
  wrapper.style.transform = `translateX(-${percent}%)`;
  if (!animate) setTimeout(() => wrapper.style.transition = '', 50);

  if (group !== 'right-panel') {
    localStorage.setItem('activeTab_' + group, tabName);
  }
  if (group === 'right-panel') {
    updateRightSubseg(tabName);
    if (tabName === 'recent-updates') {
      loadRecentUpdatesIfNeeded();
    }
  }
}
document.addEventListener('click',(e)=>{
  const item = safeClosest(e.target, '.fc-tabs .fc-tabs__item');
  if (!item) return;
  const nav = item.closest('.fc-tabs');
  const group = nav?.dataset?.tabGroup;
  if (!group) return;
  if (group === 'right-panel') {
    // 右侧主页签交给 Scroll Snap 初始化里的点击处理
    return;
  }
  activateTab(group, item.dataset.tab, true);
});

// 默认状态初始化：右侧交给 scroll-snap，跳过
(function initTabDefaults(){
  ['left-panel','right-panel'].forEach(group=>{
    if (group === 'right-panel') return; // 右侧跳过，交给 snap 初始化
    const saved = localStorage.getItem('activeTab_'+group);
    const fallback = document.querySelector(`.fc-tabs[data-tab-group="${group}"] .fc-tabs__item`)?.dataset.tab || '';
    activateTab(group, saved || fallback, false);
  });
  const sidebarTopActive = document.querySelector('.fc-tabs[data-tab-group="sidebar-top"] .fc-tabs__item.active')?.dataset.tab;
  if (sidebarTopActive) activateTab('sidebar-top', sidebarTopActive, false);
})();

/* ===== 顶部可视高度同步 ===== */
function computeTopPaneViewportHeight(){
  const scroller = document.querySelector('#top-panel .fc-sidebar-panel__content');
  const nav = scroller ? scroller.querySelector('nav.fc-tabs') : null;
  if (!scroller || !nav) return 0;
  const scrollerStyle = getComputedStyle(scroller);
  const padBottom = parseFloat(scrollerStyle.paddingBottom)||0;
  const navStyle = getComputedStyle(nav);
  const navMB = parseFloat(navStyle.marginBottom)||0;
  const navH = Math.ceil(nav.getBoundingClientRect().height);
  const avail = scroller.clientHeight - navH - navMB - padBottom;
  return Math.max(0, Math.floor(avail));
}
function syncTopTabsViewportHeight(){
  const container = document.querySelector('#top-panel .fc-tab-container');
  if (!container) return;
  const h = computeTopPaneViewportHeight();
  container.style.height = (h>0?h:0)+'px';
}
(function initTopTabsViewport(){
  const scroller = document.querySelector('#top-panel .fc-sidebar-panel__content');
  if (scroller && 'ResizeObserver' in window){
    const ro = new ResizeObserver(()=>requestAnimationFrame(syncTopTabsViewportHeight));
    ro.observe(scroller);
  }
  syncTopTabsViewportHeight();
  window.addEventListener('resize', ()=>requestAnimationFrame(syncTopTabsViewportHeight));
  document.addEventListener('mouseup', ()=>requestAnimationFrame(syncTopTabsViewportHeight));
})();

// 初始化按钮可达性状态（加安全判断，避免加载顺序问题）
try { window.__APP?.sidebar?.refreshToggleUI?.(); } catch(_) {}

/* =========================================================
   主题切换
   ========================================================= */
const themeToggle = $('#themeToggle');
const themeIcon = $('#themeIcon');

// 替换 currentTheme 的初始化为：
let currentTheme = (function(){
  return (window.ThemePref && typeof window.ThemePref.resolve === 'function')
    ? window.ThemePref.resolve()
    : (document.documentElement.getAttribute('data-theme') || 'light');
})();

let THEME_OP_ID = 0;

function setTheme(t) {
  const root = document.documentElement;
  const prev = root.getAttribute('data-theme') || 'light';
  const myId = ++THEME_OP_ID;

  // 每次进入深色都生成全新的渐变
  if (t === 'dark') {
    // 关键修复：清理可能遗留的浅色内联变量，避免覆盖 dark 变量
    root.style.removeProperty('--bg-primary');

    generateDarkGradient();

    // 锁住渐变层为可见，避免切换过程中掉到 0
    root.style.setProperty('--grad-opacity', '1');

    // 下一帧切 data-theme
    requestAnimationFrame(() => {
      root.setAttribute('data-theme', 'dark');
      // 交由 [data-theme=dark] 的 --grad-opacity:1 接管，微任务后清理内联
      setTimeout(() => {
        if (myId !== THEME_OP_ID) return; // 防止旧清理落到新主题
        root.style.removeProperty('--grad-opacity');
      }, 0);
    });
  } else {
    // 进入浅色：避免露底
    root.style.setProperty('--bg-primary', '#f9fafb'); // 先给浅色底
    root.style.setProperty('--grad-opacity', '1');     // 渐变仍可见以便平滑淡出

    // 持有当前渐变，确保淡出过程中不丢失
    const currGrad = (getComputedStyle(root).getPropertyValue('--dark-rand-gradient') || '').trim();
    if (currGrad && currGrad !== 'none') {
      root.style.setProperty('--dark-rand-gradient', currGrad);
    }

    // 下一帧切主题，再下一帧淡出渐变
    requestAnimationFrame(() => {
      root.setAttribute('data-theme', 'light');
      requestAnimationFrame(() => {
        root.style.setProperty('--grad-opacity', '0');
        // 动画结束后清理临时变量，并清空渐变，确保下次进入 dark 一定会生成新渐变
        setTimeout(() => {
          if (myId !== THEME_OP_ID) return; // 防止竞态
          root.style.removeProperty('--grad-opacity');
          root.style.removeProperty('--bg-primary');
          root.style.removeProperty('--dark-rand-gradient'); // 关键：清掉以便下次重新生成
        }, 520); // 略大于 .5s 过渡
      });
    });
  }

  // 同步图标
  if (themeIcon) themeIcon.className = t === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';

  // 统一保存 + 上报（本地 + 后端）
  if (window.ThemePref && typeof window.ThemePref.save === 'function') {
    window.ThemePref.save(t, { notifyServer: true });
  }

  // 等两帧再刷新图表/布局（保留原逻辑）
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (lastChartData) {
        postChartData(lastChartData);
      } else {
        resizeChart();
      }
      syncTopTabsViewportHeight();
    });
  });
}

// 初始化：只调用一次
setTheme(currentTheme);

// 防重复绑定保护
if (!window.__APP_THEME_BOUND__) {
  window.__APP_THEME_BOUND__ = true;
  themeToggle?.addEventListener('click', () => {
    currentTheme = currentTheme === 'light' ? 'dark' : 'light';
    setTheme(currentTheme);
    // 侧栏颜色和图表兜底刷新
    window.applySidebarColors();
    if (lastChartData) {
      postChartData(lastChartData);
    } else {
      resizeChart();
    }
    requestAnimationFrame(syncTopTabsViewportHeight);
  });
}

/* =========================================================
   已选 & 快速按钮状态
   ========================================================= */
let selectedMapSet = new Set();
let selectedKeySet = new Set();

// NEW: 以 model_id + condition_id 为唯一键的索引，用于快捷按钮联动
let selectedPairSet = new Set();
function rebuildSelectedPairIndex(){
  selectedPairSet.clear();
  try {
    const pairs = LocalState.getSelectionPairs();
    (pairs || []).forEach(p => {
      if (p && p.model_id != null && p.condition_id != null) {
        selectedPairSet.add(`${p.model_id}_${p.condition_id}`);
      }
    });
  } catch(_) {}
}

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
rebuildSelectedPairIndex();

// CHANGED: 快捷按钮 HTML 生成，优先用 (model_id, condition_id) 判断是否已存在
function buildQuickBtnHTML(addType, brand, model, modelId, conditionId, condition, logSource){
  const mapKey = `${escapeHtml(brand)}||${escapeHtml(model)}||${escapeHtml(condition||'')}`;
  const hasIds = (modelId != null && conditionId != null && String(modelId) !== '' && String(conditionId) !== '');
  const isDup = hasIds
    ? selectedPairSet.has(`${String(modelId)}_${String(conditionId)}`)
    : selectedMapSet.has(mapKey);

  const mode = isDup ? 'remove' : 'add';
  const title = isDup ? '从图表移除' : '添加到图表';
  const icon = isDup ? '<i class="fa-solid fa-xmark"></i>' : '<i class="fa-solid fa-plus"></i>';
  const defaultSourceMap = { likes:'liked', rating:'top_rating', ranking:'top_query', search:'search' };
  const sourceAttr = logSource || defaultSourceMap[addType] || 'unknown';

  let cls;
  if (isDup) cls = 'js-list-remove';
  else if (addType==='search') cls='js-search-add';
  else if (addType==='rating') cls='js-rating-add';
  else if (addType==='ranking') cls='js-ranking-add';
  else cls='js-likes-add';

  return `
    <button class="fc-btn-icon-add ${cls} fc-tooltip-target"
            title="${title}"
            data-mode="${mode}"
            data-add-type="${addType}"
            data-log-source="${escapeHtml(sourceAttr)}"
            data-brand="${escapeHtml(brand)}"
            data-model="${escapeHtml(model)}"
            data-condition="${escapeHtml(condition||'')}"
            ${modelId ? `data-model-id="${escapeHtml(modelId)}"`:''}
            ${conditionId ? `data-condition-id="${escapeHtml(conditionId)}"`:''}>
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
  btn.classList.remove('js-list-remove','js-ranking-add','js-rating-add','js-search-add','js-likes-add');
  btn.classList.add(addType==='rating'?'js-rating-add'
    : addType==='ranking'?'js-ranking-add'
      : addType==='search'?'js-search-add':'js-likes-add');
  btn.title='添加到图表';
  btn.innerHTML='<i class="fa-solid fa-plus"></i>';
}
function mapKeyFromDataset(d){
  const b = unescapeHtml(d.brand||'');
  const m = unescapeHtml(d.model||'');
  const c = unescapeHtml(d.condition||'');
  return `${b}||${m}||${c}`;
}
// CHANGED: 状态同步优先使用 (model_id, condition_id) 判断
function syncQuickActionButtons(){
  window.__APP.dom.all('.fc-btn-icon-add.fc-tooltip-target').forEach(btn=>{
    if (!btn.dataset.addType){
      if (btn.classList.contains('js-rating-add')) btn.dataset.addType='rating';
      else if (btn.classList.contains('js-ranking-add')) btn.dataset.addType='ranking';
      else if (btn.classList.contains('js-search-add')) btn.dataset.addType='search';
      else if (btn.classList.contains('js-likes-add')) btn.dataset.addType='likes';
    }
    const d = btn.dataset;
    let dup = false;
    if (d.modelId && d.conditionId) {
      dup = selectedPairSet.has(`${d.modelId}_${d.conditionId}`);
    } else {
      const key = mapKeyFromDataset(d);
      dup = selectedMapSet.has(key);
    }
    if (dup) toRemoveState(btn); else toAddState(btn);
  });
}

/* =========================================================
   Rebuild 选中 / 移除列表
   ========================================================= */
const selectedListEl = $('#selectedFansList');
const removedListEl  = $('#recentlyRemovedList');
const selectedCountEl = $('#selectedCount');
const clearAllContainer = $('#clearAllContainer');
const clearAllBtn = $('#clearAllBtn');

// CHANGED: 已选列表仅显示 condition，并以 brand||model||condition 建键
function rebuildSelectedFans(fans){
  if (!Array.isArray(fans)) fans = LocalState.getSelected();
  selectedListEl.innerHTML='';
  ColorManager.assignUniqueIndices((fans || []).map(f => f.key));
  if (!fans || fans.length===0){
    selectedCountEl.textContent='0';
    clearAllContainer?.classList.add('hidden');
    rebuildSelectedIndex(); rebuildSelectedPairIndex();
    requestAnimationFrame(prepareSidebarMarquee);
    scheduleAdjust(); syncQuickActionButtons && syncQuickActionButtons();
    return;
  }
  fans.forEach(f=>{
    const keyStr = `${f.model_id}_${f.condition_id}`;
    const info = DisplayCache.get(f.model_id, f.condition_id);
    const brand = info?.brand || '';
    const model = info?.model || '';
    const condName  = info?.condition || '加载中...';
    const scenExtra = (typeof formatScenario === 'function') ? formatScenario(info?.rt, info?.rl) : '';
    const condText  = scenExtra ? `${condName} - ${scenExtra}` : condName;

    const isLiked = LocalState.likes.has(keyStr);
    const div = document.createElement('div');
    div.className='fan-item flex items-center justify-between p-3 border border-gray-200 rounded-md';
    div.dataset.fanKey = f.key;
    div.dataset.map = `${brand}||${model}||${condText}`;
    div.innerHTML=`
      <div class="flex items-center min-w-0">
        <div class="w-3 h-3 rounded-full mr-2 flex-shrink-0 js-color-dot"></div>
        <div class="truncate">
          <span class="font-medium">${escapeHtml(brand)} ${escapeHtml(model)}</span> - 
          <span class="text-gray-600 text-sm">${escapeHtml(condText)}</span>
        </div>
      </div>
      <div class="flex items-center flex-shrink-0">
        <button class="like-button mr-3" data-fan-key="${f.key}" data-model-id="${f.model_id}" data-condition-id="${f.condition_id}">
          <i class="fa-solid fa-thumbs-up ${isLiked?'text-red-500':'text-gray-400'}"></i>
        </button>
        <button class="fc-icon-remove text-lg js-remove-fan" data-fan-key="${f.key}" title="移除">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>`;
    selectedListEl.appendChild(div);
    const dot = div.querySelector('.js-color-dot'); if (dot) dot.style.backgroundColor = ColorManager.getColor(f.key);
  });
  selectedCountEl.textContent = fans.length.toString();
  clearAllContainer?.classList.remove('hidden');
  rebuildSelectedIndex(); rebuildSelectedPairIndex();
  requestAnimationFrame(prepareSidebarMarquee);
  scheduleAdjust(); syncQuickActionButtons && syncQuickActionButtons();
}

/* =========================================================
   统一状态处理
   ========================================================= */
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
    hideLoading('op'); showError(data.error_message);
  } else {
    if (successMsg) showSuccess(successMsg);
    hideLoading('op'); autoCloseOpLoading();
  }
  let pendingChart = null;
  if ('chart_data' in data) pendingChart = data.chart_data;
  if ('share_meta' in data && data.share_meta){
     ColorManager.patchIndicesFromServer(data.share_meta);
  }
  if ('like_keys' in data){
    LocalState.likes.setAll(data.like_keys || []);
  }
  if (data.fp){ LocalState.likes.updateServerFP(data.fp); LocalState.likes.logCompare(); }

  if ('selected_fans' in data){    
    // 使用新的 ColorManager 接口
    ColorManager.assignUniqueIndices((data.selected_fans || []).map(f => f.key));
    rebuildSelectedFans(data.selected_fans);
  }
  if ('recently_removed_fans' in data){
    window.__APP.features.recentlyRemoved.rebuild(data.recently_removed_fans);
  }
  if ('share_meta' in data && data.share_meta){
    pendingShareMeta = {
      show_raw_curves: data.share_meta.show_raw_curves,
      show_fit_curves: data.share_meta.show_fit_curves,
      pointer_x_rpm: data.share_meta.pointer_x_rpm,
      pointer_x_noise_db: data.share_meta.pointer_x_noise_db,
      legend_hidden_keys: data.share_meta.legend_hidden_keys
    };
    if (__isShareLoaded && !__shareAxisApplied && data.chart_data && data.chart_data.x_axis_type){
      frontXAxisType = (data.chart_data.x_axis_type === 'noise') ? 'noise_db' : data.chart_data.x_axis_type;
      try { localStorage.setItem('x_axis_type', frontXAxisType); } catch(_){}
      __shareAxisApplied = true;
    }
  }
  if (pendingChart) postChartData(pendingChart);
  syncQuickActionButtons();
  scheduleAdjust();
}

/* =========================================================
   POST 助手
   ========================================================= */
async function apiPost(url, payload){
  const resp = await fetch(url, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(payload||{})
  });
  if (!resp.ok) throw new Error('HTTP '+resp.status);
  return resp.json();
}

/* =========================================================
   点赞排行
   ========================================================= */
let likesTabLoaded = false;
let likesTabLastLoad = 0;
const LIKES_TTL = 120000;

let updatesTabLoaded = false;
let updatesTabLastLoad = 0;
const UPDATES_TTL = 600000; // 10 分钟
let _updatesPending = false, _updatesDebounce = null;

function needReloadLikes(){
  if (!likesTabLoaded) return true;
  return (Date.now() - likesTabLastLoad) > LIKES_TTL;
}
let _rtPending = false, _rtDebounce = null;

/* reloadTopRatings：保持结构但移除旧兼容缓存结构中 root.data/items 多层拆解 */
function reloadTopRatings(debounce=true){
  if (debounce){
    if (_rtDebounce) clearTimeout(_rtDebounce);
    return new Promise(resolve=>{
      _rtDebounce = setTimeout(()=>resolve(reloadTopRatings(false)), 220);
    });
  }
  if (_rtPending) return Promise.resolve();
  _rtPending = true;
  const cacheNS = 'top_ratings';
  const payload = {};
  const cached = window.__APP.cache.get(cacheNS, payload);
  if (cached && !needReloadLikes()){
    applyRatingTable(cached.data);  // 缓存中直接存标准结构
    _rtPending = false;
    return Promise.resolve();
  }
  const tbody = document.getElementById('ratingRankTbody');
  if (tbody && !likesTabLoaded){
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-gray-500 py-6">加载中...</td></tr>';
  }
  return fetch('/api/top_ratings')
    .then(r=>r.json())
    .then(j=>{
      const n = normalizeApiResponse(j);
      if (!n.ok){
        showError(n.error_message || '获取失败');
        return;
      }
      const data = n.data; // { items:[...] }
      window.__APP.cache.set(cacheNS, payload, { data }, LIKES_TTL);
      applyRatingTable(data);
    })
    .catch(err=>showError('获取点赞排行异常: '+err.message))
    .finally(()=>{ _rtPending=false; });
}

// CHANGED: 顶部“好评榜”渲染，使用 condition_name_zh，并传入新签名
function applyRatingTable(resp){
  const tbody = document.getElementById('ratingRankTbody');
  if (!tbody) return;

  const list = (resp && resp.items) ||
               (resp && resp.data && resp.data.items) ||
               (resp && resp.data && Array.isArray(resp.data.items) ? resp.data.items : []);

  if (!Array.isArray(list)) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-red-500 py-6">数据格式异常</td></tr>';
    return;
  }
  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-gray-500 py-6">暂无点赞排行数据</td></tr>';
    return;
  }

  let html = '';
  list.forEach((r, idx)=>{
    const rank = idx + 1;
    const medal = rank===1?'gold':rank===2?'silver':rank===3?'bronze':'';
    const rankCell = medal
      ? `<i class="fa-solid fa-medal ${medal} text-2xl"></i>`
      : `<span class="font-medium">${rank}</span>`;

    const scen = escapeHtml(r.condition_name_zh || '');
    const priceText = (r.reference_price > 0) ? escapeHtml(String(r.reference_price)) : '-';

    html += `
      <tr class="hover:bg-gray-50">
        <td class="fc-rank-cell">${rankCell}</td>
        <td class="nowrap fc-marquee-cell"><span class="fc-marquee-inner">${escapeHtml(r.brand_name_zh)}</span></td>
        <td class="nowrap fc-marquee-cell"><span class="fc-marquee-inner">${escapeHtml(r.model_name)} (${r.max_speed} RPM)</span></td>
        <td class="nowrap fc-marquee-cell"><span class="fc-marquee-inner">${escapeHtml(r.size)}x${escapeHtml(r.thickness)}</span></td>
        <td class="nowrap fc-marquee-cell"><span class="fc-marquee-inner">${priceText}</span></td>
        <td class="nowrap fc-marquee-cell"><span class="fc-marquee-inner">${scen}</span></td>
        <td class="text-blue-600 font-medium">${escapeHtml(r.like_count)}</td>
        <td>
          ${buildQuickBtnHTML('rating', r.brand_name_zh, r.model_name, r.model_id, r.condition_id, r.condition_name_zh, 'top_rating')}
        </td>
      </tr>`;
  });
  tbody.innerHTML = html;
  likesTabLoaded = true;
  likesTabLastLoad = Date.now();
  syncQuickActionButtons();
}

function loadLikesIfNeeded(){
  if (!needReloadLikes()) return;
  showLoading('rating-refresh','加载好评榜...');
  reloadTopRatings(false).finally(()=>hideLoading('rating-refresh'));
}
document.addEventListener('DOMContentLoaded', () => {
  reloadTopRatings(false).catch(()=>{});
});

// 3) 近期更新：加载函数（仿照 reloadTopRatings）
function reloadRecentUpdates(debounce = true) {
  if (debounce) {
    if (_updatesDebounce) clearTimeout(_updatesDebounce);
    return new Promise(resolve => {
      _updatesDebounce = setTimeout(() => resolve(reloadRecentUpdates(false)), 220);
    });
  }
  if (_updatesPending) return Promise.resolve();
  _updatesPending = true;

  const cacheNS = 'recent_updates';
  const payload = {};
  const cached = window.__APP.cache.get(cacheNS, payload);
  if (cached && !needReloadUpdates()) {
    applyRecentUpdatesTable(cached.data);
    _updatesPending = false;
    return Promise.resolve();
  }

  const tbody = document.getElementById('recentUpdatesTbody');
  if (tbody && !updatesTabLoaded) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-gray-500 py-6">加载中...</td></tr>';
  }

  return fetch('/api/recent_updates')
    .then(r => r.json())
    .then(j => {
      const n = normalizeApiResponse(j);
      if (!n.ok) {
        showError(n.error_message || '获取近期更新失败');
        return;
      }
      const data = n.data; // { items:[...] }
      window.__APP.cache.set(cacheNS, payload, { data }, UPDATES_TTL);
      applyRecentUpdatesTable(data);
    })
    .catch(err => showError('获取近期更新异常: ' + err.message))
    .finally(() => { _updatesPending = false; });
}

function needReloadUpdates() {
  if (!updatesTabLoaded) return true;
  return (Date.now() - updatesTabLastLoad) > UPDATES_TTL;
}

// CHANGED: 近期更新渲染，使用新签名
function applyRecentUpdatesTable(resp) {
  const tbody = document.getElementById('recentUpdatesTbody');
  if (!tbody) return;

  const list = (resp && resp.items) ||
               (resp && resp.data && Array.isArray(resp.data.items) ? resp.data.items : []);

  if (!Array.isArray(list)) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-red-500 py-6">数据格式异常</td></tr>';
    return;
  }
  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-gray-500 py-6">暂无近期更新数据</td></tr>';
    return;
  }

  let html = '';
  list.forEach(r => {
    const brand = r.brand_name_zh || '';
    const model = r.model_name || '';
    const maxSpeed = (r.max_speed != null) ? ` (${r.max_speed} RPM)` : '';
    const sizeText = `${escapeHtml(r.size)}x${escapeHtml(r.thickness)}`;
    const scen = escapeHtml(r.condition_name_zh || '');
    const updateText = escapeHtml(r.update_date);
    const descRaw = (r.description != null && String(r.description).trim() !== '') ? String(r.description) : '-';
    const desc = escapeHtml(descRaw);

    html += `
      <tr class="hover:bg-gray-50">
        <td class="nowrap fc-marquee-cell"><span class="fc-marquee-inner">${escapeHtml(brand)}</span></td>
        <td class="nowrap fc-marquee-cell"><span class="fc-marquee-inner">${escapeHtml(model)}${maxSpeed}</span></td>
        <td class="nowrap fc-marquee-cell"><span class="fc-marquee-inner">${sizeText}</span></td>
        <td class="nowrap fc-marquee-cell"><span class="fc-marquee-inner">${scen}</span></td>
        <td class="nowrap fc-marquee-cell"><span class="fc-marquee-inner">${updateText}</span></td>
        <td class="nowrap fc-marquee-cell"><span class="fc-marquee-inner">${desc}</span></td>
        <td>
          ${buildQuickBtnHTML('ranking', brand, model, r.model_id, r.condition_id, r.condition_name_zh, 'update_notice')}
        </td>
      </tr>`;
  });

  tbody.innerHTML = html;
  updatesTabLoaded = true;
  updatesTabLastLoad = Date.now();
  syncQuickActionButtons();
}

// 5) 近期更新：触发装载（供 activateTab 调用）
function loadRecentUpdatesIfNeeded() {
  if (!needReloadUpdates()) return;
  showLoading('updates-refresh', '加载近期更新...');
  reloadRecentUpdates(false).finally(() => hideLoading('updates-refresh'));
}

/* =========================================================
   搜索（移除跑马灯）
   ========================================================= */
const searchAirflowTbody = $('#searchAirflowTbody');
const searchLikesTbody = $('#searchLikesTbody');
let SEARCH_RESULTS_RAW = [];

// CHANGED: 搜索结果渲染，使用新签名
function fillSearchTable(tbody, list){
  if (!tbody) return;
  Array.from(tbody.querySelectorAll('.fc-marquee-cell')).forEach(td=>{
    td.classList.remove('fc-marquee-cell','nowrap');
    const inner = td.querySelector('.fc-marquee-inner');
    if (inner) td.innerHTML = inner.innerHTML;
  });
  if (!list.length){
    tbody.innerHTML='<tr><td colspan="9" class="text-center text-gray-500 py-6">没有符合条件的结果</td></tr>';
    return;
  }

  const logSource =
    (tbody.id === 'searchAirflowTbody') ? 'search_airflow' :
    (tbody.id === 'searchLikesTbody')   ? 'search_rating'  :
                                          'search';

  tbody.innerHTML = list.map(r=>{
    const brand = r.brand_name_zh;
    const model = r.model_name;
    const scenLabel = escapeHtml(r.condition_name_zh || '');
    const priceText = (r.reference_price > 0) ? escapeHtml(String(r.reference_price)) : '-';

    const axis = (r.effective_axis === 'noise') ? 'noise_db' : (r.effective_axis || 'rpm');
    const unit = axis === 'noise_db' ? 'dB' : 'RPM';
    const xVal = Number(r.effective_x);
    const xText = axis === 'noise_db' ? xVal.toFixed(1) : Math.round(xVal).toString();
    const srcText = (r.effective_source === 'fit') ? '拟合' : '原始';
    const xCell = `${xText} ${unit} (${srcText})`;

    const airflow = Number(r.effective_airflow ?? r.max_airflow ?? 0);
    const airflowText = airflow.toFixed(1);

    return `
      <tr class="hover:bg-gray-50">
        <td class="nowrap">${escapeHtml(brand)}</td>
        <td class="nowrap">${escapeHtml(model)}</td>
        <td class="nowrap">${escapeHtml(r.size)}x${escapeHtml(r.thickness)}</td>
        <td class="nowrap">${priceText}</td>
        <td class="nowrap">${scenLabel}</td>
        <td class="nowrap">${xCell}</td>
        <td class="text-blue-600 font-medium text-sm">${airflowText}</td>
        <td class="text-blue-600 font-medium">${r.like_count ?? 0}</td>
        <td>${buildQuickBtnHTML('search', brand, model, r.model_id, r.condition_id, r.condition_name_zh, logSource)}</td>
      </tr>`;
  }).join('');
}

function renderSearchResults(results, conditionLabel){
  SEARCH_RESULTS_RAW = results.slice();
  const byAirflow = SEARCH_RESULTS_RAW;
  const byLikes = SEARCH_RESULTS_RAW.slice().sort((a,b)=>(b.like_count||0)-(a.like_count||0));

  // 根据结果集设置“转速/噪音”表头（两个表同名）
  let axisLabel = '转速';
  if (results && results.length) {
    const ax = results[0]?.effective_axis;
    axisLabel = (ax === 'noise' || ax === 'noise_db') ? '噪音' : '转速';
  }
  const h1 = document.getElementById('searchXHeaderAir');
  const h2 = document.getElementById('searchXHeaderLikes');
  if (h1) h1.textContent = axisLabel;
  if (h2) h2.textContent = axisLabel;

  const labelEl = document.getElementById('searchConditionLabel');
  if (labelEl) labelEl.textContent = conditionLabel;

  fillSearchTable(searchAirflowTbody, byAirflow);
  fillSearchTable(searchLikesTbody, byLikes);
  syncQuickActionButtons();
}

/* =========================================================
   点赞 / 快速按钮 / 恢复 / 清空
   ========================================================= */
function updateLikeIcons(modelId, conditionId, isLiked){
  window.__APP.dom.all(`.like-button[data-model-id="${modelId}"][data-condition-id="${conditionId}"]`)
    .forEach(btn => {
      const ic = btn.querySelector('i');
      if (!ic) return;
      ic.classList.toggle('text-red-500', isLiked);
      ic.classList.toggle('text-gray-400', !isLiked);
    });
}
const RECENT_LIKES_REFRESH_DELAY = 650;
const TOP_RATINGS_REFRESH_DELAY = 800;
const scheduleRecentLikesRefresh = (function(){
  const debounced = createDelayed(()=>{ if (recentLikesLoaded) reloadRecentLikes(); }, RECENT_LIKES_REFRESH_DELAY);
  return function(){ debounced(); };
})();
const scheduleTopRatingsRefresh = (function(){
  const debounced = createDelayed(()=>{ if (likesTabLoaded) reloadTopRatings(false); }, TOP_RATINGS_REFRESH_DELAY);
  return function(){ debounced(); };
})();

document.addEventListener('click', async e=>{
  const likeBtn = safeClosest(e.target, '.like-button');
  if (likeBtn){
    if (needThrottle('like') && !globalThrottle()) return;
    const modelId = likeBtn.dataset.modelId;
    const conditionId = likeBtn.dataset.conditionId;
    if (!modelId || !conditionId) { showError('缺少点赞标识'); return; }
    const icon = likeBtn.querySelector('i');
    const prevLiked = icon.classList.contains('text-red-500');
    const nextLiked = !prevLiked;
    const url = prevLiked ? '/api/unlike' : '/api/like';
    const keyStr = `${modelId}_${conditionId}`;
    updateLikeIcons(modelId, conditionId, nextLiked);
    if (nextLiked) LocalState.likes.add(keyStr); else LocalState.likes.remove(keyStr);
    fetch(url, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ model_id: modelId, condition_id: conditionId })
    })
      .then(r=>r.json())
      .then(j=>{
        const resp = normalizeApiResponse(j);
        if (!resp.ok){
          updateLikeIcons(modelId, conditionId, prevLiked);
          if (prevLiked) LocalState.likes.add(keyStr); else LocalState.likes.remove(keyStr);
          showError(resp.error_message || '操作失败');
          return;
        }
        const data = resp.data || {};
        if (data.fp){
          LocalState.likes.updateServerFP(data.fp);
          LocalState.likes.logCompare();
        }
        const finalLiked = LocalState.likes.has(keyStr);
        updateLikeIcons(modelId, conditionId, finalLiked);
        if (data.fp && ( (!LocalState.likes.isSynced()) || !LocalState.likes.shouldSkipStatus() ) && data.fp.c < LIKE_FULL_FETCH_THRESHOLD){
          fetchAllLikeKeys();
        }
        scheduleRecentLikesRefresh();
        scheduleTopRatingsRefresh();
        showSuccess(prevLiked ? '已取消点赞' : '已点赞');
      })
      .catch(err=>{
        updateLikeIcons(modelId, conditionId, prevLiked);
        if (prevLiked) LocalState.likes.add(keyStr); else LocalState.likes.remove(keyStr);
        showError('网络错误：'+err.message);
      });
    return;
  }

  const quickRemove = safeClosest(e.target, '.js-list-remove');
if (quickRemove){
    const midAttr = quickRemove.dataset.modelId;
    const cidAttr = quickRemove.dataset.conditionId;
    const sel = LocalState.getSelected();
    let target = null;

    if (midAttr && cidAttr) {
      target = sel.find(it => String(it.model_id) === String(midAttr) && String(it.condition_id) === String(cidAttr));
    }

    if (!target){
      showInfo('该数据已不在图表中');
      syncQuickActionButtons();
      return;
    }
    const ok = LocalState.removeKey(target.key);
    if (ok){
      showSuccess('已移除');
      rebuildSelectedFans(LocalState.getSelected());
      window.__APP.features.recentlyRemoved.rebuild(LocalState.getRecentlyRemoved());
      syncQuickActionButtons();
      refreshChartFromLocal(false);
    } else {
      showError('移除失败（未找到）');
    }
    return;
  }

 {
    const picker = ['.js-ranking-add','.js-search-add','.js-rating-add','.js-likes-add'];
    for (const sel of picker){
      const btn = safeClosest(e.target, sel);
      if (!btn) continue;
      const midAttr = btn.dataset.modelId;
      const cidAttr = btn.dataset.conditionId;
      if (!(midAttr && cidAttr)){
        showError('缺少标识：按钮未包含 model_id / condition_id');
        return;
      }
      showLoading('op','添加中...');
      try {
        const pairs = [{
          model_id: Number(midAttr),
          condition_id: Number(cidAttr),
          brand: btn.dataset.brand ? unescapeHtml(btn.dataset.brand) : '',
          model: btn.dataset.model ? unescapeHtml(btn.dataset.model) : '',
          condition: btn.dataset.condition ? unescapeHtml(btn.dataset.condition) : ''
        }];
        const newPairs = computeNewPairsAfterDedup(pairs);
        if (newPairs.length === 0){
          hideLoading('op'); showInfo('已存在'); return;
        }
        if (!ensureCanAdd(newPairs.length)){
          hideLoading('op'); return;
        }

        // 立即更新前端状态与 UI
        const addedSummary = LocalState.addPairs(pairs);
        rebuildSelectedFans(LocalState.getSelected());
        ensureLikeStatusBatch(addedSummary.addedDetails.map(d => ({ model_id: d.model_id, condition_id: d.condition_id })));
        window.__APP.features.recentlyRemoved.rebuild(LocalState.getRecentlyRemoved());
        syncQuickActionButtons();
        applySidebarColors();
        refreshChartFromLocal(false);

        hideLoading('op');
        showSuccess(`新增 ${addedSummary.added} 组`);
        window.__APP.sidebar.maybeAutoOpenSidebarOnAdd && window.__APP.sidebar.maybeAutoOpenSidebarOnAdd();

        // 埋点改为后台、无阻塞
        const addType = btn.dataset.addType || '';
        const fallbackMap = { likes:'liked', rating:'top_rating', ranking:'top_query', search:'search' };
        const logSource = btn.dataset.logSource || fallbackMap[addType] || 'unknown';
        Promise.resolve(logNewPairs(addedSummary.addedDetails, logSource)).catch(()=>{});
      } catch(err){
        hideLoading('op');
        showError('添加失败: '+err.message);
      }
      return;
    }
  }


  const removeBtn = safeClosest(e.target, '.js-remove-fan');
  if (removeBtn){
    const fanKey = removeBtn.dataset.fanKey;
    if (!fanKey){ showError('缺少 fan_key'); return; }
    const ok = LocalState.removeKey(fanKey);
    if (ok){
      showSuccess('已移除');
      rebuildSelectedFans(LocalState.getSelected());
      window.__APP.features.recentlyRemoved.rebuild(LocalState.getRecentlyRemoved());
      syncQuickActionButtons();
      refreshChartFromLocal(false);
    } else {
      showInfo('条目不存在');
    }
    return;
  }

  if (e.target.id === 'clearAllBtn'){
    const state = e.target.getAttribute('data-state') || 'normal';
    if (state === 'normal'){
      clearAllBtn.setAttribute('data-state','confirming');
      clearAllBtn.innerHTML = `
        <div class="fc-clear-confirm">
          <button id="confirmClearAll" class="bg-red-600 text-white hover:bg-red-700">确认</button>
          <button id="cancelClearAll" class="bg-gray-400 text-white hover:bg-gray-500">取消</button>
        </div>`;
      scheduleAdjust();
    }
    return;
  }
  if (e.target.id === 'cancelClearAll'){
    clearAllBtn.setAttribute('data-state','normal');
    clearAllBtn.textContent='移除所有';
    scheduleAdjust();
    return;
  }
  if (e.target.id === 'confirmClearAll'){
    showLoading('op','清空中...');
    try {
      LocalState.clearAll();
      hideLoading('op');
      showSuccess('已全部移除');
      rebuildSelectedFans(LocalState.getSelected());
      window.__APP.features.recentlyRemoved.rebuild(LocalState.getRecentlyRemoved());
      syncQuickActionButtons();
      applySidebarColors();
      refreshChartFromLocal(false);
    } catch(err){
      hideLoading('op');
      showError('清空失败: '+err.message);
    } finally {
      clearAllBtn.setAttribute('data-state','normal');
      clearAllBtn.textContent='移除所有';
    }
    return;
  }
});

/* =========================================================
   选中数量与上限判断
   ========================================================= */
function ensureCanAdd(plannedNewCount = 1){
  if (!FRONT_MAX_ITEMS) return true;
  const curr = LocalState.getSelected().length;
  if (curr + plannedNewCount > FRONT_MAX_ITEMS){
    showInfo(`将超出最大上限（${FRONT_MAX_ITEMS}），请先移除部分曲线`);
    return false;
  }
  return true;
}
function computeNewPairsAfterDedup(pairs){
  const existing = new Set(LocalState.getSelectionPairs().map(p => `${p.model_id}_${p.condition_id}`));
  const uniq = [];
  const seen = new Set();
  pairs.forEach(p=>{
    const k = `${p.model_id}_${p.condition_id}`;
    if (seen.has(k)) return;
    seen.add(k);
    if (!existing.has(k)) uniq.push(p);
  });
  return uniq;
}

/* =========================================================
   侧栏 跑马灯
   ========================================================= */
/* 侧栏行跑马灯（修复类名统一） */
function prepareSidebarMarquee(){
  window.__APP.dom.all('#sidebar .fan-item .truncate').forEach(container=>{
    if (container.querySelector('.fc-sidebar-marquee-inner')) return;
    const inner = document.createElement('span');
    inner.className='fc-sidebar-marquee-inner';
    inner.innerHTML = container.innerHTML;
    container.innerHTML='';
    container.appendChild(inner);
  });
}
prepareSidebarMarquee();
const SIDEBAR_SCROLL_SPEED=60;

function startSingleMarquee(row, containerSel, innerSel, speed){
  const container = row.querySelector(containerSel);
  const inner = row.querySelector(innerSel);
  if (!container || !inner) return;
  const delta = inner.scrollWidth - container.clientWidth;
  if (delta > 6){
    const duration = (delta / speed).toFixed(2);
    inner.style.transition = `transform ${duration}s linear`;
    inner.style.transform = `translateX(-${delta}px)`;
  }
}
function stopSingleMarquee(row, innerSel){
  const inner = row.querySelector(innerSel);
  if (!inner) return;
  inner.style.transition='transform .35s ease';
  inner.style.transform='translateX(0)';
}
function startSidebarMarquee(row){ startSingleMarquee(row, '.truncate', '.fc-sidebar-marquee-inner', SIDEBAR_SCROLL_SPEED); }
function stopSidebarMarquee(row){ stopSingleMarquee(row, '.fc-sidebar-marquee-inner'); }
document.addEventListener('mouseenter',(e)=>{
  const row = safeClosest(e.target, '#sidebar .fan-item');
  if (!row) return;
  startSidebarMarquee(row);
}, true);
document.addEventListener('mouseleave',(e)=>{
  const row = safeClosest(e.target, '#sidebar .fan-item');
  if (!row) return;
  stopSidebarMarquee(row);
}, true);

/* 最近点赞工况行跑马灯 */
function prepareRecentLikesMarquee(){
  document.querySelectorAll('#recentLikesList .scenario-row .scenario-text').forEach(container=>{
    if (container.querySelector('.fc-recent-marquee-inner')) return;
    const inner = document.createElement('span');
    inner.className = 'fc-recent-marquee-inner';
    inner.textContent = container.textContent;
    container.textContent = '';
    container.appendChild(inner);
  });
}
const RECENT_LIKES_SCROLL_SPEED = 60;
function startRecentLikesMarquee(row){ startSingleMarquee(row, '.scenario-text', '.fc-recent-marquee-inner', RECENT_LIKES_SCROLL_SPEED); }
function stopRecentLikesMarquee(row){ stopSingleMarquee(row, '.fc-recent-marquee-inner'); }
document.addEventListener('mouseenter', (e)=>{
  const row = safeClosest(e.target, '#recentLikesList .scenario-row');
  if (!row) return;
  startRecentLikesMarquee(row);
}, true);
document.addEventListener('mouseleave', (e)=>{
  const row = safeClosest(e.target, '#recentLikesList .scenario-row');
  if (!row) return;
  stopRecentLikesMarquee(row);
}, true);

/* =========================================================
   Segment 切换
   ========================================================= */
document.addEventListener('click',(e)=>{
  const btn = safeClosest(e.target,'.fc-seg__btn');
  if (!btn) return;
  const seg = btn.closest('.fc-seg'); if (!seg) return;
  const targetId = btn.dataset.target;
  seg.querySelectorAll('.fc-seg__btn').forEach(b=>b.classList.toggle('is-active', b===btn));
  seg.setAttribute('data-active', targetId);
  const paneId = seg.dataset.paneId;
  const pane = paneId ? document.getElementById(paneId):null;
  if (pane) pane.querySelectorAll('.fc-rank-panel').forEach(p=>p.classList.toggle('active', p.id===targetId));
  if (targetId === 'likes-panel') loadLikesIfNeeded();
});

/* 拖动式小子段切换（保留） */
(function initRightSegSwitchLikeXAxis() {
  const segs = document.querySelectorAll('#rightSubsegContainer .fc-seg');
  if (!segs.length) return;
  segs.forEach(seg => {
    const thumb = seg.querySelector('.fc-seg__thumb');
    const btns = seg.querySelectorAll('.fc-seg__btn');
    if (!thumb || btns.length !== 2) return;
    let dragging = false;
    let startX = 0;
    let basePercent = 0;
    let lastPercent = 0;
    function activeIsRight() {
      const act = seg.getAttribute('data-active') || '';
      return act.endsWith('likes-panel');
    }
    function pointInThumb(clientX, clientY) {
      const r = thumb.getBoundingClientRect();
      return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
    }
    function start(e) {
      const cx = (e.touches ? e.touches[0].clientX : e.clientX) || 0;
      const cy = (e.touches ? e.touches[0].clientY : e.clientY) || 0;
      if (!pointInThumb(cx, cy)) return;
      dragging = true;
      startX = cx;
      basePercent = activeIsRight() ? 100 : 0;
      lastPercent = basePercent;
      thumb.style.transition = 'none';
      if (e.cancelable) e.preventDefault();
    }
    function move(e) {
      if (!dragging) return;
      const cx = (e.touches ? e.touches[0].clientX : e.clientX) || 0;
      const dx = cx - startX;
      const w = thumb.getBoundingClientRect().width || 1;
      let percent = basePercent + (dx / w) * 100;
      percent = Math.max(0, Math.min(100, percent));
      lastPercent = percent;
      thumb.style.transform = `translateX(${percent}%)`;
      if (e.cancelable) e.preventDefault();
    }
    function end() {
      if (!dragging) return;
      dragging = false;
      const goRight = lastPercent >= 50;
      const targetBtn = goRight ? btns[1] : btns[0];
      thumb.style.transition = '';
      thumb.style.transform = '';
      targetBtn.click();
    }
    seg.addEventListener('mousedown', start);
    document.addEventListener('mousemove', move, { passive: false });
    document.addEventListener('mouseup', end);
    seg.addEventListener('touchstart', start, { passive: false });
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('touchend', end);
  });
})();

/* 主容器响应式 */
(function initRightPanelResponsiveWrap(){
  const card = document.querySelector('.fc-right-card');
  if (!card || !('ResizeObserver' in window)) return;
  const APPLY_W = 520;
  const ro = new ResizeObserver(entries=>{
    for (const entry of entries){
      const w = entry.contentRect.width;
      if (w < APPLY_W) {
        card.classList.add('rp-narrow');
      } else {
        card.classList.remove('rp-narrow');
      }
    }
  });
  ro.observe(card);
})();
(function initMainPanelsAdaptiveStack(){
  if (!('ResizeObserver' in window)) return;
  const container = document.getElementById('main-panels');
  if (!container) return;
  const THRESHOLD = 980;
  function apply(width){
    if (width < THRESHOLD) {
      container.classList.add('fc-force-col');
    } else {
      container.classList.remove('fc-force-col');
    }
  }
  apply(container.getBoundingClientRect().width);
  const ro = new ResizeObserver(entries=>{
    for (const entry of entries){
      apply(entry.contentRect.width);
    }
  });
  ro.observe(container);
})();

/* =========================================================
   scheduleAdjust
   ========================================================= */
let _adjustQueued = false;
function scheduleAdjust(){
  // 始终读取全局标记（由 sidebar.js 维护），不要用本地快照变量
  if (window.__VERT_DRAGGING) return;
  if (window.__SIDEBAR_USER_ADJUSTED_VERTICAL) return;
  if (_adjustQueued) return;
  _adjustQueued = true;
  requestAnimationFrame(()=>{
    _adjustQueued = false;
    window.__APP?.sidebar?.adjustBottomPanelAuto?.();
  });
}

/* =========================================================
   初始数据获取
   ========================================================= */
(function mountChartRendererEarly(){
  function doMount(){
    const el = document.getElementById('chartHost');
    if (el && window.ChartRenderer && typeof ChartRenderer.mount === 'function') {
      ChartRenderer.mount(el);

      // NEW: 监听 X 轴切换，写回 LocalState，并按新轴刷新曲线
      if (typeof ChartRenderer.setOnXAxisChange === 'function') {
        ChartRenderer.setOnXAxisChange((next) => {
          // 规范化
          const nx = (next === 'noise') ? 'noise_db' : next;
          try { localStorage.setItem('x_axis_type', nx); } catch(_) {}
          frontXAxisType = nx;
          // 同步给应用状态（影响 /api/curves 的 x_axis_type）
          if (typeof LocalState?.setXAxisType === 'function') {
            try { LocalState.setXAxisType(nx); } catch(_) {}
          }
          // 重新取数并渲染（避免沿用旧轴裁剪过的数据）
          refreshChartFromLocal(false);
        });
      }
    }
  }
  if (document.readyState !== 'loading') {
    doMount();
  } else {
    document.addEventListener('DOMContentLoaded', doMount, { once:true });
  }
})();

// NEW: 批量获取 (model_id, condition_id) 的显示元信息
async function fetchMetaForPairs(pairs){
  if (!Array.isArray(pairs) || !pairs.length) return [];
  const resp = await fetch('/api/meta_by_ids', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ pairs })
  });
  const j = await resp.json();
  const n = normalizeApiResponse(j);
  if (!n.ok) return [];
  const items = (n.data && n.data.items) || [];
  return Array.isArray(items) ? items : [];
}

// CHANGED: “最近移除”显示缓存改用 /api/meta_by_ids（不再调用 /api/curves）
async function ensureRemovedDisplayCache(){
  try{
    const removed = (LocalState && LocalState.getRecentlyRemoved && LocalState.getRecentlyRemoved()) || [];
    if (!Array.isArray(removed) || !removed.length) return;

    const selectedPairs = new Set(
      (LocalState.getSelectionPairs?.() || []).map(p=> `${p.model_id}_${p.condition_id}`)
    );
    const need = [];
    const seen = new Set();
    for (const it of removed){
      if (!it) continue;
      const k = `${it.model_id}_${it.condition_id}`;
      if (selectedPairs.has(k)) continue;
      if (DisplayCache.get && DisplayCache.get(it.model_id, it.condition_id)) continue;
      if (seen.has(k)) continue;
      seen.add(k);
      const mid = Number(it.model_id), cid = Number(it.condition_id);
      if (Number.isInteger(mid) && Number.isInteger(cid)){
        need.push({ model_id: mid, condition_id: cid });
      }
    }
    if (!need.length) return;

    const items = await fetchMetaForPairs(need);
    if (items.length){
      DisplayCache.setFromMeta(items);
      window.__APP?.features?.recentlyRemoved?.rebuild?.(LocalState.getRecentlyRemoved());
    }
  }catch(_){}
}

(function initLocalSelectionBoot(){
  installRemovedRenderHookOnce();
  rebuildSelectedFans(LocalState.getSelected());
  primeSelectedLikeStatus();
  window.__APP.features.recentlyRemoved.rebuild(LocalState.getRecentlyRemoved());
  ensureRemovedDisplayCache(); // 关键补齐
})();

  applySidebarColors();
  refreshChartFromLocal(false); // 已选曲线依然用 /api/curves 渲染图表
  syncQuickActionButtons && syncQuickActionButtons();
  prepareSidebarMarquee();

async function primeSelectedLikeStatus(){
  try {
    const pairs = LocalState.getSelectionPairs();
    if (!pairs.length) return;

    let didFullFetch = false;
    if (needFullLikeKeyFetch()) {
      fetchAllLikeKeys();
      didFullFetch = true;
      return; // 全量后无需增量
    }
    if (LocalState.likes.shouldSkipStatus(LIKESET_VERIFY_MAX_AGE_MS)) {
      return;
    }
    const need = pairs.filter(p => !LocalState.likes.has(`${p.model_id}_${p.condition_id}`));
    if (!need.length && LocalState.likes.isSynced()) {
      return;
    }
    const resp = await fetch('/api/like_status', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ pairs: need })
    });
    if (!resp.ok) return;
    const j = await resp.json();
    const n = normalizeApiResponse(j);
    if (!n.ok) return;
    const data = n.data || {};
    if (data.fp){
       LocalState.likes.updateServerFP(data.fp); 
       LocalState.likes.logCompare(); 
      }
    const list = extractLikeKeys(data);
    if (!Array.isArray(list) || !list.length) return;
    list.forEach(k=>{
      if (!LocalState.likes.has(k)){
        LocalState.likes.add(k);
        const [m,c] = k.split('_');
        if (m && c) updateLikeIcons(m, c, true);
      }
    });

    // 二次判定：增量后若仍不同步且属于小集合 → 全量补齐
    const fp = LocalState.likes.getServerFP && LocalState.likes.getServerFP();
    if (!didFullFetch &&
        fp && typeof fp.c === 'number' &&
        fp.c < LIKE_FULL_FETCH_THRESHOLD &&
        !LocalState.likes.isSynced()) {
      fetchAllLikeKeys();
    }
  } catch(_){}

}

/* 初始右侧子段显示状态 */
updateRightSubseg('top-queries');

/* 分享模式自动滚动 */
(function autoScrollToChartOnShare(){
  try {
    const usp = new URLSearchParams(window.location.search);
    if (usp.get('share_loaded') === '1') {
      window.addEventListener('load', () => {
        setTimeout(() => {
          const el = document.getElementById('chart-settings');
          if (el) {
            el.scrollIntoView({ behavior:'smooth', block:'center' });
          }
        }, 120);
      });
    }
  } catch(_) {}
})();

/* 列表底部 padding 初始化 */
function scheduleInitListPadding(){
  const list = document.querySelector('#selectedFansList');
  if (list) list.style.paddingBottom='var(--content-bottom-gap)';
}
scheduleInitListPadding();

/* 图表窗口 Resize */
window.addEventListener('resize', ()=> {
  const collapsed = document.getElementById('sidebar')?.classList.contains('collapsed');
  if (!collapsed) resizeChart();
});

/* 顶部 Scroll Snap 初始化 */
initSnapTabScrolling({
  containerId: 'sidebar-top-container',
  group: 'sidebar-top',
  persistKey: null,
  onActiveChange: (tab)=> {
    if (tab === 'recent-liked') loadRecentLikesIfNeeded();
  }
});
initSnapTabScrolling({
  containerId: 'left-panel-container',
  group: 'left-panel',
  persistKey: 'activeTab_left-panel'
});

// 新增：右侧主页签 Scroll Snap（不保存状态，默认“近期热门”）
initSnapTabScrolling({
  containerId: 'right-panel-container',
  group: 'right-panel',
  persistKey: null,             // 不保存状态
  defaultTab: 'top-queries',    // 默认激活“近期热门”
  onActiveChange: (tab) => {
    updateRightSubseg && updateRightSubseg(tab);
    if (tab === 'recent-updates') {
      loadRecentUpdatesIfNeeded && loadRecentUpdatesIfNeeded();
    }
  }
});

/* 模块注册 */
window.__APP.modules = {
  overlay: {
    open: window.overlayOpenSidebar,
    close: window.overlayCloseSidebar,
    toggle: window.overlayToggleSidebar
  },
  gesture: {
    ensureZone: window.ensureGestureZone || function(){}
  },
  layout: {
    scheduleAdjust,
    adjustBottomAuto: window.__APP.sidebar.adjustBottomPanelAuto
  },
  search: {
    render: typeof renderSearchResults === 'function' ? renderSearchResults : function(){},
    cache: window.__APP.cache
  },
  rankings: {
    reloadTopRatings: typeof reloadTopRatings === 'function' ? reloadTopRatings : function(){},
    loadLikesIfNeeded: typeof loadLikesIfNeeded === 'function' ? loadLikesIfNeeded : function(){}
  },
  state: {
    processState: typeof processState === 'function' ? processState : function(){}
  },
  theme: {
    setTheme: typeof setTheme === 'function' ? setTheme : function(){}
  },
  chart: {
    postChartData: typeof postChartData === 'function' ? postChartData : function(){},
    resizeChart: typeof resizeChart === 'function' ? resizeChart : function(){}
  }
};

window.__APP.features?.recentlyRemoved?.mount?.();
installRemovedRenderHookOnce();

/* 滚动条宽度测量 */
(function setRealScrollbarWidth(){
  function measure(){
    try{
      const box = document.createElement('div');
      box.style.cssText = 'position:absolute;top:-9999px;left:-9999px;width:120px;height:120px;overflow:scroll;visibility:hidden;';
      document.body.appendChild(box);
      const sbw = Math.max(0, box.offsetWidth - box.clientWidth) || 0;
      document.documentElement.style.setProperty('--sbw', sbw + 'px');
      document.documentElement.classList.toggle('overlay-scrollbars', sbw === 0);
      box.remove();
    }catch(e){}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', measure, { once:true });
  } else {
    measure();
  }
  const remeasure = () => setTimeout(measure, 60);
  window.addEventListener('orientationchange', remeasure);
  window.addEventListener('resize', remeasure);
})();

/* 限制条件输入锁定 */
(function initSortValueUnlockMinimal() {
  const select = document.getElementById('sortBySelect');
  const input  = document.getElementById('sortValueInput');
  if (!select || !input) return;
  function apply() {
    const none = (select.value === 'none');
    input.disabled = none;
    if (none) input.value = '';
  }
  select.addEventListener('change', apply);
  apply();
})();

/* 查询次数显示 */
function loadQueryCount() {
  fetch('/api/query_count')
    .then(r => r.json())
    .then(j => {
      // 兼容结构：新 = j.data.count；旧（如果后端改回裸 count）= j.count
      const count = (j && typeof j === 'object')
        ? (j.data && typeof j.data === 'object' && typeof j.data.count !== 'undefined'
            ? j.data.count
            : (typeof j.count !== 'undefined' ? j.count : 0))
        : 0;
      const el = document.getElementById('query-count');
      if (el) el.textContent = count;
    })
    .catch(err => {
      console.warn('获取查询次数失败:', err);
    });
}
document.addEventListener('DOMContentLoaded', () => {
  loadQueryCount();
  setInterval(loadQueryCount, 60000);
});

/* 最近点赞标题渐隐宽度测量 */
function applyRecentLikesTitleMask() {
  const groups = document.querySelectorAll('#recentLikesList .recent-like-group');
  groups.forEach(g => {
    const titleWrap = g.querySelector('.fc-group-header .fc-title-wrap');
    const titleBox  = titleWrap?.querySelector('.truncate');
    if (!titleWrap || !titleBox) return;
    const w = Math.max(0, Math.ceil(titleBox.getBoundingClientRect().width));
    titleWrap.style.setProperty('--title-w', w + 'px');
  });
}
if (typeof window.rebuildRecentLikes === 'function' && !window.__RECENT_TITLE_MASK_PATCHED__) {
  window.__RECENT_TITLE_MASK_PATCHED__ = true;
  const _orig = window.rebuildRecentLikes;
  window.rebuildRecentLikes = function(list){
    _orig(list);
    requestAnimationFrame(applyRecentLikesTitleMask);
  };
}
let __titleMaskRaf = null;
window.addEventListener('resize', () => {
  if (__titleMaskRaf) cancelAnimationFrame(__titleMaskRaf);
  __titleMaskRaf = requestAnimationFrame(applyRecentLikesTitleMask);
});

/* 记录用户是否点击过侧栏按钮 */
const LS_KEY_SIDEBAR_TOGGLE_CLICKED = 'sidebar_toggle_clicked';
function markSidebarToggleClicked(){
  try { localStorage.setItem(LS_KEY_SIDEBAR_TOGGLE_CLICKED, '1'); } catch(_) {}
}
function userHasClickedSidebarToggle(){
  try { return localStorage.getItem(LS_KEY_SIDEBAR_TOGGLE_CLICKED) === '1'; } catch(_) { return false; }
}
function maybeAutoOpenSidebarOnAdd(){
  if (userHasClickedSidebarToggle()) return;
  expandSidebarIfCollapsed();
}

/* visit_start */
(function initVisitStartMinimal(){
  try { if (sessionStorage.getItem('visit_started') === '1') return; } catch(_) {}
  const payload = {
    screen_w: (screen && screen.width) || null,
    screen_h: (screen && screen.height) || null,
    device_pixel_ratio: window.devicePixelRatio || null,
    language: (navigator.languages && navigator.languages[0]) || navigator.language || null,
    is_touch: ('ontouchstart' in window) || (navigator.maxTouchPoints > 0)
  };
  fetch('/api/visit_start', {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify(payload),
    keepalive: true
  }).catch(()=>{}).finally(()=>{
    try { sessionStorage.setItem('visit_started','1'); } catch(_){}
  });
})();

/* 全局 Tooltip */
(function initGlobalTooltip(){
  const MARGIN = 8;
  let tip = null, currAnchor = null, hideTimer = null;
  function ensureTip(){
    if (tip) return tip;
    tip = document.createElement('div');
    tip.id = 'appTooltip';
    document.body.appendChild(tip);
    return tip;
  }
  function setText(html){
    ensureTip().innerHTML = html;
  }
  function placeAround(anchor, preferred='top'){
    const t = ensureTip();
    const rect = anchor.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    t.style.visibility = 'hidden';
    t.dataset.show = '1';
    t.style.left = '-9999px';
    t.style.top  = '-9999px';
    const tw = t.offsetWidth, th = t.offsetHeight;
    let placement = preferred;
    const topSpace = rect.top;
    const bottomSpace = vh - rect.bottom;
    if (preferred === 'top' && topSpace < th + 12) placement = 'bottom';
    if (preferred === 'bottom' && bottomSpace < th + 12) placement = 'top';
    let cx = rect.left + rect.width / 2;
    cx = Math.max(MARGIN + tw/2, Math.min(vw - MARGIN - tw/2, cx));
    let top;
    if (placement === 'top') top = rect.top - th - 10; else top = rect.bottom + 10;
    t.dataset.placement = placement;
    t.style.left = `${Math.round(cx)}px`;
    t.style.top  = `${Math.round(top)}px`;
    t.style.visibility = '';
  }
  function show(anchor){
    clearTimeout(hideTimer);
    currAnchor = anchor;
    const txt = anchor.getAttribute('data-tooltip') || anchor.getAttribute('title') || '';
    if (anchor.hasAttribute('title')) anchor.setAttribute('data-title', anchor.getAttribute('title')), anchor.removeAttribute('title');
    setText(txt);
    placeAround(anchor, anchor.getAttribute('data-tooltip-placement') || 'top');
    ensureTip().dataset.show = '1';
  }
  function hide(immediate=false){
    const t = ensureTip();
    const doHide = () => { t.dataset.show = '0'; currAnchor = null; };
    if (immediate) return doHide();
    hideTimer = setTimeout(doHide, 60);
  }
  document.addEventListener('mouseenter', (e) => {
    let node = e.target;
    if (node && node.nodeType !== 1) node = node.parentElement;
    if (!node) return;
    let el = null;
    if (node && typeof node.closest === 'function') {
      try { el = node.closest('[data-tooltip]'); } catch(_) {}
    }
    if (!el) el = safeClosest(node, '[data-tooltip]');
    if (!el) return;
    show(el);
  }, true);
  document.addEventListener('mouseleave', (e) => {
    let node = e.target;
    if (node && node.nodeType !== 1) node = node.parentElement;
    if (!node) return;
    let el = null;
    if (node && typeof node.closest === 'function') {
      try { el = node.closest('[data-tooltip]'); } catch(_) {}
    }
    if (!el) el = safeClosest(node, '[data-tooltip]');
    if (!el) return;
    hide(false);
  }, true);
  document.addEventListener('focusin', (e)=>{
    const el = safeClosest(e.target, '[data-tooltip]');
    if (!el) return;
    show(el);
  });
  document.addEventListener('focusout', (e)=>{
    const el = safeClosest(e.target, '[data-tooltip]');
    if (!el) return;
    hide(false);
  });
  const onRelayout = ()=>{ if (currAnchor && document.body.contains(currAnchor)) placeAround(currAnchor, currAnchor.getAttribute('data-tooltip-placement') || 'top'); };
  window.addEventListener('resize', onRelayout);
  window.addEventListener('scroll', onRelayout, { passive: true, capture: true });
  window.addEventListener('beforeunload', ()=>{
    document.querySelectorAll('[data-title]').forEach(el=>{
      el.setAttribute('title', el.getAttribute('data-title') || '');
      el.removeAttribute('data-title');
    });
  });
})();

/* 工况格式化 */
function formatScenario(rt, rl){
  const rtype = escapeHtml(rt || '');
  const raw = rl ?? '';
  const isEmpty = (String(raw).trim() === '' || String(raw).trim() === '无');
  return isEmpty ? rtype : `${rtype}(${escapeHtml(raw)})`;
}

/* expand */
async function fetchExpandPairs(brand, model, condition){
  const payload = {
    mode: 'expand',
    brand,
    model,
    condition_name: condition
  };
  const resp = await fetch('/api/search_fans', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(payload)
  });
  const j = await resp.json();
  const n = normalizeApiResponse(j);
  if (!n.ok){
    throw new Error(n.error_message || n.error_code || 'expand 请求失败');
  }
  const root = n.data || {};
  const items = (root.items) || (root.data && root.data.items) || [];
  return items.map(it=>({
    model_id: it.model_id,
    condition_id: it.condition_id,
    brand: it.brand_name_zh,
    model: it.model_name,
    condition: it.condition_name_zh
  }));
}

async function refreshChartFromLocal(showToast=false){
  const pairs = LocalState.getSelectionPairs();
  if (pairs.length === 0) {
    postChartData({ x_axis_type: LocalState.getXAxisType(), series: [] });
    return;
  }
  try {
    const resp = await fetch('/api/curves', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ pairs })
    });
    const j = await resp.json();
    const n = normalizeApiResponse(j);
    if (!n.ok){ showError(n.error_message || '获取曲线失败'); return; }
    const data = n.data || {};

    // missing 清理保持不变...

    const chartData = {
      x_axis_type: LocalState.getXAxisType(),
      series: data.series || []
    };
    // NEW: 用服务器返回的元信息更新显示缓存
    DisplayCache.setFromSeries(chartData.series);
    // 刷新侧栏/最近移除的显示文本
    rebuildSelectedFans(LocalState.getSelected());
    window.__APP.features.recentlyRemoved.rebuild(LocalState.getRecentlyRemoved());

    lastChartData = chartData;
    postChartData(chartData);
    if (showToast) showSuccess('已刷新曲线');
  } catch(e){
    showError('曲线请求异常: '+e.message);
  }
}

async function logNewPairs(addedDetails, source = 'unknown') {
  if (!addedDetails || !addedDetails.length) return;
  const pairs = addedDetails.map(d => ({ model_id: d.model_id, condition_id: d.condition_id }));

  if (!window.Analytics || typeof window.Analytics.logQueryPairs !== 'function') {
    // Fail fast：显式暴露缺陷，便于定位问题
    throw new Error('Analytics module not loaded: window.Analytics.logQueryPairs is unavailable');
  }

  await window.Analytics.logQueryPairs(source, pairs);
}


function generateDarkGradient() {
  // 随机主色 & 副色 (HSL)
  const h1 = Math.floor(Math.random() * 360);
  const h2Offset = 30 + Math.floor(Math.random() * 60); // 30~90 之间偏移
  const h2 = (h1 + h2Offset) % 360;

  const s1 = 35 + Math.random() * 25; // 35-60%
  const s2 = 35 + Math.random() * 25;

  const l1 = 10 + Math.random() * 8;  // 10-18% 更暗
  const l2 = 14 + Math.random() * 12; // 14-26% 略亮

  const angle = Math.floor(Math.random() * 360);

  const stop1 = `hsl(${h1} ${s1.toFixed(1)}% ${l1.toFixed(1)}%)`;
  const stop2 = `hsl(${h2} ${s2.toFixed(1)}% ${l2.toFixed(1)}%)`;
  const gradient = `linear-gradient(${angle}deg, ${stop1} 0%, ${stop2} 100%)`;

  const root = document.documentElement;
  // 只设置渐变，不再改 --bg-primary，底色交给 CSS 里的 [data-theme="dark"] --bg-primary
  root.style.setProperty('--dark-rand-gradient', gradient);
  // 留下一个可供导出/其它用途的基色（可选，不参与底色）
  const baseIsFirst = l1 <= l2;
  root.style.setProperty('--dark-rand-base', baseIsFirst ? stop1 : stop2);
}
