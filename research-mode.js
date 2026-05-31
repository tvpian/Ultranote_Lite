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
    try { seedIfNeeded(db); } catch(e){ console.error('[research-mode] seed', e); }
    try { scheduleRituals(db); } catch(e){ console.error('[research-mode] rituals', e); }
    bindShortcuts();
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
    let nb = db.notebooks.find(x => x.title === title);
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
  // Seed notebook
  // ------------------------------------------------------------------
  function seedIfNeeded(db){
    if (db.settings.researchSeededAt) return;
    const nb = ensureNotebook('🔬 Research');
    ensurePage({ title: '📥 Inbox', notebookId: nb.id, content: INBOX_BODY, tags: ['research', 'inbox'] });
    ensurePage({ title: '🗺️ Topic Maps — Index', notebookId: nb.id, content: TOPIC_INDEX_BODY, tags: ['research', 'topic-maps'] });
    ensurePage({ title: '📊 Monthly Synthesis — Template', notebookId: nb.id, content: SYNTH_TEMPLATE, tags: ['research', 'synthesis', 'template'] });
    ensurePage({ title: '🔁 Weekly Triage Ritual', notebookId: nb.id, content: WEEKLY_BODY, tags: ['research', 'ritual'] });
    ensurePage({ title: '📚 Sources & Feeds', notebookId: nb.id, content: SOURCES_BODY, tags: ['research', 'sources'] });
    ensurePage({ title: '🧰 Research Toolkit', notebookId: nb.id, content: TOOLKIT_BODY, tags: ['research', 'tools'] });
    db.settings.researchSeededAt = nowISO();
    window.save();
    console.log('[research-mode] seeded 🔬 Research notebook');
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

  function openInboxCapture(){
    const text = prompt('📥 Research inbox — paste a link, title, or idea:');
    if (!text || !text.trim()) return;
    const inbox = findNote(n => n.title === '📥 Inbox');
    if (!inbox) { alert('Research inbox not found. Open Notebooks → 🔬 Research.'); return; }
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
    const line = `- [ ] [${stamp}] ${text.trim()}\n`;
    if (inbox.content.includes('## Captures')) {
      inbox.content = inbox.content.replace('## Captures\n', '## Captures\n' + line);
    } else {
      inbox.content += (inbox.content.endsWith('\n') ? '' : '\n') + line;
    }
    inbox.updatedAt = nowISO();
    window.save();
    toast('Captured to 📥 Inbox');
  }

  function newPaperNote(){
    const title = prompt('Paper title:');
    if (!title || !title.trim()) return;
    const nb = (window.db.notebooks || []).find(x => x.title === '🔬 Research');
    if (!nb) { alert('🔬 Research notebook not found.'); return; }
    const p = ensurePage({
      title: title.trim(),
      notebookId: nb.id,
      content: PAPER_TEMPLATE.replace('{TITLE}', title.trim()).replace('{DATE}', todayStr()),
      tags: ['paper', 'research']
    });
    window.save();
    if (typeof window.openNote === 'function') window.openNote(p.id);
    else if (typeof window.render === 'function') window.render();
    toast('New paper note: ' + p.title);
  }

  function newOrOpenTopicMap(){
    const topic = prompt('Topic name (e.g. "shared autonomy", "social robot trust", "diffusion policies"):');
    if (!topic || !topic.trim()) return;
    const name = topic.trim();
    const nb = (window.db.notebooks || []).find(x => x.title === '🔬 Research');
    if (!nb) { alert('🔬 Research notebook not found.'); return; }
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

})();
