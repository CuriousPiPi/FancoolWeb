/* chart.js
 * Phase 2: 图表 iframe 通信 / X轴类型 / 数据过滤 / 队列
 * 增补：refreshTheme() 供主题切换后重新发送数据
 */
(function initChartModule(){
  window.__APP = window.__APP || {};
  const colorMod = window.__APP.color;
  function getColorMod(){ return window.__APP.color; }

  const chartFrame = document.getElementById('chartFrame');
  let lastChartData = null;
  let frontXAxisType = 'rpm';
  let pendingShareMeta = null;
  let __isShareLoaded = (function(){
    try {
      const usp = new URLSearchParams(window.location.search);
      return usp.get('share_loaded') === '1';
    } catch(_) { return false; }
  })();
  let __shareAxisApplied = false;

  const chartMessageQueue = [];
  let chartFrameReady = false;
  let postRetryCount = 0;
  const MAX_POST_RETRY = 10;

  function safePostMessage(msg){
    try {
      chartFrame.contentWindow.postMessage(msg, window.location.origin);
      return true;
    } catch(e){
      console.warn('[chart] postMessage error', e);
      return false;
    }
  }

  function initPersistedXAxisType(){
    try {
      const saved = localStorage.getItem('x_axis_type');
      if (saved === 'rpm' || saved === 'noise_db' || saved === 'noise') {
        frontXAxisType = (saved === 'noise') ? 'noise_db' : saved;
      }
    } catch(_) {}
  }
  initPersistedXAxisType();

  function getFrontXAxisType(){ return frontXAxisType; }

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
    setTimeout(()=>resizeChart(), 50);
  }

  if (chartFrame) {
    chartFrame.addEventListener('load', () => {
      if (!chartFrameReady) {
        chartFrameReady = true;
        flushChartQueue();
        if (lastChartData && !chartMessageQueue.length) {
          postChartData(lastChartData);
        }
      }
    });
     setTimeout(()=>{
      if(!chartFrameReady){
        console.info('[chart] iframe load timeout fallback flush');
        chartFrameReady = true;
        flushChartQueue();
        if (lastChartData) postChartData(lastChartData);
      }
    }, 1000);
  }

  function getChartBg(){
    const host = document.getElementById('chart-settings') || document.body;
    let bg = '';
    try { bg = getComputedStyle(host).backgroundColor; } catch(_) {}
    if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') {
      try { bg = getComputedStyle(document.body).backgroundColor; } catch(_) {}
    }
    return bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : '#ffffff';
  }

  function isValidNum(v){ return typeof v === 'number' && Number.isFinite(v); }
  function filterChartDataForAxis(chartData) {
    const axis = chartData.x_axis_type === 'noise' ? 'noise_db' : chartData.x_axis_type;
    const cleaned = { ...chartData, series: [] };
    chartData.series.forEach((s) => {
      const rpmArr   = Array.isArray(s.rpm) ? s.rpm : [];
      const noiseArr = Array.isArray(s.noise_db) ? s.noise_db : [];
      const flowArr  = Array.isArray(s.airflow) ? s.airflow : [];
      const xArr = axis === 'noise_db' ? noiseArr : rpmArr;

      const rpmNew = [], noiseNew = [], flowNew = [];
      for (let i=0;i<xArr.length;i++){
        const x = xArr[i], y = flowArr[i];
        if (isValidNum(x) && isValidNum(y)){
          rpmNew.push(isValidNum(rpmArr[i]) ? rpmArr[i] : null);
          noiseNew.push(isValidNum(noiseArr[i]) ? noiseArr[i] : null);
          flowNew.push(y);
        }
      }
      const hasAxisPoints = axis === 'noise_db'
        ? noiseNew.some(isValidNum)
        : rpmNew.some(isValidNum);
      if (flowNew.length > 0 && hasAxisPoints){
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

    const cm = getColorMod();
    if (!cm){
      if (postRetryCount < MAX_POST_RETRY){
        postRetryCount++;
        setTimeout(()=>postChartData(chartData), 60);
      } else {
        console.warn('[chart] color module not ready after retries, sending raw');
      }
    }

    let prepared;
    try {
      prepared = cm ? cm.withFrontColors(chartData) : chartData;
    } catch(e){
      console.warn('[chart] withFrontColors error, fallback raw', e);
      prepared = chartData;
    }

    if (__isShareLoaded && !__shareAxisApplied && chartData && chartData.x_axis_type){
      frontXAxisType = (chartData.x_axis_type === 'noise') ? 'noise_db' : chartData.x_axis_type;
      try { localStorage.setItem('x_axis_type', frontXAxisType); } catch(_){}
      __shareAxisApplied = true;
      prepared = { ...prepared, x_axis_type: frontXAxisType };
    }

    // 过滤 & 打包
    const filtered = filterChartDataForAxis(prepared);
    const payload = {
      chartData: filtered,
      theme: cm?.currentThemeStr ? cm.currentThemeStr() : 'light',
      chartBg: getChartBg()
    };
    if (pendingShareMeta){
      payload.shareMeta = pendingShareMeta;
      pendingShareMeta = null;
    }
    const msg = { type:'chart:update', payload };
    if (!chartFrameReady){
      chartMessageQueue.push(msg);
    } else {
      if (!safePostMessage(msg)){
        chartMessageQueue.push(msg);
        setTimeout(flushChartQueue, 120);
      }
    }
  }

  if (__isShareLoaded && !window.__APP.__didScrollToChart){
    const anchor = document.getElementById('chartFrame') || document.getElementById('chart-container') || chartFrame;
    if (anchor && typeof anchor.scrollIntoView === 'function'){
      anchor.scrollIntoView({ behavior:'smooth', block:'start' });
      window.__APP.__didScrollToChart = true;
    }
  }

  // 监听 color 模块 ready（如果 color.js 在其内部 dispatch 自定义事件，或我们在 window 上标记）
  document.addEventListener('DOMContentLoaded', ()=>{
    if (lastChartData && getColorMod() && postRetryCount>0){
      postChartData(lastChartData);
    }
  });

  // SSE / 其他模块可手动重放
  window.addEventListener('color-module-ready', ()=>{
    if (lastChartData) postChartData(lastChartData);
  });

  function resizeChart(){
    if (!chartFrame || !chartFrame.contentWindow) return;
    chartFrame.contentWindow.postMessage({ type:'chart:resize' }, window.location.origin);
  }

  function setPendingShareMeta(meta){
    pendingShareMeta = meta;
  }

  function forceAxis(next){
    if (!next) return;
    const normalized = (next === 'noise') ? 'noise_db' : next;
    if (normalized !== frontXAxisType){
      frontXAxisType = normalized;
      try { localStorage.setItem('x_axis_type', frontXAxisType); } catch(_){}
      if (lastChartData) postChartData(lastChartData);
    }
  }

  /* 新增：主题刷新接口 */
  function refreshTheme(){
    if (lastChartData) {
      // 重新发送以便颜色 / 背景 / 主题样式更新
      postChartData(lastChartData);
    } else {
      resizeChart();
    }
  }

  window.addEventListener('message',(e)=>{
    if (e.origin !== window.location.origin) return;
    const { type, payload } = e.data || {};
    if (type === 'chart:ready'){
      chartFrameReady = true;
      flushChartQueue();
      if (lastChartData && !chartMessageQueue.length) postChartData(lastChartData);
      return;
    }
    if (type === 'chart:xaxis-type-changed'){
      forceAxis(payload?.x_axis_type);
    }
  });

  window.__APP.chart = {
    postChartData,
    resizeChart,
    getFrontXAxisType,
    setPendingShareMeta,
    forceAxis,
    refreshTheme
  };

  // 旧全局
  window.postChartData = postChartData;
  window.resizeChart = resizeChart;
  window.filterChartDataForAxis = filterChartDataForAxis;

})();