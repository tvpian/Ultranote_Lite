// ============================================================
//  UltraNote Lite — UI polish (Phase 8)
//  Self-contained. Adds page-transition stagger, save toast,
//  and badge pulse without touching app.js logic.
//
//  To disable everything: just remove the <script> tag for this
//  file in index.html. No other code depends on it.
// ============================================================
(function () {
  'use strict';

  // ---------- 1. Stagger child cascade on #content re-renders ----------
  // DISABLED: this entrance animation was perceived as the page "refreshing
  // twice" on every nav (eye sees content appear, then cascade complete).
  // The save toast, badge pulse, and other polish features below are
  // unaffected. To re-enable, uncomment the block below and the matching
  // CSS in styles.css (search for 'contentEnter').
  //
  // const content = document.getElementById('content');
  // if (content) {
  //   const tagChildren = () => { ... };
  //   new MutationObserver(() => {
  //     if (document.body.classList.contains('is-routing')) tagChildren();
  //   }).observe(content, { childList: true });
  // }
  // let routingTimer = null;
  // const armRoutingFlag = () => { ... };
  // document.addEventListener('click', (e) => {
  //   const btn = e.target.closest && e.target.closest('[data-route]');
  //   if (btn) armRoutingFlag();
  // }, true);
  // armRoutingFlag();

  // ---------- 2. Save toast ----------
  // Wrap window.persistDB so every successful save flashes a small confirm
  // chip bottom-right. If persistDB doesn't exist yet (script-order race),
  // poll briefly until it does, then wrap once.
  function installSaveToast() {
    if (!window.persistDB || window.__uiPolish_saveWrapped) return;
    const original = window.persistDB;
    window.__uiPolish_saveWrapped = true;
    window.persistDB = async function () {
      const result = await original.apply(this, arguments);
      try {
        if (result === undefined || result === true ||
            (result && typeof result === 'object')) {
          showSaveToast();
        }
      } catch (e) { /* never let polish break saves */ }
      return result;
    };
  }
  let attempts = 0;
  const wrapPoll = setInterval(() => {
    attempts++;
    if (window.persistDB) { installSaveToast(); clearInterval(wrapPoll); }
    else if (attempts > 80) { clearInterval(wrapPoll); } // ~8s give-up
  }, 100);

  // Debounce the toast so a burst of saves only shows one chip.
  let toastEl = null;
  let toastTimer = null;
  function showSaveToast() {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'save-toast';
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
      toastEl.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>' +
        '<span>Saved</span>';
      document.body.appendChild(toastEl);
    }
    toastEl.classList.remove('save-toast--visible');
    // Force reflow so re-adding the class re-triggers the transition.
    void toastEl.offsetWidth;
    toastEl.classList.add('save-toast--visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toastEl) toastEl.classList.remove('save-toast--visible');
    }, 1500);
  }

  // ---------- 3. Nav badge pulse ----------
  // Tag any <span class="pill"> inside a nav button so when its text content
  // changes (e.g. task count goes from 5 → 6), it pulses softly. The pulse
  // class is removed on animationend so it can re-trigger.
  const nav = document.querySelector('nav');
  if (nav) {
    const last = new WeakMap();
    const watch = (el) => {
      last.set(el, el.textContent);
      new MutationObserver(() => {
        const prev = last.get(el);
        const now = el.textContent;
        if (prev !== now) {
          last.set(el, now);
          el.classList.remove('pulse-once');
          void el.offsetWidth;
          el.classList.add('pulse-once');
        }
      }).observe(el, { childList: true, characterData: true, subtree: true });
    };
    nav.querySelectorAll('.pill, .badge').forEach(watch);
    // Also watch for late-arriving pills (rendered after this script runs)
    new MutationObserver((muts) => {
      muts.forEach(m => m.addedNodes.forEach(n => {
        if (n.nodeType === 1) {
          if (n.matches && n.matches('.pill, .badge')) watch(n);
          n.querySelectorAll && n.querySelectorAll('.pill, .badge').forEach(watch);
        }
      }));
    }).observe(nav, { childList: true, subtree: true });
  }
})();
