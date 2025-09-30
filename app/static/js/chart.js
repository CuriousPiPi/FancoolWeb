/* chart.js (Phase 1 占位)
 * 未来迁移：postChartData / resizeChart / filterChartDataForAxis / X轴类型持久化。
 */
(function initChartModule(){
  window.__APP = window.__APP || {};
  if (!window.__APP.chart) {
    window.__APP.chart = {
      postChartData(data){
        if (typeof window.postChartData === 'function') return window.postChartData(data);
      },
      resizeChart(){
        if (typeof window.resizeChart === 'function') return window.resizeChart();
      }
    };
  }
})();