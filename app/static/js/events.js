/* ========== 事件处理模块 ========== */

// Toast 功能
function createToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  const icon = type === 'success' ? 'fa-check-circle' :
               type === 'error' ? 'fa-exclamation-circle' :
               type === 'loading' ? 'fa-spinner fa-spin' :
               'fa-info-circle';
  
  toast.innerHTML = `
    <i class="fa-solid ${icon}"></i>
    <span>${message}</span>
  `;
  
  const container = window.__APP.dom.one('#toastContainer');
  if (container) {
    container.appendChild(toast);
    
    // 自动移除（加载状态除外）
    if (type !== 'loading') {
      setTimeout(() => {
        if (toast.parentNode) {
          toast.style.animation = 'toastSlideOut 0.3s ease-out forwards';
          setTimeout(() => {
            if (toast.parentNode) {
              container.removeChild(toast);
            }
          }, 300);
        }
      }, 3000);
    }
  }
  
  return toast;
}

// 添加离场动画到 CSS 中（如果还没有）
function addToastAnimations() {
  if (document.querySelector('#toast-animations')) return;
  
  const style = document.createElement('style');
  style.id = 'toast-animations';
  style.textContent = `
    @keyframes toastSlideOut {
      from { transform: translateX(0); opacity: 1; }
      to { transform: translateX(100%); opacity: 0; }
    }
  `;
  document.head.appendChild(style);
}

// 初始化侧边栏事件
function initSidebarEvents() {
  const toggle = window.__APP.dom.one('#sidebar-toggle');
  const sidebar = window.__APP.dom.one('#sidebar');
  
  if (toggle && sidebar) {
    toggle.addEventListener('click', () => {
      sidebar.classList.toggle('collapsed');
      
      // 更新按钮 aria-label
      const isCollapsed = sidebar.classList.contains('collapsed');
      toggle.setAttribute('aria-label', isCollapsed ? '展开侧栏' : '收起侧栏');
    });
  }
}

// 初始化页签切换事件
function initTabEvents() {
  // 通用页签切换处理
  document.addEventListener('click', (e) => {
    const tabItem = e.target.closest('.tab-nav-item');
    if (!tabItem) return;
    
    const tabGroup = tabItem.closest('[data-tab-group]')?.dataset.tabGroup;
    if (!tabGroup) return;
    
    const targetTab = tabItem.dataset.tab;
    if (!targetTab) return;
    
    // 更新活动状态
    const allTabs = document.querySelectorAll(`[data-tab-group="${tabGroup}"] .tab-nav-item`);
    allTabs.forEach(tab => tab.classList.remove('active'));
    tabItem.classList.add('active');
    
    // 切换内容
    switchTabContent(tabGroup, targetTab);
  });
}

// 切换页签内容
function switchTabContent(tabGroup, targetTab) {
  if (tabGroup === 'sidebar-top') {
    const wrapper = window.__APP.dom.one('#top-tabs-wrapper');
    if (wrapper) {
      const translateX = targetTab === 'recent-liked' ? '-50%' : '0';
      wrapper.style.transform = `translateX(${translateX})`;
    }
    
    // 如果切换到最近点赞且需要加载数据
    if (targetTab === 'recent-liked' && window.__APP.likes.needReloadLikes()) {
      window.__APP.likes.loadRecentLikes();
    }
  } else if (tabGroup === 'left-panel') {
    const wrapper = window.__APP.dom.one('#left-tabs-wrapper');
    if (wrapper) {
      const translateX = targetTab === 'search' ? '-50%' : '0';
      wrapper.style.transform = `translateX(${translateX})`;
    }
  }
}

// 初始化分段控件事件
function initSegmentEvents() {
  document.addEventListener('click', (e) => {
    const segBtn = e.target.closest('.seg-btn');
    if (!segBtn) return;
    
    const seg = segBtn.closest('.seg');
    const targetPanel = segBtn.dataset.target;
    
    if (seg && targetPanel) {
      // 更新分段控件状态
      const allBtns = seg.querySelectorAll('.seg-btn');
      allBtns.forEach(btn => btn.classList.remove('is-active'));
      segBtn.classList.add('is-active');
      
      // 更新容器的 data-active 属性
      seg.dataset.active = targetPanel;
      
      // 切换面板显示
      const container = seg.closest('.right-subseg').parentNode;
      const panels = container.querySelectorAll('.rank-panel');
      panels.forEach(panel => panel.classList.remove('active'));
      
      const activePanel = container.querySelector(`#${targetPanel}`);
      if (activePanel) {
        activePanel.classList.add('active');
        
        // 如果是好评榜面板且需要加载数据
        if (targetPanel === 'ratings-panel' && window.__APP.likes.needReloadLikes()) {
          window.__APP.likes.reloadTopRatings();
        }
      }
    }
  });
}

// 初始化点赞按钮事件
function initLikeEvents() {
  document.addEventListener('click', async (e) => {
    const likeBtn = e.target.closest('.like-button');
    if (!likeBtn) return;
    
    e.preventDefault();
    await window.__APP.likes.handleLikeClick(likeBtn);
  });
}

// 初始化添加/移除按钮事件
function initAddRemoveEvents() {
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.btn-add');
    if (!btn) return;
    
    e.preventDefault();
    
    const mode = btn.dataset.mode;
    if (mode === 'add') {
      await handleAddFan(btn);
    } else if (mode === 'remove') {
      await handleRemoveFan(btn);
    }
  });
}

// 处理添加风扇
async function handleAddFan(btn) {
  if (window.__APP.state.isAtMaxCapacity()) {
    showError(`最多只能选择 ${window.APP_CONFIG?.maxItems || 8} 个数据`);
    return;
  }
  
  const brand = btn.dataset.brand;
  const model = btn.dataset.model;
  const resType = btn.dataset.resType;
  const resLoc = btn.dataset.resLoc;
  
  if (!brand || !model || !resType) {
    showError('缺少必要参数');
    return;
  }
  
  try {
    showInfo('添加中...');
    const data = await window.__APP.api.addFan(brand, model, resType, resLoc);
    
    if (data.success) {
      showSuccess('已添加');
      await window.__APP.state.processState(data);
    } else {
      showError(data.error || '添加失败');
    }
  } catch (error) {
    console.error('添加失败:', error);
    showError('操作失败，请稍后重试');
  }
}

// 处理移除风扇
async function handleRemoveFan(btn) {
  const fanKey = btn.dataset.fanKey;
  if (!fanKey) {
    showError('缺少必要参数');
    return;
  }
  
  try {
    const data = await window.__APP.api.removeFan(fanKey);
    
    if (data.success) {
      showSuccess('已移除');
      await window.__APP.state.processState(data);
    } else {
      showError(data.error || '移除失败');
    }
  } catch (error) {
    console.error('移除失败:', error);
    showError('操作失败，请稍后重试');
  }
}

// 初始化恢复按钮事件
function initRestoreEvents() {
  document.addEventListener('click', async (e) => {
    const restoreBtn = e.target.closest('.restore-icon');
    if (!restoreBtn) return;
    
    e.preventDefault();
    
    const fanKey = restoreBtn.dataset.fanKey;
    if (!fanKey) {
      showError('缺少必要参数');
      return;
    }
    
    if (window.__APP.state.isAtMaxCapacity()) {
      showError(`最多只能选择 ${window.APP_CONFIG?.maxItems || 8} 个数据`);
      return;
    }
    
    try {
      const data = await window.__APP.api.restoreFan(fanKey);
      
      if (data.success) {
        showSuccess('已恢复');
        await window.__APP.state.processState(data);
      } else {
        showError(data.error || '恢复失败');
      }
    } catch (error) {
      console.error('恢复失败:', error);
      showError('操作失败，请稍后重试');
    }
  });
}

// 初始化清空按钮事件
function initClearEvents() {
  const clearBtn = window.__APP.dom.one('#clearAllBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      if (!confirm('确定要清空所有选中的数据吗？')) {
        return;
      }
      
      try {
        const data = await window.__APP.api.clearAll();
        
        if (data.success) {
          showSuccess('已清空');
          await window.__APP.state.processState(data);
        } else {
          showError(data.error || '清空失败');
        }
      } catch (error) {
        console.error('清空失败:', error);
        showError('操作失败，请稍后重试');
      }
    });
  }
}

// 初始化主题切换事件
function initThemeEvents() {
  const themeBtn = window.__APP.dom.one('#themeToggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      window.__APP.state.toggleTheme();
    });
  }
}

// 初始化分享按钮事件
function initShareEvents() {
  const shareBtn = window.__APP.dom.one('#shareBtn');
  if (shareBtn) {
    shareBtn.addEventListener('click', () => {
      window.__APP.share.createShare();
    });
  }
}

// 初始化键盘导航
function initKeyboardNavigation() {
  // Tab 页签的键盘导航
  document.addEventListener('keydown', (e) => {
    const focusedTab = document.activeElement;
    if (!focusedTab.classList.contains('tab-nav-item')) return;
    
    const tabGroup = focusedTab.closest('[data-tab-group]');
    if (!tabGroup) return;
    
    const tabs = Array.from(tabGroup.querySelectorAll('.tab-nav-item'));
    const currentIndex = tabs.indexOf(focusedTab);
    
    let newIndex = currentIndex;
    if (e.key === 'ArrowLeft') newIndex = Math.max(0, currentIndex - 1);
    else if (e.key === 'ArrowRight') newIndex = Math.min(tabs.length - 1, currentIndex + 1);
    else if (e.key === 'Home') newIndex = 0;
    else if (e.key === 'End') newIndex = tabs.length - 1;
    
    if (newIndex !== currentIndex) {
      e.preventDefault();
      tabs[newIndex].focus();
      tabs[newIndex].click();
    }
  });
}

// Toast 消息函数
function showSuccess(message) {
  createToast(message, 'success');
}

function showError(message) {
  createToast(message, 'error');
}

function showInfo(message) {
  createToast(message, 'loading');
}

// UI 模块
window.__APP.ui = {
  showToast: createToast,
  showSuccess,
  showError,
  showInfo
};

// 导出事件模块
window.__APP.events = {
  initSidebarEvents,
  initTabEvents,
  initSegmentEvents,
  initLikeEvents,
  initAddRemoveEvents,
  initRestoreEvents,
  initClearEvents,
  initThemeEvents,
  initShareEvents,
  initKeyboardNavigation,
  
  // 初始化所有事件
  init() {
    addToastAnimations();
    this.initSidebarEvents();
    this.initTabEvents();
    this.initSegmentEvents();
    this.initLikeEvents();
    this.initAddRemoveEvents();
    this.initRestoreEvents();
    this.initClearEvents();
    this.initThemeEvents();
    this.initShareEvents();
    this.initKeyboardNavigation();
  }
};