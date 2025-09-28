/* ========== 点赞系统模块 ========== */

let likesTabLoaded = false;
let likesTabLastLoad = 0;
const LIKES_TTL = 120000; // 2分钟
let _rtPending = false;
let _rtDebounce = null;

function needReloadLikes() {
  if (!likesTabLoaded) return true;
  return (Date.now() - likesTabLastLoad) > LIKES_TTL;
}

// 重新加载排行榜
function reloadTopRatings(debounce = true) {
  if (debounce) {
    if (_rtDebounce) clearTimeout(_rtDebounce);
    _rtDebounce = setTimeout(() => reloadTopRatings(false), 300);
    return;
  }
  
  if (_rtPending) return;
  _rtPending = true;
  
  window.__APP.api.getTopRatings()
    .then(data => {
      if (data.success) {
        renderTopRatings(data.top_ratings);
        likesTabLoaded = true;
        likesTabLastLoad = Date.now();
      } else {
        console.error('获取排行榜失败:', data.error);
      }
    })
    .catch(error => {
      console.error('获取排行榜出错:', error);
    })
    .finally(() => {
      _rtPending = false;
    });
}

// 渲染排行榜
function renderTopRatings(ratings) {
  const container = window.__APP.dom.one('#topRatingsContent');
  if (!container) return;

  if (!ratings || ratings.length === 0) {
    container.innerHTML = '<div class="text-gray-500 text-sm text-center py-8">暂无数据</div>';
    return;
  }

  const html = ratings.map((item, index) => {
    const rank = index + 1;
    const rankClass = rank <= 3 ? `rank-${rank}` : '';
    
    return `
      <tr>
        <td class="rank-cell ${rankClass}">${rank}</td>
        <td class="model-cell">
          <div class="model-info">
            <div class="model-name">${escapeHtml(item.brand)} ${escapeHtml(item.model)}</div>
            <div class="model-scenario">${escapeHtml(item.res_type)}${item.res_loc ? `(${escapeHtml(item.res_loc)})` : ''}</div>
          </div>
        </td>
        <td class="likes-cell">
          <div class="likes-count">
            <i class="fa-solid fa-thumbs-up"></i>
            ${item.likes_count}
          </div>
        </td>
        <td class="actions-cell">
          <button class="like-button" 
                  data-model-id="${item.model_id}"
                  data-condition-id="${item.condition_id}"
                  aria-label="点赞">
            <i class="fa-solid fa-thumbs-up text-gray-400"></i>
          </button>
          ${buildQuickBtnHTML('ratings', item.brand, item.model, item.res_type, item.res_loc)}
        </td>
      </tr>
    `;
  }).join('');

  container.innerHTML = html;
}

// 加载最近点赞
function loadRecentLikes() {
  window.__APP.api.getRecentLikes()
    .then(data => {
      if (data.success) {
        renderRecentLikes(data.recent_likes);
      } else {
        console.error('获取最近点赞失败:', data.error);
      }
    })
    .catch(error => {
      console.error('获取最近点赞出错:', error);
    });
}

// 渲染最近点赞
function renderRecentLikes(likes) {
  const container = window.__APP.dom.one('#recentLikesList');
  if (!container) return;

  if (!likes || likes.length === 0) {
    container.innerHTML = '<div class="text-gray-500 text-sm text-center py-8">暂无最近点赞</div>';
    return;
  }

  // 按品牌和型号分组
  const groups = {};
  likes.forEach(like => {
    const key = `${like.brand}||${like.model}`;
    if (!groups[key]) {
      groups[key] = {
        brand: like.brand,
        model: like.model,
        maxSpeed: like.max_speed,
        size: like.size,
        thickness: like.thickness,
        scenarios: []
      };
    }
    groups[key].scenarios.push({
      rt: like.res_type,
      rl: like.res_loc,
      mid: like.model_id,
      cid: like.condition_id
    });
  });

  const html = Object.values(groups).map(group => {
    const metaParts = [];
    if (group.maxSpeed) metaParts.push(`${escapeHtml(group.maxSpeed)} RPM`);
    if (group.size && group.thickness) metaParts.push(`${escapeHtml(group.size)}x${escapeHtml(group.thickness)}`);
    const metaRight = metaParts.join(' · ');

    const scenariosHtml = group.scenarios.map(s => {
      const scenText = s.rl ? `${escapeHtml(s.rt)} ${escapeHtml(s.rl)}` : `${escapeHtml(s.rt)}`;
      return `
        <div class="flex items-center justify-between scenario-row">
          <div class="scenario-text text-sm text-gray-700">${scenText}</div>
          <div class="actions">
            <button class="like-button recent-like-button" title="取消点赞"
                    data-model-id="${escapeHtml(s.mid || '')}"
                    data-condition-id="${escapeHtml(s.cid || '')}"
                    aria-label="取消点赞">
              <i class="fa-solid fa-thumbs-up text-red-500"></i>
            </button>
            ${buildQuickBtnHTML('likes', group.brand, group.model, s.rt, s.rl)}
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="recent-like-group mb-4 p-3 border border-gray-200 rounded-md">
        <div class="group-header flex items-center justify-between mb-2">
          <div class="group-title">
            <span class="font-medium">${escapeHtml(group.brand)} ${escapeHtml(group.model)}</span>
          </div>
          ${metaRight ? `<div class="group-meta text-xs text-gray-500">${metaRight}</div>` : ''}
        </div>
        <div class="scenarios-list space-y-2">
          ${scenariosHtml}
        </div>
      </div>
    `;
  }).join('');

  container.innerHTML = html;
  applyRecentLikesTitleMask();
}

// 处理点赞按钮点击
async function handleLikeClick(button) {
  const modelId = button.dataset.modelId;
  const conditionId = button.dataset.conditionId;
  
  if (!modelId || !conditionId) {
    showError('缺少必要参数');
    return;
  }

  const icon = button.querySelector('i');
  const isLiked = icon.classList.contains('text-red-500');

  try {
    const data = isLiked 
      ? await window.__APP.api.unlike(modelId, conditionId)
      : await window.__APP.api.like(modelId, conditionId);

    if (data.success) {
      // 更新按钮状态
      if (isLiked) {
        icon.classList.remove('text-red-500');
        icon.classList.add('text-gray-400');
        button.setAttribute('title', '点赞');
        button.setAttribute('aria-label', '点赞');
      } else {
        icon.classList.remove('text-gray-400');
        icon.classList.add('text-red-500');
        button.setAttribute('title', '取消点赞');
        button.setAttribute('aria-label', '取消点赞');
      }

      showSuccess(isLiked ? '已取消点赞' : '已点赞');
      
      // 如果需要重新加载排行榜
      if (needReloadLikes()) {
        reloadTopRatings();
      }
    } else {
      showError(data.error || '操作失败');
    }
  } catch (error) {
    console.error('点赞操作失败:', error);
    showError('操作失败，请稍后重试');
  }
}

// 构建快速添加按钮HTML
function buildQuickBtnHTML(source, brand, model, resType, resLoc) {
  const key = `${brand}||${model}||${resType}||${resLoc || '无'}`;
  const isSelected = window.__APP.state.isSelected(key);
  
  if (isSelected) {
    return `<button class="btn-add" data-mode="remove" data-fan-key="${key}" title="从图表移除" aria-label="移除">
      <i class="fa-solid fa-times"></i>
    </button>`;
  } else {
    return `<button class="btn-add" data-mode="add" data-brand="${escapeHtml(brand)}" 
             data-model="${escapeHtml(model)}" data-res-type="${escapeHtml(resType)}" 
             data-res-loc="${escapeHtml(resLoc || '')}" title="添加到图表" aria-label="添加">
      <i class="fa-solid fa-plus"></i>
    </button>`;
  }
}

// 应用标题遮罩效果
function applyRecentLikesTitleMask() {
  const groups = document.querySelectorAll('#recentLikesList .recent-like-group');
  groups.forEach(group => {
    const title = group.querySelector('.group-title');
    if (title) {
      const span = title.querySelector('span');
      if (span && span.scrollWidth > span.offsetWidth) {
        title.classList.add('title-overflow');
      } else {
        title.classList.remove('title-overflow');
      }
    }
  });
}

// 检查是否需要加载点赞数据
function loadLikesIfNeeded() {
  if (needReloadLikes()) {
    reloadTopRatings();
  }
}

// HTML 转义
function escapeHtml(text) {
  if (typeof text !== 'string') return text;
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Toast 消息
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

// 导出点赞模块
window.__APP.likes = {
  reloadTopRatings,
  loadRecentLikes,
  handleLikeClick,
  buildQuickBtnHTML,
  loadLikesIfNeeded,
  applyRecentLikesTitleMask,
  needReloadLikes
};