const $ = s => document.querySelector(s);

// ===== 常量与标志 =====
const LS_KEY = 'admin_perf_draft_v2';
let suspendDraft = true;

// ===== Tabs =====
const tabs = document.querySelectorAll('.tab');
const panels = { upload: $('#panel-upload'), brand: $('#panel-brand'), model: $('#panel-model'), condition: $('#panel-condition') };
tabs.forEach(t => t.addEventListener('click', () => {
  tabs.forEach(x => x.classList.remove('active')); t.classList.add('active');
  const key = t.dataset.tab; Object.entries(panels).forEach(([k, el]) => el.style.display = (k === key ? '' : 'none'));
  if(key === 'brand'){ initBrandEditList(); }
  if(key === 'condition'){ initConditionEditList(); }
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
if(condForm){
  condForm.addEventListener('submit', async e=>{
    e.preventDefault(); condMsg.textContent=''; condMsg.className=''; condSubmitBtn.disabled=true;
    const zh=$('#rtZh').value.trim(), en=$('#rtEn').value.trim();
    const condIsValid = parseInt($('#condIsValid')?.value || '0', 10);
    if(!zh||!en){ condMsg.className='err'; condMsg.textContent='风阻类型中文与英文均为必填'; condSubmitBtn.disabled=false; return; }
    try{
      const r=await fetch('/admin/api/data/condition/add',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({resistance_type_zh:zh,resistance_type_en:en, is_valid: condIsValid})
      });
      const j=await r.json();
      if(j.success){ condMsg.className='ok'; condMsg.textContent=`添加成功，condition_id：${(j.data.condition_ids||[]).join(', ')}`; }
      else { condMsg.className='err'; condMsg.textContent=j.error_message||'提交失败'; }
    }catch{ condMsg.className='err'; condMsg.textContent='网络或服务器错误'; } finally{ condSubmitBtn.disabled=false; }
  });
}

/* ====================== 工况管理：编辑 ====================== */
const cmAdd = $('#cmAdd'), cmEdit = $('#cmEdit');
const condAddBox = $('#condAddBox'), condEditBox = $('#condEditBox');
if(cmAdd && cmEdit){
  const updateBoxes=()=>{ const m = document.querySelector('input[name="condMgmtMode"]:checked')?.value || 'add'; if(m==='add'){ condAddBox.style.display=''; condEditBox.style.display='none'; } else { condAddBox.style.display='none'; condEditBox.style.display=''; initConditionEditList(); } };
  cmAdd.addEventListener('change',updateBoxes); cmEdit.addEventListener('change',updateBoxes); updateBoxes();
}
const condEditInput=$('#condEditInput'), condEditOptions=$('#condEditOptions'), condEditHint=$('#condEditHint');
const condOutId=$('#condOutId'), condInId=$('#condInId'), rtZhEdit=$('#rtZhEdit'), rtEnEdit=$('#rtEnEdit'), condEditIsValidOut=$('#condEditIsValidOut'), condEditIsValidIn=$('#condEditIsValidIn');
const condEditForm=$('#condEditForm'), condEditSubmitBtn=$('#condEditSubmitBtn'), condEditMsg=$('#condEditMsg');

let condTypesCache=[];
async function initConditionEditList(){
  try{
    const r=await fetch('/admin/api/data/condition/types'); const j=await r.json();
    if(j.success){ condTypesCache=j.data.items||[]; condEditOptions.innerHTML=''; condTypesCache.forEach(it=>{ const opt=document.createElement('option'); opt.value = it.label; opt.dataset.tzh = it.type_zh; opt.dataset.ten = it.type_en; condEditOptions.appendChild(opt); }); }
  }catch{}
}
function setCondEditEnabled(en){
  if(en){ condEditForm.classList.remove('disabled'); [...condEditForm.querySelectorAll('input,select,button')].forEach(el=>el.disabled=false);}
  else { condEditForm.classList.add('disabled'); [...condEditForm.querySelectorAll('input,select,button')].forEach(el=>{ if(el.id!=='condEditSubmitBtn'){ el.value=''; } el.disabled=true; }); condEditMsg.textContent=''; }
}
setCondEditEnabled(false);
function commitPickCondition(){
  const v = (condEditInput.value||'').trim();
  const opt = [...condEditOptions.children].find(o=>o.value===v);
  if(!opt){ condOutId.value=''; condInId.value=''; setCondEditEnabled(false); condEditHint.textContent='未选择工况'; return false; }
  loadConditionTypeDetail(opt.dataset.tzh, opt.dataset.ten);
  condEditHint.textContent = `已选择：${v}`;
  return true;
}
if(condEditInput){
  condEditInput.addEventListener('change', commitPickCondition);
  condEditInput.addEventListener('input', ()=>{ if(!condEditInput.value.trim()){ setCondEditEnabled(false); condEditHint.textContent='未选择工况'; }});
}
async function loadConditionTypeDetail(tzh, ten){
  try{
    const r=await fetch(`/admin/api/data/condition/type-detail?type_zh=${encodeURIComponent(tzh)}&type_en=${encodeURIComponent(ten)}`);
    const j=await r.json();
    if(!j.success){ condEditMsg.className='err'; condEditMsg.textContent=j.error_message||'加载失败'; setCondEditEnabled(false); return; }
    const d=j.data;
    // 名称
    rtZhEdit.value = d.type_zh || '';
    rtEnEdit.value = d.type_en || '';

    // 单一模式开关（空载/No Load）
    const single = (d.single === 1) || (!!d.single_condition && !d.outlet && !d.inlet);
    // ids 与 is_valid
    if(single){
      // 使用“出风控件”作为单一 is_valid 控件，隐藏“进风控件”
      const singleId = d.single_condition?.condition_id || d.outlet?.condition_id || d.inlet?.condition_id || '';
      const singleValid = d.single_condition?.is_valid ?? d.outlet?.is_valid ?? d.inlet?.is_valid ?? 0;
      condOutId.value = singleId ? String(singleId) : '';
      condInId.value = ''; // 清空
      condEditIsValidOut.value = String(singleValid ?? 0);

      // 隐藏右侧“进风”块
      const inWrap = condEditIsValidIn.closest('div');
      if(inWrap) inWrap.style.display='none';
      // 调整左侧标签
      const outLabel = condEditIsValidOut.closest('div')?.querySelector('label');
      if(outLabel) outLabel.textContent = 'is_valid';

    }else{
      // 常规双向
      condOutId.value = d.outlet?.condition_id || '';
      condInId.value  = d.inlet?.condition_id || '';
      condEditIsValidOut.value = String(d.outlet?.is_valid ?? 0);
      condEditIsValidIn.value  = String(d.inlet?.is_valid ?? 0);

      // 还原显示与标签
      const inWrap = condEditIsValidIn.closest('div');
      if(inWrap) inWrap.style.display='';
      const outLabel = condEditIsValidOut.closest('div')?.querySelector('label');
      if(outLabel) outLabel.textContent = '出风 is_valid';
    }

    // 缓存模式标志
    loadConditionTypeDetail._singleMode = !!single;

    setCondEditEnabled(true); condEditMsg.textContent='';
  }catch{ condEditMsg.className='err'; condEditMsg.textContent='网络或服务器错误'; setCondEditEnabled(false); }
}

if(condEditForm){
  condEditForm.addEventListener('submit', async e=>{
    e.preventDefault(); condEditMsg.textContent=''; condEditMsg.className=''; condEditSubmitBtn.disabled=true;
    const singleMode = !!loadConditionTypeDetail._singleMode;
    const outId=parseInt(condOutId.value||'0',10), inId=parseInt(condInId.value||'0',10);
    const zh = rtZhEdit.value.trim(), en = rtEnEdit.value.trim();
    const vOut = parseInt(condEditIsValidOut.value||'0',10), vIn = parseInt(condEditIsValidIn.value||'0',10);

    if(singleMode){
      if(outId<=0){ condEditMsg.className='err'; condEditMsg.textContent='未正确加载记录'; condEditSubmitBtn.disabled=false; return; }
      if(!zh || !en){ condEditMsg.className='err'; condEditMsg.textContent='请填写完整的中英文名称'; condEditSubmitBtn.disabled=false; return; }
      if(!confirm(`确认将工况更新为：\n「${zh} / ${en}」\n状态：${vOut===1?'公开':'未公开'}？`)){ condEditSubmitBtn.disabled=false; return; }
      try{
        const r=await fetch('/admin/api/data/condition/type-update',{ method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({ resistance_type_zh: zh, resistance_type_en: en, outlet:{ condition_id: outId, is_valid: vOut } /* inlet 省略 */ }) });
        const j=await r.json();
        if(j.success){ condEditMsg.className='ok'; condEditMsg.textContent='更新成功'; initConditionEditList(); }
        else { condEditMsg.className='err'; condEditMsg.textContent=j.error_message||'提交失败'; }
      }catch{ condEditMsg.className='err'; condEditMsg.textContent='网络或服务器错误'; } finally{ condEditSubmitBtn.disabled=false; }
      return;
    }

    // 非单一模式：原逻辑
    if(outId<=0 || inId<=0){ condEditMsg.className='err'; condEditMsg.textContent='未正确加载出风/进风记录'; condEditSubmitBtn.disabled=false; return; }
    if(!zh || !en){ condEditMsg.className='err'; condEditMsg.textContent='请填写完整的中英文名称'; condEditSubmitBtn.disabled=false; return; }
    if(!confirm(`确认将工况更新为：\n「${zh} / ${en}」\n出风：${vOut===1?'公开':'未公开'}；进风：${vIn===1?'公开':'未公开'}？`)){ condEditSubmitBtn.disabled=false; return; }
    try{
      const r=await fetch('/admin/api/data/condition/type-update',{ method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ resistance_type_zh: zh, resistance_type_en: en, outlet:{ condition_id: outId, is_valid: vOut }, inlet:{ condition_id: inId, is_valid: vIn } }) });
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
}
function disablePerfEditor(){ perfEditor.classList.add('disabled'); perfTable.innerHTML=''; previewArea.style.display='none'; }
function enablePerfEditor(){ perfEditor.classList.remove('disabled'); if(perfTable.children.length===0) addPerfRow(); markDirty(); }

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
      <td><input type="text" inputmode="decimal" class="w-small perf-airflow" placeholder="CFM" value="${row.airflow_cfm??''}" /></td>
      <td><input type="text" inputmode="decimal" class="w-small perf-noise" placeholder="noise_db" value="${row.noise_db??''}" /></td>
      <td><input type="text" inputmode="decimal" class="w-small perf-totaldb" placeholder="total_db" /></td>
      <td><input type="text" inputmode="decimal" class="w-small perf-ambientdb" placeholder="ambient_db" /></td>
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
    <td><input type="text" inputmode="decimal" class="w-small perf-airflow" placeholder="CFM" /></td>
    <td><input type="text" inputmode="decimal" class="w-small perf-noise" placeholder="noise_db" /></td>
    <td><input type="text" inputmode="decimal" class="w-small perf-totaldb" placeholder="total_db" /></td>
    <td><input type="text" inputmode="decimal" class="w-small perf-ambientdb" placeholder="ambient_db" /></td>
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
    if(!rpmStr && !airStr && !noiseStr && !tStr && !aStr){ continue; }
    const rpm = parseInt(rpmStr,10);
    if(!rpmStr || isNaN(rpm) || rpm<=0){ ok=false; msg=`第${i+1}行：rpm 必须为>0的整数`; break; }
    if(rpms.includes(rpm)){ ok=false; msg=`第${i+1}行：rpm 重复`; break; }
    rpms.push(rpm);
    const air=parseFloat(airStr);
    if(!airStr || isNaN(air) || air<=0){ ok=false; msg=`第${i+1}行：airflow_cfm 必须>0`; break; }
    if(tStr!=='' && aStr!==''){ const t=parseFloat(tStr), a=parseFloat(aStr); if(isNaN(t)||isNaN(a)){ ok=false; msg=`第${i+1}行：噪音数值需为数字`; break; } if(t<a){ ok=false; msg=`第${i+1}行：总噪音应≥环境噪音`; break; } }
    let ndb = null;
    if(noiseStr!==''){ const v=parseFloat(noiseStr); if(isNaN(v)){ ok=false; msg=`第${i+1}行：noise_db 必须为数字`; break; } ndb = Number(v.toFixed(1)); }
    else { const calc = computeNoise(tStr, aStr); if(calc!=null) ndb = calc; }
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
function renderPreview(rows){
  previewTableBody.innerHTML='';
  rows.forEach((r,i)=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${i+1}</td><td>${r.rpm}</td><td>${r.airflow_cfm}</td><td>${r.noise_db??''}</td>`;
    previewTableBody.appendChild(tr);
  });
  const pairsRpmAir = rows.map(r=>[r.rpm, r.airflow_cfm]);
  const pairsNoiseAir = rows.filter(r=>r.noise_db!=null).map(r=>[r.noise_db, r.airflow_cfm]);
  drawScatter(chartRpmAir, pairsRpmAir, 'rpm', 'airflow');
  drawScatter(chartNoiseAir, pairsNoiseAir, 'noise_db', 'airflow');
  previewArea.style.display='';
}
// 提交按钮：提交前强制校验“更新描述”，并随请求提交 description 字段
perfSubmitBtn.addEventListener('click', async ()=>{
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

  // 新增：提交前校验“更新描述”必填
  if(!desc){ perfSubmitMsg.className='err'; perfSubmitMsg.textContent='请填写更新描述'; return; }

  perfSubmitBtn.disabled=true;
  try{
    if(mode==='reupload' || mode==='new'){
      const r=await fetch('/admin/api/data/perf/add',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          model_id: mid,
          condition_id: cid,
          is_valid: parseInt(isValidSelect.value,10),
          description: desc, // 新增
          rows: res2.rows.map(x=>({ rpm:x.rpm, airflow_cfm:x.airflow_cfm, noise_db:x.noise_db }))
        })
      });
      const j=await r.json();
      if(j.success){
        perfSubmitMsg.className='ok';
        perfSubmitMsg.textContent=`成功插入 ${j.data.inserted} 行`;
        disablePerfEditor(); previewArea.style.display='none'; previewReady=false; perfSubmitBtn.textContent='预览'; clearDraft();
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
          description: desc, // 新增
          changes
        })
      });
      const j=await r.json();
      if(j.success){
        const rowsChanged = (j.data?.updated_rows || 0) + (j.data?.state_changed_rows || 0);
        perfSubmitMsg.className='ok';
        perfSubmitMsg.textContent=`编辑提交成功，更新 ${rowsChanged} 行`;
        disablePerfEditor(); previewArea.style.display='none'; previewReady=false; perfSubmitBtn.textContent='预览'; clearDraft();
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

(async function init(){
  suspendDraft = true;
  resetUploadState();
  bindDraftAutoSave();
  try{
    const raw = localStorage.getItem(LS_KEY);
    if(raw){
      const d = JSON.parse(raw);
      if(hasMeaningfulDraft(d)){ $('#restoreBar').style.display='block'; }
    }
  }catch(e){}
  // 型号编辑“两级下拉”初始化（若元素不存在将安全跳过）
  try{ initModelEditTwoDropdowns(); }catch(e){}

  // 修复点：初始化结束后允许自动保存草稿
  suspendDraft = false;
})();