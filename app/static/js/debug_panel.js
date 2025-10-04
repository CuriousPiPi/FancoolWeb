/* Debug Panel: fetch / postMessage / LocalState instrumentation */
;(function(){
  const qs = new URLSearchParams(location.search);
  const AUTO = qs.get('debug') === '1' || localStorage.getItem('__FC_DEBUG__') === '1';

  const MAX_LOG = 500;
  const STATE = {
    logs: [],
    filters: { fetch: true, 'msg-in': true, 'msg-out': true, ls: true, error: true, info: true },
    open: AUTO
  };

  function nowStr(){
    const d = new Date();
    return d.toISOString().split('T')[1].replace('Z','');
  }

  function trim(str, max=400){
    if (!str) return '';
    str = String(str);
    return str.length > max ? str.slice(0, max) + '…' : str;
  }

  function log(type, data){
    if (!STATE.filters[type] && !STATE.filters[data?.level || '']) {
      // 仍然存储但可根据需要跳过：这里不跳过存储，因为可能后面切换过滤
    }
    STATE.logs.push({
      id: STATE.logs.length + 1,
      t: nowStr(),
      type,
      data
    });
    if (STATE.logs.length > MAX_LOG) STATE.logs.splice(0, STATE.logs.length - MAX_LOG);
    if (STATE.open) render();
  }

  function levelColor(type, data){
    if (type === 'error' || data?.level === 'error') return '#ff4d4f';
    if (type === 'fetch') {
      if (data?.status >= 400) return '#ff7875';
      if (data?.status >= 300) return '#faad14';
      return '#52c41a';
    }
    if (type.startsWith('msg')) return '#69c0ff';
    if (type === 'ls') return '#b37feb';
    return '#d9d9d9';
  }

  function escapeHtml(s){
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'
    })[c]);
  }

  function fmtJSON(obj){
    try { return escapeHtml(JSON.stringify(obj, null, 2)); } catch { return ''; }
  }

  let panel, bodyEl, countBadge;

  function buildPanel(){
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'debugPanel';
    panel.innerHTML = `
      <style>
        #debugPanel{
          position:fixed;right:0;bottom:0;width:460px;height:55vh;z-index:999999;
          background:#111d;backdrop-filter:blur(4px);color:#eee;font:12px/1.3 monospace;
          display:flex;flex-direction:column;border:1px solid #333;border-right:none;
        }
        #debugPanel.hidden { display:none; }
        #debugPanel header{
          display:flex;align-items:center;gap:6px;padding:4px 8px;background:#222;
          border-bottom:1px solid #333;font-size:12px;flex-wrap:wrap;
        }
        #debugPanel header button{
          background:#444;border:1px solid #666;color:#eee;padding:2px 6px;
          cursor:pointer;font-size:12px;border-radius:3px;
        }
        #debugPanel header button.active{background:#1677ff;border-color:#1677ff;}
        #debugPanel header button.danger{background:#a8071a;border-color:#a8071a;}
        #debugPanel header .grow{flex:1;}
        #debugPanel .dbg-body{
            flex:1;overflow:auto;font-family:monospace;padding:4px;background:#0d0d0d;
        }
        #debugPanel .dbg-row{
          border-bottom:1px solid #1f1f1f;padding:3px 2px;white-space:pre-wrap;word-break:break-all;
        }
        #debugPanel .dbg-row:hover{background:#262626;}
        #debugPanel .meta{display:flex;align-items:center;gap:6px;margin-bottom:2px;flex-wrap:wrap;}
        #debugPanel .badge{
          display:inline-block;font-size:10px;padding:1px 4px;border-radius:2px;
          background:#333;color:#eee;
        }
        #debugPanel .time{color:#999;font-size:10px;}
        #debugPanel .payload{font-size:11px;line-height:1.35;white-space:pre-wrap;}
        #debugPanel .status-badge{padding:1px 4px;border-radius:2px;font-size:10px;}
        #debugPanel .toggle-btn{
          position:fixed;right:0;bottom:55vh;transform:translateY(4px);
          background:#1677ff;color:#fff;border:none;padding:4px 8px;
          cursor:pointer;font-size:12px;border-radius:4px 0 0 4px;z-index:999999;
        }
        #debugPanel.dark body{}
        #debugPanel .filter-group{display:flex;gap:4px;flex-wrap:wrap;}
        #debugPanel .cnt-badge{
          background:#555;color:#fff;padding:2px 6px;border-radius:3px;font-size:11px;
        }
        #debugPanel .copy-btn{
          background:#555;border:1px solid #777;color:#eee;font-size:10px;
          padding:1px 4px;cursor:pointer;border-radius:2px;
        }
        #debugPanel .copy-btn:hover{background:#666;}
      </style>
      <header>
        <button data-act="clear" class="danger">清空</button>
        <button data-act="pause">暂停</button>
        <span class="cnt-badge" id="dbgCount">0</span>
        <div class="filter-group" id="dbgFilters"></div>
        <div class="grow"></div>
        <button data-act="close">关闭</button>
      </header>
      <div class="dbg-body" id="dbgBody"></div>
    `;
    document.body.appendChild(panel);

    // Toggle button
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'toggle-btn';
    toggleBtn.textContent = STATE.open ? 'DBG-' + STATE.logs.length : 'DBG';
    toggleBtn.addEventListener('click', ()=> {
      STATE.open = !STATE.open;
      panel.classList.toggle('hidden', !STATE.open);
      toggleBtn.textContent = STATE.open ? 'DBG-' + STATE.logs.length : 'DBG';
      if (STATE.open) render();
      localStorage.setItem('__FC_DEBUG__', STATE.open ? '1':'0');
    });
    document.body.appendChild(toggleBtn);

    bodyEl = panel.querySelector('#dbgBody');
    countBadge = panel.querySelector('#dbgCount');
    buildFilters(panel.querySelector('#dbgFilters'));

    panel.querySelector('header').addEventListener('click', (e)=>{
      const btn = e.target.closest('button');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'clear'){
        STATE.logs = [];
        render();
      } else if (act === 'pause'){
        btn.classList.toggle('active');
        STATE.paused = btn.classList.contains('active');
        btn.textContent = STATE.paused ? '继续' : '暂停';
      } else if (act === 'close'){
        STATE.open = false;
        panel.classList.add('hidden');
        localStorage.setItem('__FC_DEBUG__', '0');
        document.querySelector('.toggle-btn').textContent = 'DBG';
      }
    });

    if (!STATE.open) panel.classList.add('hidden');
    return panel;
  }

  function buildFilters(container){
    container.innerHTML = '';
    const items = [
      ['fetch','fetch'],
      ['msg-in','msg-in'],
      ['msg-out','msg-out'],
      ['ls','local'],
      ['error','error'],
      ['info','info']
    ];
    items.forEach(([key,label])=>{
      const b = document.createElement('button');
      b.textContent = label;
      b.dataset.filter = key;
      b.className = STATE.filters[key] ? 'active' : '';
      b.addEventListener('click', ()=>{
        STATE.filters[key] = !STATE.filters[key];
        b.classList.toggle('active', STATE.filters[key]);
        render();
      });
      container.appendChild(b);
    });
  }

  function render(){
    if (!panel) return;
    const logs = STATE.logs.filter(item => {
      if (!STATE.filters[item.type] && !STATE.filters[item.data?.level || '']) return false;
      return true;
    });
    countBadge.textContent = STATE.logs.length;
    const frag = document.createDocumentFragment();
    logs.slice(-250).forEach(entry=>{
      const row = document.createElement('div');
      row.className = 'dbg-row';
      const c = levelColor(entry.type, entry.data);
      let metaHtml = `<span class="time">${entry.t}</span> <span class="badge" style="background:${c}">${entry.type}</span>`;
      if (entry.type === 'fetch'){
        metaHtml += ` <span class="status-badge" style="background:${entry.data.status>=400?'#a8071a':'#0958d9'}">${entry.data.status}</span>`;
        metaHtml += ` <span>${escapeHtml(entry.data.method)} ${escapeHtml(entry.data.url)}</span>`;
        metaHtml += ` <span>${entry.data.ms}ms</span>`;
      } else if (entry.type === 'msg-in' || entry.type === 'msg-out') {
        metaHtml += ` <span>${escapeHtml(entry.data?.data?.type || '')}</span>`;
      } else if (entry.type === 'ls') {
        metaHtml += ` <span>${escapeHtml(entry.data.action)}</span>`;
      }
      const info = entry.data;
      let body = '';
      if (entry.type === 'fetch'){
        body += info.requestBody ? `req: ${escapeHtml(trim(info.requestBody, 300))}\n` : '';
        body += info.responseBody ? `res: ${escapeHtml(trim(info.responseBody, 500))}` : '';
      } else if (entry.type.startsWith('msg')) {
        body = fmtJSON(info.data);
      } else if (entry.type === 'ls') {
        body = fmtJSON(info.detail);
      } else if (entry.type === 'error' || entry.type === 'info'){
        body = fmtJSON(info);
      }
      row.innerHTML = `
        <div class="meta">${metaHtml} 
          <button class="copy-btn" data-copy="${encodeURIComponent(body)}">复制</button>
        </div>
        <div class="payload">${body || ''}</div>
      `;
      frag.appendChild(row);
    });
    bodyEl.innerHTML = '';
    bodyEl.appendChild(frag);
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  /* ==== FETCH HOOK ==== */
  function hookFetch(){
    if (window.__FETCH_HOOKED__) return;
    const orig = window.fetch;
    window.fetch = async function(input, init){
      if (STATE.paused) return orig(input, init);
      const url = (typeof input === 'string') ? input : input.url;
      const method = (init && init.method) || (typeof input === 'object' ? input.method : 'GET') || 'GET';
      let requestBody = '';
      try {
        if (init && init.body) requestBody = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
      } catch(_) {}
      const start = performance.now();
      let status = 0, responseBody = '', ok = false;
      try {
        const resp = await orig(input, init);
        status = resp.status;
        ok = resp.ok;
        const clone = resp.clone();
        let text = '';
        try { text = await clone.text(); } catch(_) {}
        responseBody = text;
        log('fetch', { url, method, status, ms: Math.round(performance.now()-start), requestBody, responseBody });
        return resp;
      } catch(err){
        log('fetch', { url, method, status: status || 0, ms: Math.round(performance.now()-start), requestBody, responseBody:'<ERROR '+err.message+'>' });
        throw err;
      }
    };
    window.__FETCH_HOOKED__ = true;
  }

  /* ==== postMessage HOOK ==== */
  function hookPostMessage(){
    if (window.__PM_HOOKED__) return;
    // Incoming
    window.addEventListener('message', (e)=>{
      if (STATE.paused) return;
      try {
        log('msg-in', { origin: e.origin, data: e.data });
      } catch(_) {}
    }, true);
    // Outgoing (wrap contentWindow after available)
    function wrapChart(){
      try{
        const frame = document.getElementById('chartFrame');
        if (!frame || !frame.contentWindow) return;
        if (frame.contentWindow.__PM_WRAPPED__) return;
        const orig = frame.contentWindow.postMessage;
        frame.contentWindow.postMessage = function(data, targetOrigin, transfer){
          if (!STATE.paused){
            try { log('msg-out', { to:'chartFrame', data }); } catch(_) {}
          }
          return orig.call(this, data, targetOrigin, transfer);
        };
        frame.contentWindow.__PM_WRAPPED__ = true;
      }catch(_){}
    }
    const mo = new MutationObserver(wrapChart);
    mo.observe(document.documentElement, { childList:true, subtree:true });
    window.addEventListener('load', wrapChart);
    wrapChart();
    window.__PM_HOOKED__ = true;
  }

  /* ==== LocalState HOOK ==== */
  function hookLocalState(){
    if (window.__LS_HOOKED__) return;
    function apply(){
      const LS = window.LocalState;
      if (!LS) { setTimeout(apply, 500); return; }
      if (LS.__DBG_WRAPPED__) return;
      function wrap(fnName){
        const orig = LS[fnName];
        if (typeof orig !== 'function') return;
        LS[fnName] = async function(...args){
          const detail = { args };
            if (!STATE.paused) log('ls', { action: fnName, detail });
          try {
            const r = await orig.apply(this, args);
            if (!STATE.paused) log('ls', { action: fnName + ':done', detail: { result: r } });
            return r;
          } catch(e){
            if (!STATE.paused) log('error', { level:'error', where:'LocalState.'+fnName, message:e.message, stack:e.stack });
            throw e;
          }
        };
      }
      ['addItems','removeItem','clearAll','fetchCurvesForPairs','saveConfig','saveCfgPatch'].forEach(wrap);
      LS.__DBG_WRAPPED__ = true;
      window.__LS_HOOKED__ = true;
    }
    apply();
  }

  /* ==== PUBLIC API ==== */
  window.__DEBUG = {
    log,
    toggle(){
      STATE.open = !STATE.open;
      buildPanel();
      panel.classList.toggle('hidden', !STATE.open);
      localStorage.setItem('__FC_DEBUG__', STATE.open ? '1':'0');
      render();
    },
    show(){
      STATE.open = true;
      buildPanel();
      panel.classList.remove('hidden');
      render();
    },
    hide(){
      STATE.open = false;
      buildPanel();
      panel.classList.add('hidden');
      render();
    },
    state: STATE
  };

  // INIT
  function init(){
    buildPanel();
    hookFetch();
    hookPostMessage();
    hookLocalState();
    if (STATE.open) render();
  }

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();