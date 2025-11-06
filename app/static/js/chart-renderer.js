(function(){
  // 对外 API
  const API = { mount, render, resize, setTheme, setOnXAxisChange };

  // 内部状态
  let root = null;
  let chart = null;
  let onXAxisChange = null;

  let lastPayload = null;
  let lastOption  = null;
  let lastIsNarrow = null;
  let isFs = false;

  let spectrumRoot = null;
  let spectrumInner = null;
  let spectrumChart = null;
  let spectrumClip = null;
  let spectrumEnabled = false;
  let lastSpectrumOption = null;
  const spectrumModelCache = new Map();
  const SPECTRUM_X_MIN = 20;
  const SPECTRUM_X_MAX = 20000;
  let __spectrumRaf = null;
  let __specLegendSyncing = false;
  let __skipSpectrumOnce = false;
  let __suppressSpectrumUntil = 0;

  let __legendRailEl = null;
  let __legendScrollEl = null;
  let __legendActionsEl = null;
  let spectrumLoadingEl = null;
  let __specPending = false;
  let __specFetchInFlight = false;
  let __lastFetchKeyHash = '';

  const NF_MAIN_H_PX = 500;  // 非全屏：主图固定高度
  const NF_SPEC_H_PX = 500;  // 非全屏：频谱固定高度
  const NARROW_BREAKPOINT = 1024;   // 窄屏阈值（可按需调整）
  const NARROW_HYSTERESIS = 48;     // 迟滞窗口（像素），用于防抖
  const LEGEND_OFFSET = 50;     // Legend 顶部下移像素

  let __specToggleCooldownUntil = 0;
  let __mainHLocked = false;
  
  let spectrumDockEl = null;
  let __dockCooldownUntil = 0;

function ensureSpectrumDock() {
  if (spectrumDockEl && spectrumDockEl.isConnected) return spectrumDockEl;

  const btn = document.createElement('button');
  btn.id = 'spectrumDock';
  btn.type = 'button';
  btn.className = 'spectrum-dock';
  btn.setAttribute('aria-label', '展开/收起频谱');

  btn.innerHTML = `
    <svg class="chev" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M3.2 6.2a1 1 0 0 1 1.4 0L8 9.6l3.4-3.4a1 1 0 1 1 1.4 1.4L8.7 11.7a1 1 0 0 1-1.4 0L3.2 7.6a1 1 0 0 1 0-1.4z" fill="currentColor"></path>
    </svg>
    <span class="label">展开频谱</span>
  `;

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    const now = performance.now();
    if (now < __dockCooldownUntil) return;
    __dockCooldownUntil = now + 250;

    spectrumEnabled = !spectrumEnabled;
    syncSpectrumDockUi();
    toggleSpectrumUI(spectrumEnabled);

    setTimeout(() => { __dockCooldownUntil = 0; }, 250);
  });

  const shell =
    document.getElementById('chart-settings') ||
    (root && root.closest('.fc-chart-container')) ||
    document.body;

  try { shell.appendChild(btn); } catch(_) { document.body.appendChild(btn); }

  spectrumDockEl = btn;
  syncSpectrumDockUi();
  return spectrumDockEl;
}

function syncSpectrumDockUi() {
  if (!spectrumDockEl) return;
  const open = !!spectrumEnabled;
  spectrumDockEl.classList.toggle('is-open', open);
  const label = spectrumDockEl.querySelector('.label');
  if (label) label.textContent = open ? '收起频谱' : '展开频谱';

  // 统一行为：全屏与非全屏都显示 dock 按钮
  spectrumDockEl.style.visibility = 'visible';
}

function placeSpectrumDock() {
  // 统一行为：全屏与非全屏都放置到容器内
  const el = ensureSpectrumDock();
  const shell =
    document.getElementById('chart-settings') ||
    (root && root.closest('.fc-chart-container')) ||
    null;

  if (!el || !shell) { if (el) el.style.visibility = 'hidden'; return; }

  if (el.parentElement !== shell) {
    try { shell.appendChild(el); } catch(_) {}
  }
  el.style.visibility = 'visible';
}

  // 新增：频谱动画“轮次”与定时器管理，根除竞态
  let __specEpoch = 0;
  const __specTimers = new Set();
  function specBumpEpochAndClearTimers() {
    __specEpoch++;
    __specTimers.forEach(id => { try { clearTimeout(id); } catch(_) {} });
    __specTimers.clear();
  }
  function specSetTimeout(fn, ms) {
    const myEpoch = __specEpoch;
    const id = setTimeout(() => {
      __specTimers.delete(id);
      if (myEpoch === __specEpoch) fn();
    }, ms);
    __specTimers.add(id);
    return id;
  }

function __hashWantedSet(set) {
  try { return Array.from(set).sort().join('|'); } catch(_) { return ''; }
}

function ensureLegendRail(){
  const shell = document.getElementById('chart-settings') || (root && root.closest('.fc-chart-container')) || null;
  if (!shell) return null;
  shell.classList.add('chart-flex');

  let stack = shell.querySelector('.chart-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.className = 'chart-stack';

    if (root) stack.appendChild(root);
    if (spectrumRoot) stack.appendChild(spectrumRoot);
    shell.insertBefore(stack, shell.firstChild); 
  }

  if (__legendRailEl && __legendRailEl.isConnected) return __legendRailEl;

  const rail = document.createElement('aside');
  rail.id = 'legendRail';
  // 移除 legend-spacer，只保留 legend-scroll 与 rail-actions
  rail.innerHTML = `
    <div class="legend-scroll" id="legendRailScroll"></div>
    <div class="rail-actions"><!-- #fitButtons 将被挂到这里 --></div>
  `;
  shell.appendChild(rail);

  __legendRailEl = rail;
  __legendScrollEl = rail.querySelector('#legendRailScroll');
  __legendActionsEl = rail.querySelector('.rail-actions');
  return rail;
}

function updateLegendRailLayout(){
  const shell = document.getElementById('chart-settings') || (root && root.closest('.fc-chart-container')) || null;
  if (!shell) return;
  shell.classList.add('chart-flex');
  const narrow = layoutIsNarrow();
  if (narrow) shell.classList.add('is-narrow'); else shell.classList.remove('is-narrow');

  if (!__legendRailEl) return;

  try {
    const topGap = narrow ? 0 : LEGEND_OFFSET;
    __legendRailEl.style.setProperty('--legend-top-gap', `${topGap}px`);
  } catch(_){}

  if (narrow) {
    __legendRailEl.style.width = '100%';
    try { shell.style.setProperty('--legend-rail-w', '0px'); } catch(_){}
    return;
  }

  // 桌面：测量文本以确定“展开时”的目标宽度
  let minW = 160;
  let textMax = 0;
  try {
    const t = tokens((lastPayload && lastPayload.theme) || (document.documentElement.getAttribute('data-theme') || 'light'));
    const sList = Array.isArray(lastPayload?.chartData?.series) ? lastPayload.chartData.series : [];
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const l1Font = `600 13px ${t.fontFamily}`;
    const l2Font = `500 11px ${t.fontFamily}`;
    sList.forEach(s=>{
      const brand = s.brand || s.brand_name_zh || s.brand_name || '';
      const model = s.model || s.model_name || '';
      const cond  = s.condition_name_zh || s.condition || '';
      const line1 = [brand, model].filter(Boolean).join(' ') || (s.name || '');
      ctx.font = l1Font;
      const w1 = ctx.measureText(line1).width || 0;
      let w2 = 0;
      if (cond) { ctx.font = l2Font; w2 = ctx.measureText(cond).width || 0; }
      textMax = Math.max(textMax, w1, w2);
    });
  } catch(_){}

  const iconW = 12, gap = 8, pad = 12;
  const need = Math.ceil(iconW + gap + textMax + pad);
  const targetW = Math.max(minW, Math.min(320, need));
  __legendRailEl.style.width = `${Math.round(targetW)}px`;

  // 可选：保留变量（目前不再用于 chart-stack padding），不影响功能
  try {
    const measured = (__legendRailEl.getBoundingClientRect?.().width) || targetW || 0;
    const w = Math.ceil(measured);
    shell.style.setProperty('--legend-rail-w', `${w}px`);
  } catch(_){}
}

function renderLegendRailItems(){
  ensureLegendRail();
  if (!__legendScrollEl) return;
  const sList = Array.isArray(lastPayload?.chartData?.series) ? lastPayload.chartData.series : [];
  const selMap = getLegendSelectionMap();
  const isNarrowNow = layoutIsNarrow();

  const items = sList.map(s => ({
    name: s.name,
    brand: s.brand || s.brand_name_zh || s.brand_name || '',
    model: s.model || s.model_name || '',
    condition: s.condition_name_zh || s.condition || '',
    color: s.color,
    selected: selMap ? (selMap[s.name] !== false) : true
  }));

  __legendScrollEl.innerHTML = items.map(it => {
    const base = (it.brand || it.model) ? `${it.brand} ${it.model}` : it.name;

    if (isNarrowNow) {
      // 窄屏：单行省略，工况拼接，工况字体和颜色与常规 .l2 一致
      return `
        <div class="legend-item ${it.selected ? '' : 'is-off'}" data-name="${it.name}">
          <span class="dot" style="background:${it.color}"></span>
          <span class="merged" style="flex:1 1 auto; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
            <span class="l1">${base}</span>
            ${it.condition ? `<span class="sep"> - </span><span class="l2-inline">${it.condition}</span>` : ``}
          </span>
        </div>
      `;
    } else {
      // 桌面：两行展示
      return `
        <div class="legend-item ${it.selected ? '' : 'is-off'}" data-name="${it.name}">
          <span class="dot" style="background:${it.color}"></span>
          <span style="flex:1 1 auto; display:flex; flex-direction:column; min-width:0;">
            <span class="l1">${base}</span>
            ${it.condition ? `<span class="l2">${it.condition}</span>` : ``}
          </span>
        </div>
      `;
    }
  }).join('');

  __legendScrollEl.querySelectorAll('.legend-item').forEach(node => {
    const name = node.getAttribute('data-name') || '';
    node.addEventListener('click', () => {
      if (!name || !chart) return;
      const sel = getLegendSelectionMap();
      const isCurrentlyVisible = sel ? (sel[name] !== false) : true;
      const actionType = isCurrentlyVisible ? 'legendUnSelect' : 'legendSelect';

      node.classList.toggle('is-off', isCurrentlyVisible);

      try { chart.dispatchAction({ type: actionType, name }); } catch(_){}
      if (spectrumEnabled && spectrumChart) {
        try { spectrumChart.dispatchAction({ type: actionType, name }); } catch(_){}
      }

      if (showFitCurves) refreshFitBubble();
    });

    node.addEventListener('mouseenter', () => { if (name && chart) try { chart.dispatchAction({ type: 'highlight', seriesName: name }); } catch(_){ } });
    node.addEventListener('mouseleave', () => { if (name && chart) try { chart.dispatchAction({ type: 'downplay', seriesName: name }); } catch(_){ } });
  });
}

// 修改：syncLegendRailFromChart —— 根据选中态增减 is-off 类
function syncLegendRailFromChart(){
  if (!__legendScrollEl) return;
  const sel = getLegendSelectionMap();
  __legendScrollEl.querySelectorAll('.legend-item').forEach(node => {
    const name = node.getAttribute('data-name');
    const selected = sel ? (sel[name] !== false) : true;
    node.classList.toggle('is-off', !selected);
  });
}
function updateLegendRail(){
  ensureLegendRail();
  renderLegendRailItems();
  updateLegendRailLayout();

  // 将 #fitButtons 放到 rail 底部
  const btns = getById('fitButtons');
  if (btns && __legendActionsEl && btns.parentElement !== __legendActionsEl) {
    try { __legendActionsEl.appendChild(btns); } catch(_){}
  }
}

function getTargetSpectrumHeight(){
  // 非全屏：参考主图高度
  const mainH =
    (root && root.getBoundingClientRect ? root.getBoundingClientRect().height : 0) ||
    (chart && chart.getHeight && chart.getHeight()) || 600;
  return Math.max(140, Math.round(mainH / 1.5));
}

  function getCssTransitionMs(){
    try {
      const raw = getComputedStyle(document.documentElement).getPropertyValue('--transition-speed').trim();
      if (!raw) return 250;
      if (raw.endsWith('ms')) return Math.max(0, parseFloat(raw));
      if (raw.endsWith('s'))  return Math.max(0, parseFloat(raw) * 1000);
      const n = parseFloat(raw);
      return Number.isFinite(n) ? n : 250;
    } catch(_) { return 250; }
  }
  // NEW: 追踪 root 的几何变化（位置/尺寸），用于在容器“移动但不改变尺寸”时重放置拟合气泡
  let __lastRootRect = { left:0, top:0, width:0, height:0 };
  let __posWatchRaf = null;
  let __posWatchUntil = 0;

  function setOnXAxisChange(fn){
    onXAxisChange = (typeof fn === 'function') ? fn : null;
  }

  // 拟合/指针状态
  const FIT_ALGO_NAME = '趋势拟合';
  let showFitCurves = false;
  let fitUIInstalled = false;

  const xQueryByMode = { rpm: null, noise_db: null };
  const fitModelsCache = { rpm: new Map(), noise_db: new Map() };

  // 复用测量上下文
  const __textMeasureCtx = (() => {
    const c = document.createElement('canvas');
    return c.getContext('2d');
  })();

  
  // -------- 工具 --------
  function warnOnce(msg){ if (!warnOnce._s) warnOnce._s=new Set(); if(warnOnce._s.has(msg))return; warnOnce._s.add(msg); console.warn(msg); }
  function getById(id){
    // 优先在 root 内查找；未命中则回退到全局（document）
    if (!id) return null;
    let el = null;
    if (root && typeof root.querySelector === 'function') {
      try { el = root.querySelector('#' + id); } catch(_) {}
    }
    return el || document.getElementById(id);
  }
  function appendToRoot(el){ if (root) root.appendChild(el); else document.body.appendChild(el); }

  // NEW: root 几何辅助
  function getRootRect(){
    if (!root || !root.getBoundingClientRect) return { left:0, top:0, width:0, height:0 };
    const r = root.getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  }

  function primeRootRect(){ __lastRootRect = getRootRect(); }

  function maybeStartRootPosWatch(ms=800){
    const until = performance.now() + Math.max(0, ms|0);
    __posWatchUntil = Math.max(__posWatchUntil, until);
    if (!__posWatchRaf) {
      const tick = () => {
        __posWatchRaf = null;
        const now = performance.now();
        const cur = getRootRect();
        // 当 root 的位置或尺寸变化时，重放置拟合 UI 与外置频谱按钮
        if (cur.left !== __lastRootRect.left || cur.top !== __lastRootRect.top ||
            cur.width !== __lastRootRect.width || cur.height !== __lastRootRect.height) {
          __lastRootRect = cur;
          try { placeFitUI(); repaintPointer(); placeSpectrumDock(); } catch(_){}
        }
        if (now < __posWatchUntil) {
          __posWatchRaf = requestAnimationFrame(tick);
        } else {
          __posWatchUntil = 0;
        }
      };
      __posWatchRaf = requestAnimationFrame(tick);
    }
  }

  function ensureEcharts(){
    if (chart || !root) return;
    if (!window.echarts){ echartsReady = false; return; }
    echartsReady = true;
    chart = echarts.init(root, null, { renderer:'canvas', devicePixelRatio: window.devicePixelRatio || 1 });
    installChartResizeObserver();
    bindGlobalListeners();
    bindChartListeners();
    primeRootRect();                 // NEW: 记录初始几何
    if (!fitUIInstalled) {
      ensureFitUI();
      fitUIInstalled = true;
      toggleFitUI(showFitCurves /* narrow 也显示 */);
      placeFitUI();
      requestAnimationFrame(repaintPointer);
    }
  }

  function adoptBubbleHost() {
    const bubble = document.getElementById('fitBubble');
    if (!bubble) return;

    // 若页面有全屏元素，则必须把气泡作为“全屏元素”的后代，才能处于 Top Layer 之上被看见
    const fsEl = document.fullscreenElement || null;
    const shouldHost = fsEl ? fsEl : document.body;

    if (bubble.parentElement !== shouldHost) {
      try { shouldHost.appendChild(bubble); } catch(_) {}
    }

    // 保持 fixed，不用切换 absolute。位置仍由 placeFitUI 按“相对 chart root 偏移”计算
    bubble.style.position = 'fixed';
  }

function bindGlobalListeners(){
  window.addEventListener('resize', onWindowResize, { passive:true });

  // 滚动时基于“相对图表偏移”重算一次位置（rAF 节流）
  let __scrollRaf = null;
  const onAnyScroll = () => {
    if (__scrollRaf) return;
    __scrollRaf = requestAnimationFrame(() => {
      __scrollRaf = null;
      try { placeFitUI(); placeSpectrumDock(); } catch(_) {}
    });
  };
  window.addEventListener('scroll', onAnyScroll, { passive: true, capture: true });

  (function hookLayoutMovers(){
    const watchMovement = () => { try { placeFitUI(); repaintPointer(); placeSpectrumDock(); } catch(_) {} };
    const kickWatch = () => { watchMovement(); maybeStartRootPosWatch(900); };

    const sidebar = document.getElementById('sidebar');
    if (sidebar) {
      ['transitionrun','transitionstart','transitionend'].forEach(ev=>{
        sidebar.addEventListener(ev, kickWatch, { passive:true });
      });
      try {
        const mo = new MutationObserver(kickWatch);
        mo.observe(sidebar, { attributes:true, attributeFilter:['class','style'] });
      } catch(_){}
    }
    const mainPanels = document.getElementById('main-panels');
    if (mainPanels) {
      ['transitionrun','transitionstart','transitionend'].forEach(ev=>{
        mainPanels.addEventListener(ev, kickWatch, { passive:true });
      });
      try {
        const mo2 = new MutationObserver(kickWatch);
        mo2.observe(mainPanels, { attributes:true, attributeFilter:['class','style'] });
      } catch(_){}
    }
  })();

  document.addEventListener('fullscreenchange', async () => {
    isFs = !!document.fullscreenElement;

    const modeHost =
      document.getElementById('chart-settings') ||
      (root && root.closest('.fc-chart-container')) ||
      document.documentElement;

    adoptBubbleHost();
    bubbleUserMoved = false;

    if (window.visualViewport) {
      try { window.visualViewport.removeEventListener('resize', onWindowResize); } catch(_) {}
      if (isFs) {
        try { window.visualViewport.addEventListener('resize', onWindowResize, { passive: true }); } catch(_) {}
      }
    }

    try { chart && chart.dispatchAction({ type: 'hideTip' }); } catch(_) {}
    try { spectrumChart && spectrumChart.dispatchAction({ type: 'hideTip' }); } catch(_) {}

    if (!isFs) {
      if (spectrumRoot) spectrumRoot.style.marginTop = '0px';

      if (!spectrumEnabled) {
        try { modeHost.removeAttribute('data-chart-mode'); } catch(_) {}
        if (root) try { root.style.minHeight = ''; } catch(_) {}
      } else {
        __ensureMainChartMinHeightForSpectrumMode();
      }

      if (screen.orientation && screen.orientation.unlock) {
        try { screen.orientation.unlock(); } catch(_) {}
      }
    }

    updateFullscreenHeights();

    if (lastPayload) render(lastPayload); else if (chart) chart.resize();

    requestAnimationFrame(() => {
      try {
        // 切换全屏模式后，同步频谱展开/收起状态（不做二次动画）
        syncSpectrumStateAcrossModes({ animate: false });

        placeFitUI();
        repaintPointer();
        updateSpectrumLayout();
        updateLegendRailLayout();
        updateLegendRail();
        updateRailParkedState();
        // 外置按钮：全屏下暂时隐藏，常规模式显示并重放置
        syncSpectrumDockUi();
        placeSpectrumDock();

        if (chart) chart.resize();
        if (spectrumChart) spectrumChart.resize();
      } catch(_) {}
    });
  }, { passive:true });
}

function bindChartListeners(){
  chart.on('legendmouseover', (p) => {
    if (!spectrumEnabled || !spectrumChart || !p || !p.name) return;
    try { spectrumChart.dispatchAction({ type: 'highlight', seriesName: p.name }); } catch(_) {}
  });
  chart.on('legendmouseout', (p) => {
    if (!spectrumEnabled || !spectrumChart || !p || !p.name) return;
    try { spectrumChart.dispatchAction({ type: 'downplay', seriesName: p.name }); } catch(_) {}
  });
  chart.on('highlight', (p) => {
    if (!spectrumEnabled || !spectrumChart || !p || !p.seriesName) return;
    try { spectrumChart.dispatchAction({ type: 'highlight', seriesName: p.seriesName }); } catch(_) {}
  });
  chart.on('downplay', (p) => {
    if (!spectrumEnabled || !spectrumChart || !p || !p.seriesName) return;
    try { spectrumChart.dispatchAction({ type: 'downplay', seriesName: p.seriesName }); } catch(_) {}
  });

  chart.on('dataZoom', () => {
    clampXQueryIntoVisibleRange();
    repaintPointer();
    if (showFitCurves) refreshFitBubble();

    if (__skipSpectrumOnce || performance.now() < __suppressSpectrumUntil) return;
    if (spectrumEnabled && spectrumChart) scheduleSpectrumRebuild();
  });
}

function onWindowResize(){
  if (!chart) return;

  __suppressSpectrumUntil = Math.max(__suppressSpectrumUntil, performance.now() + 500);

  updateFullscreenHeights();
  const nowNarrow = layoutIsNarrow();
  if (lastIsNarrow === null) lastIsNarrow = nowNarrow;
  maybeStartRootPosWatch(900);

  if (nowNarrow !== lastIsNarrow) {
    lastIsNarrow = nowNarrow;
    if (lastPayload) render(lastPayload); else chart.resize();
  } else {
    chart.resize();
    try { spectrumEnabled && spectrumChart && spectrumChart.resize(); } catch(_) {}

    if (lastOption) {
      const { x, y, visible } = computePrefixCenter(lastOption);
      placeAxisOverlayAt(x, y, visible && !lastOption.__empty);
      placeFitUI();
      repaintPointer();
    }
  }

  updateSpectrumLayout();
  updateLegendRailLayout();
  __refreshFsSpecMaxHeightIfExpanded();
  updateRailParkedState();
  // 关键：外置按钮随窗口变化重放置
  placeSpectrumDock();
}

  let __chartRO = null;
function installChartResizeObserver(){
  if (__chartRO || !root || typeof ResizeObserver === 'undefined') return;
  __chartRO = new ResizeObserver(entries => {
    for (const entry of entries) {
      const cr = entry.contentRect || {};
      if (chart && cr.width > 0 && cr.height > 0) {
        __suppressSpectrumUntil = Math.max(__suppressSpectrumUntil, performance.now() + 500);

        primeRootRect();
        maybeStartRootPosWatch(900);

        const nowNarrow = layoutIsNarrow();
        if (lastIsNarrow === null) lastIsNarrow = nowNarrow;
        if (nowNarrow !== lastIsNarrow) {
          lastIsNarrow = nowNarrow;
          try {
            if (lastPayload) { render(lastPayload); }
            else { chart.resize(); }
          } catch(_){}
          updateSpectrumLayout();
          updateLegendRailLayout();
          updateRailParkedState();
          // 外置按钮
          placeSpectrumDock();
          continue;
        }

        try { chart.resize(); } catch(_){}
        try { spectrumEnabled && spectrumChart && spectrumChart.resize(); } catch(_){}

        try {
          if (lastOption) {
            const { x, y, visible } = computePrefixCenter(lastOption);
            placeAxisOverlayAt(x, y, visible && !lastOption.__empty);
          }
          placeFitUI();
          repaintPointer();
          updateAxisSwitchPosition({ force: true, animate: false });
        } catch(_){}
        updateSpectrumLayout();
        updateLegendRailLayout();

        // 外置按钮
        placeSpectrumDock();
      }
    }
  });
  __chartRO.observe(root);
}

  function isMobile(){
    return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
      || (window.matchMedia && window.matchMedia('(pointer:coarse)').matches);
  }

function layoutIsNarrow() {
  // 以“图表外层容器”的实际宽度判定，避免 rail 改变自身宽度导致的反馈抖动
  const host = document.getElementById('chart-settings') || (root && root.closest('.fc-chart-container')) || document.documentElement;
  const w =
    (host && host.getBoundingClientRect && Math.floor(host.getBoundingClientRect().width)) ||
    (window.innerWidth || 0);

  // 迟滞窗口：进入阈值略小、退出阈值略大，避免边界来回切换
  const half = Math.max(0, Math.floor(NARROW_HYSTERESIS / 2));
  const enterNarrowAt = NARROW_BREAKPOINT - half; // 进入窄屏阈值
  const exitNarrowAt  = NARROW_BREAKPOINT + half; // 退出窄屏阈值

  let narrow;
  if (lastIsNarrow === true) {
    // 已经是窄屏 → 只有当宽度明显超过退出阈值才切回桌面
    narrow = (w < exitNarrowAt);
  } else if (lastIsNarrow === false) {
    // 已经是桌面 → 只有当宽度明显小于进入阈值才切换到窄屏
    narrow = (w < enterNarrowAt);
  } else {
    // 初次判定
    narrow = (w < NARROW_BREAKPOINT);
  }

  // 全屏 + 移动端不视为窄屏（保持原规则）
  if (isFs && isMobile()) narrow = false;
  return narrow;
}

function mount(rootEl) {
  if (!rootEl) {
    warnOnce('[ChartRenderer] mount(rootEl) 需要一个有效的 DOM 容器');
    return;
  }
  root = rootEl; // 在函数最开始设置 root 变量

  ensureSpectrumHost();

  // 确保 DOM 结构正确
  const shell = root.closest('.fc-chart-container');
  if (shell) {
    let stack = shell.querySelector('.chart-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.className = 'chart-stack';
      
      if (root.parentElement) {
        root.parentElement.insertBefore(stack, root);
      }
      stack.appendChild(root);
    }

    // 确保 spectrumRoot 也被移入 stack
    if (spectrumRoot && spectrumRoot.parentElement !== stack) {
        stack.appendChild(spectrumRoot);
    }
  }

  ensureLegendRail();
  updateLegendRailLayout();

  ensureEcharts();
  const initialTheme =
    (window.ThemePref && typeof window.ThemePref.resolve === 'function')
      ? window.ThemePref.resolve()
      : (document.documentElement.getAttribute('data-theme') || 'light');

  if (window.ThemePref && typeof window.ThemePref.setDom === 'function') {
    window.ThemePref.setDom(initialTheme);
  } else {
    document.documentElement.setAttribute('data-theme', initialTheme);
  }

  if (!chart) return;
  
  const emptyPayload = { chartData: { series: [] }, theme: initialTheme };
  render(emptyPayload);
}

function ensureSpectrumHost() {
  // 若已存在 host，仅保证有 .spectrum-inner 子元素
  if (spectrumRoot && spectrumRoot.isConnected) {
    let inner = spectrumRoot.querySelector('.spectrum-inner');
    if (!inner) {
      inner = document.createElement('div');
      inner.className = 'spectrum-inner';
      spectrumRoot.appendChild(inner);
    }
    try {
      inner.style.position = 'relative';
      inner.style.width = '100%';
      inner.style.overflow = 'visible';
    } catch(_) {}
    spectrumInner = inner;
    return spectrumRoot;
  }

  // 新建 Host + inner（无剪裁层）
  let host = document.getElementById('spectrumHost');
  if (!host) { host = document.createElement('div'); host.id = 'spectrumHost'; }

  const shell = document.getElementById('chart-settings') || (root && root.closest('.fc-chart-container')) || document.body;
  let stack = shell && shell.querySelector('.chart-stack');
  if (!stack && root && root.parentElement) {
    stack = document.createElement('div');
    stack.className = 'chart-stack';
    root.parentElement.insertBefore(stack, root);
    stack.appendChild(root);
    if (shell && stack.parentElement !== shell) shell.insertBefore(stack, shell.firstChild);
  }
  if (stack && host.parentElement !== stack) stack.appendChild(host);
  else if (!stack && root && host.parentElement !== root.parentElement) root.parentElement?.insertBefore(host, root.nextSibling);

  let inner = host.querySelector('.spectrum-inner');
  if (!inner) { inner = document.createElement('div'); inner.className = 'spectrum-inner'; host.appendChild(inner); }
  try {
    inner.style.position = 'relative';
    inner.style.width = '100%';
    inner.style.overflow = 'visible';
  } catch(_) {}

  spectrumRoot = host;
  spectrumInner = inner;
  return host;
}

function updateFullscreenHeights() {
  const fsEl = document.fullscreenElement;
  const activeFs = !!fsEl;
  isFs = activeFs;

  requestAnimationFrame(() => {
    try { chart && chart.resize(); } catch (_) { }
    try { spectrumEnabled && spectrumChart && spectrumChart.resize(); } catch (_) { }
  });
}

function setTheme(theme) {
  const t = (window.ThemePref && typeof window.ThemePref.save === 'function')
    ? window.ThemePref.save(theme, { notifyServer: false }) // 渲染器不直接上报
    : String(theme || 'light').toLowerCase();

  if (window.ThemePref && typeof window.ThemePref.setDom === 'function') {
    window.ThemePref.setDom(t);
  } else {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('theme', t); } catch(_) {}
  }
  if (lastPayload) render(lastPayload);
}

function render(payload){
  lastPayload = payload || lastPayload;
  if (!root){ warnOnce('[ChartRenderer] 请先调用 mount(rootEl)'); return; }
  if (!window.echarts){ requestAnimationFrame(()=>render(lastPayload)); return; }
  ensureEcharts();
  if (!chart) return;

  const prevXMode = currentXModeFromPayload(lastPayload);
  const prevEmpty = !!(lastOption && lastOption.__empty);

  syncThemeAttr((lastPayload && lastPayload.theme) || 'light');

  if (!fitUIInstalled && showFitCurves) { ensureFitUI(); fitUIInstalled = true; }

  const option = buildOption(lastPayload);
  const nextXMode = currentXModeFromPayload(lastPayload);
  const nextEmpty = !!option.__empty;

  if (prevXMode !== nextXMode || prevEmpty !== nextEmpty) {
    try { chart.clear(); } catch(_){}
  }

  chart.setOption(option, true);
  chart.resize();

  lastOption = option;
  syncSpectrumBgWithMain(option && option.backgroundColor);

  requestAnimationFrame(() => updateAxisSwitchPosition({ force:true, animate:false }));
  if (option.__empty) {
    try { chart.dispatchAction({ type: 'updateAxisPointer', currTrigger: 'leave' }); } catch(_){}
  }

  const { x, y, visible } = computePrefixCenter(option);
  placeAxisOverlayAt(x, y, visible && !option.__empty);

  lastIsNarrow = layoutIsNarrow();

  toggleFitUI(showFitCurves);
  placeFitUI();
  updateRailParkedState();

  // 外置按钮：常规模式显示，位置与文案同步
  ensureSpectrumDock();
  syncSpectrumDockUi();
  placeSpectrumDock();

  updateLegendRail();

  primeRootRect();
  maybeStartRootPosWatch(600);

  try {
    const onFinished = () => {
      try { chart.off('finished', onFinished); } catch(_){}
      repaintPointer();
      updateSpectrumLayout();

      if (spectrumEnabled) {
        if (__skipSpectrumOnce || performance.now() < __suppressSpectrumUntil) {
        } else {
          requestAndRenderSpectrum();
        }
      }
      setTimeout(() => { __skipSpectrumOnce = false; }, 450);
      try { syncLegendRailFromChart(); } catch(_){}
    };
    chart.on('finished', onFinished);
  } catch(_){}

  requestAnimationFrame(repaintPointer);
  if (showFitCurves) refreshFitBubble();
}

  function resize(){ if (chart) chart.resize(); }

  // ===== 主题/度量 =====
  function syncThemeAttr(theme){
    const t = String(theme || 'light').toLowerCase();
    document.documentElement.setAttribute('data-theme', t);
  }

  function tokens(theme) {
    const dark = (theme||'').toLowerCase()==='dark';
    return {
      fontFamily:'system-ui,-apple-system,"Segoe UI","Helvetica Neue","Microsoft YaHei",Arial,sans-serif',
      axisLabel: dark ? '#d1d5db' : '#4b5563',
      axisName:  dark ? '#9ca3af' : '#6b7280',
      axisLine:  dark ? '#374151' : '#e5e7eb',
      gridLine:  dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)',
      tooltipBg: dark ? 'var(--bg-bubble)' : 'rgba(255,255,255,0.98)',
      tooltipBorder: dark ? '#374151' : '#e5e7eb',
      tooltipText: dark ? '#f3f4f6' : '#1f2937',
      tooltipShadow: dark ? '0 6px 20px rgba(0,0,0,0.35)' : '0 6px 20px rgba(0,0,0,0.12)',
      pagerIcon: dark ? '#93c5fd' : '#2563eb'
    };
  }

  function measureText(text, size, weight, family){
    const ctx = __textMeasureCtx;
    ctx.font = `${String(weight||400)} ${Number(size||14)}px ${family||'sans-serif'}`;
    const m = ctx.measureText(text || '');
    const width = m.width || 0;
    const ascent = (typeof m.actualBoundingBoxAscent === 'number') ? m.actualBoundingBoxAscent : size * 0.8;
    const descent = (typeof m.actualBoundingBoxDescent === 'number') ? m.actualBoundingBoxDescent : size * 0.2;
    return { width, height: ascent + descent };
  }

  const TITLE_GLUE = '  -  ';
  function computePrefixCenter(option){
    if (!chart || !option || !option.title) return { x: 0, y: 0, visible:false };
    if (option.__empty) return { x: 0, y: 0, visible:false };
    const title = option.title;
    const ts = title.textStyle || {};
    const size = Number(ts.fontSize || option.__titleFontSize || 14);
    const weight = ts.fontWeight || option.__titleFontWeight || 600;
    const family = ts.fontFamily || option.__titleFamily;
    const prefix = String(option.__titlePrefix || '');
    const totalText = `${prefix}${TITLE_GLUE}风量曲线`;

    const mTotal = measureText(totalText, size, weight, family);
    const mPrefix = measureText(prefix, size, weight, family);
    const chartW = chart.getWidth();
    const centerX = chartW / 2;
    const totalLeft = centerX - mTotal.width / 2;
    const prefixCenterX = totalLeft + mPrefix.width / 2;
    const top = (typeof title.top === 'number') ? title.top : 0;
    const centerY = top + (mTotal.height / 2);
    return { x: Math.round(prefixCenterX), y: Math.round(centerY), visible:true };
  }

  // ===== X 轴模式/构建 =====
  function currentXModeFromPayload(payload){
    const inPay = (payload?.chartData?.x_axis_type === 'noise_db' || payload?.chartData?.x_axis_type === 'noise') ? 'noise_db' : 'rpm';
    if (xAxisOverride) return xAxisOverride;
    return inPay;
  }

  const X_PLACEHOLDER_NEG = -1;
  const X_MIN_CLAMP = 0;
  function isFiniteNumber(v){ const n = Number(v); return Number.isFinite(n); }

  function buildSeries(rawSeries, xMode) {
    let maxAir = 0;
    let minX = +Infinity, maxX = -Infinity;

    const series = rawSeries.map(s => {
      const xSrc  = Array.isArray(s[xMode]) ? s[xMode] : [];
      const ySrc  = Array.isArray(s.airflow) ? s.airflow : [];
      const tipSrc = Array.isArray(xMode === 'rpm' ? s.noise_db : s.rpm)
        ? (xMode === 'rpm' ? s.noise_db : s.rpm) : [];

      const n = Math.min(xSrc.length, ySrc.length);
      const data = [];
      for (let i = 0; i < n; i++) {
        const xRaw = xSrc[i];
        const yRaw = ySrc[i];
        const yv = Number(yRaw);
        const xv = Number(xRaw);

        if (isFiniteNumber(yv)) {
          if (isFiniteNumber(xv) && xv !== X_PLACEHOLDER_NEG) {
            minX = Math.min(minX, xv);
            maxX = Math.max(maxX, xv);
            maxAir = Math.max(maxAir, yv);
            const tipRaw = tipSrc[i];
            const tip = isFiniteNumber(Number(tipRaw)) ? Number(tipRaw) : undefined;
            data.push({ value: [xv, yv], tip });
          } else {
            data.push({ value: [X_PLACEHOLDER_NEG, yv], tip: undefined, __missingX: true });
          }
        }
      }

      return {
        name: s.name,
        type: 'line',
        smooth: true,
        connectNulls: false,
        showSymbol: true,
        symbol: 'circle',
        symbolSize: 8,
        lineStyle: { width: 3, color: s.color },
        itemStyle: { color: s.color },
        label: { show: true, position: 'top', color: 'gray' },
        legendHoverLink: true,
        emphasis: {
          focus: 'series',
          blurScope: 'coordinateSystem',
          lineStyle: { width: 4 },
          itemStyle: { borderWidth: 1.2, shadowColor: 'rgba(0,0,0,0.25)', shadowBlur: 8 },
          label: { show: true }
        },
        blur: {
          lineStyle: { opacity: 0.18 },
          itemStyle: { opacity: 0.18 },
          label: { show: false }
        },
        data
      };
    });

    if (minX === +Infinity) { minX = 0; maxX = 100; }
    if (maxAir <= 0) maxAir = 100;

    const span = Math.max(1, maxX - minX);
    const pad = Math.floor(span * 0.2);
    return { series, xMin: Math.max(minX - pad, 0), xMax: maxX + pad, yMax: Math.ceil(maxAir * 1.4) };
  }

function buildOption(payload) {
  const { chartData, theme } = payload || {};
  const t = tokens(theme||'light');
  const sList = Array.isArray(chartData?.series) ? chartData.series : [];
  const xMode = currentXModeFromPayload(payload);

  const isNarrow = layoutIsNarrow();
  const exportBg = (payload && payload.chartBg) || getExportBg();
  const bgNormal = isFs ? exportBg : 'transparent';
  const transitionMs = getCssTransitionMs();

  if (!sList.length) {
    toggleFitUI(false);
    return {
      __empty:true,
      backgroundColor: bgNormal,
      title:{ text:'请 先 添 加 数 据', left:'center', top:'middle',
        textStyle:{ color:t.axisLabel, fontFamily:t.fontFamily, fontSize: 20, fontWeight: 600 }
      },
      toolbox:{ show:false },
      tooltip:{ show:false, triggerOn:'none' }
    };
  }

  const built = buildSeries(sList, xMode);

  const xName = xMode==='rpm' ? '转速(RPM)' : '噪音(dB)';
  const titlePrefix = xMode==='rpm' ? '转速' : '噪音';
  const titleTop = 10, titleFontSize = 20, titleFontWeight = 600;
  const titleText = `${titlePrefix}${TITLE_GLUE}风量曲线`;
  const titleMeasure = measureText(titleText, titleFontSize, titleFontWeight, t.fontFamily);
  const gridTop = Math.max(54, titleTop + Math.ceil(titleMeasure.height) + 12);

  const gridRight = 30;
  // 窄屏不再为 legend 预留大底部空间，统一 40
  const gridBottom = isNarrow ? 60 : 60;

  const legendCfg = { show: false, data: sList.map(s=>s.name) };
  try {
    const prevSel = chart?.getOption?.().legend?.[0]?.selected;
    if (prevSel) legendCfg.selected = prevSel;
  } catch(_){}

  const finalSeries = [];
  built.series.forEach(s => finalSeries.push(s));

  if (showFitCurves) {
    ensureFitModels(sList, xMode);
    const width = Math.max(300, chart.getWidth ? chart.getWidth() : 800);
    const sampleCount = computeSampleCount(width);
    sList.forEach(s => {
      const model = fitModelsCache[xMode].get(s.name);
      if (!model || model.x0 == null || model.x1 == null) return;
      const sMin = Math.min(model.x0, model.x1);
      const sMax = Math.max(model.x0, model.x1);
      const xmin = Math.max(built.xMin, sMin);
      const xmax = Math.min(built.xMax, sMax);
      if (!(xmax > xmin)) return;
      const pts = resampleSingle(model, xmin, xmax, sampleCount);
      finalSeries.push({
        id: `fit-line:${xMode}:${s.name}`,
        name: s.name,
        type: 'line',
        smooth: false,
        showSymbol: false,
        connectNulls: false,
        data: pts.map(p => [p.x, p.y]),
        lineStyle: { width: 2.5, type:'dashed', color: s.color, opacity: 0.95 },
        itemStyle: { color: s.color },
        legendHoverLink: true,
        emphasis: { focus: 'series', blurScope: 'coordinateSystem', lineStyle: { width: 3.5, opacity: 1 }, itemStyle: { opacity: 1 } },
        blur: { lineStyle: { opacity: 0.2 }, itemStyle: { opacity: 0.2 } },
        silent: false,
        tooltip: { show: false },
        z: 3
      });
    });
  }

  const rawMin = Math.max(X_MIN_CLAMP, built.xMin);
  const rawMax = built.xMax * 1.2;
  let xMinForAxis = Math.floor(rawMin);
  let xMaxForAxis = Math.ceil(rawMax);
  if (!(xMaxForAxis > xMinForAxis)) xMaxForAxis = xMinForAxis + 1;

  // 自定义导出按钮
  const exportAllFeature = {
    show: true,
    title: '导出为图片',
    icon: 'path://M12 2v10m0 0 4-4m-4 4-4-4M4 20h16v2H4z',
    onclick: () => { try { exportCombinedImage(); } catch(e){ console.warn('导出失败', e); } }
  };

  // 全屏按钮：基于 isFs 切换图标与标题（非独立按钮）
  const fsEnterIcon = 'path://M4 4h6v2H6v4H4V4Zm10 0h6v6h-2V6h-4V4Zm6 10v6h-6v-2h4v-4h2ZM4 14h2v4h4v2H4v-6z';
  const fsExitIcon  = 'path://M6 6h4v2H8v2H6V6Zm10 0h2v4h-2V8h-2V6h2Zm2 10v2h-4v-2h2v-2h2v2ZM6 16h2v2h4v2H6v-4z';
  const myFullscreen = {
    show: true,
    title: isFs ? '退出全屏' : '全屏查看',
    icon: isFs ? fsExitIcon : fsEnterIcon,
    onclick: () => toggleFullscreen()
  };

  // 移除原生 saveAsImage
  const toolboxFeatures = isNarrow ? {
    restore: {},
    myExportAll: exportAllFeature,
    myFullscreen
  } : {
    dataZoom: { yAxisIndex: 'none' },
    restore: {},
    myExportAll: exportAllFeature,
    myFullscreen
  };

  return {
    __empty:false,
    __titlePrefix:titlePrefix,

    backgroundColor: bgNormal,
    color: sList.map(s=>s.color),
    textStyle:{ fontFamily:t.fontFamily },
    stateAnimation: { duration: transitionMs, easing: 'cubicOut' },
    animationDurationUpdate: transitionMs,
    animationEasingUpdate: 'cubicOut',

    grid:{ left:40, right: gridRight, top: gridTop, bottom: gridBottom },

    title: { text: titleText, left: 'center', top: titleTop,
      textStyle: { color: t.axisLabel, fontSize: 20, fontWeight: 600, fontFamily:t.fontFamily } },

    legend: legendCfg,

    xAxis:{
      type:'value', name:xName, nameLocation:'middle', nameGap:25, nameMoveOverlap:true,
      nameTextStyle:{ color:t.axisName, fontWeight:600, fontFamily:t.fontFamily, textShadowColor:'rgba(0,0,0,0.28)', textShadowBlur:4, textShadowOffsetY:1 },
      axisLabel:{ color:t.axisLabel, fontSize:12, fontFamily:t.fontFamily, margin:10 },
      axisLine:{ lineStyle:{ color:t.axisLine }},
      splitLine:{ show:true, lineStyle:{ color:t.gridLine }},
      min: xMinForAxis, max: xMaxForAxis
    },
    yAxis:{
      type:'value', name:'风量(CFM)', min:0, max: built.yMax * 1.3,
      nameTextStyle:{ color:t.axisName, fontWeight:600, textShadowColor:'rgba(0,0,0,0.28)', textShadowBlur:4, textShadowOffsetY:1 },
      axisLabel:{ color:t.axisLabel }, axisLine:{ lineStyle:{ color:t.axisLine }},
      splitLine:{ show:true, lineStyle:{ color:t.gridLine }}
    },

    tooltip: {
      appendToBody: !isFs,
      confine: false,
      trigger: 'item',
      triggerOn: 'mousemove|click|touchstart|touchmove',
      // 仅保留文字颜色；其他样式使用 ECharts 默认值，保证可读性
      axisPointer: {
        type: 'cross',
        label: {
          color: t.tooltipText
        }
      },
      backgroundColor: t.tooltipBg,
      borderColor: t.tooltipBorder,
      borderWidth: 1,
      borderRadius: 12,
      textStyle: { color: t.tooltipText },
      position: function (pos, _params, dom) {
        const x = Array.isArray(pos) ? pos[0] : 0;
        const y = Array.isArray(pos) ? pos[1] : 0;
        const vw = window.innerWidth  || document.documentElement.clientWidth || 0;
        const vh = window.innerHeight || document.documentElement.clientHeight || 0;
        const dw = dom?.offsetWidth  || 0;
        const dh = dom?.offsetHeight || 0;
        const pad = 8, gap = 12;

        let left = x + gap;
        let top  = y + gap;

        if (left + dw > vw - pad) left = Math.max(pad, x - gap - dw);
        if (top  + dh > vh - pad) top  = Math.max(pad, y - gap - dh);
        if (left < pad) left = pad;
        if (top  < pad) top = pad;

        return [Math.round(left), Math.round(top)];
      },
      extraCssText: `
        position: fixed;
        backdrop-filter: blur(4px) saturate(120%);
        -webkit-backdrop-filter: blur(4px) saturate(120%);
        box-shadow: ${t.tooltipShadow};
        z-index: 1000000;
      `,
      formatter: function(p){
        const xModeNow = currentXModeFromPayload(lastPayload);
        const xLabel = xModeNow==='rpm' ? 'RPM, ' : 'dB, ';
        const infoLabel = xModeNow==='rpm' ? 'dB' : 'RPM';
        const x = p.value?.[0], y = p.value?.[1];
        const tip = p.data?.tip ?? '';
        const dot = `<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${p.color};margin-right:4px;"></span>`;
        return `${dot}${p.seriesName}<br/>&nbsp;&nbsp;&nbsp;&nbsp;${y}CFM @${x}${xLabel}${tip}${infoLabel}`;
      }
    },

    toolbox:{ top: 0, right: 0, feature:toolboxFeatures },

    dataZoom: [
      { type: 'inside', xAxisIndex: 0, throttle: 50, zoomOnMouseWheel: true, moveOnMouseWheel: true, moveOnMouseMove: true ,filterMode: "none", startValue: xMinForAxis, endValue: xMaxForAxis*0.85 },
      { type: 'inside', yAxisIndex: 0, throttle: 50, zoomOnMouseWheel: 'alt', moveOnMouseWheel: 'alt', moveOnMouseMove: true ,filterMode: "none", endValue: built.yMax}
    ],

    series: finalSeries
  };
}
  // ===== UI：X 轴切换 =====
  let xAxisOverride = null;
  let axisSnapSuppressUntil = 0;
  let axisSnapSuppressTimer = null;

  function ensureAxisOverlay(){
    let overlay = getById('chartXAxisOverlay');
    if (!overlay){
      overlay = document.createElement('div');
      overlay.id = 'chartXAxisOverlay';
      overlay.className = 'chart-xaxis-overlay';
      overlay.setAttribute('aria-label','X轴切换');
      overlay.innerHTML = `
        <div class="switch-container" id="xAxisSwitchContainer">
          <div class="switch-track" id="xAxisSwitchTrack">
            <div class="switch-slider" id="xAxisSwitchSlider">
              <span class="switch-label switch-label-right">转速</span>
              <span class="switch-label switch-label-left">噪音</span>
            </div>
          </div>
        </div>`;
      appendToRoot(overlay);

      // 不再在 JS 中设置 z-index，统一交给 CSS 分层
      overlay.style.position = 'absolute';

      bindXAxisSwitch();
      requestAnimationFrame(() => updateAxisSwitchPosition({ force: true, animate: false }));
    }
    return overlay;
  }

  function updateAxisSwitchPosition(opts = {}) {
    const { force = false, animate = false } = opts;
    // 修改点：去掉“force 例外”，在保护窗口内一律跳过，避免 render() 的刷新把动画干掉
    if (performance.now() < axisSnapSuppressUntil) return;

    const track  = getById('xAxisSwitchTrack');
    const slider = getById('xAxisSwitchSlider');
    if (!track || !slider) return;

    const sliderWidth = slider.offsetWidth || 0;
    const trackWidth  = track.offsetWidth || 0;
    const maxX = Math.max(0, trackWidth - sliderWidth);

    const currType = currentXModeFromPayload(lastPayload);
    const toNoise  = (currType === 'noise_db');

    slider.style.transition = animate ? 'transform .25s ease' : slider.style.transition || ''; // 不强行抹掉已存在的过渡
    slider.style.transform  = `translateX(${toNoise ? maxX : 0}px)`;
    track.setAttribute('aria-checked', String(toNoise));
  }

  function bindXAxisSwitch(){
    const xAxisSwitchTrack = getById('xAxisSwitchTrack');
    const xAxisSwitchSlider = getById('xAxisSwitchSlider');
    if (!xAxisSwitchTrack || !xAxisSwitchSlider) return;

    let sliderWidth = 0, trackWidth = 0, maxX = 0;
    let dragging = false, dragMoved = false, startX = 0, base = 0, activePointerId = null;

    try {
      xAxisSwitchTrack.setAttribute('role', 'switch');
      xAxisSwitchTrack.setAttribute('aria-checked', String((currentXModeFromPayload(lastPayload) || 'rpm') !== 'rpm'));
    } catch(_) {}

    function measure() { sliderWidth = xAxisSwitchSlider.offsetWidth || 0; trackWidth  = xAxisSwitchTrack.offsetWidth || 0; maxX = Math.max(0, trackWidth - sliderWidth); }
    function pos(type, animate = true) {
      const toNoise = (type === 'noise_db' || type === 'noise');
      const x = toNoise ? maxX : 0;
      xAxisSwitchSlider.style.transition = animate ? 'transform .5s ease' : 'none';
      xAxisSwitchSlider.style.transform  = `translateX(${x}px)`;
      xAxisSwitchTrack.setAttribute('aria-checked', String(toNoise));
    }
    function protectSliderAnimationWindow() {
      axisSnapSuppressUntil = performance.now() + 360;
      clearTimeout(axisSnapSuppressTimer);
      axisSnapSuppressTimer = setTimeout(() => { axisSnapSuppressUntil = 0; }, 400);
    }
    xAxisSwitchSlider.addEventListener('transitionend', () => { axisSnapSuppressUntil = 0; });

    function applyType(newType) {
      const normalized = (newType === 'noise') ? 'noise_db' : newType;
      if (normalized !== 'rpm' && normalized !== 'noise_db') return;
      if (xAxisOverride === normalized) return;
      xAxisOverride = normalized;
      try { localStorage.setItem('x_axis_type', normalized); } catch(_){}
      pos(normalized, true);
      protectSliderAnimationWindow();

      __skipSpectrumOnce = true;
      __suppressSpectrumUntil = performance.now() + 420;  // 抑制 ~420ms，覆盖 ECharts 异步 dataZoom
      if (lastPayload) render(lastPayload);
      if (typeof onXAxisChange === 'function') { try { onXAxisChange(normalized); } catch(_) {} }
    }

    function nearestType() {
      const m = new DOMMatrix(getComputedStyle(xAxisSwitchSlider).transform);
      const cur = m.m41 || 0;
      return cur > maxX / 2 ? 'noise_db' : 'rpm';
    }

    function onPointerDown(e) {
      if (e.button !== undefined && e.button !== 0) return;
      measure();
      dragging = true; dragMoved = false;
      activePointerId = e.pointerId ?? null;
      startX = e.clientX;
      const m = new DOMMatrix(getComputedStyle(xAxisSwitchSlider).transform);
      base = m.m41 || 0;
      xAxisSwitchSlider.style.transition = 'none';
      try { if (activePointerId != null) xAxisSwitchSlider.setPointerCapture(activePointerId); } catch(_){}
      e.preventDefault?.();
    }
    function onPointerMove(e) {
      if (!dragging) return;
      const dx = e.clientX - startX;
      if (!dragMoved && Math.abs(dx) > 2) dragMoved = true;
      let x = base + dx;
      x = Math.max(0, Math.min(x, maxX));
      xAxisSwitchSlider.style.transform = `translateX(${x}px)`;
    }
    function finishDrag() {
      if (!dragging) return;
      dragging = false;
      try { if (activePointerId != null) xAxisSwitchSlider.releasePointerCapture(activePointerId); } catch(_){}
      activePointerId = null;
      const newType = nearestType();
      pos(newType, true);
      applyType(newType);
    }
    function cancelDrag() {
      if (!dragging) return;
      dragging = false;
      try { if (activePointerId != null) xAxisSwitchSlider.releasePointerCapture(activePointerId); } catch(_){}
      activePointerId = null;
      pos(currentXModeFromPayload(lastPayload), true);
    }

    xAxisSwitchTrack.addEventListener('click', (e) => {
      e.preventDefault();     // 关键：阻止任何潜在默认行为（例如提交）
      e.stopPropagation();    // 关键：不让点击冒泡到上层表单或容器
      if (dragMoved) { dragMoved = false; return; }
      const curr = currentXModeFromPayload(lastPayload);
      const next = (curr === 'rpm') ? 'noise_db' : 'rpm';
      pos(next, true);
      applyType(next);
    });

    xAxisSwitchTrack.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerup', finishDrag, { passive: true });
    window.addEventListener('pointercancel', cancelDrag);
    window.addEventListener('blur', cancelDrag);

    measure();
    pos(currentXModeFromPayload(lastPayload), false);
    window.addEventListener('resize', () => { const keep = currentXModeFromPayload(lastPayload); measure(); pos(keep, false); }, { passive:true });
  }

  function placeAxisOverlayAt(x, y, show){
    const overlay = ensureAxisOverlay();
    const off = window.__FS_TOGGLE_OFFSET || { x: 0, y: 0 };
    overlay.style.left = (x + (Number(off.x)||0)) + 'px';
    overlay.style.top  = (y + (Number(off.y)||0)) + 'px';
    overlay.style.visibility = show ? 'visible' : 'hidden';
    requestAnimationFrame(() => updateAxisSwitchPosition({ force:true, animate:false }));
  }

// 在 ensureFitUI 内，更新 bubble.innerHTML，新增 footer 与“关闭”按钮，并绑定点击事件。
function ensureFitUI(){
  let btns = getById('fitButtons');
  if (!btns){
    btns = document.createElement('div');
    btns.id = 'fitButtons';
    btns.className = 'fit-buttons';
    btns.innerHTML = `
      <button class="btn" id="btnFit" type="button">实时拟合</button>
    `;
    appendToRoot(btns);

    const btnFit = btns.querySelector('#btnFit');
    function syncButtons(){
      btnFit.classList.toggle('active', showFitCurves);
    }

    btnFit.addEventListener('click', (e)=>{
      e.preventDefault();
      e.stopPropagation();
      showFitCurves = !showFitCurves;
      bubbleUserMoved = false;
      bubblePos.left = null;
      bubblePos.top  = null;

      syncButtons();
      toggleFitUI(showFitCurves);
      placeFitUI();
      repaintPointer();
      if (showFitCurves) refreshFitBubble(); else {
        const bubble = getById('fitBubble');
        if (bubble) bubble.style.visibility = 'hidden';
      }
    });

    syncButtons();
  }

  // 气泡
  let bubble = getById('fitBubble');
  if (!bubble){
    bubble = document.createElement('div');
    bubble.id = 'fitBubble';
    bubble.className = 'fit-bubble';
    bubble.innerHTML = `
      <div class="head">
        <div class="title">${FIT_ALGO_NAME} 估算值</div>
        <div class="x-input">
          <span>当前位置</span>
          <input id="fitXInput" type="number" step="1" />
          <span id="fitXUnit"></span>
        </div>
      </div>
      <div id="fitBubbleRows"></div>
      <div class="foot">
        <div class="hint">按系列可见性（Legend）过滤，按风量从大到小排序</div>
        <button id="fitCloseBtn" class="btn-close" type="button">关闭</button>
      </div>
    `;
    document.body.appendChild(bubble);
    bubble.style.position = 'fixed';

    adoptBubbleHost();
    bindBubbleDrag(bubble);

    const xInput = bubble.querySelector('#fitXInput');
    xInput.addEventListener('input', onBubbleInputLive);
    xInput.addEventListener('change', onBubbleInputCommit);
    xInput.addEventListener('keydown', (e)=>{ if (e.key === 'Enter') { onBubbleInputCommit(); } });

    // 关闭按钮：关闭拟合（等效于取消“实时拟合”）
    const btnsRoot = getById('fitButtons');
    const btnFit = btnsRoot ? btnsRoot.querySelector('#btnFit') : null;
    const btnClose = bubble.querySelector('#fitCloseBtn');
    if (btnClose){
        btnClose.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          showFitCurves = false;
          if (btnFit) btnFit.classList.remove('active');
          toggleFitUI(false);
          // 新增：复原 rail
          updateRailParkedState();
          repaintPointer();
        });
    }
  }

  // 指针
  let ptr = getById('fitPointer');
  if (!ptr){
    ptr = document.createElement('div');
    ptr.id = 'fitPointer';
    ptr.className = 'fit-pointer';
    ptr.innerHTML = `<div class="line"></div><div class="handle" id="fitPointerHandle"></div>`;
    appendToRoot(ptr);
    bindPointerDrag();
  }
}

  let bubbleUserMoved = false;
  const bubblePos = { left: null, top: null };

  function bindBubbleDrag(bubble){
    if (!bubble) return;

    let activePointerId = null;
    let startX = 0, startY = 0;
    let baseLeftFixed = 0, baseTopFixed = 0;
    let rStart = null;
    let dragging = false;
    const DRAG_THRESHOLD = 4;
    const pad = 6;

    function isInteractiveTarget(el){
      return !!(el && (el.closest('input, textarea, select, button, [contenteditable=""], [contenteditable="true"]')));
    }
    function onPointerDown(e){
      if (e.button !== undefined && e.button !== 0) return;
      if (isInteractiveTarget(e.target)) return;

      // 记录拖拽起点（以 viewport/fixed 坐标）
      const rect = bubble.getBoundingClientRect();
      baseLeftFixed = rect.left;
      baseTopFixed  = rect.top;
      startX = e.clientX; startY = e.clientY;
      rStart = root ? root.getBoundingClientRect() : { left:0, top:0 };

      dragging = false;
      activePointerId = e.pointerId ?? null;
      try { if (activePointerId != null) bubble.setPointerCapture(activePointerId); } catch(_){}
    }
    function onPointerMove(e){
      if (activePointerId != null && (e.pointerId ?? null) !== activePointerId) return;
      if (activePointerId == null) return;

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      if (!dragging && Math.hypot(dx, dy) > DRAG_THRESHOLD){
        dragging = true;
        bubble.classList.add('dragging');
      }
      if (!dragging) return;

      // 允许拖出图表区域：只对可视区做轻微钳制，避免完全丢失
      const bw = bubble.offsetWidth  || 0;
      const bh = bubble.offsetHeight || 0;
      const vw = window.innerWidth, vh = window.innerHeight;

      let newLeft = baseLeftFixed + dx;
      let newTop  = baseTopFixed  + dy;

      newLeft = Math.min(Math.max(-bw + pad, newLeft), Math.max(pad, vw - pad));
      newTop  = Math.min(Math.max(-bh + pad, newTop ), Math.max(pad, vh - pad));

      bubble.style.left = Math.round(newLeft) + 'px';
      bubble.style.top  = Math.round(newTop)  + 'px';
      bubble.style.right  = 'auto';
      bubble.style.bottom = 'auto';

      // 将 fixed 坐标换算为“相对图表”的偏移，后续滚动/缩放时据此还原
      const rNow = rStart || (root ? root.getBoundingClientRect() : { left:0, top:0 });
      bubblePos.left = newLeft - rNow.left;
      bubblePos.top  = newTop  - rNow.top;
      bubbleUserMoved = true;
    }
    function endDrag(){
      if (activePointerId == null) return;
      try { bubble.releasePointerCapture(activePointerId); } catch(_){}
      activePointerId = null; dragging = false; bubble.classList.remove('dragging');
    }

    bubble.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove, { passive:true });
    window.addEventListener('pointerup',   endDrag,       { passive:true  });
    window.addEventListener('pointercancel', endDrag,     { passive:true  });
    window.addEventListener('blur', endDrag);
  }

  function toggleFitUI(showFit){
      const btns = getById('fitButtons');
      const bubble = getById('fitBubble');
      const ptr = getById('fitPointer');
      const empty  = !lastOption || lastOption.__empty;

      if (btns) btns.style.visibility = empty ? 'hidden' : 'visible';

      const showFloating = showFit && !empty; // 窄屏也允许
      if (bubble) bubble.style.visibility = showFloating ? 'visible' : 'hidden';
      if (ptr)    ptr.style.visibility    = showFloating ? 'visible' : 'hidden';

      // 新增：根据气泡状态切换 rail 是否停靠
      updateRailParkedState();
    }

// 修改：placeFitUI —— 有 rail 时，按钮不再用绝对/固定定位
function placeFitUI(){
  const btns = getById('fitButtons');
  const bubble = getById('fitBubble');
  if (!lastOption) return;

  const grid = lastOption.grid || { left:40, right: 260, top: 60, bottom: 40 };
  const left = (typeof grid.left==='number') ? grid.left : 40;
  const top = (typeof grid.top==='number') ? grid.top : 60;

  // 如果 rail 存在：按钮交给 rail 布局，不需要定位
  if (btns && __legendActionsEl) {
    btns.style.position = 'static';
    btns.style.right = '';
    btns.style.bottom = '';
    btns.style.visibility = (lastOption.__empty) ? 'hidden' : 'visible';
  } else if (btns) {
    // 回退：保持原有逻辑
    const narrow = layoutIsNarrow();
    btns.style.flexDirection = narrow ? 'column' : 'row';
    if (isFs) {
      btns.style.position = 'fixed';
      btns.style.right = '12px';
      btns.style.bottom = '12px';
    } else {
      btns.style.position = 'absolute';
      btns.style.right = '10px';
      btns.style.bottom = '10px';
    }
    btns.style.visibility = (lastOption.__empty) ? 'hidden' : 'visible';
  }

  if (bubble){
    const r = root ? root.getBoundingClientRect() : { left:0, top:0 };
    const defaultOffsetX = left;
    const defaultOffsetY = top;

    let offX, offY;
    if (!bubbleUserMoved || bubblePos.left == null || bubblePos.top == null){
      offX = defaultOffsetX;
      offY = defaultOffsetY;
      bubblePos.left = offX;
      bubblePos.top  = offY;
    } else {
      offX = bubblePos.left;
      offY = bubblePos.top;
    }

    let fx = r.left + offX;
    let fy = r.top  + offY;

    bubble.style.position = 'fixed';
    bubble.style.left = Math.round(fx) + 'px';
    bubble.style.top  = Math.round(fy) + 'px';
    bubble.style.right  = 'auto';
    bubble.style.bottom = 'auto';

    const showFloating = showFitCurves && !lastOption.__empty;
    bubble.style.visibility = showFloating ? 'visible' : 'hidden';

    const unit = (currentXModeFromPayload(lastPayload) === 'rpm') ? 'RPM' : 'dB';
    const unitSpan = bubble.querySelector('#fitXUnit');
    if (unitSpan) unitSpan.textContent = unit;
  }
}


  function bindPointerDrag(){
    const handle = getById('fitPointerHandle');
    if (!handle) return;

    let dragging=false, startX=0, baseX=0, activePointerId=null;

    function measureGrid(){
      if (!lastOption) return { left:40, right: (chart ? chart.getWidth() - 260 : 800), top: 60, height: 300 };
      const grid = lastOption.grid || { left:40, right: 260, top: 60, bottom: 40 };
      const chartW = chart ? chart.getWidth() : (root ? root.clientWidth : 800);
      const chartH = chart ? chart.getHeight() : (root ? root.clientHeight : 600);
      const left = (typeof grid.left==='number') ? grid.left : 40;
      const rightGap = (typeof grid.right==='number') ? grid.right : 260;
      const top = (typeof grid.top==='number') ? grid.top : 60;
      const bottomGap = (typeof grid.bottom==='number') ? grid.bottom : 40;
      const right = chartW - rightGap;
      const height = chartH - top - bottomGap;
      return { left, right, top, height };
    }

    function onDown(e){
      if (e.button !== undefined && e.button !== 0) return;
      dragging = true;
      activePointerId = e.pointerId ?? null;
      startX = e.clientX;
      const ptr = getById('fitPointer');
      baseX = parseFloat(ptr?.style.left || '0');
      handle.style.cursor = 'grabbing';
      try { if (activePointerId != null) handle.setPointerCapture(activePointerId); } catch(_){}
      e.preventDefault?.();
    }
    function onMove(e){
      if (!dragging) return;
      const grid = measureGrid();
      const dx = e.clientX - startX;
      let x = baseX + dx;
      x = Math.max(grid.left, Math.min(x, grid.right));
      const ptr = getById('fitPointer');
      ptr.style.left = x + 'px';

      const xVal = pxToDataX(x);
      const mode = currentXModeFromPayload(lastPayload);
      if (Number.isFinite(xVal)) {
        xQueryByMode[mode] = clampXDomain(xVal);
        syncBubbleInput();
        if (showFitCurves) refreshFitBubble();
        // 实时同步频谱
        if (spectrumEnabled && spectrumChart) scheduleSpectrumRebuild();
      }
    }
    function onUp(){
      if (!dragging) return;
      dragging=false;
      handle.style.cursor = 'grab';
      try { if (activePointerId != null) handle.releasePointerCapture(activePointerId); } catch(_){}
      activePointerId=null;
    }
    function onCancel(){
      if (!dragging) return;
      dragging=false;
      handle.style.cursor = 'grab';
      try { if (activePointerId != null) handle.releasePointerCapture(activePointerId); } catch(_){}
      activePointerId=null;
    }

    handle.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove, { passive:true });
    window.addEventListener('pointerup', onUp, { passive:true });
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onCancel);
  }

  function scheduleSpectrumRebuild(){
    if (!spectrumEnabled || !spectrumChart) return;
    if (__spectrumRaf) return;
    __spectrumRaf = requestAnimationFrame(() => {
      __spectrumRaf = null;
      buildAndSetSpectrumOption();
    });
  }

  function pxToDataX(xPixel){
    try { return chart.convertFromPixel({ xAxisIndex: 0 }, xPixel); } catch(e){ return NaN; }
  }
  function dataToPxX(xData){
    try { return chart.convertToPixel({ xAxisIndex: 0 }, xData); } catch(e){ return NaN; }
  }

  function repaintPointer(){
    const ptr = getById('fitPointer');
    if (!ptr || !lastOption) return;
    // 窄屏也显示拟合指针
    if (!showFitCurves || lastOption.__empty) { ptr.style.visibility = 'hidden'; return; }

    const grid = lastOption.grid || { left:40, right: 260, top: 60, bottom: 40 };
    const chartW = chart ? chart.getWidth() : (root ? root.clientWidth : 800);
    const chartH = chart ? chart.getHeight() : (root ? root.clientHeight : 600);
    const left = (typeof grid.left==='number') ? grid.left : 40;
    const rightGap = (typeof grid.right==='number') ? grid.right : 260;
    const top = (typeof grid.top==='number') ? grid.top : 60;
    const bottomGap = (typeof grid.bottom==='number') ? grid.bottom : 40;
    const height = chartH - top - bottomGap;

    const mode = currentXModeFromPayload(lastPayload);
    if (xQueryByMode[mode] == null) {
      const [vx0, vx1] = getVisibleXRange();
      xQueryByMode[mode] = (vx0 + vx1) / 2;
    }
    clampXQueryIntoVisibleRange();

    const xPixel = dataToPxX(xQueryByMode[mode]);
    if (!Number.isFinite(xPixel)) { ptr.style.visibility = 'hidden'; return; }

    ptr.style.position = 'absolute';
    ptr.style.left = xPixel + 'px';
    ptr.style.top = top + 'px';
    ptr.style.height = height + 'px';
    ptr.style.visibility = 'visible';

    syncBubbleInput();
    if (showFitCurves) refreshFitBubble();
  }

  function syncBubbleInput(){
    const inp = getById('fitXInput');
    if (!inp) return;
    const mode = currentXModeFromPayload(lastPayload);
    const val = Number(xQueryByMode[mode]);
    const rounded = (mode === 'noise_db') ? Number(val.toFixed(1)) : Math.round(val);
    inp.value = String(rounded);

    const [vx0, vx1] = getVisibleXRange();
    inp.setAttribute('min', String(Math.floor(vx0)));
    inp.setAttribute('max', String(Math.ceil(vx1)));
    inp.setAttribute('step', (mode === 'noise_db') ? '0.1' : '1');
  }

  function onBubbleInputLive(){
    const inp = getById('fitXInput');
    if (!inp) return;
    const mode = currentXModeFromPayload(lastPayload);
    const raw = Number(inp.value);
    if (!Number.isFinite(raw)) return;
    xQueryByMode[mode] = clampXDomain(raw);
    clampXQueryIntoVisibleRange();

    const xPixel = dataToPxX(xQueryByMode[mode]);
    const ptr = getById('fitPointer');
    if (ptr && Number.isFinite(xPixel)) ptr.style.left = xPixel + 'px';

    if (showFitCurves) refreshFitBubble();
    // 实时同步频谱
    if (spectrumEnabled && spectrumChart) scheduleSpectrumRebuild();
  }
  function onBubbleInputCommit(){
    repaintPointer();
    refreshFitBubble();
    // 实时同步频谱
    if (spectrumEnabled && spectrumChart) scheduleSpectrumRebuild();
  }

function refreshFitBubble(){
  const bubble = getById('fitBubble');
  if (!bubble || !showFitCurves || !lastPayload || !chart) return;
  if (lastOption && lastOption.__empty) { bubble.style.visibility = 'hidden'; return; }
  const rowsEl = bubble.querySelector('#fitBubbleRows');
  const mode = currentXModeFromPayload(lastPayload);
  const x = xQueryByMode[mode];
  if (x == null) return;

  const sList = Array.isArray(lastPayload?.chartData?.series) ? lastPayload.chartData.series : [];
  ensureFitModels(sList, mode);

  const opt = chart.getOption() || {};
  const selMap = (opt.legend && opt.legend[0] && opt.legend[0].selected) || {};

  const items = [];
  sList.forEach(s => {
    const selected = (selMap[s.name] !== false);
    const model = fitModelsCache[mode].get(s.name);
    const crossModel = (s && s.pchip)
      ? (mode === 'rpm' ? s.pchip?.rpm_to_noise_db : s.pchip?.noise_to_rpm)
      : null;

    let y = NaN;
    if (model && model.x0 != null && model.x1 != null) {
      const dom0 = Math.min(model.x0, model.x1);
      const dom1 = Math.max(model.x0, model.x1);
      if (x >= dom0 && x <= dom1) y = evalPchipJS(model, x);
    }

    let crossVal = NaN;
    if (crossModel && crossModel.x0 != null && crossModel.x1 != null) {
      const c0 = Math.min(crossModel.x0, crossModel.x1);
      const c1 = Math.max(crossModel.x0, crossModel.x1);
      if (x >= c0 && x <= c1) crossVal = evalPchipJS(crossModel, x);
    }

    items.push({ name: s.name, color: s.color, selected, y, cross: crossVal });
  });

  const fmtCFM = (v)=> Math.round(v);
  const withVal = items.filter(it => Number.isFinite(it.y)).sort((a,b)=> b.y - a.y);
  const noVal   = items.filter(it => !Number.isFinite(it.y));

  const base = (withVal.length && withVal[0].y > 0) ? withVal[0].y : 0;
  const pctVal = (v)=> (Number.isFinite(v) && base > 0) ? Math.round((v / base) * 100) : null;

  const valTexts = items.map(it => Number.isFinite(it.y) ? `${fmtCFM(it.y)} CFM` : '-');
  const maxValChars = valTexts.reduce((m,s)=>Math.max(m, s.length), 1);
  const pctWidthCh = 6;

  const pad4 = (n) => {
    const s = String(Math.round(Number(n)));
    return s.length < 4 ? (' '.repeat(4 - s.length) + s) : s;
  };

  const ordered = withVal.concat(noVal);
  rowsEl.innerHTML = ordered.map(it => {
    const hasY = Number.isFinite(it.y);
    const valText = hasY ? `${fmtCFM(it.y)} CFM` : '-';
    const pct = hasY ? pctVal(it.y) : null;
    const pctText = (pct==null) ? '-' : `(${pct}%)`;

    const hasCross = Number.isFinite(it.cross);
    let crossHTML = '';
    if (hasCross) {
      if (mode === 'noise_db') {
        const rpmDigits = pad4(it.cross);
        crossHTML = `<span style="display:inline-block; width:4ch; text-align:right; font-variant-numeric:tabular-nums;">${rpmDigits}</span> RPM`;
      } else {
        crossHTML = `${Number(it.cross).toFixed(1)} dB`;
      }
    }

    const crossBlock = hasCross
      ? `
          <span class="sep" style="color:var(--text-); opacity:.5; margin:0 8px;">│</span>
          <span style="color:var(--text-); font-variant-numeric:tabular-nums;">${crossHTML}</span>
        `
      : '';

    if (!hasY) {
      return `
        <div class="row ${it.selected ? '' : 'is-off'}" data-name="${it.name}">
          <span class="dot" style="background:${it.color}"></span>
          <span>${it.name}</span>
          <span style="margin-left:auto; display:inline-flex; align-items:center; gap:0;">
            <span style="color:var(--text-); font-variant-numeric:tabular-nums;">-</span>
          </span>
        </div>
      `;
    }

    return `
      <div class="row ${it.selected ? '' : 'is-off'}" data-name="${it.name}">
        <span class="dot" style="background:${it.color}"></span>
        <span>${it.name}</span>
        <span style="margin-left:auto; display:inline-flex; align-items:center; gap:0;">
          <span style="min-width:${maxValChars}ch; text-align:right; font-weight:800; font-variant-numeric:tabular-nums;">${valText}</span>
          <span style="width:${pctWidthCh}ch; text-align:right; font-variant-numeric:tabular-nums;">${pctText}</span>
          ${crossBlock}
        </span>
      </div>
    `;
  }).join('');

  // 绑定交互：悬停高亮、点击切换显隐；并避免触发气泡拖拽
  rowsEl.querySelectorAll('.row[data-name]').forEach(node => {
    const name = node.getAttribute('data-name') || '';

    node.addEventListener('pointerdown', (e) => { e.stopPropagation(); }, { passive:true });

    node.addEventListener('mouseenter', () => {
      if (!name) return;
      try { chart.dispatchAction({ type: 'highlight', seriesName: name }); } catch(_){}
      if (spectrumEnabled && spectrumChart) {
        try { spectrumChart.dispatchAction({ type: 'highlight', seriesName: name }); } catch(_){}
      }
    }, { passive:true });

    node.addEventListener('mouseleave', () => {
      if (!name) return;
      try { chart.dispatchAction({ type: 'downplay', seriesName: name }); } catch(_){}
      if (spectrumEnabled && spectrumChart) {
        try { spectrumChart.dispatchAction({ type: 'downplay', seriesName: name }); } catch(_){}
      }
    }, { passive:true });

    node.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!name) return;

      const sel = getLegendSelectionMap();
      const isCurrentlyVisible = sel ? (sel[name] !== false) : true;
      const actionType = isCurrentlyVisible ? 'legendUnSelect' : 'legendSelect';

      // 主图与频谱图都用 dispatchAction 切换显隐（会有动画）
      try { chart.dispatchAction({ type: actionType, name }); } catch(_){}
      if (spectrumEnabled && spectrumChart) {
        try { spectrumChart.dispatchAction({ type: actionType, name }); } catch(_){}
        // 删除：scheduleSpectrumRebuild();  // 这会触发整图重建，导致动画丢失
      }

      try { syncLegendRailFromChart(); } catch(_){}
      refreshFitBubble();
    });
  });
}

  function ensureFitModels(sList, xMode){
    const models = fitModelsCache[xMode];
    sList.forEach(s => {
      const ph = s && s.pchip
        ? (xMode === 'noise_db' ? s.pchip.noise_to_airflow : s.pchip.rpm_to_airflow)
        : null;

      if (ph && Array.isArray(ph.x) && Array.isArray(ph.y) && Array.isArray(ph.m) && ph.x0 != null && ph.x1 != null) {
        models.set(s.name, ph);
      } else {
        models.delete(s.name);
      }
    });
  }

  function evalPchipJS(model, x){
    if (!model || !Array.isArray(model.x) || !Array.isArray(model.y) || !Array.isArray(model.m)) return NaN;
    const xs = model.x, ys = model.y, ms = model.m;
    const n = xs.length;
    if (n === 0) return NaN;
    if (n === 1) return ys[0];

    let xv = x;
    if (xv <= xs[0]) xv = xs[0];
    if (xv >= xs[n - 1]) xv = xs[n - 1];

    let lo = 0, hi = n - 2, i = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= xv && xv <= xs[mid + 1]) { i = mid; break; }
      if (xv < xs[mid]) hi = mid - 1; else lo = mid + 1;
    }
    if (lo > hi) i = Math.max(0, Math.min(n - 2, lo));

    const x0 = xs[i], x1 = xs[i + 1];
    const h = (x1 - x0) || 1;
    const t = (xv - x0) / h;
    const y0 = ys[i], y1 = ys[i + 1];
    const m0 = ms[i] * h, m1 = ms[i + 1] * h;

    const h00 = (2 * t*t*t - 3 * t*t + 1);
    const h10 = (t*t*t - 2 * t*t + t);
    const h01 = (-2 * t*t*t + 3 * t*t);
    const h11 = (t*t*t - t*t);
    return h00 * y0 + h10 * m0 + h01 * y1 + h11 * m1;
  }

  function computeSampleCount(widthPx){
    const n = Math.round(widthPx / 20); // 每 20px 一个点
    return Math.max(20, Math.min(50, n));
  }

  function resampleSingle(model, xmin, xmax, count){
    const n = Math.max(2, (count|0));
    const pts = [];
    const dom0 = Math.min(model.x0, model.x1);
    const dom1 = Math.max(model.x0, model.x1);
    const x0 = Math.max(xmin, dom0);
    const x1 = Math.min(xmax, dom1);
    if (!(x1 > x0)) return pts;
    for (let i = 0; i < n; i++){
      const t = (n === 1) ? 0 : (i / (n - 1));
      const x = x0 + (x1 - x0) * t;
      const y = evalPchipJS(model, x);
      pts.push({ x, y: Number.isFinite(y) ? y : NaN });
    }
    return pts;
  }

  function clampXDomain(val){
    if (!lastOption) return val;
    const xAxis = lastOption.xAxis || {};
    const xmin = Number(xAxis.min); const xmax = Number(xAxis.max);
    if (!Number.isFinite(xmin) || !Number.isFinite(xmax)) return val;
    return Math.max(xmin, Math.min(val, xmax));
  }

  function getVisibleXRange(){
    if (!lastOption) return [0,1];
    const xAxis = lastOption.xAxis || {};
    const xmin = Number(xAxis.min); const xmax = Number(xAxis.max);
    let vmin = xmin, vmax = xmax;
    const opt = chart.getOption() || {};
    const dz = (opt.dataZoom||[]).find(z => z.xAxisIndex === 0 || (z.xAxisIndex||0)===0) || null;
    if (dz && typeof dz.start === 'number' && typeof dz.end === 'number') {
      const span = xmax - xmin;
      vmin = xmin + span * (dz.start/100);
      vmax = xmin + span * (dz.end/100);
    }
    return [vmin, vmax];
  }

  function clampXQueryIntoVisibleRange(){
    const mode = currentXModeFromPayload(lastPayload);
    if (xQueryByMode[mode] == null) return;
    const [vmin, vmax] = getVisibleXRange();
    if (xQueryByMode[mode] < vmin) xQueryByMode[mode] = vmin;
    if (xQueryByMode[mode] > vmax) xQueryByMode[mode] = vmax;
  }

  async function enterFullscreen(){
    const shell = document.getElementById('chart-settings');
    const target = shell || (root && root.parentElement) || root || document.documentElement;
  
    try {
      if (target.requestFullscreen) { await target.requestFullscreen(); }
      else { await document.documentElement.requestFullscreen(); }
      isFs = true;
      if (isMobile() && screen.orientation && screen.orientation.lock) {
        try { await screen.orientation.lock('landscape'); } catch(_) {}
      }
    } catch(err){
      console.warn('requestFullscreen 失败：', err);
    } finally {
      adoptBubbleHost();
      bubbleUserMoved = false;
  
      updateFullscreenHeights();
      if (lastPayload) render(lastPayload); else if (chart) chart.resize();
  
      requestAnimationFrame(() => {
        try {
          placeFitUI(); repaintPointer(); updateSpectrumLayout();
          updateLegendRailLayout();  // 全屏下立刻重排 rail
          updateLegendRail();
        } catch(_) {}
      });
    }
  }

  async function exitFullscreen(){
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
    } catch(err) {
      console.warn('exitFullscreen 失败：', err);
    } finally {
      isFs = false;
      adoptBubbleHost();
      bubbleUserMoved = false;
  
      // 退出全屏：先修正 minHeight，再做一次布局收敛，避免高度偏大
      if (spectrumEnabled) {
        __ensureMainChartMinHeightForSpectrumMode();
      } else {
        if (root) try { root.style.minHeight = ''; } catch(_) {}
      }
  
      updateFullscreenHeights();
      updateSpectrumLayout();
  
      if (lastPayload) render(lastPayload);
      else if (chart) chart.resize();
  
      requestAnimationFrame(() => {
        try { placeFitUI(); repaintPointer(); } catch(_) {}
      });
    }
  }
  
  function toggleFullscreen(){ if (document.fullscreenElement) exitFullscreen(); else enterFullscreen(); }

  function ensureSpectrumChart() {
    ensureSpectrumHost();
    if (spectrumChart || !window.echarts || !spectrumInner) return;
    spectrumChart = echarts.init(spectrumInner, null, { renderer:'canvas', devicePixelRatio: window.devicePixelRatio || 1 });
  }

async function toggleSpectrumUI(show) {
  ensureSpectrumHost();
  spectrumEnabled = !!show;
  if (!spectrumRoot) return;

  specBumpEpochAndClearTimers();

  const shell =
    document.getElementById('chart-settings') ||
    (root && root.closest('.fc-chart-container')) ||
    document.documentElement;

  try { spectrumChart && spectrumChart.dispatchAction({ type: 'hideTip' }); } catch(_) {}

  const bgMs = getCssTransitionMs();
  const safetyMs = Math.max(240, bgMs + 120);
  const myEpoch = __specEpoch;

  if (show) {
    ensureSpectrumChart();

    if (isFs) {
      // 关键：先标记为 spectrum 模式，避免 :fullscreen:not([data-chart-mode="spectrum"]) 把高度钳成 0
      try { shell.setAttribute('data-chart-mode', 'spectrum'); } catch(_) {}

      // 全屏：沿用 max-height 逻辑
      spectrumRoot.style.setProperty('flex', '0 0 auto', 'important');
      spectrumRoot.style.setProperty('max-height', '0px');

      const targetPx = __computeFsSpecTargetPx();
      spectrumRoot.style.setProperty('--fs-spec-h', targetPx + 'px');
      void spectrumRoot.offsetHeight;

      requestAndRenderSpectrum().catch(()=>{}).then(() => {
        if (myEpoch !== __specEpoch) return;
        try { spectrumChart && spectrumChart.resize(); } catch(_) {}
      });

      requestAnimationFrame(() => {
        if (myEpoch !== __specEpoch) return;
        const onEnd = (e) => {
          if (myEpoch !== __specEpoch) return;
          if (e && e.propertyName && e.propertyName !== 'max-height') return;
          try { spectrumRoot.removeEventListener('transitionend', onEnd); } catch(_) {}
          try { chart && chart.resize(); } catch(_) {}
          try { spectrumChart && spectrumChart.resize(); } catch(_) {}
        };
        try { spectrumRoot.addEventListener('transitionend', onEnd, { once: true }); } catch(_) {}
        spectrumRoot.style.setProperty('max-height', targetPx + 'px');
      });
    } else {
      // 非全屏：先把 inner 固定到“目标像素高”，立即 resize 一次；父容器靠 CSS 过渡做揭示
      const targetPx = __computeNfSpecTargetPx();
      if (spectrumInner) {
        spectrumInner.style.height = targetPx + 'px';
        try { ensureSpectrumChart(); spectrumChart && spectrumChart.resize(); } catch(_) {}
        spectrumInner.style.transition = 'transform var(--transition-speed, .25s) ease';
        spectrumInner.style.opacity = '1';
      }
      spectrumRoot.classList.add('anim-scale', 'reveal-from-0');
      try { shell.setAttribute('data-chart-mode', 'spectrum'); } catch(_) {}
      requestAndRenderSpectrum().catch(()=>{}).then(() => {
        if (myEpoch !== __specEpoch) return;
        try { spectrumChart && spectrumChart.resize(); } catch(_) {}
      });
      requestAnimationFrame(() => {
        if (myEpoch !== __specEpoch) return;
        const onEnd = (e) => {
          if (myEpoch !== __specEpoch) return;
          if (e && e.propertyName !== 'height') return;
          try { spectrumRoot.removeEventListener('transitionend', onEnd); } catch(_) {}
          spectrumRoot.classList.remove('anim-scale', 'reveal-from-0', 'revealed');
          if (spectrumInner) {
            spectrumInner.style.transition = '';
            spectrumInner.style.opacity = '';
            spectrumInner.style.height = '';
          }
          try { spectrumChart && spectrumChart.resize(); } catch(_) {}
          revealSpectrumIfNeeded();
        };
        try { spectrumRoot.addEventListener('transitionend', onEnd, { once:true }); } catch(_) {}
        spectrumRoot.classList.add('revealed');
        specSetTimeout(() => {
          if (myEpoch !== __specEpoch) return;
          spectrumRoot.classList.remove('anim-scale', 'reveal-from-0', 'revealed');
          if (spectrumInner) {
            spectrumInner.style.transition = '';
            spectrumInner.style.opacity = '';
            spectrumInner.style.height = '';
          }
        }, safetyMs);
      });
    }
  } else {
    // 收起分支保持原实现（cleanupAfter 会移除 data-chart-mode）
    const cleanupAfter = () => {
      if (myEpoch !== __specEpoch) return;
      try { shell.removeAttribute('data-chart-mode'); } catch(_) {}
      if (root) try { root.style.minHeight = ''; } catch(_) {}
      spectrumRoot.classList.remove('anim-scale', 'revealed', 'reveal-from-0', 'collapse-to-0');
      if (spectrumInner) {
        spectrumInner.style.transition = '';
        spectrumInner.style.opacity = '';
        spectrumInner.style.height = '';
      }
      try {
        spectrumRoot.style.removeProperty('max-height');
        spectrumRoot.style.removeProperty('flex');
      } catch(_) {}
    };

    if (isFs) {
      const curH = Math.max(1, Math.round((spectrumRoot.getBoundingClientRect().height || 1)));
      spectrumRoot.style.setProperty('flex', '0 0 auto', 'important');
      spectrumRoot.style.setProperty('--fs-spec-h', curH + 'px');
      spectrumRoot.style.setProperty('max-height', curH + 'px');

      requestAnimationFrame(() => {
        if (myEpoch !== __specEpoch) return;
        const onEnd = (e) => {
          if (myEpoch !== __specEpoch) return;
          if (e && e.propertyName && e.propertyName !== 'max-height') return;
          try { spectrumRoot.removeEventListener('transitionend', onEnd); } catch(_) {}
          cleanupAfter();
          try {
            spectrumRoot.style.removeProperty('max-height');
            spectrumRoot.style.removeProperty('flex');
            spectrumRoot.style.removeProperty('--fs-spec-h');
          } catch(_) {}
          updateFullscreenHeights();
          try { chart && chart.resize(); } catch(_) {}
        };
        try { spectrumRoot.addEventListener('transitionend', onEnd, { once:true }); } catch(_) {}
        spectrumRoot.style.setProperty('max-height', '0px');
      });

      specSetTimeout(() => { try { cleanupAfter(); updateFullscreenHeights(); } catch(_) {} }, Math.max(900, (getCssTransitionMs()||350)+300));
    } else {
      // 非全屏：先把 inner 固定为“当前像素高”，随后仅靠父容器 height 过渡做收起
      const curH = Math.max(1, Math.round((spectrumRoot.getBoundingClientRect().height || 1)));
      if (spectrumInner) {
        spectrumInner.style.height = curH + 'px';        // 画布保持最终内容尺寸，只是被父容器逐步遮住
        spectrumInner.style.transition = 'transform var(--transition-speed, .25s) ease';
        spectrumInner.style.opacity = '1';
      }

      spectrumRoot.classList.add('anim-scale', 'collapse-to-0');

      requestAnimationFrame(() => {
        if (myEpoch !== __specEpoch) return;

        const onEnd = (e) => {
          if (myEpoch !== __specEpoch) return;
          if (e && e.propertyName !== 'height') return;
          try { spectrumRoot.removeEventListener('transitionend', onEnd); } catch(_) {}
          cleanupAfter();
          spectrumRoot.classList.remove('anim-scale', 'collapse-to-0');
        };

        try { spectrumRoot.addEventListener('transitionend', onEnd, { once:true }); } catch(_) {}
        try { shell.removeAttribute('data-chart-mode'); } catch(_) {}   // 触发 height 从 dvh → 0 的 CSS 过渡
      });
    }
  }

  // 同步外置按钮
  try {
    syncSpectrumDockUi();
  } catch(_) {}
  try {
    placeSpectrumDock();
  } catch(_) {}
}
  
function updateSpectrumLayout() {
  if (!spectrumRoot || !spectrumInner) return;

  if (isFs) {
    if (spectrumRoot) spectrumRoot.style.height = '';
    if (spectrumInner) spectrumInner.style.height = '';
  }
  // NEW: 任何模式下都尽量触发频谱 resize，使其跟随容器宽度
  if (spectrumChart) { try { spectrumChart.resize(); } catch(_) {} }
}

function getXQueryOrDefault(mode){
  let x = xQueryByMode[mode];
  if (x == null) {
    const [vx0, vx1] = getVisibleXRange();
    x = (vx0 + vx1) / 2;
  }
  return x;
}

// 新增：根据当前主图 X 轴与指针，计算单个系列的 RPM
function getSeriesRpmForCurrentX(series, spectrumModel){
  const mode = currentXModeFromPayload(lastPayload);
  if (mode === 'rpm') {
    const rpm = Number(getXQueryOrDefault('rpm'));
    return Number.isFinite(rpm) && rpm > 0 ? rpm : 0;
  } else {
    // X=噪音：用该系列自带的 noise->rpm 模型
    const noiseX = Number(getXQueryOrDefault('noise_db'));
    const ph = series?.pchip?.noise_to_rpm;
    if (ph && Array.isArray(ph.x) && Array.isArray(ph.y) && Array.isArray(ph.m)) {
      const rpm = Number(evalPchipJS(ph, noiseX));
      return Number.isFinite(rpm) && rpm > 0 ? rpm : 0;
    }
    // 没有模型时保底：用系列最大转速
    return rpmMaxForSeries(series, spectrumModel);
  }
}

async function requestAndRenderSpectrum() {
  if (!spectrumEnabled) return;
  if (!lastPayload || !lastPayload.chartData || !Array.isArray(lastPayload.chartData.series)) return;

  ensureSpectrumHost();
  ensureSpectrumChart();
  updateSpectrumLayout();

  const sList = lastPayload.chartData.series;

  // 计算当前所需的模型键集合
  const wanted = new Set();
  const pairs = [];
  const seen = new Set();
  sList.forEach(s => {
    const mid = Number(s.model_id), cid = Number(s.condition_id);
    if (!Number.isInteger(mid) || !Number.isInteger(cid)) return;
    const key = `${mid}_${cid}`;
    if (seen.has(key)) return;
    seen.add(key);
    wanted.add(key);
    pairs.push({ model_id: mid, condition_id: cid });
  });

  const wantedArr = Array.from(wanted);
  const keyHash = __hashWantedSet(wanted);

  // 1) 若全部已缓存，直接渲染，无需发请求
  const allCached = wantedArr.length > 0 && wantedArr.every(k => spectrumModelCache.has(k));
  if (allCached) {
    __specPending = false;
    setSpectrumLoading(false);
    buildAndSetSpectrumOption();
    __lastFetchKeyHash = keyHash;
    return;
  }

  // 2) 并发去重：已有请求在进行中则直接返回，避免重复打点
  if (__specFetchInFlight) return;

  // 3) 发起请求（仅在确有缺失时）
  __specFetchInFlight = true;
  try {
    let fetchRes = { modelsLoaded: 0, missingKeys: new Set(), rebuildingKeys: new Set() };
    try {
      fetchRes = await fetchSpectrumModelsForPairs(pairs);
    } catch (e) {
      console.warn('加载频谱模型失败：', e);
    }

    const pendingKeys = wantedArr.filter(k => !spectrumModelCache.has(k) && !fetchRes.missingKeys.has(k));
    __specPending = pendingKeys.length > 0;

    // 已就绪的先渲染（Loading 只做遮罩提示，不阻挡内容）
    buildAndSetSpectrumOption();

    if (__specPending) {
      setSpectrumLoading(true, `${pendingKeys.length}条频谱加载中，请稍后...`);
      // 使用已有的定时器工具轮询
      specSetTimeout(() => {
        if (spectrumEnabled) requestAndRenderSpectrum();
      }, 1500);
    } else {
      setSpectrumLoading(false);
    }

    __lastFetchKeyHash = keyHash;
  } finally {
    __specFetchInFlight = false;
  }
}

async function fetchSpectrumModelsForPairs(pairs) {
  if (!Array.isArray(pairs) || !pairs.length) {
    return { modelsLoaded: 0, missingKeys: new Set(), rebuildingKeys: new Set() };
  }
  const resp = await fetch('/api/spectrum-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairs })
  });
  const j = await resp.json();
  const ok = !!(j && typeof j === 'object' && j.success === true);
  if (!ok) throw new Error((j && j.error_message) || '频谱模型接口失败');

  const data = j.data || {};
  const models = Array.isArray(data.models) ? data.models : [];
  let loaded = 0;

  models.forEach(item => {
    const mid = Number(item.model_id), cid = Number(item.condition_id);
    const key = `${mid}_${cid}`;
    const model = (item && item.model) || null;
    if (model && Array.isArray(model.centers_hz) && Array.isArray(model.band_models_pchip)) {
      spectrumModelCache.set(key, model);
      loaded++;
    }
  });

  function toKeySet(arr) {
    const s = new Set();
    (Array.isArray(arr) ? arr : []).forEach(e => {
      const mid = Number(e && e.model_id), cid = Number(e && e.condition_id);
      if (Number.isInteger(mid) && Number.isInteger(cid)) s.add(`${mid}_${cid}`);
    });
    return s;
  }

  const missingKeys = toKeySet(data.missing);
  const rebuildingKeys = toKeySet(data.rebuilding);

  return { modelsLoaded: loaded, missingKeys, rebuildingKeys };
}

// 新增整个函数：依据当前 Legend 可见性构建频谱线并渲染
function getLegendSelectionMap(){
  try {
    const opt = chart.getOption() || {};
    return (opt.legend && opt.legend[0] && opt.legend[0].selected) || {};
  } catch(_) { return {}; }
}

function rpmMaxForSeries(s, model) {
  // 优先用模型的 rpm_max；其次从原始点估计
  const fromModel = Number(model && model.rpm_max);
  if (Number.isFinite(fromModel) && fromModel > 0) return fromModel;
  const arr = Array.isArray(s.rpm) ? s.rpm.filter(v => Number.isFinite(Number(v))) : [];
  if (arr.length) return Math.max.apply(null, arr.map(Number));
  return 0;
}

  let __spectrumWasEmpty = true;

function buildAndSetSpectrumOption() {
  if (!spectrumChart) return;

  const allSeries = Array.isArray(lastPayload?.chartData?.series) ? lastPayload.chartData.series : [];
  const t = tokens(document.documentElement.getAttribute('data-theme') || 'light');
  const gridMain = (lastOption && lastOption.grid) || { left:40, right:260, top:60, bottom:40 };
  const left = (typeof gridMain.left === 'number') ? gridMain.left : 40;
  const rightGap = (typeof gridMain.right === 'number') ? gridMain.right : 260;

  const fmtHz = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    return n >= 1000 ? (n / 1000).toFixed(1) + ' kHz' : n.toFixed(1) + ' Hz';
  };

  const selMapFromMain = getLegendSelectionMap();
  const visibleSeries = allSeries.filter(s => (selMapFromMain ? selMapFromMain[s.name] !== false : true));

  const visibleKeys = visibleSeries
    .map(s => `${s.model_id}_${s.condition_id}`)
    .sort()
    .join('|');

  // 统计“可见系列中已就绪模型”的数量（用于决定是否重算 Y max）
  let modelReadyCount = 0;
  visibleSeries.forEach(s => {
    const k = `${Number(s.model_id)}_${Number(s.condition_id)}`;
    if (spectrumModelCache.has(k)) modelReadyCount++;
  });

  const needRecalcYMax =
    !lastSpectrumOption ||
    lastSpectrumOption.__visibleHash !== visibleKeys ||
    !Number.isFinite(lastSpectrumOption.__yMaxFixed) ||
    lastSpectrumOption.__modelReadyCount !== modelReadyCount;

  if (needRecalcYMax) {
    const fixedMax = computeSpectrumYMaxFixed();
    lastSpectrumOption = {
      __yMax: fixedMax,
      __yMaxFixed: fixedMax,
      __visibleHash: visibleKeys,
      __modelReadyCount: modelReadyCount
    };
  }

  const lines = [];
  let hasAnyData = false;
  visibleSeries.forEach(s => {
    const mid = Number(s.model_id), cid = Number(s.condition_id);
    if (!Number.isInteger(mid) || !Number.isInteger(cid)) return;
    const model = spectrumModelCache.get(`${mid}_${cid}`);
    if (!model) return;

    const centers = Array.isArray(model.centers_hz) ? model.centers_hz : (model.freq_hz || model.freq || []);
    const bands = Array.isArray(model.band_models_pchip) ? model.band_models_pchip : [];
    if (!(centers.length && bands.length)) return;

    const rpmTarget = getSeriesRpmForCurrentX(s, model);
    const pts = [];
    if (Number.isFinite(rpmTarget) && rpmTarget > 0) {
      for (let i = 0; i < centers.length; i++) {
        const hz = Number(centers[i]);
        if (!Number.isFinite(hz)) continue;
        const bm = bands[i];
        if (!bm || !Array.isArray(bm.x) || !Array.isArray(bm.y) || !Array.isArray(bm.m)) continue;
        const raw = Number(evalPchipJS(bm, rpmTarget));
        const db = Number.isFinite(raw) ? Math.max(0, raw) : NaN;
        if (!Number.isFinite(db)) continue;
        pts.push([hz, db]);
      }
    }
    if (pts.length) hasAnyData = true;
    lines.push({ id: `spec:${mid}_${cid}`, name: s.name, color: s.color, data: pts });
  });

  const canvasBg = (lastOption && lastOption.backgroundColor) || getExportBg();

  // 注意：等待期内如果没有任何可渲染数据，则不渲染空态，避免与 Loading 叠加
  if (!hasAnyData) {
    if (__specPending) {
      // 正在等待重建/加载：保持现有画面，不更新为空态
      return;
    }

    // 非等待期：可以安全显示空态
    spectrumChart.setOption({
      backgroundColor: canvasBg,
      title: {
        text: '当前无可渲染频谱',
        left: 'center',
        top: 'middle',
        textStyle: { color: t.axisLabel, fontWeight: 600, fontSize: 14, fontFamily: t.fontFamily }
      },
      grid: { left, right: rightGap, top: 36, bottom: 18 },
      xAxis: { show: false, min: SPECTRUM_X_MIN, max: SPECTRUM_X_MAX },
      yAxis: { show: false, min: 0, max: Math.max(0, Number(lastSpectrumOption?.__yMaxFixed) || 60) },
      legend: { show: false, selected: selMapFromMain },
      series: []
    }, { notMerge: false, replaceMerge: ['series','tooltip'] }); // 关键：合并 tooltip，保证模式切换后定位策略更新
    spectrumChart.resize();
    return;
  }

  spectrumChart.setOption({
    backgroundColor: canvasBg,
    textStyle: { fontFamily: t.fontFamily },

    title: {
      text: buildSpectrumTitle(),
      left: 'center',
      top: 6,
      textStyle: { color: t.axisLabel, fontWeight: 700, fontSize: 16, fontFamily: t.fontFamily }
    },

    grid: { left, right: rightGap, top: 38, bottom: 60 },

    xAxis: {
      type: 'log',
      logBase: 10,
      min: SPECTRUM_X_MIN,
      max: SPECTRUM_X_MAX,
      name: '频率',
      nameGap: 25,
      nameLocation: 'middle',
      nameTextStyle: { color: t.axisName, fontWeight: 600 },
      axisLabel: { color: t.axisLabel, formatter: fmtHz },
      axisLine: { lineStyle: { color: t.axisLine } },
      splitLine: { show: true, lineStyle: { color: t.gridLine } },
      minorTick: { show: true, splitNumber: 9 },
      minorSplitLine: { show: true, lineStyle: { color: t.gridLine, opacity: 0.4 } }
    },

    yAxis: {
      type: 'value',
      min: 0,
      max: Math.max(0, Number(lastSpectrumOption?.__yMaxFixed) || 60),
      name: '声级(dB)',
      nameTextStyle: { color: t.axisName, fontWeight: 600 },
      axisLabel: { color: t.axisLabel },
      axisLine: { lineStyle: { color: t.axisLine } },
      splitLine: { show: true, lineStyle: { color: t.gridLine } }
    },

    tooltip: {
      appendToBody: !isFs,          // 非全屏：挂到 body；全屏：挂容器内，避免 Top Layer 遮挡
      confine: false,
      trigger: 'axis',
      triggerOn: 'mousemove|click|touchstart|touchmove',
      backgroundColor: t.tooltipBg,
      borderColor: t.tooltipBorder,
      borderWidth: 1,
      borderRadius: 10,
      textStyle: { color: t.tooltipText },
      axisPointer: { type: 'line', snap: true, label: { formatter: (obj) => fmtHz(obj?.value) } },
      position: function (pos) {
        const x = Array.isArray(pos) ? pos[0] : 0;
        const y = Array.isArray(pos) ? pos[1] : 0;
        const gap = 12;
        return [Math.round(x + gap), Math.round(y + gap)];
      },
      extraCssText: `
        position: ${isFs ? 'absolute' : 'fixed'};
        backdrop-filter: blur(4px) saturate(120%);
        -webkit-backdrop-filter: blur(4px) saturate(120%);
        box-shadow: ${t.tooltipShadow};
        z-index: 1000000;
      `,
      formatter: function (params) {
        if (!Array.isArray(params) || !params.length) return '';
        const x = params[0]?.axisValue;
        const head = `<div style="font-weight:800;margin-bottom:4px;">${fmtHz(x)}</div>`;
        const linesHtml = params.map(p => {
          const v = Array.isArray(p.data) ? p.data[1] : (Number(p.value) || NaN);
          const dB = Number.isFinite(v) ? v.toFixed(1) + ' dB' : '-';
          return `<div style="display:flex;align-items:center;gap:6px;">
                    <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${p.color};"></span>
                    <span>${p.seriesName}</span>
                    <span style="margin-left:auto;color:var(--text-muted);font-variant-numeric:tabular-nums;">${dB}</span>
                  </div>`;
        }).join('');
        return head + linesHtml;
      }
    },

    legend: { show: false, selected: selMapFromMain },

    series: lines.map(l => ({
      id: l.id,
      name: l.name,
      type: 'line',
      showSymbol: false,
      smooth: false,
      connectNulls: false,
      data: l.data,
      lineStyle: { width: 2.5, color: l.color },
      itemStyle: { color: l.color },
      silent: false,
      z: 1,
      clip: true,
      animation: true,
      animationDuration: 650,
      animationEasing: 'linear',
      animationDelay: function (idx) { return idx * 14; },
      animationDurationUpdate: 500,
      animationEasingUpdate: 'cubicOut',
      universalTransition: true,
      emphasis: { focus: 'series', blurScope: 'coordinateSystem' }
    }))
  }, { notMerge: false, replaceMerge: ['series','tooltip'] }); // 关键：每次都同时刷新 tooltip 配置

  spectrumChart.resize();
}

// 新增：频谱标题文本
function buildSpectrumTitle(){
  const mode = currentXModeFromPayload(lastPayload);
  const x = Number(getXQueryOrDefault(mode));
  if (mode === 'rpm') return `A计权声级频谱 @ ${Math.round(x)} RPM`;
  const v = Number.isFinite(x) ? x.toFixed(1) : '-';
  return `A计权声级频谱 @ ${v} dB`;
}

// 新增整个函数：计算“固定的频谱 Y 轴上限”，只依据“当前可见系列在其最大转速时的全频段 dB 最大值”
function computeSpectrumYMaxFixed() {
  if (!lastPayload || !lastPayload.chartData) return 60;
  const sList = Array.isArray(lastPayload.chartData.series) ? lastPayload.chartData.series : [];
  const selected = getLegendSelectionMap();

  let globalMax = 0;
  sList.forEach(s => {
    if (selected && selected[s.name] === false) return;         // 仅可见系列
    const mid = Number(s.model_id), cid = Number(s.condition_id);
    if (!Number.isInteger(mid) || !Number.isInteger(cid)) return;
    const model = spectrumModelCache.get(`${mid}_${cid}`);
    if (!model) return;

    const centers = Array.isArray(model.centers_hz) ? model.centers_hz : (model.freq_hz || model.freq || []);
    const bands   = Array.isArray(model.band_models_pchip) ? model.band_models_pchip : [];
    if (!centers.length || !bands.length) return;

    // 固定：使用该系列“最大转速”
    const rpmMax = rpmMaxForSeries(s, model);
    if (!Number.isFinite(rpmMax) || rpmMax <= 0) return;

    for (let i = 0; i < centers.length; i++) {
      const bandModel = bands[i];
      if (!bandModel || !Array.isArray(bandModel.x) || !Array.isArray(bandModel.y) || !Array.isArray(bandModel.m)) continue;
      const v = Number(evalPchipJS(bandModel, rpmMax));
      // 小于 0 的值在频谱上显示为 0
      const db = Number.isFinite(v) ? Math.max(0, v) : NaN;
      if (Number.isFinite(db) && db > globalMax) globalMax = db;
    }
  });

  // 固定范围：0 ~ globalMax（若无值，兜底到 60）
  return Math.max(10, Math.ceil(globalMax || 60));
}

function __ensureMainChartMinHeightForSpectrumMode() {
  if (!root) return;
  const vh = window.innerHeight || 800;
  const clampH = Math.max(480, Math.min(600, Math.round(vh * 0.62)));
  root.style.minHeight = clampH + 'px';
}

// 删除重复定义的 updateFullscreenHeights（保留前面的唯一版本）

function revealSpectrumIfNeeded() {
  if (!spectrumRoot) return;
  const rect = spectrumRoot.getBoundingClientRect();
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  // 若底部超出可视区域，则滚动让其露出（对齐到开始位置）
  if (rect.bottom > vh - 8) {
    try { spectrumRoot.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch(_) {
      // 兜底：使用 window.scrollTo
      const se = document.scrollingElement || document.documentElement || document.body;
      const top = (window.scrollY || se.scrollTop || 0) + (rect.top - 8);
      window.scrollTo({ top, behavior: 'smooth' });
    }
  }
}

// 替换：导出主图+频谱（修复 Legend 样式/位置、字体大小，以及底部裁切）
async function exportCombinedImage() {
  if (!chart) return;

  // 1) 准备
  try { chart.dispatchAction({ type: 'hideTip' }); } catch(_) {}
  try { spectrumChart && spectrumChart.dispatchAction({ type: 'hideTip' }); } catch(_) {}
  try { chart.resize(); } catch(_) {}
  try { spectrumEnabled && spectrumChart && spectrumChart.resize(); } catch(_) {}

  // 等一帧，确保布局稳定
  await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));

  const exportBg = getExportBg();
  const dpr = window.devicePixelRatio || 1;
  const t = tokens(document.documentElement.getAttribute('data-theme') || 'light');

  // 2) 获取主图/频谱图片（高分辨率）
  const mainUrl = chart.getDataURL({ pixelRatio: dpr, backgroundColor: exportBg, excludeComponents: [] });
  let specUrl = null;
  if (spectrumEnabled && spectrumChart) {
    try {
      specUrl = spectrumChart.getDataURL({ pixelRatio: dpr, backgroundColor: exportBg, excludeComponents: [] });
    } catch(_) {}
  }

  // 3) 加载图片资源
  const loadImg = (src) => new Promise((res, rej) => {
    if (!src) return res(null);
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.crossOrigin = 'anonymous';
    im.src = src;
  });

  const mainImg = await loadImg(mainUrl);
  const specImg = await loadImg(specUrl);

  if (!mainImg) return;

  // 4) 用 CSS 像素布局（将高分辨率图按 dpr 缩放到 CSS 大小）
  const mainCssW = mainImg.width / dpr;
  const mainCssH = mainImg.height / dpr;
  const specCssW = specImg ? (specImg.width / dpr) : 0;
  const specCssH = specImg ? (specImg.height / dpr) : 0;

  const chartsW = Math.max(mainCssW, specCssW);
  const gap = 24;            // 主图与频谱之间的间距（CSS px）
  const pad = 16;            // 画布内边距
  const bottomPad = 16;      // 额外底部留白，避免“紧贴底边”的裁切感
  const chartsH = mainCssH + (specImg ? (gap + specCssH) : 0);

  // 5) 构造导出用 Legend（复刻侧栏）
  const items = __buildLegendItemsForExport();
  const lm = __measureLegendForExport(items, t);
  const legendW = lm.colW;
  const legendH = lm.totalH;

  // 6) 计算输出画布的 CSS 尺寸，并用 dpr 放大像素尺寸
  const cssW = pad + chartsW + gap + legendW + pad;
  const cssH = pad + Math.max(chartsH, legendH) + bottomPad;
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(cssW * dpr));
  out.height = Math.max(1, Math.round(cssH * dpr));
  const ctx = out.getContext('2d');
  ctx.scale(dpr, dpr);

  // 背景
  ctx.fillStyle = exportBg;
  ctx.fillRect(0, 0, cssW, cssH);

  // 7) 绘制主图与频谱（按 CSS 尺寸投放）
  let x = pad, y = pad;
  ctx.drawImage(mainImg, x, y, mainCssW, mainCssH);
  y += mainCssH;

  if (specImg) {
    y += gap;
    ctx.drawImage(specImg, x, y, specCssW, specCssH);
  }

  // 8) 绘制 Legend（右列，复刻两行样式）
  let lx = pad + chartsW + gap;
  let ly = pad;

  ctx.textBaseline = 'alphabetic';

  items.forEach(it => {
    const color = it.selected ? (it.color || '#888') : 'rgba(128,128,128,.35)';
    // dot
    ctx.fillStyle = color;
    const r = lm.dotW / 2;
    ctx.beginPath();
    ctx.arc(lx + r + lm.padX, ly + r + 2, r, 0, Math.PI * 2);
    ctx.fill();

    // texts
    const textX = lx + lm.padX + lm.dotW + lm.gapDotText;
    const line1Y = ly + lm.line1H - 6; // 视觉基线略向上，靠近侧栏观感
    ctx.font = lm.line1Font;
    ctx.fillStyle = it.selected ? t.tooltipText : 'rgba(0,0,0,.55)';
    ctx.fillText(it.line1 || '', textX, line1Y);

    let itemH = lm.line1H;
    if (it.line2) {
      ctx.font = lm.line2Font;
      const line2Y = ly + lm.line1H + lm.line2H - 6;
      ctx.fillStyle = 'var(--text-muted)';
      // 如无全局 CSS 变量，兜底为次要文本色
      if (getComputedStyle(document.documentElement).getPropertyValue('--text-muted')) {
        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim() || '#6b7280';
      } else {
        ctx.fillStyle = '#6b7280';
      }
      ctx.fillText(it.line2, textX, line2Y);
      itemH = lm.line1H + lm.line2H;
    }

    ly += itemH + lm.itemGap;
  });

  // 9) 触发下载
  const a = document.createElement('a');
  a.download = 'charts-all.png';
  a.href = out.toDataURL('image/png');
  a.click();
}

function __computeFsSpecTargetPx() {
  const shell = document.getElementById('chart-settings') || (root && root.closest('.fc-chart-container'));
  if (!shell) return 0;
  const stack = shell.querySelector('.chart-stack');
  if (!stack) return 0;

  const st = getComputedStyle(stack);
  const gap = parseFloat(st.rowGap || st.gap || '0') || 0;
  const stackH = Math.max(0, Math.round(stack.getBoundingClientRect().height));

  // 可用高度要扣掉一个列间隙（两行之间只会产生一个 gap）
  const usable = Math.max(0, stackH - gap);

  const cs = getComputedStyle(document.documentElement);
  const mainFlex = parseFloat(cs.getPropertyValue('--fs-main-flex')) || 3;
  const specFlex = parseFloat(cs.getPropertyValue('--fs-spec-flex')) || 2;

  const total = Math.max(0.0001, mainFlex + specFlex);
  const specPx = Math.round(usable * (specFlex / total));

  // 合理下限，避免 0 导致动画不触发
  return Math.max(1, specPx);
}

function __refreshFsSpecMaxHeightIfExpanded() {
  if (!(isFs && spectrumEnabled && spectrumRoot)) return;
  const px = __computeFsSpecTargetPx();
  if (px > 0) {
    spectrumRoot.style.setProperty('max-height', px + 'px');
    spectrumRoot.style.setProperty('--fs-spec-h', px + 'px');
  }
}

/* 追加：创建/获取 Loading 覆盖层 */
function ensureSpectrumLoader() {
  if (!spectrumRoot) return null;
  let el = spectrumRoot.querySelector('.spectrum-loading');
  if (!el) {
    el = document.createElement('div');
    el.className = 'spectrum-loading';
    el.innerHTML = `
      <div class="spinner" aria-hidden="true"></div>
      <div class="text" id="spectrumLoadingText">加载中...</div>
    `;
    spectrumRoot.appendChild(el);
  }
  spectrumLoadingEl = el;
  return el;
}

function setSpectrumLoading(on, text) {
  const el = ensureSpectrumLoader();
  if (!el) return;
  const txt = el.querySelector('#spectrumLoadingText');
  if (txt) {
    if (typeof text === 'string' && text.length) txt.textContent = text;
    txt.style.fontSize = '15px';
  }
  el.classList.toggle('is-active', !!on);
}

// 锁定/解锁主图高度，避免非全屏动画期间抖动
function lockMainChartHeight() {
  if (!root) return;
  const h = Math.round((root.getBoundingClientRect && root.getBoundingClientRect().height) || root.clientHeight || 0);
  if (h > 0) {
    root.style.height = h + 'px';
    root.style.minHeight = h + 'px';
    __mainHLocked = true;
  }
}
function unlockMainChartHeight() {
  if (!root || !__mainHLocked) return;
  try { root.style.removeProperty('height'); } catch(_) {}
  try { root.style.removeProperty('min-height'); } catch(_) {}
  __mainHLocked = false;

}

function syncSpectrumStateAcrossModes({ animate = false } = {}) {
  ensureSpectrumHost();
  const shell =
    document.getElementById('chart-settings') ||
    (root && root.closest('.fc-chart-container')) ||
    document.documentElement;

  if (!spectrumRoot) return;

  if (spectrumEnabled) {
    try { shell.setAttribute('data-chart-mode', 'spectrum'); } catch (_) {}

    if (isFs) {
      // 全屏：仍用 max-height + --fs-spec-h 表达展开高度
      const targetPx = __computeFsSpecTargetPx();
      spectrumRoot.style.removeProperty('height');
      spectrumRoot.style.setProperty('flex', '0 0 auto', 'important');
      spectrumRoot.style.setProperty('--fs-spec-h', targetPx + 'px');

      if (animate) {
        spectrumRoot.style.transition = 'max-height var(--transition-speed, .25s) ease';
        const cur = Math.max(0, Math.round(spectrumRoot.getBoundingClientRect().height || 0));
        spectrumRoot.style.setProperty('max-height', cur + 'px');
        void spectrumRoot.offsetHeight;
        spectrumRoot.style.setProperty('max-height', targetPx + 'px');
      } else {
        spectrumRoot.style.transition = 'none';
        spectrumRoot.style.setProperty('max-height', targetPx + 'px');
        void spectrumRoot.offsetHeight;
        spectrumRoot.style.transition = '';
      }
    } else {
      // 非全屏：不再写入 px；依靠 CSS 的 dvh 规则和 height 过渡
      if (animate) {
        spectrumRoot.classList.add('anim-scale');
        requestAnimationFrame(() => {
          try { spectrumRoot.classList.remove('anim-scale'); } catch(_) {}
        });
      }
      spectrumRoot.style.removeProperty('max-height');
      spectrumRoot.style.removeProperty('flex');
    }
  } else {
    try { shell.removeAttribute('data-chart-mode'); } catch (_) {}

    if (isFs) {
      spectrumRoot.style.removeProperty('height');
      if (animate) {
        spectrumRoot.style.transition = 'max-height var(--transition-speed, .25s) ease';
      } else {
        spectrumRoot.style.transition = 'none';
      }
      spectrumRoot.style.setProperty('max-height', '0px');
      if (!animate) spectrumRoot.style.transition = '';
    } else {
      // 非全屏：移除属性即回到 height:0（CSS 过渡生效）
      spectrumRoot.style.removeProperty('max-height');
      spectrumRoot.style.removeProperty('flex');
      if (animate) {
        spectrumRoot.classList.add('anim-scale');
        requestAnimationFrame(() => {
          try { spectrumRoot.classList.remove('anim-scale'); } catch(_) {}
        });
      }
    }
  }

  // 关键补丁：模式切换后立刻刷新频谱配置（含 tooltip），避免沿用旧的 appendToBody/fixed
  try {
    if (spectrumEnabled && spectrumChart) {
      buildAndSetSpectrumOption();  // 内部已根据 isFs 设置 appendToBody 和位置语义，并 replaceMerge tooltip
    }
  } catch(_) {}

  try { chart && chart.resize(); } catch (_) {}
  try { spectrumEnabled && spectrumChart && spectrumChart.resize(); } catch (_) {}
}

  function getExportBg() {
    const bgBody = getComputedStyle(document.body).backgroundColor;
    return bgBody && bgBody !== 'rgba(0, 0, 0, 0)' ? bgBody : '#ffffff';
  }

  // 新增：构建导出用 Legend 条目（复刻侧栏的两行文案）
function __buildLegendItemsForExport() {
  const sList = Array.isArray(lastPayload?.chartData?.series) ? lastPayload.chartData.series : [];
  const selMap = getLegendSelectionMap();
  return sList.map(s => {
    const brand = s.brand || s.brand_name_zh || s.brand_name || '';
    const model = s.model || s.model_name || '';
    const line1 = (brand || model) ? `${brand} ${model}`.trim() : (s.name || '');
    const line2 = s.condition_name_zh || s.condition || '';
    const selected = selMap ? (selMap[s.name] !== false) : true;
    return {
      id: s.name,
      color: s.color || '#888',
      line1,
      line2,
      selected
    };
  });
}

// 新增：测量导出用 Legend 的列宽与总高（CSS 像素）
function __measureLegendForExport(items, t) {
  const measureCtx = document.createElement('canvas').getContext('2d');
  const padX = 10;            // 文本内边距
  const dotW = 12;            // 圆点直径
  const gapDotText = 8;       // 点到文字的水平间隔
  const minCol = 160, maxCol = 360;

  const line1Font = `600 13px ${t.fontFamily}`;
  const line2Font = `500 11px ${t.fontFamily}`;
  const line1H = 22;          // 第一行行高
  const line2H = 16;          // 第二行行高
  const itemGap = 8;          // 条目之间的垂直间距

  let textMax = 0;
  let totalH = 0;

  items.forEach(it => {
    measureCtx.font = line1Font;
    const w1 = measureCtx.measureText(it.line1 || '').width || 0;
    let w2 = 0;
    if (it.line2) {
      measureCtx.font = line2Font;
      w2 = measureCtx.measureText(it.line2).width || 0;
    }
    textMax = Math.max(textMax, w1, w2);

    const itemH = it.line2 ? (line1H + line2H) : line1H;
    totalH += itemH + itemGap;
  });

  if (items.length > 0) totalH -= itemGap; // 最后一项不加间距

  const colW = Math.min(maxCol, Math.max(minCol, Math.ceil(padX + dotW + gapDotText + textMax + padX)));
  return { colW, totalH, line1H, line2H, itemGap, dotW, gapDotText, padX, line1Font, line2Font };
}

// 新增：根据当前是否窄屏，返回非全屏时频谱应使用的固定高度
function getNonFullscreenSpecHeight(){
  const narrow = layoutIsNarrow();
  return narrow ? Math.round(NF_SPEC_H_PX / 1.5) : NF_SPEC_H_PX; // 600 -> 400
}

// NEW: 将频谱背景与主图一致（仅更新 backgroundColor，不动其它配置）
function syncSpectrumBgWithMain(bgOverride){
  try {
    if (!spectrumEnabled || !spectrumChart) return;
    const fallback = (lastOption && lastOption.backgroundColor) || (isFs ? getExportBg() : 'transparent');
    const targetBg = (bgOverride !== undefined && bgOverride !== null) ? bgOverride : fallback;
    spectrumChart.setOption({ backgroundColor: targetBg });
  } catch(_) {}
}

// 新增：与 CSS dvh 规则一致的“非常规模式下频谱目标像素高”
function __computeNfSpecTargetPx() {
  const vv = (window.visualViewport && Math.round(window.visualViewport.height)) || 0;
  const vh = vv > 0 ? vv : (window.innerHeight || document.documentElement.clientHeight || 800);
  const narrow = layoutIsNarrow();
  const frac = narrow ? 0.30 : 0.45;    // 窄屏 30dvh，桌面 45dvh
  let px = Math.round(vh * frac);
  // 与 CSS 约束对齐：上限 600；桌面最小 300
  px = Math.min(600, px);
  if (!narrow) px = Math.max(300, px);
  return Math.max(1, px);
}

// 停靠状态切换后，补一次宽度测量，确保变量与当前布局一致
function updateRailParkedState(){
  const shell =
    document.getElementById('chart-settings') ||
    (root && root.closest('.fc-chart-container')) ||
    null;
  if (!shell) return;

  const narrow = layoutIsNarrow();
  const empty  = !lastOption || lastOption.__empty;
  const shouldPark = !!(showFitCurves && !empty && !narrow);
  shell.classList.toggle('rail-parked', shouldPark);

  // 新增：切换后立刻刷新一次 rail 宽度变量，避免边界分辨率下变量与实际显示不一致
  try { updateLegendRailLayout(); } catch(_) {}
}

  // 挂到全局
  window.ChartRenderer = API;

})();