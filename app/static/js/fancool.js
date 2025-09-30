/* fancool.js (兼容层 Stub - Phase 1)
 * 原始逻辑已搬到 core.js。
 * 若老部署仍只引这一个脚本，会缺功能；需改为加载 core.js 等新文件。
 */
(function(){
  console.info('[Fancool] 已拆分为多个模块：core.js / color.js / chart.js / layout.js / state-ui.js / main.js');
  if (!window.__APP) {
    console.warn('[Fancool] 警告：core.js 似乎未加载，功能可能不可用。');
  }
})();