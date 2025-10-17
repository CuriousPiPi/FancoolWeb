/* =========================================================
   features/recently-removed
   - 负责“最近移除”面板的渲染与“恢复”按钮交互
   - 依赖：LocalState、toast/loading、ensureCanAdd、rebuildSelectedFans、
           ensureLikeStatusBatch、refreshChartFromLocal、formatScenario、
           escapeHtml、safeClosest（若缺少则用原生 closest）
   - 对外：window.__APP.features.recentlyRemoved = { mount, rebuild }
   ========================================================= */
(function initRecentlyRemovedFeature(){
  window.__APP = window.__APP || {};
  window.__APP.features = window.__APP.features || {};

  const getEl = (sel) => (window.__APP?.dom?.one ? window.__APP.dom.one(sel) : document.querySelector(sel));
  const getAll = (sel) => (window.__APP?.dom?.all ? window.__APP.dom.all(sel) : Array.from(document.querySelectorAll(sel)));

  function getRemovedListEl(){ return document.getElementById('recentlyRemovedList'); }

  function selectedKeySetFromState(){
    const set = new Set();
    try {
      const sel = (window.LocalState && window.LocalState.getSelected && window.LocalState.getSelected()) || [];
      sel.forEach(it => { if (it && it.key) set.add(it.key); });
    } catch(_){}
    return set;
  }

  function htmlEscape(s){ return (typeof window.escapeHtml === 'function') ? window.escapeHtml(s) : String(s ?? ''); }
  function fmtScenario(rt, rl){ return (typeof window.formatScenario === 'function') ? window.formatScenario(rt, rl) : htmlEscape(rt || ''); }
  function closestSafe(node, sel){
    if (typeof window.safeClosest === 'function') return window.safeClosest(node, sel);
    return (node && node.closest) ? node.closest(sel) : null;
  }

  function rebuild(list){
    const removedListEl = getRemovedListEl();
    if (!removedListEl) return;

    removedListEl.innerHTML = '';
    if (!Array.isArray(list) || list.length === 0){
      removedListEl.innerHTML = '<p class="text-gray-500 text-center py-6 empty-removed">暂无最近移除的风扇</p>';
      requestAnimationFrame(()=>{ try { if (typeof window.prepareSidebarMarquee === 'function') window.prepareSidebarMarquee(); } catch(_){} });
      return;
    }

    const selectedKeys = selectedKeySetFromState();
    list.forEach(item => {
      if (!item || selectedKeys.has(item.key)) return;
      const div = document.createElement('div');
      div.className = 'fan-item flex items-center justify-between p-3 border border-gray-200 rounded-md';
      div.dataset.fanKey = item.key;
      div.innerHTML = `
        <div class="truncate">
          <span class="font-medium">${htmlEscape(item.brand)} ${htmlEscape(item.model)}</span> - 
          <span class="text-gray-600 text-sm">${fmtScenario(item.res_type, item.res_loc)}</span>
        </div>
        <button class="fc-icon-restore text-lg js-restore-fan" data-fan-key="${htmlEscape(item.key)}" title="恢复至图表">
          <i class="fa-solid fa-rotate-left"></i>
        </button>`;
      removedListEl.appendChild(div);
    });

    // 布局/交互微调
    requestAnimationFrame(()=>{
      try { if (typeof window.syncTopTabsViewportHeight === 'function') window.syncTopTabsViewportHeight(); } catch(_){}
      try { if (typeof window.prepareSidebarMarquee === 'function') window.prepareSidebarMarquee(); } catch(_){}
    });
  }

  async function handleRestore(fanKey){
    if (!fanKey) return;
    try {
      if (typeof window.ensureCanAdd === 'function' && !window.ensureCanAdd(1)) return;

      const removedList = (window.LocalState && window.LocalState.getRecentlyRemoved && window.LocalState.getRecentlyRemoved()) || [];
      const orig = Array.isArray(removedList) ? removedList.find(it => it && it.key === fanKey) : null;

      async function removeFromRecentlyRemovedUI(){
        try { window.LocalState?.removeFromRecentlyRemoved?.(fanKey); } catch(_){}
        rebuild((window.LocalState && window.LocalState.getRecentlyRemoved && window.LocalState.getRecentlyRemoved()) || []);
        if (typeof window.showInfo === 'function') window.showInfo('该数据已不可用，已从“最近移除”列表剔除');
      }

      // 存在性预检查
      if (orig && Number.isInteger(orig.model_id) && Number.isInteger(orig.condition_id)) {
        try {
          const chk = await fetch('/api/curves', {
            method: 'POST',
            headers: { 'Content-Type':'application/json' },
            body: JSON.stringify({ pairs: [{ model_id: orig.model_id, condition_id: orig.condition_id }] })
          });
          const j = await chk.json();
          const n = (typeof window.normalizeApiResponse === 'function') ? window.normalizeApiResponse(j) : { ok:true, data:j };
          if (n.ok) {
            const data = n.data || {};
            const miss = Array.isArray(data.missing) ? data.missing : [];
            const isMissing = miss.some(m => String(m.model_id) === String(orig.model_id) && String(m.condition_id) === String(orig.condition_id));
            if (isMissing) {
              await removeFromRecentlyRemovedUI();
              return;
            }
          }
        } catch(_) {
          // 静默，继续走原恢复流程
        }
      }

      const result = window.LocalState?.restoreKey?.(fanKey);
      if (result && result.ok){
        try { await (window.logNewPairs?.([ result.item ], 'recover') || Promise.resolve()); } catch(_){}
        if (typeof window.showSuccess === 'function') window.showSuccess('已恢复');

        // 选中区刷新
        if (typeof window.rebuildSelectedFans === 'function') window.rebuildSelectedFans(window.LocalState?.getSelected?.());
        // 点赞状态补齐
        if (typeof window.ensureLikeStatusBatch === 'function') window.ensureLikeStatusBatch([{ model_id: result.item.model_id, condition_id: result.item.condition_id }]);
        // 最近移除刷新
        rebuild(window.LocalState?.getRecentlyRemoved?.());
        // 快速按钮/颜色点/曲线刷新
        try { window.syncQuickActionButtons?.(); } catch(_){}
        try { window.applySidebarColors?.(); } catch(_){}
        try { window.refreshChartFromLocal?.(false); } catch(_){}
      } else if (result && result.reason === 'already_selected'){
        if (typeof window.showInfo === 'function') window.showInfo('已在图表中，已从最近移除列表剔除');
        rebuild(window.LocalState?.getRecentlyRemoved?.());
      } else {
        await removeFromRecentlyRemovedUI();
      }
    } catch(e){
      if (typeof window.showError === 'function') window.showError('恢复失败: ' + e.message);
    }
  }

  function onDocClick(e){
    const btn = closestSafe(e.target, '.js-restore-fan');
    if (!btn) return;
    const fanKey = btn.getAttribute('data-fan-key') || '';
    if (!fanKey) {
      if (typeof window.showError === 'function') window.showError('缺少 fan_key');
      return;
    }
    handleRestore(fanKey);
  }

  function mount(){
    // 绑定事件委托
    document.addEventListener('click', onDocClick, true);
  }

  window.__APP.features.recentlyRemoved = { mount, rebuild };
})();