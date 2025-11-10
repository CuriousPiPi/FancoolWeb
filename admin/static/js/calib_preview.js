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

  CalibPreview.show = async function({ mount, batchId }){
    const container = (typeof mount==='string')? document.querySelector(mount) : mount;
    if(!container) throw new Error('mount container not found');
    if(!batchId) throw new Error('batchId required');

    container.innerHTML = `
      <div class="panel" style="margin-top:10px;">
        <h4 style="margin:0 0 8px;">频谱预览</h4>
        <div id="calibChart" style="width:100%; height:340px;"></div>
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
        <div id="countsChart" style="width:100%; height:100px;"></div>
      </div>

      <div class="panel" style="margin-top:12px;">
        <h4 style="margin:0 0 8px;">模型基础参数</h4>
        <div id="calibInfoGrid" style="display:grid; grid-template-columns: 1fr 1fr; gap:6px 16px;"></div>
      </div>
    `;

    const res = await fetch(`/admin/api/calib/preview?batch_id=${encodeURIComponent(batchId)}`);
    const j = await res.json();
    if(!j.success) throw new Error(j.error_message||'预览数据拉取失败');
    const model = j.data.model || {};
    await loadECharts();

    const centers = model.centers_hz || [];
    const finalBands = Array.isArray(model.band_models_pchip) ? model.band_models_pchip : [];
    if(!centers.length || finalBands.length===0){
      const el = document.getElementById('calibChart');
      el.innerHTML='';
      const warn = document.createElement('div');
      warn.className='hint';
      warn.style.marginTop='8px';
      warn.textContent='频谱模型为空：请检查数据与参数。';
      el.parentNode.appendChild(warn);
      return;
    }

    const calib = model.calibration || {};
    const rpmMin = model.rpm_min ?? (calib?.calib_model?.x0 ?? 1500);
    const rpmMax = model.rpm_max ?? (calib?.calib_model?.x1 ?? 4500);
    const npo = calib.n_per_oct || 12;
    const {f1, f2} = bandEdgesFromCenters(centers, npo);

    // 图实例
    const ec = echarts.init(document.getElementById('calibChart'), null, { renderer:'canvas', devicePixelRatio: window.devicePixelRatio||1 });
    const ecCounts = echarts.init(document.getElementById('countsChart'), null, { renderer:'canvas', devicePixelRatio: window.devicePixelRatio||1 });

    // RPM 控件
    const rpmInput = document.getElementById('calibRpmInput');
    const rpmRange = document.getElementById('calibRpmRange');
    rpmInput.min = Math.floor(rpmMin); rpmInput.max = Math.ceil(rpmMax); rpmInput.step='1';
    rpmRange.min = rpmInput.min; rpmRange.max = rpmInput.max; rpmRange.step='1';

    // 合成显示区
    const laCompositeVal = document.getElementById('laCompositeVal');
    const deltaVal = document.getElementById('deltaVal');

    // Info 面板
    (function renderInfoGrid(){
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

      // 叶片数读取顺序：calibration.fan_blades -> calibration.harmonics.n_blade -> n/a
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
        ['rpm_invert', `${calib?.rpm_invert?.mode || 'unknown'} (final=${calib?.rpm_invert?.track_final || '-'})`]
      ];
      infoEl.innerHTML = rows.map(([k,v]) =>
        `<div style="display:flex; justify-content:space-between; align-items:center; padding:2px 0;">
           <span style="opacity:.7;">${k}</span>
           <span style="font-weight:600;">${v}</span>
         </div>`
      ).join('');
    })();

    // 分箱覆盖
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

    function render(rpm){
      // 频谱（基础烘焙后）
      const spec = spectrumFromBandModels(finalBands, centers, rpm);

      // 谐波注入
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

      // 合成 LAeq
      const E_sum = Es.reduce((a,b)=>a+b,0);
      const laSynth = (E_sum>0) ? 10*Math.log10(E_sum) : NaN;
      laCompositeVal.textContent = Number.isFinite(laSynth) ? laSynth.toFixed(2) : '-';

      // Δ 校正
      let deltaDb = null;
      if(calib.laeq_correction_db_pchip){
        const d = evalPchip(calib.laeq_correction_db_pchip, Number(rpm));
        if(Number.isFinite(d)) deltaDb = d;
      }
      deltaVal.textContent = (deltaDb!=null) ? (deltaDb>=0?`+${deltaDb.toFixed(2)}`:deltaDb.toFixed(2)) : '-';

      // 转回 dB 频谱
      const specClosed = centers.map((c,i)=> [c, Es[i]>0 ? 10*Math.log10(Es[i]) : null]);

      // y 轴范围
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
          {
            name:'spectrum', type:'line', showSymbol:false, connectNulls:true,
            lineStyle:{ width:2.2, color:'#2563eb' },
            data: specClosed
          },
          {
            name:'points', type:'scatter', symbolSize:3,
            itemStyle:{ color:'#2563eb' },
            data: specClosed.filter(([,y])=>y!=null)
          }
        ],
        tooltip:{
          trigger:'axis', axisPointer:{ type:'cross' },
          formatter:(items)=>{
            const pts = Array.isArray(items)? items: [items];
            const line = pts.find(p=>p.seriesType==='line') || pts[0];
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
      let rpm = Math.max(rpmMin, Math.min(rpmMax, Number(v)||rpmMin));
      rpmInput.value = String(Math.round(rpm));
      rpmRange.value = String(Math.round(rpm));
      render(rpm);
    }

    // Resize 监听
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

    setRPM(Math.round((rpmMin+rpmMax)/2));
  };

  window.CalibPreview = CalibPreview;
})();