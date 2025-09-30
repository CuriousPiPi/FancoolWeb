/* color.js
 * Phase 2: 颜色 / 主题 / 颜色索引映射
 * 补充：setTheme + 主题切换按钮逻辑 + dispatch app-theme-changed + 调用 chart.refreshTheme()
 */

(function initColorModule(){
  window.__APP = window.__APP || {};

  /* ========= 颜色索引持久化 ========= */
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
  function releaseColorIndexForKey(key){
    if (!key) return;
    if (Object.prototype.hasOwnProperty.call(colorIndexMap,key)) {
      delete colorIndexMap[key];
      saveColorIndexMap(colorIndexMap);
    }
  }
  function nextFreeIndex(assigned){
    let i=0; while(assigned.has(i)) i++; return i;
  }
  function assignUniqueIndicesForSelection(fans){
    const keys = (fans || []).map(f => f.key).filter(Boolean);
    const countByIdx = new Map();
    keys.forEach(k=>{
      if (Object.prototype.hasOwnProperty.call(colorIndexMap,k)) {
        const idx = colorIndexMap[k]|0;
        countByIdx.set(idx,(countByIdx.get(idx)||0)+1);
      }
    });
    const assigned = new Set();
    keys.forEach(k=>{
      if (Object.prototype.hasOwnProperty.call(colorIndexMap,k)) {
        const idx = colorIndexMap[k]|0;
        if ((countByIdx.get(idx)||0) === 1) assigned.add(idx);
      }
    });
    keys.forEach(k=>{
      const has = Object.prototype.hasOwnProperty.call(colorIndexMap,k);
      if (has) {
        const idx = colorIndexMap[k]|0;
        if ((countByIdx.get(idx)||0) === 1) {
          assigned.add(idx);
          return;
        }
      }
      const newIdx = nextFreeIndex(assigned);
      colorIndexMap[k] = newIdx;
      assigned.add(newIdx);
    });
    saveColorIndexMap(colorIndexMap);
  }

  /* ========= 主题 & 调色 ========= */
  const DARK_BASE_PALETTE = [
    "#3E9BFF","#FFF958","#42E049","#FF4848","#DB68FF",
    "#2CD1E8","#F59916","#FF67A6","#8b5cf6","#14E39E"
  ];
  const LIGHT_LINEAR_SCALE = 0.66;
  function srgbToLinear(c){ return c <= 0.04045 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); }
  function linearToSrgb(c){ return c <= 0.0031308 ? 12.92*c : 1.055*Math.pow(c,1/2.4)-0.055; }
  function darkToLightLinear(hex){
    const h = hex.replace('#','');
    let r = parseInt(h.slice(0,2),16)/255;
    let g = parseInt(h.slice(2,4),16)/255;
    let b = parseInt(h.slice(4,6),16)/255;
    r = srgbToLinear(r); g = srgbToLinear(g); b = srgbToLinear(b);
    r*=LIGHT_LINEAR_SCALE; g*=LIGHT_LINEAR_SCALE; b*=LIGHT_LINEAR_SCALE;
    r = Math.round(linearToSrgb(r)*255);
    g = Math.round(linearToSrgb(g)*255);
    b = Math.round(linearToSrgb(b)*255);
    const to=v=>v.toString(16).padStart(2,'0');
    return '#'+to(r)+to(g)+to(b);
  }
  const currentThemeStr = () =>
    (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
  function currentPalette(){
    return currentThemeStr()==='dark'
      ? DARK_BASE_PALETTE
      : DARK_BASE_PALETTE.map(darkToLightLinear);
  }
  function colorForKey(key){
    const idx = (Object.prototype.hasOwnProperty.call(colorIndexMap,key)?(colorIndexMap[key]|0):0);
    const palette = currentPalette();
    return palette[idx % palette.length];
  }

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

  function withFrontColors(chartData, frontXAxisType){
    const series = (chartData.series||[]).map(s=>{
      const idx = colorIndexMap[s.key] ?? ensureColorIndexForKey(s.key);
      return { ...s, color: colorForKey(s.key), color_index: idx };
    });
    return { ...chartData, x_axis_type: frontXAxisType, series };
  }

  function applySidebarColors(){
    const rows = document.querySelectorAll('#selectedFansList .fan-item');
    rows.forEach(div=>{
      const key = div.getAttribute('data-fan-key');
      const dot = div.querySelector('.js-color-dot');
      if (key && dot) dot.style.backgroundColor = colorForKey(key);
    });
  }

  /* ========= 新增：主题设置 ========= */
  function setTheme(t){
    if (t !== 'dark' && t !== 'light') t = 'light';
    const prev = document.documentElement.getAttribute('data-theme');
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('theme', t); } catch(_){}
    // 更新图标
    const icon = document.getElementById('themeIcon');
    if (icon) {
      icon.className = (t === 'dark') ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
    }
    // 刷新侧栏颜色点
    if (typeof window.applySidebarColors === 'function') {
      window.applySidebarColors();
    }
    // 通知图表刷新
    if (window.__APP.chart && typeof window.__APP.chart.refreshTheme === 'function') {
      window.__APP.chart.refreshTheme();
    }
    // 广播事件
    window.dispatchEvent(new CustomEvent('app-theme-changed',{ detail:{ theme:t, previous: prev }}));
  }

  /* 初始化主题（考虑已有 data-theme 或 localStorage 保存） */
  (function initThemeToggleOnce(){
    if (window.__APP.__themeInited) return;
    window.__APP.__themeInited = true;

    let saved = null;
    try { saved = localStorage.getItem('theme'); } catch(_){}
    const initial = (saved === 'dark' || saved === 'light') ? saved :
      (document.documentElement.getAttribute('data-theme') || 'light');
    setTheme(initial);

    function bind(){
      const btn = document.getElementById('themeToggle');
      if (!btn) return false;
      btn.addEventListener('click', ()=>{
        const next = (currentThemeStr() === 'light') ? 'dark' : 'light';
        setTheme(next);
      });
      return true;
    }
    if (!bind()){
      // 若按钮尚未在 DOM（脚本在 head 中），延迟尝试
      document.addEventListener('DOMContentLoaded', bind, { once:true });
    }
  })();

  // 模块导出
  window.__APP.color = {
    loadColorIndexMap,
    saveColorIndexMap,
    colorIndexMap,
    ensureColorIndexForKey,
    ensureColorIndicesForSelected,
    releaseColorIndexForKey,
    assignUniqueIndicesForSelection,
    currentPalette,
    currentThemeStr,
    colorForKey,
    applyServerStatePatchColorIndices,
    withFrontColors,
    applySidebarColors,
    setTheme
  };

  // 旧全局兼容
  window.colorForKey = colorForKey;
  window.ensureColorIndexForKey = ensureColorIndexForKey;
  window.ensureColorIndicesForSelected = ensureColorIndicesForSelected;
  window.assignUniqueIndicesForSelection = assignUniqueIndicesForSelection;
  window.releaseColorIndexForKey = releaseColorIndexForKey;
  window.applyServerStatePatchColorIndices = applyServerStatePatchColorIndices;
  window.withFrontColors = function(chartData){
    const axis = (window.__APP.chart && window.__APP.chart.getFrontXAxisType)
      ? window.__APP.chart.getFrontXAxisType()
      : (chartData.x_axis_type || 'rpm');
    return withFrontColors(chartData, axis);
  };
  window.applySidebarColors = applySidebarColors;
  window.setTheme = setTheme;

})();