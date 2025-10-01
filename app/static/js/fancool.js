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

/* === F-01~F-03 Local State Integration Start === */
const {
  selectionStore,
  removedStore
} = (window.__APP.localStores || {});

function fanKey(model_id, condition_id){
  return `${model_id}_${condition_id}`;
}

// 保存上一次服务器返回的完整 fan 对象列表（包含 meta）
let lastSelectedFans = [];
/* === F-01~F-03 Local State Integration End === */
