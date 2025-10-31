(function(){
  // 动态频谱渲染器：前端 PCHIP 插值 + 右侧导轨（支持 RPM / dB 两种控制模式）
  // - dB 模式控制“设备噪声（去环境）”，基于 calib_model(rpm)->LAeq_envsub
  // - 采用 LUT（RPM 等间距采样+单调化+二分）进行 dB->RPM 快速映射；若 LUT 不可用，回退为粗采样+局部细化
  // - 右侧为导轨与模式开关预留空间，避免与图表区域/图例重叠导致点击不到

  const API = { mount, render, resize, setTheme };
  let root = null, chart = null;
  const EPS_DB_SPAN = 0.3;

  // 数据与状态
  let modelsByKey = {};     // key -> { model, name, color, brand?, modelName?, condition? }
  let dynRpm = null, dynRpmMin = 1500, dynRpmMax = 4500;

  // 噪音控制模式（dB，设备噪声，已去环境）
  let controlMode = 'rpm';      // 'rpm' | 'noise_db'
  let dynNoise = null, dynNoiseMin = 40, dynNoiseMax = 90;
  let refKeyForNoise = null;    // 用于噪音<->转速映射的参考序列 key

  // dB<->RPM LUT（方案A：RPM 等间距采样 + 单调化）
  let noiseLUT = null;          // { rpm: Float64Array, db: Float64Array, samples: number }
  let noiseLUTMeta = { key: null, rpmMin: NaN, rpmMax: NaN, mdlRef: null };

  // UI：竖直导轨
  let vRail = null, vTrack = null, vKnob = null, vReadout = null, vModeToggle = null;
  let dragging = false;
  let lastOption = null;

  // 主题
  const tokensOf = (theme) => RendererBase.utils.tokens(theme || window.ThemePref?.resolve?.() || 'light');
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

  // ---------- 噪音 <-> 转速 映射（设备噪声，去环境） ----------
  function pickRefKey(){
    const keys = Object.keys(modelsByKey||{});
    return keys.length ? keys[0] : null;
  }

  function laSubAtRpm(modelJson, rpm){
    // 直接使用 calib_model：rpm -> LAeq_envsub（设备噪声，已去环境）
    const mdl = modelJson?.calibration?.calib_model;
    if (!mdl) return NaN;
    return evalPchip(mdl, rpm);
  }

  // LUT：RPM 等间距采样 + 单调化
  function buildNoiseLUT(calibModel, rpmMin, rpmMax, samples=512){
    const rpm = new Float64Array(samples);
    const db  = new Float64Array(samples);
    const step = (rpmMax - rpmMin) / Math.max(1, samples-1);
    for(let i=0;i<samples;i++){
      const r = rpmMin + i*step;
      rpm[i] = r;
      db[i]  = evalPchip(calibModel, r);
    }
    // 保证非下降（抹平数值抖动）
    for(let i=1;i<samples;i++){
      if (db[i] < db[i-1]) db[i] = db[i-1];
    }
    return { rpm, db, samples };
  }

// 修改：二分查询保持不变（用于正常 LUT）
function rpmFromNoiseLUT(lut, targetDb){
  const { rpm, db, samples } = lut || {};
  if (!rpm || !db || !samples) return NaN;
  // 找到首个/最后一个有效索引，避免端点 NaN 干扰
  let iStart = 0, iEnd = samples - 1;
  while (iStart < samples && !Number.isFinite(db[iStart])) iStart++;
  while (iEnd >= 0 && !Number.isFinite(db[iEnd])) iEnd--;
  if (iStart >= iEnd) return NaN;

  // 边界裁剪
  if (targetDb <= db[iStart]) return rpm[iStart];
  if (targetDb >= db[iEnd])   return rpm[iEnd];

  // 二分
  let lo=iStart, hi=iEnd;
  while (lo + 1 < hi){
    const mid = (lo + hi) >> 1;
    const v = db[mid];
    if (!Number.isFinite(v)) { // 跳过无效点
      // 往两侧扩散找最近有效点
      let l=mid-1, r=mid+1, vm=NaN, idx=mid;
      while (l>=lo || r<=hi){
        if (l>=lo && Number.isFinite(db[l])) { vm = db[l]; idx=l; break; }
        if (r<=hi && Number.isFinite(db[r])) { vm = db[r]; idx=r; break; }
        l--; r++;
      }
      if (!Number.isFinite(vm)) break;
      if (vm >= targetDb) hi = idx; else lo = idx;
      continue;
    }
    if (v >= targetDb) hi = mid; else lo = mid;
  }
  const d0 = db[lo], d1 = db[hi];
  const r0 = rpm[lo], r1 = rpm[hi];
  const t = (Number.isFinite(d1) && Number.isFinite(d0) && d1 > d0) ? (targetDb - d0) / (d1 - d0) : 0;
  return r0 + t * (r1 - r0);
}

  // 回退：若 LUT 不可用，使用粗采样+局部细化（不使用 laeq_env_db）
  function rpmFromNoiseBrute(modelJson, targetDb, rmin, rmax){
    const N = 96;
    let bestR = rmin, bestErr = Infinity;
    const step = (rmax - rmin) / Math.max(1, N-1);
    for (let i=0;i<N;i++){
      const r = rmin + i*step;
      const la = laSubAtRpm(modelJson, r);
      if (Number.isFinite(la)){
        const err = Math.abs(la - targetDb);
        if (err < bestErr){ bestErr = err; bestR = r; }
      }
    }
    // 局部三分
    let left = Math.max(rmin, bestR - 2*step);
    let right = Math.min(rmax, bestR + 2*step);
    for (let k=0;k<18;k++){
      const m1 = left + (right-left)/3;
      const m2 = right - (right-left)/3;
      const e1 = Math.abs(laSubAtRpm(modelJson, m1) - targetDb);
      const e2 = Math.abs(laSubAtRpm(modelJson, m2) - targetDb);
      if (!Number.isFinite(e1) || !Number.isFinite(e2)) break;
      if (e1 < e2) right = m2; else left = m1;
    }
    const rcand = (left+right)/2;
    return Math.max(rmin, Math.min(rcand, rmax));
  }

// 修改：确保/重建 LUT，并设置 dB 轴范围与“是否平坦”标记
function ensureNoiseLUT(force=false){
  if (controlMode !== 'noise_db') return;
  if (!refKeyForNoise) refKeyForNoise = pickRefKey();
  const ref = (modelsByKey||{})[refKeyForNoise];
  const mdl = ref?.model;
  const calibModel = mdl?.calibration?.calib_model;
  if (!mdl || !calibModel) { noiseLUT = null; noiseLUTMeta = { key:null, rpmMin:NaN, rpmMax:NaN, mdlRef:null, flat:true }; return; }

  const rmin = Number(mdl.rpm_min ?? calibModel?.x0 ?? dynRpmMin);
  const rmax = Number(mdl.rpm_max ?? calibModel?.x1 ?? dynRpmMax);
  const key = refKeyForNoise;

  const changed = force
    || noiseLUT==null
    || noiseLUTMeta.key !== key
    || noiseLUTMeta.rpmMin !== rmin
    || noiseLUTMeta.rpmMax !== rmax
    || noiseLUTMeta.mdlRef !== calibModel;

  if (!changed) return;

  // 重建
  noiseLUT = buildNoiseLUT(calibModel, rmin, rmax, 512);
  const stats = lutFiniteStats(noiseLUT);
  const flat = !(stats && stats.i0>=0 && stats.i1>=0 && Number.isFinite(stats.spanDb) && stats.spanDb >= EPS_DB_SPAN);

  // 设置显示范围：用有效首末 dB，加少许边距
  if (stats && stats.i0>=0 && stats.i1>=0) {
    const pad = 0.5;
    dynNoiseMin = Math.floor((stats.minDb - pad));
    dynNoiseMax = Math.ceil((stats.maxDb + pad));
    if (dynNoiseMin >= dynNoiseMax) {
      // 极端情况下仍然相等，强行拉开一点，避免滑块分母为零
      dynNoiseMin = Math.floor(stats.minDb - 1.0);
      dynNoiseMax = Math.ceil(stats.maxDb + 1.0);
    }
  } else {
    // 无有效 dB，给出保底范围
    dynNoiseMin = 40; dynNoiseMax = 90;
  }

  // 初始化一个 dB 读数
  if (!Number.isFinite(dynNoise)) {
    if (stats && stats.i0>=0 && stats.i1>=0) {
      const mid = Math.floor((stats.i0 + stats.i1)/2);
      const v = noiseLUT.db[mid];
      dynNoise = Number.isFinite(v) ? Math.round(v*10)/10 : Math.round(((dynNoiseMin+dynNoiseMax)/2)*10)/10;
    } else {
      dynNoise = Math.round(((dynNoiseMin+dynNoiseMax)/2)*10)/10;
    }
  }

  // 记录元信息
  noiseLUTMeta = { key, rpmMin: rmin, rpmMax: rmax, mdlRef: calibModel, flat };
}

  // ---------- 布局/legend ----------
  const layoutIsNarrow = () => {
    const w = (root?.getBoundingClientRect?.().width|0) || (chart?.getWidth?.()||0);
    return w>0 ? (w<800) : false;
  };
  const measureText = (text,size,weight,family)=>RendererBase.utils.measureText(text,size,weight,family);

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

    // 预留右侧空间给 legend + 垂直导轨 + 模式开关，避免重叠点击不到
    const railSpaceDesktop = 120;  // 导轨+开关的水平占位
    const railSpaceNarrow  = 90;
    const railSpace = isN ? railSpaceNarrow : railSpaceDesktop;

    const iconW=18, iconTextGap=8, safety=12;
    const legendComputedW = !isN ? (iconW + iconTextGap + legendItemTextMaxW + safety) : 0;
    const legendRightDesktop=20;
    const gridRightDesktop = !isN ? Math.max(200, legendRightDesktop + legendComputedW + railSpace) : railSpace + 20;

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

  // ---------- UI：竖直导轨（支持模式切换；不与图表区重叠） ----------
  function ensureVerticalRail(t){
    if (!root) return;

    // 确保 root 为定位容器
    try {
      const cs = window.getComputedStyle(root);
      if (cs && cs.position === 'static') root.style.position = 'relative';
    } catch(_){ root.style.position = 'relative'; }

    if (!vRail){
      vRail = document.createElement('div');
      vRail.className = 'spr-rail';
      vRail.innerHTML = `
        <div class="spr-track"></div>
        <div class="spr-knob"></div>
        <div class="spr-readout"></div>
        <div class="spr-mode-toggle" aria-label="控制模式">
          <button data-mode="rpm" class="on">RPM</button>
          <button data-mode="noise">dB</button>
        </div>`;
      root.appendChild(vRail);

      vTrack = vRail.querySelector('.spr-track');
      vKnob  = vRail.querySelector('.spr-knob');
      vReadout = vRail.querySelector('.spr-readout');
      vModeToggle = vRail.querySelector('.spr-mode-toggle');

      // 样式（内联）
      Object.assign(vRail.style, {
        position: 'absolute',
        width: '28px',
        background: 'transparent',
        zIndex: '2000',
        pointerEvents: 'auto',
        userSelect: 'none'
      });
      Object.assign(vTrack.style, {
        position: 'absolute',
        left: '50%',
        transform: 'translateX(-50%)',
        width: '4px',
        borderRadius: '2px',
        opacity: '0.6'
      });
      Object.assign(vKnob.style, {
        position: 'absolute',
        left: '50%',
        transform: 'translate(-50%, -8px)',
        width: '14px',
        height: '14px',
        borderRadius: '50%',
        boxShadow: '0 1px 3px rgba(0,0,0,.25)',
        cursor: 'ns-resize'
      });
      Object.assign(vReadout.style, {
        position: 'absolute',
        left: '50%',
        transform: 'translate(-50%, -100%)',
        fontSize: '12px',
        fontWeight: '600',
        padding: '2px 6px',
        borderRadius: '6px',
        background: 'rgba(255,255,255,0.8)',
        boxShadow: '0 1px 2px rgba(0,0,0,.12)',
        whiteSpace: 'nowrap'
      });
      Object.assign(vModeToggle.style, {
        position: 'absolute',
        right: '-90px',  // 放在导轨右侧，远离图表区域与 legend，避免重叠
        top: '-6px',
        display: 'flex',
        gap: '6px',
        zIndex: '2001'
      });
      vModeToggle.querySelectorAll('button').forEach(btn=>{
        Object.assign(btn.style, {
          padding: '4px 8px',
          fontSize: '12px',
          fontWeight: '600',
          borderRadius: '6px',
          border: '1px solid #d1d5db',
          background: '#ffffff',
          color: '#111827',
          cursor: 'pointer'
        });
        if (btn.classList.contains('on')) {
          btn.style.background = '#2563eb';
          btn.style.color = '#ffffff';
          btn.style.borderColor = '#2563eb';
        }
      });

      const onDown = (e) => { dragging=true; vRail.classList.add('dragging'); onMove(e); e.preventDefault?.(); };
      const onUp   = () => { dragging=false; vRail.classList.remove('dragging'); };
// 修改：导轨拖动逻辑（只替换 onMove 函数体）
const onMove = (e) => {
  if (!dragging && !(e.type==='pointerdown'||e.type==='mousedown'||e.type==='touchstart')) return;
  const clientY = (e.touches && e.touches.length) ? e.touches[0].clientY : (e.clientY ?? null);
  if (clientY==null || !lastOption || !chart) return;
  const grid = lastOption.grid || {};
  const chartH = chart.getHeight();
  const top = (typeof grid.top==='number') ? grid.top : 54;
  const bottomGap = (typeof grid.bottom==='number') ? grid.bottom : 40;
  const height = chartH - top - bottomGap;
  const rect = root.getBoundingClientRect();
  const yInChart = clientY - rect.top;
  const clampedY = Math.max(top, Math.min(yInChart, top+height));
  const tNorm = 1 - (clampedY - top)/height;

  if (controlMode === 'noise_db'){
    const n = dynNoiseMin + tNorm * (dynNoiseMax - dynNoiseMin);
    dynNoise = Math.round(n*10)/10;
    ensureNoiseLUT(false);
    const r = noiseToRpm(dynNoise, tNorm);
    if (Number.isFinite(r)) dynRpm = Math.round(r);
  } else {
    const r = dynRpmMin + tNorm * (dynRpmMax - dynRpmMin);
    dynRpm = Math.round(r);
    // 同步噪音读数（去环境）
    const ref = (modelsByKey||{})[refKeyForNoise];
    const la = laSubAtRpm(ref?.model, dynRpm);
    if (Number.isFinite(la)) dynNoise = Math.round(la*10)/10;
  }
  const tNow = tokensOf(currentTheme());
  updateRailVisual(tNow);
  renderDynamicNow(tNow);
};

      vRail.addEventListener('mousedown', onDown);
      vRail.addEventListener('touchstart', onDown, { passive: true });
      window.addEventListener('mousemove', onMove, { passive: true });
      window.addEventListener('touchmove', onMove, { passive: true });
      window.addEventListener('mouseup', onUp, { passive: true });
      window.addEventListener('touchend', onUp, { passive: true });
      window.addEventListener('touchcancel', onUp, { passive: true });

      // 模式开关
      vModeToggle?.addEventListener('click', (e)=>{
        const btn = e.target.closest('button[data-mode]');
        if (!btn) return;
        vModeToggle.querySelectorAll('button').forEach(b=>{
          b.classList.remove('on');
          b.style.background = '#ffffff';
          b.style.color = '#111827';
          b.style.borderColor = '#d1d5db';
        });
        btn.classList.add('on');
        btn.style.background = '#2563eb';
        btn.style.color = '#ffffff';
        btn.style.borderColor = '#2563eb';

        const m = btn.getAttribute('data-mode');
        controlMode = (m==='noise') ? 'noise_db' : 'rpm';

        const tNow = tokensOf(currentTheme());
        if (controlMode==='noise_db'){
          if (!refKeyForNoise) refKeyForNoise = pickRefKey();
          ensureNoiseLUT(true);
          if (noiseLUT){
            dynNoiseMin = Math.floor(noiseLUT.db[0]);
            dynNoiseMax = Math.ceil(noiseLUT.db[noiseLUT.samples-1]);
            if (!Number.isFinite(dynNoise)){
              const idx = Math.floor(noiseLUT.samples/2);
              dynNoise = Math.round(noiseLUT.db[idx]*10)/10;
            }
            let r = rpmFromNoiseLUT(noiseLUT, dynNoise);
            if (!Number.isFinite(r)) {
              const ref = (modelsByKey||{})[refKeyForNoise];
              r = rpmFromNoiseBrute(ref?.model, dynNoise, dynRpmMin, dynRpmMax);
            }
            if (Number.isFinite(r)) dynRpm = Math.round(r);
          }
        }
        updateRailLayout(tNow);
        updateRailVisual(tNow);
        renderDynamicNow(tNow);
      });
    }

    // 颜色自适应主题
    vTrack.style.background = t.axisLine || '#e5e7eb';
    vKnob.style.background  = t.pagerIcon || '#2563eb';
    vReadout.style.color    = t.axisLabel || '#374151';
  }

  function updateRailLayout(t){
    if (!vRail || !chart || !lastOption) return;
    const grid = lastOption.grid || {};
    const chartW = chart.getWidth(), chartH = chart.getHeight();
    const rightGap = (typeof grid.right==='number') ? grid.right : 200;
    const top = (typeof grid.top==='number') ? grid.top : 54;
    const bottomGap = (typeof grid.bottom==='number') ? grid.bottom : 40;

    // 将导轨放在“网格右侧空白区域”内（不覆盖绘图区/legend），并留出开关区域
    const railWidth = 28;
    const railRightMargin = 16; // 距容器右侧再留一点空白，避免外溢
    const plotRightX = chartW - rightGap;    // 网格右边界（绘图区右侧）
    const railLeft = Math.min(chartW - railWidth - railRightMargin, plotRightX + 8);

    const plotHeight = chartH - top - bottomGap;
    vRail.style.top = `${top}px`;
    vRail.style.left = `${Math.max(0, Math.round(railLeft))}px`;
    vRail.style.height = `${plotHeight}px`;

    vTrack.style.top = '0px';
    vTrack.style.height = `${plotHeight}px`;

    vReadout.style.top = '-22px';
    vReadout.style.bottom = 'auto';

    updateRailVisual(t);
  }

  function updateRailVisual(t){
    if (!vRail || !chart || !lastOption) return;
    const grid = lastOption.grid || {};
    const chartH = chart.getHeight();
    const top = (typeof grid.top==='number') ? grid.top : 54;
    const bottomGap = (typeof grid.bottom==='number') ? grid.bottom : 40;
    const height = chartH - top - bottomGap;
    if (!(height>0)) return;

    if (controlMode === 'noise_db'){
      const norm = (dynNoise - dynNoiseMin) / Math.max(1, (dynNoiseMax - dynNoiseMin));
      const y = (1 - norm) * height;
      vKnob.style.top = `${y}px`;
      vReadout.textContent = `设备噪声：${Number(dynNoise).toFixed(1)} dB`;
    } else {
      const norm = (dynRpm - dynRpmMin) / Math.max(1, (dynRpmMax - dynRpmMin));
      const y = (1 - norm) * height;
      vKnob.style.top = `${y}px`;
      vReadout.textContent = `转速：${Math.round(dynRpm)} RPM`;
    }
    vTrack.style.background = t.axisLine || '#e5e7eb';
    vKnob.style.background  = t.pagerIcon || '#2563eb';
    vReadout.style.color    = t.axisLabel || '#374151';
  }

  // ---------- 基础 ----------
  function ensureEcharts(){
    if (!root || !window.echarts) return;
    const existing = echarts.getInstanceByDom(root);
    if (existing) { chart = existing; return; }
    chart = echarts.init(root, null, { renderer:'canvas', devicePixelRatio: window.devicePixelRatio || 1 });
    window.addEventListener('resize', ()=>{
      if (!chart) return;
      chart.resize();
      const t = tokensOf(currentTheme());
      updateRailLayout(t);
    }, { passive:true });
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

  // ---------- 渲染 ----------
  function mount(rootEl){
    root = rootEl;
    if (!root) return;
    ensureEcharts();
    if (!chart) return;
    const t = tokensOf(currentTheme());
    ensureVerticalRail(t);
    if (vRail) vRail.style.display = 'none'; // 待有模型后再显示
  }

  function setTheme(theme){
    if (!theme) return;
    document.documentElement.setAttribute('data-theme', theme);
    const t = tokensOf(theme);
    ensureVerticalRail(t);
    updateRailLayout(t);
    renderDynamicNow(t); // 自适应主题色
  }

  function resize(){
    if (chart){
      chart.resize();
      const t=tokensOf(currentTheme());
      updateRailLayout(t);
    }
  }

  function render(payload){
    if (!chart) { ensureEcharts(); if (!chart) return; }
    const t = tokensOf((payload && payload.theme) || currentTheme());
    ensureVerticalRail(t);

    modelsByKey = payload?.chartData?.modelsByKey || {};
    const hasModels = Object.keys(modelsByKey).length > 0;

    if (!hasModels){
      if (vRail) vRail.style.display = 'none';
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

    // 有数据：边界与参考初始化
    const merged = mergeRpmBounds(modelsByKey);
    dynRpmMin=merged.rpmMin; dynRpmMax=merged.rpmMax;
    if (dynRpm==null) dynRpm = merged.rpmInit;
    dynRpm = Math.max(dynRpmMin, Math.min(dynRpm, dynRpmMax));

    if (!refKeyForNoise) refKeyForNoise = pickRefKey();

// 修改：render 中进入 dB 模式时的初始化分支
if (controlMode==='noise_db'){
  ensureNoiseLUT(true);
  if (noiseLUT) {
    const stats = lutFiniteStats(noiseLUT);
    if (stats && stats.i0>=0 && stats.i1>=0) {
      const pad = 0.5;
      dynNoiseMin = Math.floor(stats.minDb - pad);
      dynNoiseMax = Math.ceil(stats.maxDb + pad);
      if (!Number.isFinite(dynNoise)) {
        const mid = Math.floor((stats.i0 + stats.i1)/2);
        const v = noiseLUT.db[mid];
        dynNoise = Number.isFinite(v) ? Math.round(v*10)/10 : Math.round(((dynNoiseMin+dynNoiseMax)/2)*10)/10;
      }
    } else {
      // LUT 无有效值，保底范围
      dynNoiseMin = 40; dynNoiseMax = 90;
      if (!Number.isFinite(dynNoise)) dynNoise = Math.round(((dynNoiseMin+dynNoiseMax)/2)*10)/10;
    }
    // 用统一映射得到当前 rpm（若 LUT 平坦则回退到线性）
    const r = noiseToRpm(dynNoise, 0.5);
    if (Number.isFinite(r)) dynRpm = Math.round(r);
  }
} else {
  // RPM 模式：同步一个噪音读数
  const ref = (modelsByKey||{})[refKeyForNoise];
  const la = laSubAtRpm(ref?.model, dynRpm);
  if (Number.isFinite(la)) dynNoise = Math.round(la*10)/10;
}

    if (vRail) vRail.style.display = 'block';
    renderDynamicNow(t);
  }

  function renderDynamicNow(t){
    if (!chart) return;
    const calc = calcAllSeries(modelsByKey, dynRpm);
    const yMax = computeYMaxFromModels(modelsByKey);
    const bg = RendererBase.utils.getExportBg();
    const transitionMs = (RendererBase?.utils?.getCssTransitionMs?.() || 300);

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

    const rightAxis = (controlMode === 'noise_db') ? {
      type:'value', position:'right',
      name:'',
      min: Math.floor(dynNoiseMin), max: Math.ceil(dynNoiseMax),
      nameTextStyle:{ color:t.axisName, fontWeight:600, fontFamily:t.fontFamily },
      axisLabel:{ color:t.axisLabel, fontSize:12, fontFamily:t.fontFamily },
      axisLine:{ lineStyle:{ color: t.axisLine } },
      splitLine:{ show:false }
    } : {
      type:'value', position:'right',
      name:'',
      min: Math.floor(dynRpmMin), max: Math.ceil(dynRpmMax),
      nameTextStyle:{ color:t.axisName, fontWeight:600, fontFamily:t.fontFamily },
      axisLabel:{ color:t.axisLabel, fontSize:12, fontFamily:t.fontFamily },
      axisLine:{ lineStyle:{ color: t.axisLine } },
      splitLine:{ show:false }
    };

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
        },
        rightAxis
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
          if (top  < pad) top  = pad;
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

    const tNow = tokensOf(currentTheme());
    ensureVerticalRail(tNow);
    updateRailLayout(tNow);
  }

  // 新增：LUT 有效值统计（过滤 NaN，返回首末有效索引与 dB 跨度）
  function lutFiniteStats(lut){
    if (!lut || !lut.db || !lut.rpm || !Number.isFinite(lut.samples)) {
      return { i0: -1, i1: -1, minDb: NaN, maxDb: NaN, spanDb: NaN };
    }
    const n = lut.samples|0;
    let i0 = -1, i1 = -1, minDb = +Infinity, maxDb = -Infinity;
    for (let i=0;i<n;i++){
      const v = lut.db[i];
      if (!Number.isFinite(v)) continue;
      if (i0 === -1) i0 = i;
      i1 = i;
      if (v < minDb) minDb = v;
      if (v > maxDb) maxDb = v;
    }
    const spanDb = (Number.isFinite(minDb) && Number.isFinite(maxDb)) ? (maxDb - minDb) : NaN;
    return { i0, i1, minDb, maxDb, spanDb };
  }

  // 新增：统一的 dB->RPM 映射（优先 LUT；LUT 平坦/不可用时回退到按位置线性映射）
function noiseToRpm(targetDb, tNorm){
  // 优先用 LUT 且跨度足够
  if (controlMode === 'noise_db' && noiseLUT && noiseLUTMeta && noiseLUTMeta.flat === false) {
    const r = rpmFromNoiseLUT(noiseLUT, targetDb);
    if (Number.isFinite(r)) return r;
  }
  // 回退：按滑块位置线性映射到 RPM（确保频谱会变化）
  const rmin = Number.isFinite(dynRpmMin) ? dynRpmMin : (noiseLUTMeta?.rpmMin ?? 1500);
  const rmax = Number.isFinite(dynRpmMax) ? dynRpmMax : (noiseLUTMeta?.rpmMax ?? 4500);
  const r = rmin + Math.max(0, Math.min(1, tNorm)) * (rmax - rmin);
  return r;
}

  window.SpectrumRenderer = API;
})();