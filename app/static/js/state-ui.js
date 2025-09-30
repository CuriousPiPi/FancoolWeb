/* state-ui.js (Phase 1 占位)
 * 未来迁移：processState、rebuildSelectedFans、rebuildRemovedFans、recent likes、search、ranking、like/unlike 逻辑等。
 */
(function initStateUIModule(){
  window.__APP = window.__APP || {};
  if (!window.__APP.stateUI) {
    window.__APP.stateUI = {
      processState(data,msg){
        if (typeof window.processState === 'function') return window.processState(data,msg);
      }
    };
  }
})();