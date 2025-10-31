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

  function getBandModels(model, useSmoothed){
    const sm = model.band_models_pchip;
    const pre = model.band_models_pchip_pre;
    if(useSmoothed || !Array.isArray(pre)) return Array.isArray(sm)? sm : [];
    return pre;
  }

  function spectrumAtRPMRaw(bandModels, centers, rpm){
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
            <label for="calibDBADiff" style="white-space:nowrap;">Δ</label>
            <input id="calibDBADiff" type="text" readonly style="width:90px;" placeholder="Δ dB" />
          </div>
          <label style="display:flex; align-items:center; gap:6px; margin-left:8px; white-space:nowrap;">
            <input id="calibSmoothToggle" type="checkbox" checked />
            平滑后
          </label>
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
  }

  function fmt(val, digits=2){
    const n = Number(val);
    if (!Number.isFinite(n)) return 'n/a';
    return n.toFixed(digits);
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

    // 主图
    const el = document.getElementById('calibChart');
    const centers = model.centers_hz || [];
    const bandsSm = Array.isArray(model.band_models_pchip) ? model.band_models_pchip : [];
    const bandsPre = Array.isArray(model.band_models_pchip_pre) ? model.band_models_pchip_pre : [];
    const anyBand = (bandsSm.some(p => p && Array.isArray(p.x) && p.x.length>0) ||
                     bandsPre.some(p => p && Array.isArray(p.x) && p.x.length>0));
    if (!centers.length || !anyBand){
      console.warn('[calib preview] empty model.');
      el.innerHTML = '';
      const warn = document.createElement('div');
      warn.className = 'hint';
      warn.style.marginTop = '8px';
      warn.textContent = '频谱模型为空：请检查 env/ 与 Rxxxx 目录及 .AWA，或尝试调低 snr_ratio_min。';
      el.parentNode.appendChild(warn);
      return;
    }
    const ec = echarts.init(el, null, { renderer: 'canvas', devicePixelRatio: window.devicePixelRatio||1 });

    // counts 覆盖图
    const countsEl = document.getElementById('countsChart');
    const ecCounts = echarts.init(countsEl, null, { renderer: 'canvas', devicePixelRatio: window.devicePixelRatio||1 });

    // RPM 范围
    const rpmMin = model.rpm_min ?? (model.calibration?.calib_model?.x0 ?? 1500);
    const rpmMax = model.rpm_max ?? (model.calibration?.calib_model?.x1 ?? 4500);

    const rpmInput = document.getElementById('calibRpmInput');
    const rpmRange = document.getElementById('calibRpmRange');
    const smoothToggle = document.getElementById('calibSmoothToggle');
    const dbaOut = document.getElementById('calibDBA');
    const dbaDiffOut = document.getElementById('calibDBADiff');

    rpmInput.min = Math.floor(rpmMin); rpmInput.max = Math.ceil(rpmMax); rpmInput.step='1';
    rpmRange.min = rpmInput.min; rpmRange.max = rpmInput.max; rpmRange.step='1';

    if (!bandsPre.length) {
      smoothToggle.checked = true;
      smoothToggle.disabled = true;
      smoothToggle.title = '无平滑前数据';
    }

    const npo = model?.calibration?.n_per_oct || 12;
    const {f1, f2} = bandEdgesFromCenters(centers, npo);

    // 基础参数面板（新增 sweep 参数显示）
    (function renderInfoGrid(){
      const infoEl = document.getElementById('calibInfoGrid');
      if (!infoEl) return;

      const rpmMin0 = model.rpm_min ?? (model.calibration?.calib_model?.x0 ?? null);
      const rpmMax0 = model.rpm_max ?? (model.calibration?.calib_model?.x1 ?? null);
      const c = model.calibration || {};
      const sp = c.sweep_params || {};
      const version = String(model.version || '');
      const modelType = version.includes('sweep') ? 'sweep' : 'anchor-only';

      const aw = c.sweep_auto_widen || {};
      const binStr = (model.rpm_bin != null)
        ? `${model.rpm_bin}${aw.applied ? ' (auto_widen)' : ''}`
        : 'n/a';

      let countsSummary = 'n/a';
      if (Array.isArray(model.counts_per_bin) && model.counts_per_bin.length) {
        const arr = model.counts_per_bin.map(Number).filter(Number.isFinite);
        if (arr.length) {
          const sum = arr.reduce((a,b)=>a+b,0);
          const s2 = arr.slice().sort((a,b)=>a-b);
          const mid = s2[Math.floor(s2.length/2)];
          const min = s2[0], max = s2[s2.length-1];
          countsSummary = `tot=${sum}, med=${mid}, min=${min}, max=${max}`;
        }
      }

      const nBlade = (c?.harmonics?.n_blade != null) ? String(c.harmonics.n_blade) : 'n/a';

      const rows = [
        ['模型类型', `${modelType} (${version})`],
        ['频带数', String(centers.length)],
        ['RPM范围', (rpmMin0!=null && rpmMax0!=null) ? `${Math.round(rpmMin0)} – ${Math.round(rpmMax0)}` : 'n/a'],
        ['分箱宽度', binStr],
        ['分箱计数', countsSummary],
        ['会话环境LAeq', (c.laeq_env_db!=null) ? `${Number(c.laeq_env_db).toFixed(2)} dB` : 'n/a'],
        ['会话常量偏移Δ', (c.session_delta_db!=null) ? `${Number(c.session_delta_db).toFixed(2)} dB` : 'n/a'],
        ['Δ定义', c.session_delta_method || 'n/a'],
        ['n_per_oct', (c.n_per_oct!=null)? String(c.n_per_oct) : 'n/a'],
        ['叶片数', nBlade],                         // 修改处
        ['closure_mode', c.closure_mode || 'none'],
        ['谐波', (c.harmonics?.n_blade>0) ? `n_blade=${c.harmonics.n_blade}` : 'off'],
        ['sweep_bin_qf_percent', (sp.sweep_bin_qf_percent!=null)? `${sp.sweep_bin_qf_percent}` : 'n/a'],
        ['sweep_env_floor_dbA', (sp.sweep_env_floor_dbA!=null)? `${sp.sweep_env_floor_dbA}` : 'n/a']
      ];

      infoEl.innerHTML = rows.map(([k,v]) =>
        `<div style="display:flex; justify-content:space-between; align-items:center; padding:2px 0;">
           <span style="opacity:.75;">${k}</span>
           <span style="font-weight:600;">${v}</span>
         </div>`
      ).join('');
    })();

    // 分箱覆盖图渲染
    (function renderCounts(){
      const xs = (model.rpm_grid_centers || []).map(Number);
      const ys = (model.counts_per_bin || []).map(Number);
      if (!xs.length || !ys.length){ ecCounts.clear(); return; }
      const data = xs.map((x,i)=>[x, ys[i]||0]);
      const maxY = Math.max(...ys, 1);
      ecCounts.setOption({
        backgroundColor:'transparent', animation:false,
        grid:{ left:50, right:18, top:8, bottom:22 },
        xAxis:{
          type:'value', min:Math.min(...xs), max:Math.max(...xs),
          axisLabel:{ formatter:(v)=>`${Math.round(v)}` }, name:'RPM', nameLocation:'middle', nameGap:18
        },
        yAxis:{
          type:'value', min:0, max:maxY, axisLabel:{ show:false }, splitLine:{ show:false }
        },
        series:[{
          name:'counts', type:'bar', data,
          itemStyle:{
            color: (params)=>{
              const v = params.value[1]/maxY;
              const r = Math.round(255 * (1-v));
              const g = Math.round(200 * v);
              return `rgb(${r},${g},120)`;
            }
          }
        }],
        tooltip:{
          trigger:'axis', axisPointer:{ type:'shadow' },
          formatter:(items)=>{ const it = Array.isArray(items)? items[0]:items; return `RPM ${Math.round(it.value[0])}<br/>count ${it.value[1]}`; }
        }
      }, true);
    })();

    function render(rpm){
      const useSmoothed = !!smoothToggle.checked;
      const bandModels = getBandModels(model, useSmoothed);

      // 基线（dB→能量）
      const specRaw = spectrumAtRPMRaw(bandModels, centers, rpm);
      const Es = specRaw.map(([,y]) => (y!=null && Number.isFinite(y)) ? Math.pow(10, y/10) : 0.0);

      // 谐波注入
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
          const Eh = Math.pow(10, Lh/10);
          const fLine = h * bpf;
          const {f1, f2} = bandEdgesFromCenters(centers, model?.calibration?.n_per_oct || 12);
          for (const [k,w] of distributeLineToBands(fLine, centers, f1, f2, sigmaB, topk)) {
            Es[k] += Eh * w;
          }
        }
      }

      // 已烘焙闭合 → 不再额外缩放
      const specClosed = specRaw.map(([f, _y], i) => {
        const E = Es[i];
        return [f, (E>0 ? 10*Math.log10(E) : null)];
      });

      // 动态 y 轴
      const ys = specClosed.map(([,y])=>y).filter(v => v!=null && Number.isFinite(v));
      let yMin = -10, yMax = 10;
      if (ys.length){
        yMin = Math.min(...ys);
        yMax = Math.max(...ys);
        const pad = Math.max(2, 0.05*(yMax - yMin || 1));
        yMin = Math.floor(yMin - pad);
        yMax = Math.ceil(yMax + pad);
        if (yMax - yMin < 6) { yMax = yMin + 6; }
      }

      const valid = specClosed.filter(([,y])=>y!=null);
      const opt = {
        backgroundColor:'transparent', animation:false,
        title:{ text:`Spectrum @ ${Math.round(rpm)} RPM${useSmoothed?' (平滑后)':' (平滑前)'}`, left:'center', top:6 },
        grid:{ left:58, right:24, top:36, bottom:52 },
        xAxis:{
          type:'log', logBase:10, min: centers[0] ?? 20, max: centers[centers.length-1] ?? 20000,
          name:'Hz', nameLocation:'middle', nameGap:28,
          axisLabel:{ formatter:(v)=>formatHz(v) }, minorTick:{show:true}, minorSplitLine:{show:true}
        },
        yAxis:{ type:'value', min:yMin, max:yMax, name:'dB' },
        series:[
          { name:'spectrum', type:'line', showSymbol:false, connectNulls:true, lineStyle:{ width:2.0, color:'#2563eb' }, data: specClosed },
          { name:'points', type:'scatter', symbolSize:4, itemStyle:{ color:'#2563eb' }, data: valid }
        ],
        tooltip:{
          trigger:'axis', axisPointer:{ type:'cross' },
          formatter:(p)=>{ const pt = Array.isArray(p)? p.find(x=>x.seriesName==='spectrum'):p; if(!pt) return ''; const f=pt.value?.[0], y=pt.value?.[1]; return `${formatHz(f)} Hz<br/>${(y!=null)? y.toFixed(2) : '-' } dB`; }
        }
      };

      // 输出：合成 LAeq 与 Δ(R)
      const laSynthClosed = levelFromSpectrum(specClosed);
      dbaOut.value = (laSynthClosed!=null)? `${laSynthClosed.toFixed(2)} dBA` : '-';
        
      // Δ 直接来自校正曲线（闭合后相对闭合前）
      const corr = model?.calibration?.laeq_correction_db_pchip;
      let d = null;
      if (corr && Array.isArray(corr.x) && Array.isArray(corr.y) && Array.isArray(corr.m)) {
        const v = evalPchip(corr, Number(rpm));
        if (Number.isFinite(v)) d = v;
      }
      dbaDiffOut.value = (d!=null) ? `${(d>=0?'+':'')}${d.toFixed(2)} dB` : '';
      dbaDiffOut.style.color = (d!=null && Math.abs(d)>0.1) ? '#b91c1c' : '';
    
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
      const kick = () => {
        const ec1 = echarts.getInstanceByDom(document.getElementById('calibChart')); ec1 && ec1.resize();
        const ec2 = echarts.getInstanceByDom(document.getElementById('countsChart')); ec2 && ec2.resize();
      };
      requestAnimationFrame(kick); setTimeout(kick, 50); setTimeout(kick, 200);
      window.addEventListener('orientationchange', kick); window.addEventListener('pageshow', kick);
      window.addEventListener('resize', kick, { passive:true });
      try {
        const ro1 = new ResizeObserver(kick); ro1.observe(document.getElementById('calibChart'));
        const ro2 = new ResizeObserver(kick); ro2.observe(document.getElementById('countsChart'));
      } catch(e){}
    })();

    rpmInput.addEventListener('input', ()=> setRPM(rpmInput.value));
    rpmInput.addEventListener('change', ()=> setRPM(rpmInput.value));
    rpmRange.addEventListener('input', ()=> setRPM(rpmRange.value));
    document.getElementById('calibSmoothToggle').addEventListener('change', ()=> setRPM(rpmInput.value));

    setRPM(Math.round((rpmMin+rpmMax)/2));
  };

  window.CalibPreview = CalibPreview;
})();