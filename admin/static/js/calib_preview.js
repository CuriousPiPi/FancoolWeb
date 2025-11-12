(function(){
  const CalibPreview = {};
  const CDN = 'https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js';

  function loadECharts(){
    if(window.echarts) return Promise.resolve();
    return new Promise((resolve, reject)=>{
      const s = document.createElement('script');
      s.src = CDN; s.async = true;
      s.onload = ()=>resolve();
      s.onerror = ()=>reject(new Error('echarts load failed'));
      document.head.appendChild(s);
    });
  }

  function evalPchip(model, x){
    if(!model||!Array.isArray(model.x)||!Array.isArray(model.y)||!Array.isArray(model.m)) return NaN;
    const xs=model.x, ys=model.y, ms=model.m;
    const n=xs.length; if(n===0) return NaN; if(n===1) return ys[0];
    let xv=x;
    if(xv<=xs[0]) xv=xs[0];
    if(xv>=xs[n-1]) xv=xs[n-1];
    let lo=0, hi=n-2, i=0;
    while(lo<=hi){
      const mid=(lo+hi)>>1;
      if(xs[mid]<=xv && xv<=xs[mid+1]){ i=mid; break; }
      if(xv<xs[mid]) hi=mid-1; else lo=mid+1;
    }
    if(lo>hi) i=Math.max(0, Math.min(n-2, lo));
    const x0=xs[i], x1=xs[i+1], h=(x1-x0)||1, t=(xv-x0)/h;
    const y0=ys[i], y1=ys[i+1], m0=ms[i]*h, m1=ms[i+1]*h;
    const h00=2*t*t*t-3*t*t+1, h10=t*t*t-2*t*t+t, h01=-2*t*t*t+3*t*t, h11=t*t*t-t*t;
    return h00*y0 + h10*m0 + h01*y1 + h11*m1;
  }

  function bandsPerDecadeFromNpo(npo){ return Math.round((npo*10.0)/3.0); }
  function bandEdgesFromCenters(centers, npo){
    const bpd=bandsPerDecadeFromNpo(npo);
    const g = Math.pow(10, 1.0/(2.0*bpd));
    const f1=[], f2=[];
    for(const c of centers){ f1.push(c/g); f2.push(c*g); }
    return {f1, f2};
  }

  function distributeLineToBands(fLine, centers, f1, f2, sigmaBands=0.25, topk=3){
    if(!(fLine>0)) return [];
    const logC = centers.map(c=>Math.log(Math.max(c,1e-30)));
    const t = Math.log(Math.max(fLine,1e-30));
    const w = logC.map((lc,i)=> (fLine>=f1[i] && fLine<=f2[i]) ? Math.exp(-0.5*Math.pow((t-lc)/Math.max(1e-6,sigmaBands),2)) : 0.0);
    const idx = Array.from(w.map((v,i)=>[v,i])).sort((a,b)=>b[0]-a[0]).slice(0, Math.max(1, topk)).map(x=>x[1]);
    let sum=0; for(const i of idx) sum += w[i];
    if(sum<=0) return [];
    return idx.map(i=>[i, w[i]/sum]);
  }

  function spectrumFromBandModels(bandModels, centers, rpm){
    const out=new Array(centers.length);
    for(let i=0;i<centers.length;i++){
      const p=bandModels[i]||null;
      let y=null;
      if(p && Array.isArray(p.x)&&Array.isArray(p.y)&&Array.isArray(p.m)){
        const v=evalPchip(p, rpm);
        if(Number.isFinite(v)) y=v;
      }
      out[i]=[centers[i], y];
    }
    return out;
  }

  function formatHz(v){
    const n=Number(v);
    if(!Number.isFinite(n)) return '';
    if(n>=1000){
      const k=n/1000;
      return (k>=100?Math.round(k):(k>=10?k.toFixed(1):k.toFixed(2)))+'k';
    }
    if(n>=100) return String(Math.round(n));
    if(n>=10) return n.toFixed(1);
    return n.toFixed(2);
  }

  function createLoadingOverlay(parent){
    const ov = document.createElement('div');
    ov.className = 'calib-loading-overlay';
    ov.style.position='absolute';
    ov.style.left='0'; ov.style.top='0';
    ov.style.right='0'; ov.style.bottom='0';
    ov.style.display='flex';
    ov.style.flexDirection='column';
    ov.style.alignItems='center';
    ov.style.justifyContent='center';
    // 与面板背景一致：使用继承或自定义变量，必要时可改为 'white' 或 'transparent'
    ov.style.background='inherit';
    ov.style.fontSize='14px';
    ov.style.color='#acacacff';
    ov.innerHTML = `
      <div style="display:flex; flex-direction:column; align-items:center; gap:10px;">
        <div class="spinner" style="
          width:34px;height:34px;
          border:4px solid #e2e8f0;
          border-top-color:#2563eb;
          border-radius:50%;
          animation:calibSpin 0.9s linear infinite;
        "></div>
        <div style="text-align:center; line-height:1.4;">
          <strong>正在生成频谱模型，请稍候...</strong><br/>
          <span id="calibLoadingElapsed" style="opacity:0.7;">耗时 0.0 s</span>
        </div>
      </div>
    `;
    parent.style.position='relative';
    parent.appendChild(ov);
    return ov;
  }

  function updateOverlayTime(ov, start){
    const el = ov.querySelector('#calibLoadingElapsed');
    if(!el) return;
    const sec = (performance.now() - start) / 1000;
    el.textContent = `耗时 ${sec.toFixed(1)} s`;
  }

  const styleTag = document.createElement('style');
  styleTag.textContent = `
    @keyframes calibSpin { from{ transform:rotate(0deg);} to{ transform:rotate(360deg);} }
  `;
  document.head.appendChild(styleTag);

  CalibPreview.show = async function({ mount, batchId }){
    const container = (typeof mount==='string')? document.querySelector(mount) : mount;
    if(!container) throw new Error('mount container not found');
    if(!batchId) throw new Error('batchId required');
  
    container.innerHTML = `
      <div class="panel" style="margin-top:10px; position:relative;">
        <h4 style="margin:0 0 8px;">频谱预览</h4>
        <div id="calibChart" style="width:100%; height:340px; position:relative;"></div>
        <div style="display:flex; gap:10px; align-items:center; margin-top:8px; flex-wrap:wrap;">
          <label for="calibRpmInput">RPM</label>
          <input id="calibRpmInput" type="number" step="1" style="width:120px;" />
          <input id="calibRpmRange" type="range" style="flex:1 1 auto; min-width:220px;" />
          <div id="laCompositeBox" style="display:flex; gap:18px; flex-wrap:wrap; font-size:13px;">
            <span>合成LAeq: <b id="laCompositeVal">-</b> dB</span>
            <span>校正Δ: <b id="deltaVal">-</b> dB</span>
          </div>
        </div>
      </div>
  
      <div class="panel" style="margin-top:12px;">
        <h4 style="margin:0 0 8px;">分箱覆盖</h4>
        <div id="countsChart" style="width:100%; height:100px; position:relative;"></div>
      </div>
  
      <div class="panel" style="margin-top:12px;">
        <h4 style="margin:0 0 8px;">耗时统计</h4>
        <div id="timingGrid" style="display:grid; grid-template-columns: 1fr 1fr; gap:6px 16px;"></div>
      </div>
  
      <div class="panel" style="margin-top:12px;">
        <h4 style="margin:0 0 8px;">模型基础参数</h4>
        <div id="calibInfoGrid" style="display:grid; grid-template-columns: 1fr 1fr; gap:6px 16px;"></div>
      </div>
    `;
  
    const chartDom = document.getElementById('calibChart');
    const overlayStart = performance.now();
    const overlay = createLoadingOverlay(chartDom);
    let overlayTimer = setInterval(()=>updateOverlayTime(overlay, overlayStart), 300);
  
    let model;
    let requestSec = null; // 前端测的请求耗时（秒，含后端处理 + 网络）
    try {
      const t0 = performance.now();
      const res = await fetch(`/admin/api/calib/preview?batch_id=${encodeURIComponent(batchId)}`);
      const j = await res.json();
      requestSec = (performance.now() - t0)/1000;
      if(!j.success) throw new Error(j.error_message||'预览数据拉取失败');
      model = j.data.model || {};
    } catch(err){
      clearInterval(overlayTimer);
      if(overlay){
        overlay.innerHTML = `<div style="text-align:center; color:#b91c1c;">
          <strong>加载失败：</strong>${(err && err.message) || err}<br/>
          请稍后重试或检查后端日志。
        </div>`;
      }
      return;
    }
  
    await loadECharts();
  
    const centers = model.centers_hz || [];
    const finalBands = Array.isArray(model.band_models_pchip) ? model.band_models_pchip : [];
    const calib = model.calibration || {};
    const rpmMin = model.rpm_min ?? (calib?.calib_model?.x0 ?? 1500);
    const rpmMax = model.rpm_max ?? (calib?.calib_model?.x1 ?? 4500);
    const npo = calib.n_per_oct || 12;
    const {f2} = bandEdgesFromCenters(centers, npo);
  
    const ec = echarts.init(document.getElementById('calibChart'), null, { renderer:'canvas', devicePixelRatio: window.devicePixelRatio||1 });
    const ecCounts = echarts.init(document.getElementById('countsChart'), null, { renderer:'canvas', devicePixelRatio: window.devicePixelRatio||1 });
  
    const rpmInput = document.getElementById('calibRpmInput');
    const rpmRange = document.getElementById('calibRpmRange');
    rpmInput.min = Math.floor(rpmMin); rpmInput.max = Math.ceil(rpmMax); rpmInput.step='1';
    rpmRange.min = rpmInput.min; rpmRange.max = rpmInput.max; rpmRange.step='1';
  
    function renderInfoGrid(frontRenderSec){
      const infoEl = document.getElementById('calibInfoGrid');
      if(!infoEl) return;
      const version = String(model.version||'');
      const modelType = version.includes('sweep') ? 'sweep' : 'anchor-only';
      const aw = calib.sweep_auto_widen || {};
      const binStr = (model.rpm_bin!=null)
        ? `${model.rpm_bin}${aw.applied ? ' (auto_widen)' : ''}`
        : 'n/a';
    
      let countsSummary='n/a';
      if(Array.isArray(model.counts_per_bin) && model.counts_per_bin.length){
        const arr = model.counts_per_bin.map(Number).filter(Number.isFinite);
        if(arr.length){
          const sum=arr.reduce((a,b)=>a+b,0);
          const s2=arr.slice().sort((a,b)=>a-b);
          const mid=s2[Math.floor(s2.length/2)];
          countsSummary=`tot=${sum}, med=${mid}, min=${s2[0]}, max=${s2[s2.length-1]}`;
        }
      }
    
      let bladeVal = 'n/a';
      if(Number.isFinite(calib.fan_blades) && calib.fan_blades>0){
        bladeVal = String(calib.fan_blades);
      }else if (calib.harmonics && Number.isFinite(calib.harmonics.n_blade) && calib.harmonics.n_blade>0){
        bladeVal = String(calib.harmonics.n_blade);
      }
    
      const rows = [
        ['模型类型', `${modelType} (${version})`],
        ['频带数', String(centers.length)],
        ['RPM范围', `${Math.round(rpmMin)} – ${Math.round(rpmMax)}`],
        ['分箱宽度', binStr],
        ['分箱计数', countsSummary],
        ['会话环境LAeq', (calib.laeq_env_db!=null) ? `${Number(calib.laeq_env_db).toFixed(2)} dB` : 'n/a'],
        ['谐波开关', (calib.harmonics_enabled === true) ? 'ON' : 'OFF'],
        ['叶片数', bladeVal],
        ['rpm_invert', `${calib?.rpm_invert?.mode || 'unknown'} (final=${calib?.rpm_invert?.track_final || '-'})`],
        ['请求耗时(前端测)', requestSec!=null ? `${requestSec.toFixed(2)} s` : 'n/a'],
        ['前端图表渲染', frontRenderSec!=null ? `${frontRenderSec.toFixed(2)} s` : 'n/a']
      ];
      infoEl.innerHTML = rows.map(([k,v]) =>
        `<div style="display:flex; justify-content:space-between; align-items:center; padding:2px 0;">
          <span style="opacity:.7;">${k}</span>
          <span style="font-weight:600;">${v}</span>
        </div>`
      ).join('');
    }
  
    (function renderCounts(){
      const xs = (model.rpm_grid_centers || []).map(Number);
      const ys = (model.counts_per_bin || []).map(Number);
      if(!xs.length || !ys.length){ ecCounts.clear(); return; }
      const maxY = Math.max(...ys,1);
      ecCounts.setOption({
        backgroundColor:'transparent', animation:false,
        grid:{ left:50, right:18, top:8, bottom:22 },
        xAxis:{
          type:'value', min:Math.min(...xs), max:Math.max(...xs),
          axisLabel:{ formatter:(v)=>`${Math.round(v)}` }, name:'RPM', nameLocation:'middle', nameGap:18
        },
        yAxis:{ type:'value', min:0, max:maxY, axisLabel:{ show:false }, splitLine:{ show:false } },
        series:[{
          name:'counts', type:'bar',
          data: xs.map((x,i)=>[x, ys[i]||0]),
          itemStyle:{
            color:(p)=>{
              const v=p.value[1]/maxY;
              const r=Math.round(255*(1-v));
              const g=Math.round(200*v);
              return `rgb(${r},${g},120)`;
            }
          }
        }],
        tooltip:{ trigger:'axis', axisPointer:{ type:'shadow' },
          formatter:(items)=>{
            const it = Array.isArray(items)? items[0]:items;
            return `RPM ${Math.round(it.value[0])}<br/>count ${it.value[1]}`;
          }
        }
      }, true);
    })();
  
    function renderTimings(){
      const el = document.getElementById('timingGrid');
      if(!el) return;
      const t = (calib.timings || {});
      const cal = t.calibration_phase || {};
      const sw  = t.sweep_phase || {};
      const fmt = (v)=> (typeof v==='number' && isFinite(v)) ? `${v.toFixed(2)} s` : '-';
    
      const rows = [
        ['总体(后端汇总)', (typeof t.overall_sec==='number') ? `${t.overall_sec.toFixed(2)} s` : '-'],
      
        ['— 校准阶段：env绝对刻度', fmt(cal.env_abs_scale_sec)],
        ['— 校准阶段：env帧滤波', fmt(cal.env_frames_sec)],
        ['— 校准阶段：env聚合/基线', fmt(cal.env_agg_sec)],
        ['— 校准阶段：短录音(full)', fmt(cal.short_full_sec)],
        ['— 校准阶段：短录音帧滤波', fmt(cal.short_frames_sec)],
        ['— 校准阶段：短录音聚合', fmt(cal.short_agg_sec)],
        ['— 校准阶段：文件数/帧数/频带', `${cal.files_env||0}+${cal.files_short||0} 文件 / ${(cal.env_frames_total||0)+(cal.short_frames_total||0)} 帧 / ${cal.bands||'-'} 带`],
      
        ['— sweep：读原始音频', fmt(sw.read_raw_sec)],
        ['— sweep：整段LAeq', fmt(sw.full_la_sec)],
        ['— sweep：读裁剪音频', fmt(sw.read_proc_sec)],
        ['— sweep：帧级滤波', fmt(sw.frames_filter_sec)],
        ['— sweep：反演(LA-only)', fmt(sw.invert_la_sec)],
        ['— sweep：反演(Hybrid)', fmt(sw.invert_hybrid_sec)],
        ['— sweep：轨迹后处理', fmt(sw.post_process_sec)],
        ['— sweep：分箱/统计', fmt(sw.binning_sec)],
        ['— sweep：谐波建模', fmt(sw.harmonics_sec)],
        ['— sweep：Δ烘焙', fmt(sw.delta_bake_sec)],
        ['— sweep：帧/频带', `${sw.frames||0} 帧 / ${sw.bands||0} 带`],
        ['— sweep：阶段小计', fmt(sw.total_sec)]
      ];
    
      el.innerHTML = rows.map(([k,v]) =>
        `<div style="display:flex; justify-content:space-between; align-items:center; padding:2px 0;">
          <span style="opacity:.7;">${k}</span>
          <span style="font-weight:600;">${v}</span>
        </div>`
      ).join('');
    }
  
    function renderSpectrum(rpm){
      const spec = spectrumFromBandModels(finalBands, centers, rpm);
      const harm = calib.harmonics || {};
      const harmonicsEnabled = (calib.harmonics_enabled === true) && harm && harm.n_blade>0;
      const Es = new Array(centers.length).fill(0);
      for(let i=0;i<centers.length;i++){
        const y = spec[i][1];
        Es[i] = (y!=null && Number.isFinite(y)) ? Math.pow(10, y/10) : 0.0;
      }
      if(harmonicsEnabled){
        const nBlade = Number(harm.n_blade)||0;
        const sigmaB = Number(harm?.kernel?.sigma_bands)||0.25;
        const topk = Number(harm?.kernel?.topk)||3;
        const bpf = nBlade * (Number(rpm)/60.0);
        const {f1, f2} = bandEdgesFromCenters(centers, npo);
        for(const item of (harm.models||[])){
          const mdl = item?.amp_pchip_db;
          const h = Number(item?.h)||0;
          if(!mdl || !h) continue;
          const Lh = evalPchip(mdl, Number(rpm));
          if(!Number.isFinite(Lh)) continue;
          const Eh = Math.pow(10, Lh/10);
          const fLine = h*bpf;
          for(const [k,w] of distributeLineToBands(fLine, centers, f1, f2, sigmaB, topk)){
            Es[k] += Eh*w;
          }
        }
      }
      const E_sum = Es.reduce((a,b)=>a+b,0);
      const laSynth = (E_sum>0) ? 10*Math.log10(E_sum) : NaN;
      document.getElementById('laCompositeVal').textContent = Number.isFinite(laSynth) ? laSynth.toFixed(2) : '-';
    
      let deltaDb = null;
      if(calib.laeq_correction_db_pchip){
        const d = evalPchip(calib.laeq_correction_db_pchip, Number(rpm));
        if(Number.isFinite(d)) deltaDb = d;
      }
      document.getElementById('deltaVal').textContent = (deltaDb!=null) ? (deltaDb>=0?`+${deltaDb.toFixed(2)}`:deltaDb.toFixed(2)) : '-';
    
      const specClosed = centers.map((c,i)=> [c, Es[i]>0 ? 10*Math.log10(Es[i]) : null]);
      const ys = specClosed.map(p=>p[1]).filter(v=>v!=null && Number.isFinite(v));
      let yMin=-10,yMax=10;
      if(ys.length){
        yMin=Math.min(...ys); yMax=Math.max(...ys);
        const pad = Math.max(2, 0.05*(yMax - yMin || 1));
        yMin = Math.floor(yMin - pad);
        yMax = Math.ceil(yMax + pad);
        if(yMax - yMin < 6) yMax = yMin + 6;
      }
      ec.setOption({
        backgroundColor:'transparent', animation:false,
        title:{ text:`Spectrum @ ${Math.round(rpm)} RPM`, left:'center', top:6 },
        grid:{ left:58, right:24, top:36, bottom:52 },
        legend:{ show:false },
        xAxis:{
          type:'log', logBase:10,
          min: centers[0] ?? 20, max: centers[centers.length-1] ?? 20000,
          name:'Hz', nameLocation:'middle', nameGap:28,
          axisLabel:{ formatter:(v)=>formatHz(v) },
          minorTick:{show:true}, minorSplitLine:{show:true}
        },
        yAxis:{ type:'value', min:yMin, max:yMax, name:'dB' },
        series:[
          { name:'spectrum', type:'line', showSymbol:false, connectNulls:true,
            lineStyle:{ width:2.2, color:'#2563eb' }, data: specClosed },
          { name:'points', type:'scatter', symbolSize:3,
            itemStyle:{ color:'#2563eb' },
            data: specClosed.filter(([,y])=>y!=null) }
        ],
        tooltip:{
          trigger:'axis', axisPointer:{ type:'cross' },
          formatter:(items)=>{
            const line = (Array.isArray(items)? items: [items]).find(p=>p.seriesType==='line');
            if(!line) return '';
            return specClosed
              .filter(p=>p[1]!=null)
              .map(p=>`${formatHz(p[0])} Hz / ${p[1].toFixed(2)} dB`)
              .join('<br/>');
          }
        }
      }, true);
      ec.resize();
    }
  
    function setRPM(v){
      const rpm = Math.max(rpmMin, Math.min(rpmMax, Number(v)||rpmMin));
      rpmInput.value = String(Math.round(rpm));
      rpmRange.value = String(Math.round(rpm));
      renderSpectrum(rpm);
    }
  
    // 初次渲染计时（前端）
    const renderStart = performance.now();
    if(!centers.length || finalBands.length===0){
      clearInterval(overlayTimer);
      if(overlay){
        overlay.innerHTML = `<div style="text-align:center; color:#b45309;">
          频谱模型为空：请检查数据与参数。
        </div>`;
      }
      renderInfoGrid(null);
      renderTimings();
      return;
    }
  
    setRPM(Math.round((rpmMin+rpmMax)/2));
    const frontRenderSec = (performance.now() - renderStart)/1000;
    renderInfoGrid(frontRenderSec);
    renderTimings();
  
    clearInterval(overlayTimer);
    if(overlay && overlay.parentNode){
      overlay.parentNode.removeChild(overlay);
    }
  
    (function attachAutoResize(){
      const kick = () => {
        const ec1 = echarts.getInstanceByDom(document.getElementById('calibChart')); ec1 && ec1.resize();
        const ec2 = echarts.getInstanceByDom(document.getElementById('countsChart')); ec2 && ec2.resize();
      };
      requestAnimationFrame(kick); setTimeout(kick,50); setTimeout(kick,200);
      window.addEventListener('orientationchange', kick);
      window.addEventListener('pageshow', kick);
      window.addEventListener('resize', kick, {passive:true});
      try {
        const ro1 = new ResizeObserver(kick); ro1.observe(document.getElementById('calibChart'));
        const ro2 = new ResizeObserver(kick); ro2.observe(document.getElementById('countsChart'));
      } catch(e){}
    })();
  
    rpmInput.addEventListener('input', ()=> setRPM(rpmInput.value));
    rpmInput.addEventListener('change', ()=> setRPM(rpmInput.value));
    rpmRange.addEventListener('input', ()=> setRPM(rpmRange.value));
  };

  window.CalibPreview = CalibPreview;
})();