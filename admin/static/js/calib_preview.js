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

  function levelFromSpectrum(points){
    let s=0;
    for(const [,y] of points){ if(y!=null && Number.isFinite(y)) s+=Math.pow(10,y/10); }
    return s>0 ? 10*Math.log10(s) : null;
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
        <div style="display:flex; gap:8px; align-items:center; margin-top:8px;">
          <label for="calibRpmInput">RPM</label>
          <input id="calibRpmInput" type="number" step="1" style="width:120px;" />
          <input id="calibRpmRange" type="range" style="flex:1 1 auto;" />
          <input id="calibDBA" type="text" readonly style="width:160px;" placeholder="dBA" />
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
                 'rpm_range =', model.rpm_min, model.rpm_max,
                 'note: check env/ & Rxxxx structure, AWA LAeq parse, and snr_ratio_min param');
    el.innerHTML = '';
    const warn = document.createElement('div');
    warn.className = 'hint';
    warn.style.marginTop = '8px';
    warn.textContent = '频谱模型为空：请检查 zip 是否包含 env/ 与 Rxxxx 目录及 .AWA，或尝试调低 snr_ratio_min（当前参数可能过严）。';
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
    const freqs = model.centers_hz || [];
    const xMin = freqs[0] ?? 20, xMax = freqs[freqs.length-1] ?? 20000;
    // RPM 范围
    const rpmMin = model.rpm_min ?? (model.calibration?.calib_model?.x0 ?? 1500);
    const rpmMax = model.rpm_max ?? (model.calibration?.calib_model?.x1 ?? 4500);

    const rpmInput = document.getElementById('calibRpmInput');
    const rpmRange = document.getElementById('calibRpmRange');
    const dbaOut = document.getElementById('calibDBA');
    rpmInput.min = Math.floor(rpmMin); rpmInput.max = Math.ceil(rpmMax); rpmInput.step='1';
    rpmRange.min = rpmInput.min; rpmRange.max = rpmInput.max; rpmRange.step='1';

    // 2) 解决初始渲染收缩成一条线：绑定 ResizeObserver，并在多帧触发 resize
    (function attachAutoResize() {
      try {
        const ro = new ResizeObserver(() => { ec && ec.resize(); });
        ro.observe(el);
        if (el.parentElement) ro.observe(el.parentElement);
      } catch(e) { /* 某些旧浏览器无 ResizeObserver 时忽略 */ }
      const kick = () => { ec && ec.resize(); };
      requestAnimationFrame(kick);
      setTimeout(kick, 50);
      setTimeout(kick, 200);
      window.addEventListener('orientationchange', kick);
      window.addEventListener('pageshow', kick);
    })();

    // 3) render(rpm) 中固定 y 轴范围：min=0，max 使用 yMaxGlobal（不随滑块变化）
    function render(rpm){
      const spec = spectrumAtRPMRaw(model, rpm).map(([f,y])=>[f, (y!=null? Math.max(0,y): null)]);
      const valid = spec.filter(([,y])=>y!=null);
      const opt = {
        backgroundColor:'transparent', animation:false,
        title:{ text:`Spectrum @ ${Math.round(rpm)} RPM`, left:'center', top:6 },
        grid:{ left:58, right:24, top:36, bottom:52 },
        xAxis:{
          type:'log', logBase:10, min:xMin, max:xMax, name:'Hz', nameLocation:'middle', nameGap:28,
          axisLabel:{ formatter:(v)=>formatHz(v) }, minorTick:{show:true}, minorSplitLine:{show:true}
        },
        yAxis:{ type:'value', min:0, max:yMaxGlobal, name:'dB' }, // 固定纵轴上限
        series:[
          { name:'spectrum', type:'line', showSymbol:false, connectNulls:true, lineStyle:{ width:2.0, color:'#2563eb' }, data: spec },
          { name:'points', type:'scatter', symbolSize:4, itemStyle:{ color:'#2563eb' }, data: valid }
        ],
        tooltip:{
          trigger:'axis', axisPointer:{ type:'cross' },
          formatter:(p)=>{ const pt = Array.isArray(p)? p.find(x=>x.seriesName==='spectrum'):p; if(!pt) return ''; const f=pt.value?.[0], y=pt.value?.[1]; return `${formatHz(f)} Hz<br/>${(y!=null)? y.toFixed(2) : '-' } dB`; }
        }
      };
      ec.setOption(opt, true);
      ec.resize(); // 防止第一次 setOption 后仍未铺满
      const la = levelFromSpectrum(spec);
      dbaOut.value = (la!=null)? `${la.toFixed(2)} dBA` : '-';
    }

    function setRPM(v){
      let rpm = Math.max(rpmMin, Math.min(rpmMax, Number(v)||rpmMin));
      rpmInput.value = String(Math.round(rpm));
      rpmRange.value = String(Math.round(rpm));
      render(rpm);
    }

    rpmInput.addEventListener('input', ()=> setRPM(rpmInput.value));
    rpmInput.addEventListener('change', ()=> setRPM(rpmInput.value));
    rpmRange.addEventListener('input', ()=> setRPM(rpmRange.value));

    setRPM(Math.round((rpmMin+rpmMax)/2));
    window.addEventListener('resize', ()=> ec && ec.resize(), { passive:true });
  };

  window.CalibPreview = CalibPreview;
})();