// 单容器宿主切换：curves <-> spectrum
(function(){
  if (window.ChartHostManager) return;

  let hostEl = null;
  let active = (function(){
    try { return localStorage.getItem('active_chart_view') || 'curves'; } catch(_) { return 'curves'; }
  })();

  function persist(){
    try { localStorage.setItem('active_chart_view', active); } catch(_){}
  }

  function mount(el){
    hostEl = el || document.getElementById('chartHost');
    if (!hostEl) return;
    // 默认先挂载曲线渲染器
    if (active === 'curves') {
      if (window.ChartRenderer && typeof ChartRenderer.mount === 'function') {
        ChartRenderer.mount(hostEl);
      }
    } else {
      if (window.SpectrumRenderer && typeof SpectrumRenderer.mount === 'function') {
        SpectrumRenderer.mount(hostEl);
      } else if (window.ChartRenderer && typeof ChartRenderer.mount === 'function') {
        // 兜底先挂 curves，等 Spectrum 加载再切换
        ChartRenderer.mount(hostEl);
      }
    }
  }

  function switchTo(name){
    const next = (name === 'spectrum') ? 'spectrum' : 'curves';
    if (next === active) return;
    active = next; persist();

    // 直接在同一容器重挂（各自内部持有 root）
    if (active === 'curves') {
      if (window.ChartRenderer?.mount) ChartRenderer.mount(hostEl);
    } else {
      if (window.SpectrumRenderer?.mount) SpectrumRenderer.mount(hostEl);
    }
  }

  function render(payload){
    if (active === 'curves') {
      window.ChartRenderer?.render && ChartRenderer.render(payload);
    } else {
      window.SpectrumRenderer?.render && SpectrumRenderer.render(payload);
    }
  }

  function resize(){
    if (active === 'curves') window.ChartRenderer?.resize && ChartRenderer.resize();
    else window.SpectrumRenderer?.resize && SpectrumRenderer.resize();
  }

  function setTheme(theme){
    if (active === 'curves') window.ChartRenderer?.setTheme && ChartRenderer.setTheme(theme);
    else window.SpectrumRenderer?.setTheme && SpectrumRenderer.setTheme(theme);
  }

  function getActive(){ return active; }

  window.ChartHostManager = { mount, switchTo, render, resize, setTheme, getActive };
})();