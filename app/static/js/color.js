/* color.js
 * 颜色索引分配 / 回收 / 唯一化 / 主题
 * 事件驱动：监听 selection:changed
 * 已移除所有旧全局兼容导出（window.colorForKey 等）
 */

(function initColorModule(){
  window.__APP = window.__APP || {};

  /* ========= 持久化 ========= */
  function loadColorIndexMap(){
    try { return JSON.parse(localStorage.getItem('colorIndexMap_v1')||'{}'); } catch { return {}; }
  }
  function saveColorIndexMap(obj){
    try { localStorage.setItem('colorIndexMap_v1', JSON.stringify(obj)); } catch(_){}
  }
  let colorIndexMap = loadColorIndexMap();

  /* ========= 分配 / 释放 / 规范化 ========= */
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
    // 保留唯一占用
    keys.forEach(k=>{
      if (Object.prototype.hasOwnProperty.call(colorIndexMap,k)) {
        const idx = colorIndexMap[k]|0;
        if ((countByIdx.get(idx)||0) === 1) assigned.add(idx);
      }
    });
    // 处理重复 / 无索引
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

  /**
   * recycleRemovedKeys: 回收 + 规范当前集合
   * @param {string[]} removedKeys
   * @param {string[]} currentKeys
   */
  function recycleRemovedKeys(removedKeys, currentKeys){
    try {
      if (Array.isArray(removedKeys) && removedKeys.length){
        removedKeys.forEach(k=>{
          if (Object.prototype.hasOwnProperty.call(colorIndexMap,k)){
            delete colorIndexMap[k];
          }
        });
        saveColorIndexMap(colorIndexMap);
      }
      if (Array.isArray(currentKeys) && currentKeys.length){
        assignUniqueIndicesForSelection(currentKeys.map(k=>({ key:k })));
      }
    } catch(e){
      console.warn('[color] recycleRemovedKeys error', e);
    }
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

  function setTheme(t){
    if (t !== 'dark' && t !== 'light') t = 'light';
    const prev = document.documentElement.getAttribute('data-theme');
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('theme', t); } catch(_){}
    const icon = document.getElementById('themeIcon');
    if (icon) {
      icon.className = (t === 'dark') ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
    }
    applySidebarColors();
    if (window.__APP.chart && typeof window.__APP.chart.refreshTheme === 'function') {
      window.__APP.chart.refreshTheme();
    }
    window.dispatchEvent(new CustomEvent('app-theme-changed',{ detail:{ theme:t, previous: prev }}));
  }

  /* ========= 事件监听 ========= */
  (function initBusIntegration(){
    const bus = window.__APP.bus;
    if (!bus){
      return;
    }
    bus.on('selection:changed', payload=>{
      try {
        recycleRemovedKeys(payload?.removed || [], payload?.current || []);
      } catch(e){
        console.warn('[color] selection:changed handler error', e);
      }
    });
    if (window.__APP.__pendingSelectionDiff){
      const diff = window.__APP.__pendingSelectionDiff;
      delete window.__APP.__pendingSelectionDiff;
      recycleRemovedKeys(diff.removed || [], diff.current || []);
    }
  })();

  const themeBtn = document.getElementById('themeToggle');
  themeBtn?.addEventListener('click', ()=>{
     const cur = document.documentElement.getAttribute('data-theme')==='dark'?'dark':'light';
     window.__APP.color.setTheme(cur==='dark'?'light':'dark');
  });

  /* ========= 命名空间导出 ========= */
  window.__APP.color = {
    loadColorIndexMap,
    saveColorIndexMap,
    colorIndexMap,
    ensureColorIndexForKey,
    ensureColorIndicesForSelected,
    releaseColorIndexForKey,
    assignUniqueIndicesForSelection,
    recycleRemovedKeys,
    currentPalette,
    currentThemeStr,
    colorForKey,
    applyServerStatePatchColorIndices,
    withFrontColors,
    applySidebarColors,
    setTheme
  };

  // 不再提供任何 legacy 全局导出

})();