/* layout.js (Phase 1 占位)
 * 未来迁移：侧栏 overlay / 手势关闭 / splitter / resizer / tabs / marquee / tooltip / focusTrap / scheduleAdjust。
 */
(function initLayoutModule(){
  window.__APP = window.__APP || {};
  if (!window.__APP.layout) {
    window.__APP.layout = {
      toggleSidebar(){
        if (typeof window.overlayToggleSidebar === 'function') return window.overlayToggleSidebar();
      },
      scheduleAdjust(){
        if (typeof window.scheduleAdjust === 'function') return window.scheduleAdjust();
      }
    };
  }
})();