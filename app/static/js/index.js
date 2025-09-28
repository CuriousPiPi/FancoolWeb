/* ========== 主入口文件 ========== */

// 全局配置（从后端注入）
window.APP_CONFIG = window.APP_CONFIG || {
  clickCooldownMs: 2000,
  maxItems: 8
};

// POLYFILL 确保兼容性
(function () {
  if (typeof Element !== 'undefined') {
    if (!Element.prototype.matches) {
      Element.prototype.matches =
        Element.prototype.msMatchesSelector ||
        Element.prototype.webkitMatchesSelector ||
        function (selector) {
          const list = (this.document || this.ownerDocument).querySelectorAll(selector);
          let i = 0;
          while (list[i] && list[i] !== this) i++;
          return !!list[i];
        };
    }
    if (!Element.prototype.closest) {
      Element.prototype.closest = function (selector) {
        let el = this;
        while (el && el.nodeType === 1) {
          if (el.matches(selector)) return el;
          el = el.parentElement;
        }
        return null;
      };
    }
  }
})();

// 主应用初始化
async function initApp() {
  try {
    console.log('初始化应用...');
    
    // 1. 初始化事件处理器
    window.__APP.events.init();
    
    // 2. 初始化图表
    window.__APP.chart.init();
    window.__APP.chart.initEvents();
    
    // 3. 加载初始状态
    await loadInitialState();
    
    // 4. 初始化侧边栏调整功能
    initSidebarResizer();
    
    // 5. 初始化侧边栏分隔条
    initSidebarSplitter();
    
    // 6. 加载查询次数
    loadQueryCount();
    
    // 7. 设置定期更新查询次数
    setInterval(loadQueryCount, 60000); // 每分钟更新
    
    // 8. 初始化表单级联选择
    initCascadeSelects();
    
    // 9. 初始化搜索功能
    initSearchForm();
    
    console.log('应用初始化完成');
    
  } catch (error) {
    console.error('应用初始化失败:', error);
    window.__APP.ui.showError('应用初始化失败，请刷新页面重试');
  }
}

// 加载初始状态
async function loadInitialState() {
  try {
    const stateData = await window.__APP.api.getState();
    if (stateData.success) {
      await window.__APP.state.processState(stateData);
    } else {
      console.error('加载初始状态失败:', stateData.error);
    }
  } catch (error) {
    console.error('获取初始状态失败:', error);
  }
}

// 加载查询次数
async function loadQueryCount() {
  try {
    const data = await window.__APP.api.getQueryCount();
    const countEl = window.__APP.dom.one('#query-count');
    if (countEl) {
      countEl.textContent = data.count || 0;
    }
  } catch (error) {
    console.error('获取查询次数失败:', error);
  }
}

// 初始化侧边栏调整器
function initSidebarResizer() {
  const resizer = window.__APP.dom.one('#sidebar-resizer');
  const sidebar = window.__APP.dom.one('#sidebar');
  
  if (!resizer || !sidebar) return;
  
  let isResizing = false;
  let startX = 0;
  let startWidth = 0;
  
  resizer.addEventListener('mousedown', (e) => {
    isResizing = true;
    startX = e.clientX;
    startWidth = parseInt(document.defaultView.getComputedStyle(sidebar).width, 10);
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  
  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    
    const width = startWidth + e.clientX - startX;
    const minWidth = 300;
    const maxWidth = Math.min(800, window.innerWidth * 0.6);
    
    if (width >= minWidth && width <= maxWidth) {
      sidebar.style.width = width + 'px';
    }
  });
  
  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });
}

// 初始化侧边栏分隔条
function initSidebarSplitter() {
  const splitter = window.__APP.dom.one('#sidebar-splitter');
  const handle = window.__APP.dom.one('#sidebar-splitter-handle');
  const topPanel = window.__APP.dom.one('#top-panel');
  const bottomPanel = window.__APP.dom.one('#bottom-panel');
  
  if (!splitter || !handle || !topPanel || !bottomPanel) return;
  
  let isDragging = false;
  let startY = 0;
  let startTopHeight = 0;
  let startBottomHeight = 0;
  
  handle.addEventListener('mousedown', (e) => {
    isDragging = true;
    startY = e.clientY;
    startTopHeight = topPanel.offsetHeight;
    startBottomHeight = bottomPanel.offsetHeight;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  
  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    
    const deltaY = e.clientY - startY;
    const newTopHeight = startTopHeight + deltaY;
    const newBottomHeight = startBottomHeight - deltaY;
    const minPanelHeight = 100;
    
    if (newTopHeight >= minPanelHeight && newBottomHeight >= minPanelHeight) {
      topPanel.style.height = newTopHeight + 'px';
      bottomPanel.style.height = newBottomHeight + 'px';
    }
  });
  
  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });
}

// 初始化级联选择
function initCascadeSelects() {
  const brandSelect = window.__APP.dom.one('#brandSelect');
  const modelSelect = window.__APP.dom.one('#modelSelect');
  const resTypeSelect = window.__APP.dom.one('#resTypeSelect');
  const resLocSelect = window.__APP.dom.one('#resLocSelect');
  
  if (brandSelect) {
    brandSelect.addEventListener('change', async () => {
      const brand = brandSelect.value;
      if (brand) {
        try {
          const data = await window.__APP.api.getModels(brand);
          updateSelectOptions(modelSelect, data.models || []);
          clearSelect(resTypeSelect);
          clearSelect(resLocSelect);
        } catch (error) {
          console.error('获取型号失败:', error);
        }
      } else {
        clearSelect(modelSelect);
        clearSelect(resTypeSelect);
        clearSelect(resLocSelect);
      }
    });
  }
  
  if (modelSelect) {
    modelSelect.addEventListener('change', async () => {
      const brand = brandSelect?.value;
      const model = modelSelect.value;
      if (brand && model) {
        try {
          const data = await window.__APP.api.getResistanceTypes(brand, model);
          updateSelectOptions(resTypeSelect, data.res_types || []);
          clearSelect(resLocSelect);
        } catch (error) {
          console.error('获取阻力类型失败:', error);
        }
      } else {
        clearSelect(resTypeSelect);
        clearSelect(resLocSelect);
      }
    });
  }
  
  if (resTypeSelect) {
    resTypeSelect.addEventListener('change', async () => {
      const brand = brandSelect?.value;
      const model = modelSelect?.value;
      const resType = resTypeSelect.value;
      if (brand && model && resType) {
        try {
          const data = await window.__APP.api.getResistanceLocations(brand, model, resType);
          updateSelectOptions(resLocSelect, data.res_locs || []);
        } catch (error) {
          console.error('获取阻力位置失败:', error);
        }
      } else {
        clearSelect(resLocSelect);
      }
    });
  }
}

// 更新选择框选项
function updateSelectOptions(select, options) {
  if (!select) return;
  
  // 保留第一个选项（通常是"请选择"）
  const firstOption = select.children[0];
  select.innerHTML = '';
  if (firstOption) select.appendChild(firstOption);
  
  options.forEach(option => {
    const opt = document.createElement('option');
    opt.value = option;
    opt.textContent = option;
    select.appendChild(opt);
  });
}

// 清空选择框
function clearSelect(select) {
  if (!select) return;
  
  const firstOption = select.children[0];
  select.innerHTML = '';
  if (firstOption) select.appendChild(firstOption);
  select.value = '';
}

// 初始化搜索表单
function initSearchForm() {
  const searchForm = window.__APP.dom.one('#searchForm');
  const searchBtn = window.__APP.dom.one('#searchBtn');
  
  if (searchForm) {
    searchForm.addEventListener('submit', handleSearch);
  }
  
  if (searchBtn) {
    searchBtn.addEventListener('click', handleSearch);
  }
}

// 处理搜索
async function handleSearch(e) {
  if (e) e.preventDefault();
  
  const formData = new FormData(window.__APP.dom.one('#searchForm'));
  const payload = Object.fromEntries(formData);
  
  try {
    window.__APP.ui.showInfo('搜索中...');
    const data = await window.__APP.api.searchFans(payload);
    
    if (data.success) {
      renderSearchResults(data.search_results, data.condition_label);
      window.__APP.ui.showSuccess('搜索完成');
    } else {
      window.__APP.ui.showError(data.error || '搜索失败');
    }
  } catch (error) {
    console.error('搜索失败:', error);
    window.__APP.ui.showError('搜索失败，请稍后重试');
  }
}

// 渲染搜索结果
function renderSearchResults(results, conditionLabel) {
  // 这里应该实现搜索结果的渲染逻辑
  console.log('搜索结果:', results, conditionLabel);
  
  // 简化的实现，实际应该根据具体需求来实现
  const airflowTable = window.__APP.dom.one('#searchAirflowTbody');
  const likesTable = window.__APP.dom.one('#searchLikesTbody');
  
  if (airflowTable && results) {
    // 渲染风量表格
    airflowTable.innerHTML = results.map(item => `
      <tr>
        <td>${item.brand || ''}</td>
        <td>${item.model || ''}</td>
        <td>${item.res_type || ''}</td>
        <td>${item.res_loc || ''}</td>
        <td>${item.rpm || ''}</td>
        <td>${item.noise_db || ''}</td>
        <td class="actions-cell">
          ${window.__APP.likes.buildQuickBtnHTML('search', item.brand, item.model, item.res_type, item.res_loc)}
        </td>
      </tr>
    `).join('');
  }
}

// 模块注册（兼容性）
window.__APP.modules = {
  overlay: {
    open: () => window.__APP.dom.one('#sidebar')?.classList.remove('collapsed'),
    close: () => window.__APP.dom.one('#sidebar')?.classList.add('collapsed'),
    toggle: () => window.__APP.dom.one('#sidebar')?.classList.toggle('collapsed')
  },
  gesture: {
    ensureZone: () => { }
  },
  layout: {
    scheduleAdjust: () => {
      window.__APP.chart.resizeChart();
    },
    adjustBottomAuto: () => {
      // 自动调整底部面板高度的逻辑
    }
  },
  search: {
    render: renderSearchResults,
    cache: window.__APP.cache
  },
  rankings: {
    reloadTopRatings: () => window.__APP.likes.reloadTopRatings(),
    loadLikesIfNeeded: () => window.__APP.likes.loadLikesIfNeeded()
  },
  state: {
    processState: (state) => window.__APP.state.processState(state)
  },
  theme: {
    setTheme: (theme) => window.__APP.state.setTheme(theme)
  },
  chart: {
    postChartData: (data) => window.__APP.chart.postChartData(data),
    resizeChart: () => window.__APP.chart.resizeChart()
  }
};

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', initApp);