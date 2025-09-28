/* ========== 主入口文件 ========== */

import { APP_CONFIG } from './config.js';
import { bindCascadeSelects, bindSearchForm } from './search.js';

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

// 主应用初始化（精简后：搜索/级联逻辑由 search.js 绑定）
async function initApp() {
  try {
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

    // 6. 加载查询次数 + 定时刷新
    loadQueryCount();
    setInterval(loadQueryCount, 60000);

    // 7. 绑定级联下拉与搜索（抽离模块后统一调用）
    bindCascadeSelects(window.__APP.api, window.__APP.dom);
    bindSearchForm(window.__APP.api, window.__APP.dom, window.__APP.ui, window.__APP.likes);

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

// 模块注册（兼容性保留）
window.__APP.modules = {
  overlay: {
    open: () => window.__APP.dom.one('#sidebar')?.classList.remove('collapsed'),
    close: () => window.__APP.dom.one('#sidebar')?.classList.add('collapsed'),
    toggle: () => window.__APP.dom.one('#sidebar')?.classList.toggle('collapsed')
  },
  gesture: { ensureZone: () => {} },
  layout: {
    scheduleAdjust: () => { window.__APP.chart.resizeChart(); },
    adjustBottomAuto: () => {}
  },
  search: {
    // 渲染函数现由 search.js 内部处理；如需外部调用可在 search.js 导出再挂接
    cache: window.__APP.cache
  },
  rankings: {
    reloadTopRatings: () => window.__APP.likes.reloadTopRatings(),
    loadLikesIfNeeded: () => window.__APP.likes.loadLikesIfNeeded()
  },
  state: { processState: (state) => window.__APP.state.processState(state) },
  theme: { setTheme: (theme) => window.__APP.state.setTheme(theme) },
  chart: {
    postChartData: (data) => window.__APP.chart.postChartData(data),
    resizeChart: () => window.__APP.chart.resizeChart()
  }
};

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', initApp);
