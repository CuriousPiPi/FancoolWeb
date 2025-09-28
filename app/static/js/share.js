/* ========== 分享功能模块 ========== */

// 创建分享链接
async function createShare() {
  const selectedKeys = window.__APP.state.getSelectedKeys();
  
  if (selectedKeys.length === 0) {
    showError('请先选择要分享的数据');
    return;
  }

  try {
    showInfo('正在生成分享链接...');
    
    const data = await window.__APP.api.createShare(selectedKeys);
    
    if (data.success && data.share_url) {
      // 复制到剪贴板
      await copyToClipboard(data.share_url);
      showSuccess('分享链接已复制到剪贴板');
      
      // 显示分享链接
      showShareDialog(data.share_url);
    } else {
      showError(data.error || '生成分享链接失败');
    }
  } catch (error) {
    console.error('创建分享失败:', error);
    showError('网络错误，请稍后重试');
  }
}

// 复制到剪贴板
async function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      console.warn('Clipboard API failed, using fallback:', err);
    }
  }
  
  // 降级方案
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.style.position = 'fixed';
  textArea.style.left = '-9999px';
  textArea.style.top = '-9999px';
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  
  try {
    document.execCommand('copy');
    return true;
  } catch (err) {
    console.error('Fallback copy failed:', err);
    return false;
  } finally {
    document.body.removeChild(textArea);
  }
}

// 显示分享对话框
function showShareDialog(shareUrl) {
  // 检查是否已有分享对话框
  let dialog = document.getElementById('share-dialog');
  
  if (!dialog) {
    dialog = createShareDialog();
    document.body.appendChild(dialog);
  }
  
  // 更新分享链接
  const urlInput = dialog.querySelector('#share-url-input');
  if (urlInput) {
    urlInput.value = shareUrl;
  }
  
  // 显示对话框
  dialog.classList.remove('hidden');
  dialog.classList.add('flex');
  
  // 自动选择链接文本
  if (urlInput) {
    urlInput.select();
  }
}

// 创建分享对话框
function createShareDialog() {
  const dialog = document.createElement('div');
  dialog.id = 'share-dialog';
  dialog.className = 'fixed inset-0 bg-black bg-opacity-50 z-50 hidden items-center justify-center p-4';
  
  dialog.innerHTML = `
    <div class="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-lg font-semibold text-gray-900">分享链接</h3>
        <button id="share-dialog-close" class="text-gray-400 hover:text-gray-600" aria-label="关闭">
          <i class="fa-solid fa-times text-xl"></i>
        </button>
      </div>
      
      <div class="mb-4">
        <p class="text-sm text-gray-600 mb-2">分享链接已生成，点击复制：</p>
        <div class="relative">
          <input id="share-url-input" 
                 type="text" 
                 readonly 
                 class="w-full p-3 pr-12 border border-gray-300 rounded-lg text-sm font-mono bg-gray-50 share-fail-url"
                 placeholder="生成中...">
          <button id="copy-share-url" 
                  class="absolute right-2 top-1/2 transform -translate-y-1/2 p-2 text-gray-500 hover:text-gray-700"
                  title="复制链接"
                  aria-label="复制链接">
            <i class="fa-solid fa-copy"></i>
          </button>
        </div>
      </div>
      
      <div class="flex justify-end space-x-2">
        <button id="share-dialog-cancel" class="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">
          关闭
        </button>
        <button id="open-share-url" class="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700">
          打开链接
        </button>
      </div>
    </div>
  `;
  
  // 绑定事件
  const closeBtn = dialog.querySelector('#share-dialog-close');
  const cancelBtn = dialog.querySelector('#share-dialog-cancel');
  const copyBtn = dialog.querySelector('#copy-share-url');
  const openBtn = dialog.querySelector('#open-share-url');
  const urlInput = dialog.querySelector('#share-url-input');
  
  const closeDialog = () => {
    dialog.classList.add('hidden');
    dialog.classList.remove('flex');
  };
  
  closeBtn.addEventListener('click', closeDialog);
  cancelBtn.addEventListener('click', closeDialog);
  
  // 点击背景关闭
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) {
      closeDialog();
    }
  });
  
  // ESC 键关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !dialog.classList.contains('hidden')) {
      closeDialog();
    }
  });
  
  // 复制按钮
  copyBtn.addEventListener('click', async () => {
    const url = urlInput.value;
    if (url && await copyToClipboard(url)) {
      showSuccess('已复制到剪贴板');
    } else {
      showError('复制失败');
    }
  });
  
  // 打开链接按钮
  openBtn.addEventListener('click', () => {
    const url = urlInput.value;
    if (url) {
      window.open(url, '_blank');
    }
  });
  
  // 输入框点击选择全部
  urlInput.addEventListener('click', () => {
    urlInput.select();
  });
  
  return dialog;
}

// Toast 消息函数
function showSuccess(message) {
  if (window.__APP.ui && window.__APP.ui.showToast) {
    window.__APP.ui.showToast(message, 'success');
  } else {
    console.log('SUCCESS:', message);
  }
}

function showError(message) {
  if (window.__APP.ui && window.__APP.ui.showToast) {
    window.__APP.ui.showToast(message, 'error');
  } else {
    console.error('ERROR:', message);
  }
}

function showInfo(message) {
  if (window.__APP.ui && window.__APP.ui.showToast) {
    window.__APP.ui.showToast(message, 'loading');
  } else {
    console.log('INFO:', message);
  }
}

// 导出分享模块
window.__APP.share = {
  createShare,
  copyToClipboard,
  showShareDialog
};