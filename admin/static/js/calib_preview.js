(function(){
  const CalibPreview = {};
  const CDN = 'https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js';

  function loadECharts(){
    if(window.echarts) return Promise.resolve();
    return new Promise((resolve, reject)=>{
      const s = document.createElement('script');
      s.src = CDN; s.async = true; s.onload = ()=>resolve(); s.onerror=()=>reject(new Error('echarts load failed'));
      document.head.appendChild(s);
    });
  }

  function evalPchip(model, x){
    if(!model||!Array.isArray(model.x)||!Array.isArray(model.y)||!Array.isArray(model.m)) return NaN;
    const xs=model.x, ys=model.y, ms=model.m;
    const n=xs.length; if(n===0) return NaN; if(n===1) return ys[0];
    let xv=x; if(xv<=xs[0]) xv=xs[0]; if(xv>=xs[n-1]) xv=xs[n-1];
    let lo=0, hi=n-2, i=0;
    while(lo<=hi){ const mid=(lo+hi)>>1; if(xs[mid]<=xv && xv<=xs[mid+1]){ i=mid; break; } if(xv<xs[mid]) hi=mid-1; else lo=mid+1; }
    if(lo>hi) i=Math.max(0, Math.min(n-2, lo));
    const x0=xs[i], x1=xs[i+1], h=(x1-x0)||1, t=(xv-x0)/h;
    const y0=ys[i], y1=ys[i+1], m0=ms[i]*h, m1=ms[i+1]*h;
    const h00=2*t*t*t-3*t*t+1, h10=t*t*t-2*t*t+t, h01=-2*t*t*t+3*t*t, h11=t*t*t-t*t;
    return h00*y0 + h10*m0 + h01*y1 + h11*m1;
  }

  // 基线频带 dB → dB 列表（可能含 null）
  function spectrumAtRPMRaw(model, rpm){
    const freqs=model.centers_hz||[], bands=model.band_models_pchip||[];
    const out=new Array(freqs.length);
    for(let i=0;i<freqs.length;i++){
      const p=bands[i]||null;
      let y=null;
      if(p && Array.isArray(p.x)&&Array.isArray(p.y)&&Array.isArray(p.m)){
        const v=evalPchip(p, rpm);
        if(Number.isFinite(v)) y=v;
      }
      out[i]=[freqs[i], y];
    }
    return out;
  }

  // n/倍频程相关
  function bandsPerDecadeFromNpo(npo){
    return Math.round((npo*10.0)/3.0);
  }
  function bandEdgesFromCenters(centers, npo){
    const bpd=bandsPerDecadeFromNpo(npo);
    const g = Math.pow(10, 1.0/(2.0*bpd));
    const f1=[], f2=[];
    for(const c of centers){
      f1.push(c/g); f2.push(c*g);
    }
    return {f1, f2};
  }

  // 谐波注入：将单条线谱能量分配到若干邻带（对数频率高斯核）
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

  function levelFromSpectrum(points){
    let s=0;
    for(const [,y] of points){ if(y!=null && Number.isFinite(y)) s+=Math.pow(10,y/10); }
    return s>0 ? 10*Math.log10(s) : null;
  }

  function laeqFromCalibModel(model, rpm){
    const cm = model?.calibration?.calib_model;
    if(!cm) return null;
    const v = evalPchip(cm, rpm);
    return Number.isFinite(v) ? v : null;
  }

  function formatHz(v){
    const n=Number(v);
    if(!Number.isFinite(n)) return '';
    if(n>=1000){ const k=n/1000; return (k>=100?Math.round(k):(k>=10?k.toFixed(1):k.toFixed(2)))+'k'; }
    if(n>=100) return String(Math.round(n));
    if(n>=10) return n.toFixed(1);
    return n.toFixed(2);
  }

  function buildUI(container){
    container.innerHTML = `
      <div class="panel" style="margin-top:10px;">
        <h4 style="margin:0 0 8px;">频谱预览</h4>
        <div id="calibChart" style="width:100%; height:320px;"></div>
        <div style="display:flex; gap:8px; align-items:center; margin-top:8px; flex-wrap:wrap;">
          <label for="calibRpmInput">RPM</label>
          <input id="calibRpmInput" type="number" step="1" style="width:120px;" />
          <input id="calibRpmRange" type="range" style="flex:1 1 auto; min-width:200px;" />
          <div style="display:flex; gap:6px; align-items:center;">
            <label for="calibDBA" style="white-space:nowrap;">合成LAeq</label>
            <input id="calibDBA" type="text" readonly style="width:120px;" placeholder="dBA(合成)" />
          </div>
          <div style="display:flex; gap:6px; align-items:center;">
            <label for="calibDBAFit" style="white-space:nowrap;">拟合LAeq</label>
            <input id="calibDBAFit" type="text" readonly style="width:120px;" placeholder="dBA(拟合)" />
          </div>
          <div style="display:flex; gap:6px; align-items:center;">
            <label for="calibDBADiff" style="white-space:nowrap;">Δ</label>
            <input id="calibDBADiff" type="text" readonly style="width:90px;" placeholder="Δ dB" />
          </div>
        </div>
      </div>
    `;
  }

  CalibPreview.show = async function({ mount, batchId }){
    const container = (typeof mount==='string')? document.querySelector(mount) : mount;
    if(!container) throw new Error('mount container not found');
    if(!batchId) throw new Error('batchId required');

    buildUI(container);
    const res = await fetch(`/admin/api/calib/preview?batch_id=${encodeURIComponent(batchId)}`);
    const j = await res.json();
    if(!j.success) throw new Error(j.error_message||'预览数据拉取失败');

    const model = j.data.model || {};
    await loadECharts();
    const el = document.getElementById('calibChart');

    // 关键：排查空图
    const centers = model.centers_hz || [];
    const bands   = model.band_models_pchip || [];
    const anyBand = bands.some(p => p && Array.isArray(p.x) && p.x.length>0);
    if (!centers.length || !anyBand){
      console.warn('[calib preview] empty model. centers_hz len =', centers.length,
                   'bands valid =', bands.filter(p=>p&&Array.isArray(p.x)&&p.x.length>0).length,
                   'rpm_range =', model.rpm_min, model.rpm_max);
      el.innerHTML = '';
      const warn = document.createElement('div');
      warn.className = 'hint';
      warn.style.marginTop = '8px';
      warn.textContent = '频谱模型为空：请检查 env/ 与 Rxxxx 目录及 .AWA，或尝试调低 snr_ratio_min。';
      el.parentNode.appendChild(warn);
      return;
    }

    const ec = echarts.init(el, null, { renderer: 'canvas', devicePixelRatio: window.devicePixelRatio||1 });

    let yMaxGlobal = 100;
    {
      let gmax = 0;
      for (const p of (model.band_models_pchip || [])) {
        if (p && Array.isArray(p.y)) {
          for (const val of p.y) {
            if (Number.isFinite(val)) gmax = Math.max(gmax, val);
          }
        }
      }
      yMaxGlobal = Math.max(0, Math.ceil(gmax));
    }

    // 轴范围
    const xMin = centers[0] ?? 20, xMax = centers[centers.length-1] ?? 20000;
    // RPM 范围
    const rpmMin = model.rpm_min ?? (model.calibration?.calib_model?.x0 ?? 1500);
    const rpmMax = model.rpm_max ?? (model.calibration?.calib_model?.x1 ?? 4500);

    const rpmInput = document.getElementById('calibRpmInput');
    const rpmRange = document.getElementById('calibRpmRange');
    const dbaOut = document.getElementById('calibDBA');
    const dbaFitOut = document.getElementById('calibDBAFit');
    const dbaDiffOut = document.getElementById('calibDBADiff');

    rpmInput.min = Math.floor(rpmMin); rpmInput.max = Math.ceil(rpmMax); rpmInput.step='1';
    rpmRange.min = rpmInput.min; rpmRange.max = rpmInput.max; rpmRange.step='1';

    // 预计算带边
    const npo = model?.calibration?.n_per_oct || 12;
    const {f1, f2} = bandEdgesFromCenters(centers, npo);

    function render(rpm){
      // 1) 基线（dB → 能量）
      const specRaw = spectrumAtRPMRaw(model, rpm);
      const Es = specRaw.map(([,y]) => (y!=null && Number.isFinite(y)) ? Math.pow(10, y/10) : 0.0); // 以 P0^2 为 1

      // 2) 谐波注入
      const harm = model?.calibration?.harmonics || {};
      if (harm && harm.n_blade>0) {
        const nBlade = Number(harm.n_blade)||0;
        const sigmaB = Number(harm?.kernel?.sigma_bands)||0.25;
        const topk = Number(harm?.kernel?.topk)||3;
        const bpf = nBlade * (Number(rpm)/60.0);
        for (const item of (harm.models||[])) {
          const mdl = item?.amp_pchip_db; const h = Number(item?.h)||0;
          if (!mdl || !h) continue;
          const Lh = evalPchip(mdl, Number(rpm));
          if (!Number.isFinite(Lh)) continue;
          const Eh = Math.pow(10, Lh/10); // 仍以 P0^2 为 1
          const fLine = h * bpf;
          for (const [k,w] of distributeLineToBands(fLine, centers, f1, f2, sigmaB, topk)) {
            Es[k] += Eh * w;
          }
        }
      }

      // 3) 动态闭合（精准对齐拟合 LAeq）
      const laSynth = (Es.reduce((a,b)=>a+b,0) > 0) ? 10*Math.log10(Es.reduce((a,b)=>a+b,0)) : null;
      const laFit = laeqFromCalibModel(model, rpm);
      let delta = 0;
      if (laSynth!=null && laFit!=null) {
        delta = laFit - laSynth;
      }
      const scale = Math.pow(10, delta/10);
      const specClosed = specRaw.map(([f,y], i) => {
        const E = Es[i]*scale;
        return [f, (E>0 ? 10*Math.log10(E) : null)];
      });

      const valid = specClosed.filter(([,y])=>y!=null);
      const opt = {
        backgroundColor:'transparent', animation:false,
        title:{ text:`Spectrum @ ${Math.round(rpm)} RPM`, left:'center', top:6 },
        grid:{ left:58, right:24, top:36, bottom:52 },
        xAxis:{
          type:'log', logBase:10, min:xMin, max:xMax, name:'Hz', nameLocation:'middle', nameGap:28,
          axisLabel:{ formatter:(v)=>formatHz(v) }, minorTick:{show:true}, minorSplitLine:{show:true}
        },
        yAxis:{ type:'value', min:0, max:yMaxGlobal, name:'dB' },
        series:[
          { name:'spectrum', type:'line', showSymbol:false, connectNulls:true, lineStyle:{ width:2.0, color:'#2563eb' }, data: specClosed },
          { name:'points', type:'scatter', symbolSize:4, itemStyle:{ color:'#2563eb' }, data: valid }
        ],
        tooltip:{
          trigger:'axis', axisPointer:{ type:'cross' },
          formatter:(p)=>{ const pt = Array.isArray(p)? p.find(x=>x.seriesName==='spectrum'):p; if(!pt) return ''; const f=pt.value?.[0], y=pt.value?.[1]; return `${formatHz(f)} Hz<br/>${(y!=null)? y.toFixed(2) : '-' } dB`; }
        }
      };
      const laSynthClosed = levelFromSpectrum(specClosed);
      dbaOut.value   = (laSynthClosed!=null)? `${laSynthClosed.toFixed(2)} dBA` : '-';
      dbaFitOut.value = (laFit!=null)? `${laFit.toFixed(2)} dBA` : '-';
      const diff = (laSynthClosed!=null && laFit!=null)? (laSynthClosed - laFit) : null;
      dbaDiffOut.value = (diff!=null)? `${(diff>=0?'+':'')}${diff.toFixed(2)} dB` : '-';
      dbaDiffOut.style.color = (diff!=null && Math.abs(diff)>0.1) ? '#b91c1c' : '';

      const ec = echarts.getInstanceByDom(document.getElementById('calibChart'));
      ec.setOption(opt, true); ec.resize();
    }

    function setRPM(v){
      let rpm = Math.max(rpmMin, Math.min(rpmMax, Number(v)||rpmMin));
      rpmInput.value = String(Math.round(rpm));
      rpmRange.value = String(Math.round(rpm));
      render(rpm);
    }

    // 自适应 resize
    (function attachAutoResize() {
      const el = document.getElementById('calibChart');
      try { const ro = new ResizeObserver(() => { const ec = echarts.getInstanceByDom(el); ec && ec.resize(); }); ro.observe(el); if (el.parentElement) ro.observe(el.parentElement); } catch(e) {}
      const kick = () => { const ec = echarts.getInstanceByDom(el); ec && ec.resize(); };
      requestAnimationFrame(kick); setTimeout(kick, 50); setTimeout(kick, 200);
      window.addEventListener('orientationchange', kick); window.addEventListener('pageshow', kick);
      window.addEventListener('resize', kick, { passive:true });
    })();

    rpmInput.addEventListener('input', ()=> setRPM(rpmInput.value));
    rpmInput.addEventListener('change', ()=> setRPM(rpmInput.value));
    rpmRange.addEventListener('input', ()=> setRPM(rpmRange.value));

    setRPM(Math.round((rpmMin+rpmMax)/2));
  };

  window.CalibPreview = CalibPreview;
})();