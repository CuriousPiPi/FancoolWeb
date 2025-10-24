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

  function getCssTransitionMs(){
    try {
      const raw = getComputedStyle(document.documentElement).getPropertyValue('--transition-speed').trim();
      if (!raw) return 300;
      if (raw.endsWith('ms')) return Math.max(0, parseFloat(raw));
      if (raw.endsWith('s'))  return Math.max(0, parseFloat(raw) * 1000);
      const n = parseFloat(raw);
      return Number.isFinite(n) ? n : 300;
    } catch(_) { return 300; }
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
  let showRawCurves = true;
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
        // 当 root 的位置或尺寸变化时，重放置拟合 UI（bubble/指针）
        if (cur.left !== __lastRootRect.left || cur.top !== __lastRootRect.top ||
            cur.width !== __lastRootRect.width || cur.height !== __lastRootRect.height) {
          __lastRootRect = cur;
          try { placeFitUI(); repaintPointer(); } catch(_){}
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

    // 滚动时基于“相对图表偏移”重算一次气泡位置（rAF 节流）
    let __scrollRaf = null;
    const onAnyScroll = () => {
      if (__scrollRaf) return;
      __scrollRaf = requestAnimationFrame(() => {
        __scrollRaf = null;
        try { placeFitUI(); } catch(_) {}
      });
    };
    window.addEventListener('scroll', onAnyScroll, { passive: true, capture: true });

    // NEW: 监听侧栏/主容器的过渡与属性变化，侧栏展开/收起/拖拽期间跟随图表容器移动
    (function hookLayoutMovers(){
      const watchMovement = () => { try { placeFitUI(); repaintPointer(); } catch(_) {} };
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

      // 全屏切换时，先把气泡挂到正确宿主（Top Layer 内/外）
      adoptBubbleHost();

      // 重置一次拟合气泡位置（使用默认定位）
      bubbleUserMoved = false;
      if (!isFs) {
        if (screen.orientation && screen.orientation.unlock) {
          try { screen.orientation.unlock(); } catch(_) {}
        }
      }
      onWindowResize();
      requestAnimationFrame(() => {
        try { placeFitUI(); repaintPointer(); } catch(_) {}
      });
    }, { passive:true });
  }

  function bindChartListeners(){
    chart.on('legendselectchanged', () => { if (showFitCurves) refreshFitBubble(); });
    chart.on('dataZoom', () => {
      clampXQueryIntoVisibleRange();
      repaintPointer();
      if (showFitCurves) refreshFitBubble();
    });
  }

  function onWindowResize(){
    if (!chart) return;
    const nowNarrow = layoutIsNarrow();
    if (lastIsNarrow === null) lastIsNarrow = nowNarrow;

    // NEW: 窗口 resize 期间也跟踪 root 几何漂移（例如响应式 reflow）
    maybeStartRootPosWatch(900);

    if (nowNarrow !== lastIsNarrow) {
      lastIsNarrow = nowNarrow;
      if (lastPayload) render(lastPayload); else chart.resize();
    } else {
      chart.resize();
      if (lastOption) {
        const { x, y, visible } = computePrefixCenter(lastOption);
        placeAxisOverlayAt(x, y, visible && !lastOption.__empty);
        placeFitUI();
        repaintPointer();
      }
    }
  }

  let __chartRO = null;
  function installChartResizeObserver(){
    if (__chartRO || !root || typeof ResizeObserver === 'undefined') return;
    __chartRO = new ResizeObserver(entries => {
      for (const entry of entries) {
        const cr = entry.contentRect || {};
        if (chart && cr.width > 0 && cr.height > 0) {
          // NEW: 容器尺寸变化 → 启动短暂的几何跟踪，覆盖“移动 + 尺寸变动”的过渡阶段
          primeRootRect();
          maybeStartRootPosWatch(900);

          // 当容器宽度变化导致“窄/宽布局”跨阈值时，重建 option（让 legend 立即切换布局）
          const nowNarrow = layoutIsNarrow();
          if (lastIsNarrow === null) lastIsNarrow = nowNarrow;
          if (nowNarrow !== lastIsNarrow) {
            lastIsNarrow = nowNarrow;
            try {
              if (lastPayload) { render(lastPayload); }
              else { chart.resize(); }
            } catch(_){}
            // render() 会自行调用 placeFitUI / repaintPointer / 更新 overlay，无需继续执行后续分支
            continue;
          }

          // 未跨阈值：保持原有轻量刷新路径
          try { chart.resize(); } catch(_){}
          try {
            if (lastOption) {
              const { x, y, visible } = computePrefixCenter(lastOption);
              placeAxisOverlayAt(x, y, visible && !lastOption.__empty);
            }
            placeFitUI();
            repaintPointer();
            updateAxisSwitchPosition({ force: true, animate: false });
          } catch(_){}
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
    // 以“图表容器实际宽度”判定（优先 root 的实际可见宽度，其次 chart.getWidth）
    const w =
      (root && root.getBoundingClientRect ? Math.floor(root.getBoundingClientRect().width) : 0) ||
      (chart && typeof chart.getWidth === 'function' ? chart.getWidth() : 0);

    let narrow = w > 0 ? (w < 800) : false;
    // 全屏 + 移动端不视为窄屏
    if (isFs && isMobile()) narrow = false;
    return narrow;
  }

  // ===== 对外 API =====
function mount(rootEl) {
  root = rootEl;
  if (!root) {
    warnOnce('[ChartRenderer] mount(rootEl) 需要一个有效的 DOM 容器');
    return;
  }
  ensureEcharts();  // 统一解析初始主题
  const initialTheme =
    (window.ThemePref && typeof window.ThemePref.resolve === 'function')
      ? window.ThemePref.resolve()
      : (document.documentElement.getAttribute('data-theme') || 'light');

  // 写入 DOM（不触发后端上报）
  if (window.ThemePref && typeof window.ThemePref.setDom === 'function') {
    window.ThemePref.setDom(initialTheme);
  } else {
    document.documentElement.setAttribute('data-theme', initialTheme);
  }

  // 首次挂载时渲染空数据状态（沿用 initialTheme）
  if (!chart) return;
  const emptyPayload = { chartData: { series: [] }, theme: initialTheme };
  render(emptyPayload);
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

    requestAnimationFrame(() => updateAxisSwitchPosition({ force:true, animate:false }));
    if (option.__empty) {
      try { chart.dispatchAction({ type: 'updateAxisPointer', currTrigger: 'leave' }); } catch(_){}
    }

    const { x, y, visible } = computePrefixCenter(option);
    placeAxisOverlayAt(x, y, visible && !option.__empty);

    lastOption = option;
    lastIsNarrow = layoutIsNarrow();

    // 窄屏也显示拟合 UI
    toggleFitUI(showFitCurves);
    placeFitUI();

    // NEW: 渲染后短暂跟踪一次位置，以覆盖同步/异步布局抖动
    primeRootRect();
    maybeStartRootPosWatch(600);

    try {
      const onFinished = () => {
        try { chart.off('finished', onFinished); } catch(_){}
        repaintPointer();
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

  function getExportBg() {
    const bgBody = getComputedStyle(document.body).backgroundColor;
    return bgBody && bgBody !== 'rgba(0, 0, 0, 0)' ? bgBody : '#ffffff';
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

    if (!sList.length || (!showRawCurves && !showFitCurves)) {
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

    const legendMeta = {};
    sList.forEach(s=>{
      const brand = s.brand || s.brand_name_zh || s.brand_name || '';
      const model = s.model || s.model_name || '';
      const condition = s.condition_name_zh || s.condition || '';  // NEW: 统一用工况字段
      const key   = s.name || [brand, model].filter(Boolean).join(' ') || String(s.key || '');
      legendMeta[key] = { brand, model, condition };               // CHANGED
    });
    function desktopLegendFormatter(name){
      const m = legendMeta[name] || {};
      const line1 = [m.brand, m.model].filter(Boolean).join(' ');
      const line2 = m.condition || '';                             // CHANGED: 第二行显示工况
      if (line2) return `{l1|${line1}}\n{l2|${line2}}`;
      return `{l1|${line1||name}}`;
    }
    function mobileLegendFormatter(name){
      const m = legendMeta[name] || {};
      const left  = [m.brand, m.model].filter(Boolean).join(' ');
      const right = m.condition || '';                              // CHANGED: 右侧显示工况
      if (right) return `{m1|${left}} {m1|-} {m2|${right}}`;
      return `{m1|${left||name}}`;
    }

    const isN = isNarrow;
    const legendCfg = isN ? {
      type: 'scroll',
      orient: 'vertical',
      left: 20, right: 6, bottom: 6,
      itemWidth: 16, itemHeight: 10, align: 'auto',
      pageIconColor: t.pagerIcon, pageTextStyle: { color: t.axisLabel },
      textStyle: { color: t.axisLabel, fontFamily: t.fontFamily,
        rich: { m1:{ fontSize:13,fontWeight:600,color:t.axisLabel,lineHeight:18 },
                m2:{ fontSize:11,fontWeight:500,color:t.axisName,lineHeight:16 } } },
      formatter: mobileLegendFormatter
    } : {
      type: 'scroll',
      orient: 'vertical',
      left: '85%', top: gridTop, bottom: 10,
      itemWidth: 18, itemHeight: 10, itemGap: 16, align: 'auto',
      pageIconColor: t.pagerIcon, pageTextStyle: { color: t.axisLabel },
      textStyle: { color: t.axisLabel, fontFamily: t.fontFamily,
        rich: { l1:{ fontSize:13,fontWeight:600,color:t.axisLabel,lineHeight:18 },
                l2:{ fontSize:11,fontWeight:500,color:t.axisName,lineHeight:14 } } },
      formatter: desktopLegendFormatter
    };
    legendCfg.data = sList.map(s => s.name);
    try {
      const prevSel = chart && chart.getOption && chart.getOption().legend && chart.getOption().legend[0] && chart.getOption().legend[0].selected;
      if (prevSel) legendCfg.selected = prevSel;
    } catch(_){}

    const finalSeries = [];
    if (showRawCurves) built.series.forEach(s => finalSeries.push(s));

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

    const toolboxFeatures = isNarrow ? {
      restore: {},
      saveAsImage: { backgroundColor: exportBg, pixelRatio: window.devicePixelRatio || 1 },
      myFullscreen: {
        show: true,
        title: !!document.fullscreenElement ? '退出全屏' : '全屏查看',
        icon: !!document.fullscreenElement
          ? 'path://M3 7v7h7M3 14l7-7M21 17v-7h-7M21 10l-7 7'
          : 'path://M3 10v-7h7M3 3l7 7M21 14v7h-7M21 21l-7-7',
        onclick: () => toggleFullscreen()
      }
    } : {
      dataZoom: { yAxisIndex: 'none' },
      restore: {},
      saveAsImage: { backgroundColor: exportBg, pixelRatio: window.devicePixelRatio || 1 },
      myFullscreen: {
        show: true,
        title: !!document.fullscreenElement ? '退出全屏' : '全屏查看',
        icon: !!document.fullscreenElement
          ? 'path://M3 7v7h7M3 14l7-7M21 17v-7h-7M21 10l-7 7'
          : 'path://M3 10v-7h7M3 3l7 7M21 14v7h-7M21 21l-7-7',
        onclick: () => toggleFullscreen()
      }
    };

    return {
      __empty:false,
      __titlePrefix:titlePrefix,

      backgroundColor: bgNormal,
      color: sList.map(s=>s.color),
      textStyle:{ fontFamily:t.fontFamily },
      // 修改：使用 CSS 的 --transition-speed 作为动画/状态过渡时长
      stateAnimation: { duration: transitionMs, easing: 'cubicOut' },
      animationDurationUpdate: transitionMs,
      animationEasingUpdate: 'cubicOut',

      grid:{ left:40, right: (isN ? 20 : 220), top: gridTop, bottom: (isN ? Math.min(320, 50 + (sList.length || 1) * 22) : 40) },

      title: { text: titleText, left: 'center', top: titleTop,
        textStyle: { color: t.axisLabel, fontSize: 20, fontWeight: 600, fontFamily: t.fontFamily } },

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
        appendToBody: true,
        confine: true,
        axisPointer: { type: "cross", label: { color: t.tooltipText } },
        trigger: 'item',
        backgroundColor: t.tooltipBg,
        borderColor: t.tooltipBorder, borderWidth: 1, borderRadius: 12,
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
          if (top  < pad) top  = pad;

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

      toolbox:{ top: -5, right: 0, feature:toolboxFeatures },

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
              <!--<span class="switch-label switch-label-right">转速</span>-->
              <!--<span class="switch-label switch-label-left">噪音</span>-->
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
      try { localStorage.setItem('x_axis_type', normalized); } catch(_) {}
      pos(normalized, true);
      protectSliderAnimationWindow();
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

    xAxisSwitchTrack.addEventListener('click', () => {
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

  // ===== UI：拟合气泡 / 指针 =====
  function ensureNarrowHint(){
    let hint = getById('narrowHint');
    if (!hint){
      hint = document.createElement('div');
      hint.id = 'narrowHint';
      hint.className = 'fit-narrow-hint';
      hint.textContent = `${FIT_ALGO_NAME}曲线请在图表右上角切换至全屏模式`;
      appendToRoot(hint);
    }
    return hint;
  }

  function ensureFitUI(){
    // 拟合开关按钮（窄屏也显示）
    let btns = getById('fitButtons');
    if (!btns){
      btns = document.createElement('div');
      btns.id = 'fitButtons';
      btns.className = 'fit-buttons';
      btns.innerHTML = `
        <button class="btn" id="btnRaw">ECHARTS<br>曲线</button>
        <button class="btn" id="btnFit">${FIT_ALGO_NAME}<br>曲线</button>
      `;
      appendToRoot(btns);
      const btnRaw = btns.querySelector('#btnRaw');
      const btnFit = btns.querySelector('#btnFit');
      function syncButtons(){
        btnRaw.classList.toggle('active', showRawCurves);
        btnFit.classList.toggle('active', showFitCurves);
      }
      function ensureAtLeastOne(onWhich){
        if (!showRawCurves && !showFitCurves){
          if (onWhich === 'raw') showFitCurves = true; else showRawCurves = true;
        }
      }
      btnRaw.addEventListener('click', ()=>{
        showRawCurves = !showRawCurves;
        ensureAtLeastOne('raw');
        syncButtons();
        if (lastPayload) render(lastPayload);
        requestAnimationFrame(placeFitUI);
      });
      btnFit.addEventListener('click', ()=>{
        showFitCurves = !showFitCurves;
        ensureAtLeastOne('fit');
        // 切换后重置气泡位置
        bubbleUserMoved = false; bubblePos.left = null; bubblePos.top = null;
        syncButtons();
        if (lastPayload) render(lastPayload);
        requestAnimationFrame(placeFitUI);
      });
      syncButtons();
    }

    // 气泡：挂到 body，使用 fixed；但位置以“相对图表”的偏移（bubblePos）计算
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
        <div class="hint">按系列可见性（Legend）过滤，按风量从大到小排序</div>
      `;
      // 关键：挂到 body，避免任何图表容器 overflow 剪裁
      document.body.appendChild(bubble);
      bubble.style.position = 'fixed';

      adoptBubbleHost();
      bindBubbleDrag(bubble);

      const xInput = bubble.querySelector('#fitXInput');
      xInput.addEventListener('input', onBubbleInputLive);
      xInput.addEventListener('change', onBubbleInputCommit);
      xInput.addEventListener('keydown', (e)=>{ if (e.key === 'Enter') { onBubbleInputCommit(); } });
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
  }

  function placeFitUI(){
    const btns = getById('fitButtons');
    const bubble = getById('fitBubble');
    if (!lastOption) return;

    const grid = lastOption.grid || { left:40, right: 260, top: 60, bottom: 40 };
    const chartW = chart ? chart.getWidth() : (root ? root.clientWidth : 800);
    const chartH = chart ? chart.getHeight() : (root ? root.clientHeight : 600);
    const left = (typeof grid.left==='number') ? grid.left : 40;
    const rightGap = (typeof grid.right==='number') ? grid.right : 260;
    const top = (typeof grid.top==='number') ? grid.top : 60;
    const bottomGap = (typeof grid.bottom==='number') ? grid.bottom : 40;

    if (btns){
      // CHANGED: 当 legend 进入窄屏布局时，按钮改为纵向排列
      const narrow = layoutIsNarrow();
      btns.style.flexDirection = narrow ? 'column' : 'row';

      btns.style.right = '10px';
      btns.style.bottom = '10px';
      btns.style.position = 'absolute';
      btns.style.visibility = (lastOption.__empty) ? 'hidden' : 'visible';
    }

    if (bubble){
      // bubble 在 body 上，使用 fixed；但位置等于“图表左上角 + 相对偏移 bubblePos”
      const r = root ? root.getBoundingClientRect() : { left:0, top:0 };
      const vw = window.innerWidth, vh = window.innerHeight;
      const bw = bubble.offsetWidth  || 0;
      const bh = bubble.offsetHeight || 0;
      const pad = 6;

      // 默认偏移：绘图区左上角（不偏移）
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

      // 计算 fixed 位置
      let fx = r.left + offX;
      let fy = r.top  + offY;

      // 轻微可视区钳制（不把气泡完全挤出屏幕）
      fx = Math.min(Math.max(-bw + pad, fx), Math.max(pad, vw - pad));
      fy = Math.min(Math.max(-bh + pad, fy), Math.max(pad, vh - pad));

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
  }
  function onBubbleInputCommit(){
    repaintPointer();
    refreshFitBubble();
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
      const visible = (selMap[s.name] !== false);
      if (!visible) return;
      const model = fitModelsCache[mode].get(s.name);
      if (!model) return;

      const dom0 = Math.min(model.x0, model.x1);
      const dom1 = Math.max(model.x0, model.x1);
      let y = NaN;
      if (x >= dom0 && x <= dom1) y = evalPchipJS(model, x);
      items.push({ name: s.name, color: s.color, y });
    });

    const fmt = (v)=> Math.round(v);
    const withVal = items.filter(it => Number.isFinite(it.y)).sort((a,b)=> b.y - a.y);
    const noVal   = items.filter(it => !Number.isFinite(it.y));

    const base = (withVal.length && withVal[0].y > 0) ? withVal[0].y : 0;
    const pctVal = (v)=> (Number.isFinite(v) && base > 0) ? Math.round((v / base) * 100) : null;

    const valTexts = items.map(it => Number.isFinite(it.y) ? `${fmt(it.y)} CFM` : '-');
    const maxValChars = valTexts.reduce((m,s)=>Math.max(m, s.length), 1);
    const pctWidthCh = 6;

    const ordered = withVal.concat(noVal);
    rowsEl.innerHTML = ordered.map(it => {
      const has = Number.isFinite(it.y);
      const valText = has ? `${fmt(it.y)} CFM` : '-';
      const pct = has ? pctVal(it.y) : null;
      const pctText = (pct==null) ? '-' : `(${pct}%)`;
      return `
        <div class="row">
          <span class="dot" style="background:${it.color}"></span>
          <span>${it.name}</span>
          <span style="margin-left:auto; display:inline-flex; align-items:center; gap:8px;">
            <span style="min-width:${maxValChars}ch; text-align:right; font-weight:800; font-variant-numeric:tabular-nums;">${valText}</span>
            <span style="width:${pctWidthCh}ch; text-align:right; font-variant-numeric:tabular-nums;">${pctText}</span>
          </span>
        </div>
      `;
    }).join('');
  }

  function ensureFitModels(sList, xMode){
    const models = fitModelsCache[xMode];
    sList.forEach(s => {
      const ph = s && s.pchip ? (xMode === 'noise_db' ? s.pchip.noise_db : s.pchip.rpm) : null;
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

  // 全屏
  async function enterFullscreen(){
    const target = root || document.getElementById('chartHost') || document.documentElement;
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
      adoptBubbleHost();                 // 关键：把气泡迁移进全屏元素
      bubbleUserMoved = false;
      if (lastPayload) render(lastPayload); else if (chart) chart.resize();
      requestAnimationFrame(() => { try { placeFitUI(); repaintPointer(); } catch(_) {} });
    }
  }

  async function exitFullscreen(){
    try { if (document.fullscreenElement) await document.exitFullscreen(); }
    catch(err){ console.warn('exitFullscreen 失败：', err); }
    finally {
      isFs = false;
      adoptBubbleHost();                 // 迁回 body
      bubbleUserMoved = false;
      if (lastPayload) render(lastPayload); else if (chart) chart.resize();
      requestAnimationFrame(() => { try { placeFitUI(); repaintPointer(); } catch(_) {} });
    }
  }

  function toggleFullscreen(){ if (document.fullscreenElement) exitFullscreen(); else enterFullscreen(); }

  // 挂到全局
  window.ChartRenderer = API;
})();