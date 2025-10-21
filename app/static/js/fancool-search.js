(function(window, document){
  'use strict';

  // 依赖的全局工具（存在即用，无则降级）
  const has = {
    toast: typeof window.showLoading === 'function'
        && typeof window.hideLoading === 'function'
        && typeof window.showError === 'function'
        && typeof window.showSuccess === 'function'
        && typeof window.showInfo === 'function',
    normalize: typeof window.normalizeApiResponse === 'function',
    cache: !!(window.__APP && window.__APP.cache),
    escapeHtml: typeof window.escapeHtml === 'function',
    formatScenario: typeof window.formatScenario === 'function'
  };

  const $$ = (sel, scope) => (scope||document).querySelector(sel);
  const $$$ = (sel, scope) => Array.from((scope||document).querySelectorAll(sel));

  function EH(s){
    if (has.escapeHtml) return window.escapeHtml(s);
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function FS(rt, rl){
    if (has.formatScenario) return window.formatScenario(rt, rl);
    const rtype = EH(rt || '');
    const raw = rl ?? '';
    const isEmpty = (String(raw).trim() === '' || String(raw).trim() === '无');
    return isEmpty ? rtype : `${rtype}(${EH(raw)})`;
  }

  // 通用 fetch JSON + normalize
  async function fetchJSON(url, opts){
    const r = await fetch(url, opts);
    const j = await r.json();
    if (has.normalize){
      const n = window.normalizeApiResponse(j);
      return n.ok ? { ok: true, data: n.data } : { ok:false, error: n.error_message || '请求失败' };
    }
    if (j && j.success === true) return { ok:true, data:j.data };
    return { ok:false, error: (j && (j.error_message || j.message)) || '请求失败' };
  }

  // 统一 cache 调用
  const Cache = {
    get(ns, payload){ return has.cache ? window.__APP.cache.get(ns, payload) : null; },
    set(ns, payload, value, ttl){ return has.cache ? window.__APP.cache.set(ns, payload, value, ttl) : value; }
  };

// 仅改动：通用自定义下拉，支持动态占位与禁用时提示
function buildCustomSelectFromNative(nativeSelect, {
  placeholder = '-- 请选择 --',
  filter = (opt) => opt.value !== '',
  renderLabel = (opt) => EH(opt?.text || ''),
  renderOption = (opt) => renderLabel(opt)
} = {}) {
  if (!nativeSelect || nativeSelect._customBuilt) return { refresh:()=>{}, setDisabled:()=>{}, setValue:()=>{}, getValue:()=>nativeSelect?.value };
  nativeSelect._customBuilt = true;
  nativeSelect.style.display = 'none';

  const wrap = document.createElement('div');
  wrap.className = 'fc-custom-select';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'fc-custom-button fc-field border-gray-300';
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = `<span class="truncate fc-custom-label">${EH(placeholder)}</span><i class="fa-solid fa-chevron-down ml-2 text-gray-500"></i>`;
  const panel = document.createElement('div');
  panel.className = 'fc-custom-options hidden';
  wrap.appendChild(btn); wrap.appendChild(panel);
  nativeSelect.parentNode.insertBefore(wrap, nativeSelect.nextSibling);

  // 新增：当前占位符（可动态更新）
  let currentPlaceholder = placeholder;

  (function syncStyle(){
    try{
      const cs = getComputedStyle(nativeSelect);
      const br = cs.borderRadius || '.375rem';
      const fs = cs.fontSize || '14px';
      btn.style.borderRadius = br;
      panel.style.borderRadius = br;
      btn.style.fontSize = fs;
      panel.style.fontSize = fs;
    }catch(_){}
  })();

  function setLabelByValue(v){
    const opt = Array.from(nativeSelect.options).find(o => String(o.value) === String(v));
    const labelEl = btn.querySelector('.fc-custom-label');
    labelEl.innerHTML = opt ? renderLabel(opt) : EH(currentPlaceholder);
  }
  function renderOptions(){
    const html = Array.from(nativeSelect.options)
      .filter(filter)
      .map(o => `<div class="fc-option" data-value="${EH(o.value)}">${renderOption(o)}</div>`)
      .join('');
    panel.innerHTML = html || '<div class="px-3 py-2 text-gray-500">无可选项</div>';
    setLabelByValue(nativeSelect.value);
  }

  // 新增：监听原生 change（外部程序性变更同步按钮文案）
  nativeSelect.addEventListener('change', () => setLabelByValue(nativeSelect.value));

  btn.addEventListener('click', () => {
    const isHidden = panel.classList.contains('hidden');
    if (isHidden) {
      document.querySelectorAll('.fc-custom-options').forEach(p => p.classList.add('hidden'));
      panel.classList.remove('hidden');
      btn.setAttribute('aria-expanded', 'true');
    } else {
      panel.classList.add('hidden');
      btn.setAttribute('aria-expanded', 'false');
    }
  });
  panel.addEventListener('click', (e) => {
    const node = e.target.closest('.fc-option');
    if (!node) return;
    const v = node.dataset.value || '';
    nativeSelect.value = v;
    nativeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    setLabelByValue(v);
    panel.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
  });
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) {
      panel.classList.add('hidden');
      btn.setAttribute('aria-expanded', 'false');
    }
  });

  renderOptions();

  return {
    refresh(){ renderOptions(); },
    // 修改：支持禁用时自定义占位提示
    setDisabled(disabled, opts = {}){
      btn.disabled = !!disabled;
      btn.setAttribute('aria-disabled', disabled ? 'true' : 'false');
      if (opts.placeholder) {
        currentPlaceholder = String(opts.placeholder);
        setLabelByValue(nativeSelect.value);
      }
    },
    // 新增：单独更新占位符
    setPlaceholder(text){
      currentPlaceholder = String(text || placeholder);
      setLabelByValue(nativeSelect.value);
    },
    setValue(v){
      nativeSelect.value = v;
      nativeSelect.dispatchEvent(new Event('change', { bubbles:true }));
      setLabelByValue(v);
    },
    getValue(){ return nativeSelect.value; }
  };
}

  // 自定义下拉（仅工况：带灰色后缀）
  function buildCustomConditionDropdown(sel, items){
    if (!sel || sel._customBuilt) return { setDisabled: ()=>{} };
    sel._customBuilt = true;
    sel.style.display = 'none';

    const wrap = document.createElement('div');
    wrap.className = 'fc-custom-select';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fc-custom-button fc-field border-gray-300';
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = `
      <span class="truncate fc-custom-label">-- 选择测试工况 --</span>
      <i class="fa-solid fa-chevron-down ml-2 text-gray-500"></i>
    `;
    const panel = document.createElement('div');
    panel.className = 'fc-custom-options hidden';

    panel.innerHTML = (items||[]).map(it => {
      const value = String(it.condition_id);
      const name = EH(it.condition_name_zh || '');
      const extra = FS(it.resistance_type_zh, it.resistance_location_zh);
      const extraHtml = extra ? `<span class="fc-cond-extra"> - ${extra}</span>` : '';
      return `<div class="fc-option" data-value="${value}">
                <span class="fc-cond-name">${name}</span>${extraHtml}
              </div>`;
    }).join('') || '<div class="px-3 py-2 text-gray-500">无可选项</div>';

    wrap.appendChild(btn); wrap.appendChild(panel);
    sel.parentNode.insertBefore(wrap, sel.nextSibling);

    (function syncStyle(){
      try{
        const cs = getComputedStyle(sel);
        const br = cs.borderRadius || '.375rem';
        const fs = cs.fontSize || '14px';
        btn.style.borderRadius = br;
        panel.style.borderRadius = br;
        btn.style.fontSize = fs;
        panel.style.fontSize = fs;
      }catch(_){}
    })();

    function setButtonLabelByValue(v){
      const rec = (items||[]).find(x => String(x.condition_id) === String(v));
      const labelBox = btn.querySelector('.fc-custom-label');
      if (!labelBox) return;
      if (!rec) { labelBox.innerHTML = '-- 选择测试工况 --'; return; }
      const name = EH(rec.condition_name_zh || '');
      const extra = FS(rec.resistance_type_zh, rec.resistance_location_zh);
      labelBox.innerHTML = `${name}${extra ? `<span class="fc-cond-extra"> - ${extra}</span>` : ''}`;
    }

    // 新增：响应原生变更
    sel.addEventListener('change', () => setButtonLabelByValue(sel.value));

    btn.addEventListener('click', () => {
      const isHidden = panel.classList.contains('hidden');
      if (isHidden) {
        document.querySelectorAll('.fc-custom-options').forEach(p => p.classList.add('hidden'));
        panel.classList.remove('hidden');
        btn.setAttribute('aria-expanded', 'true');
      } else {
        panel.classList.add('hidden');
        btn.setAttribute('aria-expanded', 'false');
      }
    });
    panel.addEventListener('click', (e) => {
      const node = e.target.closest('.fc-option');
      if (!node) return;
      const v = node.dataset.value || '';
      sel.value = v;
      sel.dispatchEvent(new Event('change', { bubbles:true }));
      setButtonLabelByValue(v);
      panel.classList.add('hidden');
      btn.setAttribute('aria-expanded', 'false');
    });
    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) {
        panel.classList.add('hidden');
        btn.setAttribute('aria-expanded', 'false');
      }
    });

    setButtonLabelByValue(sel.value || '');
    return {
      setDisabled(disabled){ btn.disabled = !!disabled; btn.setAttribute('aria-disabled', disabled ? 'true' : 'false'); }
    };
  }

  // =============== 模块 A：按工况筛选（Search by Condition） ===============
  function initConditionSearch(){
    const form = $$('#searchForm');
    const sel = $$('#conditionFilterSelect');
    if (!form || !sel) return;

    // 工况下拉：加载 + 自定义
    (async function initSelect(){
      sel.disabled = true;
      sel.innerHTML = '<option value="">-- 选择测试工况 --</option>';
      let ui = null;
      try{
        const r = await fetch('/get_conditions?raw=1');
        const list = await r.json();
        const arr = Array.isArray(list) ? list : [];
        // 同步原生 select（兼容）
        arr.forEach(it=>{
          const o = document.createElement('option');
          o.value = String(it.condition_id);
          const extra = FS(it.resistance_type_zh, it.resistance_location_zh);
          const base = it.condition_name_zh || '';
          o.textContent = extra ? `${base} - ${extra}` : base;
          sel.appendChild(o);
        });
        // 自定义下拉（带灰色后缀）
        ui = buildCustomConditionDropdown(sel, arr);
      }catch(_){
      } finally {
        sel.disabled = false;
        ui && ui.setDisabled(false);
      }
    })();

    // 统一当前页签内其它下拉（尺寸、限制条件）
    const sizeSel = form.querySelector('select[name="size_filter"]');
    if (sizeSel) buildCustomSelectFromNative(sizeSel, { placeholder: '尺寸(mm)' });

    const sortSel = form.querySelector('#sortBySelect');
    if (sortSel) buildCustomSelectFromNative(sortSel, { placeholder: '限制条件' });

    // 提交逻辑（沿用现有缓存与渲染）
    form.addEventListener('submit', async (e)=>{
      e.preventDefault();
      const cidStr = sel && sel.value ? String(sel.value).trim() : '';
      if (!cidStr){ has.toast && window.showError('请选择测试工况'); return; }
      if (!/^\d+$/.test(cidStr)){ has.toast && window.showError('工况选项未正确初始化，请刷新页面'); return; }

      const fd = new FormData(form);
      const payload = {}; fd.forEach((v,k)=>payload[k]=v);
      payload.condition_id = Number(cidStr);
      delete payload.condition;
      delete payload.condition_name;

      const cacheNS = 'search';
      const doFetch = async ()=>{
        const resp = await fetch('/api/search_fans', {
          method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)
        });
        const j = await resp.json();
        if (has.normalize){
          const n = window.normalizeApiResponse(j);
          if (!n.ok) return { success:false, error_message: n.error_message };
          const d = n.data || {};
          return { success:true, search_results: d.search_results, condition_label: d.condition_label };
        } else {
          if (!j || j.success !== true) return { success:false, error_message: (j && j.error_message) || '搜索失败' };
          const d = j.data || {};
          return { success:true, search_results: d.search_results, condition_label: d.condition_label };
        }
      };
      const refreshFromServer = async (cached)=>{
        try {
          const fresh = await doFetch();
          if (fresh.success) {
            Cache.set(cacheNS, payload, fresh);
            if (!cached || JSON.stringify(cached.search_results)!==JSON.stringify(fresh.search_results)){
              if (window.__APP?.modules?.search?.render) {
                window.__APP.modules.search.render(fresh.search_results, fresh.condition_label);
              } else if (typeof window.renderSearchResults === 'function') {
                window.renderSearchResults(fresh.search_results, fresh.condition_label);
              }
              has.toast && window.showInfo('已刷新最新结果');
            }
          }
        } catch(_){}
      };

      const cached = Cache.get(cacheNS, payload);
      if (cached){
        if (window.__APP?.modules?.search?.render) window.__APP.modules.search.render(cached.search_results, cached.condition_label);
        else if (typeof window.renderSearchResults === 'function') window.renderSearchResults(cached.search_results, cached.condition_label);
        has.toast && window.showInfo('已使用缓存结果，后台刷新中...');
        refreshFromServer(cached);
      } else {
        has.toast && window.showLoading('op','搜索中...');
        try {
          const data = await doFetch();
          if (!data.success){
            has.toast && window.hideLoading('op');
            has.toast && window.showError(data.error_message||'搜索失败');
            return;
          }
          Cache.set(cacheNS, payload, data);
          if (window.__APP?.modules?.search?.render) window.__APP.modules.search.render(data.search_results, data.condition_label);
          else if (typeof window.renderSearchResults === 'function') window.renderSearchResults(data.search_results, data.condition_label);
          has.toast && window.hideLoading('op');
          has.toast && window.showSuccess('搜索完成');
          document.querySelector('.fc-tabs[data-tab-group="right-panel"] .fc-tabs__item[data-tab="search-results"]')?.click();
        } catch(err){
          has.toast && window.hideLoading('op');
          has.toast && window.showError('搜索异常: '+err.message);
        }
      }
    });
  }

  // =============== 模块 B：按型号添加（Model Cascade + 条件多选） ===============
  const CondState = {
    items: [],
    selected: new Set(),
    get allChecked() { return this.items.length > 0 && this.selected.size === this.items.length; },
    clear() { this.items = []; this.selected.clear(); }
  };

  function setCondPlaceholder(text){
    const el = $$('#condPlaceholder'); const list = $$('#condList'); const box = $$('#conditionMulti');
    if (!el || !box) return;
    el.textContent = text || '';
    el.classList.remove('hidden');
    list && list.classList.add('hidden');
  }
  function showCondList(){
    const el = $$('#condPlaceholder'); const list = $$('#condList');
    if (el) el.classList.add('hidden');
    if (list) list.classList.remove('hidden');
  }

  function getCondTitleLabel(){
    const box = $$('#conditionMulti');
    if (!box) return null;
    const row = box.closest('.fc-form-row');
    if (!row) return null;
    const label = row.querySelector('label');
    return label || null;
  }
  function updateCondCountLabel(){
    const label = getCondTitleLabel();
    if (!label) return;
    if (!label.dataset.baseLabel){
      // 去掉已有尾部括号
      const base = (label.textContent || '').replace(/\s*\(\d+\)\s*$/, '');
      label.dataset.baseLabel = base;
    }
    const base = label.dataset.baseLabel || '测试工况';
    const count = CondState.selected.size; // “全部”不计入，本状态不包含“全部”
    label.textContent = count > 0 ? `${base} (${count})` : base;
  }

  function renderConditionList(items){
    CondState.items = Array.isArray(items) ? items.slice() : [];
    CondState.selected.clear();
    const listEl = $$('#condList'); if (!listEl) return;

    const renderItems = CondState.items.map(it => {
      const name = EH(it.condition_name_zh || '');
      const extra = FS(it.resistance_type_zh, it.resistance_location_zh);
      const extraHtml = extra ? `<span class="fc-cond-extra"> - ${extra}</span>` : '';
      return { id: String(it.condition_id), html: `<span class="fc-cond-name">${name}</span>${extraHtml}` };
    });

    listEl.innerHTML = `
      <div class="sticky top-0 bg-white pb-1 border-b border-gray-100 mb-1">
        <label class="inline-flex items-center gap-2">
          <input type="checkbox" id="cond_all" class="fc-checkbox">
          <span>-- 全部 --</span>
        </label>
      </div>
      <div class="space-y-1">
        ${renderItems.map(it => `
          <label class="flex items-center gap-2">
            <input type="checkbox" class="cond-item fc-checkbox" data-cond-id="${it.id}">
            <span class="truncate">${it.html}</span>
          </label>
        `).join('')}
      </div>`;

    const allBox = $$('#cond_all');
    const itemBoxes = $$$('.cond-item', listEl);

    function syncAllFromItems(){
      if (allBox){
        allBox.checked = CondState.allChecked;
        allBox.indeterminate = CondState.selected.size > 0 && !CondState.allChecked;
      }
      updateCondCountLabel();
    }
    function checkAll(val){
      CondState.selected.clear();
      if (val) CondState.items.forEach(it => CondState.selected.add(String(it.condition_id)));
      itemBoxes.forEach(b => b.checked = !!val);
      syncAllFromItems();
    }

    allBox?.addEventListener('change', () => checkAll(allBox.checked));
    itemBoxes.forEach(box => {
      box.addEventListener('change', () => {
        const id = box.dataset.condId || '';
        if (box.checked) CondState.selected.add(id); else CondState.selected.delete(id);
        syncAllFromItems();
      });
    });

    checkAll(false);
    showCondList();
    updateCondCountLabel();
  }

  // 数据获取
  async function fetchBrands(){
    const r = await fetchJSON('/api/brands'); return r.ok ? (r.data?.items || r.data || []) : [];
  }
  async function fetchModelsByBrand(brandId){
    const r = await fetchJSON(`/api/models_by_brand?brand_id=${encodeURIComponent(brandId)}`);
    return r.ok ? (r.data?.items || r.data || []) : [];
  }
  async function fetchConditionsByModel(modelId){
    const r = await fetchJSON(`/api/conditions_by_model?model_id=${encodeURIComponent(modelId)}`);
    return r.ok ? (r.data?.items || r.data || []) : [];
  }
  async function fetchExpandPairsById(modelId, conditionIdOrNull){
    const payload = { mode:'expand', model_id: modelId };
    if (conditionIdOrNull != null) payload.condition_id = conditionIdOrNull;
    const r = await fetchJSON('/api/search_fans', {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)
    });
    if (!r.ok) throw new Error(r.error || 'expand 请求失败');
    const items = (r.data && r.data.items) || [];
    return items.map(it=>({ model_id: it.model_id, condition_id: it.condition_id }));
  }

// 仅改动：型号级联初始化与品牌变更时的禁用/占位处理
function initModelCascade(){
  const form = $$('#fanForm');
  const brandSelect = $$('#brandSelect');
  const modelSelect = $$('#modelSelect');
  const conditionLoadingEl = $$('#conditionLoading');
  if (!form || !brandSelect || !modelSelect) return;

  const uiBrand = buildCustomSelectFromNative(brandSelect, { placeholder:'-- 选择品牌 --' });
  const uiModel = buildCustomSelectFromNative(modelSelect, { placeholder:'-- 选择型号 --' });

  (async function initBrands(){
    try {
      const brands = await fetchBrands();
      brandSelect.innerHTML = '<option value="">-- 选择品牌 --</option>' +
        brands.map(b=>`<option value="${EH(b.brand_id)}">${EH(b.brand_name_zh)}</option>`).join('');
      brandSelect.disabled = false;
      uiBrand.refresh(); uiBrand.setDisabled(false);
    } catch(_) {}
    // 新增：初始时型号下拉禁用，提示“请先选择品牌”
    modelSelect.innerHTML = '<option value="">-- 请先选择品牌 --</option>';
    modelSelect.value = '';
    modelSelect.disabled = true;
    uiModel.refresh();
    uiModel.setDisabled(true, { placeholder: '-- 请先选择品牌 --' });

    setCondPlaceholder('-- 请先选择品牌 --');
  })();

  brandSelect.addEventListener('change', async ()=>{
    const bid = brandSelect.value;

    if (!bid) {
      // 新增：无品牌 → 型号禁用且显示“请先选择品牌”
      modelSelect.innerHTML = '<option value="">-- 请先选择品牌 --</option>';
      modelSelect.value = '';
      modelSelect.disabled = true;
      uiModel.refresh();
      uiModel.setDisabled(true, { placeholder: '-- 请先选择品牌 --' });

      CondState.clear();
      renderConditionList([]);
      setCondPlaceholder('-- 请先选择品牌 --');
      return;
    }

    // 有品牌但未加载完型号前，先禁用并显示“选择型号”
    modelSelect.innerHTML = '<option value="">-- 选择型号 --</option>';
    modelSelect.value = '';
    modelSelect.disabled = true;
    uiModel.refresh();
    uiModel.setDisabled(true, { placeholder: '-- 选择型号 --' });

    CondState.clear();
    renderConditionList([]);
    setCondPlaceholder('-- 请先选择型号 --');

    try {
      const models = await fetchModelsByBrand(bid);
      models.forEach(m=>{
        const o=document.createElement('option'); o.value=m.model_id; o.textContent=m.model_name; modelSelect.appendChild(o);
      });
      modelSelect.disabled=false;
      uiModel.refresh();
      uiModel.setDisabled(false); // 解除禁用，保留“选择型号”占位
    } catch(_){}
  });

    modelSelect.addEventListener('change', async ()=>{
      const mid = modelSelect.value;
      CondState.clear();
      renderConditionList([]);
      updateCondCountLabel();
      if (!mid) { setCondPlaceholder('-- 请先选择型号 --'); return; }
      conditionLoadingEl && conditionLoadingEl.classList.remove('hidden');
      setCondPlaceholder('加载中...');
      try {
        const items = await fetchConditionsByModel(mid);
        if (Array.isArray(items) && items.length) renderConditionList(items);
        else setCondPlaceholder('该型号暂无工况');
      } catch(_){
        setCondPlaceholder('加载失败，请重试');
      } finally {
        conditionLoadingEl && conditionLoadingEl.classList.add('hidden');
      }
    });

    // 型号关键字搜索
    (function initModelKeywordSearch(){
      const input = $$('#modelSearchInput');
      const popup = $$('#searchSuggestions');
      if (!input || !popup) return;
      let timer = null;

      input.addEventListener('input', ()=>{
        clearTimeout(timer);
        const q = input.value.trim();
        if (q.length < 2){ popup.classList.add('hidden'); return; }
        timer = setTimeout(async ()=>{
          try{
            const r = await fetch(`/search_models/${encodeURIComponent(q)}?raw=1`);
            const list = await r.json();
            const arr = Array.isArray(list) ? list : [];
            popup.innerHTML='';
            if (!arr.length){ popup.classList.add('hidden'); return; }
            arr.forEach(full=>{
              const div=document.createElement('div');
              div.className='cursor-pointer'; div.textContent=full;
              div.addEventListener('click', async ()=>{
                const parts = full.split(' ');
                const brandName = parts[0];
                const modelName = parts.slice(1).join(' ');
                try {
                  const brands = await fetchBrands();
                  const bRow = (brands || []).find(b => String(b.brand_name_zh) === String(brandName));
                  if (!bRow) throw new Error('未找到品牌ID');

                  // 用自定义下拉的 setValue，自动更新标签并派发 change
                  uiBrand.setValue(bRow.brand_id);

                  // 等待型号列表出现（延长至 2500ms）
                  await new Promise((resolve, reject)=>{
                    const deadline = Date.now() + 2000;
                    (function tryPick(){
                      const opts = Array.from(modelSelect.options || []);
                      const hit = opts.find(o => o.textContent === modelName);
                      if (hit) { resolve(hit.value); return; }
                      if (Date.now() > deadline) { reject(new Error('未找到型号ID')); return; }
                      setTimeout(tryPick, 60);
                    })();
                  }).then(mid => {
                    // 同步模型下拉（更新标签并派发 change）
                    uiModel.setValue(mid);
                  });
                  input.value=''; popup.classList.add('hidden');
                } catch(e){
                  has.toast && window.showError('无法定位到该型号（ID 级联）');
                }
              });
              popup.appendChild(div);
            });
            popup.classList.remove('hidden');
          } catch(_){
            popup.classList.add('hidden');
          }
        }, 280);
      });
      document.addEventListener('click', (e)=>{
        if (!input.contains(e.target) && !popup.contains(e.target)) popup.classList.add('hidden');
      });
    })();

    // 提交：生成 pairs 并沿用现有添加流程
    form.addEventListener('submit', async (e)=>{
      e.preventDefault();
      const mid = modelSelect.value;
      if (!mid){ has.toast && window.showError('请先选择型号'); return; }

      const useAll = CondState.allChecked;
      const pickedIds = Array.from(CondState.selected);
      if (!useAll && pickedIds.length === 0){
        has.toast && window.showError('请选择测试工况'); return;
      }

      has.toast && window.showLoading('op','解析中...');
      try {
        let pairs = [];
        const allPairs = await fetchExpandPairsById(Number(mid), null);
        if (useAll) {
          pairs = allPairs;
        } else {
          const wanted = new Set(pickedIds.map(String));
          pairs = allPairs.filter(p => wanted.has(String(p.condition_id)));
        }

        if (!pairs.length){ has.toast && window.hideLoading('op'); has.toast && window.showInfo('没有匹配数据'); return; }
        if (typeof window.computeNewPairsAfterDedup === 'function') {
          const newPairs = window.computeNewPairsAfterDedup(pairs);
          if (newPairs.length === 0){ has.toast && window.hideLoading('op'); has.toast && window.showInfo('全部已存在，无新增'); return; }
        }
        if (typeof window.ensureCanAdd === 'function' && !window.ensureCanAdd( (pairs && pairs.length) || 1 )){
          has.toast && window.hideLoading('op'); return;
        }

        const addedSummary = window.LocalState.addPairs(pairs);
        has.toast && window.hideLoading('op');
        if (addedSummary.added>0){
          has.toast && window.showSuccess(`新增 ${addedSummary.added} 组`);
          if (typeof window.rebuildSelectedFans === 'function') window.rebuildSelectedFans(window.LocalState.getSelected());
          if (typeof window.ensureLikeStatusBatch === 'function')
            window.ensureLikeStatusBatch(addedSummary.addedDetails.map(d => ({ model_id: d.model_id, condition_id: d.condition_id })));
          window.__APP?.features?.recentlyRemoved?.rebuild?.(window.LocalState.getRecentlyRemoved());
          typeof window.syncQuickActionButtons === 'function' && window.syncQuickActionButtons();
          typeof window.applySidebarColors === 'function' && window.applySidebarColors();
          typeof window.refreshChartFromLocal === 'function' && window.refreshChartFromLocal(false);
          window.__APP?.sidebar?.maybeAutoOpenSidebarOnAdd && window.__APP.sidebar.maybeAutoOpenSidebarOnAdd();
        } else {
          has.toast && window.showInfo('全部已存在，无新增');
        }
        if (typeof window.logNewPairs === 'function') {
          Promise.resolve(window.logNewPairs(addedSummary.addedDetails, 'direct')).catch(()=>{});
        }
      } catch(err){
        has.toast && window.hideLoading('op');
        has.toast && window.showError('添加失败: '+err.message);
      }
    });
  }

  function initAll(){
    initConditionSearch();
    initModelCascade();
  }

  // 自动初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll, { once:true });
  } else {
    initAll();
  }

  window.FancoolSearch = {
    init: initAll,
    _debug: { CondState }
  };
})(window, document);