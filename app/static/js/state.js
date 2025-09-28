/* ========== 状态管理模块 ========== */

// 全局状态
let selectedMapSet = new Set();
let selectedKeySet = new Set();
let lastChartData = null;
let recentRemovedItems = [];

// 状态重建函数
function rebuildSelectedIndex() {
  selectedMapSet.clear();
  selectedKeySet.clear();
  window.__APP.dom.all('#selectedFansList .fan-item').forEach(div => {
    const key = div.getAttribute('data-fan-key');
    if (key) selectedKeySet.add(key);
    const map = div.getAttribute('data-map');
    if (map) selectedMapSet.add(map);
  });
}

// 更新计数显示
function updateSelectedCount() {
  const countEl = window.__APP.dom.one('#selectedCount');
  if (countEl) {
    countEl.textContent = selectedKeySet.size;
  }
}

// 检查是否已选择某个风扇
function isSelected(key) {
  return selectedKeySet.has(key);
}

// 检查是否达到最大数量
function isAtMaxCapacity() {
  return selectedKeySet.size >= (window.APP_CONFIG?.maxItems || 8);
}

// 获取选择的风扇键
function getSelectedKeys() {
  return Array.from(selectedKeySet);
}

// 颜色分配
const COLOR_PALETTE = [
  "#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd",
  "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf",
  "#3E9BFF", "#FFF958", "#42E049", "#FF4848", "#DB68FF",
  "#2CD1E8", "#F59916", "#FF67A6", "#8b5cf6", "#14E39E"
];

function colorForKey(key) {
  if (!key) return COLOR_PALETTE[0];
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash) + key.charCodeAt(i);
    hash = hash & hash;
  }
  return COLOR_PALETTE[Math.abs(hash) % COLOR_PALETTE.length];
}

// 主题检测
const currentThemeStr = () =>
  (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');

// 主题切换
function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  
  // 更新颜色点
  window.__APP.dom.all('#selectedFansList .fan-item').forEach(div => {
    const key = div.getAttribute('data-fan-key');
    const dot = div.querySelector('.js-color-dot');
    if (key && dot) dot.style.backgroundColor = colorForKey(key);
  });
}

// 主题切换事件处理
function toggleTheme() {
  let currentTheme = currentThemeStr();
  currentTheme = currentTheme === 'light' ? 'dark' : 'light';
  setTheme(currentTheme);
  
  // 重新渲染图表
  if (lastChartData) {
    window.__APP.modules.chart.postChartData(lastChartData);
  } else {
    window.__APP.modules.chart.resizeChart();
  }
}

// 状态处理函数
async function processState(stateData) {
  try {
    // 更新选中的风扇列表
    const selectedList = window.__APP.dom.one('#selectedFansList');
    if (selectedList && stateData.selected_fans) {
      selectedList.innerHTML = '';
      stateData.selected_fans.forEach(fan => {
        const fanItem = createFanItem(fan);
        selectedList.appendChild(fanItem);
      });
    }

    // 更新最近移除列表
    if (stateData.recently_removed) {
      recentRemovedItems = stateData.recently_removed;
      renderRecentlyRemoved(recentRemovedItems);
    }

    // 重建索引
    rebuildSelectedIndex();
    updateSelectedCount();

    // 更新颜色点
    window.__APP.dom.all('#selectedFansList .fan-item').forEach(div => {
      const key = div.getAttribute('data-fan-key');
      const dot = div.querySelector('.js-color-dot');
      if (key && dot) dot.style.backgroundColor = colorForKey(key);
    });

    // 更新清空按钮可见性
    updateClearAllVisibility();

    // 如果有选中的风扇，准备图表数据
    if (selectedKeySet.size > 0) {
      const chartData = prepareChartData(stateData.selected_fans);
      lastChartData = chartData;
      window.__APP.modules.chart.postChartData(chartData);
    }

  } catch (error) {
    console.error('状态处理错误:', error);
  }
}

// 创建风扇项DOM
function createFanItem(fan) {
  const div = document.createElement('div');
  div.className = 'fan-item flex items-center justify-between p-3 border border-gray-200 rounded-md';
  div.setAttribute('data-fan-key', fan.key);
  div.setAttribute('data-map', `${fan.brand}||${fan.model}||${fan.res_type}||${fan.res_loc || '无'}`);
  
  div.innerHTML = `
    <div class="flex items-center min-w-0">
      <div class="w-3 h-3 rounded-full mr-2 flex-shrink-0 js-color-dot" style="background-color: ${colorForKey(fan.key)}"></div>
      <div class="truncate">
        <span class="font-medium">${fan.brand} ${fan.model}</span> - 
        <span class="text-gray-600 text-sm">
          ${fan.res_loc ? `${fan.res_type}(${fan.res_loc})` : fan.res_type}
        </span>
      </div>
    </div>
    <div class="flex items-center flex-shrink-0">
      <button class="like-button mr-3" 
              data-fan-key="${fan.key}"
              data-model-id="${fan.model_id}"
              data-condition-id="${fan.condition_id}"
              aria-label="点赞">
        <i class="fa-solid fa-thumbs-up text-gray-400"></i>
      </button>
      <button class="btn-add" data-mode="remove" data-fan-key="${fan.key}" aria-label="移除">
        <i class="fa-solid fa-times"></i>
      </button>
    </div>
  `;
  
  return div;
}

// 渲染最近移除列表
function renderRecentlyRemoved(items) {
  const container = window.__APP.dom.one('#recentRemovedList');
  if (!container) return;
  
  if (items.length === 0) {
    container.innerHTML = '<div class="text-gray-500 text-sm text-center py-4">无最近移除项</div>';
    return;
  }
  
  container.innerHTML = items.map(item => `
    <div class="flex items-center justify-between p-2 border-b border-gray-100 last:border-b-0">
      <div class="flex-1 min-w-0">
        <div class="truncate font-medium text-sm">${item.brand} ${item.model}</div>
        <div class="truncate text-xs text-gray-500">${item.res_type}${item.res_loc ? `(${item.res_loc})` : ''}</div>
      </div>
      <button class="restore-icon ml-2 p-1" 
              data-fan-key="${item.key}" 
              aria-label="恢复">
        <i class="fa-solid fa-undo text-sm"></i>
      </button>
    </div>
  `).join('');
}

// 更新清空按钮可见性
function updateClearAllVisibility() {
  const container = window.__APP.dom.one('#clearAllContainer');
  if (container) {
    container.style.display = selectedKeySet.size > 0 ? 'block' : 'none';
  }
}

// 准备图表数据
function prepareChartData(selectedFans) {
  return {
    fans: selectedFans.map(fan => ({
      key: fan.key,
      brand: fan.brand,
      model: fan.model,
      res_type: fan.res_type,
      res_loc: fan.res_loc,
      rpm_data: fan.rpm_data || [],
      noise_data: fan.noise_data || [],
      color: colorForKey(fan.key)
    }))
  };
}

// 导出状态管理模块
window.__APP.state = {
  rebuildSelectedIndex,
  updateSelectedCount,
  isSelected,
  isAtMaxCapacity,
  getSelectedKeys,
  colorForKey,
  currentThemeStr,
  setTheme,
  toggleTheme,
  processState,
  createFanItem,
  renderRecentlyRemoved,
  updateClearAllVisibility,
  prepareChartData,
  
  // 状态访问器
  get selectedKeys() { return Array.from(selectedKeySet); },
  get selectedMaps() { return Array.from(selectedMapSet); },
  get recentRemoved() { return recentRemovedItems; },
  get lastChartData() { return lastChartData; },
  set lastChartData(data) { lastChartData = data; }
};