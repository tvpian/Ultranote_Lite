// ============================================================
//  UltraNote Lite — Power features (Phase 11)
//
//  Self-contained. Read-mostly. Layered on top of app.js by
//  wrapping window.render / window.openNote with post-hooks.
//  Removing this <script> tag turns everything off cleanly.
//
//  Features:
//    1. Sticky "Today" bar      — top 3 incomplete tasks pinned
//                                  to the top of every page.
//    2. Reading-session timer   — floating pill that counts time
//                                  spent on a note whose status is
//                                  📖 Reading. Minutes persist to
//                                  note.readingMinutes (additive).
//    3. Note → tasks panel      — when viewing a note, list the
//                                  tasks created from / linked to it.
//    4. Daily review prompt     — when opening today's daily and
//                                  yesterday left open tasks, offer
//                                  a one-click carry-over.
// ============================================================
(function () {
  'use strict';

  // ---- tiny helpers ----------------------------------------------------
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const LS = {
    get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} },
  };
  const tk = () => (typeof window.todayKey === 'function' ? window.todayKey() : new Date().toISOString().slice(0, 10));
  const lds = (d) => (typeof window.localDateStr === 'function'
    ? window.localDateStr(d)
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  const yesterdayKey = () => { const d = new Date(); d.setDate(d.getDate() - 1); return lds(d); };

  // Hook window.render exactly once.
  function wrapRender() {
    if (typeof window.render !== 'function' || window.render.__powerWrapped) return;
    const orig = window.render;
    const wrapped = function () {
      const r = orig.apply(this, arguments);
      try { afterRender(); } catch (e) { console.warn('[power] afterRender failed', e); }
      return r;
    };
    wrapped.__powerWrapped = true;
    window.render = wrapped;
  }
  function wrapOpenNote() {
    if (typeof window.openNote !== 'function' || window.openNote.__powerWrapped) return;
    const orig = window.openNote;
    const wrapped = function (id) {
      // Stop any timer for the previous note before switching.
      stopReadingTimer(true);
      const r = orig.apply(this, arguments);
      try { afterOpenNote(id); } catch (e) { console.warn('[power] afterOpenNote failed', e); }
      return r;
    };
    wrapped.__powerWrapped = true;
    window.openNote = wrapped;
  }

  // Try to wrap immediately, and again after DOMContentLoaded just in case.
  function tryWrap() { wrapRender(); wrapOpenNote(); }
  tryWrap();
  document.addEventListener('DOMContentLoaded', tryWrap);
  window.addEventListener('load', tryWrap);

  // ====================================================================
  //  1. Sticky Today bar
  // ====================================================================
  const BAR_HIDDEN_KEY = 'powerBarHidden';

  function todayTasks() {
    const db = window.db; if (!db || !db.tasks) return [];
    const tkn = tk();
    return db.tasks.filter(t => t.status !== 'DONE' && !t.deletedAt)
      .map(t => {
        let score = 0;
        if (t.due === tkn) score += 100;
        else if (t.due && t.due < tkn) score += 80; // overdue
        if (t.priority === 'high') score += 30;
        else if (t.priority === 'low') score -= 10;
        return { t, score };
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(x => x.t);
  }

  function renderTodayBar() {
    // Don't show on the Today page itself (it already lists tasks).
    if (window.route === 'today') { removeTodayBar(); return; }
    if (LS.get(BAR_HIDDEN_KEY, '0') === '1') { removeTodayBar(); return; }
    const host = document.getElementById('content');
    if (!host) { removeTodayBar(); return; }
    const items = todayTasks();
    if (!items.length) { removeTodayBar(); return; }

    let bar = document.getElementById('powerTodayBar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'powerTodayBar';
      host.insertBefore(bar, host.firstChild);
    } else if (bar.parentNode !== host) {
      host.insertBefore(bar, host.firstChild);
    }
    const tkn = tk();
    bar.innerHTML = `
      <div class="ptb-label">📌 Today</div>
      <div class="ptb-items">
        ${items.map(t => {
          const overdue = t.due && t.due < tkn;
          return `
            <label class="ptb-item${overdue ? ' is-overdue' : ''}" title="${esc(t.title)}">
              <input type="checkbox" data-ptb-id="${esc(t.id)}">
              <span class="ptb-title" data-ptb-open="${esc(t.id)}">${esc(t.title)}</span>
              ${t.priority === 'high' ? '<span class="ptb-pri">!</span>' : ''}
              ${overdue ? `<span class="ptb-due">${esc(t.due)}</span>` : ''}
            </label>`;
        }).join('')}
      </div>
      <button class="ptb-hide" type="button" title="Hide bar (reopen via the pin icon)">×</button>
    `;
    bar.querySelectorAll('input[data-ptb-id]').forEach(cb => {
      cb.onchange = () => {
        if (typeof window.setTaskStatus === 'function') {
          window.setTaskStatus(cb.dataset.ptbId, cb.checked ? 'DONE' : 'TODO');
        }
        if (typeof window.render === 'function') window.render();
      };
    });
    bar.querySelectorAll('[data-ptb-open]').forEach(el => {
      el.onclick = (ev) => {
        ev.preventDefault();
        const tid = el.dataset.ptbOpen;
        const t = (window.db && window.db.tasks || []).find(x => x.id === tid);
        if (!t) return;
        gotoTaskSource(t);
      };
    });
    bar.querySelector('.ptb-hide').onclick = () => {
      LS.set(BAR_HIDDEN_KEY, '1');
      removeTodayBar();
      ensureShowBarHandle();
    };
  }
  function removeTodayBar() {
    const bar = document.getElementById('powerTodayBar');
    if (bar) bar.remove();
  }
  function ensureShowBarHandle() {
    if (LS.get(BAR_HIDDEN_KEY, '0') !== '1') {
      const h = document.getElementById('powerShowBar'); if (h) h.remove();
      return;
    }
    if (document.getElementById('powerShowBar')) return;
    const btn = document.createElement('button');
    btn.id = 'powerShowBar';
    btn.type = 'button';
    btn.title = 'Show pinned today tasks';
    btn.textContent = '📌';
    btn.onclick = () => {
      LS.set(BAR_HIDDEN_KEY, '0');
      btn.remove();
      renderTodayBar();
    };
    document.body.appendChild(btn);
  }

  // Navigate to whatever a task is attached to. Daily-note tasks should
  // open the Today page on that date, not the raw note editor.
  function gotoTaskSource(t) {
    if (!t) return;
    const db = window.db;
    if (t.noteId && db) {
      const n = (db.notes || []).find(x => x.id === t.noteId);
      if (n && n.type === 'daily') {
        window.selectedDailyDate = n.dateIndex || tk();
        window.route = 'today';
        if (typeof window.render === 'function') window.render();
        return;
      }
      if (n && typeof window.openNote === 'function') {
        window.openNote(t.noteId); return;
      }
    }
    if (t.projectId) {
      window.currentProjectId = t.projectId;
      window.route = 'projects';
      if (typeof window.render === 'function') window.render();
      return;
    }
    window.route = 'today';
    if (typeof window.render === 'function') window.render();
  }

  // ====================================================================
  //  2. Reading-session timer
  // ====================================================================
  const timerState = {
    noteId: null,
    startedAt: 0,          // ms timestamp of current run
    accumulatedMs: 0,      // session ms not yet flushed to note.readingMinutes
    intervalId: null,
    paused: false,
  };

  function startReadingTimer(noteId) {
    stopReadingTimer(true);
    timerState.noteId = noteId;
    timerState.startedAt = Date.now();
    timerState.accumulatedMs = 0;
    timerState.paused = false;
    buildTimerPill();
    timerState.intervalId = setInterval(tickTimer, 1000);
  }
  function stopReadingTimer(flush) {
    if (timerState.intervalId) clearInterval(timerState.intervalId);
    timerState.intervalId = null;
    if (flush) flushTimer();
    timerState.noteId = null;
    timerState.startedAt = 0;
    timerState.accumulatedMs = 0;
    timerState.paused = false;
    const pill = document.getElementById('readingTimerPill');
    if (pill) pill.remove();
  }
  function flushTimer() {
    if (!timerState.noteId) return;
    let ms = timerState.accumulatedMs;
    if (!timerState.paused && timerState.startedAt) ms += (Date.now() - timerState.startedAt);
    const wholeMinutes = Math.floor(ms / 60000);
    if (wholeMinutes <= 0) return;
    const db = window.db; if (!db) return;
    const n = (db.notes || []).find(x => x.id === timerState.noteId);
    if (!n) return;
    n.readingMinutes = (n.readingMinutes || 0) + wholeMinutes;
    if (typeof window.updateNote === 'function') {
      // updateNote will also save + sync.
      window.updateNote(n.id, { readingMinutes: n.readingMinutes });
    } else if (typeof window.save === 'function') {
      window.save();
    }
  }
  function tickTimer() {
    const pill = document.getElementById('readingTimerPill'); if (!pill) return;
    const elapsedMs = timerState.accumulatedMs + (timerState.paused || !timerState.startedAt
      ? 0
      : Date.now() - timerState.startedAt);
    const totalSec = Math.floor(elapsedMs / 1000);
    const m = Math.floor(totalSec / 60), s = totalSec % 60;
    const note = (window.db && window.db.notes || []).find(x => x.id === timerState.noteId);
    const prev = note && note.readingMinutes ? note.readingMinutes : 0;
    pill.querySelector('.rtp-time').textContent =
      `${m}m ${String(s).padStart(2, '0')}s${prev ? ` · total ${prev + m}m` : ''}`;
    // Flush a whole minute back into note.readingMinutes so it persists across crashes.
    if (m >= 1 && !timerState.paused) {
      flushTimer();
      // Reset session counters; pill keeps showing real-time delta.
      timerState.accumulatedMs = 0;
      timerState.startedAt = Date.now();
    }
  }
  function buildTimerPill() {
    let pill = document.getElementById('readingTimerPill');
    if (pill) return pill;
    pill = document.createElement('div');
    pill.id = 'readingTimerPill';
    pill.innerHTML = `
      <span class="rtp-emoji">📖</span>
      <span class="rtp-time">0m 00s</span>
      <button class="rtp-btn" data-act="pause" title="Pause / resume">⏸</button>
      <button class="rtp-btn" data-act="stop"  title="Stop &amp; save">✕</button>
    `;
    document.body.appendChild(pill);
    pill.querySelector('[data-act="pause"]').onclick = () => {
      if (timerState.paused) {
        timerState.startedAt = Date.now();
        timerState.paused = false;
        pill.querySelector('[data-act="pause"]').textContent = '⏸';
      } else {
        timerState.accumulatedMs += (Date.now() - timerState.startedAt);
        timerState.startedAt = 0;
        timerState.paused = true;
        pill.querySelector('[data-act="pause"]').textContent = '▶';
      }
    };
    pill.querySelector('[data-act="stop"]').onclick = () => stopReadingTimer(true);
    return pill;
  }
  // Persist if the user closes the tab mid-session.
  window.addEventListener('beforeunload', () => { if (timerState.noteId) flushTimer(); });

  // ====================================================================
  //  3. Note → tasks panel
  // ====================================================================
  function renderNoteTasksPanel() {
    const linked = document.getElementById('linkedNotesSection');
    if (!linked) return;
    const noteId = window._openNoteId;
    if (!noteId) return;
    const db = window.db; if (!db) return;
    const tasks = (db.tasks || []).filter(t => t.noteId === noteId && !t.deletedAt);
    let panel = document.getElementById('noteTasksSection');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'noteTasksSection';
      panel.style.marginTop = '8px';
      // Insert before backlinks if it exists, else after linked.
      const bl = document.getElementById('backlinksSection');
      if (bl) bl.parentNode.insertBefore(panel, bl);
      else linked.parentNode.insertBefore(panel, linked.nextSibling);
    }
    const sig = noteId + '\u0000' + tasks.length + '\u0000' +
      tasks.map(t => t.id + ':' + t.status).join('|');
    if (panel.dataset.sig === sig) return;
    panel.dataset.sig = sig;

    if (!tasks.length) {
      panel.innerHTML = `
        <div class="row" style="justify-content:space-between;align-items:center;">
          <h3 style="margin:0;font-size:16px;">Tasks from this note (0)</h3>
          <span class="muted" style="font-size:11px;">none yet — create one from a quick capture</span>
        </div>`;
      return;
    }
    const open = tasks.filter(t => t.status !== 'DONE');
    const done = tasks.filter(t => t.status === 'DONE');
    panel.innerHTML = `
      <div class="row" style="justify-content:space-between;align-items:center;">
        <h3 style="margin:0;font-size:16px;">Tasks from this note (${tasks.length})</h3>
        <span class="muted" style="font-size:11px;">${open.length} open · ${done.length} done</span>
      </div>
      <div class="list" style="margin-top:6px;">
        ${tasks.map(t => `
          <label class="row" style="gap:8px;align-items:flex-start;padding:4px 0;border-bottom:1px solid var(--btn-border);cursor:pointer;">
            <input type="checkbox" data-ntp-id="${esc(t.id)}" ${t.status === 'DONE' ? 'checked' : ''}>
            <span style="flex:1;font-size:13px;${t.status === 'DONE' ? 'opacity:0.55;text-decoration:line-through;' : ''}">
              ${esc(t.title)}
              ${t.due ? ` <span class="muted" style="font-size:11px;">· due ${esc(t.due)}</span>` : ''}
              ${t.priority === 'high' ? ' <span class="pill" style="font-size:10px;">!</span>' : ''}
            </span>
          </label>`).join('')}
      </div>`;
    panel.querySelectorAll('input[data-ntp-id]').forEach(cb => {
      cb.onchange = () => {
        if (typeof window.setTaskStatus === 'function') {
          window.setTaskStatus(cb.dataset.ntpId, cb.checked ? 'DONE' : 'TODO');
        }
        // Force re-render of panel + bar.
        panel.dataset.sig = '';
        renderNoteTasksPanel();
        renderTodayBar();
        // Flip the Checklist promoter badge from "→ tracked" to "✓ done".
        const fup = document.getElementById('noteFollowupsSection');
        if (fup) fup.dataset.sig = '';
        renderFollowupsPanel();
      };
    });
  }

  // ====================================================================
  //  3b. Checklist promoter — turn markdown "- [ ]" lines into real tasks
  // ====================================================================
  // Scans the open note for markdown task-list lines and renders a panel that
  // lets you promote any of them into a real db.tasks entry linked to the note
  // (noteId set, tag 'paper-followup' added). Promoted lines are detected by
  // matching task title + noteId, so re-opening the note shows them as ✓ tracked
  // instead of offering the button again.
  function renderFollowupsPanel() {
    const noteId = window._openNoteId;
    if (!noteId) return;
    const db = window.db; if (!db) return;
    const note = (db.notes || []).find(n => n.id === noteId);
    if (!note) return;

    // Skip daily notes — they already have their own task UI; we don't want
    // every Top-3 checkbox prompting promotion.
    if (note.type === 'daily') return;

    const linked = document.getElementById('linkedNotesSection');
    if (!linked) return;

    let panel = document.getElementById('noteFollowupsSection');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'noteFollowupsSection';
      panel.style.marginTop = '8px';
      // Place above the Tasks panel so the flow reads: checklist -> promoted tasks.
      const tasksPanel = document.getElementById('noteTasksSection');
      if (tasksPanel) tasksPanel.parentNode.insertBefore(panel, tasksPanel);
      else {
        const bl = document.getElementById('backlinksSection');
        if (bl) bl.parentNode.insertBefore(panel, bl);
        else linked.parentNode.insertBefore(panel, linked.nextSibling);
      }
    }

    // Read live editor content if present (so typing new checkboxes shows up
    // before saving); otherwise fall back to the saved note body.
    const box = document.getElementById('contentBox');
    const src = (box ? box.value : (note.content || '')) || '';

    const items = [];
    src.split('\n').forEach((line, idx) => {
      const m = line.match(/^\s*-\s*\[\s*([ xX])\s*\]\s*(.+?)\s*$/);
      if (!m) return;
      const text = m[2].trim();
      if (!text) return;
      items.push({ idx, checked: m[1] !== ' ', text });
    });

    if (!items.length) { panel.innerHTML = ''; panel.dataset.sig = ''; return; }

    const noteTasks = (db.tasks || []).filter(t => t.noteId === noteId && !t.deletedAt);
    const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    const matchTask = (text) => noteTasks.find(t => norm(t.title) === norm(text));

    const sig = noteId + '\u0000' + items.length + '\u0000' +
      items.map(it => (it.checked ? 'x' : 'o') + ':' + it.text).join('|') + '\u0000' +
      noteTasks.map(t => t.id + ':' + t.status).join('|');
    if (panel.dataset.sig === sig) return;
    panel.dataset.sig = sig;

    const esc = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

    const untracked = items.filter(it => !matchTask(it.text)).length;

    panel.innerHTML = `
      <div class="row" style="justify-content:space-between;align-items:center;">
        <h3 style="margin:0;font-size:16px;">Checklist in this note (${items.length})</h3>
        <span class="muted" style="font-size:11px;">${untracked} untracked · click → Task to promote</span>
      </div>
      <div class="list" style="margin-top:6px;">
        ${items.map(it => {
          const t = matchTask(it.text);
          const tracked = !!t;
          const done = tracked && t.status === 'DONE';
          const badge = tracked
            ? `<span class="pill" style="background:${done?'#4caf9e':'#8b6dff'};color:#fff;font-size:10px;margin-left:6px;">${done?'\u2713 done':'\u2192 tracked'}</span>`
            : '';
          const rowStyle = it.checked ? 'opacity:.55;text-decoration:line-through;' : '';
          return `<div class="row" style="justify-content:space-between;gap:8px;align-items:flex-start;padding:4px 0;border-bottom:1px solid var(--btn-border);">
            <span style="flex:1;font-size:13px;${rowStyle}">
              ${it.checked ? '\u2611' : '\u2610'} ${esc(it.text)} ${badge}
            </span>
            ${tracked
              ? ''
              : `<button class="btn" data-fup-promote="${it.idx}" style="font-size:11px;flex-shrink:0;" title="Create a tracked task for this line">\u2192 Task</button>`
            }
          </div>`;
        }).join('')}
      </div>
    `;

    panel.querySelectorAll('[data-fup-promote]').forEach(btn => {
      btn.onclick = () => {
        const idx = +btn.dataset.fupPromote;
        const it = items.find(x => x.idx === idx);
        if (!it) return;
        if (typeof window.createTask !== 'function') return;
        // Inherit project if the note is attached to one — keeps Review filters honest.
        const projectId = (note.projectId || null);
        window.createTask({
          title: it.text,
          noteId,
          projectId,
          priority: 'medium',
          tags: ['paper-followup'],
        });
        if (typeof window.save === 'function') window.save();
        flashToast('Promoted to tracked task');
        // Re-render this panel and the tasks panel below.
        panel.dataset.sig = '';
        renderFollowupsPanel();
        renderNoteTasksPanel();
      };
    });
  }

  // ====================================================================
  //  4. Daily review prompt — yesterday's open tasks
  // ====================================================================
  function maybeShowDailyReview() {
    if (window.route !== 'today') return;
    const sel = window.selectedDailyDate || tk();
    if (sel !== tk()) return; // only on today, not historical dates
    const dismissKey = 'reviewDismissed:' + sel;
    if (LS.get(dismissKey, '0') === '1') return;
    const db = window.db; if (!db) return;

    const ykey = yesterdayKey();
    const yDaily = (db.notes || []).find(n => n.type === 'daily' && n.dateIndex === ykey && !n.deletedAt);
    if (!yDaily) return;
    const openTasks = (db.tasks || []).filter(t =>
      t.noteId === yDaily.id && t.status !== 'DONE' && !t.deletedAt);
    if (!openTasks.length) return;

    // Anchor inside #content, prepend a banner.
    const host = document.getElementById('content'); if (!host) return;
    if (document.getElementById('dailyReviewBanner')) return; // already there

    const banner = document.createElement('div');
    banner.id = 'dailyReviewBanner';
    banner.innerHTML = ` 
      <div class="drb-head">
        🌅 <strong>Yesterday left ${openTasks.length} open task${openTasks.length === 1 ? '' : 's'}.</strong>
        <span class="muted" style="font-size:11px;">${esc(ykey)}</span>
      </div>
      <div class="drb-list">
        ${openTasks.slice(0, 5).map(t => `
          <div class="drb-item">
            • ${esc(t.title)}${t.priority === 'high' ? ' <span class="pill" style="font-size:10px;">!</span>' : ''}
          </div>`).join('')}
        ${openTasks.length > 5 ? `<div class="muted" style="font-size:11px;">…and ${openTasks.length - 5} more</div>` : ''}
      </div>
      <div class="drb-actions">
        <button class="btn" data-drb="carry">Carry over all to today</button>
        <button class="btn" data-drb="skip">Skip</button>
      </div>
    `;
    host.insertBefore(banner, host.firstChild);

    banner.querySelector('[data-drb="carry"]').onclick = () => {
      // Find / create today's daily note so we can attach.
      const todayDaily = (db.notes || []).find(n =>
        n.type === 'daily' && n.dateIndex === sel && !n.deletedAt);
      const tnoteId = todayDaily ? todayDaily.id : null;
      let created = 0;
      openTasks.forEach(t => {
        if (typeof window.createTask !== 'function') return;
        window.createTask({
          title: t.title,
          due: sel,
          noteId: tnoteId,
          projectId: t.projectId || null,
          priority: t.priority || 'medium',
          description: t.description || '',
          tags: Array.isArray(t.tags) ? t.tags.slice() : [],
        });
        created++;
      });
      LS.set(dismissKey, '1');
      banner.remove();
      if (typeof window.render === 'function') window.render();
      // tiny toast
      flashToast(`Carried over ${created} task${created === 1 ? '' : 's'}`);
    };
    banner.querySelector('[data-drb="skip"]').onclick = () => {
      LS.set(dismissKey, '1');
      banner.remove();
    };
  }
  function flashToast(msg) {
    const t = document.getElementById('qcToast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(window._qcToastT);
    window._qcToastT = setTimeout(() => t.classList.remove('show'), 1800);
  }

  // ====================================================================
  //  Post-render / post-open dispatchers
  // ====================================================================
  function afterRender() {
    // wrap openNote here too — it may have been (re)defined.
    wrapOpenNote();
    // Sticky Today bar disabled — user found it visually noisy.
    // (Code left intact below; flip the early-return to re-enable.)
    // renderTodayBar();
    // ensureShowBarHandle();
    removeTodayBar();
    const handle = document.getElementById('powerShowBar'); if (handle) handle.remove();
    // If user navigates away from the note editor, kill the timer.
    if (!document.getElementById('title') && timerState.noteId) {
      stopReadingTimer(true);
    }
  }
  function afterOpenNote(id) {
    // Defer to next tick so editor DOM exists.
    setTimeout(() => {
      renderNoteTasksPanel();
      renderFollowupsPanel();
      // Live-refresh the checklist promoter while the user types new "- [ ]" lines.
      // Debounced via rAF; bound once per editor open (the wrapped DOM element handles
      // its own listener lifecycle when the editor is rebuilt by openNote).
      const box = document.getElementById('contentBox');
      if (box && !box.__fupBound) {
        box.__fupBound = true;
        let raf = 0;
        box.addEventListener('input', () => {
          if (raf) cancelAnimationFrame(raf);
          raf = requestAnimationFrame(() => { raf = 0; renderFollowupsPanel(); });
        });
      }
      const note = (window.db && window.db.notes || []).find(n => n.id === id);
      // Read status from the dropdown if present (unsaved choices count too),
      // otherwise fall back to the saved value on the note.
      const dropdown = document.getElementById('noteStatus');
      const status = dropdown ? dropdown.value : (note ? note.status : '');
      if (status === 'reading') startReadingTimer(id);
      else stopReadingTimer(true);
    }, 0);
  }

  // Status dropdown change — react immediately (do not wait for Save).
  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'noteStatus') {
      const id = window._openNoteId;
      if (!id) return;
      const val = e.target.value;
      if (val === 'reading' && timerState.noteId !== id) {
        startReadingTimer(id);
        flashToast('📖 Reading timer started');
      } else if (val !== 'reading' && timerState.noteId === id) {
        stopReadingTimer(true);
      }
    }
  });

  // Re-render today-bar if tasks change (cheap polling-free signal: listen
  // for storage events from other tabs, plus a periodic check while visible).
  window.addEventListener('storage', (e) => {
    if (e.key && e.key.startsWith('reviewDismissed:')) return;
    renderTodayBar();
  });

  // Expose for debugging.
  window._powerFeatures = {
    renderTodayBar, renderNoteTasksPanel, renderFollowupsPanel,
    stopReadingTimer, startReadingTimer,
    showBar: () => { LS.set(BAR_HIDDEN_KEY, '0'); renderTodayBar(); },
  };
})();
