/* localStores.js
 * Local state management for selection, removed items, share meta, colors, and likes
 * IIFE pattern, attaches to window.__APP.localStores
 * No ES module imports - pure browser compatibility
 */

(function initLocalStores(){
  'use strict';
  
  if (!window.__APP) window.__APP = {};
  if (window.__APP.localStores) {
    console.warn('[LocalStores] Already initialized, skipping.');
    return;
  }

  /* ========================================================
   * Helper: Generate consistent key for model_id + condition_id
   * ====================================================== */
  function makeKey(model_id, condition_id) {
    return `${model_id}_${condition_id}`;
  }

  /* ========================================================
   * Selection Store
   * Manages currently selected fans
   * Storage key: fc_selected_v1
   * Format: [{model_id, condition_id, meta?}]
   * ====================================================== */
  const SELECTION_KEY = 'fc_selected_v1';
  const selectionStore = (function(){
    let items = [];
    let changeListeners = [];

    function load() {
      try {
        const raw = localStorage.getItem(SELECTION_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            items = parsed;
          }
        }
      } catch(e) {
        console.error('[selectionStore] Failed to load:', e);
        items = [];
      }
      return items;
    }

    function save() {
      try {
        localStorage.setItem(SELECTION_KEY, JSON.stringify(items));
      } catch(e) {
        console.error('[selectionStore] Failed to save:', e);
      }
    }

    function notifyChange() {
      changeListeners.forEach(fn => {
        try { fn(items.slice()); } catch(e) { console.error('[selectionStore] Listener error:', e); }
      });
    }

    function list() {
      return items.slice();
    }

    function has(model_id, condition_id) {
      const key = makeKey(model_id, condition_id);
      return items.some(item => makeKey(item.model_id, item.condition_id) === key);
    }

    function add(entry) {
      if (!entry || !entry.model_id || !entry.condition_id) {
        console.warn('[selectionStore] Invalid entry:', entry);
        return false;
      }
      
      const key = makeKey(entry.model_id, entry.condition_id);
      if (has(entry.model_id, entry.condition_id)) {
        return false; // Already exists
      }

      items.push({
        model_id: entry.model_id,
        condition_id: entry.condition_id,
        meta: entry.meta || null
      });
      save();
      notifyChange();
      return true;
    }

    function remove(model_id, condition_id) {
      const key = makeKey(model_id, condition_id);
      const initialLength = items.length;
      items = items.filter(item => makeKey(item.model_id, item.condition_id) !== key);
      
      if (items.length !== initialLength) {
        save();
        notifyChange();
        return true;
      }
      return false;
    }

    function replace(newList) {
      if (!Array.isArray(newList)) {
        console.warn('[selectionStore] replace() requires array');
        return;
      }
      items = newList.map(entry => ({
        model_id: entry.model_id,
        condition_id: entry.condition_id,
        meta: entry.meta || null
      }));
      save();
      notifyChange();
    }

    function clear() {
      items = [];
      save();
      notifyChange();
    }

    function onChange(callback) {
      if (typeof callback === 'function') {
        changeListeners.push(callback);
      }
    }

    // Initialize
    load();

    return { list, has, add, remove, replace, clear, onChange, load, save };
  })();

  /* ========================================================
   * Removed Store
   * Manages recently removed fans (circular buffer, MAX=30)
   * Storage key: fc_removed_v1
   * Format: [{key, model_id, condition_id, brand, model, res_type, res_loc, removed_at}]
   * ====================================================== */
  const REMOVED_KEY = 'fc_removed_v1';
  const MAX_REMOVED = 30;
  const removedStore = (function(){
    let items = [];
    let changeListeners = [];

    function load() {
      try {
        const raw = localStorage.getItem(REMOVED_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            items = parsed;
          }
        }
      } catch(e) {
        console.error('[removedStore] Failed to load:', e);
        items = [];
      }
      return items;
    }

    function save() {
      try {
        localStorage.setItem(REMOVED_KEY, JSON.stringify(items));
      } catch(e) {
        console.error('[removedStore] Failed to save:', e);
      }
    }

    function notifyChange() {
      changeListeners.forEach(fn => {
        try { fn(items.slice()); } catch(e) { console.error('[removedStore] Listener error:', e); }
      });
    }

    function push(entry) {
      if (!entry || !entry.key) {
        console.warn('[removedStore] Invalid entry, missing key:', entry);
        return;
      }

      // Remove existing entry with same key if exists
      items = items.filter(item => item.key !== entry.key);

      // Add to beginning
      items.unshift({
        key: entry.key,
        model_id: entry.model_id,
        condition_id: entry.condition_id,
        brand: entry.brand || '',
        model: entry.model || '',
        res_type: entry.res_type || '',
        res_loc: entry.res_loc || '',
        removed_at: entry.removed_at || new Date().toISOString()
      });

      // Trim to MAX
      if (items.length > MAX_REMOVED) {
        items = items.slice(0, MAX_REMOVED);
      }

      save();
      notifyChange();
    }

    function removeByKey(key) {
      const initialLength = items.length;
      items = items.filter(item => item.key !== key);
      
      if (items.length !== initialLength) {
        save();
        notifyChange();
        return true;
      }
      return false;
    }

    function list() {
      return items.slice();
    }

    function onChange(callback) {
      if (typeof callback === 'function') {
        changeListeners.push(callback);
      }
    }

    // Initialize
    load();

    return { push, removeByKey, list, onChange, load, save };
  })();

  /* ========================================================
   * Share Meta Store (skeleton for future)
   * Storage key: fc_share_meta_v1
   * Format: {show_raw_curves, show_fit_curves, pointer_x_rpm, pointer_x_noise_db, etc.}
   * ====================================================== */
  const SHARE_META_KEY = 'fc_share_meta_v1';
  const shareMetaStore = (function(){
    let data = {};
    let changeListeners = [];

    function load() {
      try {
        const raw = localStorage.getItem(SHARE_META_KEY);
        if (raw) {
          data = JSON.parse(raw);
        }
      } catch(e) {
        console.error('[shareMetaStore] Failed to load:', e);
        data = {};
      }
      return data;
    }

    function saveData() {
      try {
        localStorage.setItem(SHARE_META_KEY, JSON.stringify(data));
      } catch(e) {
        console.error('[shareMetaStore] Failed to save:', e);
      }
    }

    function notifyChange() {
      changeListeners.forEach(fn => {
        try { fn(Object.assign({}, data)); } catch(e) { console.error('[shareMetaStore] Listener error:', e); }
      });
    }

    function get() {
      return Object.assign({}, data);
    }

    function save(partial) {
      if (typeof partial === 'object' && partial !== null) {
        Object.assign(data, partial);
        saveData();
        notifyChange();
      }
    }

    function onChange(callback) {
      if (typeof callback === 'function') {
        changeListeners.push(callback);
      }
    }

    // Initialize
    load();

    return { get, save, onChange, load };
  })();

  /* ========================================================
   * Like Store (in-memory only for now)
   * Format: Set of keys (model_id_condition_id)
   * ====================================================== */
  const likeStore = (function(){
    let keys = new Set();

    function set(keysArray) {
      if (Array.isArray(keysArray)) {
        keys = new Set(keysArray);
      }
    }

    function has(key) {
      return keys.has(key);
    }

    function add(key) {
      keys.add(key);
    }

    function remove(key) {
      return keys.delete(key);
    }

    function list() {
      return Array.from(keys);
    }

    return { set, has, add, remove, list };
  })();

  /* ========================================================
   * Color Store (skeleton)
   * Simple incremental index assignment persisted in localStorage
   * Storage key: fc_color_map_v1
   * Format: { "mid_cid": colorIndex, ... }
   * ====================================================== */
  const COLOR_MAP_KEY = 'fc_color_map_v1';
  const colorStore = (function(){
    let colorMap = {};
    let nextIndex = 0;

    function load() {
      try {
        const raw = localStorage.getItem(COLOR_MAP_KEY);
        if (raw) {
          colorMap = JSON.parse(raw);
          // Find max index to continue from there
          const indices = Object.values(colorMap).filter(v => typeof v === 'number');
          if (indices.length > 0) {
            nextIndex = Math.max(...indices) + 1;
          }
        }
      } catch(e) {
        console.error('[colorStore] Failed to load:', e);
        colorMap = {};
        nextIndex = 0;
      }
    }

    function save() {
      try {
        localStorage.setItem(COLOR_MAP_KEY, JSON.stringify(colorMap));
      } catch(e) {
        console.error('[colorStore] Failed to save:', e);
      }
    }

    function getIndex(key) {
      return colorMap[key];
    }

    function ensure(keysArray) {
      if (!Array.isArray(keysArray)) return;
      
      let changed = false;
      keysArray.forEach(key => {
        if (!(key in colorMap)) {
          colorMap[key] = nextIndex++;
          changed = true;
        }
      });

      if (changed) {
        save();
      }
    }

    function clear() {
      colorMap = {};
      nextIndex = 0;
      save();
    }

    // Initialize
    load();

    return { getIndex, ensure, clear, load, save };
  })();

  /* ========================================================
   * Export all stores
   * ====================================================== */
  window.__APP.localStores = {
    makeKey,
    selectionStore,
    removedStore,
    shareMetaStore,
    likeStore,
    colorStore
  };

  console.info('[LocalStores] Initialized successfully.');
})();
