/* PATCH VERSION (P3C2+): 
 * - Adds sidebar-top snap click bridge
 * - Right subseg relocation & proper visibility toggle
 * - Splitter rails decoration
 * - Restores dynamic height sync for #sidebar-top-container (syncTopTabsViewportHeight)
 * - Fixes seg switching (queries/likes & airflow/likes)
 * - FIX (P3C2+H2): Correct top container viewport height (subtract sidebar-top nav height)
 */

(function initLayoutModule(){
  console.info('[layout:init] layout module loaded');

  window.__APP = window.__APP || {};
  const dom = window.__APP.dom || {
    one: s=>document.querySelector(s),
    all: (s,scope)=>Array.from((scope||document).querySelectorAll(s))
  };

  /* -------------------------------------------------------
   * 工具 / 状态
   * ----------------------------------------------------- */
  let userAdjustedVertical = false;
  let unlockOnNextExpand = false;
  let _adjustQueued = false;
  let currentSidebarWidth = 0;
  let isCollapsed = false;
  let __VERT_DRAGGING = false;
  const sidebar = dom.one('#sidebar');
  const mainContent = dom.one('#main-content');
  const resizer = dom.one('#sidebar-resizer');
  const splitter = dom.one('#sidebar-splitter');
  const topPanel = dom.one('#top-panel');
  const bottomPanel = dom.one('#bottom-panel');
  const sidebarToggle = document.getElementById('sidebar-toggle');

  /* ---------------- Focus Trap ---------------- */
  const a11yFocusTrap = (function(){
    let container=null,lastFocused=null,bound=false;
    function focusable(root){
      return Array.from(root.querySelectorAll(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
      )).filter(el=>el.offsetParent!==null);
    }
    function onKey(e){
      if(e.key!=='Tab'||!container) return;
      const list=focusable(container);
      if(!list.length){ e.preventDefault(); container.focus(); return;}
      const first=list[0], last=list[list.length-1];
      if(e.shiftKey){
        if(document.activeElement===first){ e.preventDefault(); last.focus(); }
      } else {
        if(document.activeElement===last){ e.preventDefault(); first.focus(); }
      }
    }
    return {
      activate(root){
        if(!root) return;
        container=root;
        lastFocused=document.activeElement;
        const list=focusable(root);
        (list[0]||root).focus({preventScroll:true});
        if(!bound){ document.addEventListener('keydown',onKey,true); bound=true; }
      },
      deactivate(){
        if(bound){ document.removeEventListener('keydown',onKey,true); bound=false; }
        if(lastFocused && lastFocused.focus) lastFocused.focus({preventScroll:true});
        container=null; lastFocused=null;
      }
    };
  })();

  /* ---------------- syncTopTabsViewportHeight (FIX P3C2+H2) ----------------
   * 旧逻辑未扣除 sidebar-top 导航高度，导致容器多出一段被下半区覆盖。
   * 新逻辑：
   *   可用高度 = (.sidebar-panel-content 内部高度 - paddingTop - paddingBottom) - navHeight
   *   nav 选择器：.tab-nav[data-tab-group="sidebar-top"]
   *   若获取失败则回退旧方式，最少 0
   */
  function syncTopTabsViewportHeight(){
    const container = document.getElementById('sidebar-top-container');
    if(!container || !topPanel) return;

    // 定位到内容容器（含 nav 与 #sidebar-top-container 的这一层）
    const content = topPanel.querySelector('.sidebar-panel-content');
    if(!content){
      // 回退：旧逻辑
      const csTop = getComputedStyle(topPanel);
      const pad = (parseFloat(csTop.paddingTop)||0) + (parseFloat(csTop.paddingBottom)||0);
      const hFallback = topPanel.clientHeight - pad;
      if(hFallback>0 && Math.abs(container.clientHeight - hFallback) > 1){
        container.style.height = hFallback + 'px';
      }
      return;
    }

    const nav = content.querySelector('.tab-nav[data-tab-group="sidebar-top"]');
    const cs = getComputedStyle(content);
    const padV = (parseFloat(cs.paddingTop)||0) + (parseFloat(cs.paddingBottom)||0);
    const innerHeight = content.clientHeight - padV;        // 去掉内容容器自身 padding

    const navH = nav ? nav.getBoundingClientRect().height : 0;
    let available = innerHeight - navH;
    if(available < 0) available = 0;

    // 避免抖动：变化超过 0.5px 再写
    if(Math.abs(container.clientHeight - available) > 0.5){
      container.style.height = available + 'px';
    }
  }
  window.syncTopTabsViewportHeight = syncTopTabsViewportHeight;

  /* ---------------- scheduleAdjust / 自动高度 ---------------- */
  function scheduleAdjust(){
    if(__VERT_DRAGGING) return;
    if(userAdjustedVertical) return;
    if(_adjustQueued) return;
    _adjustQueued=true;
    requestAnimationFrame(()=>{
      _adjustQueued=false;
      applyAutoBottomHeight();
    });
  }
  function applyAutoBottomHeight(){
    if(userAdjustedVertical) { syncTopTabsViewportHeight(); return; }
    if(!bottomPanel||!topPanel) return;
    const CFG={ MIN_BOTTOM_PX:140, MAX_RATIO:0.72, MIN_TOP_SPACE_PX:260 };
    const px=v=>Number.parseFloat(v)||0;
    const hRect=el=>el?Math.ceil(el.getBoundingClientRect().height):0;
    const isHidden=el=>!el||el.classList.contains('hidden');
    const content=bottomPanel.querySelector('.sidebar-panel-content');
    const title=content?.querySelector('h2');
    const list=document.getElementById('selectedFansList');
    const footer=document.getElementById('clearAllContainer');
    const winH=window.innerHeight;
    const titleH=hRect(title);
    const titleMB=title?px(getComputedStyle(title).marginBottom):0;
    const contentPT=content?px(getComputedStyle(content).paddingTop):0;
    const footerH=!isHidden(footer)?hRect(footer):0;
    let rows=0,rowH=56,gapY=0,listPT=0,listPB=0;
    if(list){
      const items=list.querySelectorAll('.fan-item');
      rows=items.length;
      if(rows>0){
        rowH=hRect(items[0]);
        if(rows>1) gapY=px(getComputedStyle(items[1]).marginTop);
      }
      const ls=getComputedStyle(list);
      listPT=px(ls.paddingTop); listPB=px(ls.paddingBottom);
    }
    const listContentH = rows>0 ? rows*rowH + Math.max(0,rows-1)*gapY + listPT + listPB : 0;
    const chromeH = contentPT + titleH + titleMB + footerH;
    const maxBottomByRatio = winH * CFG.MAX_RATIO;
    const maxBottomByTopReserve = winH - CFG.MIN_TOP_SPACE_PX;
    const maxBottom = Math.max(CFG.MIN_BOTTOM_PX, Math.min(maxBottomByRatio, maxBottomByTopReserve));
    const maxListViewport = Math.max(0, maxBottom - chromeH);
    const listViewportH = Math.min(listContentH, maxListViewport);
    const ideal = chromeH + listViewportH;
    const desired = Math.round(Math.max(Math.min(ideal, maxBottom), Math.min(CFG.MIN_BOTTOM_PX, maxBottom)));
    bottomPanel.style.flex=`0 0 ${desired}px`;
    topPanel.style.flex='1 1 auto';
    syncTopTabsViewportHeight();
  }
  function unlockVerticalAuto(){
    userAdjustedVertical=false; __VERT_DRAGGING=false;
    document.body.classList.remove('is-vert-dragging');
    if(topPanel){ topPanel.style.height=''; topPanel.style.flex=''; }
    if(bottomPanel){ bottomPanel.style.height=''; bottomPanel.style.flex=''; }
    scheduleAdjust();
  }
  function maybeUnlockOnExpand(){
    if(!unlockOnNextExpand) return;
    unlockOnNextExpand=false;
    unlockVerticalAuto();
  }

  /* ---------------- Sidebar Toggle / Overlay ---------------- */
  function refreshToggleUI(){
    const btn=document.getElementById('sidebar-toggle');
    if(!btn||!sidebar) return;
    const collapsed=sidebar.classList.contains('collapsed');
    btn.setAttribute('aria-label',collapsed?'展开侧栏':'收起侧栏');
    btn.setAttribute('aria-expanded',String(!collapsed));
  }
  function openSidebar(){
    if(!sidebar) return;
    if(document.documentElement.classList.contains('sidebar-overlay-mode')){
      overlayOpenSidebarInternal(); return;
    }
    if(sidebar.classList.contains('collapsed')){
      sidebar.classList.remove('collapsed');
      if(mainContent) mainContent.style.marginLeft = currentSidebarWidth+'px';
      isCollapsed=false;
      setTimeout(()=>{ if(window.resizeChart) window.resizeChart(); },300);
      requestAnimationFrame(()=>maybeUnlockOnExpand());
      refreshToggleUI();
    }
  }
  function closeSidebar(){
    if(!sidebar) return;
    if(document.documentElement.classList.contains('sidebar-overlay-mode')){
      overlayCloseSidebarInternal(); return;
    }
    if(!sidebar.classList.contains('collapsed')){
      currentSidebarWidth = sidebar.getBoundingClientRect().width;
      sidebar.classList.add('collapsed');
      if(mainContent) mainContent.style.marginLeft='0';
      isCollapsed=true;
      unlockOnNextExpand=true;
      refreshToggleUI();
    }
  }
  function toggleSidebar(){
    if(!sidebar) return;
    if(sidebar.classList.contains('collapsed')) openSidebar(); else closeSidebar();
  }

  /* 预声明避免 TDZ */
  let overlayOpenSidebarInternal = ()=>{};
  let overlayCloseSidebarInternal = ()=>{};

  (function initSidebarOverlayModeOnce(){
    if(window.innerWidth >= 600) return;
    const root=document.documentElement;
    root.classList.add('sidebar-overlay-mode');
    if(sidebar && !sidebar.classList.contains('collapsed')) sidebar.classList.add('collapsed');
    let bodyLockCount=0, prevOverflow='';
    function lockBody(){ if(bodyLockCount===0){ prevOverflow=document.body.style.overflow; document.body.style.overflow='hidden'; } bodyLockCount++; }
    function unlockBody(){ bodyLockCount=Math.max(0,bodyLockCount-1); if(!bodyLockCount) document.body.style.overflow=prevOverflow; }
    function addBackdrop(){
      if(document.querySelector('.sidebar-overlay-backdrop')){
        requestAnimationFrame(()=>document.querySelector('.sidebar-overlay-backdrop')?.classList.add('is-visible'));
        return;
      }
      const bd=document.createElement('div');
      bd.className='sidebar-overlay-backdrop';
      bd.addEventListener('click',()=>overlayCloseSidebarInternal());
      document.body.appendChild(bd);
      requestAnimationFrame(()=>bd.classList.add('is-visible'));
    }
    function removeBackdrop(){
      const bd=document.querySelector('.sidebar-overlay-backdrop');
      if(!bd) return;
      bd.classList.remove('is-visible');
      setTimeout(()=>bd.remove(),220);
    }
    function openOv(){
      if(!root.classList.contains('sidebar-overlay-mode')||!sidebar) return;
      sidebar.classList.remove('collapsed');
      addBackdrop(); lockBody(); ensureGestureZone(); a11yFocusTrap.activate(sidebar); refreshToggleUI();
    }
    function closeOv(){
      if(!root.classList.contains('sidebar-overlay-mode')||!sidebar) return;
      if(!sidebar.classList.contains('collapsed')){
        sidebar.classList.add('collapsed');
        removeBackdrop(); unlockBody(); a11yFocusTrap.deactivate(); refreshToggleUI();
      }
    }
    overlayOpenSidebarInternal=openOv;
    overlayCloseSidebarInternal=closeOv;
    document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeOv(); });
  })();

  function overlayToggleSidebarInternal(){
    if(!sidebar) return;
    if(sidebar.classList.contains('collapsed')) overlayOpenSidebarInternal(); else overlayCloseSidebarInternal();
  }

  if(sidebar){
    const mo=new MutationObserver(muts=>{
      muts.forEach(m=>{
        if(m.type==='attributes' && m.attributeName==='class'){
          refreshToggleUI();
          if(sidebar.classList.contains('collapsed')) unlockOnNextExpand=true;
          else requestAnimationFrame(maybeUnlockOnExpand);
        }
      });
    });
    mo.observe(sidebar,{ attributes:true });
  }

  if(sidebarToggle){
    if(!sidebarToggle.dataset.layoutBound){
      sidebarToggle.dataset.layoutBound='1';
      sidebarToggle.addEventListener('click',()=>{
        if(document.documentElement.classList.contains('sidebar-overlay-mode')) overlayToggleSidebarInternal();
        else toggleSidebar();
      });
    }
  }

  /* ---------------- Overlay Gesture Zone ---------------- */
  function ensureGestureZone(){
    if(!sidebar) return;
    if(!document.documentElement.classList.contains('sidebar-overlay-mode')) return;
    if(document.getElementById('sidebar-gesture-close-zone')) return;
    const zone=document.createElement('div');
    zone.id='sidebar-gesture-close-zone';
    sidebar.appendChild(zone);
    const MIN_DRAG_X=12, MAX_SLOPE=0.65, CLOSE_RATIO=0.30, VELOCITY=-0.8, MIN_FLING=24;
    let drag=null;
    function pt(e){
      if(e.changedTouches && e.changedTouches.length){
        const t=e.changedTouches[0]; return {x:t.clientX,y:t.clientY};
      }
      return {x:e.clientX,y:e.clientY};
    }
    function backdrop(){ return document.querySelector('.sidebar-overlay-backdrop'); }
    zone.addEventListener('pointerdown', e=>{
      if(e.pointerType==='mouse') return;
      if(sidebar.classList.contains('collapsed')) return;
      const p=pt(e);
      drag={ startX:p.x,startY:p.y,lastX:p.x,lastY:p.y,width:sidebar.getBoundingClientRect().width,dragging:false,pointerId:e.pointerId,trace:[{x:p.x,t:performance.now()}] };
      try { zone.setPointerCapture(e.pointerId); } catch(_){}
    }, { passive:true });
    zone.addEventListener('pointermove', e=>{
      if(!drag || drag.pointerId!==e.pointerId) return;
      const p=pt(e);
      drag.lastX=p.x; drag.lastY=p.y;
      const dx=p.x-drag.startX, dy=p.y-drag.startY;
      if(!drag.dragging){
        if(dx < -MIN_DRAG_X){
          const slope=Math.abs(dy/dx);
          if(slope<=MAX_SLOPE){ drag.dragging=true; sidebar.style.transition='none'; }
          else { drag=null; }
        }
        return;
      }
      e.preventDefault();
      const limited=Math.max(-drag.width, dx);
      sidebar.style.transform=`translateX(${limited}px)`;
      const bd=backdrop();
      if(bd){
        const ratio=Math.max(0,Math.min(1,1 + limited/drag.width));
        const eased=1 - (1 - ratio)*(1 - ratio);
        bd.style.opacity=(0.8*eased).toFixed(3);
        const now=performance.now();
        drag.trace.push({x:p.x,t:now});
        if(drag.trace.length>5) drag.trace.shift();
      }
    }, { passive:false });
    function finishDrag(){
      if(!drag) return;
      const dx=drag.lastX-drag.startX;
      const dist=Math.abs(dx);
      const bd=backdrop();
      let shouldClose = dist > drag.width * CLOSE_RATIO;
      if(!shouldClose && dist>MIN_FLING && drag.trace.length>=2){
        const a=drag.trace[drag.trace.length-2];
        const b=drag.trace[drag.trace.length-1];
        const dt=Math.max(1,b.t-a.t);
        const vx=(b.x-a.x)/dt;
        if(vx<=VELOCITY) shouldClose=true;
      }
      sidebar.style.transition='';
      if(shouldClose){
        overlayCloseSidebarInternal();
        requestAnimationFrame(()=>{ sidebar.style.transform=''; if(bd) bd.style.opacity=''; });
      } else {
        sidebar.style.transform='translateX(0)';
        if(bd) bd.style.opacity='';
        requestAnimationFrame(()=>{ if(!sidebar.classList.contains('collapsed')) sidebar.style.transform=''; });
      }
      drag=null;
    }
    zone.addEventListener('pointerup', e=>{ if(drag && drag.pointerId===e.pointerId) finishDrag(); }, { passive:true });
    zone.addEventListener('pointercancel', e=>{ if(drag && drag.pointerId===e.pointerId) finishDrag(); }, { passive:true });
  }

  /* ---------------- Splitter Handle ---------------- */
  (function initSplitterHandle(){
    if(!splitter || !topPanel || !bottomPanel) return;
    let handle=document.getElementById('sidebar-splitter-handle');
    if(!handle){
      handle=document.createElement('button');
      handle.id='sidebar-splitter-handle';
      handle.className='splitter-handle';
      handle.type='button';
      handle.setAttribute('role','separator');
      handle.setAttribute('aria-orientation','horizontal');
      handle.setAttribute('aria-label','拖拽调整上下面板高度');
      splitter.appendChild(handle);
    }
    handle.addEventListener('mousedown',e=>e.stopPropagation(),{passive:false});
    handle.addEventListener('touchstart',e=>e.stopPropagation(),{passive:false});
    let dragging=false,startY=0,startTopHeight=0,maxTop=0, rafFlag=false;
    const minTop=0;
    function measureConstraints(){
      const header=document.getElementById('sidebar-header');
      const sidebarRect=sidebar.getBoundingClientRect();
      const headerH=header?header.getBoundingClientRect().height:0;
      const trackHeight=sidebarRect.height - headerH - splitter.offsetHeight;
      const bpContent=bottomPanel.querySelector('.sidebar-panel-content');
      const bpTitle=bpContent?.querySelector('h2');
      const footer=document.getElementById('clearAllContainer');
      const csContent=bpContent?getComputedStyle(bpContent):null;
      const titleH=bpTitle?Math.ceil(bpTitle.getBoundingClientRect().height):0;
      const titleMB=bpTitle?parseFloat(getComputedStyle(bpTitle).marginBottom)||0:0;
      const contentPT=csContent?parseFloat(csContent.paddingTop)||0:0;
      const footerH=(footer && !footer.classList.contains('hidden'))?Math.ceil(footer.getBoundingClientRect().height):0;
      const chromeMinBottom=Math.ceil(titleH+titleMB+contentPT+footerH);
      const minBottom=Math.max(0, chromeMinBottom);
      const _maxTop=Math.max(minTop, trackHeight - minBottom);
      return { headerH, maxTop:_maxTop };
    }
    function onPointerDown(e){
      e.preventDefault(); e.stopPropagation();
      handle.setPointerCapture?.(e.pointerId);
      userAdjustedVertical=true;
      __VERT_DRAGGING=true;
      document.body.classList.add('is-vert-dragging');
      const { maxTop:mt } = measureConstraints();
      maxTop=mt;
      const topH=Math.max(minTop, Math.ceil(topPanel.getBoundingClientRect().height));
      dragging=true;
      startY=e.clientY ?? (e.touches && e.touches[0]?.clientY) ?? 0;
      startTopHeight=topH;
      document.body.style.cursor='ns-resize';
      document.body.style.userSelect='none';
      function onPointerMove(ev){
        if(!dragging) return;
        const clientY=ev.clientY ?? (ev.touches && ev.touches[0]?.clientY) ?? 0;
        let rawTop=startTopHeight + (clientY - startY);
        rawTop=Math.max(minTop, Math.min(rawTop, maxTop));
        const dpr=Math.max(1, window.devicePixelRatio||1);
        const snappedTop=(Math.round(rawTop*dpr)/dpr);
        topPanel.style.height=snappedTop.toFixed(2)+'px';
        topPanel.style.flex='0 0 auto';
        bottomPanel.style.flex='1 1 auto';
        bottomPanel.style.height='';
        if(!rafFlag){
          rafFlag=true;
            requestAnimationFrame(()=>{ rafFlag=false; syncTopTabsViewportHeight(); });
        }
      }
      function end(){
        dragging=false;
        __VERT_DRAGGING=false;
        document.body.classList.remove('is-vert-dragging');
        document.body.style.cursor='';
        document.body.style.userSelect='';
        syncTopTabsViewportHeight();
        window.removeEventListener('pointermove', onPointerMove, {capture:false});
        window.removeEventListener('pointerup', end, {capture:false});
        window.removeEventListener('pointercancel', end, {capture:false});
      }
      window.addEventListener('pointermove', onPointerMove, {passive:false});
      window.addEventListener('pointerup', end, {passive:true});
      window.addEventListener('pointercancel', end, {passive:true});
    }
    handle.addEventListener('pointerdown', onPointerDown, { passive:false });
  })();

  /* ---------------- Splitter Rails 装饰 ---------------- */
  (function initSplitterRails(){
    const sp = document.getElementById('sidebar-splitter');
    if(!sp) return;
    const svg = sp.querySelector('svg.splitter-rails');
    const topL = sp.querySelector('#sr-top-left');
    const topR = sp.querySelector('#sr-top-right');
    const botL = sp.querySelector('#sr-bot-left');
    const botR = sp.querySelector('#sr-bot-right');
    if(!svg || !topL || !topR || !botL || !botR) return;
    function updateSplitterRails(){
      const W = Math.max(0, Math.round(sp.clientWidth));
      const H = Math.max(0, Math.round(sp.clientHeight));
      const handle = document.getElementById('sidebar-splitter-handle');
      const handleW = Math.max(0, Math.round(handle ? handle.offsetWidth : 72));
      const GAP_PAD = 0;
      const gapPx = Math.min(W, handleW + 2 * GAP_PAD);
      const totalRails = Math.max(0, W - gapPx);
      const leftRail = Math.floor(totalRails / 2);
      const rightRail = totalRails - leftRail;
      const xLeftStart=0;
      const xLeftEnd=xLeftStart + leftRail;
      const xRightEnd=W;
      const xRightStart=xRightEnd - rightRail;
      const yTop=0.5;
      const yBot=(H||12)-0.5;
      topL.setAttribute('x1',xLeftStart); topL.setAttribute('y1',yTop);
      topL.setAttribute('x2',xLeftEnd);   topL.setAttribute('y2',yTop);
      topR.setAttribute('x1',xRightStart); topR.setAttribute('y1',yTop);
      topR.setAttribute('x2',xRightEnd);   topR.setAttribute('y2',yTop);
      botL.setAttribute('x1',xLeftStart); botL.setAttribute('y1',yBot);
      botL.setAttribute('x2',xLeftEnd);   botL.setAttribute('y2',yBot);
      botR.setAttribute('x1',xRightStart); botR.setAttribute('y1',yBot);
      botR.setAttribute('x2',xRightEnd);   botR.setAttribute('y2',yBot);
    }
    function raf(){ requestAnimationFrame(updateSplitterRails); }
    raf();
    window.addEventListener('resize', raf);
    window.updateSplitterRails = updateSplitterRails;
  })();

  /* ---------------- Sidebar 宽度 Resizer ---------------- */
  (function initSidebarResizer(){
    if(!resizer || !sidebar || !mainContent) return;
    const SIDEBAR_MIN_W=260, SIDEBAR_MAX_W=700;
    let dragging=false,startX=0,startW=0,rafId=null;
    function applyWidth(w){
      sidebar.style.width=w+'px';
      if(!isCollapsed){
        mainContent.style.marginLeft=w+'px';
        currentSidebarWidth=w;
        if(typeof window.updateSplitterRails==='function') window.updateSplitterRails();
      }
    }
    function dragStart(x){
      dragging=true;
      startX=x;
      startW=sidebar.getBoundingClientRect().width;
      document.body.classList.add('resizing-sidebar','sidebar-hdragging');
      document.body.style.userSelect='none';
    }
    function dragMove(x){
      if(!dragging) return;
      const dx=x-startX;
      let newW=startW+dx;
      newW=Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W,newW));
      if(!rafId){
        rafId=requestAnimationFrame(()=>{ applyWidth(newW); rafId=null; });
      }
    }
    function dragEnd(){
      dragging=false;
      document.body.classList.remove('resizing-sidebar','sidebar-hdragging');
      document.body.style.userSelect='';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('pointermove', onPtrMove);
      window.removeEventListener('pointerup', onPtrUp);
      window.removeEventListener('pointercancel', onPtrUp);
      setTimeout(()=>{ if(window.resizeChart) window.resizeChart(); },120);
      scheduleAdjust();
    }
    function onMouseMove(e){ if(e.cancelable) e.preventDefault(); dragMove(e.clientX); }
    function onMouseUp(){ dragEnd(); }
    resizer.addEventListener('mousedown', e=>{
      if(isCollapsed) return;
      if(document.documentElement.classList.contains('sidebar-overlay-mode')) return;
      e.preventDefault();
      dragStart(e.clientX);
      document.addEventListener('mousemove', onMouseMove, { passive:false });
      document.addEventListener('mouseup',   onMouseUp,   { passive:true  });
    });
    function onPtrMove(e){ if(!dragging) return; if(e.cancelable) e.preventDefault(); dragMove(e.clientX); }
    function onPtrUp(){ dragEnd(); }
    resizer.addEventListener('pointerdown', e=>{
      if(isCollapsed) return;
      if(document.documentElement.classList.contains('sidebar-overlay-mode')) return;
      if(e.pointerType!=='touch' && e.pointerType!=='pen') return;
      e.preventDefault();
      dragStart(e.clientX);
      window.addEventListener('pointermove', onPtrMove, { passive:false });
      window.addEventListener('pointerup', onPtrUp,     { passive:true  });
      window.addEventListener('pointercancel', onPtrUp, { passive:true  });
    });
  })();

  /* ---------------- 跑马灯 ---------------- */
  function prepareMarqueeCells(tbody, indexes){
    if(!tbody) return;
    const rows=Array.from(tbody.querySelectorAll('tr'));
    rows.forEach(tr=>{
      const cells=Array.from(tr.children);
      indexes.forEach(i=>{
        const td=cells[i]; if(!td) return;
        if(!td.classList.contains('marquee-cell')){
          td.classList.add('marquee-cell','nowrap');
          const inner=document.createElement('span');
          inner.className='marquee-inner';
          inner.innerHTML=td.innerHTML;
          td.innerHTML='';
          td.appendChild(inner);
        }
      });
    });
  }
  /* === PATCH RL-Fade: Restore recentLikes title fade === */
  function applyRecentLikesTitleMask() {
    const groups = document.querySelectorAll('#recentLikesList .recent-like-group');
    groups.forEach(g => {
      const titleWrap = g.querySelector('.group-header .title-wrap');
      const titleBox  = titleWrap?.querySelector('.truncate');
      if (!titleWrap || !titleBox) return;
      // 可见标题宽度（容器宽度即为可见宽度，因溢出被裁切）
      const w = Math.max(0, Math.ceil(titleBox.getBoundingClientRect().width));
      titleWrap.style.setProperty('--title-w', w + 'px');
      // 如需调渐隐长度：
      // titleWrap.style.setProperty('--fade-w', '28px');
    });
  }
  
  /* 在 rebuildRecentLikes 渲染后执行一次测量 */
  if (typeof window.rebuildRecentLikes === 'function' && !window.__RECENT_TITLE_MASK_PATCHED__) {
    window.__RECENT_TITLE_MASK_PATCHED__ = true;
    const _orig = window.rebuildRecentLikes;
    window.rebuildRecentLikes = function(list){
      _orig(list);
      requestAnimationFrame(applyRecentLikesTitleMask);
    };
  }

  function wrapMarqueeForExistingTables(){
    const queriesTbody=document.querySelector('#queries-panel tbody');
    const searchAirflowTbody=document.getElementById('searchAirflowTbody');
    const searchLikesTbody=document.getElementById('searchLikesTbody');
    if(queriesTbody) prepareMarqueeCells(queriesTbody,[1,2,3,4]);
    if(searchAirflowTbody && searchAirflowTbody.children.length>0) prepareMarqueeCells(searchAirflowTbody,[0,1,2,3]);
    if(searchLikesTbody && searchLikesTbody.children.length>0) prepareMarqueeCells(searchLikesTbody,[0,1,2,3]);
  }
  const TABLE_SCROLL_SPEED=60;
  function startRowMarquee(tr){
    tr.querySelectorAll('.marquee-cell .marquee-inner').forEach(inner=>{
      const td=inner.parentElement;
      const delta=inner.scrollWidth - td.clientWidth;
      if(delta>6){
        const duration=(delta/TABLE_SCROLL_SPEED).toFixed(2);
        inner.style.transition=`transform ${duration}s linear`;
        inner.style.transform=`translateX(-${delta}px)`;
      }
    });
  }
  function stopRowMarquee(tr){
    tr.querySelectorAll('.marquee-cell .marquee-inner').forEach(inner=>{
      inner.style.transition='transform .35s ease';
      inner.style.transform='translateX(0)';
    });
  }
  document.addEventListener('mouseenter', e=>{
    const tr=e.target.closest && e.target.closest('#right-panel-wrapper .ranking-table tbody tr');
    if(!tr) return;
    startRowMarquee(tr);
  }, true);
  document.addEventListener('mouseleave', e=>{
    const tr=e.target.closest && e.target.closest('#right-panel-wrapper .ranking-table tbody tr');
    if(!tr) return;
    stopRowMarquee(tr);
  }, true);

  function prepareSidebarMarquee(){
    document.querySelectorAll('#sidebar .fan-item .truncate').forEach(c=>{
      if(c.querySelector('.sidebar-marquee-inner')) return;
      const inner=document.createElement('span');
      inner.className='sidebar-marquee-inner';
      inner.innerHTML=c.innerHTML;
      c.innerHTML='';
      c.appendChild(inner);
    });
  }
  const SIDEBAR_SCROLL_SPEED=60;
  function startSidebarMarquee(row){
    const container=row.querySelector('.truncate');
    const inner=row.querySelector('.sidebar-marquee-inner');
    if(!container||!inner) return;
    const delta=inner.scrollWidth - container.clientWidth;
    if(delta>6){
      const duration=(delta/SIDEBAR_SCROLL_SPEED).toFixed(2);
      inner.style.transition=`transform ${duration}s linear`;
      inner.style.transform=`translateX(-${delta}px)`;
    }
  }
  function stopSidebarMarquee(row){
    const inner=row.querySelector('.sidebar-marquee-inner');
    if(!inner) return;
    inner.style.transition='transform .35s ease';
    inner.style.transform='translateX(0)';
  }
  document.addEventListener('mouseenter', e=>{
    const row=e.target.closest && e.target.closest('#sidebar .fan-item');
    if(!row) return;
    startSidebarMarquee(row);
  }, true);
  document.addEventListener('mouseleave', e=>{
    const row=e.target.closest && e.target.closest('#sidebar .fan-item');
    if(!row) return;
    stopSidebarMarquee(row);
  }, true);

  function prepareRecentLikesMarquee(){
    document.querySelectorAll('#recentLikesList .scenario-row .scenario-text').forEach(c=>{
      if(c.querySelector('.recent-marquee-inner')) return;
      const inner=document.createElement('span');
      inner.className='recent-marquee-inner';
      inner.textContent=c.textContent;
      c.textContent='';
      c.appendChild(inner);
    });
  }
  const RECENT_LIKES_SCROLL_SPEED=60;
  function startRecentLikesMarquee(row){
    const container=row.querySelector('.scenario-text');
    const inner=row.querySelector('.recent-marquee-inner');
    if(!container||!inner) return;
    const delta=inner.scrollWidth - container.clientWidth;
    if(delta>6){
      const duration=(delta/RECENT_LIKES_SCROLL_SPEED).toFixed(2);
      inner.style.transition=`transform ${duration}s linear`;
      inner.style.transform=`translateX(-${delta}px)`;
    }
  }
  function stopRecentLikesMarquee(row){
    const inner=row.querySelector('.recent-marquee-inner');
    if(!inner) return;
    inner.style.transition='transform .35s ease';
    inner.style.transform='translateX(0)';
  }
  document.addEventListener('mouseenter', e=>{
    const row=e.target.closest && e.target.closest('#recentLikesList .scenario-row');
    if(!row) return;
    startRecentLikesMarquee(row);
  }, true);
  document.addEventListener('mouseleave', e=>{
    const row=e.target.closest && e.target.closest('#recentLikesList .scenario-row');
    if(!row) return;
    stopRecentLikesMarquee(row);
  }, true);

  function refreshMarquees(){
    prepareSidebarMarquee();
    wrapMarqueeForExistingTables();
    prepareRecentLikesMarquee();
  }
  refreshMarquees();

  /* ---------------- Right Subseg Seg relocation ---------------- */
  function initRightSubsegSegs(){
    const container = document.getElementById('rightSubsegContainer');
    if(!container) return;
    const topSeg = document.querySelector('#top-queries-pane .seg');
    const searchSeg = document.querySelector('#search-results-pane .seg');
    if(topSeg){
      topSeg.id='segTopQueries';
      topSeg.dataset.paneId='top-queries-pane';
      if(topSeg.parentElement !== container) container.appendChild(topSeg);
    }
    if(searchSeg){
      searchSeg.id='segSearchResults';
      searchSeg.dataset.paneId='search-results-pane';
      if(searchSeg.parentElement !== container) container.appendChild(searchSeg);
    }
    [topSeg, searchSeg].forEach(seg=>{
      if(!seg) return;
      const btns=seg.querySelectorAll('.seg-btn');
      if(!btns.length) return;
      if(!seg.getAttribute('data-active')){
        btns.forEach((b,i)=>b.classList.toggle('is-active', i===0));
        const firstTarget=btns[0].dataset.target;
        seg.setAttribute('data-active', firstTarget||'');
        const paneId=seg.dataset.paneId;
        const pane = paneId?document.getElementById(paneId):null;
        if(pane){
          pane.querySelectorAll('.rank-panel').forEach(p=>{
            p.classList.toggle('active', p.id===firstTarget);
          });
        }
      }
    });
  }
  initRightSubsegSegs();

  /* ---------------- Tabs / Seg ---------------- */
  function updateRightSubseg(activeRightTab){
    const segQueries = document.getElementById('segTopQueries');
    const segSearch  = document.getElementById('segSearchResults');
    if(segQueries) segQueries.style.display = (activeRightTab === 'top-queries') ? 'inline-flex':'none';
    if(segSearch)  segSearch.style.display  = (activeRightTab === 'search-results') ? 'inline-flex':'none';
  }

  function activateTab(group, tabName, animate=false){
    if(group==='sidebar-top'){
      const nav=document.querySelector('.tab-nav[data-tab-group="sidebar-top"]');
      if(nav){
        nav.querySelectorAll('.tab-nav-item').forEach(it=>{
          it.classList.toggle('active', it.dataset.tab===tabName);
        });
      }
      localStorage.setItem('activeTab_sidebar-top', tabName);
      if(tabName==='recent-liked' && typeof window.loadRecentLikesIfNeeded==='function'){
        window.loadRecentLikesIfNeeded();
      }
      return;
    }
    if(group==='left-panel'){
      const nav=document.querySelector('.tab-nav[data-tab-group="left-panel"]');
      const container=document.getElementById('left-panel-container');
      if(!nav||!container) return;
      const items=[...nav.querySelectorAll('.tab-nav-item')];
      let idx=items.findIndex(i=>i.dataset.tab===tabName);
      if(idx<0){ idx=0; tabName=items[0]?.dataset.tab||''; }
      items.forEach((it,i)=>it.classList.toggle('active', i===idx));
      const left=container.clientWidth*idx;
      if(animate) container.scrollTo({ left, behavior:'smooth' }); else container.scrollLeft=left;
      localStorage.setItem('activeTab_left-panel', tabName);
      return;
    }
    if(group==='right-panel'){
      const nav=document.querySelector('.tab-nav[data-tab-group="right-panel"]');
      const wrapper=document.getElementById('right-panel-wrapper');
      if(!nav||!wrapper) return;
      const items=[...nav.querySelectorAll('.tab-nav-item')];
      if(!animate) tabName = tabName || items[0]?.dataset.tab;
      let idx=items.findIndex(i=>i.dataset.tab===tabName);
      if(idx<0){ idx=0; tabName=items[0]?.dataset.tab||''; }
      items.forEach((it,i)=>it.classList.toggle('active', i===idx));
      const percent=idx*50;
      if(!animate) wrapper.style.transition='none';
      wrapper.style.transform=`translateX(-${percent}%)`;
      if(!animate) setTimeout(()=>wrapper.style.transition='',50);
      updateRightSubseg(tabName);
      return;
    }
  }

  ['left-panel','right-panel','sidebar-top'].forEach(group=>{
    const saved=localStorage.getItem('activeTab_'+group);
    const first=document.querySelector(`.tab-nav[data-tab-group="${group}"] .tab-nav-item`)?.dataset.tab;
    activateTab(group, saved || first || '', false);
  });

  document.addEventListener('click', e=>{
    const item=e.target.closest && e.target.closest('.tab-nav .tab-nav-item');
    if(!item) return;
    const nav=item.closest('.tab-nav');
    const group=nav?.dataset?.tabGroup;
    if(!group || group==='sidebar-top') return;
    activateTab(group, item.dataset.tab, true);
  });

  document.addEventListener('click', e=>{
    const btn=e.target.closest && e.target.closest('.seg-btn');
    if(!btn) return;
    const seg=btn.closest('.seg'); if(!seg) return;
    const target=btn.dataset.target;
    const paneId=seg.dataset.paneId;
    const pane=paneId?document.getElementById(paneId):null;
    seg.querySelectorAll('.seg-btn').forEach(b=>b.classList.toggle('is-active', b===btn));
    seg.setAttribute('data-active', target||'');
    if(pane){
      pane.querySelectorAll('.rank-panel').forEach(p=>p.classList.toggle('active', p.id===target));
    }
    if(target==='likes-panel' && typeof window.loadLikesIfNeeded==='function'){
      window.loadLikesIfNeeded();
    }
  });

  (function initRightSegSwitchLikeXAxis(){
    const segs=document.querySelectorAll('#rightSubsegContainer .seg');
    if(!segs.length) return;
    segs.forEach(seg=>{
      const thumb=seg.querySelector('.seg-thumb');
      const btns=seg.querySelectorAll('.seg-btn');
      if(!thumb || btns.length!==2) return;
      let dragging=false,startX=0,basePercent=0,lastPercent=0;
      function activeIsRight(){ return (seg.getAttribute('data-active')||'').endsWith('likes-panel'); }
      function pointInThumb(x,y){ const r=thumb.getBoundingClientRect(); return x>=r.left && x<=r.right && y>=r.top && y<=r.bottom; }
      function start(e){
        const cx=(e.touches?e.touches[0].clientX:e.clientX)||0;
        const cy=(e.touches?e.touches[0].clientY:e.clientY)||0;
        if(!pointInThumb(cx,cy)) return;
        dragging=true;
        startX=cx;
        basePercent=activeIsRight()?100:0;
        lastPercent=basePercent;
        thumb.style.transition='none';
        if(e.cancelable) e.preventDefault();
      }
      function move(e){
        if(!dragging) return;
        const cx=(e.touches?e.touches[0].clientX:e.clientX)||0;
        const dx=cx-startX;
        const w=thumb.getBoundingClientRect().width||1;
        let percent=basePercent + (dx / w)*100;
        percent=Math.max(0, Math.min(100, percent));
        lastPercent=percent;
        thumb.style.transform=`translateX(${percent}%)`;
        if(e.cancelable) e.preventDefault();
      }
      function end(){
        if(!dragging) return;
        dragging=false;
        const goRight=lastPercent>=50;
        const targetBtn=goRight?btns[1]:btns[0];
        thumb.style.transition='';
        thumb.style.transform='';
        targetBtn.click();
      }
      seg.addEventListener('mousedown', start);
      document.addEventListener('mousemove', move, { passive:false });
      document.addEventListener('mouseup', end);
      seg.addEventListener('touchstart', start, { passive:false });
      document.addEventListener('touchmove', move, { passive:false });
      document.addEventListener('touchend', end);
    });
  })();

  (function initSidebarTopSnap(){
    const container=document.getElementById('sidebar-top-container');
    const nav=document.querySelector('.tab-nav[data-tab-group="sidebar-top"]');
    if(!container||!nav) return;
    const tabs=[...nav.querySelectorAll('.tab-nav-item')];
    function go(idx){
      const w=container.clientWidth || 1;
      container.scrollTo({ left: w*idx, behavior:'smooth' });
    }
    nav.addEventListener('click', e=>{
      const item=e.target.closest('.tab-nav-item');
      if(!item) return;
      const idx=tabs.indexOf(item);
      if(idx<0) return;
      go(idx);
      tabs.forEach((t,i)=>t.classList.toggle('active', i===idx));
      activateTab('sidebar-top', item.dataset.tab, false);
    });
    container.addEventListener('scroll', ()=>{
      clearTimeout(container._snapTimer);
      container._snapTimer=setTimeout(()=>{
        const w=container.clientWidth||1;
        const idx=Math.round(container.scrollLeft / w);
        tabs.forEach((t,i)=>t.classList.toggle('active', i===idx));
        const tabName=tabs[idx]?.dataset.tab;
        if(tabName) activateTab('sidebar-top', tabName, false);
      },80);
    });
    const saved=localStorage.getItem('activeTab_sidebar-top');
    let idx=0;
    if(saved){
      const found=tabs.findIndex(t=>t.dataset.tab===saved);
      if(found>=0) idx=found;
    }
    requestAnimationFrame(()=>{
      container.scrollLeft=container.clientWidth*idx;
      tabs.forEach((t,i)=>t.classList.toggle('active', i===idx));
      syncTopTabsViewportHeight();
    });
  })();

  /* ---------------- Tooltip ---------------- */
  const tooltip=(function initGlobalTooltip(){
    const MARGIN=8;
    let tip=null,currAnchor=null,hideTimer=null;
    function ensureTip(){
      if(tip) return tip;
      tip=document.createElement('div');
      tip.id='appTooltip';
      document.body.appendChild(tip);
      return tip;
    }
    function setText(html){ ensureTip().innerHTML=html; }
    function placeAround(anchor, preferred='top'){
      const t=ensureTip();
      const rect=anchor.getBoundingClientRect();
      const vw=window.innerWidth, vh=window.innerHeight;
      t.style.visibility='hidden'; t.dataset.show='1'; t.style.left='-9999px'; t.style.top='-9999px';
      const tw=t.offsetWidth, th=t.offsetHeight;
      let placement=preferred;
      const topSpace=rect.top;
      const bottomSpace=vh-rect.bottom;
      if(preferred==='top' && topSpace < th+12) placement='bottom';
      if(preferred==='bottom' && bottomSpace < th+12) placement='top';
      let cx=rect.left + rect.width/2;
      cx=Math.max(MARGIN+tw/2, Math.min(vw - MARGIN - tw/2, cx));
      const top=(placement==='top')? rect.top - th - 10 : rect.bottom + 10;
      t.dataset.placement=placement;
      t.style.left=`${Math.round(cx)}px`;
      t.style.top =`${Math.round(top)}px`;
      t.style.visibility='';
    }
    function show(anchor){
      clearTimeout(hideTimer);
      currAnchor=anchor;
      const txt=anchor.getAttribute('data-tooltip') || anchor.getAttribute('title') || '';
      if(anchor.hasAttribute('title')){
        anchor.setAttribute('data-title', anchor.getAttribute('title'));
        anchor.removeAttribute('title');
      }
      setText(txt);
      placeAround(anchor, anchor.getAttribute('data-tooltip-placement')||'top');
      ensureTip().dataset.show='1';
    }
    function hide(immediate=false){
      const t=ensureTip();
      const doHide=()=>{ t.dataset.show='0'; currAnchor=null; };
      if(immediate) return doHide();
      hideTimer=setTimeout(doHide,60);
    }
    document.addEventListener('mouseenter', e=>{
      let node=e.target;
      if(node && node.nodeType!==1) node=node.parentElement;
      if(!node) return;
      let el=null;
      if(node && typeof node.closest==='function'){
        try { el=node.closest('[data-tooltip]'); } catch(_){}
      }
      if(!el) el=window.safeClosest? window.safeClosest(node,'[data-tooltip]'):null;
      if(!el) return;
      show(el);
    }, true);
    document.addEventListener('mouseleave', e=>{
      let node=e.target;
      if(node && node.nodeType!==1) node=node.parentElement;
      if(!node) return;
      let el=null;
      if(node && typeof node.closest==='function'){
        try { el=node.closest('[data-tooltip]'); } catch(_){}
      }
      if(!el) el=window.safeClosest? window.safeClosest(node,'[data-tooltip]'):null;
      if(!el) return;
      hide(false);
    }, true);
    document.addEventListener('focusin', e=>{
      const el=window.safeClosest? window.safeClosest(e.target,'[data-tooltip]') : null;
      if(!el) return;
      show(el);
    });
    document.addEventListener('focusout', e=>{
      const el=window.safeClosest? window.safeClosest(e.target,'[data-tooltip]') : null;
      if(!el) return;
      hide(false);
    });
    function refreshTooltip(){
      if(currAnchor && document.body.contains(currAnchor)){
        placeAround(currAnchor, currAnchor.getAttribute('data-tooltip-placement')||'top');
      }
    }
    window.addEventListener('resize', refreshTooltip);
    window.addEventListener('scroll', refreshTooltip, true);
    return { refreshTooltip };
  })();

  /* ---------------- 公共 API 暴露 ---------------- */
  const api={
    toggleSidebar,
    openSidebar,
    closeSidebar,
    ensureGestureZone,
    scheduleAdjust,
    applyAutoBottomHeight,
    refreshMarquees,
    refreshTooltip: tooltip.refreshTooltip,
    a11y:{
      focusTrapActivate:a11yFocusTrap.activate,
      focusTrapDeactivate:a11yFocusTrap.deactivate
    },
    tabs:{ activate:activateTab }
  };
  window.__APP.layout = api;

  /* ---------------- 兼容旧全局 ---------------- */
  window.overlayOpenSidebar = openSidebar;
  window.overlayCloseSidebar = closeSidebar;
  window.overlayToggleSidebar = toggleSidebar;
  window.ensureGestureZone = ensureGestureZone;
  window.scheduleAdjust = scheduleAdjust;
  window.adjustBottomPanelAuto = applyAutoBottomHeight;
  window.a11yFocusTrap = {
    activate: a11yFocusTrap.activate,
    deactivate: a11yFocusTrap.deactivate
  };
  window.activateTab = activateTab;

  if(sidebar){
    currentSidebarWidth = sidebar.getBoundingClientRect().width;
    isCollapsed = sidebar.classList.contains('collapsed');
  }
  requestAnimationFrame(()=>{
    scheduleAdjust();
    syncTopTabsViewportHeight();
    const activeRight = document.querySelector('.tab-nav[data-tab-group="right-panel"] .tab-nav-item.active')?.dataset.tab;
    if(activeRight) updateRightSubseg(activeRight);
  });

  window.addEventListener('resize', ()=>{
    scheduleAdjust();
    if(!isCollapsed && typeof window.resizeChart === 'function') window.resizeChart();
    syncTopTabsViewportHeight();
  });

})();