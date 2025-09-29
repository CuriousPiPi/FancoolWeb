
window.APP_CONFIG = window.APP_CONFIG || { clickCooldownMs: 2000, maxItems: 0 };
/* ==== 命名空间根 ==== */
window.__APP = window.__APP || {};

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

/* ==== P1-5 帧写入调度器（低频批量写入） ==== */
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

/* ==== P1-7 通用缓存 (内存+TTL) ==== */
window.__APP.cache = (function(){
  const store = new Map();
  const DEFAULT_TTL = 180000; // 3 分钟
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

/* ==== 快捷选择器（缓存版本） ==== */
const $ = (s) => window.__APP.dom.one(s);


// === POLYFILL + SAFE CLOSEST (全局一次) ===
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

  // 覆盖/增强你原来的 safeClosest
  window.safeClosest = function safeClosest(start, selector) {
    if (!start) return null;
    let el = start;
    // 提升文本/注释节点
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
   Overlay 初始化（含 Scroll Lock 计数 + Backdrop + 手势热区保障）
   ========================================================= */
(function initSidebarOverlayModeOnce() {
  const vw = window.innerWidth;
  if (vw >= 600) return;
  const root = document.documentElement;
  root.classList.add('sidebar-overlay-mode');
  const sidebar = $('#sidebar');
  if (!sidebar) return;
  if (!sidebar.classList.contains('collapsed')) sidebar.classList.add('collapsed');

  // Scroll lock 引用计数
  let bodyLockCount = 0;
  let prevBodyOverflow = '';

  function lockBodyScroll() {
    if (bodyLockCount === 0) {
      prevBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    bodyLockCount++;
  }
  function unlockBodyScroll() {
    bodyLockCount = Math.max(0, bodyLockCount - 1);
    if (bodyLockCount === 0) {
      document.body.style.overflow = prevBodyOverflow;
    }
  }

  function addBackdrop() {
    if (document.querySelector('.sidebar-overlay-backdrop')) {
      requestAnimationFrame(()=>document.querySelector('.sidebar-overlay-backdrop')?.classList.add('is-visible'));
      return;
    }
    const bd = document.createElement('div');
    bd.className = 'sidebar-overlay-backdrop';
    bd.addEventListener('click', () => overlayCloseSidebar());
    document.body.appendChild(bd);
    requestAnimationFrame(()=>bd.classList.add('is-visible'));
  }
  function removeBackdrop() {
    const bd = document.querySelector('.sidebar-overlay-backdrop');
    if (!bd) return;
    bd.classList.remove('is-visible');
    setTimeout(()=>bd.remove(), 220);
  }

  window.overlayOpenSidebar = function overlayOpenSidebar() {
      if (!root.classList.contains('sidebar-overlay-mode')) return;
      const s = document.getElementById('sidebar'); if (!s) return;
      s.classList.remove('collapsed');
      addBackdrop();
      lockBodyScroll();
      ensureGestureZone();
      a11yFocusTrap.activate(s);   // <<< 新增：激活焦点陷阱
      refreshToggleUI && refreshToggleUI();
    };

  window.overlayCloseSidebar = function overlayCloseSidebar() {
      if (!root.classList.contains('sidebar-overlay-mode')) return;
      const s = document.getElementById('sidebar'); if (!s) return;
      if (!s.classList.contains('collapsed')) {
        s.classList.add('collapsed');
        removeBackdrop();
        unlockBodyScroll();
        a11yFocusTrap.deactivate(); 
        const mc = document.getElementById('main-content');
        if (mc) mc.style.marginLeft = '';
        refreshToggleUI && refreshToggleUI();
      }
    };

  window.overlayToggleSidebar = function overlayToggleSidebar() {
    const s = $('#sidebar'); if (!s) return;
    if (s.classList.contains('collapsed')) overlayOpenSidebar(); else overlayCloseSidebar();
  };

  document.addEventListener('keydown', (e)=>{
    if (e.key === 'Escape') overlayCloseSidebar();
  });
})();

/* =========================================================
   P0-1：右缘关闭手势热区
   ========================================================= */
(function initOverlayCloseGestureZone() {
  const root = document.documentElement;
  if (!root.classList.contains('sidebar-overlay-mode')) {
    window.addEventListener('resize', tryLateInit, { once: true });
    return;
  }
  setup();
  function tryLateInit() {
    if (window.innerWidth < 600) setup();
  }
  function setup() {
    window.ensureGestureZone = function ensureGestureZone() {
      const sidebar = $('#sidebar');
      if (!sidebar) return;
      if (document.getElementById('sidebar-gesture-close-zone')) return;
      const zone = document.createElement('div');
      zone.id = 'sidebar-gesture-close-zone';
      zone.setAttribute('role','presentation');
      sidebar.appendChild(zone);
      bindZoneEvents(zone, sidebar);
    };
    window.ensureGestureZone();
  }

  const zoneWidthVar = getComputedStyle(document.documentElement).getPropertyValue('--gesture-close-zone-width').trim();
  const GESTURE_CLOSE_ZONE_WIDTH = parseInt(zoneWidthVar, 10) || 24;
  const CLOSE_RATIO = 0.30;
  const MIN_DRAG_X = 12;
  const MAX_SLOPE = 0.65;
  const VELOCITY_CLOSE_PX_PER_MS = -0.8; // 负值：向左快速甩
  const MIN_FLING_DISTANCE = 24;         // 位移至少超过 24px 才考虑速度关闭

  function bindZoneEvents(zone, sidebar) {
    let drag = null;
    function backdrop() { return document.querySelector('.sidebar-overlay-backdrop'); }
    function pt(e) {
      if (e.changedTouches && e.changedTouches.length) {
        const t = e.changedTouches[0];
        return { x: t.clientX, y: t.clientY };
      }
      return { x: e.clientX, y: e.clientY };
    }
    zone.addEventListener('pointerdown', (e)=>{
      if (e.pointerType === 'mouse') return;
      if (sidebar.classList.contains('collapsed')) return;
      const p = pt(e);
      drag = {
        startX: p.x,
        startY: p.y,
        lastX: p.x,
        lastY: p.y,
        width: sidebar.getBoundingClientRect().width,
        dragging: false,
        pointerId: e.pointerId,
        trace: [{ x: p.x, t: performance.now() }]
      };
      try { zone.setPointerCapture(e.pointerId); } catch(_){}
    }, { passive:true });

    zone.addEventListener('pointermove', (e)=>{
      if (!drag || drag.pointerId !== e.pointerId) return;
      const p = pt(e);
      drag.lastX = p.x; drag.lastY = p.y;
      const dx = p.x - drag.startX;
      const dy = p.y - drag.startY;
      if (!drag.dragging) {
        if (dx < -MIN_DRAG_X) {
          const slope = Math.abs(dy / dx);
            if (slope <= MAX_SLOPE) {
              drag.dragging = true;
              sidebar.style.transition='none';
            } else {
              cancelDrag();
            }
        }
        return;
      }
      e.preventDefault();
      const limited = Math.max(-drag.width, dx);
      sidebar.style.transform = `translateX(${limited}px)`;
      const bd = backdrop();
      if (bd) {
        const ratio = Math.max(0, Math.min(1, 1 + limited / drag.width));
        const eased = (function easeOutQuad(t){ return 1 - (1 - t)*(1 - t); })(ratio);
        const op = 0.8 * eased;
        bd.style.opacity = op.toFixed(3);

        // 记录位置用于速度计算
        const now = performance.now();
        drag.trace.push({ x: p.x, t: now });
        if (drag.trace.length > 5) drag.trace.shift();
      }
    }, { passive:false });

    function finishDrag() {
      if (!drag) return;
      const dx = drag.lastX - drag.startX;
      const dist = Math.abs(dx);
      let shouldClose = dist > drag.width * CLOSE_RATIO;

      if (!shouldClose) {
        // 动量判定：满足最小位移 + 速度阈值
        if (dist > MIN_FLING_DISTANCE && drag.trace && drag.trace.length >= 2) {
          const a = drag.trace[drag.trace.length - 2];
          const b = drag.trace[drag.trace.length - 1];
          const dt = Math.max(1, b.t - a.t);
          const vx = (b.x - a.x) / dt; // px/ms
          if (vx <= VELOCITY_CLOSE_PX_PER_MS) {
            shouldClose = true;
          }
        }
      }
      sidebar.style.transition='';
      if (shouldClose) {
        overlayCloseSidebar && overlayCloseSidebar();
        requestAnimationFrame(()=> { sidebar.style.transform=''; });
      } else {
        sidebar.style.transform='translateX(0)';
        const bd = document.querySelector('.sidebar-overlay-backdrop'); if (bd) bd.style.opacity='';
        requestAnimationFrame(()=>{
          if (!sidebar.classList.contains('collapsed')) sidebar.style.transform='';
        });
      }
      cancelDrag();
    }
    function cancelDrag(){ drag = null; }

    zone.addEventListener('pointerup', (e)=>{
      if (!drag || drag.pointerId !== e.pointerId) return;
      if (drag.dragging) finishDrag(); else cancelDrag();
    }, { passive:true });
    zone.addEventListener('pointercancel', (e)=>{
      if (!drag || drag.pointerId !== e.pointerId) return;
      if (drag.dragging) finishDrag(); else cancelDrag();
    }, { passive:true });

    const ro = ('ResizeObserver' in window) ? new ResizeObserver(()=>{
    }) : null;
    if (ro) ro.observe(sidebar);
  }
})();

/* =========================================================
   工具函数 / Toast / Throttle / HTML 转义
   ========================================================= */
const toastContainerId = 'toastContainer';
function ensureToastRoot() {
  let r = document.getElementById(toastContainerId);
  if (!r) { r = document.createElement('div'); r.id = toastContainerId; document.body.appendChild(r); }
  return r;
}
let toastIdCounter = 0;
const activeLoadingKeys = new Set();

function createToast(msg, type='info', opts={}) {
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
  div.className = 'toast '+type;
  div.id = id;
  div.innerHTML = `${iconMap[type]||iconMap.info}<div class="msg">${msg}</div><span class="close-btn" data-close="1">&times;</span>`;
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
    const t = e.target.closest('.toast'); if (t) closeToast(t.id);
  }
});

const loadingTimeoutMap = new Map();
function showLoading(key, text='加载中...') {
  // 已有同 key：只更新文本，不再创建新节点
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

  // 可选兜底关闭（保持你之前 12 秒逻辑）
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

  const nodes = [];

  while (document.getElementById(id)) {
    nodes.push(document.getElementById(id));
    document.getElementById(id).remove(); 
  }

  const t = loadingTimeoutMap.get(key);
  if (t) {
    clearTimeout(t);
    loadingTimeoutMap.delete(key);
  }
}

function autoCloseOpLoading() {
  hideLoading('op');
  document.querySelectorAll('.toast.loading').forEach(t => {
    const msgEl = t.querySelector('.msg');
    if (!msgEl) return;
    const text = (msgEl.textContent || '').trim();
    if (/^(添加中|移除中)/.test(text)) {
      t.remove();
    }
  });
}

const showSuccess = (m)=>createToast(m,'success');
const showError = (m)=>createToast(m,'error');
const showInfo = (m)=>createToast(m,'info', {autoClose:1800});

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
   颜色映射与图表通讯
   ========================================================= */
function applyServerStatePatchColorIndices(share_meta){
  if (!share_meta) return;
  if (share_meta.color_indices && typeof share_meta.color_indices === 'object') {
    try {
      Object.entries(share_meta.color_indices).forEach(([k,v])=>{
        if (Number.isFinite(v)) { colorIndexMap[k] = v|0; }
      });
      saveColorIndexMap(colorIndexMap);
    } catch(_){}
  }
}

function loadColorIndexMap(){
  try { return JSON.parse(localStorage.getItem('colorIndexMap_v1')||'{}'); } catch { return {}; }
}
function saveColorIndexMap(obj){
  try { localStorage.setItem('colorIndexMap_v1', JSON.stringify(obj)); } catch(_){}
}
let colorIndexMap = loadColorIndexMap();
function ensureColorIndexForKey(key, selectedKeys){
  if (!key) return 0;
  if (Object.prototype.hasOwnProperty.call(colorIndexMap,key)) return colorIndexMap[key]|0;
  const used = new Set();
  (selectedKeys||[]).forEach(k=>{
    if (Object.prototype.hasOwnProperty.call(colorIndexMap,k)) used.add(colorIndexMap[k]|0);
  });
  let idx=0; while(used.has(idx)) idx++;
  colorIndexMap[key]=idx; saveColorIndexMap(colorIndexMap);
  return idx;
}
function ensureColorIndicesForSelected(fans){
  const keys = (fans||[]).map(f=>f.key);
  keys.forEach(k=>ensureColorIndexForKey(k, keys));
}
function colorForKey(key){
  const idx = (Object.prototype.hasOwnProperty.call(colorIndexMap,key)?(colorIndexMap[key]|0):0);
  const palette = currentPalette();
  return palette[idx % palette.length];
}

/* 颜色映射 withFrontColors（保留并附带 color_index） */
function withFrontColors(chartData){
  // 兜底：若分享首次加载且未应用轴类型，则这里也同步一次
  if (__isShareLoaded && !__shareAxisApplied && chartData && chartData.x_axis_type) {
    frontXAxisType = (chartData.x_axis_type === 'noise') ? 'noise_db' : chartData.x_axis_type;
    try { localStorage.setItem('x_axis_type', frontXAxisType); } catch(_){}
    __shareAxisApplied = true;
  }
  const series = (chartData.series||[]).map(s=>{
    const idx = colorIndexMap[s.key] ?? ensureColorIndexForKey(s.key);
    return { ...s, color: colorForKey(s.key), color_index: idx };
  });
  return { ...chartData, x_axis_type: frontXAxisType, series };
}

/* ==== 修正：颜色索引回收与去重（稳定版） ==== */

/* 最小未占用 index */
function nextFreeIndex(assigned){
  let i = 0;
  while (assigned.has(i)) i++;
  return i;
}

/* 释放某个已移除 key 的颜色索引 */
function releaseColorIndexForKey(key){
  if (!key) return;
  if (Object.prototype.hasOwnProperty.call(colorIndexMap, key)) {
    delete colorIndexMap[key];
    saveColorIndexMap(colorIndexMap);
  }
}

/* 只在“缺失或冲突”时重分配；唯一者保持不变，避免颜色抖动 */
function assignUniqueIndicesForSelection(fans){
  const keys = (fans || []).map(f => f.key).filter(Boolean);

  // 统计每个 idx 的拥有数，用于识别冲突
  const countByIdx = new Map(); // idx -> count
  keys.forEach(k => {
    if (Object.prototype.hasOwnProperty.call(colorIndexMap, k)) {
      const idx = colorIndexMap[k] | 0;
      countByIdx.set(idx, (countByIdx.get(idx) || 0) + 1);
    }
  });

  // 已最终占用的索引集合（先占住所有“唯一”的旧索引，保证稳定）
  const assigned = new Set();
  keys.forEach(k => {
    if (Object.prototype.hasOwnProperty.call(colorIndexMap, k)) {
      const idx = colorIndexMap[k] | 0;
      if ((countByIdx.get(idx) || 0) === 1) {
        assigned.add(idx); // 保留旧索引
      }
    }
  });

  // 第二轮：仅对“缺失或冲突”的条目分配新索引
  keys.forEach(k => {
    const has = Object.prototype.hasOwnProperty.call(colorIndexMap, k);
    if (has) {
      const idx = colorIndexMap[k] | 0;
      const isUnique = (countByIdx.get(idx) || 0) === 1;
      if (isUnique) {
        // 唯一者无条件保留旧 idx，避免洗牌
        // 确保占位（即使第一轮已占位，这里重复 add 也安全）
        assigned.add(idx);
        return;
      }
    }
    // 缺失或冲突：分配新 index
    const newIdx = nextFreeIndex(assigned);
    colorIndexMap[k] = newIdx;
    assigned.add(newIdx);
  });

  saveColorIndexMap(colorIndexMap);
}

const chartFrame = $('#chartFrame');
let lastChartData = null;
let likedKeysSet = new Set();
let frontXAxisType = 'rpm';

const chartMessageQueue = [];
let chartFrameReady = false;

function flushChartQueue(){
  if (!chartFrameReady || !chartFrame || !chartFrame.contentWindow) return;
  while(chartMessageQueue.length){
    const msg = chartMessageQueue.shift();
    try {
      chartFrame.contentWindow.postMessage(msg, window.location.origin);
    } catch(e){
      console.warn('postMessage flush error:', e);
      break;
    }
  }
  // 补一次 resize，防止初始化阶段尺寸还未稳定
  setTimeout(()=>resizeChart(), 50);
}

if (chartFrame) {
  chartFrame.addEventListener('load', () => {
    // 若 iframe 未主动发 chart:ready，也在 load 时标记就绪并 flush
    if (!chartFrameReady) {
      chartFrameReady = true;
      flushChartQueue();
      if (lastChartData && !chartMessageQueue.length) {
        postChartData(lastChartData);
      }
    }
  });
}

(function initPersistedXAxisType(){
  try {
    const saved = localStorage.getItem('x_axis_type');
    if (saved === 'rpm' || saved === 'noise_db' || saved === 'noise') {
      frontXAxisType = (saved === 'noise') ? 'noise_db' : saved;
    }
  } catch(_) {}
})();

// 新增：读取图表容器的实际背景色（透明则回退到 body 或白色）
function getChartBg(){
  const host = document.getElementById('chart-settings') || document.body;
  let bg = '';
  try { bg = getComputedStyle(host).backgroundColor; } catch(_) {}
  if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') {
    try { bg = getComputedStyle(document.body).backgroundColor; } catch(_) {}
  }
  return bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : '#ffffff';
}

const DARK_BASE_PALETTE = [
  "#3E9BFF", // 鲜蓝
  "#FFF958", // 金
  "#42E049", // 绿
  "#FF4848", // 红
  "#DB68FF", // 紫
  "#2CD1E8", // 青
  "#F59916", // 橙
  "#FF67A6", // 粉
  "#8b5cf6", // 次蓝紫
  "#14E39E"  // 次绿
];

/**
 * 检测当前主题
 */
const currentThemeStr = () =>
  (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');

const LIGHT_LINEAR_SCALE = 0.66; // 在“物理线性空间”缩放
function srgbToLinear(c){ // 0..1
  return c <= 0.04045 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4);
}
function linearToSrgb(c){
  return c <= 0.0031308 ? 12.92*c : 1.055*Math.pow(c,1/2.4)-0.055;
}
function darkToLightLinear(hex){
  const h = hex.replace('#','');
  let r = parseInt(h.slice(0,2),16)/255;
  let g = parseInt(h.slice(2,4),16)/255;
  let b = parseInt(h.slice(4,6),16)/255;
  // 解码到线性光
  r = srgbToLinear(r);
  g = srgbToLinear(g);
  b = srgbToLinear(b);
  // 线性缩放
  r *= LIGHT_LINEAR_SCALE;
  g *= LIGHT_LINEAR_SCALE;
  b *= LIGHT_LINEAR_SCALE;
  // 编码回 sRGB
  r = Math.round(linearToSrgb(r)*255);
  g = Math.round(linearToSrgb(g)*255);
  b = Math.round(linearToSrgb(b)*255);
  const to = v=>v.toString(16).padStart(2,'0');
  return '#'+to(r)+to(g)+to(b);
}
function currentPalette(){
  return currentThemeStr()==='dark'
    ? DARK_BASE_PALETTE
    : DARK_BASE_PALETTE.map(darkToLightLinear);
}

window.applySidebarColors = function() {
  const rows = window.__APP.dom.all('#selectedFansList .fan-item');
  window.__APP.scheduler.write(()=> {
    rows.forEach(div => {
      const key = div.getAttribute('data-fan-key');
      const dot = div.querySelector('.js-color-dot');
      if (key && dot) dot.style.backgroundColor = colorForKey(key);
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
      // 仅当 x 与 airflow 都是“真实数值”时才保留该点
      if (isValidNum(x) && isValidNum(y)) {
        rpmNew.push(isValidNum(rpmArr[i]) ? rpmArr[i] : null);
        noiseNew.push(isValidNum(noiseArr[i]) ? noiseArr[i] : null);
        flowNew.push(y);
      }
    }

    // 当前轴维度下没有任何有效点 -> 整个系列不发送
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
  if (!chartFrame || !chartFrame.contentWindow) return;
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
  const msg = { type:'chart:update', payload };
  if (!chartFrameReady){
    chartMessageQueue.push(msg);
  } else {
    chartFrame.contentWindow.postMessage(msg, window.location.origin);
  }
}

function resizeChart(){
  if (!chartFrame || !chartFrame.contentWindow) return;
  chartFrame.contentWindow.postMessage({ type:'chart:resize' }, window.location.origin);
}

/* =========================================================
   子段 UI（右侧子段定位）
   ========================================================= */
const rightSubsegContainer = $('#rightSubsegContainer');
const segQueriesOrig = document.querySelector('#top-queries-pane .seg');
const segSearchOrig  = document.querySelector('#search-results-pane .seg');
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
const recentLikesListEl = $('#recentLikesList');
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
    const rt = item.resistance_type_zh || item.res_type || item.resistance_type || '';
    const rl = item.resistance_location_zh || item.res_loc || item.resistance_location || ''; // 允许为空
    const mid = item.model_id ?? item.modelId ?? item.mid ?? '';
    const cid = item.condition_id ?? item.conditionId ?? item.cid ?? '';
    if (!brand || !model || !rt) return; // 仅要求类型存在
    const key = `${brand}||${model}||${size}||${thickness}||${maxSpeed}`;
    if (!groups.has(key)) groups.set(key, { brand, model, size, thickness, maxSpeed, scenarios:[] });
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
    groupDiv.innerHTML = `
      <div class="group-header">
        <div class="title-wrap flex items-center min-w-0">
          <div class="truncate font-medium">${escapeHtml(g.brand)} ${escapeHtml(g.model)}</div>
        </div>
        <div class="meta-right text-sm text-gray-600">${metaRight}</div>
      </div>
      <div class="group-scenarios mt-2 space-y-1">${scenariosHtml}</div>`;
    wrap.appendChild(groupDiv);
  });

  syncQuickActionButtons();
  requestAnimationFrame(prepareRecentLikesMarquee);
}

function reloadRecentLikes(){
  showLoading('recent-likes','加载最近点赞...');
  fetch('/api/recent_likes')
    .then(r=>r.json())
    .then(d=>{
      if (!d.success){ showError('获取最近点赞失败'); return; }
      rebuildRecentLikes(d.data||[]);
      recentLikesLoaded = true;
    })
    .catch(err=>showError('获取最近点赞异常: '+err.message))
    .finally(()=>hideLoading('recent-likes'));
}
function loadRecentLikesIfNeeded(){
  if (recentLikesLoaded) return;
  reloadRecentLikes();
}

/* =========================================================
   顶部 / 左 / 右三个 Tab 管理（Sidebar 顶部用 Scroll Snap）
   ========================================================= */
function activateTab(group, tabName, animate = false) {
  if (group === 'sidebar-top') {
    const nav = document.querySelector('.tab-nav[data-tab-group="sidebar-top"]');
    if (nav) {
      nav.querySelectorAll('.tab-nav-item').forEach(it => {
        it.classList.toggle('active', it.dataset.tab === tabName);
      });
    }
    localStorage.setItem('activeTab_sidebar-top', tabName);
    if (tabName === 'recent-liked') loadRecentLikesIfNeeded();
    return;
  }

  // 新增：left-panel 使用横向滚动（Scroll Snap）
  if (group === 'left-panel') {
    const nav = document.querySelector('.tab-nav[data-tab-group="left-panel"]');
    const container = document.getElementById('left-panel-container');
    if (!nav || !container) return;

    const items = [...nav.querySelectorAll('.tab-nav-item')];
    let idx = items.findIndex(i => i.dataset.tab === tabName);
    if (idx < 0) {
      idx = 0;
      tabName = items[0]?.dataset.tab || '';
    }
    items.forEach((it, i) => it.classList.toggle('active', i === idx));

    const left = container.clientWidth * idx;
    if (animate) container.scrollTo({ left, behavior: 'smooth' });
    else container.scrollLeft = left;

    localStorage.setItem('activeTab_left-panel', tabName);
    return; // 不再走通用 transform 逻辑
  }

  // 其余（如 right-panel）沿用原 transform 方案
  const nav = document.querySelector(`.tab-nav[data-tab-group="${group}"]`);
  const wrapper = document.getElementById(`${group}-wrapper`);
  if (!nav || !wrapper) return;

  const items = [...nav.querySelectorAll('.tab-nav-item')];

  // 关键：右侧页签初始化时（animate=false）忽略本地存储，固定用第一个页签
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

  // 不再保存 right-panel 的本地状态，其它分组仍然保存
  if (group !== 'right-panel') {
    localStorage.setItem('activeTab_' + group, tabName);
  }

  if (group === 'right-panel') updateRightSubseg(tabName);
  if (group === 'sidebar-top' && tabName === 'recent-liked') loadRecentLikesIfNeeded();
  if (group === 'sidebar-top') requestAnimationFrame(() => requestAnimationFrame(syncTopTabsViewportHeight));
}

document.addEventListener('click',(e)=>{
  const item = safeClosest(e.target, '.tab-nav .tab-nav-item');
  if (!item) return;
  const nav = item.closest('.tab-nav');
  const group = nav?.dataset?.tabGroup;
  if (!group) return;
  activateTab(group, item.dataset.tab, true);
});
['left-panel','right-panel','sidebar-top'].forEach(group=>{
  const saved = localStorage.getItem('activeTab_'+group);
  activateTab(group, saved || document.querySelector(`.tab-nav[data-tab-group="${group}"] .tab-nav-item`)?.dataset.tab || '', false);
});

/* ===== 顶部可视高度同步 ===== */
function computeTopPaneViewportHeight(){
  const scroller = document.querySelector('#top-panel .sidebar-panel-content');
  const nav = scroller ? scroller.querySelector('nav.tab-nav') : null;
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
  const container = document.querySelector('#top-panel .tab-content-container');
  if (!container) return;
  const h = computeTopPaneViewportHeight();
  container.style.height = (h>0?h:0)+'px';
}
(function initTopTabsViewport(){
  const scroller = document.querySelector('#top-panel .sidebar-panel-content');
  if (scroller && 'ResizeObserver' in window){
    const ro = new ResizeObserver(()=>requestAnimationFrame(syncTopTabsViewportHeight));
    ro.observe(scroller);
  }
  syncTopTabsViewportHeight();
  window.addEventListener('resize', ()=>requestAnimationFrame(syncTopTabsViewportHeight));
  document.addEventListener('mouseup', ()=>requestAnimationFrame(syncTopTabsViewportHeight));
})();

/* =========================================================
   Sidebar 状态相关 & 拖拽（垂直 splitter / 宽度 resizer）
   ========================================================= */
const sidebar        = $('#sidebar');
const sidebarToggle  = document.getElementById('sidebar-toggle');
const mainContent    = $('#main-content');
const resizer        = document.getElementById('sidebar-resizer');
const splitter       = document.getElementById('sidebar-splitter');
const topPanel       = document.getElementById('top-panel');
const bottomPanel    = document.getElementById('bottom-panel');

function refreshToggleUI(){
  const btn = document.getElementById('sidebar-toggle');
  if (!btn) return;
  const collapsed = sidebar.classList.contains('collapsed');
  btn.setAttribute('aria-label', collapsed ? '展开侧栏' : '收起侧栏');
  btn.setAttribute('aria-expanded', String(!collapsed));
}
refreshToggleUI();

let currentSidebarWidth = sidebar?.getBoundingClientRect().width || 0;
let isCollapsed = sidebar?.classList.contains('collapsed') || false;
let userAdjustedVertical = false;      // 高度锁定（用户拖拽过）
let unlockOnNextExpand = false;        // 收起时不立刻解锁，等下一次展开再解锁

// 解锁并恢复自动高度
function unlockVerticalAuto(){
  userAdjustedVertical = false;
  window.__VERT_DRAGGING = false;
  document.body.classList.remove('is-vert-dragging');
  // 清除由拖拽设置的内联高度/弹性
  if (topPanel) {
    topPanel.style.height = '';
    topPanel.style.flex   = '';
  }
  if (bottomPanel) {
    bottomPanel.style.flex   = '';
    bottomPanel.style.height = '';
  }
  // 触发一次自动布局
  scheduleAdjust && scheduleAdjust();
}

// 在“展开完成”时，如果之前记录了需要解锁，则执行解锁
function maybeUnlockOnExpand(){
  if (!unlockOnNextExpand) return;
  unlockOnNextExpand = false;
  unlockVerticalAuto();
}

// 监听侧栏 class 变化：收起时仅设置“下次展开再解锁”；展开时执行解锁
if (sidebar){
  const mo = new MutationObserver(muts=>{
    for (const m of muts){
      if (m.type === 'attributes' && m.attributeName === 'class'){
        refreshToggleUI();
        const nowCollapsed = sidebar.classList.contains('collapsed');
        if (nowCollapsed){
          // 收起：不要立刻改高度，等下次展开再恢复自动高度
          unlockOnNextExpand = true;
        } else {
          // 展开：如果需要，恢复自动高度
          // 放到下一帧，避免与展开过程的样式竞争
          requestAnimationFrame(maybeUnlockOnExpand);
        }
      }
    }
  });
  mo.observe(sidebar, { attributes:true });
}

function expandSidebarIfCollapsed(){
  if (!sidebar) return;

  // 新增：窄屏 overlay 模式下，改为调用 overlayOpenSidebar，禁止给主容器加 margin-left
  if (document.documentElement.classList.contains('sidebar-overlay-mode')) {
    if (sidebar.classList.contains('collapsed')) {
      overlayOpenSidebar && overlayOpenSidebar();
    }
    return;
  }

  // 仅桌面模式走原逻辑
  if (isCollapsed){
    sidebar.classList.remove('collapsed');
    if (mainContent) mainContent.style.marginLeft = currentSidebarWidth + 'px';
    isCollapsed = false;
    setTimeout(resizeChart, 300);
    requestAnimationFrame(() => {
      syncTopTabsViewportHeight && syncTopTabsViewportHeight();
      maybeUnlockOnExpand();
    });
    refreshToggleUI();
  }
}

sidebarToggle?.addEventListener('click', ()=>{
  markSidebarToggleClicked();
  if (!sidebar || !mainContent) return;
  if (document.documentElement.classList.contains('sidebar-overlay-mode')) {
    overlayToggleSidebar && overlayToggleSidebar();
    return;
  }
  if (isCollapsed){
    expandSidebarIfCollapsed();
  } else {
    currentSidebarWidth = sidebar.getBoundingClientRect().width;
    sidebar.classList.add('collapsed');
    mainContent.style.marginLeft='0';
    isCollapsed = true;
    // 此处不调用解锁，MutationObserver 已经记录 unlockOnNextExpand
  }
  refreshToggleUI();
});

/* 分隔条：中间把手拖拽（Pointer 统一鼠标+触摸） */
(function initSplitterHandle(){
  if (!splitter) return;

  let handle = document.getElementById('sidebar-splitter-handle');
  if (!handle) {
    handle = document.createElement('button');
    handle.id = 'sidebar-splitter-handle';
    handle.className = 'splitter-handle';
    handle.type = 'button';
    handle.setAttribute('role','separator');
    handle.setAttribute('aria-orientation','horizontal');
    handle.setAttribute('aria-label','拖拽调整上下面板高度');
    splitter.appendChild(handle);
  }

  handle.addEventListener('mousedown', e => e.stopPropagation(), { passive:false });
  handle.addEventListener('touchstart', e => e.stopPropagation(), { passive:false });

  let dragging = false;
  let startY = 0;
  let startTopHeight = 0;
  let maxTop = 0;
  const minTop = 0;

  function measureConstraints(){
    const header = document.getElementById('sidebar-header');
    const sidebarRect = sidebar.getBoundingClientRect();
    const headerH = header ? header.getBoundingClientRect().height : 0;
    const trackHeight = sidebarRect.height - headerH - splitter.offsetHeight;

    const bpContent = bottomPanel?.querySelector('.sidebar-panel-content');
    const bpTitle   = bpContent?.querySelector('h2');
    const footer    = document.getElementById('clearAllContainer');
    const csContent = bpContent ? getComputedStyle(bpContent) : null;

    const titleH    = bpTitle ? Math.ceil(bpTitle.getBoundingClientRect().height) : 0;
    const titleMB   = bpTitle ? parseFloat(getComputedStyle(bpTitle).marginBottom)||0 : 0;
    const contentPT = csContent ? parseFloat(csContent.paddingTop)||0 : 0;
    const footerH   = (footer && !footer.classList.contains('hidden')) ? Math.ceil(footer.getBoundingClientRect().height) : 0;
    const chromeMinBottom = Math.ceil(titleH + titleMB + contentPT + footerH);

    const MIN_BOTTOM_BUSINESS = 0;
    const minBottom = Math.max(MIN_BOTTOM_BUSINESS, chromeMinBottom);

    const _maxTop = Math.max(minTop, trackHeight - minBottom);
    return { headerH, maxTop: _maxTop };
  }

  function onPointerDown(e){
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture?.(e.pointerId);

    // 正确：使用同一个词法变量，锁定自动高度
    userAdjustedVertical = true;

    // 拖拽中标志（关闭过渡 + scheduleAdjust 短路）
    window.__VERT_DRAGGING = true;
    document.body.classList.add('is-vert-dragging');

    const { headerH, maxTop: mt } = measureConstraints();
    maxTop = mt;

    const topH = Math.max(minTop, Math.ceil(topPanel.getBoundingClientRect().height));

    dragging = true;
    startY = e.clientY ?? (e.touches && e.touches[0]?.clientY) ?? 0;
    startTopHeight = topH;

    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';

    function onPointerMove(ev){
      if (!dragging) return;
      const clientY = ev.clientY ?? (ev.touches && ev.touches[0]?.clientY) ?? 0;
      let rawTop = startTopHeight + (clientY - startY);
      rawTop = Math.max(minTop, Math.min(rawTop, maxTop));

      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const snappedTop = (Math.round((headerH + rawTop) * dpr) / dpr) - headerH;

      topPanel.style.height = snappedTop.toFixed(2) + 'px';
      topPanel.style.flex   = '0 0 auto';
      bottomPanel.style.flex = '1 1 auto';
      bottomPanel.style.height = '';

      handle.setAttribute('aria-valuenow', String(Math.round(snappedTop)));
    }

    function end(){
      dragging = false;
      window.__VERT_DRAGGING = false;
      document.body.classList.remove('is-vert-dragging');

      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      window.removeEventListener('pointermove', onPointerMove, { capture:false });
      window.removeEventListener('pointerup',   end,           { capture:false });
      window.removeEventListener('pointercancel', end,         { capture:false });

      // 结束后不触发自动调整；处于“锁定”状态，直到收起并在下次展开时恢复自动高度
    }

    window.addEventListener('pointermove', onPointerMove, { passive:false });
    window.addEventListener('pointerup',   end,           { passive:true  });
    window.addEventListener('pointercancel', end,         { passive:true  });
  }

  handle.addEventListener('pointerdown', onPointerDown, { passive:false });
})();


// === 分隔条“图形轨道”长度计算（把手两侧的条状实体） ===
(function initSplitterRails(){
  const splitter = document.getElementById('sidebar-splitter');
  if (!splitter) return;

  const svg    = splitter.querySelector('svg.splitter-rails');
  const topL   = splitter.querySelector('#sr-top-left');
  const topR   = splitter.querySelector('#sr-top-right');
  const botL   = splitter.querySelector('#sr-bot-left');
  const botR   = splitter.querySelector('#sr-bot-right');

  function updateSplitterRails(){
    if (!splitter || !svg || !topL || !topR || !botL || !botR) return;

    const W = Math.max(0, Math.round(splitter.clientWidth));
    const H = Math.max(0, Math.round(splitter.clientHeight)); // 与 CSS 高度一致（例如 10 或 12）

    const handle = document.getElementById('sidebar-splitter-handle');
    const handleW = Math.max(0, Math.round(handle ? handle.offsetWidth : 72));

    // 把手两侧额外留白；想让线条贴到把手边缘就设为 0
    const GAP_PAD = 0;
    const gapPx = Math.min(W, handleW + 2 * GAP_PAD);

    // 可绘制总长（两侧合计）
    const totalRails = Math.max(0, W - gapPx);

    // 无缝分配：左取 floor，右取剩余，保证 left + right == totalRails
    const leftRail  = Math.floor(totalRails / 2);
    const rightRail = totalRails - leftRail;

    const xLeftStart   = 0;
    const xLeftEnd     = xLeftStart + leftRail;
    const xRightEnd    = W;
    const xRightStart  = xRightEnd - rightRail;

    // 贴顶/底 1px 线（stroke-width=1）
    const yTop = 0.5;
    const yBot = (H || 12) - 0.5;

    // 上边两段
    topL.setAttribute('x1', xLeftStart);  topL.setAttribute('y1', yTop);
    topL.setAttribute('x2', xLeftEnd);    topL.setAttribute('y2', yTop);

    topR.setAttribute('x1', xRightStart); topR.setAttribute('y1', yTop);
    topR.setAttribute('x2', xRightEnd);   topR.setAttribute('y2', yTop);

    // 下边两段
    botL.setAttribute('x1', xLeftStart);  botL.setAttribute('y1', yBot);
    botL.setAttribute('x2', xLeftEnd);    botL.setAttribute('y2', yBot);

    botR.setAttribute('x1', xRightStart); botR.setAttribute('y1', yBot);
    botR.setAttribute('x2', xRightEnd);   botR.setAttribute('y2', yBot);
  }

  function rafUpdate(){ requestAnimationFrame(updateSplitterRails); }
  rafUpdate();
  window.addEventListener('resize', rafUpdate);
  window.updateSplitterRails = updateSplitterRails;
})();


/* 宽度拖拽 */
const SIDEBAR_MIN_W = 260;   // 原 320，按需修改
const SIDEBAR_MAX_W = 700;   // 保持不变或按需调大/调小

if (resizer && sidebar && mainContent){
  let dragging=false, startX=0, startW=0, rafId=null;

  function applyWidth(w){
    sidebar.style.width = w + 'px';
    if (!isCollapsed){
      mainContent.style.marginLeft = w + 'px';
      currentSidebarWidth = w;
      if (typeof window.updateSplitterRails === 'function') window.updateSplitterRails();
    }
  }

  function dragStart(clientX){
    dragging = true;
    startX   = clientX;
    startW   = sidebar.getBoundingClientRect().width;
    document.body.classList.add('resizing-sidebar');
    document.body.classList.add('sidebar-hdragging');  // 新增：关闭过渡
    document.body.style.userSelect = 'none';
  }
  function dragMove(clientX){
    if (!dragging) return;
    const dx = clientX - startX;
    let newW = startW + dx;
    newW = Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, newW));
    if (!rafId){
      rafId = requestAnimationFrame(()=>{
        applyWidth(newW);
        rafId = null;
      });
    }
  }
  function dragEnd(){
    dragging = false;
    document.body.classList.remove('resizing-sidebar');
    document.body.classList.remove('sidebar-hdragging');  // 新增：恢复过渡
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup',   onMouseUp);
    window.removeEventListener('pointermove', onPtrMove);
    window.removeEventListener('pointerup',   onPtrUp);
    window.removeEventListener('pointercancel', onPtrUp);
    setTimeout(resizeChart,120);
    requestAnimationFrame(syncTopTabsViewportHeight);
    scheduleAdjust();
  }

  function onMouseMove(ev){
    if (ev.cancelable) ev.preventDefault();
    dragMove(ev.clientX);
  }
  function onMouseUp(){ dragEnd(); }

  resizer.addEventListener('mousedown', e=>{
    if (isCollapsed) return;
    if (document.documentElement.classList.contains('sidebar-overlay-mode')) return;
    e.preventDefault();
    dragStart(e.clientX);
    document.addEventListener('mousemove', onMouseMove, { passive:false });
    document.addEventListener('mouseup',   onMouseUp,   { passive:true  });
  });

  function onPtrMove(e){
    if (!dragging) return;
    if (e.cancelable) e.preventDefault();
    dragMove(e.clientX);
  }
  function onPtrUp(){ dragEnd(); }

  resizer.addEventListener('pointerdown', e=>{
    if (isCollapsed) return;
    if (document.documentElement.classList.contains('sidebar-overlay-mode')) return;
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
    e.preventDefault();
    // 不强制捕获，保持事件冒泡，避免某些环境只动几像素就“卡住”
    dragStart(e.clientX);
    window.addEventListener('pointermove', onPtrMove,   { passive:false });
    window.addEventListener('pointerup',   onPtrUp,     { passive:true  });
    window.addEventListener('pointercancel', onPtrUp,   { passive:true  });
  });
}

/* =========================================================
   主题切换
   ========================================================= */
const themeToggle = $('#themeToggle');
const themeIcon = $('#themeIcon');
let currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
function setTheme(t){
  const prev = document.documentElement.getAttribute('data-theme');
  if (prev === t) {
    // 只更新图标（初始脚本运行时由 head 脚本已经设置 data-theme）
    if (themeIcon) themeIcon.className = t==='dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
    return;
  }
  document.documentElement.setAttribute('data-theme', t);
  if (themeIcon) themeIcon.className = t==='dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
  localStorage.setItem('theme', t);
  fetch('/api/theme',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({theme:t})}).catch(()=>{});
}
setTheme(currentTheme);

themeToggle?.addEventListener('click', ()=>{
  currentTheme = currentTheme==='light' ? 'dark':'light';
  setTheme(currentTheme);
  window.__APP.dom.all('#selectedFansList .fan-item').forEach(div=>{
    const key = div.getAttribute('data-fan-key');
    const dot = div.querySelector('.js-color-dot');
    if (key && dot) dot.style.backgroundColor = colorForKey(key);
  });
  if (lastChartData) {
    postChartData(lastChartData);
  } else {
     resizeChart();
  }
  requestAnimationFrame(syncTopTabsViewportHeight);
});

/* =========================================================
   已选 & 快速按钮索引 / 状态
   ========================================================= */
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

function buildQuickBtnHTML(addType, brand, model, resType, resLoc){
  const raw = (resLoc ?? '');
  const normResLoc = (String(raw).trim() === '') ? '无' : raw; // 统一“空”->“无”
  const mapKey = `${escapeHtml(brand)}||${escapeHtml(model)}||${escapeHtml(resType)}||${escapeHtml(normResLoc)}`;
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
            data-res-loc="${escapeHtml(normResLoc)}">
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
  const b = unescapeHtml(d.brand||''), m=unescapeHtml(d.model||''), rt=unescapeHtml(d.resType||''), rl=unescapeHtml(d.resLoc||'');
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
    const d = btn.dataset;
    const key = mapKeyFromDataset(d);
    if (selectedMapSet.has(key)) toRemoveState(btn); else toAddState(btn);
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

function rebuildSelectedFans(fans){
  selectedListEl.innerHTML='';
  ensureColorIndicesForSelected(fans||[]);
  if (!fans || fans.length===0){
    selectedCountEl.textContent='0';
    clearAllContainer?.classList.add('hidden');
    rebuildSelectedIndex();
    requestAnimationFrame(window.applySidebarColors);
    requestAnimationFrame(prepareSidebarMarquee);
    scheduleAdjust();
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
  selectedCountEl.textContent = fans.length.toString();
  clearAllContainer?.classList.remove('hidden');
  rebuildSelectedIndex();
  requestAnimationFrame(prepareSidebarMarquee);
  scheduleAdjust();
}

function rebuildRemovedFans(list){
  removedListEl.innerHTML='';
  if (!list || list.length===0){
    removedListEl.innerHTML='<p class="text-gray-500 text-center py-6 empty-removed">暂无最近移除的风扇</p>';
    requestAnimationFrame(prepareSidebarMarquee);
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
  requestAnimationFrame(syncTopTabsViewportHeight);
  requestAnimationFrame(prepareSidebarMarquee);
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
      hideLoading('op'); 
      autoCloseOpLoading();  
    }

  let pendingChart = null;
  if ('chart_data' in data) pendingChart = data.chart_data;

  /* 新增：如果 share_meta 在本次返回，优先处理颜色索引映射 */
  if ('share_meta' in data && data.share_meta) {
    applyServerStatePatchColorIndices(data.share_meta);
  }

  if ('like_keys' in data) likedKeysSet = new Set(data.like_keys||[]);

  if ('selected_fans' in data) {
    const incomingKeys = new Set((data.selected_fans || []).map(f => f.key).filter(Boolean));
    try {
      prevSelectedKeys.forEach(k => { if (!incomingKeys.has(k)) releaseColorIndexForKey(k); });
    } catch(_) {}

    /* 不再在这里“重排”颜色，如果分享携带了 color_indices 则已经写入 colorIndexMap。
       若需要确保唯一仍可调用 assignUniqueIndicesForSelection */
    assignUniqueIndicesForSelection(data.selected_fans);
    rebuildSelectedFans(data.selected_fans);
  }

  if ('recently_removed_fans' in data) rebuildRemovedFans(data.recently_removed_fans);

  if ('share_meta' in data && data.share_meta) {
    pendingShareMeta = {
      show_raw_curves: data.share_meta.show_raw_curves,
      show_fit_curves: data.share_meta.show_fit_curves,
      pointer_x_rpm: data.share_meta.pointer_x_rpm,
      pointer_x_noise_db: data.share_meta.pointer_x_noise_db,
      legend_hidden_keys: data.share_meta.legend_hidden_keys
      // color_indices 已提前处理
    };

    if (__isShareLoaded && !__shareAxisApplied && data.chart_data && data.chart_data.x_axis_type) {
      frontXAxisType = (data.chart_data.x_axis_type === 'noise') ? 'noise_db' : data.chart_data.x_axis_type;
      try { localStorage.setItem('x_axis_type', frontXAxisType); } catch(_){}
      __shareAxisApplied = true;
    }
  }

  if (pendingChart) postChartData(pendingChart);

  syncQuickActionButtons();
  wrapMarqueeForExistingTables();
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
   点赞排行（缓存 + TTL + 后台刷新）
   ========================================================= */
let likesTabLoaded = false;
let likesTabLastLoad = 0;
const LIKES_TTL = 120000;
function needReloadLikes(){
  if (!likesTabLoaded) return true;
  return (Date.now() - likesTabLastLoad) > LIKES_TTL;
}
let _rtPending = false, _rtDebounce = null;

function reloadTopRatings(debounce=true){
  if (debounce){
    if (_rtDebounce) clearTimeout(_rtDebounce);
    return new Promise(resolve=>{ _rtDebounce = setTimeout(()=>resolve(reloadTopRatings(false)), 250); });
  }
  if (_rtPending) return Promise.resolve();
  _rtPending = true;

  const cacheNS = 'top_ratings';
  const payload = {};
  const cached = window.__APP.cache.get(cacheNS, payload);
  if (cached && !needReloadLikes()){
    applyRatingTable(cached);
    _rtPending = false;
    return Promise.resolve();
  }

  const tbody = document.getElementById('ratingRankTbody');
  if (tbody && !likesTabLoaded) tbody.innerHTML='<tr><td colspan="7" class="text-center text-gray-500 py-6">加载中...</td></tr>';

  return fetch('/api/top_ratings')
    .then(r=>r.json())
    .then(data=>{
      if (!data.success){ showError('更新点赞排行失败'); return; }
      window.__APP.cache.set(cacheNS, payload, data, LIKES_TTL);
      applyRatingTable(data);
    })
    .catch(err=> showError('获取点赞排行异常: '+err.message))
    .finally(()=>{ _rtPending=false; });
}

function applyRatingTable(data){
  const list = data.data || [];
  const tbody = document.getElementById('ratingRankTbody');
  if (!tbody) return;
  if (list.length===0){
    tbody.innerHTML='<tr><td colspan="7" class="text-center text-gray-500 py-6">暂无点赞排行数据</td></tr>';
    return;
  }
  let html='';
  list.forEach((r, idx)=>{
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
    html+=`
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
  prepareMarqueeCells(tbody, [1,2,3,4]);
}

function loadLikesIfNeeded(){
  if (!needReloadLikes()) return;
  showLoading('rating-refresh','加载好评榜...');
  reloadTopRatings(false).finally(()=>hideLoading('rating-refresh'));
}

/* =========================================================
   搜索（缓存 + 后台刷新）
   ========================================================= */
const searchForm = $('#searchForm');
const searchAirflowTbody = $('#searchAirflowTbody');
const searchLikesTbody = $('#searchLikesTbody');
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
  prepareMarqueeCells(tbody, [0,1,2,3]);
}

function renderSearchResults(results, conditionLabel){
  SEARCH_RESULTS_RAW = results.slice();
  const byAirflow = SEARCH_RESULTS_RAW;
  const byLikes = SEARCH_RESULTS_RAW.slice().sort((a,b)=>(b.like_count||0)-(a.like_count||0));
  const labelEl = document.getElementById('searchConditionLabel');
  if (labelEl) labelEl.textContent = conditionLabel;
  fillSearchTable(searchAirflowTbody, byAirflow);
  fillSearchTable(searchLikesTbody, byLikes);
  syncQuickActionButtons();
}

if (searchForm){
  searchForm.addEventListener('submit', async e=>{
    e.preventDefault();
    if (!searchForm.reportValidity()) return; // 用原生 min/max/step 校验
    if (needThrottle('search') && !globalThrottle()) return;
    const fd = new FormData(searchForm);
    const payload = {}; fd.forEach((v,k)=>payload[k]=v);
    const cacheNS='search';
    const cached = window.__APP.cache.get(cacheNS, payload);
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
          searchLikesTbody.innerHTML='<tr><td colspan="7" class="text-center text-gray-500 py-6">搜索失败</td></tr>';
          return;
        }
        window.__APP.cache.set(cacheNS, payload, data);
        renderSearchResults(data.search_results, data.condition_label);
        hideLoading('op'); showSuccess('搜索完成');
        document.querySelector('.tab-nav[data-tab-group="right-panel"] .tab-nav-item[data-tab="search-results"]')?.click();
      } catch(err){
        hideLoading('op'); showError('搜索异常: '+err.message);
        searchAirflowTbody.innerHTML='<tr><td colspan="7" class="text-center text-gray-500 py-6">搜索失败</td></tr>';
        searchLikesTbody.innerHTML='<tr><td colspan="7" class="text-center text-gray-500 py-6">搜索失败</td></tr>';
      }
    }

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
  });
}

/* =========================================================
   级联选择
   ========================================================= */
const fanForm = $('#fanForm');
const brandSelect = $('#brandSelect');
const modelSelect = $('#modelSelect');
const resTypeSelect = $('#resTypeSelect');
const resLocSelect = $('#resLocSelect');

if (brandSelect){
  brandSelect.addEventListener('change', ()=>{
    const b = (brandSelect.value || '').trim();

    // 根据是否已选品牌切换占位提示与锁定状态
    modelSelect.innerHTML   = `<option value="">${b ? '-- 选择型号 --' : '-- 请先选择品牌 --'}</option>`;
    modelSelect.disabled    = !b;

    resTypeSelect.innerHTML = `<option value="">${b ? '-- 请先选择型号 --' : '-- 请先选择品牌 --'}</option>`;
    resTypeSelect.disabled  = true;

    resLocSelect.innerHTML  = `<option value="">${b ? '-- 请先选择型号 --' : '-- 请先选择品牌 --'}</option>`;
    resLocSelect.disabled   = true;

    if (!b) return;

    fetch(`/get_models/${encodeURIComponent(b)}`).then(r=>r.json()).then(models=>{
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

    // 型号未选 → 下游显示“请先选择型号”；已选 → 类型可选、位置提示“先选类型”
    resTypeSelect.innerHTML = m
      ? '<option value="">-- 选择风阻类型 --</option><option value="全部">全部</option>'
      : '<option value="">-- 请先选择型号 --</option>';
    resTypeSelect.disabled  = true;

    resLocSelect.innerHTML  = m
      ? '<option value="">-- 请先选择风阻类型 --</option>'
      : '<option value="">-- 请先选择型号 --</option>';
    resLocSelect.disabled   = true;

    if (!b || !m) return;

    fetch(`/get_resistance_types/${encodeURIComponent(b)}/${encodeURIComponent(m)}`).then(r=>r.json()).then(types=>{
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

    // 未选风阻类型 → 位置提示“请先选择风阻类型”
    if (!rt){
      resLocSelect.innerHTML = '<option value="">-- 请先选择风阻类型 --</option>';
      resLocSelect.disabled  = true;
      return;
    }

    // 预设默认占位（位置可选 + “全部”）
    resLocSelect.innerHTML = '<option value="">-- 选择风阻位置 --</option><option value="全部">全部</option>';
    resLocSelect.disabled  = true;

    if (!b || !m || !rt) return;

    // 新增：空载 → 位置锁定为“无”，并禁用下拉
    if (rt === '空载'){
      resLocSelect.innerHTML = '<option value="无" selected>无</option>';
      resLocSelect.disabled = true;
      return;
    }

    // 原逻辑：选择“全部” → 允许位置不筛选
    if (rt === '全部'){ 
      resLocSelect.innerHTML = '<option value="全部" selected>全部</option>';
      resLocSelect.disabled=true; 
      return; 
    }

    // 其它类型 → 拉取具体位置选项
    fetch(`/get_resistance_locations/${encodeURIComponent(b)}/${encodeURIComponent(m)}/${encodeURIComponent(rt)}`).then(r=>r.json()).then(locs=>{
      locs.forEach(l=>{
        const o=document.createElement('option'); o.value=l; o.textContent=l; resLocSelect.appendChild(o);
      });
      resLocSelect.disabled=false;
    });
  });
}

// 首次加载时应用占位提示（不选品牌则显示“请先选择品牌”）
if (brandSelect) {
  brandSelect.dispatchEvent(new Event('change'));
}

/* 型号关键字搜索 */
const modelSearchInput = $('#modelSearchInput');
const searchSuggestions = $('#searchSuggestions');
let modelDebounceTimer;
if (modelSearchInput && searchSuggestions){
  modelSearchInput.addEventListener('input', ()=>{
    clearTimeout(modelDebounceTimer);
    const q = modelSearchInput.value.trim();
    if (q.length < 2){ searchSuggestions.classList.add('hidden'); return; }
    modelDebounceTimer = setTimeout(()=>{
      fetch(`/search_models/${encodeURIComponent(q)}`).then(r=>r.json()).then(list=>{
        searchSuggestions.innerHTML='';
        if (list.length===0){ searchSuggestions.classList.add('hidden'); return; }
        list.forEach(full=>{
          const div=document.createElement('div');
            div.className='cursor-pointer'; div.textContent=full;
            div.addEventListener('click', ()=>{
              const parts = full.split(' ');
              const brand=parts[0]; const model=parts.slice(1).join(' ');
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
      }).catch(()=>searchSuggestions.classList.add('hidden'));
    },280);
  });
  document.addEventListener('click', e=>{
    if (!modelSearchInput.contains(e.target) && !searchSuggestions.contains(e.target)){
      searchSuggestions.classList.add('hidden');
    }
  });
}

/* =========================================================
   点赞 / 快速按钮操作 / 恢复 / 清空
   ========================================================= */

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

  /* 快速删除（按钮状态是 remove) */
  const quickRemove = safeClosest(e.target, '.js-list-remove');
  if (quickRemove){
    const { brand, model, resType, resLoc } = quickRemove.dataset;
    const keyStr = `${unescapeHtml(brand)}||${unescapeHtml(model)}||${unescapeHtml(resType)}||${unescapeHtml(resLoc)}`;
    const targetRow = window.__APP.dom.all('#selectedFansList .fan-item')
      .find(div=>div.getAttribute('data-map') === keyStr);
    if (!targetRow){ showInfo('该数据已不在图表中'); syncQuickActionButtons(); return; }
    const key = targetRow.getAttribute('data-fan-key');
    if (!key){ showError('未找到可移除的条目'); return; }
    showLoading('op','移除中...');
    try {
      const data = await apiPost('/api/remove_fan',{ fan_key:key });
      processState(data,'已移除');
      scheduleAdjust();
    } catch(err){ hideLoading('op'); showError('移除失败: '+err.message); }
    return;
  }

  /* 快速添加 (ranking/search/rating/likes) */
  const picker = ['.js-ranking-add','.js-search-add','.js-rating-add','.js-likes-add'];
  for (const sel of picker){
    // 原有委托监听内：
    // ...
    const btn = safeClosest(e.target, sel);
    if (btn){
      const key = mapKeyFromDataset(btn.dataset);
      if (selectedMapSet.has(key)){ showInfo('该数据已添加'); syncQuickActionButtons(); return; }
      if (!ensureCanAdd()) return;
      showLoading('op','添加中...');
      try {
        const { brand, model, resType, resLoc } = btn.dataset;
        const rl = unescapeHtml(resLoc);
        const resLocToSend = (rl === '无') ? '' : rl;  // 空值 -> ''
        const data = await apiPost('/api/add_fan',{
          brand: unescapeHtml(brand),
          model: unescapeHtml(model),
          res_type: unescapeHtml(resType),
          res_loc: resLocToSend
        });
        processState(data,'添加成功');
        scheduleAdjust();
        if (data && data.success) maybeAutoOpenSidebarOnAdd();
      } catch(err){ hideLoading('op'); showError('添加失败: '+err.message); }
      return;
    }
  }

  /* 从已选列表移除 */
  const removeBtn = safeClosest(e.target, '.js-remove-fan');
  if (removeBtn){
    showLoading('op','移除中...');
    try {
      const data = await apiPost('/api/remove_fan',{ fan_key: removeBtn.dataset.fanKey });
      processState(data,'已移除');
      scheduleAdjust();
    } catch(err){ hideLoading('op'); showError('移除失败: '+err.message); }
    return;
  }

  /* 恢复 */
  const restoreBtn = safeClosest(e.target,'.js-restore-fan');
  if (restoreBtn){
    const fanKey = restoreBtn.dataset.fanKey;
    if (selectedKeySet.has(fanKey)){
      const row = restoreBtn.closest('.fan-item');
      if (row) row.remove();
      showInfo('该数据已在图表中，已从最近移除列表移除');
      return;
    }
    showLoading('op','恢复中...');
    try {
      const data = await apiPost('/api/restore_fan',{ fan_key: fanKey });
      processState(data,'已恢复');
      scheduleAdjust();
    } catch(err){ hideLoading('op'); showError('恢复失败: '+err.message); }
    return;
  }

  /* 清空确认交互 */
  if (e.target.id === 'clearAllBtn'){
    const state = e.target.getAttribute('data-state') || 'normal';
    if (state === 'normal'){
      clearAllBtn.setAttribute('data-state','confirming');
      clearAllBtn.innerHTML = `
        <div class="clear-confirm-wrapper">
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
      const data = await apiPost('/api/clear_all',{});
      processState(data,'已全部移除');
    } catch(err){ hideLoading('op'); showError('清空失败: '+err.message); }
    finally {
      clearAllBtn.setAttribute('data-state','normal');
      clearAllBtn.textContent='移除所有';
      scheduleAdjust();
    }
    return;
  }
});

/* =========================================================
   添加表单提交
   ========================================================= */
if (fanForm){
  fanForm.addEventListener('submit', async e=>{
    e.preventDefault();
    const brand = brandSelect.value.trim();
    const model = modelSelect.value.trim();
    const res_type = resTypeSelect.value.trim();
    let res_loc = resLocSelect.value.trim();

    if (!brand || !model){ showError('请先选择品牌与型号'); return; }
    if (!res_type){ showError('请选择风阻类型'); return; }

    // 空载：固定使用“无”
    if (res_type === '空载') {
      res_loc = '无';
    }

    if (!res_loc) res_loc='全部'; // 非空载场景仍允许“全部”表示不筛位置

    // 既不是类型=全部，也不是位置=全部 才做精确重复校验
    if (res_type !== '全部' && res_loc !== '全部'){
      const mapKey = `${brand}||${model}||${res_type}||${res_loc}`;
      if (selectedMapSet.has(mapKey)){ showInfo('该数据已添加'); return; }
    }

    if (!ensureCanAdd()) return;
    showLoading('op','添加中...');
    try {
      // 提交前把“无”转成空串，后端据此做空值筛选
      const res_loc_payload = (res_loc === '无') ? '' : res_loc;
      const data = await apiPost('/api/add_fan',{ brand, model, res_type, res_loc: res_loc_payload });
      processState(data, data.error_message?'':'添加成功');
      scheduleAdjust();
      if (data && data.success) maybeAutoOpenSidebarOnAdd();
    } catch(err){ hideLoading('op'); showError('添加失败: '+err.message); }
  });
}

/* =========================================================
   选中数量与上限判断
   ========================================================= */
const MAX_ITEMS = Number(window.APP_CONFIG.maxItems || 0);
function currentSelectedCount(){
  return selectedKeySet.size || parseInt(selectedCountEl?.textContent||'0',10);
}
function ensureCanAdd(countToAdd=1){
  if (!MAX_ITEMS) return true;
  const curr = currentSelectedCount();
  if (curr + countToAdd > MAX_ITEMS){ showInfo(`已达上限（${MAX_ITEMS})`); return false; }
  return true;
}


/* =========================================================
   表格跑马灯（右侧 & 侧栏）
   ========================================================= */
function prepareMarqueeCells(tbody, indexes){
  if (!tbody) return;
  const rows = Array.from(tbody.querySelectorAll('tr'));
  rows.forEach(tr=>{
    const cells = Array.from(tr.children);
    indexes.forEach(i=>{
      const td = cells[i];
      if (!td) return;
      if (!td.classList.contains('marquee-cell')){
        td.classList.add('marquee-cell','nowrap');
        const inner = document.createElement('span');
        inner.className='marquee-inner';
        inner.innerHTML=td.innerHTML;
        td.innerHTML='';
        td.appendChild(inner);
      }
    });
  });
}
function wrapMarqueeForExistingTables(){
  const queriesTbody = document.querySelector('#queries-panel tbody');
  if (queriesTbody) prepareMarqueeCells(queriesTbody,[1,2,3,4]);
  if (searchAirflowTbody?.children.length>0) prepareMarqueeCells(searchAirflowTbody,[0,1,2,3]);
  if (searchLikesTbody?.children.length>0) prepareMarqueeCells(searchLikesTbody,[0,1,2,3]);
}
function startRowMarquee(tr){
  const speed=60;
  tr.querySelectorAll('.marquee-cell .marquee-inner').forEach(inner=>{
    const td = inner.parentElement;
    const delta = inner.scrollWidth - td.clientWidth;
    if (delta > 6){
      const duration = (delta / speed).toFixed(2);
      inner.style.transition = `transform ${duration}s linear`;
      inner.style.transform = `translateX(-${delta}px)`;
    }
  });
}
function stopRowMarquee(tr){
  tr.querySelectorAll('.marquee-cell .marquee-inner').forEach(inner=>{
    inner.style.transition='transform .35s ease';
    inner.style.transform='translateX(0)';
  });
}
document.addEventListener('mouseenter',(e)=>{
  const tr = safeClosest(e.target, '#right-panel-wrapper .ranking-table tbody tr');
  if (!tr) return;
  startRowMarquee(tr);
}, true);
document.addEventListener('mouseleave',(e)=>{
  const tr = safeClosest(e.target, '#right-panel-wrapper .ranking-table tbody tr');
  if (!tr) return;
  stopRowMarquee(tr);
}, true);

/* 侧栏行跑马灯 */
function prepareSidebarMarquee(){
  window.__APP.dom.all('#sidebar .fan-item .truncate').forEach(container=>{
    if (container.querySelector('.sidebar-marquee-inner')) return;
    const inner = document.createElement('span');
    inner.className='sidebar-marquee-inner';
    inner.innerHTML = container.innerHTML;
    container.innerHTML='';
    container.appendChild(inner);
  });
}
prepareSidebarMarquee();
const SIDEBAR_SCROLL_SPEED=60;
function startSidebarMarquee(row){
  const container = row.querySelector('.truncate');
  const inner = row.querySelector('.sidebar-marquee-inner');
  if (!container || !inner) return;
  const delta = inner.scrollWidth - container.clientWidth;
  if (delta > 6){
    const duration = (delta / SIDEBAR_SCROLL_SPEED).toFixed(2);
    inner.style.transition=`transform ${duration}s linear`;
    inner.style.transform=`translateX(-${delta}px)`;
  }
}
function stopSidebarMarquee(row){
  const inner = row.querySelector('.sidebar-marquee-inner');
  if (!inner) return;
  inner.style.transition='transform .35s ease';
  inner.style.transform='translateX(0)';
}
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


// 新增：最近点赞场景行的跑马灯（与侧栏/表格分开，互不影响）
function prepareRecentLikesMarquee(){
  document.querySelectorAll('#recentLikesList .scenario-row .scenario-text').forEach(container=>{
    if (container.querySelector('.recent-marquee-inner')) return;
    const inner = document.createElement('span');
    inner.className = 'recent-marquee-inner';
    inner.textContent = container.textContent;
    container.textContent = '';
    container.appendChild(inner);
  });
}

const RECENT_LIKES_SCROLL_SPEED = 60; // px/s，与其它区块一致

function startRecentLikesMarquee(row){
  const container = row.querySelector('.scenario-text');
  const inner = row.querySelector('.recent-marquee-inner');
  if (!container || !inner) return;
  const delta = inner.scrollWidth - container.clientWidth;
  if (delta > 6){
    const duration = (delta / RECENT_LIKES_SCROLL_SPEED).toFixed(2);
    inner.style.transition = `transform ${duration}s linear`;
    inner.style.transform  = `translateX(-${delta}px)`;
  }
}
function stopRecentLikesMarquee(row){
  const inner = row.querySelector('.recent-marquee-inner');
  if (!inner) return;
  inner.style.transition = 'transform .35s ease';
  inner.style.transform  = 'translateX(0)';
}

// 委托监听：进入行开始左移，离开行复位
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
   底部面板自动高度（节流后的 scheduleAdjust 驱动）
   ========================================================= */
(function(){
  const CFG = { MIN_BOTTOM_PX:140, MAX_RATIO:0.72, MIN_TOP_SPACE_PX:260 };
  const px = (v)=>Number.parseFloat(v)||0;
  const hRect = (el)=> (el ? Math.ceil(el.getBoundingClientRect().height):0);
  const isHidden = (el)=>!el || el.classList.contains('hidden');

  function computeDesiredBottomHeight(){
    const bottom = document.getElementById('bottom-panel');
    const content = bottom?.querySelector('.sidebar-panel-content');
    const title = content?.querySelector('h2');
    const list = document.getElementById('selectedFansList');
    const footer = document.getElementById('clearAllContainer');
    const winH = window.innerHeight;
    const titleH = hRect(title);
    const titleMB = title ? px(getComputedStyle(title).marginBottom):0;
    const contentPT = content ? px(getComputedStyle(content).paddingTop):0;
    const footerH = !isHidden(footer)? hRect(footer):0;

    let rows=0,rowH=56,gapY=0,listPT=0,listPB=0;
    if (list){
      const items = list.querySelectorAll('.fan-item');
      rows = items.length;
      if (rows>0){
        rowH = hRect(items[0]);
        if (rows>1) gapY = px(getComputedStyle(items[1]).marginTop);
      }
      const ls = getComputedStyle(list);
      listPT = px(ls.paddingTop); listPB = px(ls.paddingBottom);
    }
    const listContentH = rows>0 ? rows*rowH + Math.max(0,rows-1)*gapY + listPT + listPB : 0;
    const chromeH = contentPT + titleH + titleMB + footerH;

    const maxBottomByRatio = winH * CFG.MAX_RATIO;
    const maxBottomByTopReserve = winH - CFG.MIN_TOP_SPACE_PX;
    const maxBottom = Math.max(CFG.MIN_BOTTOM_PX, Math.min(maxBottomByRatio, maxBottomByTopReserve));

    const maxListViewport = Math.max(0, maxBottom - chromeH);
    const listViewportH = Math.min(listContentH, maxListViewport);
    const ideal = chromeH + listViewportH;
    const desired = Math.max(Math.min(ideal, maxBottom), Math.min(CFG.MIN_BOTTOM_PX, maxBottom));
    return Math.round(desired);
  }

  window.adjustBottomPanelAuto = function adjustBottomPanelAuto(){
    try { if (typeof userAdjustedVertical !== 'undefined' && userAdjustedVertical) return; } catch {}
    const bottomPanel = document.getElementById('bottom-panel');
    const topPanel = document.getElementById('top-panel');
    if (!bottomPanel || !topPanel) return;
    const h = computeDesiredBottomHeight();
    bottomPanel.style.flex = `0 0 ${h}px`;
    topPanel.style.flex ='1 1 auto';
    requestAnimationFrame(()=> {
      if (typeof syncTopTabsViewportHeight === 'function') syncTopTabsViewportHeight();
    });
  };

  (function(){
    const list = document.getElementById('selectedFansList');
    if (list && 'ResizeObserver' in window){
      const ro = new ResizeObserver(()=>{
        try { if (typeof userAdjustedVertical !== 'undefined' && userAdjustedVertical) return; } catch(_){}
        scheduleAdjust();
      });
      ro.observe(list);
    }
  })();

  const footer = document.getElementById('clearAllContainer');
  if (footer && 'ResizeObserver' in window){
    const ro = new ResizeObserver(()=>{
      if (typeof userAdjustedVertical !== 'undefined' && userAdjustedVertical) return;
      requestAnimationFrame(()=>window.adjustBottomPanelAuto());
    });
    ro.observe(footer);
  }
  window.addEventListener('resize', ()=>{
    if (typeof userAdjustedVertical !== 'undefined' && userAdjustedVertical) return;
    requestAnimationFrame(()=>window.adjustBottomPanelAuto());
  });
})();

/* =========================================================
   Segment 切换（查询榜 / 好评榜 + 搜索子段）
   ========================================================= */
document.addEventListener('click',(e)=>{
  const btn = safeClosest(e.target,'.seg-btn');
  if (!btn) return;
  const seg = btn.closest('.seg'); if (!seg) return;
  const targetId = btn.dataset.target;
  seg.querySelectorAll('.seg-btn').forEach(b=>b.classList.toggle('is-active', b===btn));
  seg.setAttribute('data-active', targetId);
  const paneId = seg.dataset.paneId;
  const pane = paneId ? document.getElementById(paneId):null;
  if (pane) pane.querySelectorAll('.rank-panel').forEach(p=>p.classList.toggle('active', p.id===targetId));
  if (targetId === 'likes-panel') loadLikesIfNeeded();
});

(function initRightSegSwitchLikeXAxis() {
  const segs = document.querySelectorAll('#rightSubsegContainer .seg');
  if (!segs.length) return;

  segs.forEach(seg => {
    const thumb = seg.querySelector('.seg-thumb');
    const btns = seg.querySelectorAll('.seg-btn');
    if (!thumb || btns.length !== 2) return;

    let dragging = false;
    let startX = 0;
    let basePercent = 0; // 0 或 100（起始在左/右）
    let lastPercent = 0;

    function activeIsRight() {
      const act = seg.getAttribute('data-active') || '';
      // 两个控件的右侧目标都以 likes-panel 结尾：likes-panel / search-likes-panel
      return act.endsWith('likes-panel');
    }

    function pointInThumb(clientX, clientY) {
      const r = thumb.getBoundingClientRect();
      return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
    }

    function start(e) {
      const cx = (e.touches ? e.touches[0].clientX : e.clientX) || 0;
      const cy = (e.touches ? e.touches[0].clientY : e.clientY) || 0;
      // 仅当起点在 thumb 区域内才进入拖拽
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
      const w = thumb.getBoundingClientRect().width || 1; // translateX(%) 以自身宽度为基
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

      // 清理内联样式，交给现有 CSS 根据 data-active 定位
      thumb.style.transition = '';
      thumb.style.transform = '';

      // 触发按钮 click，复用现有切换/懒加载/ARIA 逻辑
      targetBtn.click();
    }

    // 改为在 seg 容器上接收起始事件，避免被按钮挡住
    seg.addEventListener('mousedown', start);
    document.addEventListener('mousemove', move, { passive: false });
    document.addEventListener('mouseup', end);

    seg.addEventListener('touchstart', start, { passive: false });
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('touchend', end);
  });
})();

/* =========================================================
   scheduleAdjust (P0-3 节流版)
   ========================================================= */
let _adjustQueued = false;
function scheduleAdjust(){
  // 拖拽过程中或用户已手动锁定时都跳过
  if (window.__VERT_DRAGGING) return;
  if (userAdjustedVertical)   return;
  if (_adjustQueued) return;
  _adjustQueued = true;
  requestAnimationFrame(()=>{
    _adjustQueued = false;
    window.adjustBottomPanelAuto && window.adjustBottomPanelAuto();
  });
}

/* =========================================================
   初始数据获取
   ========================================================= */
fetch('/api/state')
  .then(r=>r.json())
  .then(d=>processState(d,''))
  .catch(()=>{});

/* 初始右侧子段显示状态 */
updateRightSubseg(localStorage.getItem('activeTab_right-panel') || 'top-queries');

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

/* =========================================================
   添加表单选项提交后补充
   ========================================================= */
function scheduleInitListPadding(){
  const list = document.querySelector('#selectedFansList');
  if (list) list.style.paddingBottom='var(--content-bottom-gap)';
}
scheduleInitListPadding();

/* 图表窗口 Resize */
window.addEventListener('resize', ()=> { if (!isCollapsed) resizeChart(); });

/* =========================================================
   顶部 Scroll Snap 分页（仅处理存储/回滚）
   ========================================================= */
   (function initSidebarTopSnap(){
  const container = document.getElementById('sidebar-top-container');
  const nav = document.querySelector('.tab-nav[data-tab-group="sidebar-top"]');
  if (!container || !nav) return;

  const tabs = Array.from(nav.querySelectorAll('.tab-nav-item'));

  function go(idx){
    const w = container.clientWidth;
    container.scrollTo({ left: w * idx, behavior: 'smooth' });
  }

  nav.addEventListener('click', e => {
    const item = e.target.closest('.tab-nav-item');
    if (!item) return;
    const idx = tabs.indexOf(item);
    if (idx < 0) return;
    go(idx);
    tabs.forEach((t,i)=>t.classList.toggle('active', i===idx));
    localStorage.setItem('activeTab_sidebar-top', item.dataset.tab);
  });

  container.addEventListener('scroll', () => {
    clearTimeout(container._snapTimer);
    container._snapTimer = setTimeout(() => {
      const w = container.clientWidth || 1;
      const idx = Math.round(container.scrollLeft / w);
      tabs.forEach((t,i)=>t.classList.toggle('active', i===idx));
    }, 80);
  });

  // 初始定位
  const saved = localStorage.getItem('activeTab_sidebar-top');
  let idx = 0;
  if (saved) {
    const found = tabs.findIndex(t => t.dataset.tab === saved);
    if (found >= 0) idx = found;
  }
  requestAnimationFrame(() => {
    container.scrollLeft = container.clientWidth * idx;
    tabs.forEach((t,i)=>t.classList.toggle('active', i===idx));
  });
})();

(function initLeftPanelSnap() {
  const container = document.getElementById('left-panel-container');
  const nav = document.querySelector('.tab-nav[data-tab-group="left-panel"]');
  if (!container || !nav) return;

  const tabs = Array.from(nav.querySelectorAll('.tab-nav-item'));

  function go(idx) {
    const w = container.clientWidth || 1;
    container.scrollTo({ left: w * idx, behavior: 'smooth' });
  }

  // 点击页签 -> 滑动到对应页
  nav.addEventListener('click', e => {
    const item = e.target.closest('.tab-nav-item');
    if (!item) return;
    const idx = tabs.indexOf(item);
    if (idx < 0) return;
    go(idx);
    tabs.forEach((t, i) => t.classList.toggle('active', i === idx));
    localStorage.setItem('activeTab_left-panel', item.dataset.tab);
  });

  // 滑动时根据 scrollLeft 同步激活态与记忆
  container.addEventListener('scroll', () => {
    clearTimeout(container._snapTimer);
    container._snapTimer = setTimeout(() => {
      const w = container.clientWidth || 1;
      const idx = Math.round(container.scrollLeft / w);
      tabs.forEach((t, i) => t.classList.toggle('active', i === idx));
      const activeTab = tabs[idx]?.dataset.tab;
      if (activeTab) localStorage.setItem('activeTab_left-panel', activeTab);
    }, 80);
  });

  // 初始定位到上次的页签
  const saved = localStorage.getItem('activeTab_left-panel');
  let idx = 0;
  if (saved) {
    const found = tabs.findIndex(t => t.dataset.tab === saved);
    if (found >= 0) idx = found;
  }
  requestAnimationFrame(() => {
    container.scrollLeft = container.clientWidth * idx;
    tabs.forEach((t, i) => t.classList.toggle('active', i === idx));
  });
})();

(function initTopSnapLazyLoadOnScroll(){
  const container = document.getElementById('sidebar-top-container');
  const nav = document.querySelector('.tab-nav[data-tab-group="sidebar-top"]');
  if (!container || !nav) return;

  const tabs = Array.from(nav.querySelectorAll('.tab-nav-item'));
  const tabNameByIndex = i => tabs[i]?.dataset.tab;
  let debounceTimer = null;

  function finalize() {
    const w = container.clientWidth || 1;
    const idx = Math.round(container.scrollLeft / w);
    const tabName = tabNameByIndex(idx);
    if (tabName === 'recent-liked' && typeof loadRecentLikesIfNeeded === 'function') {
      loadRecentLikesIfNeeded();
    }
  }

  container.addEventListener('scroll', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(finalize, 90);
  });

  requestAnimationFrame(() => finalize());
})();

/* ==== P2-8 A11y: 焦点陷阱工具 ==== */
const a11yFocusTrap = (function(){
  let container = null;
  let lastFocused = null;
  let bound = false;

  function focusableElements(root){
    return Array.from(root.querySelectorAll(
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
    )).filter(el => el.offsetParent !== null);
  }

  function handleKey(e){
    if (e.key !== 'Tab') return;
    if (!container) return;
    const list = focusableElements(container);
    if (!list.length) {
      e.preventDefault();
      container.focus();
      return;
    }
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  return {
    activate(root){
      if (!root) return;
      container = root;
      lastFocused = document.activeElement;
      const list = focusableElements(root);
      (list[0] || root).focus({ preventScroll:true });
      if (!bound){
        document.addEventListener('keydown', handleKey, true);
        bound = true;
      }
    },
    deactivate(){
      if (bound){
        document.removeEventListener('keydown', handleKey, true);
        bound = false;
      }
      if (lastFocused && typeof lastFocused.focus === 'function') {
        lastFocused.focus({ preventScroll:true });
      }
      container = null;
      lastFocused = null;
    }
  };
})();

/* ==== P2-8 A11y: Tabs / Segmented 控件 ARIA + 键盘导航 ==== */
(function initA11yTabs(){
  const TAB_GROUP_SELECTOR = '.tab-nav[data-tab-group]';
  const SEG_SELECTOR = '.seg[data-active]';

  function upgradeTabGroup(nav){
    if (nav.getAttribute('role') === 'tablist') return;
    nav.setAttribute('role','tablist');
    const group = nav.dataset.tabGroup || '';
    const items = Array.from(nav.querySelectorAll('.tab-nav-item'));
    items.forEach((item, idx) => {
      const tabId = item.id || (`tab-${group}-${idx}`);
      item.id = tabId;
      item.setAttribute('role','tab');
      // 关联面板（如果面板在 DOM 中具有 tab 名称）
      const panelName = item.dataset.tab;
      const panel = document.getElementById(`${panelName}-pane`) || document.getElementById(`${panelName}-panel`);
      if (panel) {
        const panelId = panel.id;
        item.setAttribute('aria-controls', panelId);
        panel.setAttribute('role','tabpanel');
        panel.setAttribute('aria-labelledby', tabId);
      }
      item.setAttribute('tabindex', item.classList.contains('active') ? '0':'-1');
      item.setAttribute('aria-selected', item.classList.contains('active') ? 'true':'false');
    });
  }

  function syncActive(nav){
    const items = Array.from(nav.querySelectorAll('.tab-nav-item'));
    items.forEach(it => {
      const active = it.classList.contains('active');
      it.setAttribute('tabindex', active ? '0':'-1');
      it.setAttribute('aria-selected', active ? 'true':'false');
    });
  }

  function handleKey(e){
    const item = e.target.closest('.tab-nav-item[role="tab"]');
    if (!item) return;
    const nav = item.closest('[role="tablist"]');
    if (!nav) return;
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;

    const items = Array.from(nav.querySelectorAll('.tab-nav-item[role="tab"]'));
    const currentIndex = items.indexOf(item);
    let nextIndex = currentIndex;
    if (e.key === 'ArrowRight') nextIndex = (currentIndex + 1) % items.length;
    else if (e.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + items.length) % items.length;
    else if (e.key === 'Home') nextIndex = 0;
    else if (e.key === 'End') nextIndex = items.length - 1;

    if (nextIndex !== currentIndex) {
      e.preventDefault();
      items[nextIndex].click();   // 复用现有 click 逻辑
      items[nextIndex].focus();
      syncActive(nav);
    }
  }

  // 初始升级
  document.querySelectorAll(TAB_GROUP_SELECTOR).forEach(upgradeTabGroup);
  // 监听点击后同步 ARIA
  document.addEventListener('click', e=>{
    const item = e.target.closest('.tab-nav-item');
    if (!item) return;
    const nav = item.closest(TAB_GROUP_SELECTOR);
    if (nav) syncActive(nav);
  });
  document.addEventListener('keydown', handleKey);

  /* Segmented 控件（.seg）辅助角色 */
  document.querySelectorAll(SEG_SELECTOR).forEach(seg=>{
    if (!seg.querySelector('.seg-btn')) return;
    if (!seg.hasAttribute('role')) seg.setAttribute('role','tablist');
    const btns = Array.from(seg.querySelectorAll('.seg-btn'));
    btns.forEach((b,i)=>{
      b.setAttribute('role','tab');
      b.setAttribute('tabindex', b.classList.contains('is-active') ? '0':'-1');
      b.setAttribute('aria-selected', b.classList.contains('is-active') ? 'true':'false');
      const id = b.id || `seg-${Math.random().toString(36).slice(2)}`;
      b.id = id;
    });
    seg.addEventListener('click', ()=> {
      btns.forEach(b=>{
        const act = b.classList.contains('is-active');
        b.setAttribute('tabindex', act ? '0':'-1');
        b.setAttribute('aria-selected', act ? 'true':'false');
      });
    });
    seg.addEventListener('keydown', e=>{
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
      const activeIndex = btns.findIndex(b=>b.classList.contains('is-active'));
      let idx = activeIndex;
      if (e.key === 'ArrowRight') idx = (activeIndex + 1) % btns.length;
      else if (e.key === 'ArrowLeft') idx = (activeIndex - 1 + btns.length) % btns.length;
      else if (e.key === 'Home') idx = 0;
      else if (e.key === 'End') idx = btns.length - 1;
      if (idx !== activeIndex) {
        e.preventDefault();
        btns[idx].click();
        btns[idx].focus();
      }
    });
  });
})();

/* ==== P1-6 模块注册（最小骨架） ==== */
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
    adjustBottomAuto: window.adjustBottomPanelAuto
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

  (function setRealScrollbarWidth(){
    function measure(){
      try{
        const box = document.createElement('div');
        box.style.cssText = 'position:absolute;top:-9999px;left:-9999px;width:120px;height:120px;overflow:scroll;visibility:hidden;';
        document.body.appendChild(box);
        const sbw = Math.max(0, box.offsetWidth - box.clientWidth) || 0; // 覆盖式滚动条返回 0
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
    // 某些安卓设备横竖屏/窗口变化时滚动条表现会变，延迟重测更稳
    const remeasure = () => setTimeout(measure, 60);
    window.addEventListener('orientationchange', remeasure);
    window.addEventListener('resize', remeasure);
  })();

  (function initSortValueUnlockMinimal() {
  const select = document.getElementById('sortBySelect');   // none | rpm | noise
  const input  = document.getElementById('sortValueInput'); // body 已统一 min/max/step
  if (!select || !input) return;

  function apply() {
    const none = (select.value === 'none');
    input.disabled = none;
    if (none) input.value = '';
  }

  select.addEventListener('change', apply);
  apply(); // 首次同步服务端初始状态
})();

  // 获取查询次数
  function loadQueryCount() {
      fetch('/api/query_count')
          .then(response => response.json())
          .then(data => {
              document.getElementById('query-count').textContent = data.count;
          })
          .catch(error => {
              console.error('获取查询次数失败:', error);
          });
  }
  
  // 页面加载时执行
  document.addEventListener('DOMContentLoaded', loadQueryCount);

  function applyRecentLikesTitleMask() {
    const groups = document.querySelectorAll('#recentLikesList .recent-like-group');
    groups.forEach(g => {
      const titleWrap = g.querySelector('.group-header .title-wrap');
      const titleBox  = titleWrap?.querySelector('.truncate');
      if (!titleWrap || !titleBox) return;
      // 可见标题宽度（容器宽度即为可见宽度，因溢出被裁切）
      const w = Math.max(0, Math.ceil(titleBox.getBoundingClientRect().width));
      titleWrap.style.setProperty('--title-w', w + 'px');
      // 如需调渐隐长度：
      // titleWrap.style.setProperty('--fade-w', '28px');
    });
  }
  
  /* 在 rebuildRecentLikes 渲染后执行一次测量 */
  if (typeof window.rebuildRecentLikes === 'function' && !window.__RECENT_TITLE_MASK_PATCHED__) {
    window.__RECENT_TITLE_MASK_PATCHED__ = true;
    const _orig = window.rebuildRecentLikes;
    window.rebuildRecentLikes = function(list){
      _orig(list);
      requestAnimationFrame(applyRecentLikesTitleMask);
    };
  }
  
  /* 侧栏尺寸变化时重算（轻微防抖） */
  let __titleMaskRaf = null;
  window.addEventListener('resize', () => {
    if (__titleMaskRaf) cancelAnimationFrame(__titleMaskRaf);
    __titleMaskRaf = requestAnimationFrame(applyRecentLikesTitleMask);
  });

  window.addEventListener('message', (e) => {
    if (e.origin !== window.location.origin) return;
    const { type, payload } = e.data || {};

    if (type === 'chart:ready') {
      chartFrameReady = true;
      flushChartQueue();
      // 若队列为空但已有 lastChartData（例如 ready 之前没有触发过 postChartData），补发一次
      if (lastChartData && !chartMessageQueue.length){
        postChartData(lastChartData);
      }
      return;
    }

    if (type === 'chart:xaxis-type-changed') {
      const next = (payload?.x_axis_type === 'noise') ? 'noise_db' : (payload?.x_axis_type || 'rpm');
      if (next !== frontXAxisType) {
        frontXAxisType = next;
        try { localStorage.setItem('x_axis_type', frontXAxisType); } catch(_) {}
        if (lastChartData) postChartData(lastChartData);
      }
    }
  });

    // === 新增：记录用户是否点击过侧栏按钮（本地标记） ===
    const LS_KEY_SIDEBAR_TOGGLE_CLICKED = 'sidebar_toggle_clicked';
    function markSidebarToggleClicked(){
      try { localStorage.setItem(LS_KEY_SIDEBAR_TOGGLE_CLICKED, '1'); } catch(_) {}
    }
    function userHasClickedSidebarToggle(){
      try { return localStorage.getItem(LS_KEY_SIDEBAR_TOGGLE_CLICKED) === '1'; } catch(_) { return false; }
    }
    // 当用户未点击过侧栏按钮且发生“添加成功”时，才自动弹出侧栏
    function maybeAutoOpenSidebarOnAdd(){
      if (userHasClickedSidebarToggle()) return;
      expandSidebarIfCollapsed();
    }

    (function initVisitStartMinimal(){
      // 同一标签页只上报一次（刷新不重复）
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

    (function initScenarioCascading(){
      const form = document.getElementById('searchForm');
      if (!form) return;
      const typeSel = form.querySelector('select[name="search_res_type"]');
      const locSel  = form.querySelector('select[name="search_res_loc"]');
        
      if (!typeSel || !locSel) return;
        
      function setLocOptions(options, enable){
        const prev = locSel.value;
        // enable=false 时提示“请先选择风阻类型”
        locSel.innerHTML = enable
          ? '<option value="">-- 选择风阻位置 --</option>'
          : '<option value="">-- 请先选择风阻类型 --</option>';
      
        (options || []).forEach(v=>{
          const o = document.createElement('option');
          o.value = v; o.textContent = v;
          locSel.appendChild(o);
        });
      
        if (enable && prev && options && options.includes(prev)) {
          locSel.value = prev;
        } else if (!enable) {
          locSel.value = '';
        }
        locSel.disabled = !enable;
      }
    
      async function refreshLocByType(rt){
        if (!rt){
          setLocOptions([], false);
          return;
        }
        if (rt === '空载'){
          locSel.innerHTML = '<option value="无" selected>无</option>';
          locSel.disabled = true;
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
    
      // 初始：明确设置占位并锁定，然后按已选类型加载
      locSel.innerHTML = '<option value="">-- 请先选择风阻类型 --</option>';
      locSel.disabled = true;
      refreshLocByType((typeSel.value || '').trim());
    
      typeSel.addEventListener('change', ()=>{
        const rt = (typeSel.value || '').trim();
        refreshLocByType(rt);
      });
    })();

  /* === Global Tooltip（避开 overflow 裁切 + 主题适配） === */
  (function initGlobalTooltip(){
    const MARGIN = 8; // 视口边缘最小间距
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

      // 先让 tooltip 可见于屏外测量尺寸
      t.style.visibility = 'hidden';
      t.dataset.show = '1';
      t.style.left = '-9999px';
      t.style.top  = '-9999px';

      const tw = t.offsetWidth, th = t.offsetHeight;

      // 选择上下位置：优先 top，放不下则 bottom
      let placement = preferred;
      const topSpace = rect.top;
      const bottomSpace = vh - rect.bottom;
      if (preferred === 'top' && topSpace < th + 12) placement = 'bottom';
      if (preferred === 'bottom' && bottomSpace < th + 12) placement = 'top';

      // 水平居中锚点，同时防止越界
      let cx = rect.left + rect.width / 2;
      cx = Math.max(MARGIN + tw/2, Math.min(vw - MARGIN - tw/2, cx));

      // 垂直位置
      let top;
      if (placement === 'top') {
        top = rect.top - th - 10; // 与锚点间隔
      } else {
        top = rect.bottom + 10;
      }

      // 应用
      t.dataset.placement = placement;
      t.style.left = `${Math.round(cx)}px`;
      t.style.top  = `${Math.round(top)}px`;
      t.style.visibility = '';
    }

    function show(anchor){
      clearTimeout(hideTimer);
      currAnchor = anchor;
      const txt = anchor.getAttribute('data-tooltip') || anchor.getAttribute('title') || '';
      // 移除原生 title 避免浏览器自带气泡
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

    // 事件委托：鼠标与键盘无障碍（修复 closest 报错）
    document.addEventListener('mouseenter', (e) => {
      let node = e.target;
      // 如果是文本/注释等非元素节点，提升到父元素
      if (node && node.nodeType !== 1) node = node.parentElement;
      if (!node) return;
      // 优先使用浏览器自带 closest，失败再降级到 safeClosest
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

    // 任意滚动容器或窗口尺寸变化时，重新定位
    const onRelayout = ()=>{ if (currAnchor && document.body.contains(currAnchor)) placeAround(currAnchor, currAnchor.getAttribute('data-tooltip-placement') || 'top'); };
    window.addEventListener('resize', onRelayout);
    window.addEventListener('scroll', onRelayout, true); // 捕获阶段，能监听任意滚动容器

    // 页面卸载时清理 title 还原（可选）
    window.addEventListener('beforeunload', ()=>{
      document.querySelectorAll('[data-title]').forEach(el=>{
        el.setAttribute('title', el.getAttribute('data-title') || '');
        el.removeAttribute('data-title');
      });
    });
  })();

  // 统一格式化场景显示（位置为空则只显示类型）
  function formatScenario(rt, rl){
  const rtype = escapeHtml(rt || '');
  const raw = rl ?? '';
  const isEmpty = (String(raw).trim() === '' || String(raw).trim() === '无');
  return isEmpty ? rtype : `${rtype}(${escapeHtml(raw)})`;
}
