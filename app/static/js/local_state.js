/* =========================================================
   Local State 管理模块（独立）
   =========================================================
   目标：
     1. 统一存储选中曲线及其元信息（不含曲线点数据）
     2. 颜色 / 隐藏 / 图表配置分离
     3. 提供订阅型回调，便于其它脚本响应
     4. 提供批量加载新曲线点数据的工具函数（无状态接口 /api/curves_by_pairs）
   ========================================================= */

(function (global) {
  const LS_KEYS = {
    selected: 'fc_selected_pairs',
    colors: 'fc_color_map',
    cfg: 'fc_chart_cfg',
    hidden: 'fc_hidden_keys'
  };

  function safeParse(json, fallback){
    try { return JSON.parse(json); } catch { return fallback; }
  }
  function readLS(key, def){
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return def;
      return safeParse(raw, def);
    } catch { return def; }
  }
  function writeLS(key, value){
    try { localStorage.setItem(key, JSON.stringify(value)); } catch(_) {}
  }

  // ============== 内部状态缓存（减少 JSON 解析） ==============
  let _selected = readLS(LS_KEYS.selected, []); // [{model_id, condition_id, brand, model, res_type, res_loc}]
  let _colors   = readLS(LS_KEYS.colors, {});   // { "mid_cid": colorIndex }
  let _cfg      = readLS(LS_KEYS.cfg, {
    x_axis:'rpm',
    show_raw:true,
    show_fit:false,
    pointer_x_rpm:null,
    pointer_x_noise_db:null
  });
  let _hidden   = readLS(LS_KEYS.hidden, []);   // ["mid_cid", ...]

  // 曲线缓存（内存，不写入 localStorage）
  const _curveCache = {}; // key -> { key, model_id, condition_id, rpm, noise_db, airflow, ... }

  // 订阅机制
  const _subscribers = {
    selected: new Set(),
    curves:   new Set(),
    cfg:      new Set(),
    colors:   new Set(),
    hidden:   new Set()
  };
  function notify(type, payload){
    (_subscribers[type] || []).forEach(fn => {
      try { fn(payload); } catch(e){ console.warn('[LocalState] subscriber error', e); }
    });
  }

  // 在原有 _cfg 基础上：若没字段则自动补齐
  function _ensureCfgShape(){
    _cfg = Object.assign({
      x_axis: 'rpm',
      show_raw: true,
      show_fit: false,
      pointer_x_rpm: null,
      pointer_x_noise_db: null
    }, _cfg || {});
  }
  _ensureCfgShape();
  
  function cfgGet(){ _ensureCfgShape(); return { ..._cfg }; }
  function cfgPatch(p){
    _ensureCfgShape();
    _cfg = { ..._cfg, ...p };
    write(LS_KEYS.cfg, _cfg);
    notify('cfg');
  }
  
  // 导出接口（在 LocalState 暴露时补上，如果之前没有）
  if (typeof window.LocalState !== 'undefined') {
    window.LocalState.getConfig = cfgGet;
    window.LocalState.saveCfgPatch = cfgPatch;
  }

  // ============== 工具函数 ==============
  function pairKey(model_id, condition_id){
    return `${model_id}_${condition_id}`;
  }

  // ============== 对外 API：读 ==============
  function getSelected(){ return _selected.slice(); }
  function getCurveCache(){ return { ..._curveCache }; }
  function getConfig(){ return { ..._cfg }; }
  function getColors(){ return { ..._colors }; }
  function getHiddenKeys(){ return _hidden.slice(); }

  // ============== 对外 API：写（保存 + 事件） ==============
  function saveSelected(next){
    _selected = next.slice();
    writeLS(LS_KEYS.selected, _selected);
    notify('selected', getSelected());
  }
  function saveConfig(next){
    _cfg = { ..._cfg, ...next };
    writeLS(LS_KEYS.cfg, _cfg);
    notify('cfg', getConfig());
  }
  function saveCfgPatch(patch){
      if (!patch || typeof patch !== 'object') return;
      _cfg = { ..._cfg, ...patch };   // 与 saveConfig 类似
      writeLS(LS_KEYS.cfg, _cfg);
      notify('cfg', getConfig());
    }
  function saveColors(next){
    _colors = { ...next };
    writeLS(LS_KEYS.colors, _colors);
    notify('colors', getColors());
  }
  function saveHidden(next){
    _hidden = next.slice();
    writeLS(LS_KEYS.hidden, _hidden);
    notify('hidden', getHiddenKeys());
  }

  // ============== 颜色索引分配（与前端 palette 同步） ==============
  function ensureColorIndex(key){
    if (Object.prototype.hasOwnProperty.call(_colors, key)) return _colors[key];
    const used = new Set(Object.values(_colors));
    let idx = 0; while(used.has(idx)) idx++;
    _colors[key] = idx;
    saveColors(_colors);
    return idx;
  }
  function releaseColorIndex(key){
    if (Object.prototype.hasOwnProperty.call(_colors, key)) {
      delete _colors[key];
      saveColors(_colors);
    }
  }

  // ============== 曲线数据加载 ==============
  async function fetchCurvesForPairs(pairs){
    if (!pairs.length) return [];
    const resp = await fetch('/api/curves_by_pairs', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        user_id: (window.CURRENT_USER_ID || ''),
        pairs: pairs.map(p => ({ model_id:p.model_id, condition_id:p.condition_id })) 
        })
    }).then(r=>r.json());
    if (!resp.success) throw new Error(resp.error || '曲线接口失败');
    (resp.series || []).forEach(s => { _curveCache[s.key] = s; });
    notify('curves', getCurveCache());
    return resp.series || [];
  }

  // ============== 批量添加 ==============
  async function addItems(items){
    // items: [{model_id, condition_id, brand, model, res_type, res_loc}]
    if (!Array.isArray(items) || !items.length) return { added: [], skipped: [] };
    const existingKeys = new Set(_selected.map(p => pairKey(p.model_id, p.condition_id)));
    const toAdd = [];
    const newPairs = [];
    items.forEach(it => {
      const key = pairKey(it.model_id, it.condition_id);
      if (!existingKeys.has(key)){
        toAdd.push({ ...it });
        existingKeys.add(key);
        newPairs.push({ model_id: it.model_id, condition_id: it.condition_id });
      }
    });
    if (toAdd.length){
      saveSelected(_selected.concat(toAdd));
      await fetchCurvesForPairs(newPairs);
    }
    return {
      added: toAdd,
      skipped: items.length - toAdd.length
    };
  }

  // ============== 移除 ==============
  function removeItem(model_id, condition_id){
    const key = pairKey(model_id, condition_id);
    const beforeLen = _selected.length;
    const next = _selected.filter(p => pairKey(p.model_id, p.condition_id) !== key);
    if (next.length !== beforeLen){
      saveSelected(next);
      releaseColorIndex(key);
    }
  }

  function clearAll(){
    saveSelected([]);
    saveHidden([]);
    saveColors({});
    // 不清除 _curveCache（下次添加会复用）也可以；这里保留
  }

  // ============== 订阅接口 ==============
  function on(type, handler){
    if (!_subscribers[type]) throw new Error('Unknown subscribe type: '+type);
    _subscribers[type].add(handler);
    return () => _subscribers[type].delete(handler);
  }

  // ============== 暴露 ==============
  const LocalState = {
    pairKey,
    // 读
    getSelected,
    getCurveCache,
    getConfig,
    getColors,
    getHiddenKeys,
    // 写
    saveConfig,
    saveCfgPatch,
    saveHidden,
    ensureColorIndex,
    releaseColorIndex,
    // 行为
    addItems,
    removeItem,
    clearAll,
    fetchCurvesForPairs,
    // 订阅
    on
  };

  // 挂到全局
  global.LocalState = LocalState;

  // 页面初次加载：如果有已保存选中项，自动加载曲线
  document.addEventListener('DOMContentLoaded', () => {
    const sel = getSelected();
    if (sel.length){
      fetchCurvesForPairs(sel.map(s => ({ model_id:s.model_id, condition_id:s.condition_id })))
        .catch(e => console.warn('初始曲线加载失败', e));
    }
  });

})(window);