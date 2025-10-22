/* =========================================================
   Right Panel Module （右侧主容器模块）
   依赖（从全局提供）：
   - safeClosest
   - escapeHtml
   - buildQuickBtnHTML
   - syncQuickActionButtons (可选)
   - initSnapTabScrolling（通用 Scroll Snap 初始化）
   - loadRecentUpdatesIfNeeded（可选：用于“近期更新”页签懒加载）
   ========================================================= */

(function attachRightPanelModule(global){
  const RightPanel = { init };
  global.RightPanel = RightPanel;

  let segQueriesEl = null;
  let segSearchEl  = null;

  const ANIM = { rowMs: 240,       // 行位移动画（followers + 接力） 
                rowEase: 'ease', 
                fadeOutMs: 200,    // 仅用于非接力场景的淡出 
                fadeInMs: 220,     // 仅用于非接力场景的淡入 
                cleanupMs: 120,    // 动画结束后的清理延时 
                guardMs: 200,       // transitionend 兜底超时 
                relayNudgeLabelY: 0 // 工况文本衔接微调（px），正值=子行更往下，负值=更往上
                };

  function init() {
    mountRightSubseg();
    initRightPanelSnapTabs();
    initTopQueriesAndLikesExpander();
    initRightPanelResponsiveWrap();
    initMainPanelsAdaptiveStack();
    initRightSubsegDragSwitch();
    updateRightSubseg('top-queries');
  }
  // 行级动画锁
  function isRowAnimating(tr){ return !!(tr && tr.dataset && tr.dataset._relay_anim === '1'); }
  function setRowAnimating(tr, on, btn){
    if (!tr) return;
    if (on) { tr.dataset._relay_anim = '1'; if (btn) btn.style.pointerEvents = 'none'; }
    else    { delete tr.dataset._relay_anim; if (btn) btn.style.pointerEvents = ''; }
  }

  function mountRightSubseg(){
    const rightSubsegContainer = document.getElementById('rightSubsegContainer');
    segQueriesEl = document.querySelector('#top-queries-pane .fc-seg');
    segSearchEl  = document.querySelector('#search-results-pane .fc-seg');
    if (!rightSubsegContainer) return;
    if (segQueriesEl) { segQueriesEl.dataset.paneId = 'top-queries-pane'; rightSubsegContainer.appendChild(segQueriesEl); }
    if (segSearchEl)  { segSearchEl.dataset.paneId  = 'search-results-pane'; rightSubsegContainer.appendChild(segSearchEl); }
  }

  function updateRightSubseg(activeTab){
    if (segQueriesEl) segQueriesEl.style.display = (activeTab === 'top-queries') ? 'inline-flex' : 'none';
    if (segSearchEl)  segSearchEl.style.display  = (activeTab === 'search-results') ? 'inline-flex' : 'none';
  }

  function initRightPanelSnapTabs(){
    const card = document.querySelector('.fc-right-card');
    if (!card) return;
    const container = card.querySelector('.fc-tab-container');
    const wrapper   = card.querySelector('.fc-tab-wrapper');
    if (!container || !wrapper) return;
    if (!container.id) container.id = 'right-panel-container';
    if (!wrapper.id)   wrapper.id   = 'right-panel-wrapper';
    global.__RIGHT_PANEL_SNAP_ON = true;

    if (typeof initSnapTabScrolling === 'function') {
      initSnapTabScrolling({
        containerId: container.id,
        group: 'right-panel',
        persistKey: null,
        defaultTab: 'top-queries',
        onActiveChange: (tab) => {
          updateRightSubseg(tab);
          if (tab === 'recent-updates' && typeof global.loadRecentUpdatesIfNeeded === 'function') {
            global.loadRecentUpdatesIfNeeded();
          }
        },
        clickScrollBehavior: 'smooth'
      });
    }
  }

  function initRightPanelResponsiveWrap(){
    const card = document.querySelector('.fc-right-card');
    if (!card) return;
    const APPLY_W = 520;
    const apply = (w) => { if (w < APPLY_W) card.classList.add('rp-narrow'); else card.classList.remove('rp-narrow'); };
    apply(card.getBoundingClientRect().width);
    if ('ResizeObserver' in window) {
      const ro = new ResizeObserver(entries=>{ for (const entry of entries){ apply(entry.contentRect.width); } });
      ro.observe(card);
    } else {
      window.addEventListener('resize', () => apply(card.getBoundingClientRect().width));
    }
  }

  function initMainPanelsAdaptiveStack(){
    if (global.__MAIN_STACK_BOUND__) return;
    const container = document.getElementById('main-panels');
    if (!container) return;
    const THRESHOLD = 980;
    const apply = (w) => { if (w < THRESHOLD) container.classList.add('fc-force-col'); else container.classList.remove('fc-force-col'); };
    apply(container.getBoundingClientRect().width);
    if ('ResizeObserver' in window) {
      const ro = new ResizeObserver(entries=>{ for (const entry of entries){ apply(entry.contentRect.width); } });
      ro.observe(container);
    } else {
      window.addEventListener('resize', () => apply(container.getBoundingClientRect().width));
    }
    global.__MAIN_STACK_BOUND__ = true;
  }

  function initRightSubsegDragSwitch() {
    const segs = document.querySelectorAll('#rightSubsegContainer .fc-seg');
    if (!segs.length) return;
    segs.forEach(seg => {
      const thumb = seg.querySelector('.fc-seg__thumb');
      const btns = seg.querySelectorAll('.fc-seg__btn');
      if (!thumb || btns.length !== 2) return;
      let dragging = false, startX = 0, basePercent = 0, lastPercent = 0;
      const activeIsRight = () => ((seg.getAttribute('data-active') || '').endsWith('likes-panel') || (seg.getAttribute('data-active') || '').endsWith('search-likes-panel'));
      const pointInThumb = (x,y)=>{ const r=thumb.getBoundingClientRect(); return x>=r.left && x<=r.right && y>=r.top && y<=r.bottom; };
      function start(e){
        const cx=(e.touches?e.touches[0].clientX:e.clientX)||0, cy=(e.touches?e.touches[0].clientY:e.clientY)||0;
        if (!pointInThumb(cx,cy)) return;
        dragging=true; startX=cx; basePercent=activeIsRight()?100:0; lastPercent=basePercent; thumb.style.transition='none';
        if (e.cancelable) e.preventDefault();
      }
      function move(e){
        if (!dragging) return;
        const cx=(e.touches?e.touches[0].clientX:e.clientX)||0, dx=cx-startX, w=thumb.getBoundingClientRect().width||1;
        let p=basePercent+(dx/w)*100; p=Math.max(0,Math.min(100,p)); lastPercent=p; thumb.style.transform=`translateX(${p}%)`;
        if (e.cancelable) e.preventDefault();
      }
      function end(){
        if (!dragging) return; dragging=false;
        const goRight=lastPercent>=50; const targetBtn=goRight?btns[1]:btns[0];
        thumb.style.transition=''; thumb.style.transform=''; targetBtn.click();
      }
      seg.addEventListener('mousedown', start);
      document.addEventListener('mousemove', move, { passive:false });
      document.addEventListener('mouseup', end);
      seg.addEventListener('touchstart', start, { passive:false });
      document.addEventListener('touchmove', move, { passive:false });
      document.addEventListener('touchend', end);
    });
  }

  /* ===== 查询榜/好评榜：展开/收起 ===== */

  // 计算父行第 6 列文本起点和第 7 列 padding-left，并写到表级 CSS 变量
  function setSubrowAnchorVar(parentTr){
    try {
      const table = parentTr.closest('table');
      if (!table) return;
      const rowRect = parentTr.getBoundingClientRect();

      // 第 6 列（热门工况列）
      const td6 = parentTr.children && parentTr.children[5];
      if (td6) {
        let anchorPx;
        const labelEl = td6.querySelector('.fc-marquee-inner');
        if (labelEl) {
          // 直接以父行工况文本的左边缘为锚点
          anchorPx = labelEl.getBoundingClientRect().left - rowRect.left;
        } else {
          // 回退：td 左 + padding-left + 展开按钮宽度与右距 + 文案自身 margin-left(.25rem≈4px)
          const tdBox = td6.getBoundingClientRect();
          const cs6 = getComputedStyle(td6);
          const pl6 = parseFloat(cs6.paddingLeft) || 0;
          const expBtn = td6.querySelector('.fc-row-expander');
          const expW = expBtn ? expBtn.getBoundingClientRect().width : 0;
          const expMr = expBtn ? parseFloat(getComputedStyle(expBtn).marginRight) || 0 : 0;
          const labelGap = 4; // 0.25rem ≈ 4px
          anchorPx = (tdBox.left + pl6 + expW + expMr + labelGap) - rowRect.left;
        }
        table.style.setProperty('--subrow-anchor-x', Math.round(anchorPx) + 'px');
      }

      // 第 7 列（次数列）左内边距（注入为子行计数左 padding）
      const td7 = parentTr.children && parentTr.children[6];
      if (td7) {
        const cs7 = getComputedStyle(td7);
        const pl7 = parseFloat(cs7.paddingLeft) || 0;
        table.style.setProperty('--subrow-count-pl', Math.round(pl7) + 'px');
      }
    } catch(_) {}
  }

  /* 只在暗色主题且存在渐变时才需要追踪 */
  function isDarkTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark';
  }
  function hasDarkGradient() {
    try {
      const g = getComputedStyle(document.documentElement).getPropertyValue('--dark-rand-gradient');
      return !!g && g.trim() !== '' && g.trim() !== 'none';
    } catch(_) { return false; }
  }
  function shouldTrackMask() {
    return isDarkTheme() && hasDarkGradient();
  }

  let __maskRaf = null;
  let __maskRows = null;

  function __maskStep() {
    if (!__maskRows) return;
    for (const el of __maskRows) {
      if (!el || !el.isConnected) continue;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--row-vp-left', Math.round(r.left) + 'px');
      el.style.setProperty('--row-vp-top',  Math.round(r.top)  + 'px');
    }
    __maskRaf = requestAnimationFrame(__maskStep);
  }
  function startRowMaskTracking(rows) {
    // 浅色主题或无渐变时，直接跳过追踪
    if (!shouldTrackMask()) {
      stopRowMaskTracking();
      return;
    }
    cancelAnimationFrame(__maskRaf);
    __maskRows = Array.from(rows || []);
    __maskStep(); // 立即跑一帧，避免首帧错位
  }
  function stopRowMaskTracking() {
    cancelAnimationFrame(__maskRaf);
    __maskRaf = null;
    if (__maskRows) {
      for (const el of __maskRows) {
        if (!el) continue;
        el.style.removeProperty('--row-vp-left');
        el.style.removeProperty('--row-vp-top');
      }
    }
    __maskRows = null;
  }

  function animateHideEl(el, dx=0, dy=6, duration=ANIM.fadeOutMs) {
    if (!el || el.dataset._anim_state === 'hiding') return;
    el.dataset._anim_state = 'hiding';
    el.classList.add('fc-fade-slide');
    el.style.visibility = ''; el.style.opacity = '1'; el.style.transform = 'translate3d(0,0,0)';
    void el.offsetWidth;
    el.style.transition = `transform ${duration}ms ${ANIM.rowEase}, opacity ${duration}ms ${ANIM.rowEase}`;
    requestAnimationFrame(() => { el.style.opacity = '0'; el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`; });
    const onEnd = (e) => { if (e.propertyName !== 'opacity') return;
      el.removeEventListener('transitionend', onEnd); el.style.visibility = 'hidden'; el.style.transition = ''; el.dataset._anim_state = ''; };
    el.addEventListener('transitionend', onEnd);
  }
  function animateShowEl(el, dx=0, dy=-6, duration=ANIM.fadeInMs) {
    if (!el || el.dataset._anim_state === 'showing') return;
    el.dataset._anim_state = 'showing';
    el.classList.add('fc-fade-slide');
    el.style.visibility = 'visible'; el.style.opacity = '0'; el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
    void el.offsetWidth;
    el.style.transition = `transform ${duration}ms ${ANIM.rowEase}, opacity ${duration}ms ${ANIM.rowEase}`;
    requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'translate3d(0,0,0)'; });
    const onEnd = (e) => { if (e.propertyName !== 'opacity') return;
      el.removeEventListener('transitionend', onEnd); el.style.transition = ''; el.dataset._anim_state = ''; };
    el.addEventListener('transitionend', onEnd);
  }

  function isLikesRow(tr){
    // “好评榜”tbody 的 table id 固定为 ratingRankTable
    const table = tr && tr.closest('table');
    return !!(table && table.id === 'ratingRankTable');
  }

  function toggleParentHotCondAndAction(tr, expanded, opts={}){
    if (!tr) return;
    const td6 = tr.children && tr.children[5];
    const tdLast = tr.children && tr.children[tr.children.length-1];
    const hot = tr.querySelector('[data-role="top-cond"] .fc-marquee-inner, td:nth-child(6) .fc-marquee-inner') 
             || tr.querySelector('[data-role="top-cond"], .js-top-cond');
    const actionBtn = tr.querySelector('td:last-child .fc-btn-icon-add') || null;

    // 接力式：仅位移，不渐隐
    if (opts.mode === 'relay') {
      const dur = opts.duration || ANIM.rowMs;
      const ease = opts.easing || 'ease';
      // 动画期间给相关列加裁切，避免越界
      addClip(td6); addClip(tdLast);

      if (expanded) {
        // 展开：父行元素向下滑出（到子行对应位置）
        if (hot && typeof opts.dyLabel === 'number') slideHideEl(hot, opts.dyLabel, dur, ease);
        if (actionBtn && typeof opts.dyBtn === 'number') slideHideEl(actionBtn, opts.dyBtn, dur, ease);
      } else {
        // 收起：父行元素自子行位置向上滑入
        if (hot && typeof opts.fromDyLabel === 'number') slideShowEl(hot, opts.fromDyLabel, dur, ease);
        if (actionBtn && typeof opts.fromDyBtn === 'number') slideShowEl(actionBtn, opts.fromDyBtn, dur, ease);
      }
      // 延迟清理裁切（给动画收尾一点余量）
      setTimeout(()=>{ removeClip(td6); removeClip(tdLast); }, (opts.duration||ANIM.rowMs) + ANIM.cleanupMs);
      return;
    }

    if (expanded) {
      if (hot) animateHideEl(hot);
      if (actionBtn) animateHideEl(actionBtn);
    } else {
      if (hot) animateShowEl(hot);
      if (actionBtn) animateShowEl(actionBtn);
    }
  }

function initTopQueriesAndLikesExpander(){

  function parseConds(tr){ try { return JSON.parse(tr.dataset.conditions || '[]') || []; } catch(_) { return []; } }

  // 子行：colspan=6 + 次数 + 操作
  function buildSubrowHTML(parentTr, cond, countValue){
    const brand = parentTr.dataset.brand || '';
    const model = parentTr.dataset.model || '';
    const mid   = parentTr.dataset.modelId || '';
    const cid   = String(cond.condition_id || '');
    const cname = String(cond.condition_name_zh || '');

    const rt = cond.resistance_type_zh || '';
    const rl = cond.resistance_location_zh || '';
    let extra = '';
    if (typeof window.formatScenario === 'function') extra = window.formatScenario(rt, rl);
    else {
      const rtype = escapeHtml(rt || ''), rloc = String(rl || '').trim();
      extra = rloc && rloc !== '无' ? `${rtype}(${escapeHtml(rl)})` : rtype;
    }
    const extraLeft = extra ? `<span class="fc-subrow__extra-left">${escapeHtml(extra)}&nbsp;&nbsp;&nbsp;</span>` : '';

    const cnt  = Number(countValue || 0);
    return `
      <tr class="fc-subrow" data-parent-mid="${escapeHtml(mid)}">
        <td colspan="6">
          <div class="fc-subrow__row">
            <div class="fc-subrow__indent">
              ${extraLeft}
              <span class="fc-subrow__dot"></span>
              <span class="fc-subrow__label">${escapeHtml(cname)}</span>
            </div>
          </div>
        </td>
        <td>
          <div class="fc-subrow__row fc-subrow__row--count">
            <span class="text-blue-600 font-medium">${escapeHtml(cnt)}</span>
          </div>
        </td>
        <td>
          <div class="fc-subrow__row fc-subrow__row--actions">
            ${buildQuickBtnHTML('ranking', brand, model, mid, cid, cname, isLikesRow(parentTr) ? 'top_rating_expand' : 'top_query_expand')}
          </div>
        </td>
      </tr>`;
  }

  function isSubrowOf(row, mid){ return row && row.classList && row.classList.contains('fc-subrow') && row.dataset.parentMid === String(mid); }
  function collectFollowers(fromTr){ const arr=[]; let n=fromTr.nextElementSibling; while(n){ arr.push(n); n=n.nextElementSibling; } return arr; }
  function collectFollowersAfter(el){ const arr=[]; let n=el?el.nextElementSibling:null; while(n){ arr.push(n); n=n.nextElementSibling; } return arr; }
  function measureTops(els){ const m=new Map(); els.forEach(el=>{ m.set(el, el.getBoundingClientRect().top); }); return m; }
  function markAnimating(els,on){ els.forEach(el=>{ if(on) el.classList.add('fc-row-animating'); else el.classList.remove('fc-row-animating'); }); }

  // 不再做任何旧字段兼容，严格依赖统一字段
  function getChildRank(rec) { return Number(rec.cond_rank || 1e9); }
  function getChildCount(rec) { return Number(rec.count || 0); }

  // 新增：获取“最后一条主行”（非子行）
  function getLastMainRow(tr){
    const tbody = tr?.closest?.('tbody');
    if (!tbody) return null;
    const mains = tbody.querySelectorAll('tr:not(.fc-subrow)');
    return mains.length ? mains[mains.length - 1] : null;
  }

  // 展开阶段：动态阈值滚动（正向累计）
  // totalDelta>0；freeSpacePx = 基准边到 scroller 可视底的初始空隙；仅当 currentDelta 超过该空隙时开始上移，滚动量=over
  function startTrackScrollPinDynamic(scroller, totalDelta, freeSpacePx){
    if (!scroller || !isFinite(totalDelta) || totalDelta <= 0) return;
    const easeInOut = (t)=> t<.5 ? (2*t*t) : (1 - Math.pow(-2*t+2,2)/2);
    const dur = ANIM.rowMs;
    const startTop = scroller.scrollTop;
    const threshold = Math.max(0, freeSpacePx || 0);

    let startTs = 0;
    function frame(ts){
      if (!startTs) startTs = ts;
      const k = Math.min(1, (ts - startTs)/Math.max(1,dur));
      const e = easeInOut(k);

      const currentDelta = e * totalDelta;
      const over = currentDelta - threshold;
      const next = over > 0 ? (startTop + over) : startTop;

      clampScrollTop(scroller, next);
      if (k < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // 收起阶段：动态阈值滚动（反向累计，触顶即止）
  // totalDelta>0；freeSpacePx = 基准边到 scroller 可视底的初始空隙；仅当 currentDelta 超过该空隙时开始减少 scrollTop
  function startTrackScrollPinDynamicCollapse(scroller, totalDelta, freeSpacePx){
    if (!scroller || !isFinite(totalDelta) || totalDelta <= 0) return;
    const easeInOut = (t)=> t<.5 ? (2*t*t) : (1 - Math.pow(-2*t+2,2)/2);
    const dur = ANIM.rowMs;
    const startTop = scroller.scrollTop;
    const threshold = Math.max(0, freeSpacePx || 0);

    let startTs = 0;
    function frame(ts){
      if (!startTs) startTs = ts;
      const k = Math.min(1, (ts - startTs)/Math.max(1,dur));
      const e = easeInOut(k);

      const currentDelta = e * totalDelta;
      const over = currentDelta - threshold;
      let next = startTop;
      if (over > 0) {
        next = startTop - over; // 收起：减少 scrollTop
      }
      clampScrollTop(scroller, next);

      if (k < 1 && scroller.scrollTop > 0) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

// ===== 展开 =====
async function expandRow(btn){
  const tr = safeClosest(btn, 'tr'); if (!tr) return;
  if (isRowAnimating(tr)) return;
  setRowAnimating(tr, true, btn);
  const unlock = () => setRowAnimating(tr, false, btn);

  const scroller = getScroller(tr);
  const trRectBefore = tr.getBoundingClientRect(); // 供“最后一行”基准使用

  setSubrowAnchorVar(tr);

  // 插入前：收集“后续主行”及其可视 top
  const followers = collectFollowers(tr);
  const prevMap = measureTops(followers);

  // 构造并插入子行
  const condsRaw = parseConds(tr);
  const sorted = condsRaw.slice().sort((a,b)=>{
    const ra = getChildRank(a);
    const rb = getChildRank(b);
    if (ra !== rb) return ra - rb;
    const ca = getChildCount(a);
    const cb = getChildCount(b);
    return cb - ca;
  });
  tr.insertAdjacentHTML('afterend', sorted.map(c=>{
    return buildSubrowHTML(tr, c, getChildCount(c));
  }).join(''));

  // 子行总高度增量
  let HExact = 0; {
    let n=tr.nextElementSibling;
    while(n && n.classList.contains('fc-subrow')) { HExact += n.getBoundingClientRect().height; n = n.nextElementSibling; }
    if (!isFinite(HExact) || HExact<=0) {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--subrow-h').trim();
      const h = parseFloat(v) || 26; HExact = h * sorted.length;
    }
  }

  const firstSub = tr.nextElementSibling && tr.nextElementSibling.classList.contains('fc-subrow')
    ? tr.nextElementSibling : null;

  // 父→子接力位移
  let dyLabel = null, dyBtn = null;
  if (firstSub) {
    const pLabel = (tr.children[5]?.querySelector('.fc-marquee-inner')) || tr.querySelector('[data-role="top-cond"], .js-top-cond');
    const cLabel = firstSub.querySelector('td[colspan] .fc-subrow__label');
    const pBtn   = tr.querySelector('td:last-child .fc-btn-icon-add');
    const cBtn   = firstSub.querySelector('td:last-child .fc-btn-icon-add');
  
    if (pLabel && cLabel) {
      const pr = pLabel.getBoundingClientRect();
      const cr = cLabel.getBoundingClientRect();
      const pCenter = pr.top + pr.height/2;
      const cCenter = cr.top + cr.height/2;
      dyLabel = Math.round((cCenter - pCenter));
      const fromY = Math.round((pCenter - cCenter));
      cLabel.style.transition = 'none';
      cLabel.style.transform = `translateY(${fromY}px)`;
      addClip(firstSub.querySelector('td[colspan]'));
    }
    if (pBtn && cBtn) {
      const prb = pBtn.getBoundingClientRect();
      const crb = cBtn.getBoundingClientRect();
      dyBtn = Math.round(crb.top - prb.top);
      cBtn.style.transition = 'none';
      cBtn.style.transform = `translateY(${Math.round(prb.top - crb.top)}px)`;
      addClip(firstSub.querySelector('td:last-child'));
    }
  
    requestAnimationFrame(()=> {
      if (cLabel){ cLabel.style.transition = `transform ${ANIM.rowMs}ms ${ANIM.rowEase}`; cLabel.style.transform = 'translateY(0)'; }
      if (cBtn){   cBtn.style.transition   = `transform ${ANIM.rowMs}ms ${ANIM.rowEase}`; cBtn.style.transform   = 'translateY(0)'; }
    
      setTimeout(()=> {
        removeClip(firstSub.querySelector('td[colspan]'));
        removeClip(firstSub.querySelector('td:last-child'));
        if (cLabel){ cLabel.style.transition=''; cLabel.style.transform=''; }
        if (cBtn){   cBtn.style.transition='';   cBtn.style.transform=''; }
      }, ANIM.rowMs + ANIM.cleanupMs);
    });
  }

  // followers 位移测量
  const currMap = measureTops(followers);

  // 父行工况/按钮接力位移
  toggleParentHotCondAndAction(tr, true, {
    mode:'relay',
    duration: ANIM.rowMs,
    easing: ANIM.rowEase,
    dyLabel,
    dyBtn
  });

  // 展开滚动同步（动态阈值）
  if (scroller) {
    const scRect = scroller.getBoundingClientRect();
    let freeSpacePx = 0;

    if (followers.length === 0) {
      // 最后一行：基于“父行底边”
      freeSpacePx = Math.max(0, Math.round(scRect.bottom - trRectBefore.bottom));
    } else {
      // 非最后一行：基于“第一条下移主行的插入前顶边”
      const firstFollower = followers[0];
      const prevTopFF = prevMap.get(firstFollower);
      if (typeof prevTopFF === 'number') {
        freeSpacePx = Math.max(0, Math.round(scRect.bottom - prevTopFF));
      } else {
        // 兜底：用“插入后 top - 预计下移量”近似回推
        const ffRect = firstFollower.getBoundingClientRect();
        freeSpacePx = Math.max(0, Math.round(scRect.bottom - (ffRect.top - HExact)));
      }
    }
    startTrackScrollPinDynamic(scroller, +HExact, freeSpacePx);
  }

  // followers 位移动画
  markAnimating(followers, true);
  if (!followers.length) {
    setTimeout(() => {
      stopRowMaskTracking();
      unlock();
    }, ANIM.rowMs + ANIM.cleanupMs);
  } else {
    startRowMaskTracking(followers);
    followers.forEach(el => {
      const prevTop = prevMap.get(el), currTop = currMap.get(el);
      if (prevTop == null || currTop == null) return;
      const dy = prevTop - currTop; if (Math.abs(dy) < 0.5) return;
      el.style.transition = 'none'; el.style.transform = `translateY(${dy}px)`;
    });
    void document.body.offsetWidth;

    let rest = followers.length;
    requestAnimationFrame(() => {
      followers.forEach(el => {
        if (!prevMap.has(el)) return;
        el.style.transition = `transform ${ANIM.rowMs}ms ${ANIM.rowEase}`;
        el.style.transform = 'translateY(0)';
      });
      const onEnd = (e) => {
        if (e.propertyName !== 'transform') return;
        const el = e.currentTarget;
        el.removeEventListener('transitionend', onEnd);
        el.style.transition = '';
        el.style.transform = '';
        el.classList.remove('fc-row-animating');
        if (--rest === 0) {
          stopRowMaskTracking();
          unlock();
        }
      };
      followers.forEach(el => el.addEventListener('transitionend', onEnd));
      setTimeout(() => {
        if (rest > 0) {
          rest = 0;
          stopRowMaskTracking();
          unlock();     
        }
      }, ANIM.rowMs + ANIM.guardMs);
    });
  }
  btn.setAttribute('aria-expanded','true');
  btn.removeAttribute('title');
  btn.classList.add('is-open');

  if (typeof syncQuickActionButtons === 'function') syncQuickActionButtons();
}

// REPLACE: collapseRow —— 融合“最后一行收起：容器平滑移动后再移除子行”
function collapseRow(btn){
  const tr = safeClosest(btn, 'tr'); if (!tr) return;
  if (isRowAnimating(tr)) return;
  setRowAnimating(tr, true, btn);
  const unlock = () => setRowAnimating(tr, false, btn);

  const scroller = getScroller(tr);

  const mid = tr.dataset.modelId || '';
  const subrows=[]; let n=tr.nextElementSibling; while (isSubrowOf(n, mid)) { subrows.push(n); n = n.nextElementSibling; }
  if (!subrows.length) {
    toggleParentHotCondAndAction(tr, false);
    unlock();
    btn.setAttribute('aria-expanded','false'); btn.removeAttribute('title'); btn.classList.remove('is-open'); return;
  }

  // 预先接力：父→子
  const firstSub = subrows[0] || null;
  let fromDyLabel = null, fromDyBtn = null;
  if (firstSub) {
    const pLabel = (tr.children[5]?.querySelector('.fc-marquee-inner')) || tr.querySelector('[data-role="top-cond"], .js-top-cond');
    const cLabel = firstSub.querySelector('td[colspan] .fc-subrow__label');
    const pBtn   = tr.querySelector('td:last-child .fc-btn-icon-add');
    const cBtn   = firstSub.querySelector('td:last-child .fc-btn-icon-add');

    if (pLabel && cLabel) {
      const pr = pLabel.getBoundingClientRect();
      const cr = cLabel.getBoundingClientRect();
      const pCenter = pr.top + pr.height/2;
      const cCenter = cr.top + cr.height/2;
      fromDyLabel = Math.round((cCenter - pCenter));
      addClip(firstSub.querySelector('td[colspan]'));
      cLabel.style.transition = `transform ${ANIM.rowMs}ms ${ANIM.rowEase}`;
      cLabel.style.transform  = `translateY(${Math.round((pCenter - cCenter))}px)`;
    }
    if (pBtn && cBtn) {
      const prb = pBtn.getBoundingClientRect();
      const crb = cBtn.getBoundingClientRect();
      fromDyBtn = Math.round(crb.top - prb.top);
      addClip(firstSub.querySelector('td:last-child'));
      cBtn.style.transition = `transform ${ANIM.rowMs}ms ${ANIM.rowEase}`;
      cBtn.style.transform  = `translateY(${Math.round(prb.top - crb.top)}px)`;
    }

    setTimeout(()=> {
      removeClip(firstSub.querySelector('td[colspan]'));
      removeClip(firstSub.querySelector('td:last-child'));
      if (cLabel){ cLabel.style.transition=''; cLabel.style.transform=''; }
      if (cBtn){   cBtn.style.transition='';   cBtn.style.transform=''; }
    }, ANIM.rowMs + ANIM.cleanupMs);
  }

  // 将要减少的总高度
  let HExact = 0; for (const sr of subrows) HExact += sr.getBoundingClientRect().height;
  if (!isFinite(HExact) || HExact<=0) {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--subrow-h').trim();
    const h = parseFloat(v) || 26; HExact = h * subrows.length;
  }

  // 父行接力入场
  toggleParentHotCondAndAction(tr, false, {
    mode:'relay',
    duration: ANIM.rowMs,
    easing: ANIM.rowEase,
    fromDyLabel,
    fromDyBtn
  });

  // 判断是否“最后一行”
  const lastSub = subrows[subrows.length - 1];
  const followers = collectFollowersAfter(lastSub);
  const isLastMainRow = followers.length === 0;

  if (isLastMainRow) {
    // 最后一行：绝对量平滑滚动，结束后再移除子行
    if (scroller) {
      collapseLastRowWithMask(tr, scroller, subrows, ANIM.rowMs, () => {
        unlock();
      });
    } else {
      setTimeout(() => { subrows.forEach(sr => sr.remove()); unlock(); }, ANIM.rowMs + ANIM.cleanupMs);
    }
  } else {
    // 非最后一行：动态阈值滚动 + followers 上移动画
    if (scroller) {
      const scRect = scroller.getBoundingClientRect();
      const lastMain = getLastMainRow(tr);
      if (lastMain) {
        const lmRect = lastMain.getBoundingClientRect();
        const freeSpacePx = Math.max(0, Math.round(scRect.bottom - lmRect.bottom));
        startTrackScrollPinDynamicCollapse(scroller, HExact, freeSpacePx);
      }
    }

    followers.forEach(el => { 
      el.classList.add('fc-row-animating'); 
      el.style.transition='none'; 
      el.style.transform='translate3d(0,0,0)'; 
      el.style.willChange='transform'; 
    });
    void document.body.offsetWidth;

    startRowMaskTracking(followers);
    requestAnimationFrame(() => {
      followers.forEach(el => {
        el.style.transition = `transform ${ANIM.rowMs}ms ${ANIM.rowEase}`;
        el.style.transform = `translate3d(0, ${-HExact}px, 0)`;
      });

      let rest = followers.length, fired = false;
      const done = () => {
        if (fired) return; fired = true;
        subrows.forEach(sr => sr.remove());
        void document.body.offsetWidth;
        requestAnimationFrame(() => {
          followers.forEach(el => {
            el.style.transition = 'none'; el.style.transform = ''; el.style.willChange = '';
            el.classList.remove('fc-row-animating');
            requestAnimationFrame(() => { el.style.transition = ''; });
          });
          stopRowMaskTracking();
          unlock();
        });
      };
      const onEnd = (e) => {
        if (e.propertyName !== 'transform') return;
        e.currentTarget.removeEventListener('transitionend', onEnd);
        if (--rest === 0) done();
      };
      followers.forEach(el => el.addEventListener('transitionend', onEnd));
      setTimeout(done, ANIM.rowMs + ANIM.guardMs);
    });
  }

  btn.setAttribute('aria-expanded','false');
  btn.removeAttribute('title'); btn.classList.remove('is-open');
}

  document.addEventListener('click', (e)=>{
    const toggle = safeClosest(e.target, '.fc-expand-toggle');
    if (!toggle) return;
    const tr = safeClosest(toggle, 'tr');
    if (tr && isRowAnimating(tr)) { e.preventDefault(); e.stopPropagation(); return; }
    e.preventDefault(); e.stopPropagation();
    if (toggle.getAttribute('aria-expanded') === 'true') collapseRow(toggle);
    else expandRow(toggle);
  });
}

  function addClip(el){ if(el){ el.classList.add('fc-col-clip'); el.style.position = el.style.position || 'relative'; } }
  function removeClip(el){ if(el){ el.classList.remove('fc-col-clip'); } }

  // 仅位移的隐藏/显示（保留）
  function slideHideEl(el, toDy, duration=ANIM.rowMs, easing=ANIM.rowEase){
    if (!el) return;
    el.style.visibility = 'visible';
    el.style.willChange = 'transform';
    el.style.transition = `transform ${duration}ms ${easing}`;
    requestAnimationFrame(()=> {
      el.style.transform = `translateY(${Math.round(toDy)}px)`;
    });
    const onEnd = (e)=> {
      if (e.propertyName !== 'transform') return;
      el.removeEventListener('transitionend', onEnd);
      el.style.visibility = 'hidden';
      el.style.transition = '';
      el.style.transform = '';
      el.style.willChange = '';
    };
    el.addEventListener('transitionend', onEnd);
  }
  function slideShowEl(el, fromDy, duration=ANIM.rowMs, easing=ANIM.rowEase){
    if (!el) return;
    el.style.visibility = 'visible';
    el.style.willChange = 'transform';
    el.style.transition = 'none';
    el.style.transform = `translateY(${Math.round(fromDy)}px)`;
    void el.offsetWidth;
    requestAnimationFrame(()=> {
      el.style.transition = `transform ${duration}ms ${easing}`;
      el.style.transform = 'translateY(0)';
    });
    const onEnd = (e)=> {
      if (e.propertyName !== 'transform') return;
      el.removeEventListener('transitionend', onEnd);
      el.style.transition = '';
      el.style.transform = '';
      el.style.willChange = '';
    };
    el.addEventListener('transitionend', onEnd);
  }

  // 滚动容器与贴边判定（保留基础工具）
function getScroller(tr){
  return tr?.closest?.('.fc-rank-scroll') || null;
}

function clampScrollTop(scroller, v){
  const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  scroller.scrollTop = Math.max(0, Math.min(maxScroll, v));
}


// REPLACE: 最后一行“收起”专用的绝对量平滑滚动（保持不变，确保存在）
function startTrackScrollPinCollapseAbsolute(scroller, totalDelta, duration=ANIM.rowMs){
  if (!scroller || !isFinite(totalDelta) || totalDelta <= 0) return;
  const easeInOut = (t)=> t<.5 ? (2*t*t) : (1 - Math.pow(-2*t+2,2)/2);
  const startTop = scroller.scrollTop;
  let startTs = 0, raf = 0, stopped = false;

  function frame(ts){
    if (!startTs) startTs = ts;
    const k = Math.min(1, (ts - startTs) / Math.max(1, duration));
    const e = easeInOut(k);
    const next = startTop - e * totalDelta; // 收起：scrollTop 逐步减少，容器“向下”运动
    clampScrollTop(scroller, next);
    if (scroller.scrollTop <= 0) stopped = true;  // 触顶即止
    if (k < 1 && !stopped) raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);
}

// REPLACE: 最后一行“收起”的平滑方案 —— 去掉遮罩，仅平滑滚动，结束后再移除子行
function collapseLastRowWithMask(tr, scroller, subrows, duration=ANIM.rowMs, onDone){
  try {
    if (!subrows || !subrows.length) { if (typeof onDone==='function') onDone(); return; }

    // 计算本次将减少的总高度（不改动子行 DOM）
    let HExact = 0;
    for (const sr of subrows) HExact += sr.getBoundingClientRect().height;
    if (!isFinite(HExact) || HExact <= 0) {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--subrow-h').trim();
      const h = parseFloat(v) || 26;
      HExact = h * subrows.length;
    }

    // 容器平滑“向下”移动：按绝对量 HExact 逐步减少 scrollTop（触顶即止）
    if (scroller) {
      startTrackScrollPinCollapseAbsolute(scroller, HExact, duration);
    }

    // 动画结束后再移除子行（scrollTop 已同步完成，不会瞬跳）
    const cleanup = () => {
      subrows.forEach(sr => sr.remove());
      if (typeof onDone==='function') onDone();
    };
    setTimeout(cleanup, duration + ANIM.cleanupMs);
  } catch(_) {
    if (typeof onDone==='function') onDone();
  }
}

})(window);

if (document.readyState !== 'loading') { window.RightPanel?.init(); }
else { document.addEventListener('DOMContentLoaded', () => window.RightPanel?.init(), { once:true }); }