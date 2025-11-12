const $ = s => document.querySelector(s);

// ===== 常量与标志 =====
const LS_KEY = 'admin_perf_draft_v2';
let suspendDraft = true;

// 顶部初始化：统一用 window 作用域
if (typeof window !== 'undefined') {
  window.lastCalibRunId = null;
  window.lastCalibModelHash = null;
  window.lastCalibBatchId = null;   // 新增：全局 audio_batch_id
}

// ===== Tabs =====
// 调整：切换到“工况管理”页签时，修正该页的行布局，避免“风阻位置”换行且占满整行
const tabs = document.querySelectorAll('.tab');
const panels = { upload: $('#panel-upload'), brand: $('#panel-brand'), model: $('#panel-model'), condition: $('#panel-condition') };
tabs.forEach(t => t.addEventListener('click', () => {
  tabs.forEach(x => x.classList.remove('active')); t.classList.add('active');
  const key = t.dataset.tab; Object.entries(panels).forEach(([k, el]) => el.style.display = (k === key ? '' : 'none'));
  if(key === 'brand'){ initBrandEditList(); }
  if(key === 'condition'){ initConditionEditList(); fixCondLayout(); } // 新增 fixCondLayout()
}));

/* ====================== 添加品牌 ====================== */
const brandForm = $('#brandForm'); const brandMsg = $('#brandMsg'); const brandSubmitBtn = $('#brandSubmitBtn');
if (brandForm) {
  brandForm.addEventListener('submit', async e => {
    e.preventDefault(); brandMsg.textContent=''; brandMsg.className=''; brandSubmitBtn.disabled=true;
    const zh=$('#zh').value.trim(), en=$('#en').value.trim();
    const brandIsValid = parseInt($('#brandIsValid')?.value || '0', 10);
    if(!zh||!en){ brandMsg.className='err'; brandMsg.textContent='中文与英文品牌名均为必填'; brandSubmitBtn.disabled=false; return; }
    try{
      const r=await fetch('/admin/api/data/brand/add',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({brand_name_zh:zh,brand_name_en:en, is_valid: brandIsValid})
      });
      const j=await r.json();
      if(j.success){ brandMsg.className='ok'; brandMsg.textContent=`添加成功，brand_id：${j.data.brand_id}`;}
      else{ brandMsg.className='err'; brandMsg.textContent=j.error_message||'提交失败';}
    }catch{ brandMsg.className='err'; brandMsg.textContent='网络或服务器错误'; } finally{ brandSubmitBtn.disabled=false; }
  });
}

/* ====================== 品牌管理：编辑 ====================== */
const bmAdd = $('#bmAdd'), bmEdit = $('#bmEdit');
const brandAddBox = $('#brandAddBox'), brandEditBox = $('#brandEditBox');
if(bmAdd && bmEdit){
  const updateBoxes=()=>{ const m = document.querySelector('input[name="brandMgmtMode"]:checked')?.value || 'add'; if(m==='add'){ brandAddBox.style.display=''; brandEditBox.style.display='none'; } else { brandAddBox.style.display='none'; brandEditBox.style.display=''; initBrandEditList(); } };
  bmAdd.addEventListener('change',updateBoxes); bmEdit.addEventListener('change',updateBoxes); updateBoxes();
}
const brandEditInput = $('#brandEditInput'), brandEditOptions = $('#brandEditOptions'), brandEditId = $('#brandEditId'), brandEditHint = $('#brandEditHint');
const brandEditForm = $('#brandEditForm'), brandEditZh=$('#brandEditZh'), brandEditEn=$('#brandEditEn'), brandEditIsValid=$('#brandEditIsValid');
const brandEditSubmitBtn = $('#brandEditSubmitBtn'), brandEditMsg=$('#brandEditMsg');
let brandAllCache = [];
async function initBrandEditList(){
  try{
    const r=await fetch('/admin/api/data/brand/all'); const j=await r.json();
    if(j.success){ brandAllCache = j.data.items||[]; brandEditOptions.innerHTML=''; brandAllCache.forEach(it=>{ const opt=document.createElement('option'); const status = (it.is_valid? '公开':'未公开'); opt.value = `${it.label} · ${status}`; opt.dataset.bid = it.brand_id; brandEditOptions.appendChild(opt); }); }
  }catch{}
}
function setBrandEditEnabled(en){
  if(en){ brandEditForm.classList.remove('disabled'); [...brandEditForm.querySelectorAll('input,select,button')].forEach(el=>el.disabled=false); }
  else { brandEditForm.classList.add('disabled'); [...brandEditForm.querySelectorAll('input,select,button')].forEach(el=>{ if(el.id!=='brandEditSubmitBtn') el.value=''; el.disabled=true; }); brandEditMsg.textContent=''; }
}
setBrandEditEnabled(false);
function commitPickBrand(){
  const v = (brandEditInput.value||'').trim();
  const opt = [...brandEditOptions.children].find(o=>o.value===v);
  if(!opt){ brandEditId.value=''; setBrandEditEnabled(false); brandEditHint.textContent='未选择品牌'; return false; }
  brandEditId.value = opt.dataset.bid;
  brandEditHint.textContent = `已选择：${v}`;
  loadBrandDetail(parseInt(opt.dataset.bid,10));
  return true;
}
if(brandEditInput){
  brandEditInput.addEventListener('change', commitPickBrand);
  brandEditInput.addEventListener('input', ()=>{ if(!brandEditInput.value.trim()){ setBrandEditEnabled(false); brandEditHint.textContent='未选择品牌'; }});
}
async function loadBrandDetail(bid){
  if(!bid){ setBrandEditEnabled(false); return; }
  try{
    const r=await fetch(`/admin/api/data/brand/detail?brand_id=${bid}`); const j=await r.json();
    if(!j.success){ brandEditMsg.className='err'; brandEditMsg.textContent=j.error_message||'加载失败'; setBrandEditEnabled(false); return; }
    const d=j.data;
    brandEditZh.value = d.brand_name_zh || '';
    brandEditEn.value = d.brand_name_en || '';
    brandEditIsValid.value = String(d.is_valid ?? 0);
    setBrandEditEnabled(true); brandEditMsg.textContent='';
  }catch{ brandEditMsg.className='err'; brandEditMsg.textContent='网络或服务器错误'; setBrandEditEnabled(false); }
}
if(brandEditForm){
  brandEditForm.addEventListener('submit', async e=>{
    e.preventDefault(); brandEditMsg.textContent=''; brandEditMsg.className=''; brandEditSubmitBtn.disabled=true;
    const bid=parseInt(brandEditId.value||'0',10); const zh = brandEditZh.value.trim(); const en = brandEditEn.value.trim(); const v = parseInt(brandEditIsValid.value||'0',10);
    if(bid<=0){ brandEditMsg.className='err'; brandEditMsg.textContent='请先选择品牌'; brandEditSubmitBtn.disabled=false; return; }
    if(!zh||!en){ brandEditMsg.className='err'; brandEditMsg.textContent='请填写完整名称'; brandEditSubmitBtn.disabled=false; return; }
    if(!confirm(`确认将品牌更新为：\n中文「${zh}」/ 英文「${en}」，状态：${v===1?'公开':'未公开'}？`)){ brandEditSubmitBtn.disabled=false; return; }
    try{
      const r=await fetch('/admin/api/data/brand/update',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ brand_id: bid, brand_name_zh: zh, brand_name_en: en, is_valid: v }) });
      const j=await r.json();
      if(j.success){ brandEditMsg.className='ok'; brandEditMsg.textContent='更新成功'; initBrandEditList(); }
      else { brandEditMsg.className='err'; brandEditMsg.textContent=j.error_message||'提交失败'; }
    }catch{ brandEditMsg.className='err'; brandEditMsg.textContent='网络或服务器错误'; } finally{ brandEditSubmitBtn.disabled=false; }
  });
}

/* ====================== 型号管理：添加 ====================== */
const brandInput=$('#brandInput'), brandOptions=$('#brandOptions'), brandIdEl=$('#brandId'), brandHint=$('#brandChosenHint');
const modelForm=$('#modelForm'), modelName=$('#modelName'), modelExistMsg=$('#modelExistMsg');
const modelSubmitBtn=$('#modelSubmitBtn'), modelMsg=$('#modelMsg'), rgbLight=$('#rgbLight');
function setModelFormEnabled(en){
  if(en){
    modelForm.classList.remove('disabled');
    [...modelForm.querySelectorAll('input,select,button')].forEach(el=>el.disabled=false);
  } else {
    modelForm.classList.add('disabled');
    [...modelForm.querySelectorAll('input,select,button')].forEach(el=>{
      if(el.id!=='modelSubmitBtn' && el.id!=='modelIsValid'){
        el.value='';
      }
      el.disabled=true;
    });
    rgbLight.value='无';
    const mis = document.querySelector('#modelIsValid');
    if(mis) mis.value = '0';
    modelExistMsg.textContent='';
    modelMsg.textContent='';
  }
}
setModelFormEnabled(false);
let brandCacheAdd=[]; let brandDebounceAdd;
async function searchBrandAdd(q){ const r=await fetch(`/admin/api/data/brand/search?q=${encodeURIComponent(q)}`); const j=await r.json(); if(j.success){ brandCacheAdd=(j.data.items||[]); brandOptions.innerHTML=''; brandCacheAdd.forEach(it=>{const opt=document.createElement('option'); opt.value=it.label; opt.dataset.bid=it.brand_id; brandOptions.appendChild(opt);});}}
function commitBrandAdd(){ const v=brandInput.value.trim(); const f=[...brandOptions.children].find(o=>o.value===v); if(f){ brandIdEl.value=f.dataset.bid; brandHint.textContent=`已选择品牌（ID：${f.dataset.bid}）`; setModelFormEnabled(true); return true;} return false;}
if(brandInput){
  brandInput.addEventListener('input',()=>{ brandIdEl.value=''; brandHint.textContent='未选择品牌'; setModelFormEnabled(false); const v=brandInput.value.trim(); if(brandDebounceAdd) clearTimeout(brandDebounceAdd); if(!v){ brandOptions.innerHTML=''; return;} brandDebounceAdd=setTimeout(()=>searchBrandAdd(v),250);});
  brandInput.addEventListener('change',commitBrandAdd); brandInput.addEventListener('blur',commitBrandAdd);
}
let nameDebounce;
if(modelName){
  modelName.addEventListener('input',()=>{ modelExistMsg.textContent=''; modelMsg.textContent=''; const v=modelName.value.trim(); if(nameDebounce) clearTimeout(nameDebounce); if(!v) return;
    nameDebounce=setTimeout(async()=>{ const r=await fetch(`/admin/api/data/model/exist?name=${encodeURIComponent(v)}`); const j=await r.json(); modelExistMsg.textContent=(j.success&&j.data.exists)?'已存在该型号':''; },350);
  });
}
if(modelForm){
  modelForm.addEventListener('submit',async e=>{
    e.preventDefault(); modelMsg.textContent=''; modelMsg.className=''; modelSubmitBtn.disabled=true;
    const bid=parseInt(brandIdEl.value||'0',10); if(!bid){ modelMsg.className='err'; modelMsg.textContent='请先选择品牌'; modelSubmitBtn.disabled=false; return; }
    if(modelExistMsg.textContent.trim()){ modelMsg.className='err'; modelMsg.textContent='已存在该型号，禁止提交'; modelSubmitBtn.disabled=false; return; }
    const modelIsValid = parseInt($('#modelIsValid')?.value || '0', 10);
    const body={
      brand_id:bid,
      model_name:$('#modelName').value.trim(),
      max_speed:$('#maxSpeed').value.trim(),
      size:$('#size').value.trim(),
      thickness:$('#thickness').value.trim(),
      rgb_light:$('#rgbLight').value,
      reference_price:$('#refPrice').value.trim(),
      comment:$('#comment').value.trim(),
      is_valid: modelIsValid
    };
    if(!body.model_name||!body.max_speed||!body.size||!body.thickness){ modelMsg.className='err'; modelMsg.textContent='请完善必填项'; modelSubmitBtn.disabled=false; return; }
    try{
      const r=await fetch('/admin/api/data/model/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const j=await r.json();
      if(j.success){
        modelMsg.className='ok';
        modelMsg.textContent=`添加成功，model_id：${j.data.model_id}`;
        modelForm.reset();
        rgbLight.value='无';
        const mis = document.querySelector('#modelIsValid'); if(mis) mis.value='0';
        modelExistMsg.textContent='';
      }
      else { modelMsg.className='err'; modelMsg.textContent=j.error_message||'提交失败'; }
    }catch{ modelMsg.className='err'; modelMsg.textContent='网络或服务器错误'; } finally{ modelSubmitBtn.disabled=false; }
  });
}

/* ====================== 型号管理：编辑 ====================== */
const modeSwitchAdd = $('#mmAdd'), modeSwitchEdit = $('#mmEdit');
const modelAddBox = $('#modelAddBox'), modelEditBox = $('#modelEditBox');
if(modeSwitchAdd && modeSwitchEdit){
  const updateBoxes=()=>{ const m = document.querySelector('input[name="modelMgmtMode"]:checked')?.value || 'add'; if(m==='add'){ modelAddBox.style.display=''; modelEditBox.style.display='none'; } else { modelAddBox.style.display='none'; modelEditBox.style.display=''; } };
  modeSwitchAdd.addEventListener('change',updateBoxes); modeSwitchEdit.addEventListener('change',updateBoxes); updateBoxes();
}

const modelEditForm=$('#modelEditForm'), modelEditSubmitBtn=$('#modelEditSubmitBtn'), modelEditMsg=$('#modelEditMsg');

const editModelName=$('#editModelName'), editMaxSpeed=$('#editMaxSpeed'), editSize=$('#editSize'), editThickness=$('#editThickness'),
      editRgbLight=$('#editRgbLight'), editRefPrice=$('#editRefPrice'), editComment=$('#editComment');

function setModelEditEnabled(en){
  if(en){ modelEditForm.classList.remove('disabled'); [...modelEditForm.querySelectorAll('input,select,button')].forEach(el=>el.disabled=false);}
  else { modelEditForm.classList.add('disabled'); [...modelEditForm.querySelectorAll('input,select,button')].forEach(el=>{ if(el.id!=='modelEditSubmitBtn' && el.id!=='modelEditIsValid') el.value=''; el.disabled=true;}); editRgbLight.value='无'; modelEditMsg.textContent=''; }
}
setModelEditEnabled(false);

let editPickedBrandLabel = '';

async function loadModelDetail(mid){
  if(!mid){ setModelEditEnabled(false); return; }
  try{
    const r=await fetch(`/admin/api/data/model/detail?model_id=${mid}`);
    const j=await r.json();
    if(!j.success){ modelEditMsg.className='err'; modelEditMsg.textContent=j.error_message||'加载失败'; setModelEditEnabled(false); return; }
    const d=j.data;
    editModelName.value = d.model_name || '';
    editMaxSpeed.value = d.max_speed ?? '';
    editSize.value = d.size ?? '';
    editThickness.value = d.thickness ?? '';
    editRgbLight.value = d.rgb_light || '无';
    editRefPrice.value = (d.reference_price != null && d.reference_price !== '') ? String(d.reference_price) : '';
    editComment.value = d.comment || '';
    const meis = document.querySelector('#modelEditIsValid');
    if(meis){
      const v = (d.is_valid == null ? 0 : parseInt(d.is_valid,10));
      meis.value = String(isNaN(v) ? 0 : v);
    }
    setModelEditEnabled(true);
    modelEditMsg.textContent='';
  }catch(e){
    modelEditMsg.className='err'; modelEditMsg.textContent='网络或服务器错误';
    setModelEditEnabled(false);
  }
}

// 新增：型号编辑改为“先选品牌再选型号”的两级下拉初始化
function initModelEditTwoDropdowns(){
  const modelBox = document.querySelector('#modelEditBox');
  const modelEditFormEl = document.querySelector('#modelEditForm');
  const brandLabel = document.querySelector('label[for="editModelBrandInput"]');
  const brandInp = document.querySelector('#editModelBrandInput');
  const brandOpts = document.querySelector('#editModelBrandOptions');
  const brandIdHidden = document.querySelector('#editModelBrandId');
  const brandHint = document.querySelector('#editModelBrandHint');
  const modelLabel = document.querySelector('label[for="editModelSelect"]');
  const modelSel = document.querySelector('#editModelSelect');
  const modelIdHidden = document.querySelector('#editModelId');
  const modelHint = document.querySelector('#editModelHint');

  // 若关键元素不存在则跳过
  if(!modelBox || !modelEditFormEl || !brandLabel || !brandInp || !brandOpts || !brandIdHidden || !brandHint || !modelLabel || !modelSel || !modelIdHidden || !modelHint){
    return;
  }

  // 将品牌与型号控件编排到同一行（仅在未编排过时进行）
  if(!modelBox.querySelector('.model-edit-pair-row')){
    const row = document.createElement('div');
    row.className = 'row align-bottom model-edit-pair-row';
    const col1 = document.createElement('div');
    const col2 = document.createElement('div');
    // 使两列在桌面端同排，移动端可自动换行
    col1.style.flex = '1 1 280px';
    col2.style.flex = '1 1 280px';

    // 将品牌相关节点移入左列
    col1.appendChild(brandLabel);
    col1.appendChild(brandInp);
    col1.appendChild(brandOpts);
    col1.appendChild(brandIdHidden);
    col1.appendChild(brandHint);

    // 将型号相关节点移入右列
    col2.appendChild(modelLabel);
    col2.appendChild(modelSel);
    col2.appendChild(modelIdHidden);
    col2.appendChild(modelHint);

    row.appendChild(col1);
    row.appendChild(col2);

    // 插到编辑表单之前
    modelBox.insertBefore(row, modelEditFormEl);
  }

  // 预加载品牌全量（支持“全量下拉”）
  (async ()=>{
    try{
      const r = await fetch('/admin/api/data/brand/all');
      const j = await r.json();
      if(j.success){
        const items = j.data.items || [];
        brandOpts.innerHTML = '';
        items.forEach(b=>{
          const opt = document.createElement('option');
          opt.value = b.label;         // 显示“中文 / 英文”
          opt.dataset.bid = b.brand_id;
          brandOpts.appendChild(opt);
        });
      }
    }catch{}
  })();

  // 选择品牌后加载型号下拉（带“· 公开/未公开”状态）
  async function loadModelsForEdit(bid){
    modelSel.innerHTML = '<option value="">请选择型号</option>';
    modelSel.disabled = true; modelIdHidden.value = '';
    if(!bid || Number(bid)<=0){ return; }
    try{
      const r = await fetch(`/admin/api/data/model/by-brand?brand_id=${bid}`);
      const j = await r.json();
      if(j.success){
        (j.data.items||[]).forEach(m=>{
          const opt = document.createElement('option');
          opt.value = String(m.model_id);
          opt.textContent = `${m.model_name} · ${m.is_valid ? '公开' : '未公开'}`;
          opt.dataset.mid = m.model_id;
          modelSel.appendChild(opt);
        });
        modelSel.disabled = false;
      }
    }catch{}
  }

  // 品牌选择确认
  function commitPickBrandForModelEdit(){
    const v = (brandInp.value||'').trim();
    const opt = [...brandOpts.children].find(o=>o.value===v);
    if(!opt){
      brandIdHidden.value=''; brandHint && (brandHint.textContent='未选择品牌');
      modelSel.innerHTML = '<option value="">请选择型号</option>'; modelSel.disabled = true; modelIdHidden.value='';
      editPickedBrandLabel = ''; // 复用外层变量用于确认提示
      setModelEditEnabled(false);
      return false;
    }
    const bid = parseInt(opt.dataset.bid, 10);
    brandIdHidden.value = opt.dataset.bid;
    editPickedBrandLabel = v; // 提交确认时显示品牌名
    brandHint && (brandHint.textContent = `已选择：${v}`);
    setModelEditEnabled(false);    // 先禁用编辑表单，待选择型号后再启用
    loadModelsForEdit(bid);
    return true;
  }

  brandInp.addEventListener('change', commitPickBrandForModelEdit);
  brandInp.addEventListener('blur', commitPickBrandForModelEdit);
  brandInp.addEventListener('input', ()=>{
    if(!brandInp.value.trim()){
      brandIdHidden.value='';
      brandHint && (brandHint.textContent='未选择品牌');
      modelSel.innerHTML='<option value="">请选择型号</option>';
      modelSel.disabled=true; modelIdHidden.value='';
      setModelEditEnabled(false);
    }
  });

  // 选择具体型号后加载详情
  modelSel.addEventListener('change', ()=>{
    const mid = parseInt(modelSel.value||'0',10);
    if(mid>0){
      const hintEl = document.querySelector('#editModelHint');
      if(hintEl) hintEl.textContent = `已选择：${modelSel.options[modelSel.selectedIndex].textContent}`;
      document.querySelector('#editModelId').value = String(mid);
      loadModelDetail(mid);
    }else{
      document.querySelector('#editModelId').value = '';
      setModelEditEnabled(false);
      const hintEl = document.querySelector('#editModelHint');
      if(hintEl) hintEl.textContent = '未选择型号';
    }
  });
}

if(modelEditForm){
  modelEditForm.addEventListener('submit', async e=>{
    e.preventDefault(); modelEditMsg.textContent=''; modelEditMsg.className=''; modelEditSubmitBtn.disabled=true;
    const mid=parseInt((document.querySelector('#editModelId')?.value || '0'), 10);
    const name = editModelName.value.trim();
    const maxs = editMaxSpeed.value.trim();
    const size = editSize.value.trim();
    const thick = editThickness.value.trim();
    const rgb = editRgbLight.value;
    const refp = editRefPrice.value.trim();
    const cmt = editComment.value.trim();
    const editIsValid = parseInt($('#modelEditIsValid')?.value || '0', 10);
    if(mid<=0){ modelEditMsg.className='err'; modelEditMsg.textContent='请先选择型号'; modelEditSubmitBtn.disabled=false; return; }
    if(!name||!maxs||!size||!thick){ modelEditMsg.className='err'; modelEditMsg.textContent='请完善必填项'; modelEditSubmitBtn.disabled=false; return; }

    const confirmBrand = editPickedBrandLabel || '该品牌';
    if(!confirm(`确认修改【${confirmBrand}】的型号【${name}】吗？\n提交后将更新数据库 fan_model 对应记录。`)){
      modelEditSubmitBtn.disabled=false; return;
    }

    try{
      const r=await fetch('/admin/api/data/model/update',{
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          model_id: mid,
          model_name: name,
          max_speed: maxs,
          size: size,
          thickness: thick,
          rgb_light: rgb,
          reference_price: refp,
          comment: cmt,
          is_valid: editIsValid
        })
      });
      const j=await r.json();
      if(j.success){
        modelEditMsg.className='ok'; modelEditMsg.textContent='已更新';
      }else{
        modelEditMsg.className='err'; modelEditMsg.textContent=j.error_message||'提交失败';
      }
    }catch{
      modelEditMsg.className='err'; modelEditMsg.textContent='网络或服务器错误';
    }finally{
      modelEditSubmitBtn.disabled=false;
    }
  });
}

/* ====================== 添加工况 ====================== */
const condForm=$('#condForm'), condMsg=$('#condMsg'), condSubmitBtn=$('#condSubmitBtn');
const condNameInp = $('#condName'), rtZhInp = $('#rtZh'), rtEnInp = $('#rtEn'), rtLocSel = $('#rtLoc');

// 即时唯一性校验：工况名
let nameChkTimer=null;
function checkCondNameUnique(name, excludeId){
  if(!name){ condMsg.textContent=''; return; }
  const url = `/admin/api/data/condition/name-exist?name=${encodeURIComponent(name)}${excludeId?`&exclude_id=${excludeId}`:''}`;
  return fetch(url).then(r=>r.json()).then(j=>{
    if(j.success && j.data.exists){
      condMsg.className='err';
      condMsg.textContent='该工况名称已存在';
      return false;
    } else {
      if(condMsg.textContent==='该工况名称已存在'){ condMsg.textContent=''; }
      return true;
    }
  }).catch(()=>true);
}
if(condNameInp){
  condNameInp.addEventListener('input', ()=>{
    if(nameChkTimer) clearTimeout(nameChkTimer);
    nameChkTimer = setTimeout(()=>{ checkCondNameUnique(condNameInp.value.trim()); }, 300);
  });
}

// 即时唯一性校验：类型中文 + 位置 组合
let combChkTimer=null;
function checkCondCombUnique(tzh, lzh, excludeId){
  if(!tzh || !lzh){ return Promise.resolve(true); }
  const url = `/admin/api/data/condition/comb-exist?type_zh=${encodeURIComponent(tzh)}&location_zh=${encodeURIComponent(lzh)}${excludeId?`&exclude_id=${excludeId}`:''}`;
  return fetch(url).then(r=>r.json()).then(j=>{
    if(j.success && j.data.exists){
      condMsg.className='err';
      condMsg.textContent='已存在该组合';
      return false;
    } else {
      if(condMsg.textContent==='已存在该组合'){ condMsg.textContent=''; }
      return true;
    }
  }).catch(()=>true);
}
[rtZhInp, rtLocSel].forEach(el=>{
  el && el.addEventListener('change', ()=>{ 
    checkCondCombUnique(rtZhInp.value.trim(), rtLocSel.value.trim());
  });
});

if(condForm){
  condForm.addEventListener('submit', async e=>{
    e.preventDefault(); condMsg.textContent=''; condMsg.className=''; condSubmitBtn.disabled=true;
    const nameZh=condNameInp?.value.trim() || '';
    const zh=rtZhInp.value.trim(), en=rtEnInp.value.trim(), loc=rtLocSel.value.trim();
    const condIsValid = parseInt($('#condIsValid')?.value || '0', 10);
    if(!nameZh || !zh || !en || !loc){
      condMsg.className='err'; condMsg.textContent='请完善必填项'; condSubmitBtn.disabled=false; return;
    }
    // 提交前再次校验唯一性
    const okName = await checkCondNameUnique(nameZh);
    const okComb = await checkCondCombUnique(zh, loc);
    if(!okName || !okComb){ condSubmitBtn.disabled=false; return; }

    try{
      const r=await fetch('/admin/api/data/condition/add',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          condition_name_zh:nameZh,
          resistance_type_zh:zh,
          resistance_type_en:en,
          resistance_location_zh:loc,
          is_valid: condIsValid
        })
      });
      const j=await r.json();
      if(j.success){
        condMsg.className='ok';
        condMsg.textContent=`添加成功，condition_id：${j.data.condition_id}`;
        // 可选：清空输入
        // condForm.reset();
      } else {
        condMsg.className='err'; condMsg.textContent=j.error_message||'提交失败';
      }
    }catch{
      condMsg.className='err'; condMsg.textContent='网络或服务器错误';
    } finally{ condSubmitBtn.disabled=false; }
  });
}

/* ====================== 工况管理：编辑（改为单条记录） ====================== */
const cmAdd = $('#cmAdd'), cmEdit = $('#cmEdit');
const condAddBox = $('#condAddBox'), condEditBox = $('#condEditBox');
if(cmAdd && cmEdit){
  const updateBoxes=()=>{ const m = document.querySelector('input[name="condMgmtMode"]:checked')?.value || 'add'; if(m==='add'){ condAddBox.style.display=''; condEditBox.style.display='none'; } else { condAddBox.style.display='none'; condEditBox.style.display=''; initConditionEditList(); } };
  cmAdd.addEventListener('change',updateBoxes); cmEdit.addEventListener('change',updateBoxes); updateBoxes();
}

const condEditInput=$('#condEditInput'), condEditOptions=$('#condEditOptions'), condEditHint=$('#condEditHint');
const condEditId=$('#condEditId'), condNameEdit=$('#condNameEdit'), rtZhEdit=$('#rtZhEdit'), rtEnEdit=$('#rtEnEdit'), rtLocEdit=$('#rtLocEdit');
const condEditForm=$('#condEditForm'), condEditSubmitBtn=$('#condEditSubmitBtn'), condEditMsg=$('#condEditMsg'), condEditIsValid=$('#condEditIsValid');

let condTypesCache=[];
async function initConditionEditList(){
  try{
    if(condEditInput){ condEditInput.style.minWidth = '680px'; } // 更宽以展示更长标签
    const r=await fetch('/admin/api/data/condition/types'); const j=await r.json();
    if(j.success){
      condTypesCache=j.data.items||[];
      condEditOptions.innerHTML='';
      condTypesCache.forEach(it=>{
        const opt=document.createElement('option');
        opt.value = it.label;              // 形如：名称 - 类型中/英 - 位置中 - 位置英
        opt.dataset.cid = it.condition_id; // 直接选定具体记录
        condEditOptions.appendChild(opt);
      });
    }
  }catch{}
}
function setCondEditEnabled(en){
  if(en){ condEditForm.classList.remove('disabled'); [...condEditForm.querySelectorAll('input,select,button')].forEach(el=>el.disabled=false); }
  else { condEditForm.classList.add('disabled'); [...condEditForm.querySelectorAll('input,select,button')].forEach(el=>{ if(el.id!=='condEditSubmitBtn'){ el.value=''; } el.disabled=true; }); condEditMsg.textContent=''; }
}
setCondEditEnabled(false);

async function loadConditionDetail(cid){
  try{
    const r=await fetch(`/admin/api/data/condition/detail?condition_id=${cid}`);
    const j=await r.json();
    if(!j.success){ condEditMsg.className='err'; condEditMsg.textContent=j.error_message||'加载失败'; setCondEditEnabled(false); return; }
    const d=j.data;
    condEditId.value = String(d.condition_id);
    condNameEdit.value = d.condition_name_zh || '';
    rtZhEdit.value = d.resistance_type_zh || '';
    rtEnEdit.value = d.resistance_type_en || '';
    rtLocEdit.value = d.resistance_location_zh || '';
    condEditIsValid.value = String(d.is_valid ?? 0);
    setCondEditEnabled(true); condEditMsg.textContent='';
  }catch{
    condEditMsg.className='err'; condEditMsg.textContent='网络或服务器错误'; setCondEditEnabled(false);
  }
}
function commitPickCondition(){
  const v = (condEditInput.value||'').trim();
  const opt = [...condEditOptions.children].find(o=>o.value===v);
  if(!opt){ condEditId.value=''; setCondEditEnabled(false); condEditHint.textContent='未选择工况'; return false; }
  const cid = parseInt(opt.dataset.cid, 10);
  condEditHint.textContent = `已选择：${v}`;
  loadConditionDetail(cid);
  return true;
}
if(condEditInput){
  condEditInput.addEventListener('change', commitPickCondition);
  condEditInput.addEventListener('input', ()=>{ if(!condEditInput.value.trim()){ setCondEditEnabled(false); condEditHint.textContent='未选择工况'; }});
}

// 编辑页即时唯一性校验（与添加一致，但排除自身）
let editNameChkTimer=null;
if(condNameEdit){
  condNameEdit.addEventListener('input', ()=>{
    if(editNameChkTimer) clearTimeout(editNameChkTimer);
    editNameChkTimer = setTimeout(()=>{
      const eid = parseInt(condEditId.value||'0',10) || 0;
      fetch(`/admin/api/data/condition/name-exist?name=${encodeURIComponent(condNameEdit.value.trim())}&exclude_id=${eid}`)
        .then(r=>r.json()).then(j=>{
          if(j.success && j.data.exists){ condEditMsg.className='err'; condEditMsg.textContent='该工况名称已存在'; }
          else if(condEditMsg.textContent==='该工况名称已存在'){ condEditMsg.textContent=''; }
        }).catch(()=>{});
    }, 300);
  });
}
[rtZhEdit, rtLocEdit].forEach(el=>{
  el && el.addEventListener('change', ()=>{
    const eid = parseInt(condEditId.value||'0',10) || 0;
    const t = rtZhEdit.value.trim(), l = rtLocEdit.value.trim();
    if(!t || !l) return;
    fetch(`/admin/api/data/condition/comb-exist?type_zh=${encodeURIComponent(t)}&location_zh=${encodeURIComponent(l)}&exclude_id=${eid}`)
      .then(r=>r.json()).then(j=>{
        if(j.success && j.data.exists){ condEditMsg.className='err'; condEditMsg.textContent='已存在该组合'; }
        else if(condEditMsg.textContent==='已存在该组合'){ condEditMsg.textContent=''; }
      }).catch(()=>{});
  });
});

if(condEditForm){
  condEditForm.addEventListener('submit', async e=>{
    e.preventDefault(); condEditMsg.textContent=''; condEditMsg.className=''; condEditSubmitBtn.disabled=true;
    const cid=parseInt(condEditId.value||'0',10);
    const nameZh = condNameEdit.value.trim();
    const zh = rtZhEdit.value.trim(), en = rtEnEdit.value.trim(), loc = rtLocEdit.value.trim();
    const v = parseInt(condEditIsValid.value||'0',10);

    if(cid<=0){ condEditMsg.className='err'; condEditMsg.textContent='未正确加载记录'; condEditSubmitBtn.disabled=false; return; }
    if(!nameZh || !zh || !en || !loc){ condEditMsg.className='err'; condEditMsg.textContent='请完善必填项'; condEditSubmitBtn.disabled=false; return; }

    // 提交前二次唯一性校验
    try{
      const [nameChk, combChk] = await Promise.all([
        fetch(`/admin/api/data/condition/name-exist?name=${encodeURIComponent(nameZh)}&exclude_id=${cid}`).then(r=>r.json()),
        fetch(`/admin/api/data/condition/comb-exist?type_zh=${encodeURIComponent(zh)}&location_zh=${encodeURIComponent(loc)}&exclude_id=${cid}`).then(r=>r.json())
      ]);
      if(nameChk.success && nameChk.data.exists){ condEditMsg.className='err'; condEditMsg.textContent='该工况名称已存在'; condEditSubmitBtn.disabled=false; return; }
      if(combChk.success && combChk.data.exists){ condEditMsg.className='err'; condEditMsg.textContent='已存在该组合'; condEditSubmitBtn.disabled=false; return; }
    }catch{}

    if(!confirm(`确认将工况更新为：\n「${nameZh} - ${zh} / ${en} - ${loc}」\n状态：${v===1?'公开':'未公开'}？`)){ condEditSubmitBtn.disabled=false; return; }

    try{
      const r=await fetch('/admin/api/data/condition/update',{
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          condition_id: cid,
          condition_name_zh: nameZh,
          resistance_type_zh: zh,
          resistance_type_en: en,
          resistance_location_zh: loc,
          is_valid: v
        })
      });
      const j=await r.json();
      if(j.success){ condEditMsg.className='ok'; condEditMsg.textContent='更新成功'; initConditionEditList(); }
      else { condEditMsg.className='err'; condEditMsg.textContent=j.error_message||'提交失败'; }
    }catch{ condEditMsg.className='err'; condEditMsg.textContent='网络或服务器错误'; } finally{ condEditSubmitBtn.disabled=false; }
  });
}

/* ====================== 上传测试数据（原有逻辑保持） ====================== */
const upBrandInput=$('#upBrandInput'), upBrandOptions=$('#upBrandOptions'), upBrandId=$('#upBrandId');
const upModelInput=$('#upModelInput'), upModelOptions=$('#upModelOptions'), upModelId=$('#upModelId');
const upConditionSelect=$('#upConditionSelect'), perfEditor=$('#perfEditor'), perfExistsMsg=$('#perfExistsMsg');
const uploadSelectHint=$('#uploadSelectHint'), addRowBtn=$('#addRowBtn'), perfTable=$('#perfTable tbody');
const perfSubmitBtn=$('#perfSubmitBtn'), perfSubmitMsg=$('#perfSubmitMsg'), isValidSelect=$('#isValidSelect');
const previewArea=$('#previewArea'), previewTableBody=$('#previewTable tbody');
const chartRpmAir=$('#chartRpmAir'), chartNoiseAir=$('#chartNoiseAir');
const existsBox=$('#existsBox'), groupPicker=$('#groupPicker'), groupSelect=$('#groupSelect'), loadGroupBtn=$('#loadGroupBtn'), groupTips=$('#groupTips'), modeBadge=$('#modeBadge');
const restoreBar=$('#restoreBar'), restoreBtn=$('#restoreBtn'), discardBtn=$('#discardBtn');

let upBrandCache=[], upBrandDebounce, previewReady=false;
let mode='new'; // 'new' | 'edit' | 'reupload'
let currentGroupKey=null, activeGroupKey=null, loadedGroupRows=[], initialIsValidOnLoad = 0;

function setMode(newMode){
  mode=newMode;
  modeBadge.textContent = '模式：' + (mode==='new'?'新建': mode==='edit'?'编辑': '重新上传');
  modeBadge.className = 'badge ' + (mode==='edit'?'badge-green': mode==='reupload'?'badge-red':'badge-grey');

  const descEl = document.querySelector('#updateDesc');
  if(descEl){
    const cur = (descEl.value||'').trim();
    if(mode === 'new'){
      if(!cur) descEl.value = '上传数据';
    }else{
      if(cur === '上传数据') descEl.value = '';
    }
  }

  if(mode!=='edit'){ [...perfTable.querySelectorAll('input')].forEach(el=>el.disabled=false); }
  markDirty(); saveDraft();
}
function markDirty(){ previewReady=false; perfSubmitBtn.textContent='预览'; previewArea.style.display='none'; perfSubmitMsg.textContent=''; }

async function searchUploadBrand(q){
  const r=await fetch(`/admin/api/data/brand/search?q=${encodeURIComponent(q)}`); const j=await r.json();
  if(j.success){ upBrandCache=j.data.items||[]; upBrandOptions.innerHTML=''; upBrandCache.forEach(it=>{const opt=document.createElement('option'); opt.value=it.label; upBrandOptions.appendChild(opt);}); }
}
function resetUploadState(keepBrand=false){
  if(!keepBrand){ upBrandId.value=''; upBrandInput.value=''; }
  upModelId.value=''; upModelInput.value=''; upModelInput.disabled=true; upModelOptions.innerHTML='';
  upConditionSelect.innerHTML='<option value="">请选择工况</option>'; upConditionSelect.disabled=true;
  existsBox.style.display='none'; groupPicker.style.display='none'; groupSelect.innerHTML='<option value="">请选择历史组</option>'; groupTips.textContent='';
  perfExistsMsg.textContent=''; uploadSelectHint.textContent='请依次选择品牌、型号与工况。';
  disablePerfEditor(); setMode('new'); currentGroupKey=null; activeGroupKey=null; loadedGroupRows=[]; initialIsValidOnLoad=0;

  // 新增：清空上一轮音频标定缓存，避免跨型号/工况误绑定
  try {
    window.lastCalibRunId = null;
    window.lastCalibModelHash = null;
    window.lastCalibBatchId = null;   
  } catch (e) {}
}

// 新增：根据是否已选定 品牌/型号/工况 同步动作栏显示
function syncUploadActionBarVisibility(){
  const bar = document.getElementById('uploadActionBar');
  if(!bar) return;
  const ready =
    (parseInt(upBrandId?.value||'0',10) > 0) &&
    (parseInt(upModelId?.value||'0',10) > 0) &&
    (parseInt(upConditionSelect?.value||'0',10) > 0);
  bar.style.display = ready ? '' : 'none';
}

// 替换：编辑区开关时同步动作栏显示
function disablePerfEditor(){
  perfEditor.classList.add('disabled');
  perfTable.innerHTML='';
  previewArea.style.display='none';
  if (perfEditor) perfEditor.style.display = 'none';
  const bar = document.getElementById('uploadActionBar');
  if (bar) bar.style.display = 'none';
}
function enablePerfEditor(){
  perfEditor.classList.remove('disabled');
  if(perfTable.children.length===0) addPerfRow();
  markDirty();
  if (perfEditor) perfEditor.style.display = '';
  const bar = document.getElementById('uploadActionBar');
  if (bar) bar.style.display = '';
}

/* 草稿存取（保持） */
function hasMeaningfulDraft(d){
  if(!d) return false;
  const hasIds = (d.bid && d.bid!=='') || (d.mid && d.mid!=='') || (d.cid && d.cid!=='');
  const hasGroup = !!d.currentGroupKey || d.mode==='edit';
  const hasRows = Array.isArray(d.rows) && d.rows.some(r=>{
    return ['rpm','airflow_cfm','noise_db','total_db','ambient_db'].some(k=> String(r[k]||'').trim()!=='');
  });
  return hasIds || hasGroup || hasRows;
}
function collectRowsForDraft(){
  const rows=[]; [...perfTable.children].forEach(tr=>{ rows.push({
    data_id: tr.dataset.dataId || null,
    rpm: tr.querySelector('.perf-rpm')?.value?.trim() || '',
    airflow_cfm: tr.querySelector('.perf-airflow')?.value?.trim() || '',
    noise_db: tr.querySelector('.perf-noise')?.value?.trim() || '',
    total_db: tr.querySelector('.perf-totaldb')?.value?.trim() || '',
    ambient_db: tr.querySelector('.perf-ambientdb')?.value?.trim() || ''
  });}); return rows;
}
function saveDraft(){
  try{
    if(suspendDraft) return;
    const draft = {
      bid: upBrandId.value || '',
      bLabel: upBrandInput.value || '',
      mid: upModelId.value || '',
      mLabel: upModelInput.value || '',
      cid: upConditionSelect.value || '',
      mode,
      currentGroupKey,
      isValid: isValidSelect.value || '0',
      // 新增字段
      desc: (document.querySelector('#updateDesc')?.value || ''),
      existOpt: (document.querySelector('input[name="existOpt"]:checked')?.value || ''),
      selGroupKey: (document.querySelector('#groupSelect')?.value || ''),
      rows: collectRowsForDraft(),
      origRows: loadedGroupRows || [],
      initialIsValidOnLoad,
      ts: Date.now()
    };
    if(!hasMeaningfulDraft(draft)){ localStorage.removeItem(LS_KEY); return; }
    localStorage.setItem(LS_KEY, JSON.stringify(draft));
  }catch(e){}
}

/* 上传页选择链（保持） */
if(upBrandInput){
  upBrandInput.addEventListener('input',()=>{
    upBrandId.value=''; resetUploadState(true);
    const v=upBrandInput.value.trim();
    if(upBrandDebounce) clearTimeout(upBrandDebounce);
    if(!v){ upBrandOptions.innerHTML=''; return; }
    upBrandDebounce=setTimeout(()=>searchUploadBrand(v),250);
    saveDraft();
  });
  upBrandInput.addEventListener('change',commitUploadBrand);
  upBrandInput.addEventListener('blur',commitUploadBrand);
}
function commitUploadBrand(){
  const v=upBrandInput.value.trim();
  const f=upBrandCache.find(it=>it.label===v);
  if(f){ upBrandId.value=f.brand_id; loadModelsForBrand(f.brand_id).then(()=> saveDraft()); return true; }
  return false;
}
async function loadModelsForBrand(bid){
  upModelInput.disabled=false; upModelInput.value=''; upModelOptions.innerHTML=''; upModelId.value=''; disablePerfEditor();
  uploadSelectHint.textContent='请继续选择型号与工况。';
  if(!bid){ return; }
  const r=await fetch(`/admin/api/data/model/by-brand?brand_id=${bid}`); const j=await r.json();
  if(j.success){ (j.data.items||[]).forEach(m=>{ const opt=document.createElement('option'); opt.value=m.model_name; opt.dataset.mid=m.model_id; upModelOptions.appendChild(opt); }); }
  await loadConditions();
}
async function loadConditions(){
  upConditionSelect.disabled=false;
  const r=await fetch('/admin/api/data/conditions/all'); const j=await r.json();
  if(j.success){ upConditionSelect.innerHTML='<option value="">请选择工况</option>'; (j.data.items||[]).forEach(c=>{ const opt=document.createElement('option'); opt.value=c.condition_id; opt.textContent=c.label; upConditionSelect.appendChild(opt); }); }
  await checkExisting();
}

if(upModelInput){
  upModelInput.addEventListener('change',commitUploadModel);
  upModelInput.addEventListener('blur',commitUploadModel);
  upModelInput.addEventListener('input',()=>{ upModelId.value=''; disablePerfEditor(); perfExistsMsg.textContent=''; markDirty(); saveDraft(); });
}
function commitUploadModel(){
  const v=upModelInput.value.trim(); if(!v) return false;
  const opt=[...upModelOptions.children].find(o=>o.value===v);
  if(opt){ upModelId.value=opt.dataset.mid; checkExisting().then(saveDraft); return true; }
  return false;
}
if(upConditionSelect){
  upConditionSelect.addEventListener('change',()=>{ disablePerfEditor(); perfExistsMsg.textContent=''; checkExisting(); markDirty(); saveDraft(); });
}

async function checkExisting(){
  const mid=parseInt(upModelId.value||'0',10);
  const cid=parseInt(upConditionSelect.value||'0',10);
  if(mid>0 && cid>0){
    const r=await fetch(`/admin/api/data/perf/check?model_id=${mid}&condition_id=${cid}`);
    const j=await r.json();
    if(!j.success){ perfExistsMsg.textContent=j.error_message||'检查失败'; return; }
    perfExistsMsg.textContent='';
    activeGroupKey = j.data.active_group_key || null;

    if(j.data.exists){
      existsBox.style.display='';
      groupPicker.style.display='none';
      setMode('reupload');
      enablePerfEditor();
      perfTable.innerHTML=''; addPerfRow();
      isValidSelect.disabled=false;
      document.querySelectorAll('input[name="existOpt"]').forEach(radio=>{
        radio.onchange = async ()=>{
          if(radio.value==='edit'){
            const mid=parseInt(upModelId.value||'0',10);
            const cid=parseInt(upConditionSelect.value||'0',10);
            const r2 = await fetch(`/admin/api/data/perf/groups?model_id=${mid}&condition_id=${cid}`);
            const j2 = await r2.json();
            if(!j2.success){ groupTips.textContent = j2.error_message || '加载历史组失败'; return; }
            groupSelect.innerHTML = '<option value="">请选择历史组</option>';
            (j2.data.groups||[]).forEach(g=>{
              const opt=document.createElement('option');
              opt.value=g.group_key;
              opt.textContent=`${g.create_date} · ${g.row_count}条 · ${g.is_valid?'公开':'草稿'}`;
              groupSelect.appendChild(opt);
            });
            activeGroupKey = j2.data.active_group_key || null;
            groupPicker.style.display='';
            setMode('edit');
            isValidSelect.value='0';
            isValidSelect.disabled=true;
            perfTable.innerHTML='';
            saveDraft();
          }else{
            groupPicker.style.display='none';
            setMode('reupload');
            isValidSelect.disabled=false;
            perfTable.innerHTML=''; addPerfRow();
            saveDraft();
          }
        };
      });
    } else {
      existsBox.style.display='none';
      setMode('new');
      enablePerfEditor();
      perfTable.innerHTML=''; addPerfRow();
    }
  }
}

async function loadGroupByKey(gk){
  const mid=parseInt(upModelId.value||'0',10);
  const cid=parseInt(upConditionSelect.value||'0',10);
  const r = await fetch(`/admin/api/data/perf/group-rows?model_id=${mid}&condition_id=${cid}&group_key=${encodeURIComponent(gk)}`);
  const j = await r.json();
  if(!j.success){ groupTips.textContent = j.error_message || '载入失败'; return false; }
  currentGroupKey = gk;
  loadedGroupRows = j.data.rows || [];
  initialIsValidOnLoad = j.data.group_is_valid ? 1 : 0;
  groupTips.textContent = `已载入：${loadedGroupRows.length} 条。${initialIsValidOnLoad ? '（当前公开组）' : '（未公开组）'}`;
  if(activeGroupKey && activeGroupKey !== gk){ isValidSelect.value='0'; isValidSelect.disabled=true; } else { isValidSelect.value='0'; isValidSelect.disabled=false; }
  perfTable.innerHTML='';
  loadedGroupRows.forEach((row, idx)=>{
    const tr=document.createElement('tr');
    tr.dataset.dataId = row.data_id;
    tr.innerHTML = `
      <td>${idx+1}</td>
      <td><input type="text" inputmode="numeric" pattern="[0-9]*" class="w-small perf-rpm" placeholder="rpm" value="${row.rpm??''}" /></td>
      <td><input type="text" inputmode="decimal" class="w-small perf-airflow" placeholder="cfm" value="${row.airflow_cfm??''}" /></td>
      <td><input type="text" inputmode="decimal" class="w-small perf-noise" placeholder="equivalent_dBA" value="${row.noise_db??''}" /></td>
      <td><input type="text" inputmode="decimal" class="w-small perf-totaldb" placeholder="total_dBA" /></td>
      <td><input type="text" inputmode="decimal" class="w-small perf-ambientdb" placeholder="ambient_dBA" /></td>
      <td><button type="button" class="delRowBtn">删除</button></td>
    `;
    perfTable.appendChild(tr);
    tr.querySelector('.perf-rpm').disabled = true;
    if(row.airflow_cfm != null){ tr.querySelector('.perf-airflow').disabled = true; }
    if(row.noise_db != null){
      tr.querySelector('.perf-noise').disabled = true;
      tr.querySelector('.perf-totaldb').disabled = true;
      tr.querySelector('.perf-ambientdb').disabled = true;
    } else {
      bindNoiseInputs(tr);
    }
    bindNumericFilters(tr);
    tr.querySelector('.delRowBtn').addEventListener('click', ()=>{
      tr.remove(); renumberRows();
      setMode('reupload'); isValidSelect.disabled=false; saveDraft();
    });
    tr.querySelectorAll('input').forEach(inp=>{
      inp.addEventListener('input', ()=>{
        if(inp.disabled){
          setMode('reupload');
          [...perfTable.querySelectorAll('input')].forEach(el=>el.disabled=false);
          perfTable.querySelectorAll('tr').forEach(bindNoiseInputs);
          isValidSelect.disabled=false;
        }
        markDirty(); saveDraft();
      });
    });
  });
  enablePerfEditor();
  setMode('edit');
  saveDraft();
  return true;
}

if($('#loadGroupBtn')){
  $('#loadGroupBtn').addEventListener('click', async ()=>{
    const gk = $('#groupSelect').value;
    if(!gk){ $('#groupTips').textContent='请选择历史组'; return; }
    try{
      const btn=$('#loadGroupBtn'); btn.disabled=true; const old=btn.textContent; btn.textContent='载入中…';
      $('#groupTips').textContent='正在载入，请稍候…';
      const ok = await loadGroupByKey(gk);
      $('#groupTips').textContent = ok ? '载入完成' : '载入失败，请重试';
      btn.textContent=old; btn.disabled=false;
    }catch{ $('#groupTips').textContent='载入失败：网络或服务器错误'; }
  });
}

/* 行工具与预览/提交（保持不变） */
function bindNoiseInputs(tr){
  const noiseInp = tr.querySelector('.perf-noise');
  const totalInp = tr.querySelector('.perf-totaldb');
  const ambientInp = tr.querySelector('.perf-ambientdb');
  const updateLock = ()=>{
    const nv = (noiseInp.value||'').trim();
    const tv = (totalInp.value||'').trim();
    const av = (ambientInp.value||'').trim();
    if(nv){ totalInp.disabled = true; ambientInp.disabled = true; }
    else if(tv || av){ noiseInp.disabled = true; }
    else { noiseInp.disabled = false; totalInp.disabled = false; ambientInp.disabled = false; }
  };
  [noiseInp,totalInp,ambientInp].forEach(inp=>{ if(!inp) return; inp.addEventListener('input', ()=>{ updateLock(); markDirty(); saveDraft(); }); });
  updateLock();
}
function bindNumericFilters(scopeEl){
  const row = scopeEl instanceof HTMLElement ? scopeEl : document;
  row.querySelectorAll('.perf-rpm').forEach(inp=>{
    inp.addEventListener('input', ()=>{
      const cleaned = (inp.value||'').replace(/\D+/g,'');
      if(inp.value!==cleaned) inp.value = cleaned;
      markDirty(); saveDraft();
    });
  });
  row.querySelectorAll('.perf-airflow, .perf-noise, .perf-totaldb, .perf-ambientdb').forEach(inp=>{
    inp.addEventListener('input', ()=>{
      let v = (inp.value||'').replace(/[^0-9.]/g,'');
      const firstDot = v.indexOf('.');
      if(firstDot !== -1){ v = v.slice(0, firstDot+1) + v.slice(firstDot+1).replace(/\./g,''); }
      if(inp.value!==v) inp.value = v;
      markDirty(); saveDraft();
    });
  });
}
function seqValueByIndex(idx){ if(idx<=0) return 800; if(idx===1) return 1000; if(idx===2) return 1200; if(idx===3) return 1500; return 2000 + (idx-4)*500; }
function ceilSeqIndex(val){ if(val<=800) return 0; if(val<=1000) return 1; if(val<=1200) return 2; if(val<=1500) return 3; return 4 + Math.ceil((val-2000)/500); }
function floorSeqIndex(val){ if(val<800) return 0; if(val<1000) return 0; if(val<1200) return 1; if(val<1500) return 2; if(val<2000) return 3; return 4 + Math.floor((val-2000)/500); }
function usedRpmSet(){ const set=new Set(); [...perfTable.children].forEach(tr=>{ const v = parseInt((tr.querySelector('.perf-rpm')?.value||'').trim(),10); if(!isNaN(v) && v>0) set.add(v); }); return set; }
function autoFillNextRpm(newTr){
  if(perfTable.children.length < 2) return;
  const first = perfTable.children[0].querySelector('.perf-rpm');
  const val = parseInt((first?.value||'').trim(),10);
  if(isNaN(val) || val<=0){ return; }
  const used = usedRpmSet();
  let direction = (val<=1000) ? 'up' : 'down';
  let idx = direction==='up' ? ceilSeqIndex(val) : floorSeqIndex(val);
  let candidate = null; let guard = 0;
  while(guard++ < 200){
    const v = seqValueByIndex(idx);
    if(!used.has(v)){ candidate = v; break; }
    idx += (direction==='up'? 1 : -1);
    if(idx<0){ idx=0; }
  }
  if(candidate!=null){ const inp = newTr.querySelector('.perf-rpm'); if(inp && (!inp.value || inp.value.trim()==='')) inp.value = String(candidate); }
}
if(addRowBtn) addRowBtn.addEventListener('click',()=>{ const tr = addPerfRow(); autoFillNextRpm(tr); if(mode==='edit'){ setMode('reupload'); isValidSelect.disabled=false; } saveDraft(); });
function addPerfRow(rowData){
  const idx=perfTable.children.length+1;
  const tr=document.createElement('tr');
  tr.innerHTML=`
    <td>${idx}</td>
    <td><input type="text" inputmode="numeric" pattern="[0-9]*" class="w-small perf-rpm" placeholder="rpm" /></td>
    <td><input type="text" inputmode="decimal" class="w-small perf-airflow" placeholder="cfm" /></td>
    <td><input type="text" inputmode="decimal" class="w-small perf-noise" placeholder="equivalent_dBA" /></td>
    <td><input type="text" inputmode="decimal" class="w-small perf-totaldb" placeholder="total_dBA" /></td>
    <td><input type="text" inputmode="decimal" class="w-small perf-ambientdb" placeholder="ambient_dBA" /></td>
    <td><button type="button" class="delRowBtn">删除</button></td>
  `;
  perfTable.appendChild(tr);
  if(rowData){
    tr.querySelector('.perf-rpm').value=rowData.rpm||'';
    tr.querySelector('.perf-airflow').value=rowData.airflow_cfm||'';
    tr.querySelector('.perf-noise').value=rowData.noise_db||'';
    tr.querySelector('.perf-totaldb').value=rowData.total_db||'';
    tr.querySelector('.perf-ambientdb').value=rowData.ambient_db||'';
  }
  bindNoiseInputs(tr); bindNumericFilters(tr);
  tr.querySelectorAll('input').forEach(inp => inp.addEventListener('input', ()=>{ markDirty(); saveDraft(); }));
  tr.querySelector('.delRowBtn').addEventListener('click',()=>{ tr.remove(); renumberRows(); markDirty(); if(mode==='edit'){ setMode('reupload'); isValidSelect.disabled=false; } saveDraft(); });
  markDirty();
  return tr;
}
function renumberRows(){ [...perfTable.children].forEach((tr,i)=>{ tr.firstElementChild.textContent=i+1; }); }
function computeNoise(total, ambient){ if(total===''||ambient===''||total==null||ambient==null) return null; const T=Math.pow(10, Number(total)/10); const A=Math.pow(10, Number(ambient)/10); const diff=T-A; if(diff>1e-12){ return Number((10*Math.log10(diff)).toFixed(1)); } return null; }

function gatherRowsForPreview(){
  const rows=[]; let ok=true; let msg=''; const rpms=[];
  for(let i=0;i<perfTable.children.length;i++){
    const tr=perfTable.children[i];
    const rpmStr=tr.querySelector('.perf-rpm').value.trim();
    const airStr=tr.querySelector('.perf-airflow').value.trim();
    const noiseStr=tr.querySelector('.perf-noise').value.trim();
    const tStr=tr.querySelector('.perf-totaldb').value.trim();
    const aStr=tr.querySelector('.perf-ambientdb').value.trim();

    // 跳过整行全空
    if(!rpmStr && !airStr && !noiseStr && !tStr && !aStr){ continue; }

    // rpm 必填
    const rpm = parseInt(rpmStr,10);
    if(!rpmStr || isNaN(rpm) || rpm<=0){ ok=false; msg=`第${i+1}行：rpm 必须为>0的整数`; break; }
    if(rpms.includes(rpm)){ ok=false; msg=`第${i+1}行：rpm 重复`; break; }
    rpms.push(rpm);

    // 三组选填：风量，等效噪音，总+环境（两者都填）
    const hasAir = airStr !== '';
    const hasEq = noiseStr !== '';
    const hasTA = (tStr !== '' && aStr !== '');

    if(!hasAir && !hasEq && !hasTA){
      ok=false; msg=`第${i+1}行：请至少填写“风量”或“等效噪音”或“总噪音+环境噪音”中的一组`; break;
    }

    // 校验风量（如填写则需>0）
    let air = null;
    if(hasAir){
      air = parseFloat(airStr);
      if(isNaN(air) || air<=0){ ok=false; msg=`第${i+1}行：airflow_cfm 必须>0（或可留空）`; break; }
    }

    // 噪音：优先使用等效噪音；若为空且提供了总+环境，则计算
    let ndb = null;
    if(hasEq){
      const v = parseFloat(noiseStr);
      if(isNaN(v)){ ok=false; msg=`第${i+1}行：noise_db 必须为数字`; break; }
      ndb = Number(v.toFixed(1));
    }else if(hasTA){
      const t = parseFloat(tStr), a = parseFloat(aStr);
      if(isNaN(t) || isNaN(a)){ ok=false; msg=`第${i+1}行：噪音数值需为数字`; break; }
      if(t < a){ ok=false; msg=`第${i+1}行：总噪音应≥环境噪音`; break; }
      const calc = computeNoise(tStr, aStr);
      if(calc!=null){ ndb = calc; }
    }

    rows.push({ idx:i+1, data_id: perfTable.children[i].dataset.dataId || null, rpm:rpm, airflow_cfm:air, noise_db:ndb });
  }
  if(!ok) return { ok:false, msg };
  if(rows.length===0) return { ok:false, msg:'请至少填写一行数据' };
  return { ok:true, rows };
}

function drawScatter(canvas, pairs, xLabel, yLabel){
  const ctx=canvas.getContext('2d'); const W=canvas.width, H=canvas.height;
  ctx.clearRect(0,0,W,H);
  if(pairs.length===0){ ctx.fillStyle='#999'; ctx.fillText('无数据', 10, 20); return; }
  const pad=36;
  const xs=pairs.map(p=>p[0]), ys=pairs.map(p=>p[1]);
  const xmin=Math.min(...xs), xmax=Math.max(...xs);
  const ymin=Math.min(...ys), ymax=Math.max(...ys);
  const xspan=(xmax-xmin)||1, yspan=(ymax-ymin)||1;
  ctx.strokeStyle='#999'; ctx.beginPath();
  ctx.moveTo(pad,H-pad); ctx.lineTo(W-pad,H-pad);
  ctx.moveTo(pad,H-pad); ctx.lineTo(pad,pad);
  ctx.stroke();
  ctx.fillStyle='#ccc'; ctx.font='12px system-ui';
  ctx.fillText(xLabel, W/2-20, H-8);
  ctx.save(); ctx.translate(12, H/2+20); ctx.rotate(-Math.PI/2); ctx.fillText(yLabel, 0, 0); ctx.restore();
  ctx.fillStyle='#888';
  ctx.fillText(String(xmin), pad, H-pad+14);
  ctx.fillText(String(xmax), W-pad-24, H-pad+14);
  ctx.fillText(String(ymin), 4, H-pad);
  ctx.fillText(String(ymax), 4, pad+6);
  ctx.fillStyle='#38bdf8';
  pairs.forEach(p=>{
    const x=pad + (p[0]-xmin)/xspan*(W-2*pad);
    const y=H-pad - (p[1]-ymin)/yspan*(H-2*pad);
    ctx.beginPath(); ctx.arc(x,y,3,0,2*Math.PI); ctx.fill();
  });
  ctx.strokeStyle='#64b5f6'; ctx.beginPath();
  const sorted=[...pairs].sort((a,b)=>a[0]-b[0]);
  sorted.forEach((p,i)=>{
    const x=pad + (p[0]-xmin)/xspan*(W-2*pad);
    const y=H-pad - (p[1]-ymin)/yspan*(H-2*pad);
    if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  });
  ctx.stroke();
}

// 提交按钮：提交前强制校验“更新描述”，并随请求提交 description 字段
perfSubmitBtn.addEventListener('click', async ()=>{
  console.info('[UI] perfSubmit clicked', { mode, mid: parseInt(upModelId.value||'0',10), cid: parseInt(upConditionSelect.value||'0',10) });
  perfSubmitMsg.textContent=''; perfSubmitMsg.className='';
  const mid=parseInt(upModelId.value||'0',10), cid=parseInt(upConditionSelect.value||'0',10);
  if(mid<=0 || cid<=0){ perfSubmitMsg.className='err'; perfSubmitMsg.textContent='请先完整选择品牌/型号/工况'; return; }

  const desc = (document.querySelector('#updateDesc')?.value || '').trim();

  const res = gatherRowsForPreview();
  if(!res.ok){ perfSubmitMsg.className='err'; perfSubmitMsg.textContent=res.msg; previewArea.style.display='none'; return; }
  if(mode==='edit' && !previewReady){
    const hasRowChange = res.rows.some(r=>{
      const origin = loadedGroupRows.find(x=>String(x.data_id)===String(r.data_id));
      if(!origin) return false;
      const airChanged = (origin.airflow_cfm==null || origin.airflow_cfm==='') && r.airflow_cfm!=null;
      const noiseChanged = (origin.noise_db==null || origin.noise_db==='') && r.noise_db!=null;
      return airChanged || noiseChanged;
    });
    const isValidChanged = (parseInt(isValidSelect.value,10) !== parseInt(initialIsValidOnLoad,10));
    if(!hasRowChange && !isValidChanged){ perfSubmitMsg.className='err'; perfSubmitMsg.textContent='无变更可预览：未补全任何空值且 is_valid 未变化'; return; }
  }
  if(!previewReady){
    renderPreview(res.rows);
    previewReady=true;
    perfSubmitBtn.textContent='提交';
    perfSubmitMsg.className='ok'; perfSubmitMsg.textContent='预览成功，请确认后点击提交';
    return;
  }
  const res2 = gatherRowsForPreview();
  if(!res2.ok){ perfSubmitMsg.className='err'; perfSubmitMsg.textContent='内容已变更，请先重新预览'; previewReady=false; perfSubmitBtn.textContent='预览'; return; }

  if(!desc){ perfSubmitMsg.className='err'; perfSubmitMsg.textContent='请填写更新描述'; return; }

  perfSubmitBtn.disabled=true;
  try{
     if(mode==='reupload' || mode==='new'){
       const batchId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() :
         ('xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c=>{
           const r=Math.random()*16|0, v=c==='x'?r:(r&0x3|0x8); return v.toString(16);
         }));
      const r=await fetch('/admin/api/data/perf/add',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          model_id: mid,
          condition_id: cid,
          batch_id: batchId,
          is_valid: parseInt(isValidSelect.value,10),
          description: desc,
          rows: res2.rows.map(x=>({ rpm:x.rpm, airflow_cfm:x.airflow_cfm, noise_db:x.noise_db }))
        })
      });
      const j=await r.json();
      if(j.success){
        perfSubmitMsg.className='ok';
        perfSubmitMsg.textContent=`成功插入 ${j.data.inserted} 行`;
        previewReady=false; perfSubmitBtn.textContent='预览';

        // 新版绑定：使用 audio_batch_id（lastCalibBatchId）+ perf_batch_id
        try {
          const perfBatchId = j.data.batch_id;
          const abid = (typeof window.lastCalibBatchId === 'string' && window.lastCalibBatchId.trim())
            ? window.lastCalibBatchId.trim()
            : null;
          if (abid) {
            const resp = await fetch('/admin/api/calib/bind-model', {
              method:'POST',
              headers:{'Content-Type':'application/json'},
              body: JSON.stringify({ model_id: mid, condition_id: cid, perf_batch_id: perfBatchId, audio_batch_id: abid })
            });
            const jb = await resp.json().catch(()=>({success:false}));
            if (!jb.success) {
              let extra = '';
              const binds = jb.meta && Array.isArray(jb.meta.bindings) ? jb.meta.bindings : [];
              if (binds.length) {
                const pairs = binds.map(b => `${b.model_name || `mid=${b.model_id}`} - ${b.condition_name_zh || `cid=${b.condition_id}`}`).join('；');
                extra = `（已绑定：${pairs}）`;
              }
              console.warn('bind-model failed:', jb.error_message || '', extra);
              const msgEl = document.querySelector('#perfSubmitMsg');
              if (msgEl) {
                msgEl.className = 'warn';
                msgEl.textContent = (msgEl.textContent ? msgEl.textContent + '；' : '') + `绑定音频失败：${jb.error_message || '请稍后重试'}${extra}`;
              }
            }
          }
        } catch (e) {
          console.warn('bind-model failed:', e);
        }
      } else {
        perfSubmitMsg.className='err'; perfSubmitMsg.textContent=j.error_message||'提交失败';
      }
    } else if(mode==='edit'){
      const changes=[];
      res2.rows.forEach(r=>{
        const origin = loadedGroupRows.find(x=>String(x.data_id)===String(r.data_id));
        if(!origin) return;
        const ch={ data_id: r.data_id };
        if((origin.airflow_cfm==null || origin.airflow_cfm==='') && r.airflow_cfm!=null){ ch.airflow_cfm = r.airflow_cfm; }
        if((origin.noise_db==null || origin.noise_db==='') && r.noise_db!=null){ ch.noise_db = r.noise_db; }
        if(ch.airflow_cfm!==undefined || ch.noise_db!==undefined){ changes.push(ch); }
      });
      if(changes.length===0 && (parseInt(isValidSelect.value,10) === parseInt(initialIsValidOnLoad,10))){ perfSubmitMsg.className='err'; perfSubmitMsg.textContent='没有可提交的变更'; perfSubmitBtn.disabled=false; return; }
      const r=await fetch('/admin/api/data/perf/group-edit',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          model_id: mid,
          condition_id: cid,
          group_key: currentGroupKey,
          is_valid: parseInt(isValidSelect.value,10),
          description: desc,
          changes
        })
      });
      const j=await r.json();
      if(j.success){
        const rowsChanged = (j.data?.updated_rows || 0) + (j.data?.state_changed_rows || 0);
        perfSubmitMsg.className='ok';
        perfSubmitMsg.textContent=`编辑提交成功，更新 ${rowsChanged} 行`;
        previewReady=false; perfSubmitBtn.textContent='预览';

        // 新增：编辑模式下也进行绑定与预热频谱（使用当前组 key 或活动组）
        try {
          const abid = (typeof window.lastCalibBatchId === 'string' && window.lastCalibBatchId.trim())
            ? window.lastCalibBatchId.trim()
            : null;
          const perfBatchId = currentGroupKey || activeGroupKey || null;
          if (abid && perfBatchId) {
            const resp = await fetch('/admin/api/calib/bind-model', {
              method:'POST',
              headers:{'Content-Type':'application/json'},
              body: JSON.stringify({ model_id: mid, condition_id: cid, perf_batch_id: perfBatchId, audio_batch_id: abid })
            });
            const jb = await resp.json().catch(()=>({success:false}));
            if (!jb.success) {
              let extra = '';
              const binds = jb.meta && Array.isArray(jb.meta.bindings) ? jb.meta.bindings : [];
              if (binds.length) {
                const pairs = binds.map(b => `${b.model_name || `mid=${b.model_id}`} - ${b.condition_name_zh || `cid=${b.condition_id}`}`).join('；');
                extra = `（已绑定：${pairs}）`;
              }
              console.warn('bind-model (edit) failed:', jb.error_message || '', extra);
              const msgEl = document.querySelector('#perfSubmitMsg');
              if (msgEl) {
                msgEl.className = 'warn';
                msgEl.textContent = (msgEl.textContent ? msgEl.textContent + '；' : '') + `绑定音频失败：${jb.error_message || '请稍后重试'}${extra}`;
              }
            }
          }
        } catch(e) {
          console.warn('bind-model (edit) failed:', e);
        }
      } else {
        perfSubmitMsg.className='err'; perfSubmitMsg.textContent=j.error_message||'提交失败';
      }
    }
  }catch{
    perfSubmitMsg.className='err'; perfSubmitMsg.textContent='网络或服务器错误';
  }finally{
    perfSubmitBtn.disabled=false;
  }
});

if($('#restoreBtn')) $('#restoreBtn').addEventListener('click', async ()=>{ const ok = await restoreDraft(); if(ok){ $('#restoreBar').style.display='none'; } else { alert('未找到可恢复的草稿或草稿信息不完整，无法恢复'); } });
if($('#discardBtn')) $('#discardBtn').addEventListener('click', ()=>{ clearDraft(); });

// restoreDraft：恢复“更新描述/切换按钮/历史组选择”
async function restoreDraft(){
  const raw = localStorage.getItem(LS_KEY); if(!raw) return false;
  let d=null; try{ d=JSON.parse(raw); }catch(e){ return false; }
  if(!d || !hasMeaningfulDraft(d)) return false;
  suspendDraft = true;

  let bid = d.bid;
  if(!bid && d.bLabel){
    const r=await fetch(`/admin/api/data/brand/search?q=${encodeURIComponent(d.bLabel)}`);
    const j=await r.json();
    if(j.success){
      const exact=(j.data.items||[]).find(x=>x.label===d.bLabel);
      if(exact) bid=exact.brand_id;
    }
  }
  if(bid){ upBrandId.value=String(bid); upBrandInput.value=d.bLabel||''; await loadModelsForBrand(bid); }
  else { upBrandInput.value=d.bLabel||''; await loadConditions(); }
  if(d.mid){ upModelId.value=String(d.mid); upModelInput.value=d.mLabel||''; }
  if(d.cid){ upConditionSelect.value = d.cid; }

  await checkExisting();

  // 恢复历史数据操作切换（重新上传/编辑）
  if(d.existOpt){
    const radio = document.querySelector(`input[name="existOpt"][value="${d.existOpt}"]`);
    if(radio){
      radio.checked = true;
      const maybePromise = radio.onchange && radio.onchange();
      if(maybePromise && typeof maybePromise.then==='function'){ try{ await maybePromise; }catch(e){} }
    }
  }

  // 若为编辑模式，恢复已选择的历史组（不自动载入，仅恢复下拉选择）
  if(d.existOpt === 'edit' && d.selGroupKey){
    // 等待下拉选项加载完成
    const waitForOption = async (val, timeout=3000)=>{
      const start=Date.now();
      while(Date.now()-start < timeout){
        if([...document.querySelectorAll('#groupSelect option')].some(o=>o.value===val)) return true;
        await new Promise(r=>setTimeout(r,100));
      }
      return false;
    };
    if(await waitForOption(d.selGroupKey)){
      const sel = document.querySelector('#groupSelect');
      if(sel){ sel.value = d.selGroupKey; }
    }
  }

  if(d.mode==='edit'){
    setMode('edit');
    isValidSelect.value = d.isValid || '0';
    isValidSelect.disabled = true;
    if(d.currentGroupKey){
      $('#groupSelect').value = d.currentGroupKey;
      await loadGroupByKey(d.currentGroupKey);
    }
  } else {
    setMode(d.mode==='reupload'?'reupload':'new');
    isValidSelect.value = d.isValid || '0';
    perfTable.innerHTML='';
    if(d.rows && d.rows.length){
      d.rows.forEach(r=> addPerfRow({ rpm: r.rpm, airflow_cfm: r.airflow_cfm, noise_db: r.noise_db, total_db: r.total_db, ambient_db: r.ambient_db }));
    } else { addPerfRow(); }
  }

  // 恢复更新描述（若无则按模式默认）
  const descEl = document.querySelector('#updateDesc');
  if(descEl){
    if(typeof d.desc === 'string'){
      descEl.value = d.desc;
    }else{
      descEl.value = (d.mode==='new' ? '上传数据' : '');
    }
  }

  suspendDraft = false;
  saveDraft();
  return true;
}
function clearDraft(){ suspendDraft = true; try{ localStorage.removeItem(LS_KEY); }catch(e){} $('#restoreBar').style.display='none'; setTimeout(()=>{ suspendDraft = false; }, 0); }
function bindDraftAutoSave(){
  [upBrandInput, upModelInput, upConditionSelect, isValidSelect].forEach(el=>{
    if(!el) return;
    el.addEventListener('change', saveDraft);
    if(el===upModelInput){ el.addEventListener('input', saveDraft); }
  });
  // 新增：更新描述
  const descEl = document.querySelector('#updateDesc');
  if(descEl){
    descEl.addEventListener('input', saveDraft);
    descEl.addEventListener('change', saveDraft);
  }
  document.querySelectorAll('input[name="existOpt"]').forEach(r=> r.addEventListener('change', saveDraft));
  if($('#groupSelect')) $('#groupSelect').addEventListener('change', saveDraft);
  new MutationObserver(()=>saveDraft()).observe(perfTable, { childList:true, subtree:true, attributes:false });
}

// 调整：批量管理区动作栏改用统一样式（不撑满整行，按钮右侧预留提示）
async function initBatchManageSection(){
  const panel = document.querySelector('#panel-upload');
  if(!panel) return;

  let uploadBox = document.querySelector('#uploadEditorBox');
  if(!uploadBox){
    uploadBox = document.createElement('div');
    uploadBox.id = 'uploadEditorBox';
    const nodes = [];
    let cur = panel.firstElementChild;
    while(cur && cur.tagName !== 'H3'){ cur = cur.nextElementSibling; }
    if(cur){ cur = cur.nextElementSibling; }
    while(cur){ nodes.push(cur); cur = cur.nextElementSibling; }
    nodes.forEach(n => uploadBox.appendChild(n));
    panel.appendChild(uploadBox);
  }

  const segWrap = document.createElement('div');
  segWrap.className = 'seg'; segWrap.style.marginBottom = '10px';
  segWrap.innerHTML = `
    <input type="radio" id="umUpload" name="uploadMode" value="upload" checked />
    <label for="umUpload">上传/编辑数据</label>
    <input type="radio" id="umBatch" name="uploadMode" value="batch" />
    <label for="umBatch">批量管理数据</label>
  `;
  panel.insertBefore(segWrap, uploadBox);

  const batchBox = document.createElement('div');
  batchBox.id = 'batchManageBox';
  batchBox.style.display = 'none';
  batchBox.innerHTML = `
    <div class="row">
      <div>
        <label>品牌（多选）</label>
        <input id="bmBrandInput" type="search" placeholder="点击选择或下拉全量" autocomplete="off" />
        <div id="bmBrandChips" style="margin-top:6px;"></div>
      </div>
      <div>
        <label>型号（多选）</label>
        <input id="bmModelInput" type="search" placeholder="可按品牌过滤；未选品牌默认全量" autocomplete="off" />
        <div id="bmModelChips" style="margin-top:6px;"></div>
      </div>
      <div>
        <label>工况 - 类型 - 位置（多选）</label>
        <input id="bmCondInput" type="search" placeholder="点击选择或下拉全量" autocomplete="off" />
        <div id="bmCondChips" style="margin-top:6px;"></div>
      </div>
    </div>
    <div class="row">
      <div>
        <label>创建时间（起）</label>
        <input id="bmDateFrom" type="datetime-local" />
      </div>
      <div>
        <label>创建时间（止）</label>
        <input id="bmDateTo" type="datetime-local" />
      </div>
      <div>
        <label>is_valid</label>
        <div style="display:flex; gap:12px; align-items:center; padding:6px 0;">
          <label style="font-weight:400; display:flex; align-items:center; gap:6px; height:32px; line-height:1;">
            <input type="checkbox" id="bmIv0" style="width:16px; height:16px;" checked /> <span>0</span>
          </label>
          <label style="font-weight:400; display:flex; align-items:center; gap:6px; height:32px; line-height:1;">
            <input type="checkbox" id="bmIv1" style="width:16px; height:16px;" checked /> <span>1</span>
          </label>
        </div>
      </div>
      <div class="align-end">
        <button id="bmSearchBtn" type="button">搜索</button>
      </div>
    </div>
    <div class="table-wrap" style="margin-top:10px;">
      <div class="table-scroll">
        <table id="bmResultTable">
          <thead>
            <tr>
              <th><input type="checkbox" id="bmCheckAll" /></th>
              <th>is_valid</th>
              <th>品牌</th>
              <th>型号</th>
              <th>工况</th>
              <th>条数</th>
              <th>创建时间</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    </div>
    <!-- 统一动作栏样式 -->
    <div class="action-bar" id="bmActionBar">
      <div class="ab-iv">
        <label for="bmTargetIv">设置 is_valid</label>
        <select id="bmTargetIv">
          <option value="" selected disabled>请选择</option>
          <option value="0">0（不公开）</option>
          <option value="1">1（公开）</option>
        </select>
      </div>
      <div class="ab-desc">
        <label for="bmDesc">更新描述（必填）</label>
        <input id="bmDesc" type="text" placeholder="请填写本次批量更新说明" />
      </div>
      <div class="ab-btns">
        <button id="bmApplyBtn" type="button">批量提交</button>
        <span class="ab-msg"><span id="bmMsg" class="hint"></span></span>
      </div>
    </div>
  `;
  panel.appendChild(batchBox);

  // 统一占位表头
  setBatchTableHeaderUnified();

  // 子页签切换
  const umUpload = document.querySelector('#umUpload');
  const umBatch = document.querySelector('#umBatch');
  const switchView = ()=>{
    const mode = document.querySelector('input[name="uploadMode"]:checked')?.value || 'upload';
    uploadBox.style.display = (mode==='upload' ? '' : 'none');
    batchBox.style.display = (mode==='batch' ? '' : 'none');
  };
  umUpload.addEventListener('change', switchView);
  umBatch.addEventListener('change', switchView);
  switchView();

  // 初始化选项与行为
  initBatchFilters();
}

let bmSelectedBrands = [];      // {id, label}
let bmSelectedModels = [];      // {id, label}
let bmSelectedConds = [];       // {id, label}

function chipHTML(label, id, type){
  return `<span class="badge" data-type="${type}" data-id="${id}" style="margin-right:6px; margin-bottom:6px; display:inline-flex; gap:6px; align-items:center;">
    ${label}<button type="button" data-role="rm" style="height:20px; padding:0 6px;" class="btn-ghost">×</button>
  </span>`;
}

// 更新：initBatchFilters —— 渲染“已选列表”固定高度；型号括号只显示品牌中文；对齐要求已满足
async function initBatchFilters(){
  // 默认时间近7天
  try{
    const now = new Date();
    const end = new Date(now.getTime() + 8*3600*1000);
    const start = new Date(end.getTime() - 7*24*3600*1000);
    const fmt = (d)=> d.toISOString().slice(0,16);
    $('#bmDateFrom').value = fmt(start);
    $('#bmDateTo').value = fmt(end);
  }catch{}

  const brandLabelById = new Map();
  const condLabelById = new Map();
  const modelLabelById = new Map();

  const brandSelectedSet = new Set(bmSelectedBrands.map(x=>x.id));
  const modelSelectedSet = new Set(bmSelectedModels.map(x=>x.id));
  const condSelectedSet  = new Set(bmSelectedConds.map(x=>x.id));

  const brandPicker = createMultiPicker($('#bmBrandInput'), {
    title: '选择品牌',
    fetchOnce: async ()=>{
      const r = await fetch('/admin/api/data/brand/all');
      const j = await r.json();
      const items = (j.success ? j.data.items : []).map(b=>({ id: b.brand_id, label: b.label }));
      items.forEach(it=> brandLabelById.set(it.id, it.label));
      return { items };
    },
    dependencyKey: null,
    toLabel: it => it.label,
    getId: it => it.id,
    selectedSet: brandSelectedSet,
    onApply: ()=>{
      bmSelectedBrands = [...brandSelectedSet].map(id=> ({ id, label: brandLabelById.get(id) || String(id) }));
      // 品牌变化清空型号
      bmSelectedModels = [];
      modelSelectedSet.clear();
      modelPicker && modelPicker.renderSelected();
    },
    selectedContainer: $('#bmBrandChips')
  });
  brandPicker.renderSelected();

  const condPicker = createMultiPicker($('#bmCondInput'), {
    title: '选择工况 - 类型 - 位置',
    fetchOnce: async ()=>{
      const r = await fetch('/admin/api/data/conditions/all');
      const j = await r.json();
      const items = (j.success ? j.data.items : []).map(c=>({ id: c.condition_id, label: c.label }));
      items.forEach(it=> condLabelById.set(it.id, it.label));
      return { items };
    },
    dependencyKey: null,
    toLabel: it => it.label,
    getId: it => it.id,
    selectedSet: condSelectedSet,
    onApply: ()=>{
      bmSelectedConds = [...condSelectedSet].map(id=> ({ id, label: condLabelById.get(id) || String(id) }));
    },
    selectedContainer: $('#bmCondChips')
  });
  condPicker.renderSelected();

  const modelPicker = createMultiPicker($('#bmModelInput'), {
    title: '选择型号',
    fetchOnce: async ()=>{
      const params = new URLSearchParams();
      if(bmSelectedBrands.length){
        params.set('brand_ids', bmSelectedBrands.map(x=>x.id).join(','));
      }
      params.set('limit','200');
      const r = await fetch(`/admin/api/data/batch/models?${params.toString()}`);
      const j = await r.json();
      const items = (j.success ? j.data.items : []).map(m=>{
        // 仅显示品牌中文名
        const brandZh = (m.brand_label || '').split('/')[0].trim();
        const lbl = `${m.model_name}（${brandZh}）`;
        modelLabelById.set(m.model_id, lbl);
        return { id: m.model_id, label: lbl };
      });
      return { items };
    },
    dependencyKey: ()=> bmSelectedBrands.map(x=>x.id).sort().join(','),
    toLabel: it => it.label,
    getId: it => it.id,
    selectedSet: modelSelectedSet,
    onApply: ()=>{
      bmSelectedModels = [...modelSelectedSet].map(id=> ({ id, label: modelLabelById.get(id) || String(id) }));
    },
    selectedContainer: $('#bmModelChips')
  });
  modelPicker.renderSelected();

  // 搜索与提交
  $('#bmSearchBtn').addEventListener('click', doBatchSearch);
  $('#bmApplyBtn').addEventListener('click', applyBatchUpdate);
}

// 修改：renderChips 支持同步 picker 的 selectedSet（删除 chip 时同步取消勾选）
function renderChips(containerSel, list, type, selectedSet){
  const box = document.querySelector(containerSel);
  box.innerHTML = list.map(x=> `<span class="badge" data-type="${type}" data-id="${x.id}" style="margin-right:6px; margin-bottom:6px; display:inline-flex; gap:6px; align-items:center;">
    ${x.label}<button type="button" data-role="rm" style="height:20px; padding:0 6px;" class="btn-ghost">×</button>
  </span>`).join('');
  box.querySelectorAll('button[data-role="rm"]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const idAttr = btn.parentElement.getAttribute('data-id');
      const id = /^\d+$/.test(idAttr) ? parseInt(idAttr,10) : idAttr;
      const arr = (type==='brand') ? bmSelectedBrands : (type==='model'? bmSelectedModels : bmSelectedConds);
      const idx = arr.findIndex(x=>x.id===id);
      if(idx>-1){ arr.splice(idx,1); }
      if(selectedSet && selectedSet.has(id)){ selectedSet.delete(id); }
      renderChips(containerSel, arr, type, selectedSet);
    });
  });
}

function debounce(fn, wait){ let t=null; return function(){ const ctx=this, args=arguments; clearTimeout(t); t=setTimeout(()=>fn.apply(ctx,args), wait); }; }

async function doBatchSearch(){
  const bmMsg = $('#bmMsg'); bmMsg.textContent='';
  const payload = {
    brand_ids: bmSelectedBrands.map(x=>x.id),
    model_ids: bmSelectedModels.map(x=>x.id),
    condition_ids: bmSelectedConds.map(x=>x.id),
    is_valid: [ $('#bmIv0').checked ? 0 : null, $('#bmIv1').checked ? 1 : null ].filter(v=>v!=null),
    date_from: $('#bmDateFrom').value ? $('#bmDateFrom').value.replace('T',' ') + ':00' : '',
    date_to:   $('#bmDateTo').value ? $('#bmDateTo').value.replace('T',' ') + ':59' : '',
    page: 1,
    page_size: 100
  };
  try{
    const r = await fetch('/admin/api/data/batch/search', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    const j = await r.json();
    if(!j.success){ bmMsg.className='err'; bmMsg.textContent=j.error_message||'搜索失败'; return; }
    renderBatchResults(j.data.items||[]);
    bmMsg.className='hint'; bmMsg.textContent = `共 ${j.data.total||0} 条，显示前 ${ (j.data.items||[]).length } 条`;
  }catch{
    bmMsg.className='err'; bmMsg.textContent='网络或服务器错误';
  }
}

// 修改：渲染空结果时也重置统一表头（防止因清空后回到不统一的表头状态）
function renderBatchResults(items){
  const thead = document.querySelector('#bmResultTable thead tr');
  if(thead){
    thead.innerHTML = `
      <th><input type="checkbox" id="bmCheckAll" style="width:16px;height:16px;" /></th>
      <th>is_valid</th>
      <th>品牌</th>
      <th>型号</th>
      <th>工况</th>
      <th>条数</th>
      <th>创建时间</th>
    `;
  }
  const tb = document.querySelector('#bmResultTable tbody');
  tb.innerHTML='';
  (items||[]).forEach(it=>{
    const tr=document.createElement('tr');
    tr.dataset.batchId = it.batch_id;
    tr.innerHTML = `
      <td><input type="checkbox" class="bmRowChk" style="width:16px;height:16px;" /></td>
      <td class="bmIv">${it.is_valid}</td>
      <td>${escapeHtml(it.brand_name||'')}</td>
      <td>${escapeHtml(it.model_name||'')}</td>
      <td>${escapeHtml(it.condition_name||'')}</td>
      <td>${it.data_count ?? ''}</td>
      <td class="bmDate">${it.create_date ?? ''}</td>
    `;
    tb.appendChild(tr);
  });
  const all = document.querySelector('#bmCheckAll');
  if(all){
    all.checked = false;
    all.addEventListener('change', ()=>{
      document.querySelectorAll('.bmRowChk').forEach(cb=> cb.checked = all.checked);
    });
  }
}

function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m] )); }

// 调整：批量提交时强校验 is_valid 必须手动选择（不再默认 0）
async function applyBatchUpdate(){
  const bmMsg = $('#bmMsg'); bmMsg.textContent=''; bmMsg.className='hint';
  const targetStr = ($('#bmTargetIv').value ?? '').trim();
  if(targetStr === ''){ bmMsg.className='err'; bmMsg.textContent='请选择 is_valid'; return; }
  const target = parseInt(targetStr, 10);
  if(!(target===0 || target===1)){ bmMsg.className='err'; bmMsg.textContent='is_valid 取值非法'; return; }

  const desc = ($('#bmDesc').value||'').trim();
  const batchIds = [...document.querySelectorAll('#bmResultTable tbody tr')].filter(tr=> tr.querySelector('.bmRowChk')?.checked).map(tr=> tr.dataset.batchId);
  if(batchIds.length===0){ bmMsg.className='err'; bmMsg.textContent='请至少勾选一条'; return; }
  if(!desc){ bmMsg.className='err'; bmMsg.textContent='请填写更新描述'; return; }
  try{
    $('#bmApplyBtn').disabled = true;
    const r = await fetch('/admin/api/data/batch/update-state', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ batch_ids: batchIds, target_is_valid: target, description: desc })
    });
    const j = await r.json();
    if(!j.success){
      bmMsg.className='err'; bmMsg.textContent=j.error_message||'更新失败';
    }else{
      const failedSet = new Set((j.data.updated_failed||[]).map(x=>x.batch_id));
      await refreshBatchStatuses(batchIds);
      document.querySelectorAll('#bmResultTable tbody tr').forEach(tr=>{
        tr.style.background = '';
        const bid = tr.dataset.batchId;
        if(failedSet.has(bid)){ tr.style.background = 'color-mix(in oklab, var(--err), transparent 85%)'; }
      });
      const hasFail = failedSet.size>0;
      const hasChange = (j.data.updated_success||[]).length>0;
      bmMsg.className = hasFail ? 'warn' : (hasChange ? 'ok' : 'hint');
      bmMsg.textContent = hasFail ? '部分条目更新状态失败' : (hasChange ? '批量更新完成' : '未发生变化');
    }
  }catch{
    bmMsg.className='err'; bmMsg.textContent='网络或服务器错误';
  }finally{
    $('#bmApplyBtn').disabled = false;
  }
}

async function refreshBatchStatuses(batchIds){
  try{
    const r = await fetch('/admin/api/data/batch/status', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ batch_ids: batchIds }) });
    const j = await r.json();
    if(!j.success) return;
    const map = new Map();
    (j.data.items||[]).forEach(it=> map.set(it.batch_id, it));
    document.querySelectorAll('#bmResultTable tbody tr').forEach(tr=>{
      const info = map.get(tr.dataset.batchId);
      if(info){
        tr.querySelector('.bmIv').textContent = String(info.is_valid);
        tr.querySelector('.bmDate').textContent = info.create_date || '';
      }
    });
  }catch{}
}

// 更新：通用多选浮层 —— 修复按钮被遮挡、行紧凑、固定已选列表高度，统一蓝色勾选
function createMultiPicker(anchorEl, {
  title,
  fetchOnce,
  dependencyKey,
  toLabel,
  getId,
  selectedSet,
  onApply,
  selectedContainer
}){
  let cache = null;   // { dep, items, labelById }
  let panel, listEl, searchEl, countEl;

  async function ensureData(){
    const dep = dependencyKey ? dependencyKey() : '__static__';
    if(cache && cache.dep === dep) return cache.items;
    const { items } = await fetchOnce();
    const labelById = new Map();
    items.forEach(it => labelById.set(getId(it), toLabel(it)));
    cache = { dep, items, labelById };
    return items;
  }

  function ensurePanel(){
    if(panel) return;
    panel = document.createElement('div');
    panel.className = 'picker';
    panel.style.cssText = `
      position:absolute; z-index:1000; min-width:320px; max-width:560px;
      max-height:420px; overflow:hidden; display:none;
      background: var(--card); border:1px solid var(--border); border-radius:10px; box-shadow: var(--shadow);
    `;
    panel.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px; padding:8px 10px; border-bottom:1px solid var(--border);">
        <div style="font-weight:700; flex:0 0 auto;">${title||''}</div>
        <input class="picker-search" placeholder="过滤关键字" style="flex:1 1 auto; height:32px; padding:0 10px; border:1px solid var(--border); border-radius:8px; color:var(--text); background:var(--card);" />
      </div>
      <div style="display:flex; align-items:center; gap:8px; padding:6px 10px; border-bottom:1px solid var(--border);">
        <button type="button" data-act="sel-all" class="btn-ghost" style="height:28px;">全选</button>
        <button type="button" data-act="clear" class="btn-ghost" style="height:28px;">清空</button>
        <span class="hint" data-role="count" style="margin-left:auto;"></span>
      </div>
      <div class="picker-list" style="overflow:auto; max-height:300px; padding:4px 8px;"></div>
      <div style="display:flex; gap:8px; justify-content:flex-end; padding:8px 10px; border-top:1px solid var(--border);">
        <button type="button" data-act="apply">应用</button>
        <button type="button" class="btn-ghost" data-act="close">关闭</button>
      </div>
    `;
    listEl = panel.querySelector('.picker-list');
    searchEl = panel.querySelector('.picker-search');
    countEl = panel.querySelector('[data-role="count"]');
    document.body.appendChild(panel);

    panel.addEventListener('click', e=>{
      const act = e.target.getAttribute('data-act');
      if(act==='apply'){ onApply && onApply(); renderSelected(); close(); }
      if(act==='close'){ close(); }
      if(act==='sel-all'){ listEl.querySelectorAll('input[type="checkbox"]').forEach(cb=> cb.checked=true); syncSetFromList(); }
      if(act==='clear'){ listEl.querySelectorAll('input[type="checkbox"]').forEach(cb=> cb.checked=false); syncSetFromList(); }
      updateCount();
    });
    searchEl.addEventListener('input', renderList);

    // 点击外部关闭
    document.addEventListener('click', (e)=>{
      if(panel.style.display==='none') return;
      if(!panel.contains(e.target) && e.target!==anchorEl){
        close();
      }
    });
    // 窗口变化时重新定位
    window.addEventListener('resize', ()=>{ if(panel && panel.style.display!=='none'){ position(anchorEl); } });
    window.addEventListener('scroll', ()=>{ if(panel && panel.style.display!=='none'){ position(anchorEl); } }, true);
  }

  // 注意：open 改为 async，先显示，再渲染，再定位（二次），避免底部按钮被遮挡
  async function open(){
    ensurePanel();
    panel.style.display = '';           // 先显示
    position(anchorEl);                 // 初定位（基于当前高度）
    await renderList();                 // 渲染列表（高度会变化）
    position(anchorEl);                 // 再定位，保证底部按钮露出
  }

  function close(){ if(panel) panel.style.display='none'; }

  // 可调参数：chrome 为头/操作/脚的总高度预留，必要时可调大（例如从 128 调到 148/160）
  function calcHeights(){
    const chrome = 148;   // ← 如果按钮仍未完全露出，调大这个值
    const maxH = 440;     // 面板最大高度上限
    return { chrome, maxH };
  }

  function position(anchor){
    const r = anchor.getBoundingClientRect();
    const viewportH = window.innerHeight || document.documentElement.clientHeight;
    const below = viewportH - r.bottom - 10;
    const above = r.top - 10;
    const { chrome, maxH: baseMaxH } = calcHeights();

    let place = 'below';
    let avail = below;
    if (below < 260 && above > below){ place = 'above'; avail = above; }

    const maxH = Math.max(260, Math.min(baseMaxH, avail));
    panel.style.maxHeight = maxH + 'px';
    const listMax = Math.max(120, maxH - chrome);
    listEl.style.maxHeight = listMax + 'px';

    panel.style.minWidth = Math.max(320, r.width) + 'px';
    panel.style.left = (window.scrollX + r.left) + 'px';
    // 计算真实高度后再放置，保证底部不被遮挡
    const ph = panel.offsetHeight || maxH;
    const belowTop = window.scrollY + r.bottom + 6;
    const aboveTop = window.scrollY + r.top - ph - 6;
    panel.style.top  = place==='below' ? Math.max(6, belowTop) + 'px' : Math.max(6, aboveTop) + 'px';
  }

  function updateCount(){
    if(!countEl) return;
    const cnt = listEl.querySelectorAll('input[type="checkbox"]:checked').length;
    countEl.textContent = `已选 ${cnt} 项`;
  }

  function syncSetFromList(){
    const ids = [...listEl.querySelectorAll('input[type="checkbox"]')].filter(cb=>cb.checked).map(cb=> cb.getAttribute('data-id'));
    selectedSet.clear();
    ids.forEach(id=>{
      selectedSet.add(/^\d+$/.test(id)? parseInt(id,10) : id);
    });
  }

  function renderSelected(){
    if(!selectedContainer) return;
    // 固定高度，三列对齐
    selectedContainer.style.border = '1px solid var(--border)';
    selectedContainer.style.borderRadius = '8px';
    selectedContainer.style.padding = '6px';
    selectedContainer.style.height = '140px';   // 固定高度（由原先 maxHeight 改为固定 height）
    selectedContainer.style.overflowY = 'auto';
    selectedContainer.style.background = 'color-mix(in oklab, var(--card), transparent 0%)';

    const ids = [...selectedSet];
    const rows = ids.map(id=>{
      const label = (cache && cache.labelById && cache.labelById.get(id)) || String(id);
      return { id, label };
    });
    selectedContainer.innerHTML = rows.map(x => `
      <div class="sel-row" data-id="${x.id}" style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:4px 6px; border-bottom:1px dashed var(--border);">
        <div style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${x.label}</div>
        <button type="button" class="btn-ghost" data-role="rm" style="height:24px; padding:0 8px;">×</button>
      </div>
    `).join('');
    const last = selectedContainer.querySelector('.sel-row:last-child');
    if(last){ last.style.borderBottom = 'none'; }
    selectedContainer.querySelectorAll('button[data-role="rm"]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const idAttr = btn.parentElement.getAttribute('data-id');
        const id = /^\d+$/.test(idAttr) ? parseInt(idAttr,10) : idAttr;
        if(selectedSet.has(id)) selectedSet.delete(id);
        renderSelected();
      });
    });
  }

  async function renderList(){
    const all = await ensureData();
    const kw = (searchEl.value||'').trim().toLowerCase();
    const filtered = kw ? all.filter(it => toLabel(it).toLowerCase().includes(kw)) : all;
    listEl.innerHTML = '';
    filtered.forEach(it=>{
      const id = getId(it);
      const lbl = toLabel(it);
      const row = document.createElement('label');
      // 更紧凑的条目；勾选框变大且统一蓝色
      row.style.cssText = 'display:flex; align-items:center; gap:8px; padding:4px 2px; cursor:pointer; font-size:14px;';
      row.innerHTML = `<input type="checkbox" data-id="${id}" style="width:16px; height:16px;"> <span style="line-height:1.2;">${lbl}</span>`;
      const cb = row.querySelector('input');
      cb.checked = selectedSet.has(id);
      cb.addEventListener('change', ()=>{
        if(cb.checked){ selectedSet.add(id); } else { selectedSet.delete(id); }
        updateCount();
      });
      listEl.appendChild(row);
    });
    updateCount();
  }

  anchorEl.addEventListener('click', (e)=>{ e.preventDefault(); open(); });
  return { open, close, renderSelected };
}

// 替换现有的 fixCondLayout：使用 CSS Grid 控制列宽，gap 仅控制列间距
function fixCondLayout(){
  // 可调参数
  const GAP_PX = 50;                 // 四列之间的间距（不会改变长度，只控制间隙）
  const POS_COL_WIDTH = 130;         // “风阻位置”列固定宽度（px），与 is_valid 下拉一致
  const GRID_FRAC = '1fr 1fr 1fr';   // 前三列的宽度比例（可改为 '1.2fr 1fr 1fr' 等）
  const SELECT_STD_WIDTH = 130;      // 下方 is_valid 下拉统一宽度（px）

  // 通用：把一行改成 grid：前三列自适应(1fr/1fr/1fr)，最后一列固定宽度
  function setupRow(containerSel, locSelectSel, isValidSel){
    const row = document.querySelector(`${containerSel} .row`);
    if(!row) return;

    // 改为 Grid 布局
    row.style.display = 'grid';
    row.style.gridTemplateColumns = `${GRID_FRAC} ${POS_COL_WIDTH}px`;
    row.style.columnGap = `${GAP_PX}px`;
    row.style.alignItems = 'end'; // 底对齐更整齐

    // 列容器允许收缩，子 input/select 100% 填满列
    row.querySelectorAll(':scope > div').forEach(col => {
      col.style.minWidth = '0';
      col.style.width = '100%';
      col.querySelectorAll('input, select').forEach(el => {
        el.style.width = '100%';
      });
    });

    // “风阻位置”列的选择框占满该固定列
    const locSel = row.querySelector(locSelectSel);
    if(locSel){ locSel.style.width = '100%'; }

    // 下方 is_valid 下拉与其他页面一致
    const iv = document.querySelector(isValidSel);
    if(iv){ iv.style.width = `${SELECT_STD_WIDTH}px`; }
  }

  // 添加工况
  setupRow('#condAddBox', 'select#rtLoc', '#condIsValid');
  // 编辑工况
  setupRow('#condEditBox', 'select#rtLocEdit', '#condEditIsValid');
}

// 新增：批量管理表头统一函数（占位/未载入时也与载入后保持一致的高度与勾选框大小）
function setBatchTableHeaderUnified() {
  const theadRow = document.querySelector('#bmResultTable thead tr');
  if (!theadRow) return;
  theadRow.innerHTML = `
    <th><input type="checkbox" id="bmCheckAll" style="width:16px;height:16px;" /></th>
    <th>is_valid</th>
    <th>品牌</th>
    <th>型号</th>
    <th>工况</th>
    <th>条数</th>
    <th>创建时间</th>
  `;
  // 绑定“全选”占位（即便无数据时也保持行为存在）
  const all = document.querySelector('#bmCheckAll');
  if (all) {
    all.checked = false;
    all.addEventListener('change', () => {
      document.querySelectorAll('.bmRowChk').forEach(cb => cb.checked = all.checked);
    });
  }
}

// 新增：统一“动作栏”样式（is_valid 下拉 + 更新描述 + 预览/提交按钮 + 提示），并为按钮右侧预留提示区域
function injectActionBarStyles(){
  if(document.getElementById('unifiedActionStyles')) return;
  const css = document.createElement('style');
  css.id = 'unifiedActionStyles';
  css.textContent = `
    /* 通用动作栏 */
    .action-bar { display:flex; gap:12px; align-items:flex-end; flex-wrap:wrap; margin-top:12px; }
    .action-bar .ab-iv { flex: 0 0 auto; }
    .action-bar .ab-iv select { width:130px; }

    .action-bar .ab-desc { flex: 1 1 360px; min-width:260px; }
    .action-bar .ab-desc input[type="text"],
    .action-bar .ab-desc input[type="search"],
    .action-bar .ab-desc textarea { width:100%; }

    .action-bar .ab-btns { margin-left:auto; display:flex; align-items:center; gap:10px; flex: 0 0 auto; }
    .action-bar .ab-btns .ab-msg {
      min-width:220px; max-width:40vw; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
    }
  `;
  document.head.appendChild(css);
}

function unifyUploadActionBar(){
  const panel = document.querySelector('#panel-upload');
  if(!panel) return;

  const isValid = document.querySelector('#isValidSelect');
  const desc = document.querySelector('#updateDesc');
  const btn = document.querySelector('#perfSubmitBtn');
  const msg = document.querySelector('#perfSubmitMsg');

  if(!isValid || !desc || !btn || !msg) return;
  if(document.querySelector('#uploadActionBar')) return;

  const origRow = panel.querySelector('#perfEditor .row.align-bottom.actions');

  const anchor = document.querySelector('#perfEditor') || panel;
  const bar = document.createElement('div');
  bar.id = 'uploadActionBar';
  bar.className = 'action-bar';

  const colIv = document.createElement('div');
  colIv.className = 'ab-iv';
  const lblIv = document.createElement('label');
  lblIv.textContent = 'is_valid';
  lblIv.setAttribute('for','isValidSelect');
  colIv.appendChild(lblIv);
  colIv.appendChild(isValid);

  const colDesc = document.createElement('div');
  colDesc.className = 'ab-desc';
  const lblDesc = document.createElement('label');
  lblDesc.textContent = '更新描述（必填）';
  lblDesc.setAttribute('for','updateDesc');
  colDesc.appendChild(lblDesc);
  colDesc.appendChild(desc);

  const colBtns = document.createElement('div');
  colBtns.className = 'ab-btns';
  const hint = document.createElement('span');
  hint.className = 'ab-msg';
  hint.appendChild(msg);
  colBtns.appendChild(btn);
  colBtns.appendChild(hint);

  bar.appendChild(colIv);
  bar.appendChild(colDesc);
  bar.appendChild(colBtns);

  if(anchor.nextSibling){ anchor.parentNode.insertBefore(bar, anchor.nextSibling); }
  else { anchor.parentNode.appendChild(bar); }

  // 关键：初始化时默认隐藏（避免首屏闪现），并与选择链联动
  bar.style.display = 'none';
  if (origRow) origRow.style.display = 'none';

  // 首次同步一次；并在选择变化时重同步
  syncUploadActionBarVisibility();
  [upBrandInput, upModelInput, upConditionSelect].forEach(el=>{
    if(!el) return;
    el.addEventListener('change', syncUploadActionBarVisibility);
    if(el===upModelInput) el.addEventListener('input', syncUploadActionBarVisibility);
  });
}

function renderPreview(rows){
  previewTableBody.innerHTML='';
  rows.forEach((r,i)=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${i+1}</td><td>${r.rpm}</td><td>${r.airflow_cfm ?? ''}</td><td>${r.noise_db??''}</td>`;
    previewTableBody.appendChild(tr);
  });
  // 仅绘制有风量/等效噪音的数据点
  const pairsRpmAir   = rows.filter(r=> r.airflow_cfm!=null && r.airflow_cfm!=='' && !isNaN(Number(r.airflow_cfm)))
                            .map(r=>[r.rpm, Number(r.airflow_cfm)]);
  const pairsRpmNoise = rows.filter(r=> r.noise_db!=null && r.noise_db!=='')
                            .map(r=>[r.rpm, Number(r.noise_db)]);
  drawScatter(chartRpmAir,  pairsRpmAir,   'rpm', 'airflow');
  drawScatter(chartNoiseAir, pairsRpmNoise, 'rpm', 'noise_db');
  previewArea.style.display='';
}

// ====== 噪音标定：上传zip并自动回填 ======

function injectUploadZipButton(){
  const anchorBox = document.querySelector('#perfEditor .flex-inline') || document.querySelector('#perfEditor');
  if(!anchorBox || document.getElementById('uploadZipBtn')) return;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'uploadZipBtn';
  btn.textContent = '上传音频zip';
  btn.style.marginLeft = '8px';

  const file = document.createElement('input');
  file.type = 'file';
  file.accept = '.zip';
  file.style.display = 'none';
  file.id = 'uploadZipFile';

  btn.addEventListener('click', async ()=>{
    // 模式与可用性判定
    const mid = parseInt(upModelId.value||'0',10);
    const cid = parseInt(upConditionSelect.value||'0',10);
    if(mid<=0 || cid<=0){ alert('请先选择品牌/型号/工况'); return; }

    // 新增：检查当前 mid+cid 是否已有绑定
try{
    const r = await fetch(`/admin/api/calib/bindings?model_id=${mid}&condition_id=${cid}`);
    const j = await r.json();
    if(j.success){
      const items = j.data.items || [];
      if(items.length > 0){
        const pick = await chooseExistingBinding(items);
        if(pick && pick !== '__go_upload__'){
          // 记住 audio 批次用于后续绑定与预览
          window.lastCalibBatchId = pick.audio_batch_id || null;

          // 回填噪音：按 audio_batch_id
          try{
            if(window.lastCalibBatchId){
              const r2 = await fetch(`/admin/api/calib/rpm-noise?audio_batch_id=${encodeURIComponent(window.lastCalibBatchId)}`);
              const j2 = await r2.json();
              if(j2.success){
                const items2 = j2.data.items || [];
                const isRowEmpty = tr => ([...tr.querySelectorAll('input')].every(inp => !String(inp.value||'').trim()));
                let emptyRows = [...perfTable.querySelectorAll('tr')].filter(isRowEmpty);
                for(const it2 of items2){
                  const rpm = parseInt(it2.rpm,10); if(!rpm) continue;
                  const ndb = (it2.noise_db!=null)? String(it2.noise_db) : '';
                  let row = [...perfTable.querySelectorAll('tr')]
                    .find(tr=> parseInt((tr.querySelector('.perf-rpm')?.value||'').trim(),10)===rpm);
                  if(!row){
                    if(emptyRows.length){
                      row = emptyRows.shift();
                      const rpmInp = row.querySelector('.perf-rpm');
                      const noiseInp = row.querySelector('.perf-noise');
                      if(rpmInp && (!rpmInp.value || !rpmInp.value.trim())) rpmInp.value = String(rpm);
                      if(noiseInp && (!noiseInp.value || !noiseInp.value.trim())) noiseInp.value = ndb;
                    }else{
                      addPerfRow({ rpm: rpm, airflow_cfm: '', noise_db: ndb });
                    }
                  }else{
                    const n = row.querySelector('.perf-noise');
                    if(n && (!n.value || n.value.trim()==='')) n.value = ndb;
                  }
                }
                renumberRows(); markDirty(); saveDraft();
              }
            }
          }catch(e){}

          // 预览
          if(window.lastCalibBatchId){ ensureCalibPreview(window.lastCalibBatchId); }
          return; // 不再弹出文件
        } else if (pick === '__go_upload__'){
          // 继续走选择文件
        } else {
          return; // 取消
        }
      }
    }
  }catch(e){ /* 忽略错误，继续走选择文件 */ }

    if(mode === 'edit'){
      // 仅当已载入历史数据且所有 noise_db 均为空时允许
      const allEmpty = [...perfTable.querySelectorAll('.perf-noise')].every(inp=> (inp.value||'').trim()==='');
      if(!currentGroupKey){ alert('请先载入历史组'); return; }
      if(!allEmpty){ alert('编辑模式下，只有全部等效噪音为空时才允许上传并回填'); return; }
    }
    document.getElementById('uploadZipFile').click();
  });

// 上传 zip 回填噪音：优先填充现有“全空行”，再考虑新增行（避免首行空着）
file.addEventListener('change', async ()=>{
  const f = file.files && file.files[0];
  if(!f){ return; }
  try{
    btn.disabled = true; btn.textContent = '处理中…';
    const mid = parseInt(upModelId.value||'0',10);
    const cid = parseInt(upConditionSelect.value||'0',10);

    const fd = new FormData();
    fd.append('model_id', String(mid));
    fd.append('condition_id', String(cid));
    fd.append('file', f);

    const r = await fetch('/admin/api/calib/upload_zip', { method:'POST', body: fd });
    const j = await r.json();
    if(!j.success){ alert(j.error_message||'上传失败'); return; }

    if (j.data && j.data.batch_id) {
        console.info('[UI] preview start', { batchId: j.data.batch_id });
        ensureCalibPreview(j.data.batch_id);
      }

    window.lastCalibBatchId = j.data.batch_id || null;
    window.lastCalibRunId = j.data.run_id ?? null;
    window.lastCalibModelHash = j.data.model_hash ?? null;

    // 新增：当音频已存在时，先做“绑定一致性”校验
    if (j.data.duplicated === 1) {
      const binds = Array.isArray(j.data.bindings) ? j.data.bindings : [];
      if (binds.length > 0) {
        const allSame = binds.every(b =>
          parseInt(b.model_id,10) === mid && parseInt(b.condition_id,10) === cid
        );
        if (!allSame) {
          const pairs = binds.map(b => {
            const m = b.model_name || `mid=${b.model_id}`;
            const c = b.condition_name_zh || `cid=${b.condition_id}`;
            return `${m} - ${c}`;
          }).join('；');
          alert(`该音频已绑定到其他型号/工况，已拒绝回填。\n已绑定：${pairs}\n如需回填，请切换到对应的型号/工况再试。`);
          window.lastCalibBatchId = null;
          window.lastCalibRunId = null;
          window.lastCalibModelHash = null;
          btn.disabled = false; btn.textContent = '上传音频zip'; file.value = '';
          return;
        }
        // allSame => 按需求“直接回填”，不再弹确认
      } else {
        // 尚未绑定：保留原有“确认后回填/预览”
        const boundCount = parseInt(j.data.bound_count ?? '0', 10) || 0;
        if (boundCount === 0) {
          if (confirm('检测到服务器已存在相同音频且尚未绑定任何型号/工况，是否直接回填/预览？')) {
            const items = j.data.rpm_noise || [];
            // 回填
            if (mode === 'reupload' || mode === 'new' || mode === 'edit') {
              const isRowEmpty = (tr)=>[...tr.querySelectorAll('input')].every(inp => !String(inp.value||'').trim());
              let emptyRows = [...perfTable.querySelectorAll('tr')].filter(isRowEmpty);
              for (const it of items) {
                const rpm = parseInt(it.rpm,10); if(!rpm) continue;
                const ndb = (it.noise_db!=null)? String(it.noise_db) : '';
                let row = [...perfTable.querySelectorAll('tr')]
                  .find(tr=> parseInt((tr.querySelector('.perf-rpm')?.value||'').trim(),10)===rpm);
                if(!row){
                  if(emptyRows.length){
                    row = emptyRows.shift();
                    const rpmInp = row.querySelector('.perf-rpm');
                    const noiseInp = row.querySelector('.perf-noise');
                    if(rpmInp && (!rpmInp.value||!rpmInp.value.trim())) rpmInp.value=String(rpm);
                    if(noiseInp && (!noiseInp.value||!noiseInp.value.trim())) noiseInp.value=ndb;
                  }else{
                    addPerfRow({ rpm:rpm, airflow_cfm:'', noise_db: ndb });
                  }
                }else{
                  const n = row.querySelector('.perf-noise');
                  if(n && (!n.value || n.value.trim()==='')) n.value = ndb;
                }
              }
              renumberRows(); markDirty(); saveDraft();
            }
            // 预览
            if (j.data.batch_id) {
              ensureCalibPreview(j.data.batch_id);
            }
            btn.disabled = false; btn.textContent = '上传音频zip'; file.value = '';
            return;
          }
        }
      }
    }

      // 回填逻辑
      const items = j.data.rpm_noise || [];
      if(mode === 'reupload' || mode === 'new'){
        // 收集当前完全空的行（所有输入均为空）
        const isRowEmpty = (tr)=>{
          const inps = tr.querySelectorAll('input');
          return [...inps].every(inp => !String(inp.value||'').trim());
        };
        let emptyRows = [...perfTable.querySelectorAll('tr')].filter(isRowEmpty);


        for(const it of items){
          const rpm = parseInt(it.rpm,10); if(!rpm) continue;
          const ndb = (it.noise_db!=null)? String(it.noise_db) : '';
          // 先找是否已有该 rpm 的行
          let row = [...perfTable.querySelectorAll('tr')]
            .find(tr=> parseInt((tr.querySelector('.perf-rpm')?.value||'').trim(),10)===rpm);

          if(!row){
            // 优先使用既有的“全空行”
            if(emptyRows.length){
              row = emptyRows.shift();
              const rpmInp = row.querySelector('.perf-rpm');
              const noiseInp = row.querySelector('.perf-noise');
              if(rpmInp && (!rpmInp.value || !rpmInp.value.trim())) rpmInp.value = String(rpm);
              if(noiseInp && (!noiseInp.value || !noiseInp.value.trim())) noiseInp.value = ndb;
            }else{
              // 无全空行再新增
              row = addPerfRow({ rpm: rpm, airflow_cfm: '', noise_db: ndb });
            }
          }else{
            const n = row.querySelector('.perf-noise');
            if(n && (!n.value || n.value.trim()==='')) n.value = ndb;
          }
        }
        renumberRows(); markDirty(); saveDraft();
      }else if(mode === 'edit'){
        const matched = [];
        items.forEach(it=>{
          const rpm = parseInt(it.rpm,10); if(!rpm) return;
          const row = [...perfTable.querySelectorAll('tr')]
            .find(tr=> parseInt((tr.querySelector('.perf-rpm')?.value||'').trim(),10)===rpm);
          if(row){
            const n = row.querySelector('.perf-noise');
            if(n && (!n.value || n.value.trim()==='')){ n.value = (it.noise_db!=null)? String(it.noise_db):''; matched.push(rpm); }
          }
        });
        if(matched.length){
          if(confirm(`是否从录音文件载入噪音数据（${Math.min(...matched)}~${Math.max(...matched)} rpm）？`)){
            markDirty(); saveDraft();
          }else{
            items.forEach(it=>{
              const rpm = parseInt(it.rpm,10);
              const row = [...perfTable.querySelectorAll('tr')].find(tr=> parseInt((tr.querySelector('.perf-rpm')?.value||'').trim(),10)===rpm);
              if(row){ const n=row.querySelector('.perf-noise'); if(n){ n.value=''; } }
            });
          }
        }else{
          alert('未匹配到当前列表内的转速挡位，未做回填');
        }
      }

      // 注入频谱预览
      ensureCalibPreview(j.data.batch_id);

    }catch(e){
      alert('处理失败：' + (e?.message||e));
    }finally{
      btn.disabled = false; btn.textContent = '上传音频zip';
      file.value = '';
    }
  });

  // 插入到“添加一行”按钮旁
  anchorBox.appendChild(btn);
  anchorBox.appendChild(file);
}

// 预览挂载时打印日志
async function ensureCalibPreview(batchId){
  try{
    console.info('[UI] ensureCalibPreview called', { batchId });

    // 在预览区下方插入容器
    let mount = document.getElementById('calibPreviewMount');
    if(!mount){
      mount = document.createElement('div');
      mount.id = 'calibPreviewMount';
      const anchor = document.getElementById('previewArea') || document.querySelector('#panel-upload');
      anchor && anchor.appendChild(mount);
    }

    // 动态加载 calib_preview.js（只加载一次）
    if(!window.CalibPreview){
      await new Promise((resolve, reject)=>{
        const s = document.createElement('script');
        s.src = '/static/js/calib_preview.js';
        s.async = true;
        s.onload=()=>resolve();
        s.onerror=()=>reject(new Error('calib_preview.js load failed'));
        document.head.appendChild(s);
      });
    }

    if(window.CalibPreview){
      console.info('[UI] CalibPreview.show', { mount: '#calibPreviewMount', batchId });
      window.CalibPreview.show({ mount: '#calibPreviewMount', batchId });
    } else {
      console.warn('[UI] CalibPreview not available after load');
    }
  }catch(e){
    console.warn('calib preview mount failed:', e);
  }
}


// 简易选择器：当 mid+cid 下存在多个已绑定模型时，允许手动选择其一进行回填/预览
async function chooseExistingBinding(items){
  return new Promise(resolve=>{
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.4); z-index:10000; display:flex; align-items:center; justify-content:center;';
    const panel = document.createElement('div');
    panel.style.cssText = 'background:var(--card,#fff); color:var(--text,#111); border-radius:10px; width:min(720px,92vw); max-height:80vh; box-shadow:0 10px 30px rgba(0,0,0,0.2); display:flex; flex-direction:column;';
    panel.innerHTML = `
      <div style="padding:14px 16px; border-bottom:1px solid var(--border,#e5e7eb); font-weight:700;">选择已绑定的频谱模型</div>
      <div style="padding:12px 16px; color:#666;">检测到该型号 + 工况已存在以下绑定记录，请选择一个用于回填/预览：</div>
      <div style="overflow:auto; padding:0 16px 8px 16px; flex:1 1 auto;">
        <table style="width:100%; border-collapse:collapse;">
          <thead>
            <tr style="text-align:left; border-bottom:1px solid var(--border,#e5e7eb);">
              <th style="padding:8px 6px;">创建时间</th>
              <th style="padding:8px 6px;">perf_batch_id</th>
              <th style="padding:8px 6px;">audio_batch_id</th>
              <th style="padding:8px 6px;">操作</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
      <div style="display:flex; gap:10px; justify-content:flex-end; padding:12px 16px; border-top:1px solid var(--border,#e5e7eb);">
        <button type="button" data-act="cancel" class="btn-ghost">取消</button>
        <button type="button" data-act="upload">改为上传文件</button>
      </div>
    `;
    const tbody = panel.querySelector('tbody');
    const short = (s,len=20)=> (typeof s==='string' && s.length>len ? (s.slice(0,10)+'…'+s.slice(-8)) : (s||''));
    (items||[]).forEach((it, idx)=>{
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="padding:8px 6px; border-bottom:1px dashed var(--border,#eee);">${it.created_at || ''}</td>
        <td style="padding:8px 6px; border-bottom:1px dashed var(--border,#eee);" title="${it.perf_batch_id||''}">${short(it.perf_batch_id, 28)}</td>
        <td style="padding:8px 6px; border-bottom:1px dashed var(--border,#eee);" title="${it.audio_batch_id||''}">${short(it.audio_batch_id, 28)}</td>
        <td style="padding:8px 6px; border-bottom:1px dashed var(--border,#eee);">
          <button type="button" data-idx="${idx}">选择</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
    ov.appendChild(panel);
    document.body.appendChild(ov);
    const cleanup = ()=>{ try{ document.body.removeChild(ov); }catch(e){} };
    panel.addEventListener('click', e=>{
      const act = e.target?.getAttribute && e.target.getAttribute('data-act');
      if(act==='cancel'){ cleanup(); resolve(null); return; }
      if(act==='upload'){ cleanup(); resolve('__go_upload__'); return; }
      const idxAttr = e.target?.getAttribute && e.target.getAttribute('data-idx');
      if(idxAttr!=null){
        const idx = parseInt(idxAttr,10);
        const pick = (items||[])[idx] || null;
        cleanup(); resolve(pick);
      }
    });
  });
}

function injectUploadZipButton(){
  const anchorBox = document.querySelector('#perfEditor .flex-inline') || document.querySelector('#perfEditor');
  if(!anchorBox || document.getElementById('uploadZipBtn')) return;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'uploadZipBtn';
  btn.textContent = '上传音频zip';
  btn.style.marginLeft = '8px';

  const file = document.createElement('input');
  file.type = 'file';
  file.accept = '.zip';
  file.style.display = 'none';
  file.id = 'uploadZipFile';

  btn.addEventListener('click', async ()=> {
    // 模式与可用性判定
    const mid = parseInt(upModelId.value||'0',10);
    const cid = parseInt(upConditionSelect.value||'0',10);
    if(mid<=0 || cid<=0){ alert('请先选择品牌/型号/工况'); return; }

    // 新增：上传前触发服务端清理未绑定的音频目录
    try {
      const resp = await fetch('/admin/api/calib/cleanup-unbound-audio', { method:'POST' });
      const cleanup = await resp.json().catch(()=>null);
      if(cleanup && cleanup.success){
        console.info('[UI] audio cleanup ok', cleanup.data);
      } else {
        console.warn('[UI] audio cleanup failed', cleanup && cleanup.error_message);
      }
    } catch(e) {
      console.warn('[UI] audio cleanup error', e);
    }

    // 新增：检查当前 mid+cid 是否已有绑定
    try{
      const r = await fetch(`/admin/api/calib/bindings?model_id=${mid}&condition_id=${cid}`);
      const j = await r.json();
      if(j.success){
        const items = j.data.items || [];
        if(items.length > 0){
          const pick = await chooseExistingBinding(items);
          if(pick && pick !== '__go_upload__'){
            // 记住 audio 批次用于后续绑定与预览
            window.lastCalibBatchId = pick.audio_batch_id || null;

            // 回填噪音：按 audio_batch_id
            try{
              if(window.lastCalibBatchId){
                const r2 = await fetch(`/admin/api/calib/rpm-noise?audio_batch_id=${encodeURIComponent(window.lastCalibBatchId)}`);
                const j2 = await r2.json();
                if(j2.success){
                  const items2 = j2.data.items || [];
                  const isRowEmpty = tr => ([...tr.querySelectorAll('input')].every(inp => !String(inp.value||'').trim()));
                  let emptyRows = [...perfTable.querySelectorAll('tr')].filter(isRowEmpty);
                  for(const it2 of items2){
                    const rpm = parseInt(it2.rpm,10); if(!rpm) continue;
                    const ndb = (it2.noise_db!=null)? String(it2.noise_db) : '';
                    let row = [...perfTable.querySelectorAll('tr')]
                      .find(tr=> parseInt((tr.querySelector('.perf-rpm')?.value||'').trim(),10)===rpm);
                    if(!row){
                      if(emptyRows.length){
                        row = emptyRows.shift();
                        const rpmInp = row.querySelector('.perf-rpm');
                        const noiseInp = row.querySelector('.perf-noise');
                        if(rpmInp && (!rpmInp.value || !rpmInp.value.trim())) rpmInp.value = String(rpm);
                        if(noiseInp && (!noiseInp.value || !noiseInp.value.trim())) noiseInp.value = ndb;
                      }else{
                        addPerfRow({ rpm: rpm, airflow_cfm: '', noise_db: ndb });
                      }
                    }else{
                      const n = row.querySelector('.perf-noise');
                      if(n && (!n.value || n.value.trim()==='')) n.value = ndb;
                    }
                  }
                  renumberRows(); markDirty(); saveDraft();
                }
              }
            }catch(e){}

            // 预览
            if(window.lastCalibBatchId){ ensureCalibPreview(window.lastCalibBatchId); }
            return; // 不再弹出文件
          } else if (pick === '__go_upload__'){
            // 继续走选择文件
          } else {
            return; // 取消
          }
        }
      }
    }catch(e){ /* 忽略错误，继续走选择文件 */ }

    if(mode === 'edit'){
      // 仅当已载入历史数据且所有 noise_db 均为空时允许
      const allEmpty = [...perfTable.querySelectorAll('.perf-noise')].every(inp=> (inp.value||'').trim()==='');
      if(!currentGroupKey){ alert('请先载入历史组'); return; }
      if(!allEmpty){ alert('编辑模式下，只有全部等效噪音为空时才允许上传并回填'); return; }
    }
    document.getElementById('uploadZipFile').click();
  });

  // 上传 zip 回填噪音：优先填充现有“全空行”，再考虑新增行（避免首行空着）
  file.addEventListener('change', async ()=> {
    const f = file.files && file.files[0];
    if(!f){ return; }
    try{
      btn.disabled = true; btn.textContent = '处理中…';
      const mid = parseInt(upModelId.value||'0',10);
      const cid = parseInt(upConditionSelect.value||'0',10);

      const fd = new FormData();
      fd.append('model_id', String(mid));
      fd.append('condition_id', String(cid));
      fd.append('file', f);

      const r = await fetch('/admin/api/calib/upload_zip', { method:'POST', body: fd });
      const j = await r.json();
      if(!j.success){ alert(j.error_message||'上传失败'); return; }

      if (j.data && j.data.batch_id) {
        console.info('[UI] preview start', { batchId: j.data.batch_id });
        ensureCalibPreview(j.data.batch_id);
      }

      window.lastCalibBatchId = j.data.batch_id || null;
      window.lastCalibRunId = j.data.run_id ?? null;
      window.lastCalibModelHash = j.data.model_hash ?? null;

      // 新增：当音频已存在时，先做“绑定一致性”校验
      if (j.data.duplicated === 1) {
        const binds = Array.isArray(j.data.bindings) ? j.data.bindings : [];
        if (binds.length > 0) {
          const allSame = binds.every(b =>
            parseInt(b.model_id,10) === mid && parseInt(b.condition_id,10) === cid
          );
            if (!allSame) {
              const pairs = binds.map(b => {
                const m = b.model_name || `mid=${b.model_id}`;
                const c = b.condition_name_zh || `cid=${b.condition_id}`;
                return `${m} - ${c}`;
              }).join('；');
              alert(`该音频已绑定到其他型号/工况，已拒绝回填。\n已绑定：${pairs}\n如需回填，请切换到对应的型号/工况再试。`);
              window.lastCalibBatchId = null;
              window.lastCalibRunId = null;
              window.lastCalibModelHash = null;
              btn.disabled = false; btn.textContent = '上传音频zip'; file.value = '';
              return;
            }
            // allSame => 按需求“直接回填”，不再弹确认
          } else {
            // 尚未绑定：保留原有“确认后回填/预览”
            const boundCount = parseInt(j.data.bound_count ?? '0', 10) || 0;
            if (boundCount === 0) {
              if (confirm('检测到服务器已存在相同音频且尚未绑定任何型号/工况，是否直接回填/预览？')) {
                const items = j.data.rpm_noise || [];
                // 回填
                if (mode === 'reupload' || mode === 'new' || mode === 'edit') {
                  const isRowEmpty = (tr)=>[...tr.querySelectorAll('input')].every(inp => !String(inp.value||'').trim());
                  let emptyRows = [...perfTable.querySelectorAll('tr')].filter(isRowEmpty);
                  for (const it of items) {
                    const rpm = parseInt(it.rpm,10); if(!rpm) continue;
                    const ndb = (it.noise_db!=null)? String(it.noise_db) : '';
                    let row = [...perfTable.querySelectorAll('tr')]
                      .find(tr=> parseInt((tr.querySelector('.perf-rpm')?.value||'').trim(),10)===rpm);
                    if(!row){
                      if(emptyRows.length){
                        row = emptyRows.shift();
                        const rpmInp = row.querySelector('.perf-rpm');
                        const noiseInp = row.querySelector('.perf-noise');
                        if(rpmInp && (!rpmInp.value || !rpmInp.value.trim())) rpmInp.value=String(rpm);
                        if(noiseInp && (!noiseInp.value || !noiseInp.value.trim())) noiseInp.value=ndb;
                      }else{
                        addPerfRow({ rpm:rpm, airflow_cfm:'', noise_db: ndb });
                      }
                    }else{
                      const n = row.querySelector('.perf-noise');
                      if(n && (!n.value || n.value.trim()==='')) n.value = ndb;
                    }
                  }
                  renumberRows(); markDirty(); saveDraft();
                }
                // 预览
                if (j.data.batch_id) {
                  ensureCalibPreview(j.data.batch_id);
                }
                btn.disabled = false; btn.textContent = '上传音频zip'; file.value = '';
                return;
              }
            }
          }
        }

      // 回填逻辑
      const items = j.data.rpm_noise || [];
      if(mode === 'reupload' || mode === 'new'){
        // 收集当前完全空的行（所有输入均为空）
        const isRowEmpty = (tr)=>{
          const inps = tr.querySelectorAll('input');
          return [...inps].every(inp => !String(inp.value||'').trim());
        };
        let emptyRows = [...perfTable.querySelectorAll('tr')].filter(isRowEmpty);

        for(const it of items){
          const rpm = parseInt(it.rpm,10); if(!rpm) continue;
          const ndb = (it.noise_db!=null)? String(it.noise_db) : '';
          // 先找是否已有该 rpm 的行
          let row = [...perfTable.querySelectorAll('tr')]
            .find(tr=> parseInt((tr.querySelector('.perf-rpm')?.value||'').trim(),10)===rpm);

          if(!row){
            // 优先使用既有的“全空行”
            if(emptyRows.length){
              row = emptyRows.shift();
              const rpmInp = row.querySelector('.perf-rpm');
              const noiseInp = row.querySelector('.perf-noise');
              if(rpmInp && (!rpmInp.value || !rpmInp.value.trim())) rpmInp.value = String(rpm);
              if(noiseInp && (!noiseInp.value || !noiseInp.value.trim())) noiseInp.value = ndb;
            }else{
              // 无全空行再新增
              addPerfRow({ rpm: rpm, airflow_cfm: '', noise_db: ndb });
            }
          }else{
            const n = row.querySelector('.perf-noise');
            if(n && (!n.value || n.value.trim()==='')) n.value = ndb;
          }
        }
        renumberRows(); markDirty(); saveDraft();
      }else if(mode === 'edit'){
        const matched = [];
        items.forEach(it=>{
          const rpm = parseInt(it.rpm,10); if(!rpm) return;
          const row = [...perfTable.querySelectorAll('tr')]
            .find(tr=> parseInt((tr.querySelector('.perf-rpm')?.value||'').trim(),10)===rpm);
          if(row){
            const n = row.querySelector('.perf-noise');
            if(n && (!n.value || n.value.trim()==='')){ n.value = (it.noise_db!=null)? String(it.noise_db):''; matched.push(rpm); }
          }
        });
        if(matched.length){
          if(confirm(`是否从录音文件载入噪音数据（${Math.min(...matched)}~${Math.max(...matched)} rpm）？`)){
            markDirty(); saveDraft();
          }else{
            items.forEach(it=>{
              const rpm = parseInt(it.rpm,10);
              const row = [...perfTable.querySelectorAll('tr')].find(tr=> parseInt((tr.querySelector('.perf-rpm')?.value||'').trim(),10)===rpm);
              if(row){ const n=row.querySelector('.perf-noise'); if(n){ n.value=''; } }
            });
          }
        }else{
          alert('未匹配到当前列表内的转速挡位，未做回填');
        }
      }

      // 注入频谱预览
      ensureCalibPreview(j.data.batch_id);

    }catch(e){
      alert('处理失败：' + (e?.message||e));
    }finally{
      btn.disabled = false; btn.textContent = '上传音频zip';
      file.value = '';
    }
  });

  // 插入到“添加一行”按钮旁
  anchorBox.appendChild(btn);
  anchorBox.appendChild(file);
}

// 初始化里，统一动作栏后再做一次同步（防止竞态）
(async function init(){
  suspendDraft = true;
  resetUploadState();
  bindDraftAutoSave();
  injectActionBarStyles();
  try{
    const raw = localStorage.getItem(LS_KEY);
    if(raw){
      const d = JSON.parse(raw);
      if(hasMeaningfulDraft(d)){ $('#restoreBar').style.display='block'; }
    }
  }catch(e){}
  try{ initModelEditTwoDropdowns(); }catch(e){}
  try{ initBatchManageSection(); }catch(e){}
  try{ unifyUploadActionBar(); }catch(e){}
  try{ injectUploadZipButton(); }catch(e){}
  // 新增：再次同步一次
  try{ syncUploadActionBarVisibility(); }catch(e){}
  suspendDraft = false;
})();

