// research-mode.js — first-class Research workflow inside UltraNote Lite.
// Seeds a "🔬 Research" notebook on first boot, schedules weekly + monthly
// review rituals, and binds three shortcuts:
//   Alt+I → capture a line to 📥 Inbox
//   Alt+P → create a structured paper note
//   Alt+M → create / open a topic map for any area you choose
// Topics are intentionally NOT hard-coded — spin one up whenever you find
// yourself returning to a thread of literature.
// Idempotent: safe to load on every boot; will not duplicate notes/tasks.

(function(){
  'use strict';

  function ready(fn){
    const tryStart = () => {
      if (window.db && typeof window.save === 'function') return fn();
      setTimeout(tryStart, 200);
    };
    if (document.readyState !== 'loading') tryStart();
    else document.addEventListener('DOMContentLoaded', tryStart);
  }
  ready(init);

  // ------------------------------------------------------------------
  // Init
  // ------------------------------------------------------------------
  function init(){
    const db = window.db;
    db.settings = db.settings || {};
    // Only auto-seed on FIRST boot. Running every boot meant a user-deleted
    // system page would silently reappear; worse, it kept fighting the
    // notebook tombstone cleanup. After first seed, the user is in charge —
    // they can call window.researchRestoreScaffold() (or click the "Restore
    // system pages" link in the Research dashboard) to recreate anything
    // they removed by mistake.
    if (!db.settings.researchSeededAt) {
      try { ensureResearchScaffold(db); } catch(e){ console.error('[research-mode] seed', e); }
    }
    try { scheduleRituals(db); } catch(e){ console.error('[research-mode] rituals', e); }
    bindShortcuts();
    // Expose dashboard renderer so app.js render() can dispatch to it.
    window.renderResearch = renderResearch;
    // Expose actions so the command palette (ui-extras.js) can offer them.
    window.researchCapture       = () => openInboxCapture();
    window.researchNewPaper      = () => newPaperNote();
    window.researchNewTopicMap   = () => newOrOpenTopicMap();
    window.researchNewSynthesis  = () => newOrOpenSynthesis();
    // Manual re-seed for users who deleted a core page and want it back.
    window.researchRestoreScaffold = () => {
      try {
        ensureResearchScaffold(window.db);
        if (typeof window.toast === 'function') window.toast('Research system pages restored');
        if (window.route === 'research' && typeof window.render === 'function') window.render();
      } catch(e){ console.error('[research-mode] restore', e); }
    };
    // Reset to dashboard whenever we navigate to the route fresh (so back/forward
    // doesn't strand the user in a stale triage view).
    const _origRender = window.render;
    if (_origRender && !_origRender.__researchWrapped) {
      window.render = function(){
        if (window.route !== 'research') researchView = 'dashboard';
        return _origRender.apply(this, arguments);
      };
      window.render.__researchWrapped = true;
    }
    // Handle ?capture=... from bookmarklet
    try { handleUrlCapture(); } catch(e){ console.error('[research-mode] urlCapture', e); }
    // Listen for sibling-tab captures even when this tab wasn't the one opened
    // by the bookmarklet — this is what lets us reuse a single instance.
    try { _ensureCaptureChannel(); } catch(_){}
    // If we're already sitting on the route (e.g. SW reload), repaint now.
    if (window.route === 'research' && typeof window.render === 'function') {
      try { window.render(); } catch(_){}
    }
    console.log('[research-mode] ready');
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  const pad = n => String(n).padStart(2, '0');
  const nowISO = () => new Date().toISOString();
  const uid = () => Math.random().toString(36).slice(2, 10);
  const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; };

  function findNote(predicate){
    return (window.db.notes || []).find(n => !n.deletedAt && predicate(n));
  }

  function ensureNotebook(title){
    const db = window.db;
    db.notebooks = db.notebooks || [];
    // Skip tombstoned rows — if the user explicitly deleted a notebook with
    // this title we must NOT find-or-create on top of it; we'd just keep
    // resurrecting the same row on every boot.
    let nb = db.notebooks.find(x => x.title === title && !x.deletedAt);
    if (nb) return nb;
    nb = { id: uid(), title, description: '', createdAt: nowISO(), updatedAt: nowISO() };
    db.notebooks.push(nb);
    return nb;
  }

  function ensurePage({ title, notebookId, content = '', tags = [] }){
    const db = window.db;
    let p = findNote(n => n.notebookId === notebookId && n.title === title);
    if (p) return p;
    const pages = (db.notes || []).filter(n => n.notebookId === notebookId && !n.deletedAt && n.type === 'page');
    const maxOrder = pages.length ? Math.max(...pages.map(x => x.sortOrder || 0)) : -1;
    p = {
      id: uid(), title, content, tags, projectId: null, dateIndex: null, type: 'page',
      pinned: false, notebookId, sortOrder: maxOrder + 1,
      createdAt: nowISO(), updatedAt: nowISO(), attachments: [], links: []
    };
    db.notes.push(p);
    return p;
  }

  function isTypingInField(el){
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || el.isContentEditable;
  }

  function toast(msg){
    let t = document.getElementById('research-toast');
    if (!t) {
      t = document.createElement('div'); t.id = 'research-toast';
      Object.assign(t.style, {
        position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
        background: 'rgba(0,0,0,0.82)', color: '#fff', padding: '9px 16px',
        borderRadius: '10px', zIndex: 99999, fontSize: '13px',
        fontFamily: 'system-ui, sans-serif', pointerEvents: 'none',
        opacity: '0', transition: 'opacity .18s'
      });
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._h); t._h = setTimeout(() => { t.style.opacity = '0'; }, 1800);
  }

  // ------------------------------------------------------------------
  // Seed / self-heal notebook (runs every boot; idempotent)
  // ------------------------------------------------------------------
  // We deliberately do NOT gate on a settings flag. Running this on every
  // boot means: if the user (or sync, or a bad merge) ever drops a core
  // page, it reappears on next reload. ensurePage/ensureNotebook are
  // find-or-create, so duplicates can't happen.
  function ensureResearchScaffold(db){
    const nb = ensureNotebook('🔬 Research');
    // Mark the notebook as system so UI can warn before delete (used below).
    nb.system = true;
    ensurePage({ title: '📥 Inbox',                       notebookId: nb.id, content: INBOX_BODY,        tags: ['research', 'inbox', 'system'] });
    ensurePage({ title: '🗺️ Topic Maps — Index',         notebookId: nb.id, content: TOPIC_INDEX_BODY,  tags: ['research', 'topic-maps', 'system'] });
    ensurePage({ title: '📊 Monthly Synthesis — Template',  notebookId: nb.id, content: SYNTH_TEMPLATE,    tags: ['research', 'synthesis', 'template', 'system'] });
    ensurePage({ title: '🔁 Weekly Triage Ritual',          notebookId: nb.id, content: WEEKLY_BODY,       tags: ['research', 'ritual', 'system'] });
    ensurePage({ title: '📚 Sources & Feeds',                notebookId: nb.id, content: SOURCES_BODY,      tags: ['research', 'sources', 'system'] });
    ensurePage({ title: '🧰 Research Toolkit',               notebookId: nb.id, content: TOOLKIT_BODY,      tags: ['research', 'tools', 'system'] });
    if (!db.settings.researchSeededAt) db.settings.researchSeededAt = nowISO();
    window.save();
  }

  // ------------------------------------------------------------------
  // Recurring rituals
  // ------------------------------------------------------------------
  function scheduleRituals(db){
    db.settings.researchRituals = db.settings.researchRituals || {};
    const today = todayStr();
    const d = new Date();
    let changed = false;

    if (d.getDay() === 5) { // Friday
      const wk = isoWeekKey(d);
      if (db.settings.researchRituals.lastWeekly !== wk) {
        ensureRitualTask({ title: 'Triage research inbox (30 min)', due: today, tags: ['research', 'ritual', 'weekly'] });
        db.settings.researchRituals.lastWeekly = wk;
        changed = true;
      }
    }
    if (d.getDate() === 1) { // first of month
      const mk = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
      if (db.settings.researchRituals.lastMonthly !== mk) {
        ensureRitualTask({ title: `Write monthly research synthesis — ${mk} (1 hr)`, due: today, tags: ['research', 'ritual', 'monthly'] });
        db.settings.researchRituals.lastMonthly = mk;
        changed = true;
      }
    }
    if (changed) window.save();
  }

  function isoWeekKey(d){
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const ys = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    const wk = Math.ceil((((t - ys) / 86400000) + 1) / 7);
    return `${t.getUTCFullYear()}-W${pad(wk)}`;
  }

  function ensureRitualTask({ title, due, tags }){
    const db = window.db;
    db.tasks = db.tasks || [];
    const exists = db.tasks.some(t => !t.deletedAt && t.title === title && t.due === due);
    if (exists) return;
    db.tasks.push({
      id: uid(), title, status: 'TODO', due, noteId: null, projectId: null,
      priority: 'medium', description: '', subtasks: [], tags,
      createdAt: nowISO(), updatedAt: nowISO(), completedAt: null, deletedAt: null
    });
  }

  // ------------------------------------------------------------------
  // Shortcuts
  // ------------------------------------------------------------------
  function bindShortcuts(){
    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented) return;
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const k = (e.key || '').toLowerCase();
      if (k === 'i') {
        if (isTypingInField(e.target)) return;
        e.preventDefault(); openInboxCapture();
      } else if (k === 'p') {
        if (isTypingInField(e.target)) return;
        e.preventDefault(); newPaperNote();
      } else if (k === 'm') {
        if (isTypingInField(e.target)) return;
        e.preventDefault(); newOrOpenTopicMap();
      }
    });
  }

  // ------------------------------------------------------------------
  // Inline capture / paper / topic-map modal
  // ------------------------------------------------------------------
  //
  // One reusable overlay replaces the three native prompt() dialogs.
  // Sleek, theme-aware, multi-line, ESC-to-close, Enter-to-submit
  // (Shift+Enter = newline), and remembers focus so you can fire it
  // again immediately.

  function showInputModal({ title, placeholder, multiline = false, initial = '', confirmLabel = 'Save' }){
    return new Promise((resolve) => {
      let overlay = document.getElementById('research-modal');
      if (overlay) overlay.remove();
      overlay = document.createElement('div');
      overlay.id = 'research-modal';
      overlay.innerHTML = `
        <style>
          #research-modal{position:fixed;inset:0;z-index:99998;display:flex;align-items:flex-start;justify-content:center;
            padding-top:14vh;background:rgba(0,0,0,0.42);backdrop-filter:blur(2px);animation:rmfade .12s ease-out;}
          @keyframes rmfade{from{opacity:0}to{opacity:1}}
          #research-modal .rm-box{background:var(--card,#1a1a1a);color:var(--text,inherit);border:1px solid var(--border,#333);
            border-radius:14px;padding:18px 20px;min-width:min(560px, 92vw);max-width:92vw;box-shadow:0 18px 60px rgba(0,0,0,0.55);}
          #research-modal .rm-title{font-weight:700;font-size:15px;margin-bottom:10px;}
          #research-modal .rm-input, #research-modal .rm-textarea{width:100%;box-sizing:border-box;background:rgba(127,127,127,0.10);
            color:var(--text,inherit);border:1px solid var(--border,#333);border-radius:8px;padding:10px 12px;font-size:14px;
            font-family:inherit;outline:none;}
          #research-modal .rm-input:focus, #research-modal .rm-textarea:focus{border-color:var(--accent,#4a90e2);}
          #research-modal .rm-textarea{min-height:110px;resize:vertical;font-family:ui-monospace,Menlo,monospace;font-size:13px;}
          #research-modal .rm-hint{font-size:11px;color:var(--muted,#999);margin-top:8px;display:flex;justify-content:space-between;gap:8px;}
          #research-modal .rm-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:14px;}
          #research-modal .rm-actions button{padding:8px 14px;border-radius:8px;border:1px solid var(--border,#333);
            background:transparent;color:var(--text,inherit);font-size:13px;cursor:pointer;}
          #research-modal .rm-actions .rm-primary{background:var(--accent,#4a90e2);color:#fff;border-color:var(--accent,#4a90e2);font-weight:600;}
          #research-modal .rm-actions button:hover{filter:brightness(1.1);}
        </style>
        <div class="rm-box" role="dialog" aria-modal="true">
          <div class="rm-title">${esc(title)}</div>
          ${multiline
            ? `<textarea class="rm-textarea" placeholder="${esc(placeholder||'')}">${esc(initial||'')}</textarea>`
            : `<input class="rm-input" type="text" placeholder="${esc(placeholder||'')}" value="${esc(initial||'')}" />`}
          <div class="rm-hint">
            <span>${multiline ? 'Enter to save · Shift+Enter for newline · Esc to cancel' : 'Enter to save · Esc to cancel'}</span>
            <span class="rm-counter"></span>
          </div>
          <div class="rm-actions">
            <button class="rm-cancel">Cancel</button>
            <button class="rm-primary">${esc(confirmLabel)}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const box = overlay.querySelector('.rm-box');
      const field = overlay.querySelector(multiline ? '.rm-textarea' : '.rm-input');
      const counter = overlay.querySelector('.rm-counter');
      const updateCounter = () => { counter.textContent = field.value ? `${field.value.length}` : ''; };
      field.addEventListener('input', updateCounter);
      const done = (val) => { overlay.remove(); resolve(val); };
      overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
      overlay.querySelector('.rm-cancel').onclick = () => done(null);
      overlay.querySelector('.rm-primary').onclick = () => {
        const v = (field.value || '').trim();
        done(v || null);
      };
      field.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); done(null); }
        else if (e.key === 'Enter' && !e.shiftKey && (!multiline || !e.altKey)) {
          if (multiline && !e.metaKey && !e.ctrlKey) {
            // In multiline, plain Enter still submits (matches the hint above).
          }
          e.preventDefault();
          const v = (field.value || '').trim();
          done(v || null);
        }
      });
      setTimeout(() => { field.focus(); field.select(); updateCounter(); }, 10);
    });
  }

  async function openInboxCapture(initialText = ''){
    const text = await showInputModal({
      title: '📥 Capture to research inbox',
      placeholder: 'Paste a link, paper title, or 1-line idea…  (you can paste multiple lines)',
      multiline: true,
      initial: initialText,
      confirmLabel: 'Capture',
    });
    if (!text) return;
    appendCaptureToInbox(text, /*silent*/ false);
  }

  // Silent capture path used by the bookmarklet handoff — no modal, no extra
  // click. Returns true on success.
  function appendCaptureToInbox(text, silent){
    if (!text) return false;
    const inbox = findNote(n => n.title === '📥 Inbox');
    if (!inbox) { if (!silent) toast('Inbox missing — reload page'); return false; }
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
    const newLines = String(text).split(/\r?\n/).map(s => s.trim()).filter(Boolean)
      .map(line => `- [ ] [${stamp}] ${line}`).join('\n') + '\n';
    if (inbox.content.includes('## Captures')) {
      inbox.content = inbox.content.replace('## Captures\n', '## Captures\n' + newLines);
    } else {
      inbox.content += (inbox.content.endsWith('\n') ? '' : '\n') + newLines;
    }
    inbox.updatedAt = nowISO();
    window.save();
    toast(silent ? '📥 Captured (from bookmarklet)' : 'Captured to 📥 Inbox');
    if (window.route === 'research' && typeof window.render === 'function') window.render();
    return true;
  }

  async function newPaperNote(prefill = ''){
    const title = await showInputModal({
      title: '📄 New paper note',
      placeholder: 'Paper title (or paste a citation — we keep just the title)',
      initial: prefill,
      confirmLabel: 'Create note',
    });
    if (!title) return;
    const nb = (window.db.notebooks || []).find(x => x.title === '🔬 Research' && !x.deletedAt);
    if (!nb) { toast('🔬 Research notebook missing'); return; }
    const p = ensurePage({
      title,
      notebookId: nb.id,
      content: PAPER_TEMPLATE.replace('{TITLE}', title).replace('{DATE}', todayStr()),
      tags: ['paper', 'research']
    });
    window.save();
    if (typeof window.openNote === 'function') window.openNote(p.id);
    else if (typeof window.render === 'function') window.render();
    toast('New paper note: ' + p.title);
  }

  async function newOrOpenTopicMap(prefill = ''){
    const name = await showInputModal({
      title: '🗺️ New / open topic map',
      placeholder: 'e.g. shared autonomy · diffusion policies · social robot trust',
      initial: prefill,
      confirmLabel: 'Open map',
    });
    if (!name) return;
    const nb = (window.db.notebooks || []).find(x => x.title === '🔬 Research' && !x.deletedAt);
    if (!nb) { toast('🔬 Research notebook missing'); return; }
    const title = `🗺️ Topic Map — ${name}`;
    const existed = !!findNote(n => n.notebookId === nb.id && n.title === title);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const p = ensurePage({
      title,
      notebookId: nb.id,
      content: topicMap(name),
      tags: ['research', 'topic-map', slug].filter(Boolean)
    });
    window.save();
    if (typeof window.openNote === 'function') window.openNote(p.id);
    else if (typeof window.render === 'function') window.render();
    toast(existed ? 'Opened topic map: ' + name : 'New topic map: ' + name);
  }

  async function newOrOpenSynthesis(prefill = ''){
    const d = new Date();
    const defaultYM = `${d.getFullYear()}-${pad(d.getMonth()+1)}`;
    const ym = await showInputModal({
      title: '📊 New / open monthly synthesis',
      placeholder: 'YYYY-MM (e.g. 2026-05)',
      initial: prefill || defaultYM,
      confirmLabel: 'Open synthesis',
    });
    if (!ym) return;
    const clean = ym.trim();
    if (!/^\d{4}-\d{2}$/.test(clean)) { toast('Use YYYY-MM (e.g. 2026-05)'); return; }
    const nb = (window.db.notebooks || []).find(x => x.title === '🔬 Research' && !x.deletedAt);
    if (!nb) { toast('🔬 Research notebook missing'); return; }
    const title = `📊 Synthesis — ${clean}`;
    const existed = !!findNote(n => n.notebookId === nb.id && n.title === title);
    const p = ensurePage({
      title,
      notebookId: nb.id,
      content: SYNTH_TEMPLATE.replace('📊 Monthly Synthesis — Template', `📊 Synthesis — ${clean}`),
      tags: ['research', 'synthesis']
    });
    window.save();
    if (typeof window.openNote === 'function') window.openNote(p.id);
    else if (typeof window.render === 'function') window.render();
    toast(existed ? 'Opened synthesis: ' + clean : 'New synthesis: ' + clean);
  }

  // ------------------------------------------------------------------
  // Content templates
  // ------------------------------------------------------------------
  const INBOX_BODY = `# 📥 Research Inbox

**How it works:** Press **Alt+I** anywhere in UltraNote to capture a paper, link, or idea here in one keystroke. Don't read it now — just capture. Every Friday, triage this list (promote into a paper note or delete).

**Shortcuts:**
- **Alt+I** → capture to this inbox
- **Alt+P** → new structured paper note
- **Alt+M** → new / open a topic map (create one whenever a thread starts repeating)

## Captures
`;

  function topicMap(topic){
    return `# 🗺️ Topic Map — ${topic}

> Living map of what's happening in this area. Update during the weekly triage. The point of this note is that **in 60 seconds you can sound informed about ${topic}** to a PI, an interviewer, or a collaborator.

## 🧑‍🔬 Key people & labs
- (Name — affiliation — what they're known for — 1 representative paper)

## 📜 Seminal works (must-cite foundations)
- (Author, Year — title — why it matters)

## 🆕 Recent (last 6 months)
- (Author, Year — title — 1-line so-what)

## ❓ Open problems
- (What's still hard / unsolved / contested)

## 🎯 My angle / what I'd contribute
- (Where my background gives me leverage; what gap I'd attack)

## 🔗 Related paper notes
- [[ ]]
`;
  }

  const TOPIC_INDEX_BODY = `# 🗺️ Topic Maps — Index

> Don't pre-decide your topics. Let them **emerge** from the inbox.

**Rule of thumb:** the *third* time a thread of literature shows up in your inbox, spin up a topic map for it. Until then, don't bother — you're still exploring.

## How to create one
Press **Alt+M** anywhere, type the topic name (e.g. *"shared autonomy"*, *"diffusion policies"*, *"social robot trust"*, *"language‑conditioned manipulation"*). A new "🗺️ Topic Map — \<name\>" note appears with the standard scaffold:

- Key people & labs
- Seminal works
- Recent (last 6 months)
- Open problems
- My angle
- Related paper notes

## How to keep them small enough to be useful
- One topic = one map. If it splits, split the map.
- Cap each section at ~10 lines. If it overflows, the topic has graduated into a sub-area — spin off a child map.
- **Every map should answer:** *"why do I care, what's the state of the art, and what would I add?"*
- If you haven't touched a map in 3 months, archive it (move to bottom, prefix with "📜 archived: "). The act of archiving is information.

## Your maps
*This list builds itself — every Alt+M creates a new "🗺️ Topic Map — ..." page in this notebook. Use the notebook view to scan them.*

## Suggested starting moves (only if helpful, otherwise ignore)
- Spend the first 2 weeks just capturing into the inbox — no maps yet.
- After 2 weeks, look at what keeps appearing. Those are your real topics, not the ones you would have guessed.
- Start with 1–3 maps maximum. Add more only when the inbox forces you to.
`;

  const SYNTH_TEMPLATE = `# 📊 Monthly Synthesis — Template

> On the 1st each month, copy this template into a new note titled "📊 Synthesis — YYYY-MM" and fill it in (~1 hour). A task is auto-created on the Today page.

## 5 bullets — what shifted in my fields this month
1.
2.
3.
4.
5.

## New people / labs on my radar
-

## What I read deeply (top 3)
-

## Threads to pull next month
-

## My own progress (anchored to research goals)
-

## 1 paragraph "elevator update" (reusable for emails to advisors / applications)
>
`;

  const WEEKLY_BODY = `# 🔁 Weekly Triage Ritual (Fridays, 30 min)

A task auto-appears every Friday on the Today page. The ritual:

1. **Open 📥 Inbox.** For each item, decide: *Promote*, *Skim later*, or *Delete*.
2. **Promote** → press **Alt+P**, paste the title, fill the template. Tag with relevant topic.
3. **Skim later** → keep in inbox but prepend "later: " — bumps for next week.
4. **Delete** → just remove the line. Ruthless is good.
5. **Update topic maps** — if a paper materially changes the field, add 1–2 lines to the right "🗺️ Topic Map".
6. **Close the loop** — anything that became a TODO gets added as a task with a due date.

**Why this works:** the inbox stays small, the topic maps stay living, and at the end of every month the monthly synthesis writes itself from the deltas in the topic maps.
`;

  const SOURCES_BODY = `# 📚 Sources & Feeds

Curated, narrow on purpose. **More sources = less reading.** Prune ruthlessly: if a source hasn't surfaced something useful in 4 weeks, drop it.

## Daily skim (15 min, in 📥 Inbox)
- **arxiv-sanity-lite** — https://arxiv-sanity-lite.com — Karpathy's filtered arXiv (set your interests)
- **Google Scholar alerts** — set 3–5 narrow phrase queries. Tune them quarterly. Examples to *consider*, not copy:
  - a specific method name you care about
  - a specific application or benchmark
  - a researcher whose lab you watch
- **The Batch** (DeepLearning.AI) — weekly digest
- **Import AI** (Jack Clark) — weekly, policy + research

## Weekly deep-dive (during Friday triage)
- **Sebastian Raschka — Ahead of AI** (substack) — best ML synthesis newsletter
- Field-specific journal RSS — pick 1–2 that map to whatever you find yourself returning to (e.g. IEEE RA-L for robotics, TACL for NLP, etc.)
- Conference proceedings of 1–3 venues you care about — skim TOC quarterly
- **The Robot Report** / equivalent industry digest — signals what's becoming real
- **arXiv** new-listing pages for the sub-fields you actually care about — Friday morning skim

## Discovery tools (use during triage, not daily)
- **Connected Papers** — https://www.connectedpapers.com — citation-graph view of any paper
- **Semantic Scholar** — better-than-Scholar author/paper alerts for CS
- **Papers with Code** — links papers to runnable code
- **Elicit** / **scite.ai** — semantic Q&A across the literature

## PDF + reference manager (external)
- **Zotero** + **Better-BibTeX** + **Zotero Connector** (browser ext)
  - One-click capture of any paper page
  - Sync via your own cloud (WebDAV or Zotero cloud)
  - Link each UltraNote paper note back to the Zotero entry by DOI

## Twitter / X — narrow lists only
- One list per topic, ≤30 accounts each. Refresh quarterly. Build the lists *after* a few weeks of triage — you'll know who actually matters by then.

## Conferences to track (Scholar-alert the accepted-papers lists)
- Pick 3–6 venues, no more. Once you know your topics, the venues pick themselves.
- **Workshops** are often where the action is — track 2–3 you care about

## Communities (lurk → participate)
- 1–2 subreddits in your area — weekly skim
- 1 Slack/Discord — once a week
- **Local reading group** — invaluable; start one if none exists in your dept

---

**Mental model:** sources feed the inbox; the inbox feeds the paper notes; the paper notes feed the topic maps; the topic maps feed the monthly synthesis; the monthly synthesis is what you actually use in applications and conversations.
`;

  const TOOLKIT_BODY = `# 🧰 Research Toolkit — recommended apps & habits

Things outside UltraNote that compound. Adopt one at a time.

## Reference & PDFs
- **Zotero** — reference manager, free, open source. Add the *Better-BibTeX* plugin if you write LaTeX. Sync PDFs via your own WebDAV (Nextcloud, etc.) to avoid the 300 MB free cap.
- **Zotero Connector** browser extension — one click to capture any paper page.

## Reading
- **Sioyek** or **Zotero's built-in PDF reader** — for annotations that export cleanly.
- **Marker** (https://github.com/VikParuchuri/marker) or **Nougat** — convert PDFs to clean Markdown (great for pasting key sections into your paper note here).

## Writing
- **Overleaf** for collaborative LaTeX; or local TeXLive + VS Code + LaTeX Workshop if you prefer.
- **Pandoc** — convert anything to anything.
- **Quarto** for technical blog posts (publishing what you learn forces understanding).

## Discovery & alerting
- **Connected Papers**, **Litmaps**, **Research Rabbit** — citation-graph exploration.
- **Semantic Scholar API** — programmatic author/paper alerts (you can wire this into a cron + push notification if you ever want).
- **arxiv-sanity-lite** self-hosted if you want full control.

## Coding / experiments
- **Weights & Biases** (free academic tier) for experiment tracking — also doubles as a portfolio when applying.
- **GitHub** — keep every project public unless you have a reason not to. Write a real README. Applications read READMEs.

## Visibility (matters more than people admit for PhD/job apps)
- **Personal site** (a one-pager is fine): name, photo, 3-line bio, 3 projects, CV PDF, contact.
- **Google Scholar profile** — even pre-PhD, claim citations as soon as you have a workshop paper.
- **Twitter/X** + **Bluesky** — post a short thread when you read something great (forces synthesis; gets you noticed).
- **Substack/blog** — 1 post a month explaining a paper in your own words. This single habit is the strongest "well-read" signal for applications.

## Habits (the leverage is here, not in the tools)
- **15 min daily skim** → inbox
- **30 min Friday triage** → promote / prune
- **1 hr first-of-month synthesis** → topic maps + monthly note
- **1 paper-explainer post per month** → blog or thread
- **1 reading-group attendance per week** → if none, start one

## Building "I am well-read" evidence for applications
- The **Monthly Synthesis** notes here become a 12-month track record you can reference in cover letters ("over the past year I've been tracking X, Y, Z; here's how my work connects").
- Topic maps become the **research statement** scaffold — you literally already have "Open problems" and "My angle" sections per topic.
- Paper notes become talking points in interviews — pull up the right one, you have authors, methods, your take, ready to discuss.
`;

  const PAPER_TEMPLATE = `# {TITLE}

**Added:** {DATE}  **Status:** #status/skim
**Tags:** #paper

## Metadata
- **Authors:**
- **Venue / Year:**
- **Link:**
- **Code:**
- **DOI / arXiv id:**

## TL;DR (3 lines, in your own words)
-

## Problem
-

## Method
-

## Results
-

## My take (so what? does it change anything I do?)
-

## Connections
- Related to: [[ ]]
- Builds on: [[ ]]
- Contradicts: [[ ]]
- Relevant to topic map: [[🗺️ Topic Map — ]]

## Quotes / snippets worth keeping
>

## Follow-ups
- [ ]
`;

  // ------------------------------------------------------------------
  // Dashboard renderer (called by app.js render() when route==='research')
  // ------------------------------------------------------------------
  // Internal sub-view state for the Research route: 'dashboard' (default)
  // or 'triage' (the structured per-line inbox triage workspace).
  let researchView = 'dashboard';

  function renderResearch(){
    if (researchView === 'triage') return renderTriage();
    if (researchView === 'manage-topics')    return renderManage('topics');
    if (researchView === 'manage-papers')    return renderManage('papers');
    if (researchView === 'manage-synthesis') return renderManage('synthesis');
    return renderDashboard();
  }

  function renderDashboard(){
    const content = document.getElementById('content');
    if (!content) return;
    const db = window.db;
    const nb = (db.notebooks || []).find(x => x.title === '🔬 Research' && !x.deletedAt);
    if (!nb) {
      content.innerHTML = '<div style="padding:24px;">Research scaffold missing — reload the page.</div>';
      ensureResearchScaffold(db);
      return;
    }
    const pages = (db.notes || []).filter(n => n.notebookId === nb.id && !n.deletedAt && n.type === 'page');
    const byTitle = (t) => pages.find(p => p.title === t);
    const inbox     = byTitle('📥 Inbox');
    const topicIdx  = byTitle('🗺️ Topic Maps — Index');
    const synthTmpl = byTitle('📊 Monthly Synthesis — Template');
    const weekly    = byTitle('🔁 Weekly Triage Ritual');
    const sources   = byTitle('📚 Sources & Feeds');
    const toolkit   = byTitle('🧰 Research Toolkit');

    const topicMaps = pages
      .filter(p => p.title.startsWith('🗺️ Topic Map — ') && p.title !== '🗺️ Topic Maps — Index')
      .sort((a,b) => (b.updatedAt||'').localeCompare(a.updatedAt||''));
    const papers = pages
      .filter(p => (p.tags||[]).includes('paper'))
      .sort((a,b) => (b.updatedAt||'').localeCompare(a.updatedAt||''));
    const synths = pages
      .filter(p => (p.tags||[]).includes('synthesis') && !(p.tags||[]).includes('template'))
      .sort((a,b) => (b.updatedAt||'').localeCompare(a.updatedAt||''));

    const allInboxLines = parseInboxLines(inbox);
    const totalInbox = allInboxLines.length;
    const previewLines = allInboxLines.slice(0, 5);

    // --- Follow-ups: open tasks promoted from a Research-scope note's "- [ ]" checklist.
    // Grouped by source note so you can see which paper still has loose ends.
    // Scope: only follow-ups whose source note is tagged 'paper' OR lives in the
    // 🔬 Research notebook — otherwise non-research notes leak into this card.
    const allNotesById = new Map((db.notes || []).filter(n => !n.deletedAt).map(n => [n.id, n]));
    const isResearchSource = (noteId) => {
      const src = allNotesById.get(noteId);
      if (!src) return false;
      if ((src.tags || []).includes('paper')) return true;
      if (nb && src.notebookId === nb.id) return true;
      return false;
    };
    const followups = (db.tasks || []).filter(t => !t.deletedAt && t.status !== 'DONE' && (t.tags || []).includes('paper-followup') && isResearchSource(t.noteId));
    const followupsByNote = new Map();
    followups.forEach(t => {
      const arr = followupsByNote.get(t.noteId) || [];
      arr.push(t);
      followupsByNote.set(t.noteId, arr);
    });
    // Sort groups by most recent task creation; ungrouped (orphaned) bucket last.
    const followupGroups = Array.from(followupsByNote.entries())
      .map(([nid, ts]) => ({
        note: allNotesById.get(nid) || null,
        tasks: ts.sort((a,b) => (b.createdAt||'').localeCompare(a.createdAt||''))
      }))
      .sort((a,b) => {
        const aT = a.tasks[0]?.createdAt || '';
        const bT = b.tasks[0]?.createdAt || '';
        return bT.localeCompare(aT);
      });

    const card = (title, body, footer='') => `
      <div class="research-card">
        <div class="research-card-title">${title}</div>
        <div class="research-card-body">${body}</div>
        ${footer ? `<div class="research-card-footer">${footer}</div>` : ''}
      </div>`;
    const linkBtn = (note, label) => note
      ? `<button class="research-doc" data-open-id="${note.id}">${esc(label || note.title)}</button>`
      : `<span style="color:var(--muted)">missing</span>`;
    const scrollList = (items, empty) => items.length
      ? `<div class="research-scrollbox"><ul class="research-list">${items.map(p => `<li><button class="research-link" data-open-id="${p.id}">${esc(p.title)}</button> <span class="research-meta">${relTime(p.updatedAt)}</span></li>`).join('')}</ul></div>`
      : `<div class="research-empty">${empty}</div>`;

    const origin = location.origin;
    // Named target ('ultranote') makes the browser reuse the same tab/window on
    // subsequent clicks instead of spawning a new instance each time.
    // .focus() then brings it forward. Drop noopener so .focus() works.
    const bookmarklet = `javascript:(function(){var u=encodeURIComponent((document.getSelection().toString()||document.title)+' — '+location.href);var w=window.open('${origin}/?capture='+u,'ultranote');if(w){try{w.focus();}catch(e){}}})();`;

    content.innerHTML = `
      <style>
        .research-wrap{padding:18px 22px 60px;max-width:1100px;margin:0 auto;}
        .research-hero{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;flex-wrap:wrap;}
        .research-hero h1{margin:0;font-size:22px;}
        .research-hero p{margin:2px 0 0;color:var(--muted);font-size:13px;}
        .research-actions{display:flex;gap:8px;flex-wrap:wrap;}
        .research-actions button{background:var(--accent,#4a90e2);color:#fff;border:none;border-radius:8px;padding:9px 14px;font-size:13px;font-weight:600;cursor:pointer;}
        .research-actions button:hover{filter:brightness(1.1);}
        .research-actions .kbd{opacity:.85;font-weight:400;margin-left:6px;font-size:11px;}
        .research-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px;align-items:start;}
        .research-card{background:var(--card,#fff);border:1px solid var(--border,#e3e3e3);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;min-width:0;max-width:100%;overflow:hidden;}
        .research-card-title{font-weight:700;margin-bottom:8px;font-size:14px;display:flex;justify-content:space-between;align-items:center;gap:8px;}
        .research-card-title .research-count{font-size:11px;font-weight:500;color:var(--muted);background:rgba(127,127,127,0.12);border-radius:10px;padding:1px 8px;}
        .research-card-body{font-size:13px;min-width:0;}
        .research-card-footer{margin-top:10px;font-size:12px;color:var(--muted);display:flex;gap:6px;align-items:center;flex-wrap:wrap;}
        .research-link{background:transparent;border:none;color:var(--link,#3b82f6);cursor:pointer;padding:2px 0;text-align:left;font:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;}
        .research-link:hover{text-decoration:underline;}
        /* Action chip: clearly a button. Square-ish, bordered, bold. */
        .research-chip{display:inline-flex;align-items:center;gap:4px;background:var(--card,#fff);color:var(--text,inherit);border:1px solid var(--border,#555);border-radius:6px;padding:5px 10px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;text-decoration:none;line-height:1.2;white-space:nowrap;}
        .research-chip:hover{background:rgba(74,144,226,0.12);border-color:var(--accent,#4a90e2);color:var(--accent,#4a90e2);text-decoration:none;}
        /* Document reference: a thing, not an action. Rounded pill, no border. */
        .research-doc{display:inline-flex;align-items:center;gap:4px;background:rgba(127,127,127,0.14);color:var(--text,inherit);border:none;border-radius:14px;padding:3px 10px;font-size:12px;font-weight:400;cursor:pointer;font-family:inherit;text-decoration:none;line-height:1.3;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
        .research-doc:hover{background:rgba(127,127,127,0.24);color:var(--link,#3b82f6);text-decoration:none;}
        .research-doc::before{content:'•';opacity:.55;margin-right:2px;}
        .research-list{list-style:none;padding:0;margin:0;}
        .research-list li{padding:3px 0;display:flex;justify-content:space-between;gap:8px;align-items:baseline;min-width:0;}
        .research-list li .research-link{flex:1 1 auto;min-width:0;}
        .research-meta{font-size:11px;color:var(--muted);white-space:nowrap;flex:0 0 auto;}
        .research-empty{color:var(--muted);font-size:12px;font-style:italic;}
        .research-scrollbox{max-height:220px;overflow-y:auto;border:1px solid var(--border,transparent);border-radius:8px;padding:6px 10px;background:rgba(127,127,127,0.04);}
        /* Inbox preview: strict one-line-per-item, capped at 5 rows. */
        .research-inbox-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:3px;}
        .research-inbox-list li{font-family:ui-monospace,Menlo,monospace;font-size:12px;background:rgba(127,127,127,0.10);color:var(--text,inherit);padding:4px 8px;border-radius:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;}
        .research-pill-scroll{max-height:140px;overflow-y:auto;padding:2px;}
        .research-pill-row{display:flex;gap:5px;flex-wrap:wrap;margin-top:2px;}
        .research-bookmarklet{display:inline-block;background:rgba(127,127,127,0.14);border:1px dashed var(--border,#888);color:var(--text,inherit);padding:6px 12px;border-radius:8px;text-decoration:none;font-size:12px;font-weight:600;cursor:grab;}
        .research-bookmarklet:hover{background:rgba(127,127,127,0.22);}
      </style>
      <div class="research-wrap">
        <div class="research-hero">
          <div>
            <h1>🔬 Research</h1>
            <p>Capture daily · triage weekly · synthesize monthly. Three shortcuts run the whole thing.</p>
          </div>
          <div class="research-actions">
            <button data-action="capture">📥 Capture <span class="kbd">Alt+I</span></button>
            <button data-action="paper">📄 New paper <span class="kbd">Alt+P</span></button>
            <button data-action="topic">🗺️ New topic map <span class="kbd">Alt+M</span></button>
            <button data-action="triage" style="background:transparent;color:var(--text,inherit);border:1px solid var(--border,#444);">🔁 Triage inbox${totalInbox?` (${totalInbox})`:''}</button>
          </div>
        </div>

        <div class="research-grid">
          ${card(`📥 Inbox<span class="research-count">${totalInbox}</span>`,
            totalInbox
              ? `<ul class="research-inbox-list">${previewLines.map(l => `<li title="${esc(l.raw)}">${esc((l.stamp ? `[${l.stamp}] ` : '') + l.text)}</li>`).join('')}</ul>
                 ${totalInbox > previewLines.length ? `<div style="margin-top:6px;"><button class="research-chip" data-action="triage">+ ${totalInbox - previewLines.length} more → triage</button></div>` : ''}`
              : `<div class="research-empty">Nothing captured yet. Press <strong>Alt+I</strong> from anywhere to drop a paper/link/idea here.</div>`,
            `${inbox ? linkBtn(inbox, 'Edit raw note') : ''}`
          )}

          ${card(`🗺️ Topic Maps<span class="research-count">${topicMaps.length}</span>`,
            topicMaps.length
              ? `<div class="research-pill-scroll"><div class="research-pill-row">${topicMaps.map(p => `<button class="research-doc" data-open-id="${p.id}" title="${esc(p.title)}">${esc(p.title.replace('🗺️ Topic Map — ',''))}</button>`).join('')}</div></div>`
              : `<div class="research-empty">No topic maps yet. Spin one up with <strong>Alt+M</strong> when a thread shows up in your inbox a 3rd time.</div>`,
            `<button class="research-chip" data-action="topic">＋ New</button>
             ${topicMaps.length ? `<button class="research-chip" data-action="manage-topics">Manage all →</button>` : ''}
             ${linkBtn(topicIdx, 'How topic maps work')}`
          )}

          ${card(`📄 Paper notes<span class="research-count">${papers.length}</span>`,
            scrollList(papers, 'No paper notes yet. Press <strong>Alt+P</strong> during Friday triage to promote inbox items.'),
            `<button class="research-chip" data-action="paper">＋ New</button>
             ${papers.length ? `<button class="research-chip" data-action="manage-papers">Manage all →</button>` : ''}`
          )}

          ${card(`� Follow-ups<span class="research-count">${followups.length}</span>`,
            followups.length
              ? `<div class="research-scrollbox">${followupGroups.map(g => {
                  const noteTitle = g.note ? esc(g.note.title || '(untitled)') : '<span class="research-empty" style="font-style:normal;">(source note deleted)</span>';
                  const openAttr = g.note ? `data-open-id="${g.note.id}"` : '';
                  const head = g.note
                    ? `<button class="research-link" ${openAttr} style="font-weight:600;font-size:12px;">${noteTitle}</button>`
                    : `<span style="font-weight:600;font-size:12px;color:var(--muted);">${noteTitle}</span>`;
                  const rows = g.tasks.map(t => {
                    const colors = { high: '#ff6b6b', medium: '#8b6dff', low: '#64748b' };
                    const col = colors[t.priority || 'medium'];
                    return `<label class="row" style="gap:8px;align-items:flex-start;padding:3px 0 3px 14px;cursor:pointer;border-left:3px solid ${col};margin-left:4px;">
                      <input type="checkbox" data-followup-toggle="${esc(t.id)}">
                      <span style="flex:1;font-size:12px;">${esc(t.title)}${t.due ? ` <span class="research-meta">· due ${esc(t.due)}</span>` : ''}</span>
                    </label>`;
                  }).join('');
                  return `<div style="padding:6px 0;border-bottom:1px dashed var(--border,#444);">${head}<div>${rows}</div></div>`;
                }).join('')}</div>`
              : `<div class="research-empty">No open follow-ups. Inside any note, type <code>- [ ]</code> tasks then click <strong>→ Task</strong> in the "Checklist in this note" panel to track them here.</div>`,
            followups.length
              ? `Tick a box to mark done. Click a note title to open the source.`
              : ''
          )}

          ${card(`�📊 Monthly synthesis<span class="research-count">${synths.length}</span>`,
            scrollList(synths, 'No synthesis notes yet. One is auto-suggested on the 1st of each month — or start one now.'),
            `<button class="research-chip" data-action="synth">＋ New</button>
             ${synths.length ? `<button class="research-chip" data-action="manage-synthesis">Manage all →</button>` : ''}
             ${linkBtn(synthTmpl, 'Open template')}`
          )}

          ${card('🔁 Rituals & how-to',
            `<div style="display:flex;flex-direction:column;gap:4px;">
              ${linkBtn(weekly, '🔁 Weekly Triage Ritual')}
              ${linkBtn(sources, '📚 Sources & Feeds')}
              ${linkBtn(toolkit, '🧰 Research Toolkit (Zotero, Connected Papers, etc.)')}
              <button class="research-chip" data-action="restore-scaffold" style="margin-top:6px;align-self:flex-start;">↻ Restore missing system pages</button>
            </div>`,
            'Core notes stay deleted if you remove them. Use Restore to recreate any you removed by mistake.'
          )}

          ${card('📌 Capture bookmarklet',
            `<div style="margin-bottom:8px;">Drag this to your browser bookmark bar. Click it on any paper / blog / arXiv page to capture the title + URL straight into your inbox.</div>
             <a class="research-bookmarklet" draggable="true" href="${bookmarklet.replace(/"/g,'&quot;')}">📥 Capture to UltraNote</a>`,
            'Select text first to capture a quote instead of the page title.'
          )}
        </div>
      </div>`;

    // Wire actions.
    content.querySelectorAll('[data-action]').forEach(btn => {
      btn.onclick = () => {
        const a = btn.dataset.action;
        if (a === 'capture') openInboxCapture();
        else if (a === 'paper') newPaperNote();
        else if (a === 'topic') newOrOpenTopicMap();
        else if (a === 'synth') newOrOpenSynthesis();
        else if (a === 'triage') { researchView = 'triage'; renderTriage(); }
        else if (a === 'manage-topics')    { researchView = 'manage-topics';    renderManage('topics'); }
        else if (a === 'manage-papers')    { researchView = 'manage-papers';    renderManage('papers'); }
        else if (a === 'manage-synthesis') { researchView = 'manage-synthesis'; renderManage('synthesis'); }
        else if (a === 'restore-scaffold') {
          if (typeof window.researchRestoreScaffold === 'function') window.researchRestoreScaffold();
        }
      };
    });
    content.querySelectorAll('[data-open-id]').forEach(el => {
      el.onclick = () => {
        const id = el.dataset.openId;
        if (typeof window.openNote === 'function') window.openNote(id);
      };
    });
    // Follow-up checkbox: mark task DONE (or back to TODO) and re-render the dashboard
    // so the row drops out of the list immediately.
    content.querySelectorAll('[data-followup-toggle]').forEach(cb => {
      cb.onchange = () => {
        const id = cb.dataset.followupToggle;
        if (typeof window.setTaskStatus === 'function') {
          window.setTaskStatus(id, cb.checked ? 'DONE' : 'TODO');
        }
        renderDashboard();
      };
    });
    // Stop the bookmarklet from being followed when clicked from the app
    // itself (only useful from the bookmark bar in another tab).
    const bm = content.querySelector('.research-bookmarklet');
    if (bm) bm.addEventListener('click', (e) => { e.preventDefault(); toast("Drag this link to your bookmark bar — don't click it here."); });
  }

  // ------------------------------------------------------------------
  // Triage view — one row per inbox line, 1-click actions
  // ------------------------------------------------------------------
  function renderTriage(){
    const content = document.getElementById('content');
    if (!content) return;
    const db = window.db;
    const inbox = findNote(n => n.title === '📥 Inbox');
    const lines = parseInboxLines(inbox);

    const rows = lines.map((l, idx) => `
      <div class="triage-row" data-idx="${idx}">
        <div class="triage-meta">${esc(l.stamp || '')}</div>
        <div class="triage-text" contenteditable="true" spellcheck="false" data-line-idx="${idx}">${esc(l.text)}</div>
        <div class="triage-actions">
          <button data-act="paper" title="Promote to a paper note">📄</button>
          <button data-act="topic" title="Open / create topic map">🗺️</button>
          <button data-act="defer" title="Defer (prepend 'later: ')">⏳</button>
          <button data-act="delete" title="Delete this line">🗑️</button>
        </div>
      </div>`).join('');

    content.innerHTML = `
      <style>
        .triage-wrap{padding:18px 22px 60px;max-width:980px;margin:0 auto;}
        .triage-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:12px;flex-wrap:wrap;}
        .triage-head h1{margin:0;font-size:20px;}
        .triage-head p{margin:2px 0 0;color:var(--muted);font-size:12px;}
        .triage-head .triage-back{background:transparent;color:var(--text,inherit);border:1px solid var(--border,#444);padding:6px 12px;border-radius:8px;font-size:12px;cursor:pointer;}
        .triage-head .triage-capture{background:var(--accent,#4a90e2);color:#fff;border:none;padding:7px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-weight:600;}
        .triage-empty{padding:40px 20px;text-align:center;color:var(--muted);background:rgba(127,127,127,0.06);border-radius:12px;}
        .triage-list{display:flex;flex-direction:column;gap:6px;max-height:calc(100vh - 180px);overflow-y:auto;border:1px solid var(--border,#333);border-radius:12px;padding:8px;background:rgba(127,127,127,0.04);}
        .triage-row{display:grid;grid-template-columns:120px 1fr auto;gap:10px;align-items:center;padding:8px 10px;background:var(--card,transparent);border:1px solid var(--border,transparent);border-radius:8px;min-width:0;}
        .triage-row:hover{border-color:var(--accent,#4a90e2);}
        .triage-meta{font-size:11px;color:var(--muted);font-family:ui-monospace,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
        .triage-text{font-size:13px;outline:none;padding:4px 6px;border-radius:4px;min-width:0;word-break:break-word;}
        .triage-text:focus{background:rgba(127,127,127,0.10);}
        .triage-actions{display:flex;gap:4px;}
        .triage-actions button{background:transparent;color:var(--text,inherit);border:1px solid var(--border,#444);width:32px;height:32px;border-radius:8px;cursor:pointer;font-size:14px;padding:0;}
        .triage-actions button:hover{background:rgba(127,127,127,0.18);}
        .triage-actions button[data-act="delete"]:hover{background:rgba(239,68,68,0.20);border-color:#ef4444;}
        .triage-actions button[data-act="paper"]:hover{background:rgba(74,144,226,0.22);border-color:var(--accent,#4a90e2);}
      </style>
      <div class="triage-wrap">
        <div class="triage-head">
          <div>
            <h1>🔁 Triage — 📥 Inbox <span style="opacity:.6;font-weight:500;">(${lines.length})</span></h1>
            <p>For each line: promote (📄/🗺️), defer (⏳), or delete (🗑️). Click the text to edit it inline.</p>
          </div>
          <div style="display:flex;gap:6px;">
            <button class="triage-capture" data-act="add">＋ Capture</button>
            <button class="triage-back" data-act="back">← Back to dashboard</button>
          </div>
        </div>
        ${lines.length
          ? `<div class="triage-list">${rows}</div>`
          : `<div class="triage-empty">Inbox is empty. Press <strong>Alt+I</strong> to capture something, or click <strong>＋ Capture</strong> above.</div>`}
      </div>`;

    // Top-level buttons
    content.querySelector('[data-act="back"]').onclick = () => {
      researchView = 'dashboard';
      renderDashboard();
    };
    content.querySelector('[data-act="add"]').onclick = async () => {
      await openInboxCapture();
      renderTriage();
    };

    // Row buttons + inline edits
    content.querySelectorAll('.triage-row').forEach(row => {
      const idx = +row.dataset.idx;
      row.querySelectorAll('.triage-actions button').forEach(btn => {
        btn.onclick = async () => {
          const act = btn.dataset.act;
          if (act === 'delete') {
            removeInboxLineByIdx(idx);
            renderTriage();
          } else if (act === 'defer') {
            deferInboxLine(idx);
            renderTriage();
          } else if (act === 'paper') {
            const text = stripDeferPrefix(lines[idx].text);
            await newPaperNote(text);
            removeInboxLineByIdx(idx);
            renderTriage();
          } else if (act === 'topic') {
            const text = stripDeferPrefix(lines[idx].text);
            await newOrOpenTopicMap(text);
            renderTriage();
          }
        };
      });
      const textEl = row.querySelector('.triage-text');
      textEl.addEventListener('blur', () => {
        const newText = textEl.textContent.trim();
        if (!newText) { removeInboxLineByIdx(idx); renderTriage(); return; }
        if (newText !== lines[idx].text) {
          updateInboxLineText(idx, newText);
        }
      });
      textEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); textEl.blur(); }
      });
    });
  }

  // ------------------------------------------------------------------
  // Manage view — one row per topic map / paper / synthesis note
  // ------------------------------------------------------------------
  const MANAGE_KINDS = {
    topics: {
      label: '🗺️ Topic Maps',
      empty: 'No topic maps yet. Create one with <strong>Alt+M</strong> or the button above.',
      titlePrefix: '🗺️ Topic Map — ',
      newAction: () => newOrOpenTopicMap(),
      filter: (p) => p.title.startsWith('🗺️ Topic Map — ') && p.title !== '🗺️ Topic Maps — Index',
    },
    papers: {
      label: '📄 Paper notes',
      empty: 'No paper notes yet. Create one with <strong>Alt+P</strong> or the button above.',
      titlePrefix: '',
      newAction: () => newPaperNote(),
      filter: (p) => (p.tags || []).includes('paper'),
    },
    synthesis: {
      label: '📊 Monthly synthesis',
      empty: 'No synthesis notes yet. Click <strong>＋ New</strong> above to start one.',
      titlePrefix: '',
      newAction: () => newOrOpenSynthesis(),
      filter: (p) => (p.tags || []).includes('synthesis') && !(p.tags || []).includes('template'),
    },
  };

  function renderManage(kind){
    const cfg = MANAGE_KINDS[kind];
    if (!cfg) { researchView = 'dashboard'; return renderDashboard(); }
    const content = document.getElementById('content');
    if (!content) return;
    const db = window.db;
    const nb = (db.notebooks || []).find(x => x.title === '🔬 Research' && !x.deletedAt);
    if (!nb) { researchView = 'dashboard'; return renderDashboard(); }

    const items = (db.notes || [])
      .filter(n => n.notebookId === nb.id && !n.deletedAt && n.type === 'page' && cfg.filter(n))
      .sort((a,b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

    const stripPrefix = (t) => cfg.titlePrefix && t.startsWith(cfg.titlePrefix) ? t.slice(cfg.titlePrefix.length) : t;

    const rows = items.map(p => `
      <div class="triage-row" data-id="${p.id}">
        <div class="triage-meta">${esc(relTime(p.updatedAt))}</div>
        <div class="triage-text" contenteditable="true" spellcheck="false">${esc(stripPrefix(p.title))}</div>
        <div class="triage-actions">
          <button data-act="open" title="Open this note">📂</button>
          <button data-act="delete" title="Delete this note">🗑️</button>
        </div>
      </div>`).join('');

    content.innerHTML = `
      <style>
        .triage-wrap{padding:18px 22px 60px;max-width:980px;margin:0 auto;}
        .triage-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:12px;flex-wrap:wrap;}
        .triage-head h1{margin:0;font-size:20px;}
        .triage-head p{margin:2px 0 0;color:var(--muted);font-size:12px;}
        .triage-head .triage-back{background:transparent;color:var(--text,inherit);border:1px solid var(--border,#444);padding:6px 12px;border-radius:8px;font-size:12px;cursor:pointer;}
        .triage-head .triage-capture{background:var(--accent,#4a90e2);color:#fff;border:none;padding:7px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-weight:600;}
        .triage-empty{padding:40px 20px;text-align:center;color:var(--muted);background:rgba(127,127,127,0.06);border-radius:12px;}
        .triage-list{display:flex;flex-direction:column;gap:6px;max-height:calc(100vh - 180px);overflow-y:auto;border:1px solid var(--border,#333);border-radius:12px;padding:8px;background:rgba(127,127,127,0.04);}
        .triage-row{display:grid;grid-template-columns:120px 1fr auto;gap:10px;align-items:center;padding:8px 10px;background:var(--card,transparent);border:1px solid var(--border,transparent);border-radius:8px;min-width:0;}
        .triage-row:hover{border-color:var(--accent,#4a90e2);}
        .triage-meta{font-size:11px;color:var(--muted);font-family:ui-monospace,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
        .triage-text{font-size:13px;outline:none;padding:4px 6px;border-radius:4px;min-width:0;word-break:break-word;}
        .triage-text:focus{background:rgba(127,127,127,0.10);}
        .triage-actions{display:flex;gap:4px;}
        .triage-actions button{background:transparent;color:var(--text,inherit);border:1px solid var(--border,#444);width:32px;height:32px;border-radius:8px;cursor:pointer;font-size:14px;padding:0;}
        .triage-actions button:hover{background:rgba(127,127,127,0.18);}
        .triage-actions button[data-act="delete"]:hover{background:rgba(239,68,68,0.20);border-color:#ef4444;}
        .triage-actions button[data-act="open"]:hover{background:rgba(74,144,226,0.22);border-color:var(--accent,#4a90e2);}
      </style>
      <div class="triage-wrap">
        <div class="triage-head">
          <div>
            <h1>${cfg.label} <span style="opacity:.6;font-weight:500;">(${items.length})</span></h1>
            <p>Click a title to rename inline. Use 📂 to open, 🗑️ to delete.</p>
          </div>
          <div style="display:flex;gap:6px;">
            ${cfg.newAction ? `<button class="triage-capture" data-act="new">＋ New</button>` : ''}
            <button class="triage-back" data-act="back">← Back to dashboard</button>
          </div>
        </div>
        ${items.length
          ? `<div class="triage-list">${rows}</div>`
          : `<div class="triage-empty">${cfg.empty}</div>`}
      </div>`;

    content.querySelector('[data-act="back"]').onclick = () => {
      researchView = 'dashboard';
      renderDashboard();
    };
    const newBtn = content.querySelector('[data-act="new"]');
    if (newBtn && cfg.newAction) {
      newBtn.onclick = async () => { await cfg.newAction(); renderManage(kind); };
    }

    content.querySelectorAll('.triage-row').forEach(row => {
      const id = row.dataset.id;
      const note = items.find(p => p.id === id);
      if (!note) return;
      row.querySelectorAll('.triage-actions button').forEach(btn => {
        btn.onclick = () => {
          const act = btn.dataset.act;
          if (act === 'open') {
            if (typeof window.openNote === 'function') window.openNote(id);
          } else if (act === 'delete') {
            if (!confirm(`Delete "${stripPrefix(note.title)}"? You can recover it from the trash.`)) return;
            note.deletedAt = nowISO();
            if (typeof window.save === 'function') window.save();
            renderManage(kind);
            toast('Deleted — recover from trash if needed');
          }
        };
      });
      const textEl = row.querySelector('.triage-text');
      textEl.addEventListener('blur', () => {
        const newName = textEl.textContent.trim();
        if (!newName) {
          textEl.textContent = stripPrefix(note.title);
          return;
        }
        const fullTitle = cfg.titlePrefix + newName;
        if (fullTitle !== note.title) {
          note.title = fullTitle;
          note.updatedAt = nowISO();
          if (typeof window.save === 'function') window.save();
          renderManage(kind);
        }
      });
      textEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); textEl.blur(); }
        if (e.key === 'Escape') { textEl.textContent = stripPrefix(note.title); textEl.blur(); }
      });
    });
  }

  // ------------------------------------------------------------------
  // Inbox line helpers
  // ------------------------------------------------------------------
  // Inbox lines look like:  `- [ ] [2026-05-30 09:12] some text`
  function parseInboxLines(inbox){
    if (!inbox) return [];
    const out = [];
    inbox.content.split('\n').forEach(raw => {
      const m = raw.match(/^\s*-\s*\[[^\]]*\]\s*(?:\[([^\]]+)\]\s*)?(.*)$/);
      if (!m) return;
      out.push({ raw, stamp: m[1] || '', text: m[2] || '' });
    });
    return out;
  }

  function stripDeferPrefix(s){ return (s || '').replace(/^later:\s*/i, '').trim(); }

  function _withInboxLines(fn){
    const inbox = findNote(n => n.title === '📥 Inbox');
    if (!inbox) return;
    const splitter = inbox.content.split('\n');
    let i = 0;
    const newLines = splitter.map(raw => {
      if (/^\s*-\s*\[[^\]]*\]/.test(raw)) {
        const r = fn(raw, i);
        i++;
        return r;
      }
      return raw;
    }).filter(x => x !== null);
    inbox.content = newLines.join('\n');
    inbox.updatedAt = nowISO();
    window.save();
  }

  function removeInboxLineByIdx(target){
    _withInboxLines((raw, i) => (i === target ? null : raw));
  }

  function deferInboxLine(target){
    _withInboxLines((raw, i) => {
      if (i !== target) return raw;
      return raw.replace(/^(\s*-\s*\[[^\]]*\]\s*(?:\[[^\]]+\]\s*)?)(?!later:)(.*)$/i, '$1later: $2');
    });
  }

  function updateInboxLineText(target, newText){
    _withInboxLines((raw, i) => {
      if (i !== target) return raw;
      return raw.replace(/^(\s*-\s*\[[^\]]*\]\s*(?:\[[^\]]+\]\s*)?).*$/, `$1${newText}`);
    });
  }

  // ------------------------------------------------------------------
  // URL capture handler (bookmarklet entry point)
  // ------------------------------------------------------------------
  // The bookmarklet opens `https://<app>/?capture=<encoded>`. Browsers don't
  // reliably honor a named window.open target across origins, so a fresh tab
  // usually spawns even if UltraNote is already open elsewhere. To collapse
  // back to a single instance we use a same-origin BroadcastChannel:
  //   1. Every UltraNote tab listens on 'ultranote-capture'.
  //   2. A newly-spawned capture tab broadcasts the captured text and waits
  //      ~450ms for an ack from a sibling tab.
  //   3. If a sibling acks, this tab closes itself; the sibling handles it.
  //   4. If no ack arrives, this tab handles the capture itself.
  let _captureChannel = null;
  function _ensureCaptureChannel(){
    if (_captureChannel || typeof BroadcastChannel === 'undefined') return _captureChannel;
    try {
      _captureChannel = new BroadcastChannel('ultranote-capture');
      _captureChannel.onmessage = (ev) => {
        const msg = ev.data || {};
        // Another tab is handing us a capture. Append silently + ack so the
        // sender (the new bookmarklet tab) can close itself. No modal click
        // needed — the user already typed the source URL via the bookmarklet.
        if (msg.type === 'capture' && typeof msg.text === 'string' && msg.token) {
          try { _captureChannel.postMessage({ type: 'ack', token: msg.token }); } catch(_) {}
          appendCaptureToInbox(msg.text, /*silent*/ true);
        }
      };
    } catch(_) {}
    return _captureChannel;
  }

  function handleUrlCapture(){
    try {
      const url = new URL(location.href);
      const cap = url.searchParams.get('capture');
      if (!cap) return;
      url.searchParams.delete('capture');
      history.replaceState(null, '', url.pathname + (url.search ? url.search : '') + url.hash);
      const ch = _ensureCaptureChannel();
      if (!ch) {
        // No BroadcastChannel support — silently append in this tab.
        setTimeout(() => appendCaptureToInbox(cap, /*silent*/ true), 200);
        return;
      }
      // Try to hand off to an existing tab.
      const token = 'cap-' + Date.now() + '-' + Math.random().toString(36).slice(2,8);
      let acked = false;
      const handler = (ev) => {
        if (ev.data && ev.data.type === 'ack' && ev.data.token === token) {
          acked = true;
          ch.removeEventListener('message', handler);
          // Hand-off complete — close this duplicate tab.
          setTimeout(() => { try { window.close(); } catch(_) {} }, 80);
        }
      };
      ch.addEventListener('message', handler);
      try { ch.postMessage({ type: 'capture', text: cap, token }); } catch(_) {}
      // If no sibling answers in time, this tab is the only UltraNote instance —
      // append silently here (same UX as the handoff path).
      setTimeout(() => {
        if (acked) return;
        ch.removeEventListener('message', handler);
        appendCaptureToInbox(cap, /*silent*/ true);
      }, 450);
    } catch(_) {}
  }

  function esc(s){ return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
  function relTime(iso){
    if (!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    const min = Math.floor(diff/60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min/60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr/24);
    if (day < 30) return `${day}d ago`;
    return iso.slice(0,10);
  }

})();
