// ============================================================
//  UltraNote Lite — Editor extras
//  Adds rich editing affordances without touching app.js plumbing.
//
//  Features added here:
//    1. Wiki-link autocomplete    [[ -> popup of fuzzy-matched titles
//    2. Slash commands             / at start of a line -> snippet menu
//    3. List/Markdown niceties     Tab indent, Enter continues list,
//                                  auto-pair (** _ ` [ (), Alt+Up/Down
//                                  move line, Ctrl+D duplicate line
//    4. Smart paste                URL on selection -> [sel](url);
//                                  bare URL paste  -> [domain](url)
//    5. Focus mode                 F11 inside the editor -> distraction-
//                                  free layout (no nav, centered column)
//    6. Backlinks panel            Auto-renders "Mentioned in (N)" below
//                                  the Linked Notes section of a note,
//                                  scanning every note's content for
//                                  [[This Note Title]].
//
//  This file is safe to delete: removing the <script> tag reverts all
//  features. It never mutates db directly except via createNote() which
//  is the same path the rest of the app uses.
// ============================================================
(function () {
  'use strict';

  // ---------- shared helpers ----------
  const TEXTAREA_IDS = ['contentBox', 'pgContent', 'dailyContent', 'dailyNewContent'];
  function isManagedTextarea(el) {
    return el && el.tagName === 'TEXTAREA' && TEXTAREA_IDS.includes(el.id);
  }
  function htmlesc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fireInput(ta) {
    try { ta.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
  }
  function getLineBounds(ta) {
    const v = ta.value, p = ta.selectionStart;
    const start = v.lastIndexOf('\n', p - 1) + 1;
    let end = v.indexOf('\n', p);
    if (end === -1) end = v.length;
    return { start, end, line: v.slice(start, end) };
  }
  function fuzzy(hay, needle) {
    if (!needle) return 1;
    hay = hay.toLowerCase(); needle = needle.toLowerCase();
    if (hay.startsWith(needle)) return 1000 - needle.length;
    if (hay.includes(needle))   return 800 - hay.indexOf(needle);
    let hi = 0, ni = 0, last = -1, first = -1;
    while (hi < hay.length && ni < needle.length) {
      if (hay[hi] === needle[ni]) {
        if (first === -1) first = hi;
        last = hi; ni++;
      }
      hi++;
    }
    if (ni < needle.length) return -1;
    return 400 - (last - first);
  }

  // ---------- caret position in textarea (approx, using a mirror div) ----------
  // Returns {left, top, height} in viewport coordinates for the current caret.
  function getCaretRect(ta) {
    const rect = ta.getBoundingClientRect();
    const style = window.getComputedStyle(ta);
    const mirror = document.createElement('div');
    const props = [
      'boxSizing','width','height','overflowX','overflowY','borderTopWidth','borderRightWidth',
      'borderBottomWidth','borderLeftWidth','paddingTop','paddingRight','paddingBottom','paddingLeft',
      'fontFamily','fontSize','fontWeight','fontStyle','letterSpacing','lineHeight','textTransform',
      'whiteSpace','wordSpacing','tabSize','textIndent','wordWrap'
    ];
    props.forEach(p => { mirror.style[p] = style[p]; });
    mirror.style.position = 'absolute';
    mirror.style.visibility = 'hidden';
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.wordWrap = 'break-word';
    mirror.style.top = '0';
    mirror.style.left = '-9999px';
    const value = ta.value.slice(0, ta.selectionStart);
    mirror.textContent = value;
    const span = document.createElement('span');
    span.textContent = '\u200b';
    mirror.appendChild(span);
    document.body.appendChild(mirror);
    const offsetX = span.offsetLeft - ta.scrollLeft;
    const offsetY = span.offsetTop  - ta.scrollTop;
    const lineH = parseFloat(style.lineHeight) || (parseFloat(style.fontSize) * 1.4);
    document.body.removeChild(mirror);
    return {
      left:   rect.left + offsetX,
      top:    rect.top  + offsetY,
      height: lineH
    };
  }

  // ============================================================
  // 1. Floating popup primitive (shared by [[ autocomplete + / menu)
  // ============================================================
  let popupEl = null, popupItems = [], popupActive = 0, popupCtx = null;
  function ensurePopup() {
    if (popupEl) return;
    popupEl = document.createElement('div');
    popupEl.className = 'ed-popup';
    popupEl.setAttribute('role', 'listbox');
    document.body.appendChild(popupEl);
  }
  function showPopup(items, ctx) {
    ensurePopup();
    popupItems = items;
    popupActive = 0;
    popupCtx = ctx; // { type, ta, anchorRect, onPick }
    renderPopup();
    positionPopup(ctx.anchorRect);
    popupEl.classList.add('show');
  }
  function hidePopup() {
    if (popupEl) popupEl.classList.remove('show');
    popupItems = []; popupCtx = null;
  }
  function isPopupOpen() {
    return popupEl && popupEl.classList.contains('show');
  }
  function renderPopup() {
    if (!popupItems.length) {
      popupEl.innerHTML = `<div class="ed-popup-empty">No matches — Esc to dismiss</div>`;
      return;
    }
    popupEl.innerHTML = popupItems.map((it, i) => `
      <div class="ed-popup-item${i === popupActive ? ' active' : ''}" data-i="${i}">
        <span class="ed-popup-label">${htmlesc(it.label)}</span>
        ${it.hint ? `<span class="ed-popup-hint">${htmlesc(it.hint)}</span>` : ''}
      </div>
    `).join('');
    popupEl.querySelectorAll('.ed-popup-item').forEach(el => {
      el.onmouseenter = () => setPopupActive(+el.dataset.i);
      el.onmousedown  = (e) => { e.preventDefault(); pickPopup(+el.dataset.i); };
    });
  }
  function setPopupActive(i) {
    popupActive = Math.max(0, Math.min(popupItems.length - 1, i));
    popupEl.querySelectorAll('.ed-popup-item').forEach((el, idx) => {
      el.classList.toggle('active', idx === popupActive);
      if (idx === popupActive) el.scrollIntoView({ block: 'nearest' });
    });
  }
  function pickPopup(i) {
    if (i != null) setPopupActive(i);
    const it = popupItems[popupActive];
    if (!it || !popupCtx) { hidePopup(); return; }
    const onPick = popupCtx.onPick;
    hidePopup();
    try { onPick(it); } catch (e) { console.warn('[editor-extras] pick failed', e); }
  }
  function positionPopup(rect) {
    const w = 340, h = Math.min(280, popupEl.scrollHeight || 280);
    let left = rect.left;
    let top  = rect.top + rect.height + 4;
    if (left + w > window.innerWidth - 8)  left = window.innerWidth - w - 8;
    if (top  + h > window.innerHeight - 8) top  = rect.top - h - 4; // flip up
    if (left < 8) left = 8;
    if (top  < 8) top  = 8;
    popupEl.style.left = left + 'px';
    popupEl.style.top  = top  + 'px';
    popupEl.style.width = w + 'px';
    popupEl.style.maxHeight = h + 'px';
  }

  // ============================================================
  // 2. [[ wiki-link autocomplete
  // ============================================================
  // Detects [[ + query immediately before the caret and shows a list
  // of matching note titles. On pick, replaces the query with the title
  // and closes the [[.
  function detectWikiContext(ta) {
    const v = ta.value, p = ta.selectionStart;
    // look back up to 120 chars for the most recent unclosed [[
    const start = Math.max(0, p - 120);
    const slice = v.slice(start, p);
    // Capture title part and (optional) alias part separately so we can
    // suggest titles even after the user types `|aliasText`.
    const m = slice.match(/\[\[([^\[\]\n|]*)(\|[^\[\]\n]*)?$/);
    if (!m) return null;
    const titleQ = m[1];
    const aliasPart = m[2] || ''; // includes leading '|'
    return {
      from: start + m.index + 2,           // first char after '[['
      to: p,                                // caret position
      query: titleQ,
      aliasPart                             // e.g. '|short name' or ''
    };
  }
  function rankNoteTitles(query) {
    const db = window.db; if (!db || !db.notes) return [];
    const seen = new Set();
    const items = [];
    db.notes.forEach(n => {
      if (n.deletedAt) return;
      const title = n.title || '';
      if (!title) return;
      const key = title.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      const s = fuzzy(title, query);
      if (s < 0) return;
      items.push({ label: title, hint: n.type || 'note', score: s, id: n.id });
    });
    items.sort((a, b) => b.score - a.score);
    return items.slice(0, 12);
  }
  function maybeShowWikiPopup(ta) {
    const ctx = detectWikiContext(ta);
    if (!ctx) { if (isPopupOpen() && popupCtx?.type === 'wiki') hidePopup(); return; }
    const items = rankNoteTitles(ctx.query);
    // Always offer "Create new" as a tail entry when there's a query
    if (ctx.query.trim()) {
      items.push({ label: `+ Create "${ctx.query.trim()}"`, hint: 'new note', _create: ctx.query.trim() });
    }
    if (!items.length) { hidePopup(); return; }
    const rect = getCaretRect(ta);
    showPopup(items, {
      type: 'wiki', ta,
      anchorRect: rect,
      onPick: (it) => {
        let title;
        if (it._create) title = it._create;
        else title = it.label;
        // Preserve any '|alias' fragment the user already typed
        const insert = title + (ctx.aliasPart || '');
        const before = ta.value.slice(0, ctx.from);
        const after  = ta.value.slice(ctx.to);
        const closes = after.startsWith(']]') ? '' : ']]';
        ta.value = before + insert + closes + after;
        const caret = ctx.from + insert.length + closes.length;
        ta.setSelectionRange(caret, caret);
        ta.focus();
        fireInput(ta);
      }
    });
  }

  // ============================================================
  // 3. Slash commands
  // ============================================================
  // Triggered when user types "/" at start of a line OR after a single
  // space at start of line. Shows a menu of insert snippets. Filters
  // as the user keeps typing.
  const SLASH_COMMANDS = [
    { key: 'today',    label: '/today',   hint: 'Insert today\'s date',
      insert: () => new Date().toLocaleDateString() },
    { key: 'now',      label: '/now',     hint: 'Insert current time',
      insert: () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) },
    { key: 'stamp',    label: '/stamp',   hint: 'Insert ISO timestamp',
      insert: () => new Date().toISOString() },
    { key: 'task',     label: '/task',    hint: 'Open task checkbox',     insert: () => '- [ ] ' },
    { key: 'done',     label: '/done',    hint: 'Completed checkbox',     insert: () => '- [x] ' },
    { key: 'h1',       label: '/h1',      hint: 'Heading 1',              insert: () => '# ' },
    { key: 'h2',       label: '/h2',      hint: 'Heading 2',              insert: () => '## ' },
    { key: 'h3',       label: '/h3',      hint: 'Heading 3',              insert: () => '### ' },
    { key: 'quote',    label: '/quote',   hint: 'Blockquote',             insert: () => '> ' },
    { key: 'hr',       label: '/hr',      hint: 'Horizontal rule',        insert: () => '---\n' },
    { key: 'code',     label: '/code',    hint: 'Fenced code block',
      insert: () => '```\n\n```',
      caretBack: 4 /* place caret on the empty line inside the fence */ },
    { key: 'link',     label: '/link',    hint: 'Markdown link',          insert: () => '[](url)',
      caretBack: 6 },
    { key: 'wiki',     label: '/wiki',    hint: 'Wiki-link [[ ]]',        insert: () => '[[]]',
      caretBack: 2 },
    { key: 'idea',     label: '/idea',    hint: '💡 Idea callout',        insert: () => '> 💡 ' },
    { key: 'question', label: '/question',hint: '❓ Open question',       insert: () => '> ❓ ' },
    { key: 'tldr',     label: '/tldr',    hint: 'TL;DR section',          insert: () => '**TL;DR:** ' },
    { key: 'paper',    label: '/paper',   hint: 'Research-paper outline',
      insert: () =>
`**Citation:** \n**DOI / URL:** \n\n## TL;DR\n\n## Key Ideas\n- \n\n## Method\n\n## Results\n\n## Limitations\n\n## ✨ Inspirations\n- \n\n## Open Questions\n- ` },
    { key: 'meeting',  label: '/meeting', hint: 'Meeting notes outline',
      insert: () =>
`**Date:** ${new Date().toLocaleDateString()}\n**Attendees:** \n\n## Agenda\n- \n\n## Notes\n- \n\n## Action Items\n- [ ] ` },
    { key: 'toc',      label: '/toc',     hint: 'Generate TOC from headings',
      insertContextual: (ta) => buildToc(ta.value) },
  ];
  function buildToc(text) {
    const lines = (text || '').split('\n');
    const out = [];
    lines.forEach(l => {
      const m = l.match(/^(#{1,6})\s+(.+?)\s*$/);
      if (!m) return;
      const depth = m[1].length;
      const title = m[2].replace(/[\[\]]/g, '');
      out.push('  '.repeat(Math.max(0, depth - 1)) + '- ' + title);
    });
    if (!out.length) return '_(no headings yet — add some `## Section` lines)_\n';
    return '**Contents**\n' + out.join('\n') + '\n';
  }
  function detectSlashContext(ta) {
    const v = ta.value, p = ta.selectionStart;
    const start = v.lastIndexOf('\n', p - 1) + 1;
    const lineSoFar = v.slice(start, p);
    // allow leading spaces (e.g., inside a list); slash must be the first non-space char
    const m = lineSoFar.match(/^(\s*)\/(\S*)$/);
    if (!m) return null;
    return { from: start + m[1].length, to: p, query: m[2] };
  }
  function maybeShowSlashMenu(ta) {
    const ctx = detectSlashContext(ta);
    if (!ctx) { if (isPopupOpen() && popupCtx?.type === 'slash') hidePopup(); return; }
    const q = ctx.query;
    const items = SLASH_COMMANDS
      .map(c => ({ c, s: q ? fuzzy(c.key, q) : 1 }))
      .filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map(x => ({ label: x.c.label, hint: x.c.hint, cmd: x.c }));
    if (!items.length) { hidePopup(); return; }
    const rect = getCaretRect(ta);
    showPopup(items, {
      type: 'slash', ta,
      anchorRect: rect,
      onPick: (it) => {
        const cmd = it.cmd;
        const before = ta.value.slice(0, ctx.from);
        const after  = ta.value.slice(ctx.to);
        const snippet = cmd.insertContextual ? cmd.insertContextual(ta) : cmd.insert();
        ta.value = before + snippet + after;
        const caretBack = cmd.caretBack || 0;
        const caret = ctx.from + snippet.length - caretBack;
        ta.setSelectionRange(caret, caret);
        ta.focus();
        fireInput(ta);
      }
    });
  }

  // ============================================================
  // 4. Editor niceties (Tab/Enter/auto-pair/Alt+arrow/Ctrl+D)
  // ============================================================
  const LIST_RE = /^(\s*)([-*+]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+)(.*)$/;
  function handleEnter(ta, e) {
    const { start, end, line } = getLineBounds(ta);
    if (ta.selectionStart !== ta.selectionEnd) return false;
    const m = line.match(LIST_RE);
    if (!m) return false;
    const [, indent, marker, rest] = m;
    if (!rest.trim()) {
      // empty list item -> break out of the list
      e.preventDefault();
      ta.setRangeText('', start, end, 'end');
      fireInput(ta);
      return true;
    }
    // continue list: for "1. " bump the number
    let nextMarker = marker;
    const numMatch = marker.match(/^(\d+)\.\s+$/);
    if (numMatch) nextMarker = (parseInt(numMatch[1], 10) + 1) + '. ';
    // checkbox items should reset to unchecked
    nextMarker = nextMarker.replace(/\[[xX]\]/, '[ ]');
    e.preventDefault();
    const insertion = '\n' + indent + nextMarker;
    ta.setRangeText(insertion, ta.selectionStart, ta.selectionStart, 'end');
    fireInput(ta);
    return true;
  }
  function handleTab(ta, e) {
    const s = ta.selectionStart, eSel = ta.selectionEnd;
    const v = ta.value;
    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    // multi-line selection -> indent each line
    if (s !== eSel && v.slice(s, eSel).includes('\n')) {
      e.preventDefault();
      const lineEnd = v.indexOf('\n', eSel);
      const blockEnd = lineEnd === -1 ? v.length : lineEnd;
      const block = v.slice(lineStart, blockEnd);
      let newBlock;
      if (e.shiftKey) newBlock = block.replace(/^(  |\t)/gm, '');
      else newBlock = block.replace(/^/gm, '  ');
      ta.setRangeText(newBlock, lineStart, blockEnd, 'preserve');
      ta.setSelectionRange(lineStart, lineStart + newBlock.length);
      fireInput(ta);
      return true;
    }
    // shift-tab on a single line: outdent up to 2 spaces / 1 tab
    if (e.shiftKey) {
      e.preventDefault();
      const line = v.slice(lineStart, v.indexOf('\n', s) === -1 ? v.length : v.indexOf('\n', s));
      const trimmed = line.replace(/^(  |\t)/, '');
      const removed = line.length - trimmed.length;
      ta.setRangeText(trimmed, lineStart, lineStart + line.length, 'preserve');
      ta.setSelectionRange(Math.max(lineStart, s - removed), Math.max(lineStart, eSel - removed));
      fireInput(ta);
      return true;
    }
    // plain tab: insert 2 spaces
    e.preventDefault();
    ta.setRangeText('  ', s, eSel, 'end');
    fireInput(ta);
    return true;
  }
  const PAIRS = { '{': '}', '"': '"', '`': '`', '*': '*', '_': '_' };
  function handleAutoPair(ta, e) {
    const ch = e.key;
    if (!PAIRS[ch]) return false;
    const s = ta.selectionStart, eSel = ta.selectionEnd;
    // wrap selection
    if (s !== eSel) {
      e.preventDefault();
      const sel = ta.value.slice(s, eSel);
      ta.setRangeText(ch + sel + PAIRS[ch], s, eSel, 'end');
      ta.setSelectionRange(s + 1, s + 1 + sel.length);
      fireInput(ta);
      return true;
    }
    // skip duplicate close if already there (so typing ")" doesn't double up)
    const next = ta.value[s];
    if (ch === PAIRS[ch] && next === ch) {
      e.preventDefault();
      ta.setSelectionRange(s + 1, s + 1);
      return true;
    }
    // do NOT auto-pair * or _ in the middle of a word (would interfere with normal typing)
    if ((ch === '*' || ch === '_') && /\w/.test(ta.value[s - 1] || '')) return false;
    e.preventDefault();
    ta.setRangeText(ch + PAIRS[ch], s, eSel, 'end');
    ta.setSelectionRange(s + 1, s + 1);
    fireInput(ta);
    return true;
  }
  function handleMoveLine(ta, dir) {
    const v = ta.value;
    const s = ta.selectionStart, eSel = ta.selectionEnd;
    const startL = v.lastIndexOf('\n', s - 1) + 1;
    const endL   = (v.indexOf('\n', eSel) === -1) ? v.length : v.indexOf('\n', eSel);
    const block  = v.slice(startL, endL);
    if (dir === 'up') {
      if (startL === 0) return false;
      const prevStart = v.lastIndexOf('\n', startL - 2) + 1;
      const prevLine  = v.slice(prevStart, startL - 1);
      const newVal = v.slice(0, prevStart) + block + '\n' + prevLine + v.slice(endL);
      ta.value = newVal;
      const delta = startL - prevStart;
      ta.setSelectionRange(s - delta, eSel - delta);
    } else {
      if (endL === v.length) return false;
      const nextEnd = (v.indexOf('\n', endL + 1) === -1) ? v.length : v.indexOf('\n', endL + 1);
      const nextLine = v.slice(endL + 1, nextEnd);
      const newVal = v.slice(0, startL) + nextLine + '\n' + block + v.slice(nextEnd);
      ta.value = newVal;
      const delta = nextLine.length + 1;
      ta.setSelectionRange(s + delta, eSel + delta);
    }
    fireInput(ta);
    return true;
  }
  function handleDuplicateLine(ta) {
    const v = ta.value;
    const s = ta.selectionStart, eSel = ta.selectionEnd;
    const startL = v.lastIndexOf('\n', s - 1) + 1;
    const endL   = (v.indexOf('\n', eSel) === -1) ? v.length : v.indexOf('\n', eSel);
    const block  = v.slice(startL, endL);
    const insertion = '\n' + block;
    ta.setRangeText(insertion, endL, endL, 'preserve');
    const delta = insertion.length;
    ta.setSelectionRange(s + delta, eSel + delta);
    fireInput(ta);
    return true;
  }

  // ============================================================
  // 5. Smart paste — convert URLs to markdown links
  // ============================================================
  const URL_RE = /^https?:\/\/\S+$/i;
  function smartPaste(ta, e) {
    const text = (e.clipboardData || window.clipboardData)?.getData('text');
    if (!text) return false;
    const trimmed = text.trim();
    if (!URL_RE.test(trimmed)) return false;
    const s = ta.selectionStart, eSel = ta.selectionEnd;
    e.preventDefault();
    if (s !== eSel) {
      const sel = ta.value.slice(s, eSel);
      const md = `[${sel}](${trimmed})`;
      ta.setRangeText(md, s, eSel, 'end');
    } else {
      let label;
      try {
        const u = new URL(trimmed);
        label = u.hostname.replace(/^www\./, '') + (u.pathname && u.pathname !== '/' ? u.pathname : '');
        if (label.length > 50) label = label.slice(0, 47) + '…';
      } catch (_) { label = trimmed; }
      const md = `[${label}](${trimmed})`;
      ta.setRangeText(md, s, eSel, 'end');
    }
    fireInput(ta);
    return true;
  }

  // ============================================================
  // 6. Focus mode (F11 inside the editor)
  // ============================================================
  function toggleFocusMode() {
    document.body.classList.toggle('focus-mode');
    const on = document.body.classList.contains('focus-mode');
    let btn = document.getElementById('focusExitBtn');
    if (on) {
      if (!btn) {
        btn = document.createElement('button');
        btn.id = 'focusExitBtn';
        btn.type = 'button';
        btn.title = 'Exit focus mode (Alt+F or Esc)';
        btn.textContent = '✕ Exit Focus';
        btn.onclick = () => toggleFocusMode();
        document.body.appendChild(btn);
      }
      let t = document.getElementById('qcToast');
      if (t) { t.textContent = '🎯 Focus mode — Alt+F or Esc to exit'; t.classList.add('show');
        clearTimeout(window._qcToastT);
        window._qcToastT = setTimeout(() => t.classList.remove('show'), 1800); }
    } else if (btn) {
      btn.remove();
    }
  }

  // ============================================================
  // Global key + input handlers
  // ============================================================
  document.addEventListener('input', (e) => {
    const ta = e.target;
    if (!isManagedTextarea(ta)) return;
    // Run both detectors in order: wiki first (more specific)
    const w = detectWikiContext(ta);
    if (w) { maybeShowWikiPopup(ta); return; }
    const s = detectSlashContext(ta);
    if (s) { maybeShowSlashMenu(ta); return; }
    if (isPopupOpen()) hidePopup();
  }, true);

  document.addEventListener('keydown', (e) => {
    const ta = e.target;
    if (!isManagedTextarea(ta)) {
      // Allow Alt+F focus toggling only when an editor textarea is on screen.
      // (F11 was previously used but the browser steals it for fullscreen,
      // which combined with our class toggle produced a broken-looking layout.)
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey &&
          (e.key === 'f' || e.key === 'F') &&
          TEXTAREA_IDS.some(id => document.getElementById(id))) {
        e.preventDefault(); toggleFocusMode();
      }
      return;
    }
    // ----- popup navigation has priority -----
    if (isPopupOpen()) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setPopupActive(popupActive + 1); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setPopupActive(popupActive - 1); return; }
      if (e.key === 'Enter')     { e.preventDefault(); pickPopup(); return; }
      if (e.key === 'Tab')       { e.preventDefault(); pickPopup(); return; }
      if (e.key === 'Escape')    { e.preventDefault(); hidePopup(); return; }
    }
    // Alt+F — focus mode (works inside editor too)
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey &&
        (e.key === 'f' || e.key === 'F')) {
      e.preventDefault(); toggleFocusMode(); return;
    }
    // Esc exits focus mode (only when no popup is open, handled above)
    if (e.key === 'Escape' && document.body.classList.contains('focus-mode')) {
      e.preventDefault(); toggleFocusMode(); return;
    }
    // Alt+Up/Down move line
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey &&
        (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      handleMoveLine(ta, e.key === 'ArrowUp' ? 'up' : 'down');
      return;
    }
    // Ctrl+D duplicate line (avoid browser bookmark)
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey &&
        (e.key === 'd' || e.key === 'D')) {
      e.preventDefault();
      handleDuplicateLine(ta);
      return;
    }
    if (e.key === 'Tab') { if (handleTab(ta, e)) return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (handleEnter(ta, e)) return;
    }
    if (handleAutoPair(ta, e)) return;
  }, true);

  document.addEventListener('paste', (e) => {
    const ta = e.target;
    if (!isManagedTextarea(ta)) return;
    smartPaste(ta, e);
  }, true);

  // Hide popup if user clicks outside it. We deliberately do NOT hide on
  // scroll — scrolling inside the popup itself (it has overflow-y: auto)
  // would fire that handler and dismiss the menu, making longer lists
  // un-pickable. The popup is position:fixed so it stays anchored anyway.
  document.addEventListener('mousedown', (e) => {
    if (popupEl && !popupEl.contains(e.target) && isPopupOpen()) hidePopup();
  }, true);
  window.addEventListener('resize', () => { if (isPopupOpen()) hidePopup(); });

  // ============================================================
  // Backlinks panel — auto-injects under Linked Notes
  // ============================================================
  function findBacklinks(targetTitle, targetId) {
    if (!targetTitle || !window.db) return [];
    const esc = targetTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match both [[Title]] and [[Title|alias]]; case-insensitive.
    const re = new RegExp('\\[\\[\\s*' + esc + '\\s*(\\||\\]\\])', 'i');
    const out = [];
    (window.db.notes || []).forEach(n => {
      if (n.deletedAt) return;
      if (n.id === targetId) return;
      const c = n.content || '';
      if (!re.test(c)) return;
      const match = c.match(re);
      const idx = match ? c.indexOf(match[0]) : -1;
      const snip = idx >= 0
        ? c.slice(Math.max(0, idx - 40), idx + targetTitle.length + 80).replace(/\s+/g, ' ').trim()
        : '';
      out.push({ id: n.id, title: n.title || '(untitled)', snippet: snip });
    });
    return out;
  }
  function renderBacklinks() {
    const linkedSection = document.getElementById('linkedNotesSection');
    if (!linkedSection) return;
    const noteId = window._openNoteId;
    const note = (window.db && window.db.notes || []).find(n => n.id === noteId);
    if (!note) return;
    let panel = document.getElementById('backlinksSection');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'backlinksSection';
      panel.style.marginTop = '8px';
      linkedSection.parentNode.insertBefore(panel, linkedSection.nextSibling);
    }
    // Cache key — skip work if same note + same content hash already rendered
    const sig = noteId + '\u0000' + (note.title || '') + '\u0000' + (window.db.notes||[]).length;
    if (panel.dataset.sig === sig) return;
    panel.dataset.sig = sig;
    const links = findBacklinks(note.title, note.id);
    panel.innerHTML = `
      <div class="row" style="justify-content:space-between;align-items:center;">
        <h3 style="margin:0;font-size:16px;">Mentioned in (${links.length})</h3>
        <span class="muted" style="font-size:11px;">notes containing [[${htmlesc(note.title || '')}]]</span>
      </div>
      <div class="list" style="margin-top:6px;">
        ${links.length === 0
          ? `<div class="muted" style="font-size:12px;padding:6px 0;">No backlinks yet. Reference this note in others with <code>[[${htmlesc(note.title||'')}]]</code>.</div>`
          : links.map(b => `
              <div class="row" style="justify-content:space-between;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid var(--btn-border);">
                <div style="flex:1;min-width:0;">
                  <a class="wikilink" data-id="${htmlesc(b.id)}" style="font-size:13px;cursor:pointer;">${htmlesc(b.title)}</a>
                  ${b.snippet ? `<div class="muted" style="font-size:11px;margin-top:2px;">…${htmlesc(b.snippet)}…</div>` : ''}
                </div>
              </div>
            `).join('')}
      </div>`;
    panel.querySelectorAll('a.wikilink[data-id]').forEach(a => {
      a.onclick = (ev) => {
        ev.preventDefault();
        if (typeof window.openNote === 'function') window.openNote(a.dataset.id);
      };
    });
  }
  // Render once per editor mount. We watch ONLY the #content node and only
  // react when #linkedNotesSection appears (or its parent is replaced) — not
  // on every subtree mutation (which would include our own innerHTML writes
  // and cause an infinite render loop that froze the page).
  let _lastSeenLinked = null;
  function _maybeRender() {
    const ls = document.getElementById('linkedNotesSection');
    if (ls && ls !== _lastSeenLinked) {
      _lastSeenLinked = ls;
      renderBacklinks();
    } else if (!ls) {
      _lastSeenLinked = null;
    }
  }
  const contentRoot = document.getElementById('content') || document.body;
  const bodyObs = new MutationObserver((mutations) => {
    // Cheap pre-filter: only act if a mutation added/removed nodes that
    // could plausibly contain #linkedNotesSection (i.e. element nodes).
    for (const m of mutations) {
      if (m.type !== 'childList') continue;
      if (m.addedNodes.length || m.removedNodes.length) {
        // Skip mutations originating inside our own panel
        if (m.target && m.target.id === 'backlinksSection') continue;
        _maybeRender();
        return;
      }
    }
  });
  bodyObs.observe(contentRoot, { childList: true, subtree: true });
  // Public hook for app.js to re-render after changes
  window._renderBacklinks = () => { _lastSeenLinked = null; renderBacklinks(); };

})();
