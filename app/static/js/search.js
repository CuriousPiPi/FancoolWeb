import { APP_CONFIG } from './config.js';

export function bindCascadeSelects(api, dom) {
  const brandSelect = dom.one('#brandSelect');
  const modelSelect = dom.one('#modelSelect');
  const resTypeSelect = dom.one('#resTypeSelect');
  const resLocSelect = dom.one('#resLocSelect');

  function clearSelect(sel) {
    if (!sel) return;
    const first = sel.children[0];
    sel.innerHTML = '';
    if (first) sel.appendChild(first);
    sel.value = '';
  }
  function updateOptions(sel, arr) {
    if (!sel) return;
    const first = sel.children[0];
    sel.innerHTML = '';
    if (first) sel.appendChild(first);
    (arr || []).forEach(v => {
      const opt = document.createElement('option');
      opt.value = v; opt.textContent = v; sel.appendChild(opt);
    });
  }

  brandSelect?.addEventListener('change', async () => {
    const b = brandSelect.value;
    if (!b) { clearSelect(modelSelect); clearSelect(resTypeSelect); clearSelect(resLocSelect); return; }
    try {
      const data = await api.getModels(b);
      updateOptions(modelSelect, data.models || []);
      clearSelect(resTypeSelect); clearSelect(resLocSelect);
    } catch (e) { console.error('获取型号失败', e); }
  });

  modelSelect?.addEventListener('change', async () => {
    const b = brandSelect?.value;
    const m = modelSelect?.value;
    if (!(b && m)) { clearSelect(resTypeSelect); clearSelect(resLocSelect); return; }
    try {
      const data = await api.getResistanceTypes(b, m);
      updateOptions(resTypeSelect, data.res_types || []);
      clearSelect(resLocSelect);
    } catch (e) { console.error('获取阻力类型失败', e); }
  });

  resTypeSelect?.addEventListener('change', async () => {
    const b = brandSelect?.value;
    const m = modelSelect?.value;
    const rt = resTypeSelect?.value;
    if (!(b && m && rt)) { clearSelect(resLocSelect); return; }
    try {
      const data = await api.getResistanceLocations(b, m, rt);
      updateOptions(resLocSelect, data.res_locs || []);
    } catch (e) { console.error('获取阻力位置失败', e); }
  });
}

export function bindSearchForm(api, dom, ui, likes) {
  const form = dom.one('#searchForm');
  const btn = dom.one('#searchBtn');
  const airflowTable = dom.one('#searchAirflowTbody');
  const likesTable = dom.one('#searchLikesTbody');
  const label = dom.one('#searchConditionLabel');

  async function execute(e) {
    if (e) e.preventDefault();
    if (!form) return;
    const fd = new FormData(form);
    const payload = Object.fromEntries(fd);
    try {
      ui.showInfo('搜索中...');
      const data = await api.searchFans(payload);
      if (data.success) {
        label && (label.textContent = data.condition_label || '');
        renderResults(data.search_results || []);
        ui.showSuccess('搜索完成');
      } else {
        ui.showError(data.error_message || data.error || '搜索失败');
      }
    } catch (err) {
      console.error(err);
      ui.showError('搜索失败，请稍后重试');
    }
  }

  function renderResults(results) {
    if (!airflowTable) return;
    if (!results.length) {
      const empty = `<tr><td colspan="7" class="text-center text-gray-500 py-6">无结果</td></tr>`;
      airflowTable.innerHTML = empty;
      if (likesTable) likesTable.innerHTML = empty;
      return;
    }
    airflowTable.innerHTML = results.map(item => `
      <tr>
        <td>${item.brand ?? ''}</td>
        <td>${item.model ?? ''}</td>
        <td>${item.size ?? ''}</td>
        <td>${(item.res_type || '') + (item.res_loc ? '(' + item.res_loc + ')' : '')}</td>
        <td>${item.max_speed ?? ''}</td>
        <td>${item.max_airflow ?? ''}</td>
        <td class="actions-cell">${likes.buildQuickBtnHTML('search', item.brand, item.model, item.res_type, item.res_loc)}</td>
      </tr>
    `).join('');
    if (likesTable) likesTable.innerHTML = airflowTable.innerHTML;
  }

  form?.addEventListener('submit', execute);
  btn?.addEventListener('click', execute);
}