/* ========== API 通信模块 ========== */

// 全局命名空间
window.__APP = window.__APP || {};

// POST 助手
async function apiPost(url, payload) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  return resp.json();
}

// API 模块
window.__APP.api = {
  // 状态管理
  async getState() {
    const response = await fetch('/api/state');
    return response.json();
  },

  async addFan(brand, model, res_type, res_loc) {
    return apiPost('/api/add_fan', { brand, model, res_type, res_loc });
  },

  async removeFan(fan_key) {
    return apiPost('/api/remove_fan', { fan_key });
  },

  async restoreFan(fan_key) {
    return apiPost('/api/restore_fan', { fan_key });
  },

  async clearAll() {
    return apiPost('/api/clear_all', {});
  },

  // 搜索
  async searchFans(payload) {
    return apiPost('/api/search_fans', payload);
  },

  async searchModels(brand) {
    return apiPost('/search_models', { brand });
  },

  async getModels(brand) {
    return apiPost('/get_models', { brand });
  },

  async getResistanceTypes(brand, model) {
    return apiPost('/get_resistance_types', { brand, model });
  },

  async getResistanceLocations(brand, model, res_type) {
    return apiPost('/get_resistance_locations', { brand, model, res_type });
  },

  async getResistanceLocationsByType(res_type) {
    return apiPost('/get_resistance_locations_by_type', { res_type });
  },

  // 点赞系统
  async like(model_id, condition_id) {
    return apiPost('/api/like', { model_id, condition_id });
  },

  async unlike(model_id, condition_id) {
    return apiPost('/api/unlike', { model_id, condition_id });
  },

  async getRecentLikes() {
    const response = await fetch('/api/recent_likes');
    return response.json();
  },

  async getTopRatings() {
    const response = await fetch('/api/top_ratings');
    return response.json();
  },

  // 分享
  async createShare(selected_keys) {
    return apiPost('/api/create_share', { selected_keys });
  },

  // 主题
  async getTheme() {
    const response = await fetch('/api/theme');
    return response.json();
  },

  async setTheme(theme) {
    return apiPost('/api/theme', { theme });
  },

  // 查询计数
  async getQueryCount() {
    const response = await fetch('/api/query_count');
    return response.json();
  },

  // 配置
  async getConfig() {
    const response = await fetch('/api/config');
    return response.json();
  }
};

// DOM 缓存与工具
(function initDomCache() {
  const cache = Object.create(null);
  function one(sel, scope) {
    if (!sel) return null;
    if (!scope && cache[sel]) return cache[sel];
    const el = (scope || document).querySelector(sel);
    if (!scope) cache[sel] = el;
    return el;
  }
  function all(sel, scope) {
    return Array.from((scope || document).querySelectorAll(sel));
  }
  function clear(sel) { if (sel) delete cache[sel]; else Object.keys(cache).forEach(k => delete cache[k]); }
  window.__APP.dom = { one, all, clear };
})();

// 帧写入调度器（低频批量写入）
window.__APP.scheduler = (function () {
  const writeQueue = [];
  let scheduled = false;
  function flush() {
    scheduled = false;
    for (let i = 0; i < writeQueue.length; i++) {
      try { writeQueue[i](); } catch (e) { console.error('[scheduler write error]', e); }
    }
    writeQueue.length = 0;
  }
  function write(fn) {
    writeQueue.push(fn);
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(flush);
    }
  }
  return { write };
})();

// 通用缓存 (内存+TTL)
window.__APP.cache = (function () {
  const store = new Map();
  const DEFAULT_TTL = 180000; // 3 分钟
  function key(ns, payload) {
    return ns + '::' + JSON.stringify(payload || {});
  }
  function get(ns, payload) {
    const k = key(ns, payload);
    const entry = store.get(k);
    if (!entry) return null;
    if (Date.now() > entry.expire) {
      store.delete(k);
      return null;
    }
    return entry.data;
  }
  function set(ns, payload, data, ttl) {
    const k = key(ns, payload);
    store.set(k, {
      data,
      expire: Date.now() + (ttl || DEFAULT_TTL)
    });
  }
  function clear(ns) {
    if (ns) {
      for (const [k] of store) {
        if (k.startsWith(ns + '::')) store.delete(k);
      }
    } else {
      store.clear();
    }
  }
  return { get, set, clear };
})();