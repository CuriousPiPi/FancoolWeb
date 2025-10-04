/* local-state.js
 * 统一维护前端本地状态（选中条目 / 最近移除 / 颜色索引 / X轴模式 / UI偏好等）
 * 所有后端不再记录的“会话性状态”都迁移到这里。
 */
(function(global){
  const LS_KEYS = {
    SELECTED: 'fc_selected_v1',            // Array<SelectedItem>
    REMOVED: 'fc_removed_v1',              // Array<RemovedItem>
    COLOR_MAP: 'colorIndexMap_v1',         // { key -> colorIndex }
    X_AXIS: 'x_axis_type',                 // 'rpm' | 'noise_db'
    PREFS: 'fc_prefs_v1'                   // 预留综合偏好 (legendHidden, pointers, etc.)
  };
  
  const MAX_RECENTLY_REMOVED = 50;
  const DEFAULT_X_AXIS = 'rpm';

  function readJSON(k,f){ try{ const r=localStorage.getItem(k); return r?JSON.parse(r):f; }catch{return f;} }
  function writeJSON(k,v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch{} }

  // 内部缓存（加载后常驻内存）
  let selected = readJSON(LS_KEYS.SELECTED, []);
  let removed  = readJSON(LS_KEYS.REMOVED, []);
  let colorMap = readJSON(LS_KEYS.COLOR_MAP, {});
  let prefs    = readJSON(LS_KEYS.PREFS, { legend_hidden_keys:[], pointer:{rpm:null, noise_db:null}});
  let xAxisType= (()=>{
    const v=(localStorage.getItem(LS_KEYS.X_AXIS)||'').trim();
    return (v==='rpm'||v==='noise_db'||v==='noise')?(v==='noise'?'noise_db':v):DEFAULT_X_AXIS;
  })();

  // ---- 颜色索引分配 ----
  function ensureColorIndex(key){
    if (!key) return 0;
    if (Object.prototype.hasOwnProperty.call(colorMap,key)) return colorMap[key]|0;
    const used = new Set(Object.values(colorMap).map(v=>v|0));
    let idx=0; while(used.has(idx)) idx++;
    colorMap[key]=idx;
    persistAll();
    return idx;
  }
  function releaseColorIndex(key){
    if (!key) return;
    if (Object.prototype.hasOwnProperty.call(colorMap,key)){
      delete colorMap[key];
      persistColorMap();
    }
  }
  function reassignUniqueIndices(){
    // 确保唯一，占位稳定：仅在缺失或冲突时重排
    const counts = new Map();
    selected.forEach(it=>{
      const idx = colorMap[it.key];
      if (Number.isInteger(idx)){
        counts.set(idx,(counts.get(idx)||0)+1);
      }
    });
    const assigned = new Set();
    selected.forEach(it=>{
      const idx = colorMap[it.key];
      if (Number.isInteger(idx) && counts.get(idx)===1){
        assigned.add(idx);
      }
    });
    selected.forEach(it=>{
      const idx = colorMap[it.key];
      if (!Number.isInteger(idx) || counts.get(idx)>1){
        let cur=0; while(assigned.has(cur)) cur++;
        colorMap[it.key]=cur;
        assigned.add(cur);
      }
    });
    persistColorMap();
  }

  // ---- 工具 ----
  function makeKey(m,c){ return `${Number(m)}_${Number(c)}`; }
  function persistAll(){
    writeJSON(LS_KEYS.SELECTED, selected);
    writeJSON(LS_KEYS.REMOVED, removed);
    writeJSON(LS_KEYS.COLOR_MAP, colorMap);
    writeJSON(LS_KEYS.PREFS, prefs);
    try{ localStorage.setItem(LS_KEYS.X_AXIS, xAxisType);}catch{}
  }
  function persistColorMap(){
    writeJSON(LS_KEYS.COLOR_MAP, colorMap);
  }
  function persistPrefs(){
    writeJSON(LS_KEYS.PREFS, prefs);
  }
  function dispatchChange(reason, extra){
    window.dispatchEvent(new CustomEvent('localstate:changed',{
      detail:Object.assign({reason, selectedCount:selected.length}, extra||{})
    }));
  }
  function findSelectedIndex(key){ return selected.findIndex(it=>it.key===key); }

  // ---- 最近移除去重逻辑 ----
  function addOrUpdateRemoved(info){
    /**
     * info: { key, model_id, condition_id, brand, model, res_type, res_loc }
     * 若 key 已存在：更新 removed_time 到当前并移到最前；不存在则作为新条目加到最前。
     * 最终 removed 按 removed_time DESC（我们直接通过操作数组保证）。
     */
    if (!info || !info.key) return;
    const now = new Date().toISOString();
    const idx = removed.findIndex(r=>r.key===info.key);
    if (idx >= 0){
      // 更新时间并移到最前
      const rec = removed[idx];
      rec.removed_time = now;
      // 删除原位置
      removed.splice(idx,1);
      // 插到最前
      removed.unshift(rec);
    } else {
      removed.unshift({
        key: info.key,
        model_id: info.model_id,
        condition_id: info.condition_id,
        brand: info.brand,
        model: info.model,
        res_type: info.res_type,
        res_loc: info.res_loc,
        removed_time: now
      });
    }
    if (removed.length > MAX_RECENTLY_REMOVED){
      removed.length = MAX_RECENTLY_REMOVED;
    }
  }

  // ---- 核心 API ----
  function getSelected(){ return selected.slice(); }
  function getRecentlyRemoved(){
    // removed 已按时间倒序维护；返回拷贝
    return removed.slice();
  }
  function getXAxisType(){ return xAxisType; }
  function setXAxisType(t){
    const norm = (t==='noise')?'noise_db':t;
    if (norm!=='rpm' && norm!=='noise_db') return;
    if (xAxisType === norm) return;
    xAxisType = norm;
    try { localStorage.setItem(LS_KEYS.X_AXIS, xAxisType); } catch(_){}
    dispatchChange('x_axis_changed',{ xAxisType });
  }

  function addPairs(pairs){
    if (!Array.isArray(pairs)) return { added:0, skipped:0, addedDetails:[] };
    let added=0, skipped=0;
    const addedDetails=[];
    pairs.forEach(p=>{
      const mid=Number(p.model_id), cid=Number(p.condition_id);
      if (!Number.isFinite(mid)||!Number.isFinite(cid)){ skipped++; return; }
      const key=makeKey(mid,cid);
      if (findSelectedIndex(key)>=0){ skipped++; return; }
      const item={
        key,
        model_id: mid,
        condition_id: cid,
        brand: p.brand || p.brand_name_zh || '',
        model: p.model || p.model_name || '',
        res_type: p.res_type || p.resistance_type_zh || '',
        res_loc: (p.res_loc===''||p.res_loc==null)?(p.resistance_location_zh||''):p.res_loc
      };
      selected.push(item);
      ensureColorIndex(key);
      added++;
      addedDetails.push({ key, model_id: mid, condition_id: cid });
    });
    persistAll();
    if (added>0) dispatchChange('add',{ added });
    return { added, skipped, addedDetails };
  }

  function removeKey(key){
    const idx=findSelectedIndex(key);
    if (idx<0) return false;
    const info=selected[idx];
    selected.splice(idx,1);
    addOrUpdateRemoved(info); // 使用去重逻辑
    persistAll();
    dispatchChange('remove',{ key });
    return true;
  }

  function restoreKey(key){
    const rIdx=removed.findIndex(r=>r.key===key);
    if (rIdx<0) return { ok:false, reason:'not_in_removed' };
    if (findSelectedIndex(key)>=0){
      removed.splice(rIdx,1);
      persistAll();
      dispatchChange('restore_skip',{ key });
      return { ok:false, reason:'already_selected' };
    }
    const rec=removed[rIdx];
    // 去掉（彻底移出 removed）
    removed.splice(rIdx,1);
    selected.push({
      key: rec.key,
      model_id: rec.model_id,
      condition_id: rec.condition_id,
      brand: rec.brand,
      model: rec.model,
      res_type: rec.res_type,
      res_loc: rec.res_loc
    });
    ensureColorIndex(key);
    persistAll();
    dispatchChange('restore',{ key });
    return { ok:true, item:{ key: rec.key, model_id: rec.model_id, condition_id: rec.condition_id } };
  }

  function clearAll(){
    const snapshot = selected.slice();
    // 逐个放入 removed（去重+最新时间）
    snapshot.forEach(it=> addOrUpdateRemoved(it));
    selected=[];
    persistAll();
    dispatchChange('clear_all',{});
  }

  function purgeRemovedKey(key){
    const idx = removed.findIndex(r=>r.key===key);
    if (idx>=0){
      removed.splice(idx,1);
      persistAll();
      dispatchChange('purge_removed',{ key });
    }
  }

  function getColorIndexMap(){
    return Object.assign({}, colorMap);
  }

  function getSelectionPairs(){
    return selected.map(s=>({ model_id: s.model_id, condition_id: s.condition_id }));
  }

  function setLegendHiddenKeys(keys){
    prefs.legend_hidden_keys = Array.isArray(keys)?keys.slice():[];
    persistPrefs();
    dispatchChange('legend_hidden',{});
  }
  function getLegendHiddenKeys(){
    return (prefs.legend_hidden_keys||[]).slice();
  }

  function setPointer(mode, value){
    if (!prefs.pointer) prefs.pointer = { rpm:null, noise_db:null };
    if (mode!=='rpm' && mode!=='noise_db') return;
    prefs.pointer[mode] = Number.isFinite(value)?value:null;
    persistPrefs();
    dispatchChange('pointer_changed',{ mode, value:prefs.pointer[mode] });
  }
  function getPointer(mode){
    if (!prefs.pointer) return null;
    return prefs.pointer[mode];
  }

  // 统一导出
  const api={
    getSelected: ()=>selected.slice(),
    getRecentlyRemoved: ()=> removed.slice(),  // 已经按时间排序
    addPairs,
    removeKey,
    restoreKey,
    clearAll,
    purgeRemovedKey:(key)=>purgeRemovedKey(key),
    getColorIndexMap: ()=> ({...colorMap}),
    ensureColorIndex,
    getXAxisType: ()=>xAxisType,
    setXAxisType:(t)=>setXAxisType(t),
    setLegendHiddenKeys:(keys)=>setLegendHiddenKeys(keys),
    getLegendHiddenKeys:()=>getLegendHiddenKeys(),
    setPointer:(mode,v)=>setPointer(mode,v),
    getPointer:(mode)=>getPointer(mode),
    getSelectionPairs:()=> getSelectionPairs(),
    persistAll
  };

  global.LocalState = api;
  dispatchChange('init',{ selectedCount: selected.length, xAxisType });

})(window);