// 轻量渲染器基类与通用工具（面向 ChartRenderer / SpectrumRenderer 复用）
(function initRendererBase(){
  if (window.RendererBase) return;

  // 单一 Canvas 用于文本测量
  const __measureCtx = (function(){
    try { const c = document.createElement('canvas'); return c.getContext('2d'); }
    catch(_){ return null; }
  })();

  function normalizeTheme(theme){
    const t = String(theme || '').toLowerCase();
    return t === 'dark' ? 'dark' : 'light';
  }

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

  function tokens(theme) {
    const dark = normalizeTheme(theme) === 'dark';
    return {
      fontFamily:'system-ui,-apple-system,"Segoe UI","Helvetica Neue","Microsoft YaHei",Arial,sans-serif',
      axisLabel: dark ? '#d1d5db' : '#4b5563',
      axisName:  dark ? '#9ca3af' : '#6b7280',
      axisLine:  dark ? '#374151' : '#e5e7eb',
      gridLine:  dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)',
      tooltipBg: dark ? 'var(--bg-bubble)' : 'rgba(255,255,255,0.98)',
      tooltipBorder: dark ? '#374151' : '#e5e7eb',
      tooltipText: dark ? '#f3f4f6' : '#1f2937',
      tooltipShadow: dark ? '0 6px 20px rgba(0,0,0,0.45)' : '0 6px 20px rgba(0,0,0,0.12)',
      pagerIcon: dark ? '#93c5fd' : '#2563eb'
    };
  }

  function measureText(text, size, weight, family){
    if (!__measureCtx) {
      const s = Number(size || 14);
      return { width: String(text||'').length * (s * 0.6), height: s * 1.2 };
    }
    const sz = Number(size || 14);
    __measureCtx.font = `${String(weight||400)} ${sz}px ${family||'sans-serif'}`;
    const m = __measureCtx.measureText(text || '');
    const width = m.width || 0;
    const ascent = (typeof m.actualBoundingBoxAscent === 'number') ? m.actualBoundingBoxAscent : sz * 0.8;
    const descent = (typeof m.actualBoundingBoxDescent === 'number') ? m.actualBoundingBoxDescent : sz * 0.2;
    return { width, height: ascent + descent };
  }

  function getExportBg() {
    try {
      const bgBody = getComputedStyle(document.body).backgroundColor;
      return bgBody && bgBody !== 'rgba(0, 0, 0, 0)' ? bgBody : '#ffffff';
    } catch(_){ return '#ffffff'; }
  }

  function getByIdScoped(root, id){
    if (!id) return null;
    let el = null;
    try { if (root && typeof root.querySelector === 'function') el = root.querySelector('#' + id); } catch(_){}
    return el || document.getElementById(id);
  }

  function appendToRoot(root, el){
    try { (root || document.body || document.documentElement).appendChild(el); }
    catch(_){ try { document.body.appendChild(el); } catch(_){ } }
  }

  function setTheme(theme, opts){
    const notifyServer = !!(opts && opts.notifyServer);
    let t = normalizeTheme(theme);
    if (window.ThemePref?.save) {
      t = window.ThemePref.save(t, { notifyServer });
      if (window.ThemePref.setDom) window.ThemePref.setDom(t);
      else document.documentElement.setAttribute('data-theme', t);
    } else {
      document.documentElement.setAttribute('data-theme', t);
      try { localStorage.setItem('theme', t); } catch(_){}
    }
    return t;
  }

  window.RendererBase = {
    utils: {
      getCssTransitionMs,
      tokens,
      measureText,
      getExportBg,
      getByIdScoped,
      appendToRoot,
      setTheme
    }
  };
})();