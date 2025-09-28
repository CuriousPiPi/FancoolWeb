/* ========== 图表模块 ========== */

let chartFrame = null;

// 初始化图表
function initChart() {
  chartFrame = window.__APP.dom.one('#chartFrame');
  
  if (chartFrame) {
    // 监听图表消息
    window.addEventListener('message', handleChartMessage);
    
    // 监听窗口大小变化
    window.addEventListener('resize', debounce(resizeChart, 250));
  }
}

// 处理来自图表 iframe 的消息
function handleChartMessage(event) {
  if (event.origin !== window.location.origin) return;
  
  try {
    const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    
    switch (data.type) {
      case 'chart-ready':
        console.log('图表已准备就绪');
        break;
        
      case 'chart-error':
        console.error('图表错误:', data.error);
        showError('图表加载失败');
        break;
        
      case 'chart-clicked':
        console.log('图表点击:', data.params);
        break;
        
      default:
        console.log('未知图表消息:', data);
    }
  } catch (error) {
    console.error('解析图表消息失败:', error);
  }
}

// 发送数据到图表
function postChartData(chartData) {
  if (!chartFrame || !chartFrame.contentWindow) {
    console.warn('图表未初始化');
    return;
  }
  
  try {
    const message = {
      type: 'chart-data',
      data: chartData,
      timestamp: Date.now()
    };
    
    chartFrame.contentWindow.postMessage(JSON.stringify(message), '*');
    window.__APP.state.lastChartData = chartData;
  } catch (error) {
    console.error('发送图表数据失败:', error);
    showError('更新图表失败');
  }
}

// 调整图表大小
function resizeChart() {
  if (!chartFrame || !chartFrame.contentWindow) return;
  
  try {
    const message = {
      type: 'chart-resize',
      timestamp: Date.now()
    };
    
    chartFrame.contentWindow.postMessage(JSON.stringify(message), '*');
  } catch (error) {
    console.error('调整图表大小失败:', error);
  }
}

// 更新图表主题
function updateChartTheme(theme) {
  if (!chartFrame || !chartFrame.contentWindow) return;
  
  try {
    const message = {
      type: 'chart-theme',
      theme: theme,
      timestamp: Date.now()
    };
    
    chartFrame.contentWindow.postMessage(JSON.stringify(message), '*');
  } catch (error) {
    console.error('更新图表主题失败:', error);
  }
}

// 清空图表
function clearChart() {
  postChartData({ fans: [] });
  window.__APP.state.lastChartData = null;
}

// 图表全屏切换
function toggleChartFullscreen() {
  if (!chartFrame) return;
  
  const container = chartFrame.parentElement;
  if (!container) return;
  
  try {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      container.requestFullscreen();
    }
  } catch (error) {
    console.error('全屏切换失败:', error);
  }
}

// 监听全屏状态变化
function handleFullscreenChange() {
  const isFullscreen = !!document.fullscreenElement;
  
  // 通知图表全屏状态变化
  if (chartFrame && chartFrame.contentWindow) {
    try {
      const message = {
        type: 'chart-fullscreen',
        fullscreen: isFullscreen,
        timestamp: Date.now()
      };
      
      chartFrame.contentWindow.postMessage(JSON.stringify(message), '*');
    } catch (error) {
      console.error('发送全屏状态失败:', error);
    }
  }
}

// 防抖函数
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// 错误显示函数
function showError(message) {
  if (window.__APP.ui && window.__APP.ui.showError) {
    window.__APP.ui.showError(message);
  } else {
    console.error('ERROR:', message);
  }
}

// 导出图表模块
window.__APP.chart = {
  init: initChart,
  postChartData,
  resizeChart,
  updateChartTheme,
  clearChart,
  toggleChartFullscreen,
  
  // 初始化图表相关事件监听器
  initEvents() {
    // 全屏变化监听
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('mozfullscreenchange', handleFullscreenChange);
    document.addEventListener('MSFullscreenChange', handleFullscreenChange);
    
    // 全屏按钮事件
    const fullscreenBtn = window.__APP.dom.one('#chartFullscreenBtn');
    if (fullscreenBtn) {
      fullscreenBtn.addEventListener('click', toggleChartFullscreen);
    }
  }
};