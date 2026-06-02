// scripts/seed-demo.js
//
// Generate a rich demo `data.json` suitable for screenshots and the README
// gallery. Designed to pair with scripts/capture-screenshots.js, which uses a
// matching virtual-today (2026-06-28) clock override so the habit-streak grid,
// daily notes, and recurring completions all line up.
//
// Usage:
//   1. Back up your real data:    cp data.json /tmp/data.json.bak
//   2. Generate the demo:         node scripts/seed-demo.js
//   3. Open http://localhost:3366 — the app reads data.json on every request.
//   4. Restore real data:         cp /tmp/data.json.bak data.json
//
// data.json is .gitignored, so a stray demo seed is never committed. This
// script writes only to the repo root's data.json.
//
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const uid = () => crypto.randomBytes(8).toString('hex');
const nowIso = () => new Date().toISOString();
const dayKey = (d) => d.toISOString().slice(0, 10);

// Virtual "today" — pinned so screenshots are reproducible. The capture
// script uses Playwright's clock override to make the page believe this is
// the real time.
const today = new Date('2026-06-28T12:00:00.000Z');
const past = (n) => { const d = new Date(today); d.setUTCDate(d.getUTCDate() - n); return d; };

// ── Projects ──────────────────────────────────────────────────────────────
const pResearch = { id: uid(), name: 'Diffusion Models Research', color: '#8b6dff',
  template: '# {{date}}\n\n## Reading\n\n## Experiments\n\n## Open questions\n',
  autoCarry: true, createdAt: nowIso() };
const pOSS = { id: uid(), name: 'UltraNote OSS Release', color: '#6ecb6e',
  template: '# {{date}}\n\n## Shipped\n\n## In flight\n\n## Followups\n',
  autoCarry: true, createdAt: nowIso() };
const pHome = { id: uid(), name: 'Home & Life', color: '#f0a14e',
  template: '# {{date}}\n\n## Errands\n\n## Calls\n\n## Notes\n',
  autoCarry: false, createdAt: nowIso() };

// ── Notebooks + pages ─────────────────────────────────────────────────────
const nbProbML = { id: uid(), title: 'Course: Probabilistic ML', system: false, createdAt: nowIso() };
const nbDDIA   = { id: uid(), title: 'Book: DDIA', system: false, createdAt: nowIso() };

const pageL1 = { id: uid(), title: 'L1 — What is a generative model?', type: 'page', notebookId: nbProbML.id,
  content: '# L1 — What is a generative model?\n\nGoal: estimate $p(x)$ from samples, then **sample new $x$**.\n\n- Discriminative: $p(y|x)$\n- Generative: $p(x)$ or $p(x,y)$\n\nSee [[Score matching]] for a modern alternative to MLE.\n',
  createdAt: nowIso(), updatedAt: nowIso() };
const pageScore = { id: uid(), title: 'Score matching', type: 'page', notebookId: nbProbML.id,
  content: '# Score matching\n\nLearn $s_\\theta(x) \\approx \\nabla_x \\log p(x)$ directly.\n\n```python\nloss = ((s_theta(x) + grad_log_q(x_perturbed))**2).mean()\n```\n\nConnects directly to [[DDPM — Ho et al. 2020]] in the variance-preserving limit.\n',
  createdAt: nowIso(), updatedAt: nowIso() };
const pageDiffusion = { id: uid(), title: 'Diffusion intuition', type: 'page', notebookId: nbProbML.id,
  content: '# Diffusion intuition\n\nForward: gradually destroy structure with Gaussian noise.\nReverse: learn to *undo* one noise step.\n\nSee [[L1 — What is a generative model?]] and [[Score matching]].\n',
  createdAt: nowIso(), updatedAt: nowIso() };
const pageDDIA1 = { id: uid(), title: 'Ch.1 Reliable, Scalable, Maintainable', type: 'page', notebookId: nbDDIA.id,
  content: '# Ch.1 — Three big pillars\n\n- **Reliability**: tolerate faults, both hw and human.\n- **Scalability**: handle growth in load.\n- **Maintainability**: ops, evolvability, simplicity.\n',
  createdAt: nowIso(), updatedAt: nowIso() };

// ── Project notes ─────────────────────────────────────────────────────────
const projNotes = [
  { id: uid(), title: 'DDPM — Ho et al. 2020', type: 'note', projectId: pResearch.id,
    content: '# DDPM\n\nKey loss is a simple denoising MSE.\n\nRelates to [[Score matching]] in the small-noise limit.\n',
    tags: ['paper'], createdAt: past(3).toISOString(), updatedAt: past(2).toISOString() },
  { id: uid(), title: 'Classifier-free guidance — Ho & Salimans 2022', type: 'note', projectId: pResearch.id,
    content: '# CFG\n\nDrop the class label with prob $p$, then at sample time:\n\n$$\\tilde\\epsilon = (1+w)\\epsilon_c - w\\epsilon_\\emptyset$$\n\nFollows from [[DDPM — Ho et al. 2020]].\n',
    tags: ['paper'], createdAt: past(2).toISOString(), updatedAt: past(1).toISOString() },
  { id: uid(), title: 'v108 retro: back-button + reload persistence', type: 'note', projectId: pOSS.id,
    content: '# v108 retro\n\n- History stack works; reload preserves view.\n- Next: [[Mobile FAB ideas]].\n',
    tags: ['retro'], createdAt: past(1).toISOString(), updatedAt: nowIso() },
  { id: uid(), title: 'Mobile FAB ideas', type: 'note', projectId: pOSS.id,
    content: '# FAB ideas\n\n- Long-press = scratchpad shortcut.\n- Pull-to-refresh on Today.\n\nFollow-up to [[v108 retro: back-button + reload persistence]].\n',
    tags: ['mobile'], createdAt: past(1).toISOString(), updatedAt: nowIso() },
  { id: uid(), title: 'PWA over Tailscale', type: 'note', projectId: pOSS.id,
    content: '# PWA over Tailscale\n\nServe app over `ts.example.ts.net`, install on phone.\n\nRelates to [[Mobile FAB ideas]] and [[v108 retro: back-button + reload persistence]].\n',
    tags: ['mobile','deploy'], createdAt: past(0).toISOString(), updatedAt: nowIso() },
];

// ── Ideas ─────────────────────────────────────────────────────────────────
const ideas = [
  { id: uid(), title: 'Voice → outline plugin', type: 'idea',
    content: 'Whisper local model, dump structured outline into Today scratchpad.', tags: ['ai'],
    createdAt: past(4).toISOString(), updatedAt: past(4).toISOString() },
  { id: uid(), title: 'Weekly digest email', type: 'idea',
    content: 'Friday 6pm: stats + done list + next-week plan.', tags: ['weekly'],
    createdAt: past(2).toISOString(), updatedAt: past(2).toISOString() },
  { id: uid(), title: 'Pomodoro mode on Today', type: 'idea',
    content: '25/5 inline timer next to the active task.', tags: ['focus'],
    createdAt: past(0).toISOString(), updatedAt: past(0).toISOString() },
];

// ── Daily notes ───────────────────────────────────────────────────────────
const dailyToday = { id: uid(), title: dayKey(today), type: 'daily', dateIndex: dayKey(today),
  content: `# ${dayKey(today)}\n\n## Top 3\n1. Ship v108 release notes\n2. Finish CFG note\n3. Recurring-task seeder for screenshots\n\n## Notes\n- Reviewed the new Map shot — finally has edges.\n- Pair with screenshot capture flow.\n\n## Journal\nGreat focus block this morning. Map page finally shows the wiki-link graph the way it should.\n`,
  journal: 'Great focus block this morning. Map page finally shows the wiki-link graph the way it should.',
  mood: '😊',
  createdAt: nowIso(), updatedAt: nowIso() };

const journalLines = [
  ['🙂', 'Solid day. Got CFG note past the messy stage; ready to ship.'],
  ['😊', 'Great pairing session. Backlog parking-lot pattern finally clicked.'],
  ['😐', 'Slow morning. Recovered in the afternoon with the topic-map work.'],
  ['😊', 'Best day of the week — research inbox at zero, three papers triaged.'],
  ['😔', 'Tired. Logged the unfinished tasks and called it.'],
];
const pastDailies = journalLines.map(([mood, journal], i) => {
  const d = past(i + 1);
  return { id: uid(), title: dayKey(d), type: 'daily', dateIndex: dayKey(d),
    content: `# ${dayKey(d)}\n\n## Top 3\n- (rolled to today)\n\n## Journal\n${journal}\n`,
    journal, mood, createdAt: d.toISOString(), updatedAt: d.toISOString() };
});

// ── Soft-deleted notes (Review → Trash) ───────────────────────────────────
const deletedNotes = [
  { id: uid(), title: 'Untitled', type: 'note', content: 'random clipboard junk',
    createdAt: past(10).toISOString(), updatedAt: past(10).toISOString(), deletedAt: past(2).toISOString() },
  { id: uid(), title: 'Old experiment plan (superseded)', type: 'note', projectId: pResearch.id,
    content: 'Replaced by the CFG note.',
    createdAt: past(7).toISOString(), updatedAt: past(5).toISOString(), deletedAt: past(1).toISOString() },
  { id: uid(), title: 'Stale link dump', type: 'note', content: '- (empty)',
    createdAt: past(15).toISOString(), updatedAt: past(15).toISOString(), deletedAt: past(3).toISOString() },
];

// ── Tasks ─────────────────────────────────────────────────────────────────
const tasks = [
  { id: uid(), title: 'Ship v108 release notes', status: 'TODO', projectId: pOSS.id, noteId: dailyToday.id,
    due: dayKey(today), priority: 'high', createdAt: nowIso(), completedAt: null, deletedAt: null },
  { id: uid(), title: 'Finish classifier-free guidance note', status: 'TODO', projectId: pResearch.id, noteId: dailyToday.id,
    due: dayKey(today), priority: 'high', createdAt: nowIso(), completedAt: null, deletedAt: null },
  { id: uid(), title: 'Triage research inbox (3 items)', status: 'TODO', projectId: pResearch.id, noteId: dailyToday.id,
    due: dayKey(today), priority: 'medium', createdAt: nowIso(), completedAt: null, deletedAt: null },
  { id: uid(), title: 'Renew passport — book appt', status: 'TODO', projectId: pHome.id, noteId: dailyToday.id,
    due: dayKey(past(-2)), priority: 'medium', createdAt: nowIso(), completedAt: null, deletedAt: null },
  { id: uid(), title: 'Read DDIA Ch.2', status: 'TODO', projectId: null, noteId: dailyToday.id,
    due: dayKey(today), priority: 'low', createdAt: nowIso(), completedAt: null, deletedAt: null },
  { id: uid(), title: 'Reply to PR review comments', status: 'TODO', projectId: pOSS.id, noteId: dailyToday.id,
    due: dayKey(today), priority: 'high', createdAt: nowIso(), completedAt: null, deletedAt: null },
  { id: uid(), title: 'Pick up groceries', status: 'TODO', projectId: pHome.id, noteId: dailyToday.id,
    due: dayKey(today), priority: 'low', createdAt: nowIso(), completedAt: null, deletedAt: null },

  // Backlog (Today's parking lot — needs noteId+carriedToNoteId for project items)
  { id: uid(), title: 'Write blog post: "How I use UltraNote"', status: 'BACKLOG',
    projectId: pOSS.id, noteId: dailyToday.id, carriedToNoteId: dailyToday.id, due: null, priority: 'low',
    createdAt: nowIso(), completedAt: null, deletedAt: null },
  { id: uid(), title: 'Investigate Mermaid diagram support', status: 'BACKLOG',
    projectId: pOSS.id, noteId: dailyToday.id, carriedToNoteId: dailyToday.id, due: null, priority: 'medium',
    createdAt: nowIso(), completedAt: null, deletedAt: null },
  { id: uid(), title: 'Explore LoRA fine-tuning on diffusion U-Net', status: 'BACKLOG',
    projectId: pResearch.id, noteId: dailyToday.id, carriedToNoteId: dailyToday.id, due: null, priority: 'medium',
    createdAt: nowIso(), completedAt: null, deletedAt: null },
  { id: uid(), title: 'Reorganize garage', status: 'BACKLOG',
    projectId: pHome.id, noteId: dailyToday.id, carriedToNoteId: dailyToday.id, due: null, priority: 'low',
    createdAt: nowIso(), completedAt: null, deletedAt: null },

  // Soft-deleted tasks
  { id: uid(), title: 'Old task: try a Notion import', status: 'TODO', projectId: null, noteId: null,
    due: null, priority: 'low', createdAt: past(8).toISOString(), completedAt: null, deletedAt: past(2).toISOString() },
  { id: uid(), title: 'Dead-end: rewrite editor in Svelte', status: 'TODO', projectId: pOSS.id, noteId: null,
    due: null, priority: 'low', createdAt: past(12).toISOString(), completedAt: null, deletedAt: past(1).toISOString() },
];

// Unfinished-prior tasks: TODO on past dailies → "Unfinished from previous days"
['Set up nightly data.json backup', 'Refactor template picker modal',
 'Email Sam re: review', 'Buy birthday card'].forEach((title, i) => {
  tasks.push({
    id: uid(), title, status: 'TODO', projectId: null,
    noteId: pastDailies[i].id, due: dayKey(past(i + 1)),
    priority: i % 2 === 0 ? 'medium' : 'low',
    createdAt: past(i + 1).toISOString(), completedAt: null, deletedAt: null,
  });
});

// ── Monthly recurring habits + completions ────────────────────────────────
// `days: []` means "every day"; otherwise a subset of 0..6 (Sun..Sat).
// `completions[YYYY-MM-DD] = true` is the per-date flag the Habit Streak grid
// renders. We populate one month worth so the grid is visually full.
const monthKey = dayKey(today).slice(0, 7);
const todayDom = today.getUTCDate();
const habits = [
  { title: '🏃 Morning workout', days: [], pattern: 'most' },
  { title: '🧘 Meditate 10 min', days: [], pattern: 'strong' },
  { title: '📖 Read 30 min',    days: [1,2,3,4,5], pattern: 'weekdays-good' },
  { title: '✍️ Weekly review',   days: [0], pattern: 'weekly-sun' },
  { title: '💧 Drink 8 cups water', days: [], pattern: 'spotty' },
];
const monthly = habits.map(h => {
  const completions = {};
  for (let i = 0; i < todayDom; i++) {
    const d = past(i);
    if (h.days.length && !h.days.includes(d.getUTCDay())) continue;
    let done;
    switch (h.pattern) {
      case 'most':          done = (i % 7 !== 3); break;
      case 'strong':        done = (i < 14) || (i % 8 !== 0); break;
      case 'weekdays-good': done = (i % 9 !== 0); break;
      case 'weekly-sun':    done = true; break;
      case 'spotty':        done = [0,2,4,5,7,10,12,15,17,19,22,24,27].includes(i); break;
    }
    if (done) completions[dayKey(d)] = true;
  }
  return {
    id: uid(), title: h.title, days: h.days, month: monthKey, type: 'monthly_task',
    description: '', subtasks: [], tags: [], completions,
    createdAt: past(todayDom).toISOString(), updatedAt: nowIso(),
  };
});

// ── Links ─────────────────────────────────────────────────────────────────
const links = [
  { id: uid(), title: 'Diffusion Models — Lilian Weng', url: 'https://lilianweng.github.io/posts/2021-07-11-diffusion-models/',
    tags: ['research','diffusion'], pinned: true, note: 'Best single-page overview I have found.',
    createdAt: past(20).toISOString(), updatedAt: past(20).toISOString() },
  { id: uid(), title: 'The Annotated Diffusion Model', url: 'https://huggingface.co/blog/annotated-diffusion',
    tags: ['research','code'], pinned: true, note: 'Walks through the code with the math.',
    createdAt: past(15).toISOString(), updatedAt: past(15).toISOString() },
  { id: uid(), title: 'KaTeX docs', url: 'https://katex.org/docs/supported.html',
    tags: ['ref'], pinned: false, note: '', createdAt: past(10).toISOString(), updatedAt: past(10).toISOString() },
  { id: uid(), title: 'PM2 process manager', url: 'https://pm2.keymetrics.io/',
    tags: ['ops'], pinned: false, note: 'Used for the ultranote service.',
    createdAt: past(8).toISOString(), updatedAt: past(8).toISOString() },
  { id: uid(), title: 'marked.js', url: 'https://marked.js.org/',
    tags: ['ref'], pinned: false, note: '', createdAt: past(6).toISOString(), updatedAt: past(6).toISOString() },
  { id: uid(), title: 'highlight.js languages', url: 'https://highlightjs.org/static/demo/',
    tags: ['ref'], pinned: false, note: '', createdAt: past(3).toISOString(), updatedAt: past(3).toISOString() },
];

// ── Resolve [[wiki-links]] → note.links arrays (Map needs these) ──────────
const allNotes = [dailyToday, ...pastDailies, ...projNotes, ...ideas,
  pageL1, pageScore, pageDiffusion, pageDDIA1, ...deletedNotes];
const titleIdx = new Map();
for (const n of allNotes) {
  if (n.deletedAt) continue;
  const k = (n.title || '').trim().toLowerCase();
  if (k && !titleIdx.has(k)) titleIdx.set(k, n.id);
}
for (const n of allNotes) {
  if (n.deletedAt || !n.content) continue;
  const out = new Set();
  const re = /\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/g;
  let m;
  while ((m = re.exec(n.content)) !== null) {
    const id = titleIdx.get(m[1].trim().toLowerCase());
    if (id && id !== n.id) out.add(id);
  }
  n.links = Array.from(out);
}

// ── Assemble + write ──────────────────────────────────────────────────────
const db = {
  notes: allNotes,
  tasks,
  projects: [pResearch, pOSS, pHome],
  notebooks: [nbProbML, nbDDIA],
  links,
  monthly,
  templates: [
    { id: uid(), name: 'Meeting notes', body: '# {{title}}\n\n## Attendees\n\n## Decisions\n\n## Action items\n' },
    { id: uid(), name: 'Weekly review', body: '# Weekly review — {{date}}\n\n## What went well\n\n## What did not\n\n## Next week\n' },
  ],
  settings: { seenTip: true },
  activity: [],
};

const target = path.resolve(__dirname, '..', 'data.json');
fs.writeFileSync(target, JSON.stringify(db, null, 2));

console.log('Wrote', target);
console.log('seeded:',
  'notes=' + allNotes.length,
  '(daily=' + (1 + pastDailies.length) +
  ', project=' + projNotes.length +
  ', idea=' + ideas.length +
  ', page=4, deleted=' + deletedNotes.length + ')',
  'tasks=' + tasks.length,
  '(backlog=' + tasks.filter(t => t.status === 'BACKLOG').length +
  ', deleted=' + tasks.filter(t => t.deletedAt).length + ')',
  'projects=3 notebooks=2 links=' + links.length,
  'monthly=' + monthly.length);
