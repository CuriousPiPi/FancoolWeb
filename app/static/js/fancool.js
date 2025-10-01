/* fancool.js (Compatibility Stub)
 * 对旧部署的提示：请确保已按顺序加载：
 * core.js -> color.js -> chart.js -> layout.js -> state-ui.js -> main.js
 */
(function(){
  if (!window.__APP){
    console.warn('[Fancool] __APP 未定义，说明 core.js 尚未加载。');
    return;
  }
  console.info('[Fancool] 兼容层已加载。模块化拆分已完成。');
  // 旧全局别名（如历史脚本直接调用）
  if (!window.processState && window.__APP.stateUI){
    window.processState = window.__APP.stateUI.processState;
  }
})();