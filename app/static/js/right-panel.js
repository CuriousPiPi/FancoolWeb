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

  function init() {
    mountRightSubseg();
    initRightPanelSnapTabs();
    initTopQueriesExpander();
    initRightPanelResponsiveWrap();
    initMainPanelsAdaptiveStack();
    initRightSubsegDragSwitch();
    updateRightSubseg('top-queries');
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

  /* ===== 查询榜：展开/收起 ===== */

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

    // 第 7 列（查询次数）左内边距（你这部分已对齐，保留）
    const td7 = parentTr.children && parentTr.children[6];
    if (td7) {
      const cs7 = getComputedStyle(td7);
      const pl7 = parseFloat(cs7.paddingLeft) || 0;
      table.style.setProperty('--subrow-count-pl', Math.round(pl7) + 'px');
    }
  } catch(_) {}
}

  function animateHideEl(el, dx=0, dy=6, duration=200) {
    if (!el || el.dataset._anim_state === 'hiding') return;
    el.dataset._anim_state = 'hiding';
    el.classList.add('fc-fade-slide');
    el.style.visibility = ''; el.style.opacity = '1'; el.style.transform = 'translate3d(0,0,0)';
    void el.offsetWidth;
    el.style.transition = `transform ${duration}ms ease, opacity ${duration}ms ease`;
    requestAnimationFrame(() => { el.style.opacity = '0'; el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`; });
    const onEnd = (e) => { if (e.propertyName !== 'opacity') return;
      el.removeEventListener('transitionend', onEnd); el.style.visibility = 'hidden'; el.style.transition = ''; el.dataset._anim_state = ''; };
    el.addEventListener('transitionend', onEnd);
  }
  function animateShowEl(el, dx=0, dy=-6, duration=220) {
    if (!el || el.dataset._anim_state === 'showing') return;
    el.dataset._anim_state = 'showing';
    el.classList.add('fc-fade-slide');
    el.style.visibility = 'visible'; el.style.opacity = '0'; el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
    void el.offsetWidth;
    el.style.transition = `transform ${duration}ms ease, opacity ${duration}ms ease`;
    requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'translate3d(0,0,0)'; });
    const onEnd = (e) => { if (e.propertyName !== 'opacity') return;
      el.removeEventListener('transitionend', onEnd); el.style.transition = ''; el.dataset._anim_state = ''; };
    el.addEventListener('transitionend', onEnd);
  }

  function toggleParentHotCondAndAction(tr, expanded){
    if (!tr) return;
    const hot = tr.querySelector('[data-role="top-cond"], .js-top-cond');
    const actionBtn = tr.querySelector('td:last-child .fc-btn-icon-add') || null;
    let actionCell = null;
    if (!actionBtn) {
      const tds = Array.from(tr.children || []);
      for (const td of tds) { if (td && td.querySelector && td.querySelector('.fc-btn-icon-add')) { actionCell = td; break; } }
    }
    if (expanded) {
      if (hot) animateHideEl(hot);
      if (actionBtn) animateHideEl(actionBtn); else if (actionCell) animateHideEl(actionCell);
    } else {
      if (hot) animateShowEl(hot);
      if (actionBtn) animateShowEl(actionBtn); else if (actionCell) animateShowEl(actionCell);
    }
  }

  function initTopQueriesExpander(){
    const DURATION = 240, EASE_EXPAND = 'ease', EASE_COLLAPSE = 'ease';

    function parseConds(tr){ try { return JSON.parse(tr.dataset.conditions || '[]') || []; } catch(_) { return []; } }

    // 子行：colspan=6 + 次数 + 操作
    function buildSubrowHTML(parentTr, cond){
      const brand = parentTr.dataset.brand || '';
      const model = parentTr.dataset.model || '';
      const mid   = parentTr.dataset.modelId || '';
      const cid   = String(cond.condition_id || '');
      const cname = String(cond.condition_name_zh || '');

      // 风阻类型(位置) → 工况左侧浅灰小字
      const rt = cond.resistance_type_zh || cond.rt || '';
      const rl = cond.resistance_location_zh || cond.rl || '';
      let extra = '';
      if (typeof window.formatScenario === 'function') extra = window.formatScenario(rt, rl);
      else {
        const rtype = escapeHtml(rt || ''), rloc = String(rl || '').trim();
        extra = rloc && rloc !== '无' ? `${rtype}(${escapeHtml(rl)})` : rtype;
      }
      const extraLeft = extra ? `<span class="fc-subrow__extra-left">${escapeHtml(extra)}&nbsp;&nbsp;&nbsp;</span>` : '';

      const qcnt  = Number(cond.query_count || 0);
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
              <span class="text-blue-600 font-medium">${escapeHtml(qcnt)}</span>
            </div>
          </td>
          <td>
            <div class="fc-subrow__row fc-subrow__row--actions">
              ${buildQuickBtnHTML('ranking', brand, model, mid, cid, cname, 'top_query_expand')}
            </div>
          </td>
        </tr>`;
    }

    function isSubrowOf(row, mid){ return row && row.classList && row.classList.contains('fc-subrow') && row.dataset.parentMid === String(mid); }
    function collectFollowers(fromTr){ const arr=[]; let n=fromTr.nextElementSibling; while(n){ arr.push(n); n=n.nextElementSibling; } return arr; }
    function collectFollowersAfter(el){ const arr=[]; let n=el?el.nextElementSibling:null; while(n){ arr.push(n); n=n.nextElementSibling; } return arr; }
    function measureTops(els){ const m=new Map(); els.forEach(el=>{ m.set(el, el.getBoundingClientRect().top); }); return m; }
    function markAnimating(els,on){ els.forEach(el=>{ if(on) el.classList.add('fc-row-animating'); else el.classList.remove('fc-row-animating'); }); }

    function expandRow(btn){
      const tr = safeClosest(btn, 'tr'); if (!tr) return;
      const conds = parseConds(tr); if (!conds.length) return;
      if (btn.getAttribute('aria-expanded') === 'true') { collapseRow(btn); return; }

      // 展开前计算并设置锚点与第7列 padding-left
      setSubrowAnchorVar(tr);

      const followers = collectFollowers(tr);
      const prevMap = measureTops(followers);

      const sorted = conds.slice().sort((a,b)=>(b.query_count||0)-(a.query_count||0));
      tr.insertAdjacentHTML('afterend', sorted.map(c=>buildSubrowHTML(tr, c)).join(''));

      const currMap = measureTops(followers);

      toggleParentHotCondAndAction(tr, true);

      markAnimating(followers, true);
      followers.forEach(el => {
        const prevTop = prevMap.get(el), currTop = currMap.get(el);
        if (prevTop == null || currTop == null) return;
        const dy = prevTop - currTop; if (Math.abs(dy) < 0.5) return;
        el.style.transition = 'none'; el.style.transform = `translateY(${dy}px)`;
      });
      void document.body.offsetWidth;
      requestAnimationFrame(() => {
        followers.forEach(el => {
          if (!prevMap.has(el)) return;
          el.style.transition = `transform ${DURATION}ms ${EASE_EXPAND}`;
          el.style.transform = 'translateY(0)';
        });
        const onEnd = (e) => {
          if (e.propertyName !== 'transform') return;
          const el = e.currentTarget;
          el.removeEventListener('transitionend', onEnd);
          el.style.transition = '';
          el.style.transform = '';
          el.classList.remove('fc-row-animating');
        };
        followers.forEach(el => el.addEventListener('transitionend', onEnd));
      });

      btn.setAttribute('aria-expanded','true');
      btn.title = '收起';
      btn.classList.add('is-open');

      if (typeof syncQuickActionButtons === 'function') syncQuickActionButtons();
    }

    function collapseRow(btn){
      const tr = safeClosest(btn, 'tr'); if (!tr) return;
      const mid = tr.dataset.modelId || '';
      const subrows=[]; let n=tr.nextElementSibling; while(isSubrowOf(n, mid)){ subrows.push(n); n=n.nextElementSibling; }
      if (!subrows.length) {
        toggleParentHotCondAndAction(tr, false);
        btn.setAttribute('aria-expanded','false'); btn.title='展开全部工况'; btn.classList.remove('is-open'); return;
      }

      let HExact = 0; for (const sr of subrows) HExact += sr.getBoundingClientRect().height;
      if (HExact <= 0) {
        const v = getComputedStyle(document.documentElement).getPropertyValue('--subrow-h').trim();
        const h = parseFloat(v) || 34; HExact = h * subrows.length;
      }

      const lastSub = subrows[subrows.length - 1];
      const followers = collectFollowersAfter(lastSub);
      if (!followers.length) {
        subrows.forEach(sr => sr.remove());
        toggleParentHotCondAndAction(tr, false);
        btn.setAttribute('aria-expanded','false'); btn.title='展开全部工况'; btn.classList.remove('is-open'); return;
      }

      followers.forEach(el => { el.classList.add('fc-row-animating'); el.style.transition='none'; el.style.transform='translate3d(0,0,0)'; el.style.willChange='transform'; });
      void document.body.offsetWidth;

      requestAnimationFrame(() => {
        followers.forEach(el => {
          el.style.transition = `transform ${DURATION}ms ${EASE_COLLAPSE}`;
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
            toggleParentHotCondAndAction(tr, false);
          });
        };
        const onEnd = (e) => { if (e.propertyName !== 'transform') return;
          e.currentTarget.removeEventListener('transitionend', onEnd);
          if (--rest === 0) done();
        };
        followers.forEach(el => el.addEventListener('transitionend', onEnd));
        setTimeout(done, DURATION + 200);
      });

      btn.setAttribute('aria-expanded','false');
      btn.title='展开全部工况';
      btn.classList.remove('is-open');
    }

    document.addEventListener('click', (e)=>{
      const toggle = safeClosest(e.target, '.fc-expand-toggle');
      if (!toggle) return;
      e.preventDefault(); e.stopPropagation();
      if (toggle.getAttribute('aria-expanded') === 'true') collapseRow(toggle);
      else expandRow(toggle);
    });
  }

})(window);

if (document.readyState !== 'loading') { window.RightPanel?.init(); }
else { document.addEventListener('DOMContentLoaded', () => window.RightPanel?.init(), { once:true }); }