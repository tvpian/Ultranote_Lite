// ============================================================
//  UltraNote Lite — Command palette + shortcuts help (Phase 9)
//  Self-contained. Reads window.db (set by app.js) and simulates
//  nav clicks. Never mutates state. Remove this <script> tag to
//  disable entirely.
//
//  Shortcuts:
//    Ctrl/Cmd + K   → open command palette
//    ?              → open keyboard shortcut cheat-sheet
//    Esc            → close either overlay
// ============================================================
(function () {
  'use strict';

  // ---------- helpers ----------
  const isTypingTarget = (el) => {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  };

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // Simple fuzzy: every char of `needle` appears in `hay` in order.
  // Scores by tightness (smaller span = better) and prefix bonus.
  function fuzzyScore(hay, needle) {
    if (!needle) return 0;
    hay = hay.toLowerCase();
    needle = needle.toLowerCase();
    let hi = 0, ni = 0, first = -1, last = -1;
    while (hi < hay.length && ni < needle.length) {
      if (hay[hi] === needle[ni]) {
        if (first === -1) first = hi;
        last = hi;
        ni++;
      }
      hi++;
    }
    if (ni < needle.length) return -1;
    const span = last - first + 1;
    const prefixBonus = (hay.indexOf(needle) === 0) ? 50 : 0;
    const exactBonus = hay.includes(needle) ? 25 : 0;
    return 1000 - span + prefixBonus + exactBonus - first;
  }

  // ---------- 1. Command Palette ----------
  let paletteEl = null;
  let paletteInput = null;
  let paletteList = null;
  let paletteItems = [];
  let paletteActive = 0;

  function buildPalette() {
    if (paletteEl) return;
    paletteEl = document.createElement('div');
    paletteEl.className = 'cmdk-overlay';
    paletteEl.setAttribute('role', 'dialog');
    paletteEl.setAttribute('aria-modal', 'true');
    paletteEl.setAttribute('aria-label', 'Command palette');
    paletteEl.innerHTML = `
      <div class="cmdk-panel" role="document">
        <div class="cmdk-search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
          <input type="text" class="cmdk-input" placeholder="Jump to a note, task, project, or page…" aria-label="Search" autocomplete="off" spellcheck="false">
          <kbd class="cmdk-hint">esc</kbd>
        </div>
        <ul class="cmdk-list" role="listbox"></ul>
        <div class="cmdk-footer">
          <span><kbd>\u2191</kbd><kbd>\u2193</kbd> navigate</span>
          <span><kbd>\u21b5</kbd> select</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    `;
    document.body.appendChild(paletteEl);
    paletteInput = paletteEl.querySelector('.cmdk-input');
    paletteList = paletteEl.querySelector('.cmdk-list');

    // Click outside panel closes.
    paletteEl.addEventListener('click', (e) => {
      if (e.target === paletteEl) closePalette();
    });
    paletteInput.addEventListener('input', refreshPalette);
    paletteInput.addEventListener('keydown', onPaletteKey);
  }

  function gatherItems() {
    const items = [];
    // Static pages from nav.
    document.querySelectorAll('#nav [data-route]').forEach((btn) => {
      const route = btn.dataset.route;
      // Strip badge/pill text from label.
      const label = (btn.firstChild && btn.firstChild.nodeType === 3)
        ? btn.firstChild.textContent.trim()
        : btn.textContent.trim();
      items.push({
        type: 'Page',
        label: label || route,
        hint: 'Navigate',
        action: () => btn.click(),
      });
    });

    const db = window.db;
    if (db && typeof db === 'object') {
      (db.notes || []).slice(0, 500).forEach((n) => {
        items.push({
          type: 'Note',
          label: n.title || '(untitled)',
          hint: n.daily ? 'Daily note' : 'Note',
          action: () => {
            const open = window.openNote;
            if (typeof open === 'function') open(n.id);
            else simulateRoute('notes');
          },
        });
      });
      (db.projects || []).forEach((p) => {
        items.push({
          type: 'Project',
          label: p.name || '(unnamed project)',
          hint: 'Open project',
          action: () => {
            window.route = 'project:' + p.id;
            if (typeof window.render === 'function') window.render();
            else simulateRoute('projects');
          },
        });
      });
      // Pending tasks only (avoid drowning the list).
      (db.tasks || [])
        .filter((t) => !t.done)
        .slice(0, 300)
        .forEach((t) => {
          items.push({
            type: 'Task',
            label: t.title || '(untitled task)',
            hint: t.due ? ('Due ' + t.due) : 'Task',
            action: () => simulateRoute('tasks'),
          });
        });
    }
    return items;
  }

  function simulateRoute(routeId) {
    const btn = document.querySelector(`#nav [data-route="${routeId}"]`);
    if (btn) btn.click();
  }

  function refreshPalette() {
    const q = paletteInput.value.trim();
    const all = gatherItems();
    let ranked;
    if (!q) {
      // No query: show pages first, then a sample of each type.
      ranked = all
        .map((it, i) => ({ it, score: it.type === 'Page' ? 2000 - i : 100 - i }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 40);
    } else {
      ranked = all
        .map((it) => ({ it, score: fuzzyScore(it.label, q) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 40);
    }
    paletteItems = ranked.map((r) => r.it);
    paletteActive = 0;
    renderPaletteList(q);
  }

  function renderPaletteList(q) {
    if (paletteItems.length === 0) {
      paletteList.innerHTML = `<li class="cmdk-empty">No matches for "${esc(q)}"</li>`;
      return;
    }
    paletteList.innerHTML = paletteItems.map((it, i) => `
      <li class="cmdk-item${i === paletteActive ? ' is-active' : ''}" role="option" data-i="${i}" aria-selected="${i === paletteActive}">
        <span class="cmdk-type cmdk-type-${esc(it.type.toLowerCase())}">${esc(it.type)}</span>
        <span class="cmdk-label">${esc(it.label)}</span>
        <span class="cmdk-hint-text">${esc(it.hint || '')}</span>
      </li>
    `).join('');
    paletteList.querySelectorAll('.cmdk-item').forEach((li) => {
      li.addEventListener('mouseenter', () => setActive(Number(li.dataset.i)));
      li.addEventListener('click', () => executeActive());
    });
  }

  function setActive(i) {
    paletteActive = Math.max(0, Math.min(paletteItems.length - 1, i));
    const lis = paletteList.querySelectorAll('.cmdk-item');
    lis.forEach((li, idx) => {
      const on = idx === paletteActive;
      li.classList.toggle('is-active', on);
      li.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) li.scrollIntoView({ block: 'nearest' });
    });
  }

  function executeActive() {
    const it = paletteItems[paletteActive];
    if (!it) return;
    closePalette();
    try { it.action(); } catch (e) { console.warn('[palette] action failed', e); }
  }

  function onPaletteKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(paletteActive + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(paletteActive - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); executeActive(); }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  }

  function openPalette() {
    buildPalette();
    paletteEl.classList.add('is-open');
    paletteInput.value = '';
    refreshPalette();
    // requestAnimationFrame to let CSS transition catch the open state
    requestAnimationFrame(() => paletteInput.focus());
  }

  function closePalette() {
    if (paletteEl) paletteEl.classList.remove('is-open');
  }

  // ---------- 2. Shortcut Cheat Sheet ----------
  let helpEl = null;

  function buildHelp() {
    if (helpEl) return;
    helpEl = document.createElement('div');
    helpEl.className = 'shk-overlay';
    helpEl.setAttribute('role', 'dialog');
    helpEl.setAttribute('aria-modal', 'true');
    helpEl.setAttribute('aria-label', 'Keyboard shortcuts');
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
    const mod = isMac ? '\u2318' : 'Ctrl';
    helpEl.innerHTML = `
      <div class="shk-panel">
        <div class="shk-head">
          <h3>Keyboard Shortcuts</h3>
          <button class="shk-close" aria-label="Close">\u2715</button>
        </div>
        <div class="shk-grid">
          <div class="shk-row"><kbd>${mod}</kbd><kbd>K</kbd><span>Command palette — jump anywhere</span></div>
          <div class="shk-row"><kbd>${mod}</kbd><kbd>S</kbd><span>Save current note</span></div>
          <div class="shk-row"><kbd>${mod}</kbd><kbd>Shift</kbd><kbd>N</kbd><span>Quick add note</span></div>
          <div class="shk-row"><kbd>${mod}</kbd><kbd>Shift</kbd><kbd>K</kbd><span>Quick add task (to today)</span></div>
          <div class="shk-row"><kbd>?</kbd><span>Show this help</span></div>
          <div class="shk-row"><kbd>Esc</kbd><span>Close overlays / dialogs</span></div>
          <div class="shk-row"><kbd>\u2191</kbd><kbd>\u2193</kbd><span>Navigate palette results</span></div>
          <div class="shk-row"><kbd>\u21b5</kbd><span>Open selected item</span></div>
        </div>
        <div class="shk-foot">Click outside or press <kbd>Esc</kbd> to close.</div>
      </div>
    `;
    document.body.appendChild(helpEl);
    helpEl.addEventListener('click', (e) => {
      if (e.target === helpEl) closeHelp();
    });
    helpEl.querySelector('.shk-close').addEventListener('click', closeHelp);
  }

  function openHelp() {
    buildHelp();
    helpEl.classList.add('is-open');
  }
  function closeHelp() {
    if (helpEl) helpEl.classList.remove('is-open');
  }

  // ---------- 3. Global key handler ----------
  document.addEventListener('keydown', (e) => {
    // Ctrl/Cmd + K — command palette (works even from inside inputs).
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (paletteEl && paletteEl.classList.contains('is-open')) closePalette();
      else openPalette();
      return;
    }
    // Esc — close whichever overlay is open.
    if (e.key === 'Escape') {
      if (paletteEl && paletteEl.classList.contains('is-open')) closePalette();
      if (helpEl && helpEl.classList.contains('is-open')) closeHelp();
      return;
    }
    // ? — help, but only when not typing.
    if (e.key === '?' && !isTypingTarget(e.target)) {
      e.preventDefault();
      openHelp();
    }
  });

  // ---------- 4. Clear the loading skeleton once #content has real children ----------
  // app.js writes content.innerHTML on its first render(); that replaces our
  // skeleton placeholders. We also flip aria-busy off for screen readers.
  const content = document.getElementById('content');
  if (content) {
    const clearBusy = () => {
      if (content.querySelector('.skeleton-stack')) return; // still loading
      content.setAttribute('aria-busy', 'false');
      obs.disconnect();
    };
    const obs = new MutationObserver(clearBusy);
    obs.observe(content, { childList: true });
    clearBusy(); // in case render already happened
  }
})();
