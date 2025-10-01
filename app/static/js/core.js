/* core.js (Slim Utility Layer)
 * 职责：DOM 缓存 / scheduler / TTL cache / safeClosest / Toast & Loading / Throttle / HTML 转义 / formatScenario / 通用工具导出
 * 不包含业务：选中/点赞/搜索/排行/表单级联/最近点赞等
 */

window.APP_CONFIG = window.APP_CONFIG || { clickCooldownMs: 2000, maxItems: 0 };
window.__APP = window.__APP || {};

/* ---------------- DOM 缓存 ---------------- */
(function initDomCache(){
  const cache = Object.create(null);
  function one(sel, scope){
    if (!sel) return null;
    if (!scope && cache[sel]) return cache[sel];
    const el = (scope||document).querySelector(sel);
    if (!scope) cache[sel]=el;
    return el;
  }
  function all(sel, scope){ return Array.from((scope||document).querySelectorAll(sel)); }
  function clear(sel){ if(sel) delete cache[sel]; else Object.keys(cache).forEach(k=>delete cache[k]); }
  window.__APP.dom = { one, all, clear };
})();

/* ---------------- 帧写调度 ---------------- */
window.__APP.scheduler = (function(){
  const writeQueue = [];
  let scheduled=false;
  function flush(){
    scheduled=false;
    for (let i=0;i<writeQueue.length;i++){
      try { writeQueue[i](); } catch(e){ console.error('[scheduler write error]', e); }
    }
    writeQueue.length=0;
  }
  function write(fn){
    writeQueue.push(fn);
    if (!scheduled){ scheduled=true; requestAnimationFrame(flush); }
  }
  return { write };
})();

/* ---------------- TTL 缓存 ---------------- */
window.__APP.cache = (function(){
  const store = new Map();
  const DEFAULT_TTL = 180000;
  const key = (ns,p)=> ns+'::'+JSON.stringify(p||{});
  function get(ns,p){
    const k=key(ns,p);
    const rec=store.get(k);
    if (!rec) return null;
    if (Date.now()>rec.expire){ store.delete(k); return null; }
    return rec.value;
  }
  function set(ns,p,v,ttl=DEFAULT_TTL){
    store.set(key(ns,p), { value:v, expire:Date.now()+ttl });
    return v;
  }
  function clear(ns){
    if (!ns){ store.clear(); return; }
    for (const k of store.keys()) if (k.startsWith(ns+'::')) store.delete(k);
  }
  return { get,set,clear };
})();

/* ---------------- Polyfill / safeClosest ---------------- */
(function(){
  if (typeof Element!=='undefined'){
    if (!Element.prototype.matches){
      Element.prototype.matches =
        Element.prototype.msMatchesSelector ||
        Element.prototype.webkitMatchesSelector ||
        function(selector){
          const list=(this.document||this.ownerDocument).querySelectorAll(selector);
          let i=0; while(list[i] && list[i]!==this) i++; return !!list[i];
        };
    }
    if (!Element.prototype.closest){
      Element.prototype.closest=function(selector){
        let el=this;
        while(el && el.nodeType===1){
          if (el.matches(selector)) return el;
          el=el.parentElement;
        }
        return null;
      };
    }
  }
  window.safeClosest = function safeClosest(start, selector){
    if (!start) return null;
    let el=start;
    if (el.nodeType && el.nodeType!==1) el=el.parentElement;
    if (!el) return null;
    if (el.closest){
      try { return el.closest(selector); } catch(_){}
    }
    while(el && el.nodeType===1){
      if (el.matches && el.matches(selector)) return el;
      el=el.parentElement;
    }
    return null;
  };
})();

/* ---------------- Toast / Loading / Throttle / HTML Escaping ---------------- */
const toastContainerId='toastContainer';
function ensureToastRoot(){
  let r=document.getElementById(toastContainerId);
  if(!r){ r=document.createElement('div'); r.id=toastContainerId; document.body.appendChild(r); }
  return r;
}
let toastIdCounter=0;
const activeLoadingKeys=new Set();
const loadingTimeoutMap=new Map();

function createToast(msg,type='info',opts={}){
  const container=ensureToastRoot();
  const { autoClose=(type==='loading'?false:2600), id='t_'+(++toastIdCounter) } = opts;
  while(document.getElementById(id)) document.getElementById(id).remove();
  const iconMap={
    success:'<i class="icon fa-solid fa-circle-check" style="color:var(--toast-success)"></i>',
    error:'<i class="icon fa-solid fa-circle-xmark" style="color:var(--toast-error)"></i>',
    loading:'<i class="icon fa-solid fa-spinner fa-spin" style="color:var(--toast-loading)"></i>',
    info:'<i class="icon fa-solid fa-circle-info" style="color:#3B82F6"></i>'
  };
  const div=document.createElement('div');
  div.className='toast '+type;
  div.id=id;
  div.innerHTML=`${iconMap[type]||iconMap.info}<div class="msg">${msg}</div><span class="close-btn" data-close="1">&times;</span>`;
  container.appendChild(div);
  if (autoClose) setTimeout(()=>closeToast(id), autoClose);
  return id;
}
function closeToast(id){
  const el=document.getElementById(id);
  if (!el) return;
  el.style.animation='toast-out .25s forwards';
  setTimeout(()=>el.remove(),240);
}
document.addEventListener('click', e=>{
  if (e.target.closest && e.target.closest('[data-close]')){
    const t = e.target.closest('.toast'); if (t) closeToast(t.id);
  }
});

function showLoading(key,text='加载中...'){
  if (activeLoadingKeys.has(key)){
    const existing = document.getElementById('loading_'+key);
    const msgEl = existing?.querySelector('.msg');
    if (msgEl) msgEl.textContent = text;
    return;
  }
  activeLoadingKeys.add(key);
  createToast(text,'loading',{ id:'loading_'+key });
  const to=setTimeout(()=>{ if(activeLoadingKeys.has(key)) hideLoading(key); },12000);
  loadingTimeoutMap.set(key,to);
}
function hideLoading(key){
  activeLoadingKeys.delete(key);
  const id='loading_'+key;
  while(document.getElementById(id)) document.getElementById(id).remove();
  const t=loadingTimeoutMap.get(key);
  if (t){ clearTimeout(t); loadingTimeoutMap.delete(key); }
}
function autoCloseOpLoading(){
  hideLoading('op');
  document.querySelectorAll('.toast.loading').forEach(t=>{
    const text=t.querySelector('.msg')?.textContent?.trim()||'';
    if (/^(添加中|移除中)/.test(text)) t.remove();
  });
}

const showSuccess=m=>createToast(m,'success');
const showError  =m=>createToast(m,'error');
const showInfo   =m=>createToast(m,'info',{autoClose:1800});

let lastGlobalAction=0;
function globalThrottle(){
  const cd = Number(window.APP_CONFIG.clickCooldownMs||2000);
  const now=Date.now();
  if (now - lastGlobalAction < cd){
    showInfo('操作过于频繁，请稍后');
    return false;
  }
  lastGlobalAction=now;
  return true;
}
const NO_THROTTLE_ACTIONS = new Set(['add','remove','restore','xaxis']);
const needThrottle = action => !NO_THROTTLE_ACTIONS.has(action);

const ESC_MAP={ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' };
function escapeHtml(s){ return String(s??'').replace(/[&<>"']/g,c=>ESC_MAP[c]); }
function unescapeHtml(s){
  const map={'&amp;':'&','&lt;':'<','&gt;':'>' ,'&quot;':'"','&#39;':'\''};
  return String(s??'').replace(/&(amp|lt|gt|quot|#39);/g,m=>map[m]);
}

function formatScenario(rt, rl){
  const rtype = escapeHtml(rt||'');
  const raw = rl ?? '';
  const blank = (String(raw).trim()==='' || String(raw).trim()==='无');
  return blank ? rtype : `${rtype}(${escapeHtml(raw)})`;
}

/* ---------------- 工具导出 ---------------- */
window.__APP.util = {
  showSuccess, showError, showInfo,
  showLoading, hideLoading, autoCloseOpLoading,
  globalThrottle, needThrottle,
  escapeHtml, unescapeHtml, formatScenario,
  createToast
};

// === Event Bus (P4-M1) ===
if (!window.__APP.bus) {
  window.__APP.bus = {
    _map: Object.create(null),
    on(evt, fn){ (this._map[evt]||(this._map[evt]=[])).push(fn); return () => this.off(evt, fn); },
    off(evt, fn){ const arr=this._map[evt]; if(!arr) return; const i=arr.indexOf(fn); if(i>=0) arr.splice(i,1); },
    emit(evt, payload){ (this._map[evt]||[]).slice().forEach(f=>{ try{ f(payload); }catch(e){ console.error('[bus]',evt,e);} }); }
  };
  console.info('[core] event bus initialized');
}