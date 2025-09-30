/* color.js (Phase 1 占位)
 * 未来迁移：palette / theme / colorIndexMap / ensureColorIndexForKey / withFrontColors 等。
 * 当前仍由 core.js 提供真实实现，这里只做命名空间占位，避免引用出错。
 */
(function initColorModule(){
  window.__APP = window.__APP || {};
  if (!window.__APP.color) {
    window.__APP.color = {
      // 占位：后面迁移时会替换
      getColorForKey(key){
        if (typeof window.colorForKey === 'function') return window.colorForKey(key);
        return '#999';
      }
    };
  }
})();