window.APP_CONFIG = window.APP_CONFIG || { clickCooldownMs: 2000, maxItems: 0 };
window.__APP = window.__APP || {};

if (typeof LocalState === 'undefined') {
  console.error('LocalState 模块未加载，请确认 local_state.js 已在 fancool.js 之前引入');
}

/* ================= 图表刷新（本地状态 -> 图表） ================= */
function refreshChartFromLocal(){
  const selected = LocalState.getSelected();
  const cache = LocalState.getCurveCache();
  const cfg = LocalState.getConfig ? LocalState.getConfig() : { x_axis:'rpm' };
  const series = [];
  selected.forEach(it=>{
    const k = LocalState.keyOf(it.model_id, it.condition_id);
    const cur = cache[k];
    if (!cur) return;
    series.push({
      key: k,
      brand: it.brand,
      model: it.model,
      res_type: it.res_type,
      res_loc: it.res_loc,
      model_id: it.model_id,
      condition_id: it.condition_id,
      rpm: cur.rpm || [],
      noise_db: cur.noise_db || [],
      airflow: cur.airflow || []
    });
  });
  if (typeof postChartData === 'function'){
    postChartData({ x_axis_type: cfg.x_axis || 'rpm', series });
  }
}

/* ================ 侧栏 UI 重建（已选列表） ================= */
function rebuildSelectedSidebar(){
  const wrap = document.getElementById('selectedFansList');
  const cntEl = document.getElementById('selectedCount');
  if (!wrap) return;
  const list = LocalState.getSelected();
  wrap.innerHTML = '';
  list.forEach(item=>{
    const k = LocalState.keyOf(item.model_id, item.condition_id);
    const div = document.createElement('div');
    div.className='fan-item flex items-center justify-between p-3 border border-gray-200 rounded-md';
    div.dataset.fanKey = k;
    div.dataset.map = `${item.brand}||${item.model}||${item.res_type}||${(item.res_loc || '无')}`;
    div.innerHTML = `
      <div class="truncate">
        <span class="font-medium">${escapeHtml(item.brand)} ${escapeHtml(item.model)}</span>
        <span class="text-gray-600 text-sm"> - ${escapeHtml(item.res_type)}${item.res_loc ? '('+escapeHtml(item.res_loc)+')':''}</span>
      </div>
      <button class="remove-icon text-lg js-remove-fan"
              data-model-id="${item.model_id}"
              data-condition-id="${item.condition_id}"
              title="移除">
        <i class="fa-solid fa-xmark"></i>
      </button>
    `;
    wrap.appendChild(div);
  });
  if (cntEl) cntEl.textContent = String(list.length);
  rebuildSelectedIndex();
  refreshChartFromLocal();
  scheduleAdjust();
}

/* ================== 事件：LocalState 订阅 ================== */
LocalState.on('selected', () => {
  rebuildSelectedSidebar();
});
LocalState.on('curves', () => {
  refreshChartFromLocal();
});

/* ================== DOM 缓存工具 ================== */
(function initDomCache(){
  const cache = Object.create(null);
  function one(sel, scope){
    if (!sel) return null;
    if (!scope && cache[sel]) return cache[sel];
    const el = (scope||document).querySelector(sel);
    if (!scope) cache[sel] = el;
    return el;
  }
  function all(sel, scope){
    return Array.from((scope||document).querySelectorAll(sel));
  }
  function clear(sel){ if(sel) delete cache[sel]; else Object.keys(cache).forEach(k=>delete cache[k]); }
  window.__APP.dom = { one, all, clear };
})();
const $ = (s)=>window.__APP.dom.one(s);

/* ================== 帧写调度器 ================== */
window.__APP.scheduler = (function(){
  const writeQueue=[]; let scheduled=false;
  function flush(){
    scheduled=false;
    for (let i=0;i<writeQueue.length;i++){
      try{ writeQueue[i](); }catch(e){ console.error('[scheduler write error]',e); }
    }
    writeQueue.length=0;
  }
  function write(fn){
    writeQueue.push(fn);
    if(!scheduled){ scheduled=true; requestAnimationFrame(flush); }
  }
  return { write };
})();

/* ================== 内存+TTL 缓存 ================== */
window.__APP.cache = (function(){
  const store=new Map(); const DEFAULT_TTL=180000;
  function key(ns,payload){ return ns+'::'+JSON.stringify(payload||{}); }
  function get(ns,payload){
    const k=key(ns,payload); const rec=store.get(k);
    if(!rec) return null;
    if(Date.now()>rec.expire){ store.delete(k); return null; }
    return rec.value;
  }
  function set(ns,payload,value,ttl=DEFAULT_TTL){
    const k=key(ns,payload); store.set(k,{value,expire:Date.now()+ttl}); return value;
  }
  function clear(ns){
    if(!ns){ store.clear(); return; }
    for(const k of store.keys()){
      if(k.startsWith(ns+'::')) store.delete(k);
    }
  }
  return { get,set,clear };
})();

/* ================== Polyfill & safeClosest ================== */
(function(){
  if(typeof Element!=='undefined'){
    if(!Element.prototype.matches){
      Element.prototype.matches =
        Element.prototype.msMatchesSelector ||
        Element.prototype.webkitMatchesSelector ||
        function(selector){
          const list=(this.document||this.ownerDocument).querySelectorAll(selector);
          let i=0; while(list[i] && list[i]!==this) i++; return !!list[i];
        };
    }
    if(!Element.prototype.closest){
      Element.prototype.closest=function(selector){
        let el=this;
        while(el && el.nodeType===1){
          if(el.matches(selector)) return el;
          el=el.parentElement;
        }
        return null;
      };
    }
  }
  window.safeClosest=function(start,selector){
    if(!start) return null;
    let el=start;
    if(el.nodeType && el.nodeType!==1) el=el.parentElement;
    if(!el) return null;
    if(el.closest){
      try { return el.closest(selector); } catch(_) {}
    }
    while(el && el.nodeType===1){
      if(el.matches && el.matches(selector)) return el;
      el=el.parentElement;
    }
    return null;
  };
})();

/* ================== Toast / Loading / 节流 ================== */
const toastContainerId='toastContainer';
function ensureToastRoot(){
  let r=document.getElementById(toastContainerId);
  if(!r){ r=document.createElement('div'); r.id=toastContainerId; document.body.appendChild(r); }
  return r;
}
let toastIdCounter=0;
const activeLoadingKeys=new Set();
function createToast(msg,type='info',opts={}){
  const container=ensureToastRoot();
  const { autoClose=(type==='loading'?false:2600), id='t_'+(++toastIdCounter) }=opts;
  while(document.getElementById(id)){ document.getElementById(id).remove(); }
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
  if(autoClose){ setTimeout(()=>closeToast(id), autoClose); }
  return id;
}
function closeToast(id){
  const el=document.getElementById(id); if(!el) return;
  el.style.animation='toast-out .25s forwards';
  setTimeout(()=>el.remove(),240);
}
document.addEventListener('click',e=>{
  if(e.target.closest && e.target.closest('[data-close]')){
    const t=e.target.closest('.toast'); if(t) closeToast(t.id);
  }
});
const loadingTimeoutMap=new Map();
function showLoading(key,text='加载中...'){
  if(activeLoadingKeys.has(key)){
    const existing=document.getElementById('loading_'+key);
    if(existing){
      const msgEl=existing.querySelector('.msg');
      if(msgEl) msgEl.textContent=text;
    }
    return;
  }
  activeLoadingKeys.add(key);
  createToast(text,'loading',{id:'loading_'+key});
  const to=setTimeout(()=>{
    if(activeLoadingKeys.has(key)) hideLoading(key);
  },12000);
  loadingTimeoutMap.set(key,to);
}
function hideLoading(key){
  activeLoadingKeys.delete(key);
  const id='loading_'+key;
  while(document.getElementById(id)){ document.getElementById(id).remove(); }
  const t=loadingTimeoutMap.get(key);
  if(t){ clearTimeout(t); loadingTimeoutMap.delete(key); }
}
const showSuccess=m=>createToast(m,'success');
const showError=m=>createToast(m,'error');
const showInfo=m=>createToast(m,'info',{autoClose:1800});
let lastGlobalAction=0;
function globalThrottle(){
  const cd=Number(window.APP_CONFIG.clickCooldownMs||2000);
  const now=Date.now();
  if(now-lastGlobalAction<cd){ showInfo('操作过于频繁，请稍后'); return false; }
  lastGlobalAction=now; return true;
}
const NO_THROTTLE_ACTIONS=new Set(['add','remove','xaxis']);
const needThrottle=(action)=>!NO_THROTTLE_ACTIONS.has(action);
const ESC_MAP={ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' };
function escapeHtml(s){ return String(s??'').replace(/[&<>"']/g,c=>ESC_MAP[c]); }
function unescapeHtml(s){
  const map={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'"}; 
  return String(s??'').replace(/&(amp|lt|gt|quot|#39);/g,m=>map[m]);
}

/* ================== 颜色映射 ================== */
function loadColorIndexMap(){
  try { return JSON.parse(localStorage.getItem('colorIndexMap_v1')||'{}'); } catch { return {}; }
}
function saveColorIndexMap(o){
  try { localStorage.setItem('colorIndexMap_v1', JSON.stringify(o)); } catch(_){}
}
let colorIndexMap=loadColorIndexMap();
function ensureColorIndexForKey(key, selectedKeys){
  if(!key) return 0;
  if(Object.prototype.hasOwnProperty.call(colorIndexMap,key)) return colorIndexMap[key]|0;
  const used=new Set();
  (selectedKeys||[]).forEach(k=>{
    if(Object.prototype.hasOwnProperty.call(colorIndexMap,k)) used.add(colorIndexMap[k]|0);
  });
  let idx=0; while(used.has(idx)) idx++;
  colorIndexMap[key]=idx; saveColorIndexMap(colorIndexMap);
  return idx;
}
function colorForKey(key){
  const idx = Object.prototype.hasOwnProperty.call(colorIndexMap,key)?(colorIndexMap[key]|0):0;
  const palette=currentPalette();
  return palette[idx % palette.length];
}
function withFrontColors(chartData){
  const series=(chartData.series||[]).map(s=>{
    const idx=colorIndexMap[s.key] ?? ensureColorIndexForKey(s.key);
    return { ...s, color: colorForKey(s.key), color_index: idx };
  });
  return { ...chartData, series };
}

/* ================== 主题 & 调色板 ================== */
const DARK_BASE_PALETTE = ["#3E9BFF","#FFF958","#42E049","#FF4848","#DB68FF","#2CD1E8","#F59916","#FF67A6","#8b5cf6","#14E39E"];
const currentThemeStr=()=> (document.documentElement.getAttribute('data-theme')==='dark'?'dark':'light');
const LIGHT_LINEAR_SCALE=0.66;
function srgbToLinear(c){ return c<=0.04045?c/12.92:Math.pow((c+0.055)/1.055,2.4); }
function linearToSrgb(c){ return c<=0.0031308?12.92*c:1.055*Math.pow(c,1/2.4)-0.055; }
function darkToLightLinear(hex){
  const h=hex.replace('#','');
  let r=parseInt(h.slice(0,2),16)/255;
  let g=parseInt(h.slice(2,4),16)/255;
  let b=parseInt(h.slice(4,6),16)/255;
  r=srgbToLinear(r); g=srgbToLinear(g); b=srgbToLinear(b);
  r*=LIGHT_LINEAR_SCALE; g*=LIGHT_LINEAR_SCALE; b*=LIGHT_LINEAR_SCALE;
  r=Math.round(linearToSrgb(r)*255); g=Math.round(linearToSrgb(g)*255); b=Math.round(linearToSrgb(b)*255);
  const to=v=>v.toString(16).padStart(2,'0'); return '#'+to(r)+to(g)+to(b);
}
function currentPalette(){
  return currentThemeStr()==='dark'?DARK_BASE_PALETTE: DARK_BASE_PALETTE.map(darkToLightLinear);
}

const chartFrame=$('#chartFrame');
let lastChartData=null;
let chartFrameReady=false;
const chartMessageQueue=[];
function flushChartQueue(){
  if(!chartFrameReady || !chartFrame || !chartFrame.contentWindow) return;
  while(chartMessageQueue.length){
    const msg=chartMessageQueue.shift();
    try{ chartFrame.contentWindow.postMessage(msg, window.location.origin); }catch(e){ console.warn(e); break; }
  }
  setTimeout(()=>resizeChart(),50);
}
if(chartFrame){
  chartFrame.addEventListener('load',()=>{
    if(!chartFrameReady){
      chartFrameReady=true;
      flushChartQueue();
      if(lastChartData && !chartMessageQueue.length){
        postChartData(lastChartData);
      }
    }
  });
}
function getChartBg(){
  const host=document.getElementById('chart-settings')||document.body;
  let bg=''; try { bg=getComputedStyle(host).backgroundColor; } catch(_){}
  if(!bg || bg==='rgba(0, 0, 0, 0)' || bg==='transparent'){
    try{ bg=getComputedStyle(document.body).backgroundColor; }catch(_){}
  }
  return bg && bg!=='rgba(0, 0, 0, 0)' ? bg : '#ffffff';
}
function postChartData(chartData){
  lastChartData=chartData;
  if(!chartFrame || !chartFrame.contentWindow) return;
  const colored=withFrontColors(chartData);
  const payload={
    chartData: colored,
    theme: currentThemeStr(),
    chartBg: getChartBg()
  };
  const msg={ type:'chart:update', payload };
  if(!chartFrameReady) chartMessageQueue.push(msg);
  else chartFrame.contentWindow.postMessage(msg, window.location.origin);
}
function resizeChart(){
  if(!chartFrame || !chartFrame.contentWindow) return;
  chartFrame.contentWindow.postMessage({type:'chart:resize'}, window.location.origin);
}

/* ================== 点赞（保持后端持久化） ================== */
let likedKeysSet=new Set();
function updateLikeIcons(modelId, conditionId, isLiked){
  window.__APP.dom.all(`.like-button[data-model-id="${modelId}"][data-condition-id="${conditionId}"]`)
    .forEach(btn=>{
      const ic=btn.querySelector('i'); if(!ic) return;
      ic.classList.toggle('text-red-500',isLiked);
      ic.classList.toggle('text-gray-400',!isLiked);
    });
}
document.addEventListener('click', e=>{
  const likeBtn = safeClosest(e.target,'.like-button');
  if(!likeBtn) return;
  if(needThrottle('like') && !globalThrottle()) return;
  const mid=likeBtn.dataset.modelId;
  const cid=likeBtn.dataset.conditionId;
  if(!mid || !cid){ showError('缺少点赞标识'); return; }
  const icon=likeBtn.querySelector('i');
  const prevLiked=icon.classList.contains('text-red-500');
  const nextLiked=!prevLiked;
  const url=prevLiked?'/api/unlike':'/api/like';
  updateLikeIcons(mid,cid,nextLiked);
  const keyStr=`${mid}_${cid}`;
  if(nextLiked) likedKeysSet.add(keyStr); else likedKeysSet.delete(keyStr);
  fetch(url,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ model_id: mid, condition_id: cid })
  }).then(r=>r.json()).then(d=>{
    if(!d.success){
      updateLikeIcons(mid,cid,prevLiked);
      if(prevLiked) likedKeysSet.add(keyStr); else likedKeysSet.delete(keyStr);
      showError(d.error_message||'点赞失败');
      return;
    }
    if(Array.isArray(d.like_keys)){
      likedKeysSet=new Set(d.like_keys);
      updateLikeIcons(mid,cid, likedKeysSet.has(keyStr));
    }
    showSuccess(prevLiked?'已取消点赞':'已点赞');
  }).catch(err=>{
    updateLikeIcons(mid,cid,prevLiked);
    if(prevLiked) likedKeysSet.add(keyStr); else likedKeysSet.delete(keyStr);
    showError('网络错误: '+err.message);
  });
});

/* ================== 已选索引与快速按钮同步 ================== */
let selectedMapSet=new Set();
function rebuildSelectedIndex(){
  selectedMapSet.clear();
  window.__APP.dom.all('#selectedFansList .fan-item').forEach(div=>{
    const map=div.getAttribute('data-map');
    if(map) selectedMapSet.add(map);
  });
}
function buildQuickBtnHTML(addType, brand, model, resType, resLoc, modelId, conditionId){
  const raw=resLoc??'';
  const normResLoc=(String(raw).trim()==='')?'无':raw;
  const mapKey=`${escapeHtml(brand)}||${escapeHtml(model)}||${escapeHtml(resType)}||${escapeHtml(normResLoc)}`;
  const isDup=selectedMapSet.has(mapKey);
  const title=isDup?'从图表移除':'添加到图表';
  const icon=isDup?'<i class="fa-solid fa-xmark"></i>':'<i class="fa-solid fa-plus"></i>';
  return `
    <button class="btn-add tooltip-btn js-add-pair"
            title="${title}"
            data-add-type="${addType}"
            data-brand="${escapeHtml(brand)}"
            data-model="${escapeHtml(model)}"
            data-res-type="${escapeHtml(resType)}"
            data-res-loc="${escapeHtml(normResLoc)}"
            data-model-id="${modelId ?? ''}"
            data-condition-id="${conditionId ?? ''}">
      ${icon}
    </button>`;
}
function syncQuickActionButtons(){
  window.__APP.dom.all('.btn-add.tooltip-btn').forEach(btn=>{
    const d=btn.dataset;
    const norm=(d.resLoc && d.resLoc.trim()!=='')?d.resLoc:'无';
    const key=`${unescapeHtml(d.brand||'')}||${unescapeHtml(d.model||'')}||${unescapeHtml(d.resType||'')}||${unescapeHtml(norm)}`;
    const isDup=selectedMapSet.has(key);
    btn.title=isDup?'从图表移除':'添加到图表';
    btn.innerHTML=isDup?'<i class="fa-solid fa-xmark"></i>':'<i class="fa-solid fa-plus"></i>';
    btn.classList.toggle('js-list-remove', isDup);
  });
}

/* ================== 表单（按型号添加 -> /api/pairs_by_filters） ================== */
const fanForm = $('#fanForm');
const brandSelect = $('#brandSelect');
const modelSelect = $('#modelSelect');
const resTypeSelect = $('#resTypeSelect');
const resLocSelect = $('#resLocSelect');

if (fanForm){
  fanForm.addEventListener('submit', async e=>{
    e.preventDefault();
    const brand=(brandSelect.value||'').trim();
    const model=(modelSelect.value||'').trim();
    const res_type=(resTypeSelect.value||'').trim();
    let res_loc=(resLocSelect.value||'').trim();

    if(!brand || !model){ showError('请先选择品牌与型号'); return; }
    if(!res_type){ showError('请选择风阻类型'); return; }

    if(res_type==='空载') res_loc='无';
    if(!res_loc) res_loc='全部';

    // 重复校验：仅在精确组合时判断
    if(res_type!=='全部' && res_loc!=='全部'){
      const mapKey=`${brand}||${model}||${res_type}||${res_loc}`;
      if(selectedMapSet.has(mapKey)){
        showInfo('该数据已添加');
        return;
      }
    }

    showLoading('op','添加中...');
    try{
      const body={
        brand,
        model,
        res_type,   // 后端会把 '全部' 视为放宽（在 route 里处理）
        res_loc     // '全部' 亦放宽，'无' 表示空位置
      };
      const resp=await fetch('/api/pairs_by_filters',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(body)
      }).then(r=>r.json());
      if(!resp.success){
        hideLoading('op');
        showError(resp.error||resp.error_message||'添加失败');
        return;
      }
      const list=resp.list||[];
      if(!list.length){
        hideLoading('op');
        showInfo('没有匹配的数据组合');
        return;
      }
      // 映射成 LocalState 需要的结构
      const items=list.map(r=>({
        model_id: r.model_id,
        condition_id: r.condition_id,
        brand: r.brand,
        model: r.model,
        res_type: r.res_type,
        res_loc: r.res_loc
      }));
      const before=LocalState.getSelected().length;
      await LocalState.add(items);
      const after=LocalState.getSelected().length;
      const added=after-before;
      hideLoading('op');
      showSuccess(added?`添加成功（新增 ${added} 条）`:'全部已存在');
      rebuildSelectedSidebar();
      refreshChartFromLocal();
    }catch(err){
      hideLoading('op');
      showError('添加异常: '+err.message);
    }
  });
}

/* ================== 级联下拉（品牌->型号->类型->位置） ================== */
if(brandSelect){
  brandSelect.addEventListener('change',()=>{
    const b=(brandSelect.value||'').trim();
    modelSelect.innerHTML=`<option value="">${b?'-- 选择型号 --':'-- 请先选择品牌 --'}</option>`;
    modelSelect.disabled=!b;
    resTypeSelect.innerHTML = `<option value="">${b?'-- 请先选择型号 --':'-- 请先选择品牌 --'}</option>`;
    resTypeSelect.disabled=true;
    resLocSelect.innerHTML = `<option value="">${b?'-- 请先选择型号 --':'-- 请先选择品牌 --'}</option>`;
    resLocSelect.disabled=true;
    if(!b) return;
    fetch(`/get_models/${encodeURIComponent(b)}`).then(r=>r.json()).then(models=>{
      models.forEach(m=>{
        const o=document.createElement('option'); o.value=m; o.textContent=m; modelSelect.appendChild(o);
      });
      modelSelect.disabled=false;
    });
  });
}
if(modelSelect){
  modelSelect.addEventListener('change',()=>{
    const b=(brandSelect.value||'').trim();
    const m=(modelSelect.value||'').trim();
    resTypeSelect.innerHTML = m
      ? '<option value="">-- 选择风阻类型 --</option><option value="全部">全部</option>'
      : '<option value="">-- 请先选择型号 --</option>';
    resTypeSelect.disabled=!m;
    resLocSelect.innerHTML = '<option value="">-- 请先选择风阻类型 --</option>';
    resLocSelect.disabled=true;
    if(!b || !m) return;
    fetch(`/get_resistance_types/${encodeURIComponent(b)}/${encodeURIComponent(m)}`)
      .then(r=>r.json()).then(types=>{
        types.forEach(t=>{
          const o=document.createElement('option'); o.value=t; o.textContent=t; resTypeSelect.appendChild(o);
        });
        resTypeSelect.disabled=false;
      });
  });
}
if(resTypeSelect){
  resTypeSelect.addEventListener('change',()=>{
    const b=(brandSelect.value||'').trim();
    const m=(modelSelect.value||'').trim();
    const rt=(resTypeSelect.value||'').trim();
    if(!rt){
      resLocSelect.innerHTML='<option value="">-- 请先选择风阻类型 --</option>';
      resLocSelect.disabled=true;
      return;
    }
    // 空载
    if(rt==='空载'){
      resLocSelect.innerHTML='<option value="无" selected>无</option>';
      resLocSelect.disabled=true;
      return;
    }
    // 全部
    if(rt==='全部'){
      resLocSelect.innerHTML='<option value="全部" selected>全部</option>';
      resLocSelect.disabled=true;
      return;
    }
    resLocSelect.innerHTML='<option value="">-- 选择风阻位置 --</option><option value="全部">全部</option>';
    resLocSelect.disabled=true;
    if(!b || !m) return;
    fetch(`/get_resistance_locations/${encodeURIComponent(b)}/${encodeURIComponent(m)}/${encodeURIComponent(rt)}`)
      .then(r=>r.json()).then(locs=>{
        locs.forEach(l=>{
          const o=document.createElement('option'); o.value=l; o.textContent=l; resLocSelect.appendChild(o);
        });
        resLocSelect.disabled=false;
      });
  });
}
if(brandSelect){ brandSelect.dispatchEvent(new Event('change')); }

/* ================== 型号关键字输入辅助 ================== */
const modelSearchInput = $('#modelSearchInput');
const searchSuggestions = $('#searchSuggestions');
let modelDebounceTimer;
if(modelSearchInput && searchSuggestions){
  modelSearchInput.addEventListener('input',()=>{
    clearTimeout(modelDebounceTimer);
    const q=modelSearchInput.value.trim();
    if(q.length<2){ searchSuggestions.classList.add('hidden'); return; }
    modelDebounceTimer=setTimeout(()=>{
      fetch(`/search_models/${encodeURIComponent(q)}`).then(r=>r.json()).then(list=>{
        searchSuggestions.innerHTML='';
        if(!list.length){ searchSuggestions.classList.add('hidden'); return; }
        list.forEach(full=>{
          const div=document.createElement('div');
          div.className='cursor-pointer'; div.textContent=full;
          div.addEventListener('click',()=>{
            const parts=full.split(' ');
            const brand=parts[0]; const model=parts.slice(1).join(' ');
            brandSelect.value=brand;
            brandSelect.dispatchEvent(new Event('change'));
            setTimeout(()=>{
              modelSelect.value=model;
              modelSelect.dispatchEvent(new Event('change'));
              modelSearchInput.value='';
              searchSuggestions.classList.add('hidden');
            },300);
          });
          searchSuggestions.appendChild(div);
        });
        searchSuggestions.classList.remove('hidden');
      }).catch(()=>searchSuggestions.classList.add('hidden'));
    },280);
  });
  document.addEventListener('click',e=>{
    if(!modelSearchInput.contains(e.target) && !searchSuggestions.contains(e.target)){
      searchSuggestions.classList.add('hidden');
    }
  });
}

/* ================== 添加/移除/清空 统一点击事件 ================== */
document.addEventListener('click', async e=>{
  // 添加
  const addBtn = e.target.closest('.js-add-pair');
  if(addBtn){
    if(needThrottle('add') && !globalThrottle()) return;
    const mid=parseInt(addBtn.dataset.modelId);
    const cid=parseInt(addBtn.dataset.conditionId);
    if(!Number.isInteger(mid) || !Number.isInteger(cid)){
      showError('缺少必要 ID');
      return;
    }
    const meta=[{
      model_id: mid,
      condition_id: cid,
      brand: addBtn.dataset.brand,
      model: addBtn.dataset.model,
      res_type: addBtn.dataset.resType,
      res_loc: addBtn.dataset.resLoc === '无' ? '' : addBtn.dataset.resLoc
    }];
    const before=LocalState.getSelected().length;
    await LocalState.add(meta);
    const after=LocalState.getSelected().length;
    if(after>before){
      showSuccess('添加成功');
      rebuildSelectedSidebar();
      refreshChartFromLocal();
    } else {
      showInfo('已存在');
    }
    return;
  }
  // 移除
  const rmBtn=e.target.closest('.js-remove-fan');
  if(rmBtn){
    const mid=parseInt(rmBtn.dataset.modelId);
    const cid=parseInt(rmBtn.dataset.conditionId);
    LocalState.remove(mid,cid);
    rebuildSelectedSidebar();
    showSuccess('已移除');
    return;
  }
  // 清空
  if(e.target.id==='clearAllBtn'){
    if(!LocalState.getSelected().length){
      showInfo('当前无数据');
      return;
    }
    if(!confirm('确认清空所有已选曲线？')) return;
    LocalState.clearAll();
    rebuildSelectedSidebar();
    showSuccess('已清空');
    return;
  }
});

/* ================== 限制数量检查 ================== */
const MAX_ITEMS = Number(window.APP_CONFIG.maxItems || 0);
function ensureCanAdd(countToAdd=1){
  if(!MAX_ITEMS) return true;
  const curr = LocalState.getSelected().length;
  if(curr + countToAdd > MAX_ITEMS){
    showInfo(`已达上限（${MAX_ITEMS}）`);
    return false;
  }
  return true;
}

/* ================== 其余（主题 / 布局 / 无障碍 等保留） ================== */
/* 主题切换 */
const themeToggle=$('#themeToggle');
const themeIcon=$('#themeIcon');
let currentTheme=document.documentElement.getAttribute('data-theme')||'light';
function setTheme(t){
  const prev=document.documentElement.getAttribute('data-theme');
  if(prev===t){
    if(themeIcon) themeIcon.className=t==='dark'?'fa-solid fa-sun':'fa-solid fa-moon';
    return;
  }
  document.documentElement.setAttribute('data-theme',t);
  if(themeIcon) themeIcon.className=t==='dark'?'fa-solid fa-sun':'fa-solid fa-moon';
  localStorage.setItem('theme',t);
  fetch('/api/theme',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({theme:t})}).catch(()=>{});
}
setTheme(currentTheme);
themeToggle?.addEventListener('click',()=>{
  currentTheme=currentTheme==='light'?'dark':'light';
  setTheme(currentTheme);
  if(lastChartData) postChartData(lastChartData); else resizeChart();
});

/* 初次加载：构建侧栏 + 图表（LocalState 会自动补曲线） */
document.addEventListener('DOMContentLoaded',()=>{
  rebuildSelectedSidebar();
  refreshChartFromLocal();
});

/* 调整高度节流 */
let _adjustQueued=false;
function scheduleAdjust(){
  if(_adjustQueued) return;
  _adjustQueued=true;
  requestAnimationFrame(()=>{
    _adjustQueued=false;
    // 可在此根据已选条目调整侧栏高度（若需要）
  });
}

/* 窗口大小变化重新布局图表 */
window.addEventListener('resize',()=>{ resizeChart(); });

/* 统一格式化场景文本 */
function formatScenario(rt, rl){
  const rtype=escapeHtml(rt||'');
  const raw=rl??'';
  const isEmpty=(String(raw).trim()==='' || String(raw).trim()==='无');
  return isEmpty ? rtype : `${rtype}(${escapeHtml(raw)})`;
}

/* ============= 图表 iframe 消息：x 轴变更同步到本地配置 ============= */
window.addEventListener('message', e=>{
  if(e.origin !== window.location.origin) return;
  const { type, payload } = e.data || {};
  if(type === 'chart:xaxis-type-changed'){
    const next = (payload?.x_axis_type === 'noise') ? 'noise_db' : (payload?.x_axis_type || 'rpm');
    try { LocalState.saveCfgPatch && LocalState.saveCfgPatch({ x_axis: next }); } catch(_){}
    if(lastChartData) postChartData(lastChartData);
  }
  if(type === 'chart:fit-config-changed'){
    LocalState.saveCfgPatch && LocalState.saveCfgPatch({
      show_raw: !!payload.show_raw,
      show_fit: !!payload.show_fit
    });
  }
  if(type === 'chart:pointer-moved'){
    if(payload && typeof payload.value === 'number'){
      if(payload.x_axis_type === 'rpm'){
        LocalState.saveCfgPatch && LocalState.saveCfgPatch({ pointer_x_rpm: payload.value });
      } else if(payload.x_axis_type === 'noise_db'){
        LocalState.saveCfgPatch && LocalState.saveCfgPatch({ pointer_x_noise_db: payload.value });
      }
    }
  }
});

/* ============= 全局 Tooltip（保留） ============= */
(function initGlobalTooltip(){
  const MARGIN=8; let tip=null, currAnchor=null, hideTimer=null;
  function ensureTip(){ if(tip) return tip; tip=document.createElement('div'); tip.id='appTooltip'; document.body.appendChild(tip); return tip; }
  function setText(html){ ensureTip().innerHTML=html; }
  function placeAround(anchor, preferred='top'){
    const t=ensureTip(); const rect=anchor.getBoundingClientRect();
    const vw=window.innerWidth, vh=window.innerHeight;
    t.style.visibility='hidden'; t.dataset.show='1'; t.style.left='-9999px'; t.style.top='-9999px';
    const tw=t.offsetWidth, th=t.offsetHeight;
    let placement=preferred;
    const topSpace=rect.top, bottomSpace=vh-rect.bottom;
    if(preferred==='top' && topSpace < th+12) placement='bottom';
    if(preferred==='bottom' && bottomSpace < th+12) placement='top';
    let cx = rect.left + rect.width/2;
    cx = Math.max(MARGIN+tw/2, Math.min(vw-MARGIN-tw/2, cx));
    const top = placement==='top' ? rect.top - th - 10 : rect.bottom + 10;
    t.dataset.placement=placement;
    t.style.left = `${Math.round(cx)}px`;
    t.style.top  = `${Math.round(top)}px`;
    t.style.visibility='';
  }
  function show(anchor){
    clearTimeout(hideTimer);
    currAnchor=anchor;
    const txt=anchor.getAttribute('data-tooltip') || anchor.getAttribute('title') || '';
    if(anchor.hasAttribute('title')){ anchor.setAttribute('data-title',anchor.getAttribute('title')); anchor.removeAttribute('title'); }
    setText(txt);
    placeAround(anchor, anchor.getAttribute('data-tooltip-placement') || 'top');
    ensureTip().dataset.show='1';
  }
  function hide(){
    const t=ensureTip(); hideTimer=setTimeout(()=>{ t.dataset.show='0'; currAnchor=null; },60);
  }
  document.addEventListener('mouseenter', e=>{
    let el=e.target; if(el && el.nodeType!==1) el=el.parentElement;
    let anchor= null;
    if(el && typeof el.closest==='function'){ try{ anchor=el.closest('[data-tooltip]'); }catch(_){ } }
    if(!anchor) anchor=safeClosest(el,'[data-tooltip]');
    if(anchor) show(anchor);
  }, true);
  document.addEventListener('mouseleave', e=>{
    let el=e.target; if(el && el.nodeType!==1) el=el.parentElement;
    let anchor=null;
    if(el && typeof el.closest==='function'){ try{ anchor=el.closest('[data-tooltip]'); }catch(_){ } }
    if(!anchor) anchor=safeClosest(el,'[data-tooltip]');
    if(anchor) hide();
  }, true);
  document.addEventListener('focusin', e=>{
    const el=safeClosest(e.target,'[data-tooltip]'); if(el) show(el);
  });
  document.addEventListener('focusout', e=>{
    const el=safeClosest(e.target,'[data-tooltip]'); if(el) hide();
  });
  const reflow=()=>{ if(currAnchor && document.body.contains(currAnchor)) placeAround(currAnchor, currAnchor.getAttribute('data-tooltip-placement')||'top'); };
  window.addEventListener('resize', reflow);
  window.addEventListener('scroll', reflow, true);
})();

/* ================== 结束 ================== */