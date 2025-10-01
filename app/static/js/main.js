/* main.js
 * 初始化：拉取初始状态 / 查询次数 / 访问上报 / 旧接口兼容
 * 依赖：core.js, color.js, chart.js, layout.js, state-ui.js
 */

(function initMainEntry(){
  console.info('[Fancool] main.js initializing.');

  const stateUI = window.__APP.stateUI;
  if (!stateUI){
    console.warn('[Fancool] stateUI 未加载，初始化被跳过。');
    return;
  }

  // 初始状态拉取
  fetch('/api/state')
    .then(r=>r.json())
    .then(d=>stateUI.processState(d,''))
    .catch(()=>{});

  // 查询次数
  function loadQueryCount(){
    fetch('/api/query_count')
      .then(r=>r.json())
      .then(data=>{
        const el=document.getElementById('query-count');
        if (el) el.textContent = data.count;
      })
      .catch(()=>{});
  }
  document.addEventListener('DOMContentLoaded', loadQueryCount);

  // 访问上报（一次）
  (function visitStart(){
    try { if (sessionStorage.getItem('visit_started')==='1') return; } catch(_){}
    const payload={
      screen_w:(screen && screen.width)||null,
      screen_h:(screen && screen.height)||null,
      device_pixel_ratio: window.devicePixelRatio || null,
      language: (navigator.languages && navigator.languages[0]) || navigator.language || null,
      is_touch: ('ontouchstart' in window) || (navigator.maxTouchPoints > 0)
    };
    fetch('/api/visit_start',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(payload),
      keepalive:true
    }).catch(()=>{}).finally(()=>{ try { sessionStorage.setItem('visit_started','1'); } catch(_){}} );
  })();

  // chart 消息（可扩展）
  window.addEventListener('message', (e)=>{
    if (e.origin !== window.location.origin) return;
    const { type } = e.data || {};
    if (type === 'chart:ready'){
      // 可在此做补发数据逻辑（chart.js 通常已处理）
    }
    if (type === 'chart:xaxis-type-changed'){
      // 若需要在 UI 层记录，可扩展
    }
  });

  // 旧接口兼容（保持原 window.__APP.modules）
  window.__APP.modules = {
    layout: {
      scheduleAdjust: window.__APP.layout?.scheduleAdjust,
      refreshMarquees: window.__APP.layout?.refreshMarquees
    },
    search: {
      render: stateUI.renderSearchResults,
      cache: window.__APP.cache
    },
    rankings: {
      reloadTopRatings: stateUI.reloadTopRatings,
      loadLikesIfNeeded: stateUI.loadLikesIfNeeded
    },
    state: {
      processState: stateUI.processState
    },
    chart: {
      postChartData: window.__APP.chart?.postChartData,
      resizeChart: window.__APP.chart?.resizeChart
    }
  };

  console.info('[Fancool] main.js initialized.');
})();