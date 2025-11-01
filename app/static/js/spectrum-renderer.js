(function(){
  // 频谱渲染器（主图驱动版）：
  // - 不再内建 dB->RPM 反推、LUT、导轨/滑块/模式开关/第二轴
  // - 仅根据“主图算出的 RPM”渲染频谱；主图需通过 API.setRPM(rpm) 或在 render(payload.chartData.rpm) 传入
  // - 仍支持多系列频谱叠画、legend、主题与自适应布局

  const API = { mount, render, resize, setTheme, setRPM };
  let root = null, chart = null;

  // 数据与状态
  let modelsByKey = {};     // key -> { model, name, color, brand?, modelName?, condition? }
  let dynRpm = null;        // 当前 RPM（由主图驱动）
  let lastOption = null;

  // 主题
  const tokensOf = (theme) => (window.RendererBase && RendererBase.utils.tokens(theme || window.ThemePref?.resolve?.() || 'light'))
    || {
      fontFamily:'system-ui,-apple-system,"Segoe UI","Helvetica Neue","Microsoft YaHei",Arial,sans-serif',
      axisLabel:'#4b5563', axisName:'#6b7280', axisLine:'#e5e7eb',
      gridLine:'rgba(0,0,0,0.08)', tooltipBg:'rgba(255,255,255,0.98)',
      tooltipBorder:'#e5e7eb', tooltipText:'#1f2937', tooltipShadow:'0 6px 20px rgba(0,0,0,0.12)',
      pagerIcon:'#2563eb'
    };
  const currentTheme = () => (window.ThemePref?.resolve?.() || document.documentElement.getAttribute('data-theme') || 'light');

  // ---------- PCHIP ----------
  function evalPchip(m, x) {
    if (!m || !Array.isArray(m.x) || !Array.isArray(m.y) || !Array.isArray(m.m)) return NaN;
    const xs=m.x, ys=m.y, ms=m.m, n=xs.length;
    if (!n) return NaN;
    if (n===1) return ys[0];
    let xv=x; if (xv<=xs[0]) xv=xs[0]; if (xv>=xs[n-1]) xv=xs[n-1];
    let lo=0, hi=n-2, i=0;
    while (lo<=hi){ const mid=(lo+hi)>>1; if (xs[mid]<=xv && xv<=xs[mid+1]){ i=mid; break; } if (xv<xs[mid]) hi=mid-1; else lo=mid+1; }
    if (lo>hi) i=Math.max(0, Math.min(n-2, lo));
    const x0=xs[i], x1=xs[i+1], h=(x1-x0)||1, t=(xv-x0)/h;
    const y0=ys[i], y1=ys[i+1], m0=(ms[i]||0)*h, m1=(ms[i+1]||0)*h;
    const h00=2*t*t*t-3*t*t+1, h10=t*t*t-2*t*t+t, h01=-2*t*t*t+3*t*t, h11=t*t*t-t*t;
    return h00*y0 + h10*m0 + h01*y1 + h11*m1;
  }

  function spectrumAtRPMRaw(model, rpm) {
    const freqs = model?.centers_hz || [];
    const bands = model?.band_models_pchip || [];
    const ys = new Array(freqs.length);
    for (let i=0;i<freqs.length;i++){
      const p = bands[i];
      ys[i] = (p && p.x && p.y && p.m) ? evalPchip(p, rpm) : NaN;
    }
    return { freq_hz: freqs, mag_db: ys };
  }

  function applyAnchorMask(model, rpm, spec, tol=0.5){
    const prs = model?.anchor_presence || {};
    const keys = Object.keys(prs); if (!keys.length) return spec;
    let hit=null, minAbs=Infinity;
    for (const k of keys){ const r=Number(k); if (!Number.isFinite(r)) continue; const d=Math.abs(rpm-r); if (d<minAbs){ minAbs=d; hit=k; } }
    if (hit==null || minAbs>tol) return spec;
    const mask = prs[hit]; if (!Array.isArray(mask)||!mask.length) return spec;
    const ys = spec.mag_db.slice();
    for (let i=0;i<ys.length;i++) if (mask[i]===0) ys[i]=NaN;
    return { freq_hz: spec.freq_hz, mag_db: ys };
  }

  function calcAllSeries(mbk, rpm){
    const out=[];
    for (const [key, meta] of Object.entries(mbk||{})){
      const model=meta?.model; if (!model) continue;
      const spec = applyAnchorMask(model, rpm, spectrumAtRPMRaw(model, rpm), 0.5);
      const xs=spec.freq_hz||[], ys=spec.mag_db||[];
      const data=[]; const n=Math.min(xs.length, ys.length);
      for (let i=0;i<n;i++){
        const x=Number(xs[i]), y=Number(ys[i]);
        if (Number.isFinite(x) && x>0 && Number.isFinite(y)) data.push([x, Math.max(0,y)]);
      }
      if (data.length){
        out.push({
          __key: key,
          name: meta?.name || key,
          color: meta?.color,
          data,
          __legend: { brand: meta?.brand||'', model: meta?.modelName||'', condition: meta?.condition||'' }
        });
      }
    }
    return { series: out };
  }

  function mergeRpmBounds(mbk){
    let rmin=+Infinity, rmax=-Infinity, rpeak=null;
    for (const [, meta] of Object.entries(mbk||{})){
      const m=meta?.model; if (!m) continue;
      const mn=Number(m.rpm_min ?? m.calibration?.calib_model?.x0);
      const mx=Number(m.rpm_max ?? m.calibration?.calib_model?.x1);
      if (Number.isFinite(mn)) rmin=Math.min(rmin,mn);
      if (Number.isFinite(mx)) rmax=Math.max(rmax,mx);
      if (rpeak==null && Number.isFinite(m?.calibration?.rpm_peak)) rpeak=m.calibration.rpm_peak;
    }
    if (rmin===+Infinity) rmin=1500;
    if (rmax===-Infinity) rmax=4500;
    return { rpmMin:rmin, rpmMax:rmax, rpmInit: rpeak ?? Math.round((rmin+rmax)/2) };
  }

  function computeYMaxFromModels(mbk){
    let gmax=0;
    for (const [, meta] of Object.entries(mbk||{})){
      const bands = meta?.model?.band_models_pchip || [];
      for (const p of bands) if (p && Array.isArray(p.y)) for (const v of p.y){ const n=Number(v); if (Number.isFinite(n)) gmax=Math.max(gmax,n); }
    }
    return Math.max(0, Math.ceil(gmax));
  }

  // ---------- 布局/legend ----------
  const layoutIsNarrow = () => {
    const w = (root?.getBoundingClientRect?.().width|0) || (chart?.getWidth?.()||0);
    return w>0 ? (w<800) : false;
  };
  const measureText = (text,size,weight,family)=> (window.RendererBase && RendererBase.utils.measureText(text,size,weight,family)) || { width: 0, height: Number(size||14) };

  function buildLegendAndGrid(series, t, titleText){
    const isN = layoutIsNarrow();
    const titleSize=18, titleWeight=600, titleTop=10;
    const mt = measureText(titleText, titleSize, titleWeight, t.fontFamily);
    const gridTop = Math.max(54, titleTop + Math.ceil(mt.height) + 12);

    // legend 宽度估算（桌面）
    let legendItemTextMaxW = 0;
    if (!isN){
      const l1Size=13,l1Weight=600, l2Size=11,l2Weight=500;
      const canvas=document.createElement('canvas'); const ctx=canvas.getContext('2d');
      const l1Font=`${l1Weight} ${l1Size}px ${t.fontFamily}`;
      const l2Font=`${l2Weight} ${l2Size}px ${t.fontFamily}`;
      series.forEach(s=>{
        const b=(s.__legend?.brand||''), m=(s.__legend?.model||''), c=(s.__legend?.condition||'');
        const line1=[b,m].filter(Boolean).join(' ') || s.name;
        const line2=c||'';
        ctx.font=l1Font; const w1=ctx.measureText(line1).width;
        let w2=0; if (line2){ ctx.font=l2Font; w2=ctx.measureText(line2).width; }
        legendItemTextMaxW=Math.max(legendItemTextMaxW, Math.max(w1,w2));
      });
    }

    const iconW=18, iconTextGap=8, safety=12;
    const legendComputedW = !isN ? (iconW + iconTextGap + legendItemTextMaxW + safety) : 0;
    const legendRightDesktop=20;
    const gridRightDesktop = !isN ? Math.max(180, legendRightDesktop + legendComputedW + 10) : 20; // 桌面预留给 legend

    const narrowBottomAuto = Math.min(320, 50 + (series.length||1)*22);
    const gridBottom = isN ? Math.max(140, narrowBottomAuto) : 40;

    function desktopLegendFormatter(name){
      const s = series.find(x=>x.name===name);
      const b=(s?.__legend?.brand||''), m=(s?.__legend?.model||''), c=(s?.__legend?.condition||'');
      const line1=[b,m].filter(Boolean).join(' ') || name;
      const line2=c||'';
      return line2 ? `{l1|${line1}}\n{l2|${line2}}` : `{l1|${line1}}`;
    }
    function mobileLegendFormatter(name){
      const s = series.find(x=>x.name===name);
      const b=(s?.__legend?.brand||''), m=(s?.__legend?.model||''), c=(s?.__legend?.condition||'');
      const left=[b,m].filter(Boolean).join(' ') || name;
      const right=c||'';
      return right ? `{m1|${left}} {m1|-} {m2|${right}}` : `{m1|${left}}`;
    }

    const legendCfg = isN ? {
      type:'scroll', orient:'vertical',
      left:20, right:6, bottom:6,
      itemWidth:16, itemHeight:10, align:'auto',
      pageIconColor: t.pagerIcon, pageTextStyle:{ color:t.axisLabel },
      textStyle:{ color:t.axisLabel, fontFamily:t.fontFamily,
        rich:{ m1:{ fontSize:13,fontWeight:600,color:t.axisLabel,lineHeight:18 },
               m2:{ fontSize:11,fontWeight:500,color:t.axisName,lineHeight:16 } } },
      formatter: mobileLegendFormatter
    } : {
      type:'scroll', orient:'vertical',
      right:legendRightDesktop, top:gridTop, bottom:10,
      itemWidth:18, itemHeight:10, itemGap:16, align:'auto',
      pageIconColor: t.pagerIcon, pageTextStyle:{ color:t.axisLabel },
      textStyle:{ color:t.axisLabel, fontFamily:t.fontFamily,
        rich:{ l1:{ fontSize:13,fontWeight:600,color:t.axisLabel,lineHeight:18 },
               l2:{ fontSize:11,fontWeight:500,color:t.axisName,lineHeight:14 } } },
      formatter: desktopLegendFormatter
    };
    legendCfg.data = series.map(s=>s.name);
    try {
      const prevSel = chart?.getOption?.().legend?.[0]?.selected;
      if (prevSel) legendCfg.selected = prevSel;
    } catch(_){}

    return { grid:{ left:40, right: gridRightDesktop, top: gridTop, bottom: gridBottom }, legend:legendCfg, titleTop };
  }

  // ---------- 基础 ----------
  function ensureEcharts(){
    if (!root || !window.echarts) return;
    const existing = echarts.getInstanceByDom(root);
    if (existing) { chart = existing; return; }
    chart = echarts.init(root, null, { renderer:'canvas', devicePixelRatio: window.devicePixelRatio || 1 });
    window.addEventListener('resize', ()=>{ if (chart) { chart.resize(); } }, { passive:true });
  }

  function formatHzShort(v){
    const n = Number(v); if (!Number.isFinite(n)) return '';
    if (n >= 1000) {
      const k = n/1000;
      const text = (k >= 100 ? Math.round(k) : k >= 10 ? k.toFixed(1) : k.toFixed(2));
      return `${text}k`;
    }
    if (n >= 100) return `${Math.round(n)}`;
    if (n >= 10) return n.toFixed(1);
    return n.toFixed(2);
  }
  function formatHzForPointer(v){
    const n = Number(v); if (!Number.isFinite(n)) return '';
    if (n >= 1000) {
      const k = n/1000;
      const text = (k >= 100 ? Math.round(k) : k >= 10 ? k.toFixed(1) : k.toFixed(2));
      return `${text} kHz`;
    }
    if (n >= 100) return `${Math.round(n)} Hz`;
    if (n >= 10) return `${n.toFixed(1)} Hz`;
    return `${n.toFixed(2)} Hz`;
  }

  // ===== 对外 API =====
  function mount(rootEl){
    root = rootEl;
    if (!root) return;
    ensureEcharts();
    if (!chart) return;
    // 初始空态
    const t = tokensOf(currentTheme());
    const opt = {
      backgroundColor:'transparent',
      title:{ text:'请 先 添 加 数据（频谱模型）', left:'center', top:'middle',
        textStyle:{ color:t.axisLabel, fontFamily:t.fontFamily, fontSize: 18, fontWeight: 600 } },
      tooltip:{ show:false }, legend:{ show:false }
    };
    chart.clear();
    chart.setOption(opt, true);
    chart.resize();
    lastOption = opt;
  }

  function setTheme(theme){
    if (!theme) return;
    document.documentElement.setAttribute('data-theme', theme);
    // 保持懒更新：有模型时局部重绘
    if (Object.keys(modelsByKey||{}).length) {
      renderDynamicNow(tokensOf(theme));
    }
  }

  function resize(){
    if (chart){
      chart.resize();
    }
  }

  // 主渲染入口（主图可通过 payload.chartData.rpm 传入控制的 RPM）
  function render(payload){
    if (!chart) { ensureEcharts(); if (!chart) return; }
    const t = tokensOf((payload && payload.theme) || currentTheme());

    modelsByKey = payload?.chartData?.modelsByKey || {};
    const hasModels = Object.keys(modelsByKey).length > 0;
    if (!hasModels){
      const opt = {
        backgroundColor:'transparent',
        title:{ text:'请 先 添 加 数据（频谱模型）', left:'center', top:'middle',
          textStyle:{ color:t.axisLabel, fontFamily:t.fontFamily, fontSize: 18, fontWeight: 600 } },
        tooltip:{ show:false }, legend:{ show:false }
      };
      chart.clear();
      chart.setOption(opt, true);
      chart.resize();
      lastOption = opt;
      return;
    }

    // RPM 来自主图：优先使用 payload 传入；否则沿用上一次，没有则取 bounds 中点
    const bounds = mergeRpmBounds(modelsByKey);
    const rpmFromPayload = Number(payload?.chartData?.rpm);
    if (Number.isFinite(rpmFromPayload)) dynRpm = rpmFromPayload;
    if (!Number.isFinite(dynRpm) || dynRpm == null) dynRpm = bounds.rpmInit;
    dynRpm = Math.max(bounds.rpmMin, Math.min(dynRpm, bounds.rpmMax));

    renderDynamicNow(t);
  }

  // 对外：主图变更后直接推送 RPM
  function setRPM(newRpm){
    const rpm = Number(newRpm);
    if (!Number.isFinite(rpm)) return;
    if (!Object.keys(modelsByKey||{}).length) { dynRpm = rpm; return; }
    const bounds = mergeRpmBounds(modelsByKey);
    dynRpm = Math.max(bounds.rpmMin, Math.min(rpm, bounds.rpmMax));
    renderDynamicNow(tokensOf(currentTheme()));
  }

  function renderDynamicNow(t){
    if (!chart) return;
    if (!Object.keys(modelsByKey||{}).length){
      // 无模型，保持空态
      const opt = {
        backgroundColor:'transparent',
        title:{ text:'请 先 添 加 数据（频谱模型）', left:'center', top:'middle',
          textStyle:{ color:t.axisLabel, fontFamily:t.fontFamily, fontSize: 18, fontWeight: 600 } },
        tooltip:{ show:false }, legend:{ show:false }
      };
      chart.clear();
      chart.setOption(opt, true);
      chart.resize();
      lastOption = opt;
      return;
    }

    const calc = calcAllSeries(modelsByKey, dynRpm);
    const yMax = computeYMaxFromModels(modelsByKey);
    const bg = (window.RendererBase && RendererBase.utils.getExportBg()) || '#ffffff';
    const transitionMs = (window.RendererBase?.utils?.getCssTransitionMs?.() || 300);

    const series = calc.series.map(s => {
      const clr = (typeof ColorManager !== 'undefined' && s.__key) ? ColorManager.getColor(s.__key) : (s.color || undefined);
      const dataWithId = (s.data || []).map(([x, y]) => ({ id: String(x), value: [x, y] }));
      return {
        __key: s.__key,
        __legend: s.__legend,
        name: s.name,
        type: 'line',
        showSymbol: true,
        symbol: 'circle',
        symbolSize: 2,
        emphasis: { symbolSize: 8 },
        universalTransition: true,
        lineStyle: { width: 2.5, color: clr },
        itemStyle: { color: clr },
        data: dataWithId,
        yAxisIndex: 0
      };
    });

    const titleText = `A 计权频带声级（dB） @ ${Math.round(dynRpm)} RPM`;
    const { grid, legend, titleTop } = buildLegendAndGrid(series, t, titleText);

    const opt = {
      __empty:false,
      backgroundColor:'transparent',
      textStyle:{ fontFamily: t.fontFamily },
      stateAnimation: { duration: transitionMs, easing: 'cubicOut' },
      animationDurationUpdate: transitionMs,
      animationEasingUpdate: 'cubicOut',

      grid,
      title:{ text:titleText, left:'center', top:titleTop,
        textStyle:{ color:t.axisLabel, fontSize:18, fontWeight:600, fontFamily:t.fontFamily } },
      legend,

      xAxis:{
        type:'log', logBase:10,
        min: 20,
        max: 22000,
        boundaryGap: [0, 0.06],
        name:'频率(Hz)', nameLocation:'middle', nameGap:25, nameMoveOverlap:true,
        nameTextStyle:{ color:t.axisName, fontWeight:600, fontFamily:t.fontFamily },
        axisLabel:{
          color:t.axisLabel,
          fontSize:12,
          fontFamily:t.fontFamily,
          margin: 10,
          interval: 0,
          hideOverlap: false,
          showMinLabel: true,
          showMaxLabel: true,
          formatter:(v)=>formatHzShort(v)
        },
        axisLine:{ lineStyle:{ color: t.axisLine } },
        splitLine:{ show:true, lineStyle:{ color: t.gridLine } },
        minorTick:{ show:true, splitNumber: 9 },
        minorSplitLine:{ show:true, lineStyle:{ color: t.gridLine, opacity: 0.28 } },
        axisPointer:{ label:{ formatter: ({ value }) => formatHzForPointer(value) } }
      },
      yAxis:[
        {
          type:'value', name:'声级(dB)', min:0, max:yMax,
          nameTextStyle:{ color:t.axisName, fontWeight:600, fontFamily:t.fontFamily },
          axisLabel:{ color:t.axisLabel, fontSize:12, fontFamily:t.fontFamily },
          axisLine:{ lineStyle:{ color:t.axisLine } },
          splitLine:{ show:true, lineStyle:{ color:t.gridLine } }
        }
      ],

      tooltip:{
        trigger:'item',
        axisPointer:{ type:'cross' },
        appendToBody:true,
        confine:true,
        backgroundColor:t.tooltipBg,
        borderColor:t.tooltipBorder,
        borderWidth:1,
        borderRadius:12,
        textStyle:{ color:t.tooltipText },
        position: function (pos, _params, dom) {
          const x = Array.isArray(pos) ? pos[0] : 0;
          const y = Array.isArray(pos) ? pos[1] : 0;
          const vw = window.innerWidth  || document.documentElement.clientWidth || 0;
          const vh = window.innerHeight || document.documentElement.clientHeight || 0;
          const dw = dom?.offsetWidth  || 0;
          const dh = dom?.offsetHeight || 0;
          const pad = 8, gap = 12;
          let left = x + gap;
          let top  = y + gap;
          if (left + dw > vw - pad) left = Math.max(pad, x - gap - dw);
          if (top  + dh > vh - pad) top  = Math.max(pad, y - gap - dh);
          if (left < pad) left = pad;
          if (top  < pad) top = pad;
          return [Math.round(left), Math.round(top)];
        },
        extraCssText: `
          position: fixed;
          backdrop-filter: blur(4px) saturate(120%);
          -webkit-backdrop-filter: blur(4px) saturate(120%);
          box-shadow: ${t.tooltipShadow};
          z-index: 1000000;
        `,
        formatter:(params)=>{
          const p = Array.isArray(params) ? params[0] : params;
          const s = (typeof p?.seriesIndex === 'number') ? series[p.seriesIndex] : null;
          const meta = s?.__legend || {};
          const left = [meta.brand||'', meta.model||''].filter(Boolean).join(' ');
          const line1 = left ? `${left}${meta.condition ? ' - ' + meta.condition : ''}` : (p?.seriesName || '');
          const y = p?.value?.[1];
          const f = p?.value?.[0];
          const dot = `<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${p?.color||s?.itemStyle?.color||'#999'};margin-right:6px;"></span>`;
          const vText = (typeof y === 'number') ? `${y.toFixed(2)} dB` : '-';
          const fText = formatHzForPointer(f);
          return `${dot}${line1}<br/>${vText} @ ${fText}`;
        }
      },

      toolbox:{ top:-4, right:0, feature:{ restore:{}, saveAsImage:{ backgroundColor:bg, pixelRatio: window.devicePixelRatio || 1 } } },
      series
    };

    chart.setOption(opt, true);
    chart.resize();
    lastOption = opt;
  }

  // 挂到全局
  window.SpectrumRenderer = API;
})();