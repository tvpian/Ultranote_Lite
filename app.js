// This file contains all the JavaScript logic for UltraNote Lite.
// Extracted from the original index.html to improve modularity and maintainability.

// --- Permanent global Ctrl+S interceptor (registered once, never removed) ---
// Calls window._doSaveNote if a note editor is open.
// This fires at capture phase before any element-level handler or browser default.
(function() {
  function _globalCtrlS(e) {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 's' || e.key === 'S' || e.code === 'KeyS')) {
      if (typeof window._doSaveNote === 'function') {
        e.preventDefault();
        e.stopImmediatePropagation();
        window._doSaveNote();
      }
    }
  }
  function _globalCtrlL(e) {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'l' || e.key === 'L' || e.code === 'KeyL')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      window.location.href = '/logout';
    }
  }
  document.addEventListener('keydown', _globalCtrlS, { capture: true, passive: false });
  window.addEventListener('keydown', _globalCtrlS, { capture: true, passive: false });
  document.addEventListener('keydown', _globalCtrlL, { capture: true, passive: false });
  window.addEventListener('keydown', _globalCtrlL, { capture: true, passive: false });
})();

// --- Local-first store (now via backend) ---
const storeKey = "ultranote-lite"; // kept for compatibility
const nowISO = () => new Date().toISOString();
// Use local date rather than UTC to avoid premature day roll‑over based on timezone.
const todayKey = () => {
  const now = new Date();
  // Adjust for timezone offset to get local date component in ISO format
  const tzOffsetMs = now.getTimezoneOffset() * 60000;
  const localDate = new Date(now.getTime() - tzOffsetMs).toISOString().slice(0, 10);
  return localDate;
};

// Helper function to format date strings without timezone issues
const formatDateString = (dateStr) => {
  if (!dateStr) return '';
  // If it's in YYYY-MM-DD format, create a local date to avoid timezone shifts
  if (dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
    const [year, month, day] = dateStr.split('-');
    const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    return date.toLocaleDateString();
  }
  // Fallback for other date formats
  return new Date(dateStr).toLocaleDateString();
};
// NEW: selected daily date (default today)
window.todayKey = todayKey;
let selectedDailyDate = todayKey();
// Independent month selection for the Monthly planning view.
// Kept separate from selectedDailyDate so navigating daily notes never
// causes the monthly view to show the wrong month.
let selectedMonthKey = todayKey().slice(0,7);
function createDailyNoteFor(dateKey, contentOverride){
  const exists = db.notes.find(n=>n.type==='daily' && n.dateIndex===dateKey && !n.deletedAt);
  if(exists) return exists;
  const isToday = dateKey === todayKey();
  const templateContent = contentOverride !== undefined ? contentOverride : (db.settings.dailyTemplate || "# Top 3\n- [ ] \n- [ ] \n- [ ] \n\n## Tasks\n\n## Journal\n\n## Wins\n");
  const daily = createNote({title:`${dateKey} — Daily`, type:'daily', dateIndex:dateKey, content:templateContent});
  if(isToday){
    // NOTE: rollover NO LONGER moves yesterday's incomplete tasks onto today's
    // daily note. They stay attached to their original day and surface in the
    // 'Unfinished from previous days' panel on Today (which already lets you
    // tick them off or dismiss them). This preserves day-of-origin attribution
    // and keeps today's task list focused on what you actually planned today.
    // The db.settings.rollover toggle is preserved for backward compatibility
    // but is now effectively a no-op for the auto-move behavior.
    if(db.settings.autoCarryTasks){
      const priorities={high:3,medium:2,low:1};
      const projectPool = db.tasks.filter(t=> t.projectId && !t.noteId && t.status==='TODO')
        .sort((a,b)=>(priorities[b.priority]||2)-(priorities[a.priority]||2))
        .slice(0,5);
      // Move existing project tasks to the new daily note rather than cloning them.
      // carriedToNoteId lets the daily filter let these through even though they
      // still have a projectId (the leak guard otherwise hides any project task).
      projectPool.forEach(t=>{
        t.noteId = daily.id;
        t.carriedToNoteId = daily.id;
        t.updatedAt = nowISO();
      });
      if(projectPool.length) save();
    }
  }
  // Insert recurring monthly tasks for the given date. Delegated to
  // syncMonthlyTasksToDaily which is also called on existing notes in renderToday.
  syncMonthlyTasksToDaily(daily, dateKey);
  return daily;
}
window.createDailyNoteFor = createDailyNoteFor;
// NEW: unified handler to open or create the selected daily note
function createOrOpenDaily(){
  const today = todayKey();
  // Always snap to today when the user hits this button
  selectedDailyDate = today;
  // Auto-create if it doesn't exist yet — no prompting needed for today
  if (!db.notes.find(n => n.type === 'daily' && n.dateIndex === today && !n.deletedAt)) {
    createDailyNoteFor(today);
  }
  route = 'today';
  render();
}

// Backend persistence helpers
async function fetchDB(){
  try{
    const r = await fetch('/api/db');
    if(!r.ok) {
      console.error(`❌ API request failed: ${r.status} ${r.statusText}`);
      if (r.status === 302 || r.status === 401) {
        console.error('🔒 Session expired or not authenticated - redirected to login');
      }
      throw new Error(`Fetch failed: ${r.status}`);
    }
    const text = await r.text();
    if (!text) {
      console.warn('📭 Empty response from server');
      return null;
    }
    const data = JSON.parse(text);
    if(!data || !Object.keys(data).length) return null;
    return data;
  }catch(e){ 
    if (e.name === 'SyntaxError') {
      console.error('❌ Server returned non-JSON response (likely HTML login page)');
      console.error('🔒 Session authentication problem - check if you\'re logged in');
    }
    console.warn('Fetch DB error', e); 
    return null; 
  }
}
async function persistDB(){
  try {
    // Persist the current local DB to the server. We rely on the server to merge
    // concurrent updates from other devices. Do not merge remote changes into the
    // outgoing snapshot here, as that would reintroduce items that the user
    // intentionally deleted on this device.
    const resp = await fetch('/api/db', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Server-side CSRF gate: same-origin XHR is the only origin a browser
        // will let set this custom header without a CORS preflight, so its
        // presence proves the request originated from our own JS.
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: JSON.stringify(db)
    });
    // Server now returns the merged result so this device immediately picks up any
    // records added by other clients since our last fetch — without waiting for the
    // next autosync tick. Guard: never interrupt an active editing session.
    if (resp && resp.ok) {
      const result = await resp.json().catch(() => null);
      if (result && result.db && typeof result.db === 'object') {
        const notEditing = !window._editorDirty && !window._isTypingInForm &&
                           !(window.__typingUntil && Date.now() < window.__typingUntil);
        if (notEditing) {
          const COLS = ['notes','tasks','projects','templates','links','monthly','notebooks','activity','agentPrompts'];
          COLS.forEach(k => {
            if (!Array.isArray(result.db[k])) return;
            if (!Array.isArray(db[k])) { db[k] = result.db[k]; return; }
            // Update items in-place so open closures (e.g. openNote's `n` reference) stay valid.
            // Replacing the whole array would detach the captured `n` and lose unsaved attachment pushes.
            // SAFETY: only update a local item from the server response if the server version is
            // strictly newer. This prevents a stale POST response (sent before a sketch/attachment
            // was added) from overwriting the freshly-mutated local item.
            result.db[k].forEach(serverItem => {
              const idx = db[k].findIndex(x => x.id === serverItem.id);
              if (idx >= 0) {
                const localTs  = Date.parse(db[k][idx].updatedAt  || db[k][idx].createdAt  || 0);
                const serverTs = Date.parse(serverItem.updatedAt || serverItem.createdAt || 0);
                if (serverTs > localTs) {
                  Object.assign(db[k][idx], serverItem);
                }
              } else {
                db[k].push(serverItem);
              }
            });
          });
          if (result.db.settings) db.settings = { ...result.db.settings, ...db.settings };
          // If a note is open its attachments may have been updated by another device.
          // Refresh the list without blowing away the editor.
          if (window._openNoteId && typeof window._renderAttachments === 'function') {
            window._renderAttachments();
          }
        }
      }
    }
    window.db = db;
  } catch (e) {
    console.error('Persist failed', e);
  }
  // Note: we deliberately do NOT mirror the entire db to localStorage anymore.
  // The DB is multi-MB (attachments are base64 inside notes); setItem silently
  // throws QuotaExceededError once it crosses ~5MB, leaving a stale stub copy
  // that later overwrites real server data on next init. The server is the
  // single source of truth — localStorage is only used as an offline fallback,
  // and only for tiny metadata (handled in persistDB success path below).
  try {
    // Lightweight "last successful sync" pointer so an offline boot can
    // surface a useful banner without exposing stale full-DB data.
    localStorage.setItem(storeKey + ':lastSync', new Date().toISOString());
  } catch(err) { /* ignore */ }
}

// Upload a File/Blob to the out-of-band attachment store (server writes it to
// ./attachments/<id>.bin, see POST /api/attachments in server.js) and return
// { id, name, type, size } — no base64 payload kept around in memory or in
// `db` afterwards. This is what keeps large images/audio/video out of
// data.json and out of every save()/persistDB() round-trip: the note only
// ever stores a small pointer record, and the browser fetches the actual
// bytes as a normal cacheable HTTP resource (GET /api/attachments/:id) when
// it's actually rendered, instead of the whole multi-MB DB blob having to be
// parsed/diffed/saved on every keystroke.
function readFileAsDataURL(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = ev => resolve(ev.target.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
async function uploadAttachmentFile(file){
  const dataUrl = await readFileAsDataURL(file);
  const id = uid();
  const resp = await fetch('/api/attachments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify({ id, name: file.name, type: file.type, data: dataUrl })
  });
  if (!resp.ok) throw new Error(`Attachment upload failed: ${resp.status}`);
  const json = await resp.json();
  return { id: json.id, name: json.name, type: json.type, size: json.size };
}
// Resolve the URL to use for an attachment record, whichever shape it's in:
// legacy records still have an inline base64 `data` field; current records
// only have an `id` and are served from disk via /api/attachments/:id.
function attachmentSrc(att){
  return att.data || ('/api/attachments/' + encodeURIComponent(att.id));
}

const seed = {
  version:2,
  settings:{rollover:true, seenTip:false, autoCarryTasks:true, autoReload:false, dailyTemplate:"# Top 3\n- [ ] \n- [ ] \n- [ ] \n\n## Tasks\n\n## Journal\n\n## Wins\n"},
  projects:[{id:"p1", name:"Sample Project", createdAt:nowISO()}],
  notes:[
    {id:"n1", title:"2025-01-01 — Daily", content:"# Top 3\n- [ ] Example task A\n- [ ] Example task B\n\n## Journal\nTried UltraNote Lite.\n", tags:[], projectId:null, dateIndex:"2025-01-01", type:"daily", createdAt:nowISO(), updatedAt:nowISO(), pinned:false},
    {id:"n2", title:"Project Plan – Sample Project", content:"## Goals\n- Define MVP\n- Ship static site\n\n## Next\n- [ ] Sketch UI\n- [ ] Create first note\n", tags:["plan"], projectId:"p1", dateIndex:null, type:"note", createdAt:nowISO(), updatedAt:nowISO(), pinned:false},
    {id:"n3", title:"Idea: Tablet stylus block", content:"- Add sketch canvas block\n- Save as SVG\n- Optional OCR later", tags:["idea"], projectId:null, dateIndex:null, type:"idea", createdAt:nowISO(), updatedAt:nowISO(), pinned:false}
  ],
  tasks:[{id:"t1", title:"Try adding a task on Today page", status:"TODO", due:null, noteId:"n1", projectId:null, createdAt:nowISO(), completedAt:null}],
  templates:[
    {id:"tpl1", name:"Meeting Notes", content:"# Meeting: [Title]\n**Date:** [Date]\n**Attendees:** \n\n## Agenda\n- \n\n## Notes\n\n## Action Items\n- [ ] \n\n## Next Steps\n"},
    {id:"tpl2", name:"Project Plan", content:"# [Project Name]\n\n## Objective\n\n## Goals\n- \n\n## Milestones\n- [ ] \n\n## Resources\n\n## Risks\n\n## Success Metrics\n"},
    {id:"tpl3", name:"Weekly Review", content:"# Week of [Date]\n\n## Wins\n- \n\n## Challenges\n- \n\n## Lessons Learned\n- \n\n## Next Week Focus\n- [ ] \n"},
    {id:"tpl_paper", name:"Research Paper", content:"# [Year] [Author] — [Short Title]\n\n**Citation:** \n**Link / DOI:** \n**Venue:** \n**Read on:** [Date]\n**Tags:** #\n\n## Why I read it\n\n## TL;DR (1 sentence)\n\n## Key ideas\n- \n- \n- \n\n## Method (1 paragraph)\n\n## Results that matter\n- \n\n## Limitations / pushback\n- \n\n## ✨ Inspirations for my work\n- \n\n## Open questions\n- \n\n## Related work to chase\n- \n"}
  ],
  // NEW collection for saved links
  links:[
    {id:"l1", title:"UltraNote Example", url:"https://example.com", tags:["ref"], pinned:true, status:"NEW", createdAt:nowISO(), updatedAt:nowISO()}
  ]
  ,
  // NEW: recurring monthly tasks for planning (empty by default)
  monthly: [],
  // Structured study/reference notebooks
  notebooks: [],
  // Built-in, read-only reference prompts (e.g. system prompts for external
  // AI agents). Deliberately NOT a notebook — this is a fixed, immutable
  // library surfaced inside the Notebooks tool, separate from the user's
  // own notebooks list.
  agentPrompts: []
};
const defaults = seed;

// Full system-prompt text for an external AI note-taking agent, tuned so its
// output is UltraNote-markdown-friendly (renders correctly with this app's
// marked.js + wiki-link/KaTeX/Mermaid pipeline). Kept as a Notebook page (see
// ensureAgentPromptsNotebook() below) purely as a copy-paste reference —
// nothing in the app parses or runs this text.
const LECTURE_AGENT_PROMPT = [
  "You are my lecture note-taking and learning agent.",
  "",
  "I will provide a YouTube lecture, transcript, or live notes. Your job is not to simply summarize it. Your job is to help me retain, understand, and reuse the ideas.",
  "",
  "Create notes using the following structure:",
  "",
  "# 1. Core Thesis",
  "",
  "Explain the lecture's central idea in 1–3 sentences.",
  "",
  "Answer:",
  "",
  "- What is this lecture really about?",
  "- What problem, question, or tension is it addressing?",
  "- Why does it matter?",
  "",
  "# 2. Concept Map",
  "",
  "Identify the main concepts and show how they relate.",
  "",
  "For each concept, include:",
  "",
  "- Simple explanation",
  "- Why it matters",
  "- How it connects to other concepts",
  "- A concrete example or analogy",
  "",
  "If the relationships between concepts are non-trivial (more than a simple",
  "list), ALSO render them as a Mermaid flowchart so the structure is visible",
  "at a glance, e.g.:",
  "",
  "```mermaid",
  "flowchart LR",
  "  A[Concept A] --> B[Concept B]",
  "  A --> C[Concept C]",
  "```",
  "",
  "# 3. High-Retention Notes",
  "",
  "Extract only the ideas worth remembering.",
  "",
  "For every important point, write it in this format:",
  "",
  "**Idea:**",
  "**Why it matters:**",
  "**Example:**",
  "**What I should remember:**",
  "",
  "Avoid shallow bullet-point summaries. Prioritize depth over quantity.",
  "",
  "# 4. Mental Models and Frameworks",
  "",
  "Identify any reusable frameworks, principles, decision rules, or patterns from the lecture.",
  "",
  "For each one, explain:",
  "",
  "- When to use it",
  "- How to apply it",
  "- What mistakes to avoid",
  "- How it generalizes beyond this lecture",
  "",
  "# 5. Active Recall Questions",
  "",
  "Generate questions that test whether I actually understood the lecture.",
  "",
  "Include:",
  "",
  "- 5 basic recall questions",
  "- 5 conceptual understanding questions",
  "- 5 application questions",
  "- 3 \"explain like I'm teaching someone else\" questions",
  "- 3 questions that expose possible misunderstandings",
  "",
  "Do not include answers immediately unless I ask for them.",
  "",
  "# 6. Confusion Tracker",
  "",
  "Identify places where the lecture may be confusing, incomplete, vague, or easy to misunderstand.",
  "",
  "For each confusion point:",
  "",
  "- Explain what might be unclear",
  "- Provide a clearer explanation",
  "- Give an example",
  "- Suggest what I should look up next if needed",
  "",
  "# 7. Examples, Stories, and Evidence",
  "",
  "Capture the strongest examples, case studies, experiments, demonstrations, or stories used in the lecture.",
  "",
  "For each:",
  "",
  "- What was the example?",
  "- What idea did it support?",
  "- Why was it persuasive?",
  "- Could there be another interpretation?",
  "",
  "# 8. Practical Applications",
  "",
  "Translate the lecture into practical use.",
  "",
  "Answer:",
  "",
  "- How can I apply this in my work, research, writing, decision-making, or projects?",
  "- What would a small experiment or implementation look like?",
  "- What would a more advanced version look like?",
  "- What could be modularized into a reusable system, checklist, prompt, script, or workflow?",
  "",
  "# 9. Connections to My Existing Knowledge",
  "",
  "Connect this lecture to related ideas, especially in:",
  "",
  "- AI",
  "- robotics",
  "- research",
  "- engineering systems",
  "- product thinking",
  "- human behavior",
  "- philosophy",
  "- writing or communication",
  "",
  "Also identify whether the lecture confirms, challenges, or updates what I may already believe.",
  "",
  "If a concept clearly maps to an existing note/topic/person I've likely",
  "already written about, reference it as a wiki-link: [[Note Title]]. Only",
  "use this for genuinely likely matches (project names, recurring topics,",
  "people) — don't invent links to notes that probably don't exist.",
  "",
  "# 10. Compression Ladder",
  "",
  "Summarize the lecture at four levels:",
  "",
  "**One sentence:**",
  "**One paragraph:**",
  "**Five key bullets:**",
  "**Detailed technical/conceptual summary:**",
  "",
  "# 11. Retention System",
  "",
  "Create a spaced repetition package from the lecture.",
  "",
  "Include:",
  "",
  "- Flashcards — format each as **Q:** ... **A:** ...",
  "- Cloze deletion cards — format as a sentence with the missing term wrapped",
  "  like this isn't natively supported, so instead write it as **Q:** The ___ effect explains why ... **A:** term",
  "- \"Why?\" questions",
  "- \"Compare and contrast\" questions",
  "- Real-world application prompts",
  "",
  "# 12. Final Takeaways",
  "",
  "End with:",
  "",
  "- The 3 most important ideas",
  "- The 3 ideas most likely to be forgotten",
  "- The 3 questions I should keep thinking about",
  "- One action I should take after watching this lecture — write this as a",
  "  checkable task: `- [ ] <action>`, so it can be tracked directly in the app.",
  "",
  "---",
  "",
  "## Output Formatting Rules (must follow — target app is UltraNote Lite)",
  "",
  "My notes app renders Markdown via marked.js (GitHub-Flavored Markdown) +",
  "DOMPurify sanitization, with a few custom extensions. Follow these rules",
  "exactly so the output renders correctly and nothing gets stripped or",
  "mangled:",
  "",
  "**Supported & encouraged:**",
  "- Headings #/##/### — use them for structure; they get anchor IDs.",
  "- **Bold**, _italic_ (`_text_` preferred over `*text*` to avoid ambiguity",
  "  with bullets), ~~strikethrough~~ (`~~text~~`).",
  "- Bullets: use `-` (not `*`) for list items, for consistency.",
  "- Numbered lists: `1. item`.",
  "- Task lists: `- [ ] task` / `- [x] done task` — exact spacing matters:",
  "  a space after `-`, and a single space inside the brackets.",
  "- Blockquotes: `> text`.",
  "- Inline code: `` `code` ``. Fenced code blocks: use triple backticks WITH",
  "  a language tag (e.g. ```python) for syntax highlighting.",
  "- Tables: standard GFM pipe syntax.",
  "- Links `[text](url)`, images `![alt](url)`.",
  "- Horizontal rule: `---` on its own line (used sparingly — see frontmatter",
  "  warning below).",
  "- Wiki-links: `[[Note Title]]` or `[[Note Title|display text]]` to",
  "  reference another note in the vault.",
  "- Math (KaTeX): inline `$x^2$`, block form must have `$$` alone on its own",
  "  line before and after the expression.",
  "- Diagrams: fenced code block with `mermaid` as the language.",
  "- Inline hashtags: `#tagname` anywhere in the text is auto-picked-up as a",
  "  tag (letters/numbers/-/_ only, no spaces — e.g. `#robot-learning`).",
  "",
  "**Avoid:**",
  "- No raw HTML tags — they get sanitized/stripped, so use markdown syntax",
  "  only, never `<div>`, `<b>`, etc.",
  "- No YAML frontmatter (`---` block at the very top) — a leading `---` is",
  "  parsed as a horizontal rule, not metadata. If you need to note metadata",
  "  (date, source, etc.), write it as a plain line, e.g. **Source:** ...",
  "- Don't stack multiple blank lines for spacing — one blank line between",
  "  blocks is enough and extra ones are collapsed anyway.",
  "",
  "Important behavior:",
  "",
  "- Do not over-summarize.",
  "- Do not preserve every detail.",
  "- Prioritize understanding, retention, and transfer.",
  "- Rewrite ideas in clear language.",
  "- Flag uncertainty instead of pretending everything is obvious.",
  "- Where useful, turn ideas into reusable templates, checklists, or frameworks."
].join("\n");

// Theme definitions. Each theme defines CSS variable values for our design tokens.
const THEMES = {
  dark: {
    '--bg': '#0b0f14',
    '--fg': '#e8eef7',
    '--muted': '#a9b6c6',
    '--card': '#161122',
    '--acc': '#8b6dff'
    ,
    '--border': '#281f3e',
    '--btn-bg': '#1c1430',
    '--btn-border': '#3a2a5a',
    '--pill-border': '#3a2e55',
    '--header-bg': '#110d1c',
    '--input-bg': '#14101f',
    '--input-border': '#2a2245'
    , '--btn-active-bg': '#181225'
    , '--kbd-border': '#4a3e6e'
  },
  light: {
    '--bg': '#f6f3fc',
    '--fg': '#0f172a',
    '--muted': '#64748b',
    '--card': '#ffffff',
    '--acc': '#2563eb',
    '--border': '#e2dafd',
    '--btn-bg': '#ffffff',
    '--btn-border': '#d8d0f0',
    '--pill-border': '#ccc4e2',
    '--header-bg': 'rgba(243,246,251,0.88)',
    '--input-bg': '#ffffff',
    '--input-border': '#d8d0f0'
    , '--btn-active-bg': '#f3f0fd'
    , '--kbd-border': '#ccc4e2'
  }
};

// Apply the current theme by setting CSS variables on the root element.
function applyTheme(){
  const theme = (db && db.settings && db.settings.theme) ? db.settings.theme : 'dark';
  const vars = THEMES[theme] || THEMES.dark;
  const root = document.documentElement;
  Object.entries(vars).forEach(([key,val])=> root.style.setProperty(key, val));
  root.setAttribute('data-theme', theme);
}

// --- Restored runtime glue (was missing) ---
let db; // global in‑memory state
// Persist scratchpad draft text outside of render cycles. Without this,
// the scratchpad would reset whenever render() is called (e.g. when
// updating tasks), because the scratch textarea is recreated each time
// and its value is set from db.settings.scratchpad. We keep the most
// recent typed value here to restore it after each render. This helps
// avoid the "scratchpad refresh" problem described by users.
let scratchDraft = '';
// Globals to track which note is open and whether the user has unsaved edits.
// These help the background sync avoid interrupting a user who is actively editing.
// When a note is opened, `_openNoteId` is set to that note's id and `_editorDirty` is reset to false.
// When the user types in the note's title or content, `_editorDirty` becomes true. When the note is saved, it is reset to false.
window._openNoteId = null;
window._editorDirty = false;
// Session-level Set of IDs that have been permanently (hard) deleted.
// The autosync merge loop checks this to prevent deleted items from being
// resurrected by a stale server snapshot before persistDB() completes.
window._hardDeletedIds = new Set();
// Track when user is actively typing in forms to prevent background sync interference
window._isTypingInForm = false;
let _typingTimer = null;
function uid(){ return Math.random().toString(36).slice(2,10); }
// Debounced save – reduces write frequency. Also live-refreshes the
// due-banner so any code path that mutates t.due / t.status is reflected
// immediately without needing a full render() call.
let _saveTimer; function save(){
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(()=>persistDB(), 400);
  try { if (typeof refreshDueBanner === 'function') refreshDueBanner(); } catch(_){ }
}

// Rebuilds the #dueBanner element from current db.tasks. Safe to call from
// anywhere — no-ops if the element isn't in the DOM (e.g., not on Today).
function refreshDueBanner(){
  const banner = document.getElementById('dueBanner');
  if(!banner) return;
  const todayStr = todayKey();
  const allOpen = (db.tasks||[]).filter(t => t.status==='TODO' && !t.deletedAt && t.due);
  const overdueList  = allOpen.filter(t => t.due < todayStr);
  const dueTodayList = allOpen.filter(t => t.due === todayStr);
  if(!overdueList.length && !dueTodayList.length){ banner.innerHTML = ''; return; }
  const taskSource = t => {
    if(t.projectId){ const p = (db.projects||[]).find(p=>p.id===t.projectId); return p ? `project: ${htmlesc(p.name)}` : 'project'; }
    if(t.noteId){ const n = (db.notes||[]).find(n=>n.id===t.noteId); return n && n.dateIndex ? n.dateIndex : 'note'; }
    return 'no note';
  };
  const makeRows = (list, color) => list.map(t =>
    `<div style='margin-top:3px;display:flex;align-items:baseline;gap:4px;flex-wrap:wrap;'>
      <span style='color:${color};font-weight:600;font-size:11px;'>●</span>
      <span style='flex:1;min-width:0;word-break:break-word;'>${htmlesc(t.title)}</span>
      <span class='banner-source' style='font-size:10px;color:var(--muted);white-space:nowrap;'>${taskSource(t)}</span>
      <span style='font-size:10px;color:var(--muted);white-space:nowrap;'>${formatDateString(t.due)}</span>
    </div>`
  ).join('');
  let html = `<div style='padding:6px 10px;margin-bottom:4px;background:rgba(255,68,68,0.1);border:1px solid rgba(255,68,68,0.35);border-radius:6px;font-size:12px;'>`;
  if(overdueList.length)  html += `<div>⚠️ <strong style='color:#ff6666;'>${overdueList.length} overdue</strong></div>${makeRows(overdueList,'#ff6666')}`;
  if(dueTodayList.length) html += `<div style='margin-top:${overdueList.length?'6px':'0'};'>🔔 <strong style='color:#fbbf24;'>${dueTodayList.length} due today</strong></div>${makeRows(dueTodayList,'#fbbf24')}`;
  html += `</div>`;
  banner.innerHTML = html;
}

// Show inline "Saved ✓" next to the save button — pass the span id explicitly.
function showSavedToast(spanId) {
  const el = document.getElementById(spanId);
  if (!el) return;
  el.textContent = 'Saved ✓';
  clearTimeout(el._st);
  el._st = setTimeout(() => { el.textContent = ''; }, 2000);
}

// ------------------------------------------------------------------
// Reminder notifications
//
// The following helper schedules desktop notifications for tasks with due
// dates matching today's date. When the page loads, we request
// permission from the user. Once granted, we poll the tasks every
// minute and show a notification for each uncompleted task due today.
// Notifications are only fired once per task to avoid repeated alerts.

let _notifiedDueTasks = new Set();
function startDueTaskNotifications() {
  // Only proceed if the Notifications API is available
  if (typeof Notification === 'undefined') return;
  Notification.requestPermission().then((permission) => {
    if (permission !== 'granted') return;
    setInterval(() => {
      try {
        const todayStr = new Date().toISOString().slice(0, 10);
        db.tasks.forEach((t) => {
          if (
            t.due === todayStr &&
            t.status !== 'DONE' &&
            !_notifiedDueTasks.has(t.id)
          ) {
            new Notification('Task due today', { body: t.title });
            _notifiedDueTasks.add(t.id);
          }
        });
      } catch (err) {
        // Silently ignore any errors (e.g., db not ready)
      }
    }, 60000); // check every minute
  });
}

// ---------------------------------------------------------------------------
// migrateDB — canonicalise every existing record so the full schema is present
// on all entities. Safe to run on every boot: only writes back if something
// actually changed. This ensures any agent that reads db.* can rely on every
// field being present with a deterministic type (no missing-key surprises).
// ---------------------------------------------------------------------------
function migrateDB() {
  let dirty = false;
  // Ensure a field exists; never overwrites an existing value.
  function ensure(obj, key, val) {
    if (obj[key] === undefined) { obj[key] = val; dirty = true; }
  }

  // ── notes / pages / daily / ideas ─────────────────────────────────────────
  (db.notes || []).forEach(n => {
    ensure(n, 'type',        'note');
    ensure(n, 'tags',        []);
    ensure(n, 'attachments', []);
    ensure(n, 'links',       []);
    ensure(n, 'pinned',      false);
    ensure(n, 'projectId',   null);
    ensure(n, 'dateIndex',   null);
    ensure(n, 'deletedAt',   null);
    ensure(n, 'updatedAt',   n.createdAt || nowISO());
    if (n.type === 'page') {
      ensure(n, 'notebookId', null);
      ensure(n, 'sortOrder',  0);
    }
  });

  // ── tasks ─────────────────────────────────────────────────────────────────
  (db.tasks || []).forEach(t => {
    ensure(t, 'updatedAt',   t.createdAt || nowISO());
    ensure(t, 'tags',        []);
    ensure(t, 'description', '');
    ensure(t, 'subtasks',    []);
    ensure(t, 'priority',    'medium');
    ensure(t, 'deletedAt',   null);
    ensure(t, 'projectId',   null);
    ensure(t, 'noteId',      null);
    ensure(t, 'due',         null);
    ensure(t, 'completedAt', null);
  });

  // ── projects ──────────────────────────────────────────────────────────────
  (db.projects || []).forEach(p => {
    ensure(p, 'updatedAt',   p.createdAt || nowISO());
    ensure(p, 'description', '');
    ensure(p, 'tags',        []);
    ensure(p, 'color',       null);
    ensure(p, 'archivedAt',  null);
  });

  // ── templates ─────────────────────────────────────────────────────────────
  (db.templates || []).forEach(t => {
    ensure(t, 'updatedAt',   t.createdAt || nowISO());
    ensure(t, 'tags',        []);
    ensure(t, 'description', '');
  });
  // Inject built-in Research Paper template for existing installs if missing.
  if (Array.isArray(db.templates) && !db.templates.some(t => (t.name || '').toLowerCase() === 'research paper')) {
    db.templates.push({
      id: 'tpl_paper',
      name: 'Research Paper',
      content: "# [Year] [Author] — [Short Title]\n\n**Citation:** \n**Link / DOI:** \n**Venue:** \n**Read on:** [Date]\n**Tags:** #\n\n## Why I read it\n\n## TL;DR (1 sentence)\n\n## Key ideas\n- \n- \n- \n\n## Method (1 paragraph)\n\n## Results that matter\n- \n\n## Limitations / pushback\n- \n\n## ✨ Inspirations for my work\n- \n\n## Open questions\n- \n\n## Related work to chase\n- \n",
      tags: ['research', 'paper'],
      description: 'Atomic note per paper. Capture citation, TL;DR, key ideas, and (most importantly) inspirations for your own work.',
      createdAt: nowISO(),
      updatedAt: nowISO()
    });
    dirty = true;
  }

  // ── monthly recurring tasks ───────────────────────────────────────────────
  (db.monthly || []).forEach(m => {
    ensure(m, 'type',        'monthly_task');
    ensure(m, 'updatedAt',   m.createdAt || nowISO());
    ensure(m, 'tags',        []);
    ensure(m, 'description', '');
  });

  // ── notebooks ─────────────────────────────────────────────────────────────
  (db.notebooks || []).forEach(nb => {
    ensure(nb, 'tags',       []);
    ensure(nb, 'archivedAt', null);
    ensure(nb, 'updatedAt',  nb.createdAt || nowISO());
  });

  // One-time: seed the built-in, read-only "Agent Prompts" reference library
  // (e.g. the Lecture Note-Taking Agent system prompt) as an immutable entry
  // — deliberately NOT a Notebook, since that made it look like just another
  // item in the user's own notebooks list. It's surfaced instead as a fixed
  // "📌 Reference Prompts" section inside the Notebooks tool (see
  // renderNotebooks()). Also retires the earlier notebook/page-based version
  // of this content from an earlier iteration, if present.
  if (!db._seededAgentPrompts) {
    db.agentPrompts = db.agentPrompts || [];
    if (!db.agentPrompts.some(p => p.id === 'ap_lecture_agent')) {
      db.agentPrompts.push({
        id: 'ap_lecture_agent',
        title: 'Lecture Note-Taking & Learning Agent',
        // Shows only in the Notebooks tool — a general-purpose study/lecture
        // prompt has nothing to do with managing a coding project.
        scope: 'notebooks',
        content: LECTURE_AGENT_PROMPT,
        createdAt: nowISO(),
        updatedAt: nowISO()
      });
    }
    const oldNb = (db.notebooks || []).find(nb => nb.id === 'nb_agent_prompts');
    if (oldNb && !oldNb.deletedAt) oldNb.deletedAt = nowISO();
    const oldPage = (db.notes || []).find(n => n.id === 'note_lecture_agent_prompt');
    if (oldPage && !oldPage.deletedAt) oldPage.deletedAt = nowISO();
    db._seededAgentPrompts = true;
    dirty = true;
  }

  // One-time: seed the "Coding-Agent API Guide" reference entry. Unlike the
  // lecture-agent prompt, this one is NOT embedded as a string — it points
  // at AGENT_GUIDE.md (served as a static file by server.js, `express.
  // static(__dirname)`) via `sourceFile`, so the in-app copy always reflects
  // whatever is currently on disk instead of drifting out of sync with a
  // duplicated copy. Own flag (`_seededAgentGuidePrompt`) so this seed can
  // run independently of the lecture-agent one above.
  if (!db._seededAgentGuidePrompt) {
    db.agentPrompts = db.agentPrompts || [];
    if (!db.agentPrompts.some(p => p.id === 'ap_coding_agent_guide')) {
      db.agentPrompts.push({
        id: 'ap_coding_agent_guide',
        title: 'Coding-Agent API Guide',
        description: 'Drop into any project workspace so a coding agent can manage that project\u2019s tasks/notes via the UltraNote REST API.',
        // Shows only in the Projects tool — this guide is specifically about
        // managing a *project's* tasks/notes via the REST API, so surfacing
        // it inside Notebooks (an unrelated tool) would be unintuitive.
        scope: 'projects',
        sourceFile: 'AGENT_GUIDE.md',
        createdAt: nowISO(),
        updatedAt: nowISO()
      });
    }
    db._seededAgentGuidePrompt = true;
    dirty = true;
  }

  // Backfill: any agentPrompts entry missing `scope` (e.g. seeded by an
  // earlier version of this app, before per-tool scoping existed) gets its
  // correct scope assigned by known id, defaulting to 'notebooks' — the
  // original, pre-scoping home for this feature — for anything unrecognized.
  (db.agentPrompts || []).forEach(p => {
    if (p.scope) return;
    p.scope = (p.id === 'ap_coding_agent_guide') ? 'projects' : 'notebooks';
    dirty = true;
  });

  // ── links ─────────────────────────────────────────────────────────────────
  (db.links || []).forEach(l => {
    ensure(l, 'description', '');
    ensure(l, 'tags',        l.tags || []);
    ensure(l, 'updatedAt',   l.createdAt || nowISO());
  });

  // Bump schema version
  if ((db.version || 1) < 2) { db.version = 2; dirty = true; }
  if (!Array.isArray(db.activity)) { db.activity = []; dirty = true; }

  // ── v80 one-time: soft-delete empty "Untitled" noise notes ───────────────
  // Earlier paths (command palette "New note", abandoned drafts) could leave
  // behind alive type='note' rows with no title, no content, no tags, and no
  // links — pure noise that clutters the Vault. Move them to Trash so they're
  // out of the way but still recoverable from Review → Trash.
  // Idempotent: gated on db._cleanedEmptyUntitled flag so it runs exactly once.
  if (!db._cleanedEmptyUntitled) {
    const ts = nowISO();
    let cleaned = 0;
    (db.notes || []).forEach(n => {
      if (n.deletedAt) return;
      if (n.type !== 'note') return;             // never touch pages / daily / ideas
      if (n.notebookId) return;                  // belongs to a notebook → leave alone
      if (n.projectId) return;                   // belongs to a project → leave alone
      if (n.pinned) return;                      // user explicitly pinned → leave alone
      const title = (n.title || '').trim().toLowerCase();
      const content = (n.content || '').trim();
      const tags = (n.tags || []).length;
      const links = (n.links || []).length;
      const attachments = (n.attachments || []).length;
      const hasTasks = (db.tasks || []).some(t => t.noteId === n.id && !t.deletedAt);
      const isEmptyTitle = title === '' || title === 'untitled';
      if (isEmptyTitle && !content && !tags && !links && !attachments && !hasTasks) {
        n.deletedAt = ts;
        n.updatedAt = ts;
        cleaned++;
      }
    });
    db._cleanedEmptyUntitled = true;
    dirty = true;
    if (cleaned) console.info('[migrate] moved', cleaned, 'empty Untitled note(s) to Trash');
  }

  // ── v81 one-time: dedupe + clean empty notebooks ─────────────────────────
  // research-mode's ensureResearchScaffold seeds a "🔬 Research" notebook by
  // title; if the user had already created one, the seed could end up as a
  // second empty duplicate. Also, the "+ New Notebook" flow + abandoned
  // creations left behind "New Notebook" rows with 0 pages. Both are noise
  // the user can't easily clean up. Notebooks are NOT soft-deletable, so we
  // only remove duplicates / empty unnamed ones — never anything with pages.
  if (!db._cleanedDupNotebooks) {
    db.notebooks = db.notebooks || [];
    const pagesOf = nbId => (db.notes || []).filter(n => n.notebookId === nbId && !n.deletedAt).length;
    // 1) dedupe by title — keep the one with the most live pages
    const byTitle = new Map();
    (db.notebooks || []).forEach(nb => {
      const key = (nb.title || '').trim();
      if (!key) return;
      if (!byTitle.has(key)) byTitle.set(key, []);
      byTitle.get(key).push(nb);
    });
    let removedDup = 0, mergedSystem = 0;
    const toRemove = new Set();
    byTitle.forEach(group => {
      if (group.length < 2) return;
      group.sort((a, b) => pagesOf(b.id) - pagesOf(a.id)
        || (a.createdAt || '').localeCompare(b.createdAt || ''));
      const keeper = group[0];
      const dropped = group.slice(1);
      // Survivor inherits system flag if any dup had it (so future scaffold runs match it).
      if (!keeper.system && dropped.some(d => d.system)) { keeper.system = true; mergedSystem++; }
      dropped.forEach(d => {
        // Re-parent any orphan pages on the dup to the keeper (defensive — should be 0).
        (db.notes || []).forEach(n => { if (n.notebookId === d.id) n.notebookId = keeper.id; });
        toRemove.add(d.id);
        removedDup++;
      });
    });
    // 2) remove empty unnamed notebooks (no pages, no description, not system).
    const emptyTitles = new Set(['', 'untitled', 'new notebook']);
    let removedEmpty = 0;
    (db.notebooks || []).forEach(nb => {
      if (toRemove.has(nb.id)) return;
      if (nb.system) return;
      const title = (nb.title || '').trim().toLowerCase();
      if (!emptyTitles.has(title)) return;
      if ((nb.description || '').trim()) return;
      if (pagesOf(nb.id) > 0) return;
      toRemove.add(nb.id);
      removedEmpty++;
    });
    if (toRemove.size) {
      // Tombstone instead of splice so a stale client POST can't resurrect them
      // (server merge rule #3 keeps the deletion when client copy is older).
      const tt = nowISO();
      db.notebooks.forEach(nb => {
        if (toRemove.has(nb.id)) { nb.deletedAt = tt; nb.updatedAt = tt; }
      });
    }
    db._cleanedDupNotebooks = true;
    dirty = true;
    if (removedDup || removedEmpty || mergedSystem) {
      console.info('[migrate] notebooks: removed', removedDup, 'dup +', removedEmpty,
        'empty,', mergedSystem, 'system flag(s) merged onto survivor');
    }
  }

  // ── one-time: un-rollover stuck tasks (v67 → v68) ────────────────────────
  // Earlier behavior auto-MOVED yesterday's incomplete tasks onto today's
  // daily note, which hid them from the 'Unfinished from previous days'
  // panel. New behavior leaves them on their original day. Walk today's
  // task list once and send any task that was created on a previous day
  // back to a daily note from its createdAt date. Conservative filters:
  // skip project tasks, auto-carried tasks, recurring/monthly virtuals.
  if (!db.settings._rolloverUndoneV68) {
    try {
      const today = todayKey();
      const todayDaily = (db.notes||[]).find(n => n.type==='daily' && n.dateIndex===today && !n.deletedAt);
      if (todayDaily) {
        const dailyByDate = new Map();
        (db.notes||[]).forEach(n => {
          if (n.type==='daily' && n.dateIndex && !n.deletedAt) dailyByDate.set(n.dateIndex, n);
        });
        const sortedDates = Array.from(dailyByDate.keys()).sort();
        const pickPriorDaily = (taskDate) => {
          if (dailyByDate.has(taskDate)) return dailyByDate.get(taskDate);
          // Otherwise the most recent prior daily note that exists.
          let candidate = null;
          for (const d of sortedDates) { if (d < today && d <= taskDate) candidate = dailyByDate.get(d); }
          return candidate;
        };
        let moved = 0;
        (db.tasks||[]).forEach(t => {
          if (t.noteId !== todayDaily.id) return;
          if (t.deletedAt) return;
          if (t.projectId) return;          // project tasks (incl. auto-carried) stay
          if (t.carriedToNoteId) return;
          if (!t.createdAt) return;
          const taskDate = String(t.createdAt).slice(0,10);
          if (taskDate >= today) return;     // genuinely added today → leave alone
          const target = pickPriorDaily(taskDate);
          if (target && target.id !== todayDaily.id) {
            t.noteId = target.id;
            t.updatedAt = nowISO();
            moved++;
          }
        });
        if (moved) console.log(`⚙️  migrateDB: un-rolled ${moved} stuck task(s) back to their original day`);
      }
    } catch (e) { console.warn('rollover undo skipped:', e); }
    db.settings._rolloverUndoneV68 = true;
    dirty = true;
  }

  if (dirty) { persistDB(); console.log('⚙️  migrateDB: schema patched and saved'); }
}
// ---------------------------------------------------------------------------

async function initApp(){
  // 1. Try server — the server is the single source of truth.
  let serverData = await fetchDB();

  if(serverData && Object.keys(serverData).length){
    // Server returned data. Use it directly. We deliberately do NOT merge in
    // an old localStorage snapshot here — that's how auto-created template
    // notes (with fresh updatedAt but empty content) were silently
    // overwriting real data on the server when a second browser opened.
    // If a previous offline edit truly never reached the server, that's a
    // very rare edge case; the autosync layer will reconcile when next online.
    db = serverData;
    window.db = db;
  } else {
    // 2. Server is unreachable. Try the legacy full-DB localStorage blob
    //    purely as an offline fallback. If absent, start from seed defaults.
    let localData = null;
    try { localData = JSON.parse(localStorage.getItem(storeKey) || 'null'); } catch(_) { localData = null; }
    if (!localData) localData = JSON.parse(JSON.stringify(defaults));
    db = localData;
    window.db = db;
    // Don't call persistDB() here — server is unreachable. The first
    // successful persistDB() once we're back online will push our state.
  }
  // Proactively evict the legacy full-DB blob from localStorage. It's
  // multi-MB, silently fails to write once the quota is hit, and is no
  // longer needed (server is authoritative). We only keep the tiny
  // ":lastSync" pointer going forward.
  try { localStorage.removeItem(storeKey); } catch(_) {}
  // Defensive: ensure collections exist (added links)
  // Ensure all collections exist on db. Include new 'monthly' plan storage.
  ['notes','tasks','projects','templates','settings','links','monthly'].forEach(k=>{
    if(!db[k]) db[k] = Array.isArray(seed[k]) ? [] : {};
  });
  if(!db.notebooks) db.notebooks = [];
  if(!db.activity)  db.activity  = [];
  // Migrate all entities to the canonical schema (adds any missing fields).
  migrateDB();
  // Ensure theme setting exists (default to dark)
  if(!db.settings.theme){ db.settings.theme = 'dark'; }
  // Auto-create today's daily note if it doesn't exist yet so the first
  // render always shows the note editor rather than the "Create Daily" prompt.
  const _todayKey = todayKey();
  if (!db.notes.find(n => n.type === 'daily' && n.dateIndex === _todayKey && !n.deletedAt)) {
    createDailyNoteFor(_todayKey);
  }
  // Draw initial UI
  drawProjectsSidebar();
  applyTheme();
  // Restore last route/note from sessionStorage so reload doesn't always land
  // on Today. Falls back to render() (Today) when nothing was saved.
  if (!_navRestoreSession()) {
    render();
  }
  
  // Start auto-sync for real-time cross-session updates
  if (typeof startAutoSync === 'function') {
    console.log('🔄 Starting auto-sync system...');
    startAutoSync();
    console.log('✅ Auto-sync started successfully');
  } else {
    console.error('❌ startAutoSync function not available - autosync.js not loaded?');
  }
  // --- Typing guard (re-add) ---
  // Prevent background sync UI refresh while user is actively typing in any editable field.
  window.__typingUntil = 0;
  const bumpTyping = () => { window.__typingUntil = Date.now() + 4000; };
  const bindTypingGuards = () => {
    document.querySelectorAll('input[type="text"], input[type="search"], textarea, [contenteditable="true"]').forEach(el => {
      if(el.dataset.typingBound) return;
      el.addEventListener('keydown', bumpTyping, { passive:true });
      el.addEventListener('input', bumpTyping, { passive:true });
      el.dataset.typingBound = '1';
    });
  };
  // --- Fancy <select> enhancer ---
  // Wraps every native single-select with a custom dropdown that matches the
  // app's modal/glass aesthetic. The original <select> stays in the DOM so
  // existing change handlers, form semantics, and `select.value = ''` resets
  // continue to work — we only intercept the value setter to keep the visible
  // button label in sync with programmatic changes. Selects with
  // data-no-fancy or [multiple]/[size>1] are skipped (e.g. linkSelect, which
  // has its own search-and-pick UX inside the link modal).
  window.enhanceSelects = function enhanceSelects(root) {
    root = root || document;
    // Sweep orphan popups whose wrapper has been removed from the DOM by a
    // re-render. Keeps document.body clean across navigation.
    document.body.querySelectorAll('.fancy-select-popup').forEach(p => {
      const owner = p.__fancyOwner;
      if (owner && !owner.isConnected) p.remove();
    });
    root.querySelectorAll('select').forEach(sel => {
      if (sel.dataset.fancy === '1') return;
      if (sel.dataset.noFancy === '1') return;
      if (sel.multiple || sel.size > 1) return;
      sel.dataset.fancy = '1';

      const wrap = document.createElement('div');
      wrap.className = 'fancy-select';
      // Carry over inline width hints so layouts that expected
      // width:100% on the original select keep their flex sizing.
      const inlineWidth = sel.style.width;
      if (inlineWidth) wrap.style.width = inlineWidth;
      if (sel.style.flex) wrap.style.flex = sel.style.flex;
      sel.parentNode.insertBefore(wrap, sel);
      wrap.appendChild(sel);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fancy-select-btn';
      btn.setAttribute('aria-haspopup', 'listbox');
      btn.setAttribute('aria-expanded', 'false');
      if (sel.title) btn.title = sel.title;
      if (sel.disabled) btn.disabled = true;

      const popup = document.createElement('div');
      popup.className = 'fancy-select-popup';
      popup.setAttribute('role', 'listbox');

      wrap.appendChild(btn);
      // Portal the popup to <body> so it isn't clipped by any scrollable
      // ancestor (e.g. .modal-body with overflow-y:auto). Position is
      // computed from the button's bounding rect on open and on scroll/resize.
      document.body.appendChild(popup);
      popup.__fancyOwner = wrap;

      const escapeHTML = s => String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      const syncBtnLabel = () => {
        const opt = sel.options[sel.selectedIndex];
        const label = opt ? (opt.textContent || '\u00a0') : '\u00a0';
        btn.innerHTML = `<span class="fancy-select-label">${escapeHTML(label)}</span><span class="fancy-select-chev">▾</span>`;
        btn.disabled = sel.disabled;
      };
      const buildPopup = () => {
        popup.innerHTML = Array.from(sel.options).map((o, i) => {
          const cls = `fancy-select-opt${i === sel.selectedIndex ? ' is-selected' : ''}${o.disabled ? ' is-disabled' : ''}`;
          return `<div class="${cls}" data-i="${i}" role="option" aria-selected="${i === sel.selectedIndex}">${escapeHTML(o.textContent || '')}</div>`;
        }).join('');
        popup.querySelectorAll('.fancy-select-opt').forEach(el => {
          el.onclick = (e) => {
            e.stopPropagation();
            if (el.classList.contains('is-disabled')) return;
            const i = +el.dataset.i;
            sel.selectedIndex = i;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            syncBtnLabel();
            close();
          };
        });
      };
      const positionPopup = () => {
        const r = btn.getBoundingClientRect();
        const margin = 6;
        const maxH = 280;
        // Decide whether to open downward or upward based on available space.
        const spaceBelow = window.innerHeight - r.bottom - margin;
        const spaceAbove = r.top - margin;
        const openUp = spaceBelow < 200 && spaceAbove > spaceBelow;
        popup.style.position = 'fixed';
        popup.style.left = r.left + 'px';
        popup.style.minWidth = r.width + 'px';
        popup.style.maxHeight = Math.min(maxH, openUp ? spaceAbove : spaceBelow) + 'px';
        if (openUp) {
          popup.style.top = '';
          popup.style.bottom = (window.innerHeight - r.top + margin) + 'px';
        } else {
          popup.style.bottom = '';
          popup.style.top = (r.bottom + margin) + 'px';
        }
        popup.style.right = '';
      };
      let isOpen = false;
      const open = () => {
        if (sel.disabled) return;
        buildPopup();
        wrap.classList.add('is-open');
        popup.classList.add('is-open');
        btn.setAttribute('aria-expanded', 'true');
        isOpen = true;
        positionPopup();
        document.addEventListener('mousedown', outsideHandler, true);
        document.addEventListener('keydown', keyHandler, true);
        window.addEventListener('scroll', positionPopup, true);
        window.addEventListener('resize', positionPopup, true);
        // Scroll selected into view
        const cur = popup.querySelector('.is-selected');
        if (cur) cur.scrollIntoView({ block: 'nearest' });
      };
      const close = () => {
        wrap.classList.remove('is-open');
        popup.classList.remove('is-open');
        btn.setAttribute('aria-expanded', 'false');
        isOpen = false;
        document.removeEventListener('mousedown', outsideHandler, true);
        document.removeEventListener('keydown', keyHandler, true);
        window.removeEventListener('scroll', positionPopup, true);
        window.removeEventListener('resize', positionPopup, true);
      };
      const outsideHandler = (e) => {
        if (wrap.contains(e.target) || popup.contains(e.target)) return;
        // Allow callers to nominate sibling controls (e.g. linkSearch) that
        // shouldn't close the popup when interacted with.
        if (e.target.closest && e.target.closest('[data-fancy-keepopen]')) return;
        close();
      };
      const keyHandler = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); close(); btn.focus(); }
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const opts = Array.from(popup.querySelectorAll('.fancy-select-opt:not(.is-disabled)'));
          if (!opts.length) return;
          const visIdx = opts.findIndex(o => +o.dataset.i === sel.selectedIndex);
          let nextVis = e.key === 'ArrowDown' ? Math.min(opts.length - 1, visIdx + 1) : Math.max(0, visIdx - 1);
          if (visIdx === -1) nextVis = 0;
          const targetI = +opts[nextVis].dataset.i;
          sel.selectedIndex = targetI;
          popup.querySelectorAll('.fancy-select-opt').forEach(o => {
            const sel2 = +o.dataset.i === targetI;
            o.classList.toggle('is-selected', sel2);
            o.setAttribute('aria-selected', sel2 ? 'true' : 'false');
          });
          opts[nextVis].scrollIntoView({ block: 'nearest' });
        }
        else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          syncBtnLabel();
          close();
        }
      };
      btn.onclick = (e) => { e.stopPropagation(); isOpen ? close() : open(); };
      btn.addEventListener('keydown', e => {
        if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });

      // Capture programmatic value changes (sel.value = '...' / selectedIndex = N)
      // so the visible button label and selected style remain correct after handlers
      // that reset the dropdown after use (e.g. Apply Template).
      try {
        const valueDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
        Object.defineProperty(sel, 'value', {
          get() { return valueDesc.get.call(this); },
          set(v) { valueDesc.set.call(this, v); syncBtnLabel(); },
          configurable: true
        });
        const idxDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
        Object.defineProperty(sel, 'selectedIndex', {
          get() { return idxDesc.get.call(this); },
          set(v) { idxDesc.set.call(this, v); syncBtnLabel(); },
          configurable: true
        });
      } catch(_){}

      // If callers replace the option list (linkModal-style search filters,
      // or template-list rebuilds), keep the popup + label fresh.
      const obs = new MutationObserver(() => {
        syncBtnLabel();
        if (isOpen) buildPopup();
      });
      obs.observe(sel, { childList: true, subtree: true });
      sel.addEventListener('change', syncBtnLabel);

      // Expose a tiny imperative API so callers (e.g. the linkSearch input
      // in openLinkModal) can drive the popup as users type.
      sel.fancyOpen  = open;
      sel.fancyClose = close;
      sel.fancyToggle = () => { isOpen ? close() : open(); };

      syncBtnLabel();
    });
  };

  // --- Fancy autocomplete for text inputs ---
  // Replaces the browser-native <datalist> popup (which can't be themed
  // cross-browser) with a portaled popup that reuses the .fancy-select-popup
  // styling, so token inputs (tag fields etc.) feel consistent with the
  // rest of the dropdowns. Token-aware: only the word containing the
  // caret is matched / replaced, so 'foo #typ' will only autocomplete
  // 'typ' and leave 'foo' alone.
  window.attachFancyAutocomplete = function attachFancyAutocomplete(input, getOptions, opts) {
    if (!input || input.dataset.fancyAc === '1') return;
    opts = opts || {};
    input.dataset.fancyAc = '1';
    // Kill the native datalist popup if any.
    input.removeAttribute('list');
    input.setAttribute('autocomplete', 'off');

    const popup = document.createElement('div');
    popup.className = 'fancy-select-popup fancy-autocomplete-popup';
    popup.setAttribute('role', 'listbox');
    document.body.appendChild(popup);
    popup.__fancyOwner = input; // reuse the enhanceSelects orphan-sweeper

    let isOpen = false;
    let activeIdx = -1;
    let matches = [];

    const tokenize = () => {
      const val = input.value;
      const cur = input.selectionStart != null ? input.selectionStart : val.length;
      let start = cur;
      while (start > 0 && !/\s/.test(val[start - 1])) start--;
      let end = cur;
      while (end < val.length && !/\s/.test(val[end])) end++;
      return { start, end, token: val.slice(start, end) };
    };

    const positionPopup = () => {
      const r = input.getBoundingClientRect();
      const margin = 4;
      const maxH = 240;
      const spaceBelow = window.innerHeight - r.bottom - margin;
      const spaceAbove = r.top - margin;
      const openUp = spaceBelow < 160 && spaceAbove > spaceBelow;
      popup.style.position = 'fixed';
      popup.style.left = r.left + 'px';
      popup.style.minWidth = Math.max(r.width, 220) + 'px';
      popup.style.maxHeight = Math.min(maxH, openUp ? spaceAbove : spaceBelow) + 'px';
      if (openUp) {
        popup.style.top = '';
        popup.style.bottom = (window.innerHeight - r.top + margin) + 'px';
      } else {
        popup.style.bottom = '';
        popup.style.top = (r.bottom + margin) + 'px';
      }
    };

    const escapeHTML = s => String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

    const render = () => {
      const tok = tokenize();
      const q = tok.token.replace(/^#/, '').trim().toLowerCase();
      matches = (getOptions(q, input.value) || []).slice(0, opts.max || 10);
      if (!matches.length) { close(); return; }
      activeIdx = 0;
      popup.innerHTML = matches.map((m, i) => {
        const label = m.label || ('#' + m.tag);
        const hint  = m.count ? `<span class="fancy-ac-count">${m.count}</span>` : '';
        return `<div class="fancy-select-opt${i === 0 ? ' is-selected' : ''}" data-i="${i}" role="option">${escapeHTML(label)}${hint}</div>`;
      }).join('');
      popup.querySelectorAll('.fancy-select-opt').forEach(el => {
        el.onmousedown = (e) => { e.preventDefault(); pick(+el.dataset.i); };
      });
      if (!isOpen) open(); else positionPopup();
    };

    const open = () => {
      popup.classList.add('is-open');
      isOpen = true;
      positionPopup();
      window.addEventListener('scroll', positionPopup, true);
      window.addEventListener('resize', positionPopup, true);
      document.addEventListener('mousedown', outsideHandler, true);
    };
    const close = () => {
      popup.classList.remove('is-open');
      isOpen = false;
      activeIdx = -1;
      window.removeEventListener('scroll', positionPopup, true);
      window.removeEventListener('resize', positionPopup, true);
      document.removeEventListener('mousedown', outsideHandler, true);
    };
    const outsideHandler = (e) => {
      if (e.target === input || popup.contains(e.target)) return;
      close();
    };
    const pick = (i) => {
      const m = matches[i];
      if (!m) return;
      const tok = tokenize();
      const insert = (opts.format ? opts.format(m) : ('#' + (m.tag || m.label)));
      const val = input.value;
      input.value = val.slice(0, tok.start) + insert + ' ' + val.slice(tok.end);
      const caret = tok.start + insert.length + 1;
      try { input.setSelectionRange(caret, caret); } catch(_){}
      close();
      input.focus();
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const setActive = (i) => {
      if (!matches.length) return;
      activeIdx = Math.max(0, Math.min(matches.length - 1, i));
      popup.querySelectorAll('.fancy-select-opt').forEach((el, idx) => {
        const on = idx === activeIdx;
        el.classList.toggle('is-selected', on);
        if (on) el.scrollIntoView({ block: 'nearest' });
      });
    };

    input.addEventListener('input', render);
    input.addEventListener('focus', () => { if (input.value) render(); });
    input.addEventListener('keydown', (e) => {
      if (!isOpen) {
        if (e.key === 'ArrowDown') { e.preventDefault(); render(); }
        return;
      }
      if (e.key === 'ArrowDown')      { e.preventDefault(); setActive(activeIdx + 1); }
      else if (e.key === 'ArrowUp')   { e.preventDefault(); setActive(activeIdx - 1); }
      else if (e.key === 'Enter' || e.key === 'Tab') {
        if (activeIdx >= 0) { e.preventDefault(); pick(activeIdx); }
      }
      else if (e.key === 'Escape')    { e.preventDefault(); close(); }
    });
  };
  bindTypingGuards();
  // Re-bind after each render by monkey-patching render once (idempotent)
  if(!window.__originalRender){
    window.__originalRender = render;
    window.render = function(){
      window.__originalRender.apply(this, arguments);
  window.db = db; // keep global pointer current
      bindTypingGuards();
      try { enhanceSelects(); } catch(_){}
      try { _navSaveSession(); } catch(_) {}
    };
  }
  // Initial pass for selects already in the DOM (taskModal, linkModal, etc.)
  try { enhanceSelects(); } catch(_){}
  // Bind Sync Now button if present
  const syncBtn = document.getElementById('syncNowBtn');
  if(syncBtn){
    if(syncBtn.dataset.syncAttached==='1') {
      // Already attached; skip
    } else {
      syncBtn.dataset.syncAttached='1';
    }
    const attachSyncHandler = () => {
      syncBtn.onclick = async () => {
        if(syncBtn.dataset.syncing==='1') return;
        syncBtn.dataset.syncing='1';
        const original = syncBtn.textContent;
        syncBtn.textContent='Syncing…';
        try {
          if(typeof manualSync==='function') {
            await manualSync();
          } else if (typeof fetchDB==='function') {
            const remote = await fetchDB();
            if(remote && typeof remote==='object'){
              const keepAuto = db.settings && db.settings.autoReload;
              const list = ['notes','tasks','projects','templates','links','monthly','notebooks'];
              const hardDeleted = window._hardDeletedIds || new Set();
              const mapify = a=>{const m=new Map(); a.forEach(o=>{ if(!hardDeleted.has(o.id)) m.set(o.id,o); }); return m;};
              list.forEach(k=>{
                const localArr = Array.isArray(db[k])? db[k]:[];
                const remoteArr = Array.isArray(remote[k])? remote[k]:[];
                const m = mapify(localArr);
                remoteArr.forEach(r=>{
                  if(hardDeleted.has(r.id)) return;
                  const l=m.get(r.id); if(!l){m.set(r.id,r); return;}
                  const lt=Date.parse(l.updatedAt||l.createdAt||0); const rt=Date.parse(r.updatedAt||r.createdAt||0);
                  if(rt>lt) m.set(r.id,r);
                });
                db[k]=Array.from(m.values());
              });
              db.settings = { ...(remote.settings||{}), ...(db.settings||{}) };
              db.settings.autoReload = keepAuto;
              window.db = db; // refresh global reference post-merge
              render();
            }
          }
        } finally {
          syncBtn.textContent=original;
          delete syncBtn.dataset.syncing;
        }
      };
    };
    // If manualSync not yet defined (script load order), retry shortly
    if(typeof manualSync!=='function') setTimeout(()=>{ if(!syncBtn.onclick || String(syncBtn.onclick).includes('manualSync')===false) attachSyncHandler(); }, 500);
    attachSyncHandler();
  }
}
// --- End restored runtime glue ---

// Patch model functions to call save() without args
function createNote({title, content="", tags=[], projectId=null, dateIndex=null, type="note", pinned=false}){
  // Initialize each note with an empty links array so related notes can be stored
  const n = { id:uid(), title, content, tags, projectId, dateIndex, type, pinned, createdAt:nowISO(), updatedAt:nowISO(), attachments: [], links: [] };
  db.notes.push(n);
  logActivity('note:create', 'note', n.id, { title, type, projectId });
  save(); return n;
}
function updateNote(id, patch){
  const n=db.notes.find(x=>x.id===id); if(!n) return;
  Object.assign(n, patch, {updatedAt:nowISO()});
  // Only log explicit content/title saves, not internal field patches (e.g. mood)
  if (patch.content !== undefined || patch.title !== undefined) {
    logActivity('note:save', 'note', id, { title: n.title, type: n.type });
  }
  if (patch.mood !== undefined && patch.mood) {
    logActivity('mood:set', 'note', id, { mood: patch.mood, date: n.dateIndex });
  }
  save(); return n;
}
function createTask({title, due=null, noteId=null, projectId=null, priority="medium", description="", subtasks=[], tags=[]}){
  // Canonical task schema — all fields present so agent queries are unambiguous.
  const t = { id: uid(), title, status: "TODO", due, noteId, projectId, priority,
               description, subtasks, tags, createdAt: nowISO(), updatedAt: nowISO(),
               completedAt: null, deletedAt: null };
  db.tasks.push(t);
  logActivity('task:create', 'task', t.id, { title, projectId, priority, due });
  // When creating a project task, update the Today page counter if present. This must occur
  // before returning so the counter updates immediately on task creation. Note: checking
  // for existence of updateProjectTasksButton guards against calling it before it is defined.
  if (projectId && typeof updateProjectTasksButton === 'function') {
    updateProjectTasksButton();
  }
  save();
  return t;
}
window.createTask = createTask;
function setTaskStatus(id, status){
  const t = db.tasks.find(x => x.id === id);
  if (!t) return;
  t.status = status;
  t.completedAt = status === 'DONE' ? nowISO() : null;
  // Track when a task was dropped so Review can answer "what did I drop
  // this week/month?" without scanning journals. Cleared if reopened.
  if (status === 'DROPPED') t.droppedAt = nowISO();
  else if (t.droppedAt) t.droppedAt = null;
  t.updatedAt = nowISO();
  if (status === 'DONE') logActivity('task:done', 'task', t.id, { title: t.title, projectId: t.projectId });
  else if (status === 'TODO') logActivity('task:reopen', 'task', t.id, { title: t.title });
  else if (status === 'DROPPED') logActivity('task:dropped', 'task', t.id, { title: t.title, projectId: t.projectId });
  save();
  // If a project task status changes, update the Today page project tasks button count
  const ptBtn = document.getElementById('showProjectTasks');
  if (ptBtn) {
    // Defer updating project tasks count to a helper for consistency
    if (typeof updateProjectTasksButton === 'function') updateProjectTasksButton();
  }
}
// Append a timestamped entry to a task's journal. The journal is an
// append-only audit trail of edits, drops, backlog moves, and free-form
// remarks. Each entry: { at, kind, text }.
function appendTaskJournal(id, kind, text){
  const t = db.tasks.find(x => x.id === id);
  if (!t) return;
  const txt = (text || '').trim();
  if (!txt) return;
  if (!Array.isArray(t.journal)) t.journal = [];
  t.journal.push({ at: nowISO(), kind: kind || 'note', text: txt });
  t.updatedAt = nowISO();
  save();
}
window.appendTaskJournal = appendTaskJournal;
// Drop a task — semantically "I decided not to do this." Distinct from
// DONE (completed), BACKLOG (deferred), and deletedAt (mistake).
// Reason is REQUIRED — callers must collect it via showReasonModal first.
function dropTask(id, reason){
  const t = db.tasks.find(x => x.id === id);
  if (!t) return;
  const r = (reason || '').trim();
  if (!r) {
    console.warn('dropTask called without a reason — aborting');
    return;
  }
  if (!Array.isArray(t.journal)) t.journal = [];
  t.journal.push({ at: nowISO(), kind: 'drop', text: r });
  setTaskStatus(id, 'DROPPED');
}
window.dropTask = dropTask;
// New helper to move a task to backlog
function moveToBacklog(id, reason) {
  const t = db.tasks.find(x => x.id === id);
  if (!t) return;
  const r = (reason || '').trim();
  if (r) {
    if (!Array.isArray(t.journal)) t.journal = [];
    t.journal.push({ at: nowISO(), kind: 'backlog', text: r });
  }
  // Mark task as backlog
  t.status = 'BACKLOG';
  t.updatedAt = nowISO();
  save();
  // If it's a project task (belongs to a project but not attached to a note) then update the
  // project task button counter on the Today page. This ensures the badge reflects the new
  // backlog status without automatically revealing the list.
  if (t.projectId && !t.noteId && typeof updateProjectTasksButton === 'function') {
    updateProjectTasksButton();
  }
}
// --- Task similarity helpers ---
// Returns a 0–1 score for how similar two task title strings are.
// Uses substring containment + Jaccard word-overlap so both
// "Prayer" / "Prayer" (exact) and "PHD prep" / "PHD Prep – apply" (partial) are caught.
function taskSimilarity(a, b){
  a = a.toLowerCase().trim();
  b = b.toLowerCase().trim();
  if(!a || !b) return 0;
  if(a === b) return 1;
  if(a.includes(b) || b.includes(a)) return 0.9;
  const wa = new Set(a.split(/\W+/).filter(Boolean));
  const wb = new Set(b.split(/\W+/).filter(Boolean));
  const inter = [...wa].filter(w => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return union ? inter / union : 0;
}
// Groups all non-deleted tasks into clusters where any two tasks have similarity >= threshold.
// Returns array of arrays, only groups with 2+ tasks.
// EXCLUDES tasks whose title matches a monthly recurring entry — those legitimately repeat every day.
function findDuplicateTaskGroups(threshold = 0.75){
  const monthlyTitles = new Set((db.monthly||[]).filter(m => !m.deletedAt).map(m => m.title.toLowerCase()));
  const tasks = db.tasks.filter(t => !t.deletedAt && t.status !== 'DONE' && !monthlyTitles.has((t.title||'').toLowerCase()));
  const visited = new Set();
  const groups = [];
  for(let i = 0; i < tasks.length; i++){
    if(visited.has(tasks[i].id)) continue;
    const group = [tasks[i]];
    for(let j = i + 1; j < tasks.length; j++){
      if(visited.has(tasks[j].id)) continue;
      if(taskSimilarity(tasks[i].title, tasks[j].title) >= threshold){
        group.push(tasks[j]);
        visited.add(tasks[j].id);
      }
    }
    if(group.length > 1){
      group.forEach(t => visited.add(t.id));
      groups.push(group);
    }
  }
  return groups;
}
// Soft-delete a task by marking it archived. Tasks are not removed from DB to allow history viewing.
function deleteTask(id){
  const t = db.tasks.find(x => x.id === id);
  if (!t) return;
  t.deletedAt = nowISO();
  t.updatedAt = nowISO(); // must be after deletedAt so server merge sees client as winner
  save();
  // If deleting a project task, update the Today page project task counter. Removing
  // the task from the DB should immediately reflect in the badge count.
  if (t.projectId && !t.noteId && typeof updateProjectTasksButton === 'function') {
    updateProjectTasksButton();
  }
}

// Helper to update the project tasks button count on the Today page. This is used to reflect
// the number of outstanding project tasks (not done or backlog) without automatically
// revealing the list. It is safe to call even if the Today page is not currently rendered.
function updateProjectTasksButton() {
  const ptBtn = document.getElementById('showProjectTasks');
  if (!ptBtn) return;
  // Count outstanding project tasks (not completed, not backlogged) and exclude
  // any tasks that have been soft-deleted. Without filtering deleted tasks, the
  // badge count would not decrease after a user deletes a task. The old logic
  // ignored deletedAt flags for legacy datasets, but this caused confusion when
  // tasks remained visible after deletion. Now we treat deleted tasks as
  // removed from the count.
  const count = db.tasks.filter(
    (t) =>
      t.projectId &&
      !t.noteId &&
      t.status !== 'BACKLOG' &&
      t.status !== 'DROPPED' &&
      t.status !== 'DONE' &&
      !t.deletedAt
  ).length;
  ptBtn.textContent = `${count} project tasks`;

  // If the project task list is currently visible on the Today page, re-render it so
  // that newly added or removed tasks appear immediately. Without this check, users
  // reported the list not updating even though the counter changes.
  const list = document.getElementById('projectTaskList');
  if (list && list.style && list.style.display !== 'none') {
    // drawProjectTasks is defined within renderToday. We guard against calling it
    // outside of its scope by checking if it exists on the window or via closure.
    try {
      if (typeof drawProjectTasks === 'function') {
        drawProjectTasks();
      }
    } catch (e) {
      // If drawProjectTasks is not in scope (e.g., we are not on Today page), ignore
    }
  }
}

// === SOFT DELETE SYSTEM ===
function softDeleteTask(id){
  const t = db.tasks.find(x => x.id === id);
  if(!t) return;
  t.deletedAt = nowISO();
  save();
}

function restoreTask(id){
  const t = db.tasks.find(x => x.id === id);
  if(!t) return;
  delete t.deletedAt;
  t.updatedAt = nowISO(); // stamp so server merge keeps this restored state
  // If the note this task belonged to no longer exists, detach noteId so the
  // task surfaces in Review → Pending Tasks instead of being silently orphaned.
  if(t.noteId && !db.notes.find(n => n.id === t.noteId)){
    t.noteId = null;
  }
  // Ensure restored tasks are actionable (not stuck in BACKLOG or DONE)
  if(t.status === 'BACKLOG' || t.status === 'DONE'){
    t.status = 'TODO';
    t.completedAt = null;
  }
  save();
}

function hardDeleteTask(id){
  // Permanently delete the task from the database
  window._hardDeletedIds.add(id);
  const taskIndex = db.tasks.findIndex(x => x.id === id);
  if (taskIndex === -1) return;
  db.tasks.splice(taskIndex, 1);
  persistDB(); // immediate — no debounce, prevents sync resurrection
}

// --- Note soft-delete helpers ---
function softDeleteNote(id){
  const n = db.notes.find(x => x.id === id);
  if(!n) return;
  const ts = nowISO();
  n.deletedAt = ts;
  n.updatedAt = ts;
  // SAFETY (daily): never cascade-delete tasks on a daily page. Detach them
  // (preserving the original noteId in _detachedFromNoteId) so accidentally
  // deleting a daily page never loses tasks — restoring the note reattaches.
  if(n.type === 'daily'){
    db.tasks.filter(t => t.noteId === id && !t.deletedAt).forEach(t => {
      t._detachedFromNoteId = id;
      t.noteId = null;
      t.updatedAt = ts; // bump so server merge respects the detach
    });
  } else {
    // Non-daily notes: soft-delete linked tasks (keep BACKLOG detached & alive).
    db.tasks.filter(t => t.noteId === id && !t.deletedAt).forEach(t => {
      if(t.status === 'BACKLOG'){
        t.noteId = null;
        t.updatedAt = ts;
      } else {
        t.deletedAt = ts;
        t.updatedAt = ts;
      }
    });
  }
  save();
}
function restoreNote(id){
  const n = db.notes.find(x => x.id === id);
  if(!n) return;
  const ts = nowISO();
  delete n.deletedAt;
  n.updatedAt = ts;
  // Reattach any tasks that were detached when a daily was soft-deleted.
  db.tasks.filter(t => t._detachedFromNoteId === id).forEach(t => {
    t.noteId = id;
    delete t._detachedFromNoteId;
    t.updatedAt = ts;
  });
  // Restore tasks that were trashed when this (non-daily) note was deleted.
  db.tasks.filter(t => t.noteId === id && t.deletedAt).forEach(t => {
    delete t.deletedAt;
    t.updatedAt = ts;
  });
  save();
}
function hardDeleteNote(id){
  window._hardDeletedIds.add(id);
  const n = db.notes.find(x => x.id === id);
  if(!n) return;
  // Permanently remove linked tasks too; track them so sync won't revive them
  db.tasks.filter(t => t.noteId === id).forEach(t => window._hardDeletedIds.add(t.id));
  db.tasks = db.tasks.filter(t => t.noteId !== id);
  db.notes = db.notes.filter(x => x.id !== id);
  persistDB(); // immediate — no debounce, prevents sync resurrection
}
function getTrashedNotes(){
  return db.notes.filter(n => n.deletedAt);
}

function emptyTrash() {
  // NOTE: callers MUST confirm with the user before invoking this. We do not
  // re-prompt here so that the single Review-page confirm isn't shown twice.
  const tasksBefore = db.tasks.length;
  const notesBefore = db.notes.length;
  const linksBefore = (db.links || []).length;
  // Track all IDs being wiped so sync cannot revive them from the server
  db.tasks.filter(x => x.deletedAt).forEach(t => window._hardDeletedIds.add(t.id));
  db.notes.filter(x => x.deletedAt).forEach(n => {
    window._hardDeletedIds.add(n.id);
    db.tasks.filter(t => t.noteId === n.id).forEach(t => window._hardDeletedIds.add(t.id));
  });
  (db.links || []).filter(x => x.deletedAt).forEach(l => window._hardDeletedIds.add(l.id));
  db.tasks = db.tasks.filter(x => !x.deletedAt);
  db.notes = db.notes.filter(x => !x.deletedAt);
  db.links = (db.links || []).filter(x => !x.deletedAt);
  if(db.tasks.length !== tasksBefore || db.notes.length !== notesBefore || db.links.length !== linksBefore) persistDB();
  if(route==='review') renderReview();
}
function createProject(name){
  // Canonical project schema — all fields explicit so agents can rely on them.
  const p = { id:uid(), name, description:'', tags:[], color:null, archivedAt:null,
               createdAt:nowISO(), updatedAt:nowISO() };
  db.projects.push(p); save(); return p;
}
function updateProject(id, patch){
  const p = db.projects.find(x => x.id === id);
  if(!p) return;
  Object.assign(p, patch, { updatedAt: nowISO() });
  save(); return p;
}
// Shared rename flow used by the sidebar (✎) and the Projects page header.
// Reuses showPrompt; no-ops on cancel, empty, or unchanged name.
async function renameProjectFlow(id){
  const p = db.projects.find(x => x.id === id);
  if(!p) return;
  const name = await showPrompt('Rename project', p.name, 'Rename', 'Cancel');
  if(name === null) return;                 // cancelled
  const trimmed = name.trim();
  if(!trimmed || trimmed === p.name) return; // empty or unchanged
  updateProject(id, { name: trimmed });
  drawProjectsSidebar();
  if(route === 'projects') render();
}
window.renameProjectFlow = renameProjectFlow;
function createTemplate(name, content){
  // Canonical template schema.
  const t = { id:uid(), name, content, description:'', tags:[], createdAt:nowISO(), updatedAt:nowISO() };
  db.templates.push(t); save(); return t;
}
function addTag(text){ const tags = extractTags(text); if(tags.length) { const uniqueTags = [...new Set([...getAllTags(), ...tags])]; } return tags; }
// Collect unique tags from notes and links (ideas/notes use tags on note; links have their own tags)
function getAllTags(){
  const sysNbIds = new Set((db.notebooks || [])
    .filter(nb => nb.system && !nb.deletedAt).map(nb => nb.id));
  const isUserNote = n => !n.deletedAt && !sysNbIds.has(n.notebookId);
  // Tags explicitly stored on notes (exclude soft-deleted + system-managed)
  const noteTags = db.notes.filter(isUserNote).flatMap(n => n.tags || []);
  // Inline hashtags inside note content (e.g. "#research")
  const inlineContentTags = db.notes.filter(isUserNote).flatMap(n => extractTags(n.content || ''));
  // Tags stored on links
  const linkTags = db.links ? db.links.filter(l => !l.deletedAt).flatMap(l => l.tags || []) : [];
  // Tags on tasks, templates, monthly tasks and notebooks (forward-compatible, agent-queryable)
  const taskTags     = (db.tasks     || []).filter(t => !t.deletedAt).flatMap(t => t.tags || []);
  const templateTags = (db.templates || []).flatMap(t => t.tags || []);
  const monthlyTags  = (db.monthly   || []).flatMap(m => m.tags || []);
  const nbTags       = (db.notebooks || []).flatMap(nb => nb.tags || []);
  // Merge + dedupe across all collections
  return [...new Set([...noteTags, ...inlineContentTags, ...linkTags,
                      ...taskTags, ...templateTags, ...monthlyTags, ...nbTags
                     ].filter(Boolean))].sort((a,b)=> a.localeCompare(b));
}
function extractTags(text){ return (text.match(/#[\w-]+/g) || []).map(tag => tag.slice(1)); }

// Build a frequency map of all tags actually in use across the workspace.
// Returns { Map<tagLower, {tag, count}>, total }. Used by suggestTagsFor.
function buildTagCorpus(){
  const sysNbIds = new Set((db.notebooks || [])
    .filter(nb => nb.system && !nb.deletedAt).map(nb => nb.id));
  const isUserNote = n => !n.deletedAt && !sysNbIds.has(n.notebookId);
  const corpus = new Map();
  const bump = (tag) => {
    const t = (tag || '').toLowerCase().trim();
    if (!t) return;
    const e = corpus.get(t) || { tag: t, count: 0 };
    e.count++;
    corpus.set(t, e);
  };
  db.notes.filter(isUserNote).forEach(n => {
    (n.tags || []).forEach(bump);
    extractTags(n.content || '').forEach(bump);
  });
  (db.links     || []).filter(l => !l.deletedAt).forEach(l => (l.tags || []).forEach(bump));
  (db.tasks     || []).filter(t => !t.deletedAt).forEach(t => (t.tags || []).forEach(bump));
  (db.templates || []).forEach(t => (t.tags || []).forEach(bump));
  (db.monthly   || []).forEach(m => (m.tags || []).forEach(bump));
  (db.notebooks || []).forEach(nb => (nb.tags || []).forEach(bump));
  return corpus;
}
// Suggest existing tags ranked by relevance to a piece of text.
// Strategy:
//   1. exact substring of the tag in lowercased text → strong signal
//      (boosted by corpus frequency, capped to avoid one super-popular
//       tag dominating).
//   2. word-fragment match — tag split on - _ space, any word ≥3 chars
//      appearing in the text contributes.
//   3. zero-signal tags with corpus frequency ≥ 5 get a faint baseline
//      score so the picker has fallback suggestions for empty notes.
// alreadySet is the list of tags currently on the note (excluded from
// suggestions). Returns at most `max` results, sorted by score then
// frequency.
function suggestTagsFor(text, alreadySet = [], max = 10){
  const t = (text || '').toLowerCase();
  const skip = new Set((alreadySet || []).map(x => (x || '').toLowerCase()));
  const scored = [];
  for (const e of buildTagCorpus().values()){
    if (skip.has(e.tag)) continue;
    let score = 0;
    if (e.tag.length >= 2 && t.includes(e.tag)) {
      score = 100 + Math.min(e.count, 20);
    } else {
      const words = e.tag.split(/[-_\s]+/).filter(w => w.length >= 3);
      const hits = words.filter(w => t.includes(w)).length;
      if (hits) score = 20 * hits + Math.min(e.count, 10);
      else if (e.count >= 5) score = 1;
    }
    if (score > 0) scored.push({ tag: e.tag, count: e.count, score });
  }
  scored.sort((a, b) => b.score - a.score || b.count - a.count);
  return scored.slice(0, max);
}
window.suggestTagsFor = suggestTagsFor;
window.buildTagCorpus = buildTagCorpus;

// --- Keyword extraction (for "intelligent" tag suggestions) ---
// suggestTagsFor only ranks tags that already exist in the corpus, so a
// brand-new note about a topic the user hasn't tagged before gets nothing.
// extractKeywordCandidates pulls likely tag candidates straight from the
// note text itself: stopword-filtered tokens with frequency >= 1, plus
// bigrams (e.g. "machine learning" -> "machine-learning") with freq >= 2.
const TAG_STOPWORDS = new Set([
  'the','a','an','and','or','but','if','then','else','for','to','of','in','on',
  'at','by','with','as','is','are','was','were','be','been','being','this',
  'that','these','those','it','its','i','you','he','she','we','they','my','your',
  'their','our','his','her','do','does','did','doing','have','has','had','having',
  'will','would','should','could','can','may','might','must','from','about',
  'into','over','under','out','up','down','off','more','less','some','any','all',
  'each','every','no','not','so','than','too','very','just','only','also','well',
  'much','many','few','one','two','three','first','second','last','new','old',
  'used','using','use','make','made','get','got','goes','went','come','came',
  'see','saw','seen','said','say','says','know','knew','want','wanted','need',
  'needed','like','liked','look','here','there','where','when','why','how',
  'what','who','whom','which','because','though','although','since','while',
  'until','before','after','during','between','among','also','etc','via','per',
  'still','already','really','actually','always','never','often','sometimes',
  'today','tomorrow','yesterday','soon','later','again','still','yet','now',
  'thing','things','stuff','way','ways','time','times','part','parts','case',
  'cases','area','areas','side','sides','kind','kinds','sort','sorts','bit',
  'bits','lot','lots','rather','quite','seems','seem','looks','sounds'
]);

window.extractKeywordCandidates = function extractKeywordCandidates(text, max = 12) {
  if (!text) return [];
  // Strip noise that can't be a tag: code blocks, inline code, URLs.
  const cleaned = String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .toLowerCase();
  const tokens = cleaned.split(/\s+/)
    .map(w => w.replace(/^-+|-+$/g, ''))
    .filter(Boolean);
  const isCandidate = w =>
    w.length >= 4 &&
    !TAG_STOPWORDS.has(w) &&
    !/^\d+$/.test(w) &&
    !/^-+$/.test(w);
  const freq = new Map();
  for (const t of tokens) {
    if (isCandidate(t)) freq.set(t, (freq.get(t) || 0) + 1);
  }
  // Bigrams: only if both halves are candidates AND the pair appears
  // multiple times (otherwise we'd suggest a million one-off pairings).
  const bigramFreq = new Map();
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = tokens[i], b = tokens[i + 1];
    if (!isCandidate(a) || !isCandidate(b)) continue;
    const k = a + '-' + b;
    bigramFreq.set(k, (bigramFreq.get(k) || 0) + 1);
  }
  for (const [k, n] of bigramFreq) {
    if (n >= 2) freq.set(k, n + 0.5); // small boost to prefer bigrams over their singletons
  }
  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([tag, count]) => ({ tag, count: Math.floor(count) }));
};

// Combine corpus-driven and text-extracted candidates so suggestions feel
// genuinely useful even on new topics. Each result carries an `isNew` flag
// so the UI can distinguish proven tags from fresh keyword extractions.
window.smartSuggestTags = function smartSuggestTags(text, alreadySet = [], max = 10) {
  const skip = new Set((alreadySet || []).map(x => (x || '').toLowerCase()));
  const corpus = suggestTagsFor(text || '', alreadySet, Math.max(max, 8))
    .map(s => ({ tag: s.tag, count: s.count, isNew: false }));
  const corpusKeys = new Set(corpus.map(s => s.tag));
  const fresh = extractKeywordCandidates(text || '', 16)
    .filter(k => !skip.has(k.tag) && !corpusKeys.has(k.tag))
    .map(k => ({ tag: k.tag, count: k.count, isNew: true }));
  // Interleave: corpus first (proven), then fresh extractions.
  return [...corpus, ...fresh].slice(0, max);
};

// Option provider for the tag inputs' fancy autocomplete popup.
// q          — the user's current partial token (no leading #), lowercased
// fullValue  — the entire input value (used to exclude already-typed tags)
// Returns [{tag, count}] ranked by substring-position then frequency.
window.tagAutocompleteOptions = function tagAutocompleteOptions(q, fullValue) {
  const used = (fullValue || '').split(/\s+/)
    .map(t => t.startsWith('#') ? t.slice(1) : t)
    .map(t => t.toLowerCase().trim())
    .filter(Boolean);
  const corpus = (typeof buildTagCorpus === 'function') ? buildTagCorpus() : new Map();
  const ql = (q || '').toLowerCase();
  const items = [];
  for (const e of corpus.values()) {
    // Exclude tags the user has already finished typing (still allow the
    // current partial token to surface).
    if (used.includes(e.tag) && e.tag !== ql) continue;
    if (ql && !e.tag.toLowerCase().includes(ql)) continue;
    items.push({ tag: e.tag, count: e.count, _idx: ql ? e.tag.toLowerCase().indexOf(ql) : 0 });
  }
  items.sort((a, b) =>
    a._idx - b._idx ||
    b.count - a.count ||
    a.tag.localeCompare(b.tag)
  );
  return items;
};

// True when the note lives in a system-managed notebook (e.g. 🔬 Research).
// Those notes are surfaced by their own dedicated tool; we hide them from
// generic surfaces (Vault search, hashtag cloud, link picker) so they don't
// pollute the user's day-to-day note workspace.
function _systemNotebookIds(){
  return new Set((db.notebooks || [])
    .filter(nb => nb.system && !nb.deletedAt)
    .map(nb => nb.id));
}
function isSystemManagedNote(n){
  if(!n || !n.notebookId) return false;
  return _systemNotebookIds().has(n.notebookId);
}
// --- Links helpers ---
function createLink({title,url,tags=[],pinned=false,status="NEW",description=''}){ const l={id:uid(), title, url, description, tags, pinned, status, createdAt:nowISO(), updatedAt:nowISO()}; db.links.push(l); save(); return l; }
function updateLink(id, patch){ const l=db.links.find(x=>x.id===id); if(!l) return; Object.assign(l, patch, {updatedAt:nowISO()}); save(); return l; }
// Soft-delete — moves the link to trash so it can be restored from Review.
// Pre-2026-06-02 this hard-deleted via `db.links = db.links.filter(...)`,
// which silently lost links and bypassed the trash entirely.
function deleteLink(id){ const l=db.links.find(x=>x.id===id); if(!l) return; const ts=nowISO(); l.deletedAt=ts; l.updatedAt=ts; save(); }
function restoreLink(id){ const l=db.links.find(x=>x.id===id); if(!l) return; delete l.deletedAt; l.updatedAt=nowISO(); save(); }
function hardDeleteLink(id){ window._hardDeletedIds.add(id); db.links = db.links.filter(l=> l.id!==id); persistDB(); }
function getTrashedLinks(){ return (db.links||[]).filter(l=> l.deletedAt); }

// ---------------------------------------------------------------------------
// logActivity — append a structured event to db.activity[]. Called by the
// app on meaningful user actions so an LLM agent can reconstruct work history.
// Each entry: { id, ts, type, entityType, entityId, detail }
// ---------------------------------------------------------------------------
function logActivity(type, entityType, entityId, detail) {
  if (!Array.isArray(db.activity)) db.activity = [];
  db.activity.push({
    id: 'act_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    ts:         nowISO(),
    type:       type,
    entityType: entityType || null,
    entityId:   entityId   || null,
    detail:     detail     || null,
  });
  // Cap at 2000 entries — oldest are pruned automatically
  if (db.activity.length > 2000) db.activity = db.activity.slice(-2000);
}

// --- Markdown toolbar helpers ---
// Ordered list of actions for the compact formatting toolbar shown in note/page editors.
const MD_TOOLBAR_ACTIONS = [
  {label:'B',       before:'**',      after:'**',     ph:'bold text',    title:'Bold'},
  {label:'I',       before:'_',       after:'_',      ph:'italic text',  title:'Italic'},
  {label:'~~',      before:'~~',      after:'~~',     ph:'strikethrough',title:'Strikethrough'},
  {label:'H1',      before:'\n# ',    after:'',       ph:'Heading',      title:'Heading 1'},
  {label:'H2',      before:'\n## ',   after:'',       ph:'Heading',      title:'Heading 2'},
  {label:'H3',      before:'\n### ',  after:'',       ph:'Heading',      title:'Heading 3'},
  {label:'`code`',  before:'`',       after:'`',      ph:'code',         title:'Inline code'},
  {label:'```',     before:'\n```\n', after:'\n```',  ph:'code here',    title:'Code block'},
  {label:'>',       before:'\n> ',    after:'',       ph:'quoted text',  title:'Blockquote'},
  {label:'\u2022 List',before:'\n- ', after:'',       ph:'item',         title:'Bullet list'},
  {label:'1. List', before:'\n1. ',   after:'',       ph:'item',         title:'Numbered list'},
  {label:'[link]',  before:'[',       after:'](url)', ph:'link text',    title:'Link'},
  {label:'[[w]]',   before:'[[',      after:']]',     ph:'Note Title',   title:'Wiki link to another note'},
  {label:'$x$',     before:'$',       after:'$',      ph:'a^2+b^2=c^2',  title:'Inline math (KaTeX)'},
  {label:'$$',      before:'\n$$\n',  after:'\n$$\n', ph:'\\int_0^1 x\\,dx', title:'Block math (KaTeX)'},
  {label:'\u25A6',  before:'\n| Col 1 | Col 2 | Col 3 |\n| :--- | :---: | ---: |\n| a | b | c |\n', after:'', ph:'', title:'Table'},
  {label:'[ ]',     before:'\n- [ ] ', after:'',      ph:'task',         title:'Task list item'},
  {label:'flow',    before:'\n```mermaid\nflowchart LR\n  A --> B\n', after:'\n```\n', ph:'', title:'Mermaid diagram'},
  {label:'\u2014',  before:'\n---\n', after:'',       ph:'',             title:'Horizontal rule'},
];
// Highlights/margin notes (==text==, ==color:text==, ==text==^[note]) are
// intentionally NOT in this toolbar — they only make sense to add while
// reading, so they're created by selecting text directly in the rendered
// Preview pane instead (see _wireHighlightSelectionPopup below), the same
// way a PDF reader's highlight tool works. The underlying insertMd()-based
// mechanism here is unchanged; only the highlight-specific buttons moved.
// Replace a textarea range with text WITHOUT breaking the browser's native
// undo/redo stack. Plain `ta.setRangeText()` mutates .value directly and is
// completely invisible to native undo — every toolbar button (Bold, wiki
// link, highlight, inline image insert, journal timestamp, etc.) was
// silently wiping out Ctrl+Z/Ctrl+Shift+Z for whatever the user had typed.
// `document.execCommand('insertText', ...)` is deprecated but remains the
// only cross-browser way to splice text into a plain <textarea> that still
// participates in native undo (same trick long used by browser-based code
// editors for this exact reason). Falls back to setRangeText only if
// execCommand is unavailable/fails, so behavior never regresses.
function _undoableReplaceRange(ta, start, end, text){
  ta.focus();
  ta.setSelectionRange(start, end);
  let ok = false;
  try { ok = document.execCommand('insertText', false, text); } catch(_) { ok = false; }
  if(!ok) ta.setRangeText(text, start, end, 'end');
}
function insertMd(ta, before, after, ph){
  if(!ta) return;
  const s = ta.selectionStart, e = ta.selectionEnd;
  const sel = ta.value.substring(s, e) || ph || '';
  _undoableReplaceRange(ta, s, e, before + sel + after);
  if(!ta.value.substring(s, e) && ph){
    ta.setSelectionRange(s + before.length, s + before.length + ph.length);
  }
  ta.focus();
  ta.dispatchEvent(new Event('input'));
}

// --- Inline images ---------------------------------------------------------
// Lets you drop/paste a hand-drawn figure or a screenshot from a lecture
// slide directly into the note body, the same way Notion/Obsidian do: the
// image is uploaded to the out-of-band attachment store (uploadAttachmentFile,
// same one backing the 📎 Attach sidebar) and only a small markdown
// `![alt](/api/attachments/<id>)` pointer is spliced into the text — never a
// base64 blob. marked.js (already wired in markdownToHtml) renders standard
// markdown images out of the box, so Split/Preview mode "just works" with no
// extra renderer code, and the actual bytes are fetched as a normal cached
// HTTP request only when the image is actually visible on screen.
// Alt text sits inside markdown `![alt](url)` syntax, not HTML — so it must
// NOT be htmlesc()'d (that would show literal "&amp;" etc. in the source).
// Instead just strip characters that would break the `[...]`/`(...)` syntax.
function _mdSafeAlt(s){
  return String(s || 'image').replace(/[\[\]()\r\n]/g, ' ').trim() || 'image';
}
async function _uploadAndInsertImage(file, ta){
  if(!file || !file.type || !file.type.startsWith('image/')) return;
  const token = uid();
  const safeName = _mdSafeAlt(file.name);
  const placeholder = `![Uploading ${safeName}…](#${token})`;
  const s = ta.selectionStart, e = ta.selectionEnd;
  _undoableReplaceRange(ta, s, e, placeholder);
  ta.dispatchEvent(new Event('input'));
  const replacePlaceholder = (text) => {
    const idx = ta.value.indexOf(placeholder);
    if(idx >= 0) _undoableReplaceRange(ta, idx, idx + placeholder.length, text);
    else _undoableReplaceRange(ta, ta.value.length, ta.value.length, text); // placeholder text got edited away
    ta.dispatchEvent(new Event('input'));
  };
  try {
    const att = await uploadAttachmentFile(file);
    replacePlaceholder(`![${safeName.replace(/\.[a-z0-9]+$/i, '')}](${attachmentSrc(att)})`);
  } catch(err){
    console.warn('Inline image upload failed:', err);
    replacePlaceholder(`![upload failed: ${safeName}]()`);
    if(typeof showQuickToast === 'function') showQuickToast('⚠️ Image upload failed');
  }
}
// Wire paste + drag&drop image handling onto a textarea. Non-image pastes/drops
// (plain text, other files) are left alone and fall through to default behavior.
function wireInlineImagePasteDrop(textareaId){
  const ta = document.getElementById(textareaId);
  if(!ta || ta._inlineImageWired) return;
  ta._inlineImageWired = true;
  ta.addEventListener('paste', (e) => {
    const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
    const imgItem = items.find(it => it.type && it.type.startsWith('image/'));
    if(!imgItem) return;
    e.preventDefault();
    const file = imgItem.getAsFile();
    if(file) _uploadAndInsertImage(file, ta);
  });
  ta.addEventListener('dragover', (e) => {
    if(Array.from(e.dataTransfer?.types || []).includes('Files')) e.preventDefault();
  });
  ta.addEventListener('drop', (e) => {
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter(f => f.type && f.type.startsWith('image/'));
    if(!files.length) return;
    e.preventDefault();
    files.forEach(f => _uploadAndInsertImage(f, ta));
  });
}
// Wire a file-picker input (e.g. the 🖼️ Image toolbar button) to the same
// upload-and-insert pipeline, targeting a given textarea.
function wireInlineImagePicker(inputId, textareaId){
  const input = document.getElementById(inputId);
  const ta = document.getElementById(textareaId);
  if(!input || !ta) return;
  input.onchange = (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    files.forEach(f => _uploadAndInsertImage(f, ta));
  };
}

function markdownToolbarHtml(taId){
  return `<div class='md-toolbar' style='display:flex;flex-wrap:wrap;gap:2px;padding:4px 0;
      margin-bottom:5px;border-bottom:1px solid var(--btn-border);'>
    ${MD_TOOLBAR_ACTIONS.map((a,i)=>`<button type='button' class='btn md-tb-btn' data-ta='${taId}' data-idx='${i}'
      title='${htmlesc(a.title)}' style='font-size:11px;padding:3px 7px;min-width:28px;'>${htmlesc(a.label)}</button>`).join('')}
  </div>`;
}
function bindMarkdownToolbar(textareaId){
  document.querySelectorAll(`.md-tb-btn[data-ta='${textareaId}']`).forEach(btn=>{
    btn.onclick = e=>{
      e.preventDefault();
      const ta = document.getElementById(btn.dataset.ta);
      const a = MD_TOOLBAR_ACTIONS[+btn.dataset.idx];
      if(!a || !ta) return;
      insertMd(ta, a.before, a.after, a.ph);
    };
  });
}

// --- Notebook helpers ---
function createNotebook({title, description=''}){
  if(!db.notebooks) db.notebooks=[];
  const nb={id:uid(), title, description, createdAt:nowISO(), updatedAt:nowISO()};
  db.notebooks.push(nb); save(); return nb;
}
function updateNotebook(id, patch){
  if(!db.notebooks) db.notebooks=[];
  const nb=db.notebooks.find(x=>x.id===id);
  if(!nb) return; Object.assign(nb, patch, {updatedAt:nowISO()}); save(); return nb;
}
function deleteNotebook(id){
  if(!db.notebooks) db.notebooks=[];
  // Soft-delete (tombstone) instead of splice. The server's POST /api/db merge
  // treats unknown ids as "new from client, add it back" — so a hard splice on
  // this device gets undone the moment a stale tab on another device (or this
  // device's stale in-memory snapshot) POSTs. Setting deletedAt + bumping
  // updatedAt makes rule #2/#3 of the server merge honor the deletion.
  const ts = nowISO();
  const nb = db.notebooks.find(x => x.id === id);
  if (nb) { nb.deletedAt = ts; nb.updatedAt = ts; }
  db.notes.filter(n=>n.notebookId===id && !n.deletedAt).forEach(n=>{ n.deletedAt=ts; n.updatedAt=ts; });
  save();
}
function getNotebookPages(notebookId){
  return db.notes.filter(n=>n.notebookId===notebookId && !n.deletedAt && n.type==='page')
    .sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0));
}
function createPage({title, notebookId, content='', tags=[], parentPageId=null}){
  const pages=getNotebookPages(notebookId);
  const maxOrder=pages.length ? Math.max(...pages.map(p=>p.sortOrder||0)) : -1;
  const n={id:uid(), title, content, tags, projectId:null, dateIndex:null, type:'page',
    pinned:false, notebookId, parentPageId, sortOrder:maxOrder+1,
    createdAt:nowISO(), updatedAt:nowISO(), attachments:[], links:[]};
  db.notes.push(n); save(); return n;
}
// Inline TOC rename. Replaces a .nb-toc-title span with an input; Enter
// commits, Esc cancels. Persists via updateNote so wiki-link backlinks and
// search stay consistent. Does not re-render the notebook (avoids losing
// the page editor's caret/scroll position).
function _startInlineRename(itemEl, titleSpan, nbId){
  const pageId = itemEl.dataset.pageId;
  const note = db.notes.find(x=>x.id===pageId);
  if(!note) return;
  const original = note.title || '';
  // Disable drag while editing so the input behaves like a real textfield.
  const wasDraggable = itemEl.getAttribute('draggable');
  itemEl.setAttribute('draggable','false');
  const input = document.createElement('input');
  input.type='text';
  input.value=original;
  input.style.cssText='width:100%;font-size:13px;padding:2px 4px;box-sizing:border-box;';
  titleSpan.replaceWith(input);
  input.focus();
  input.select();
  const restoreSpan = (text)=>{
    const span = document.createElement('span');
    span.className='nb-toc-title';
    span.style.cssText='display:inline-block;width:100%;';
    span.textContent = text || 'Untitled';
    input.replaceWith(span);
    span.addEventListener('dblclick', e=>{
      e.preventDefault(); e.stopPropagation();
      _startInlineRename(itemEl, span, nbId);
    });
    if(wasDraggable!==null) itemEl.setAttribute('draggable', wasDraggable);
  };
  const commit = ()=>{
    const next = input.value.trim() || 'Untitled';
    if(next !== original){
      updateNote(pageId, { title: next });
      itemEl.dataset.pageTitle = next;
      // If the renamed page is currently open, sync the editor's title field.
      if(currentPageId === pageId){
        const t=document.getElementById('pgTitle');
        if(t && t.value !== next) t.value = next;
      }
    }
    restoreSpan(next);
  };
  const cancel = ()=> restoreSpan(original);
  input.addEventListener('keydown', e=>{
    if(e.key==='Enter'){ e.preventDefault(); commit(); }
    else if(e.key==='Escape'){ e.preventDefault(); cancel(); }
  });
  input.addEventListener('blur', commit);
}

// --- UI helpers ---
const $ = sel => document.querySelector(sel);
const content = $("#content");
const nav = $("#nav");
const projectList = $("#projectList");

const sections = [
  {id:"today", label:"📅 Today"},
  {id:"projects", label:"📁 Projects"},
  {id:"ideas", label:"💡 Ideas"},
  {id:"links", label:"🔗 Links"}, // NEW
  {id:"map", label:"🗺️ Map"},
  {id:"people", label:"👥 People"},
  {id:"notebooks", label:"📓 Notebooks"},
  {id:"research", label:"🔬 Research"},
  {id:"vault", label:"🔍 Vault"},
  {id:"monthly", label:"🗓️ Monthly"},
  {id:"review", label:"📊 Review"},
  {id:"journal", label:"📖 Journal"},
];
let route = "today";
// Mirror to window so deferred modules (e.g. research-mode.js) can read the
// current route without hitting the script-scope `let` they can't see.
window.route = route;
let currentProjectId = null; // NEW: selected project
let currentNotebookId = null; // which notebook is open
let currentPageId = null;     // which page is open within a notebook

// --- Navigation history stack ---
// Each entry stores the full view state so Back restores exactly where you were.
window._navHistory  = window._navHistory  || [];
window._navPopping  = false;  // true while restoring – suppresses re-push

function _navSnapshot() {
  return {
    route,
    projectId:  currentProjectId,
    notebookId: currentNotebookId,
    pageId:     currentPageId,
    dailyDate:  selectedDailyDate,
    noteId:     window._openNoteId || null,
  };
}
function _navPush() {
  if (window._navPopping) return;
  window._navHistory.push(_navSnapshot());
  if (window._navHistory.length > 80) window._navHistory.shift(); // cap memory
  try { history.pushState({ _unNav: true }, ''); } catch(_) {}
}
function _navPop() {
  if (!window._navHistory || !window._navHistory.length) {
    // Nothing in history — fall back to today
    route = 'today'; render(); return;
  }
  const st = window._navHistory.pop();
  window._navPopping = true;
  route              = st.route;
  currentProjectId   = st.projectId;
  currentNotebookId  = st.notebookId;
  currentPageId      = st.pageId;
  selectedDailyDate  = st.dailyDate || selectedDailyDate;
  window._openNoteId = st.noteId;
  // openNote()/renderNotebookDetail() only touch #content, not the nav
  // sidebar's active-route highlight — refresh it here so the highlighted
  // tab always matches the route we just popped back to.
  window.route = route;
  renderNav();
  if (st.noteId) {
    // Was looking at a note editor — reopen it without pushing again
    openNote(st.noteId);
  } else if (st.route === 'notebooks' && st.notebookId) {
    renderNotebookDetail(st.notebookId);
  } else {
    render();
  }
  window._navPopping = false;
}

// Pop history if there's somewhere to go back to; otherwise run a caller-
// supplied fallback. Used by post-action handlers (delete a note, recover
// from a missing note) so they prefer the user's actual previous view
// rather than a hardcoded route.
function _navBackOr(fallback) {
  if (window._navHistory && window._navHistory.length) {
    _navPop();
  } else if (typeof fallback === 'function') {
    fallback();
  } else {
    route = 'today'; render();
  }
}
window._navBackOr = _navBackOr;
// --- End navigation history ---

// --- Browser-history + reload persistence ---
// Without this the Android back button leaves the PWA, and reloading any
// page drops you back on Today. We push a marker on each in-app navigation
// so back maps to _navPop(), and persist the current view to sessionStorage
// so a hard reload restores it.
if (!window._unNavWired) {
  window._unNavWired = true;
  try { history.replaceState({ _unBase: true }, ''); } catch(_) {}
  window.addEventListener('popstate', (e) => {
    if (e && e.state && e.state._unNav) { _navPop(); return; }
    // Returned to the base history entry. If our in-app stack still has the
    // pre-navigation snapshot, restore it so back lands the user on the
    // initial view (not a stale one). When the stack is also empty the
    // browser's next back press will leave the app, which is correct.
    if (e && e.state && e.state._unBase && window._navHistory && window._navHistory.length) {
      _navPop();
      // Re-establish the base marker so the user can keep navigating without
      // immediately exiting on the next back press.
      try { history.replaceState({ _unBase: true }, ''); } catch(_) {}
    }
  });
}
function _navSaveSession() {
  try { sessionStorage.setItem('un_view', JSON.stringify(_navSnapshot())); } catch(_) {}
}
function _navRestoreSession() {
  try {
    const raw = sessionStorage.getItem('un_view');
    if (!raw) return false;
    const st = JSON.parse(raw);
    if (!st || !st.route) return false;
    route              = st.route;
    currentProjectId   = st.projectId   || null;
    currentNotebookId  = st.notebookId  || null;
    currentPageId      = st.pageId      || null;
    if (st.dailyDate)  selectedDailyDate = st.dailyDate;
    // openNote()/renderNotebookDetail() only touch #content, not the primary
    // nav sidebar (#nav) — that's fine for normal in-app navigation since
    // renderNav() already ran for whatever view came before, but on a fresh
    // page load nothing has rendered #nav yet. Without this, a reload that
    // restores straight into a note or notebook page leaves the entire nav
    // bar blank until the user manually switches views.
    applyTheme();
    renderNav();
    window.route = route;
    if (st.noteId && (db.notes||[]).some(n => n.id === st.noteId && !n.deletedAt)) {
      window._openNoteId = st.noteId;
      try { openNote(st.noteId); } catch(_) { render(); }
    } else if (st.route === 'notebooks' && st.notebookId) {
      try { renderNotebookDetail(st.notebookId); } catch(_) { render(); }
    } else {
      render();
    }
    return true;
  } catch(_) { return false; }
}
window._navSaveSession    = _navSaveSession;
window._navRestoreSession = _navRestoreSession;

function renderNav(){
  nav.innerHTML = sections.map(s => `<button data-route="${s.id}" class="${route===s.id?'active':''}">${s.label}</button>`).join("");
  nav.querySelectorAll("button").forEach(b=> b.onclick = ()=>{ _navPush(); route=b.dataset.route; if(route==='today') selectedDailyDate = todayKey(); render(); });
  // Due/overdue count badge — shown on both the desktop sidebar nav AND the mobile bottom bar
  const _tStr = todayKey();
  const _dueN = (db.tasks||[]).filter(t => t.status==='TODO' && !t.deletedAt && t.due && t.due <= _tStr).length;
  const _badgeHtml = _dueN ? ` <span style="display:inline-block;background:#ef4444;color:#fff;border-radius:10px;font-size:10px;padding:1px 5px;vertical-align:middle;font-weight:700;line-height:1.4;">${_dueN}</span>` : '';
  const _todayNavBtn = nav.querySelector('[data-route="today"]');
  if(_todayNavBtn && _dueN) _todayNavBtn.innerHTML += _badgeHtml;
  // Mobile bottom bar — reset the Today button label then apply badge
  const _mbToday = document.querySelector('#mobileBar [data-nav="today"]');
  if(_mbToday) _mbToday.innerHTML = 'Today' + _badgeHtml;
}

function htmlesc(s){ return String(s ?? '').replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[m])); }

// Enhanced markdown rendering using marked.js library with fallback
// This function provides:
//  - Full markdown support via marked.js when available
//  - Safe HTML rendering to prevent XSS attacks
//  - Basic markdown support as fallback if marked.js fails to load
//  - Converts headings, lists, code blocks, emphasis, and more
// --- Note status helpers ---
// Status is a free-form string on note.status. Known values render as a small
// colored pill via styles.css `.status-pill[data-s="..."]`. Unknown / empty
// values render as nothing so older notes stay visually unchanged.
const NOTE_STATUS_LABELS = {
  inbox:     '📥 Inbox',
  reading:   '📖 Reading',
  read:      '✅ Read',
  annotated: '✍️ Annotated',
  followup:  '🔁 Follow up',
  archive:   '🗄️ Archived',
};
function statusBadge(status){
  if(!status) return '';
  const label = NOTE_STATUS_LABELS[status] || status;
  return ` <span class='status-pill' data-s='${htmlesc(status)}'>${htmlesc(label)}</span>`;
}

// --- Wiki-link helpers ---
// Pre-process [[Title]] tokens out of markdown source so marked.js doesn't mangle
// them, and stitch them back in as <a class='wikilink'> after rendering. Missing
// notes get class 'missing' so they appear visually distinct.
function _wikiPlaceholderFor(i){ return `xWiKiLiNk${i}WiKiLiNkx`; }
function _extractWikiLinks(md){
  const tokens = [];
  // Supports both [[Title]] and [[Title|alias text]]
  const out = md.replace(/\[\[([^\[\]\n|]+?)(?:\|([^\[\]\n]+?))?\]\]/g, (m, rawTitle, rawAlias) => {
    const title = rawTitle.trim();
    if (!title) return m;
    const alias = (rawAlias || '').trim() || null;
    const i = tokens.length;
    tokens.push({ title, alias });
    return _wikiPlaceholderFor(i);
  });
  return { out, tokens };
}
// Fuzzy fallback: tolerates case, whitespace, and inexact wording.
// Returns a note id (or null). Conservative — only matches if the query is
// a substring of the title (case-insensitive) OR title is a substring of query.
function _resolveWikiTitle(title){
  const notes = (window.db && window.db.notes) ? window.db.notes : [];
  if (!title) return null;
  const q = title.toLowerCase().trim();
  // 1. Exact case-insensitive
  for (const n of notes) {
    if (n.deletedAt || !n.title) continue;
    if (n.title.toLowerCase() === q) return n;
  }
  // 2. Substring either way (cheap fuzzy)
  let best = null, bestLen = Infinity;
  for (const n of notes) {
    if (n.deletedAt || !n.title) continue;
    const t = n.title.toLowerCase();
    if (t.includes(q) || q.includes(t)) {
      if (n.title.length < bestLen) { best = n; bestLen = n.title.length; }
    }
  }
  return best;
}
function _injectWikiLinks(html, tokens){
  return html.replace(/xWiKiLiNk(\d+)WiKiLiNkx/g, (m, i) => {
    const tok = tokens[+i] || { title: '', alias: null };
    const display = tok.alias || tok.title;
    const resolved = _resolveWikiTitle(tok.title);
    const safe = htmlesc(display);
    if (resolved) {
      const titleAttr = resolved.title.toLowerCase() === tok.title.toLowerCase()
        ? `Open ${htmlesc(resolved.title)}`
        : `Open ${htmlesc(resolved.title)} (fuzzy match for "${htmlesc(tok.title)}")`;
      return `<a class='wikilink' data-id='${resolved.id}' title='${titleAttr}'>${safe}</a>`;
    }
    return `<a class='wikilink missing' data-title='${htmlesc(tok.title)}' title='Click to create \u201C${htmlesc(tok.title)}\u201D'>${safe}</a>`;
  });
}
// Pre-process ==highlight== tokens out of markdown source (same technique as
// wiki-links above) so marked doesn't mangle them, then stitch them back in
// as <mark> after rendering. Supports an optional leading color code and an
// optional trailing margin-comment footnote:
//   ==text==            plain yellow highlight
//   ==g:text==           colored highlight (y|g|p|b = yellow/green/pink/blue)
//   ==text==^[a note]    highlight with a margin annotation (hover/click to read)
//   ==g:text==^[a note]  both combined
const HL_COLORS = { y: 'yellow', g: 'green', p: 'pink', b: 'blue' };
function _hlPlaceholderFor(i){ return `xHiLiTexN${i}NxHiLiTex`; }
function _extractHighlights(md){
  const tokens = [];
  const out = md.replace(/==(?:([ygpb]):)?([^=\n]+?)==(?:\^\[([^\]\n]*)\])?/g, (m, color, text, note) => {
    const i = tokens.length;
    tokens.push({ color: HL_COLORS[color] ? color : 'y', text, note: (note || '').trim() });
    return _hlPlaceholderFor(i);
  });
  return { out, tokens };
}
function _injectHighlights(html, tokens){
  return html.replace(/xHiLiTexN(\d+)NxHiLiTex/g, (m, i) => {
    const tok = tokens[+i];
    if (!tok) return m;
    const noteAttr = tok.note ? ` data-note='${htmlesc(tok.note)}' title='\uD83D\uDCAC ${htmlesc(tok.note)}'` : '';
    const badge = tok.note ? ` <sup class='hl-note-badge' data-hl-idx='${i}'>\uD83D\uDCAC</sup>` : '';
    return `<mark class='hl hl-${tok.color}' data-hl-idx='${i}'${noteAttr}>${htmlesc(tok.text)}</mark>${badge}`;
  });
}

// ---------------------------------------------------------------------------
// Highlight & margin-note creation directly from the rendered PREVIEW pane
// (select-to-highlight, PDF-viewer style) — rather than only via the
// editor toolbar buttons above, which require switching to Edit mode and
// manually typing/selecting inside the raw textarea. This mirrors how you'd
// annotate a PDF: select text where you're actually reading it, pick a
// highlight color (or add a note), done.
//
// The tricky part is that the preview is rendered HTML, not the raw
// markdown source — so a selection made in the preview has to be mapped
// back to a character range in the textarea's raw value before we can
// splice in `==...==` markup. `_locateSourceRange` does this via a plain
// substring search of the selected text against the source, skipping over
// any occurrence that's already wrapped in `==...==` so re-highlighting a
// duplicate phrase elsewhere in the note doesn't quietly re-target text
// that's already annotated.
//
// A bare substring search alone is NOT enough: if the selected text (a
// common word, a repeated phrase/heading, etc.) occurs more than once in
// the note, `indexOf` always finds the FIRST occurrence — which silently
// highlights the wrong spot whenever the user selects a LATER occurrence
// of the same text. `approxRatio` (the selection's position as a 0..1
// fraction of the way through the rendered preview's plain text, computed
// by the caller) disambiguates: among all matching candidates, we pick the
// one whose position (as the same fraction of the source length) is
// closest to that ratio. Markdown syntax means source length and rendered
// text length aren't identical, so this is approximate, but document order
// is preserved end-to-end, so the closest-by-ratio candidate is reliably
// the one actually selected — a single duplicate word could theoretically
// still be borderline, but a whole selected phrase is unambiguous in
// practice.
function _locateSourceRange(source, selText, approxRatio){
  if(!selText) return null;
  const candidates = [];
  let from = 0;
  while(true){
    const idx = source.indexOf(selText, from);
    if(idx === -1) break;
    const already = source.slice(Math.max(0, idx-2), idx) === '=='
      && source.slice(idx+selText.length, idx+selText.length+2) === '==';
    if(!already) candidates.push(idx);
    from = idx + 1;
  }
  if(!candidates.length) return null;
  if(candidates.length === 1 || approxRatio == null){
    return { start: candidates[0], end: candidates[0]+selText.length };
  }
  const expectedPos = approxRatio * source.length;
  let best = candidates[0], bestDist = Infinity;
  for(const c of candidates){
    const d = Math.abs(c - expectedPos);
    if(d < bestDist){ bestDist = d; best = c; }
  }
  return { start: best, end: best+selText.length };
}
// Computes a linear character offset of (node, offset) within all the text
// content of `container`, by walking its text nodes in DOM order and
// summing lengths. Used to figure out roughly how far through the rendered
// preview's plain text a selection starts, for `_locateSourceRange`'s
// `approxRatio` disambiguation.
function _textOffsetInContainer(container, node, offset){
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let total = 0, cur;
  while((cur = walker.nextNode())){
    if(cur === node) return total + offset;
    total += cur.textContent.length;
  }
  return total;
}
// Splices `text` into a textarea's raw value at [start,end). Uses the
// undo-safe execCommand path when the textarea is actually visible/focusable
// (Edit/Split mode); falls back to a direct .value splice when it's
// display:none (pure Preview mode, where .focus() is a no-op and
// execCommand would silently target the wrong element). The fallback isn't
// a single Ctrl+Z step, but that's an acceptable trade-off for an edit made
// while the raw editor isn't even on screen.
function _replaceSourceRange(ta, start, end, text){
  if(ta.offsetParent !== null){
    _undoableReplaceRange(ta, start, end, text);
  } else {
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
  }
  ta.dispatchEvent(new Event('input'));
}
// Small floating "<message> · Undo" snackbar, shown after every preview-
// triggered highlight/note action (create, edit note, remove). Native
// Ctrl+Z already works for these edits when the textarea is visible, but it
// silently CAN'T reach it in pure Preview mode (`_replaceSourceRange`'s
// fallback there is a direct .value splice — a hidden textarea can't be
// focused, so execCommand has nothing to target). Rather than have undo
// work in some modes and not others, every preview action gets this single,
// explicit, always-reliable "Undo" affordance — the same pattern readers
// like Kindle/Apple Books use for "highlight added" confirmations, and it
// doubles as an obvious "delete this" path for anyone who didn't notice the
// click-to-open annotation popover's own Remove button.
let _undoToastEl = null;
function _showUndoToast(message, onUndo){
  if(!_undoToastEl){
    _undoToastEl = document.createElement('div');
    _undoToastEl.className = 'hl-undo-toast';
    document.body.appendChild(_undoToastEl);
  }
  clearTimeout(_undoToastEl._hideT);
  _undoToastEl.innerHTML = `<span>${htmlesc(message)}</span><button type="button" data-undo>\u21A9 Undo</button>`;
  _undoToastEl.querySelector('[data-undo]').onclick = () => {
    onUndo();
    _undoToastEl.classList.remove('show');
    clearTimeout(_undoToastEl._hideT);
  };
  _undoToastEl.classList.add('show');
  _undoToastEl._hideT = setTimeout(() => _undoToastEl.classList.remove('show'), 6000);
}
// Same as `_replaceSourceRange`, but captures whatever text currently sits
// in [start,end) first and offers it back through the undo toast above —
// one explicit, mode-independent way to reverse any single highlight/note
// action instead of relying solely on native (sometimes unreachable) undo.
function _replaceSourceRangeWithUndo(ta, start, end, text, message){
  const original = ta.value.slice(start, end);
  _replaceSourceRange(ta, start, end, text);
  _showUndoToast(message, () => {
    _replaceSourceRange(ta, start, start + text.length, original);
  });
}
// Finds the Nth `==...==` highlight token in a raw markdown source string
// (0-indexed, in document order) — used to map a click on a rendered
// <mark data-hl-idx> back to its exact source range for editing/removal.
// Order is stable because highlight extraction (_extractHighlights) always
// scans left-to-right over the source, same as this regex does here.
function _locateHighlightToken(source, idx){
  const re = /==(?:([ygpb]):)?([^=\n]+?)==(?:\^\[([^\]\n]*)\])?/g;
  let m, i = 0;
  while((m = re.exec(source))){
    if(i === idx){
      return { start: m.index, end: m.index + m[0].length, color: HL_COLORS[m[1]] ? m[1] : 'y', text: m[2], note: (m[3]||'').trim() };
    }
    i++;
  }
  return null;
}
// Floating mini-toolbar shown when text is selected inside a rendered
// preview pane: 4 color swatches (plain highlight) + a note button
// (yellow highlight + prompt for a margin note), matching the same actions
// already available from the editor toolbar's highlight buttons.
let _hlSelectPopupEl = null;
function _ensureHlSelectPopup(){
  if(_hlSelectPopupEl) return _hlSelectPopupEl;
  const el = document.createElement('div');
  el.className = 'hl-select-popup';
  el.innerHTML = `
    <button type="button" data-hl-color="y" title="Highlight — yellow">\uD83D\uDFE1</button>
    <button type="button" data-hl-color="g" title="Highlight — green">\uD83D\uDFE2</button>
    <button type="button" data-hl-color="p" title="Highlight — pink">\uD83E\uDD0D</button>
    <button type="button" data-hl-color="b" title="Highlight — blue">\uD83D\uDD35</button>
    <button type="button" data-hl-note title="Highlight & add a note">\uD83D\uDCAC</button>
  `;
  document.body.appendChild(el);
  _hlSelectPopupEl = el;
  return el;
}
function _hideHlSelectPopup(){
  if(_hlSelectPopupEl) _hlSelectPopupEl.classList.remove('show');
}
// Wires select-to-highlight into one preview pane. `previewEl` is the
// rendered `.markdown-preview` element; `ta` is its paired source textarea
// (may be hidden if currently in pure Preview mode — handled by
// `_replaceSourceRange`). Safe to call once per time the pane is (re)opened;
// listeners are scoped to `previewEl`/`ta`, which are fresh DOM nodes each
// time openNote()/openPageInNotebook() runs.
function _wireHighlightSelectionPopup(previewEl, ta){
  if(!previewEl || !ta) return;
  const popup = _ensureHlSelectPopup();
  let pendingRange = null; // {start,end} in ta.value, set right before showing the popup
  function applyAction(action){
    if(!pendingRange) return;
    const { start, end } = pendingRange;
    const selText = ta.value.slice(start, end);
    (async () => {
      if(action === 'note'){
        const note = await showPrompt('Margin note for this highlight (optional):', '', 'Add', 'Skip');
        const suffix = (note && note.trim()) ? `^[${note.trim()}]` : '';
        _replaceSourceRangeWithUndo(ta, start, end, `==${selText}==${suffix}`, suffix ? 'Highlight & note added' : 'Highlighted');
      } else {
        const wrapped = action === 'y' ? `==${selText}==` : `==${action}:${selText}==`;
        _replaceSourceRangeWithUndo(ta, start, end, wrapped, 'Highlighted');
      }
    })();
    window.getSelection().removeAllRanges();
    _hideHlSelectPopup();
    pendingRange = null;
  }
  popup.querySelectorAll('[data-hl-color]').forEach(btn => {
    // mousedown (not click) + preventDefault so the browser never collapses
    // the live text selection before we've read it.
    btn.onmousedown = (e) => { e.preventDefault(); applyAction(btn.dataset.hlColor); };
  });
  const noteBtn = popup.querySelector('[data-hl-note]');
  if(noteBtn) noteBtn.onmousedown = (e) => { e.preventDefault(); applyAction('note'); };

  previewEl.addEventListener('mouseup', () => {
    setTimeout(() => { // let the browser finish updating the selection first
      const sel = window.getSelection();
      const text = sel && sel.toString();
      if(!text || !text.trim() || sel.isCollapsed
         || !previewEl.contains(sel.anchorNode) || !previewEl.contains(sel.focusNode)){
        _hideHlSelectPopup();
        return;
      }
      const selRange = sel.getRangeAt(0);
      const previewTextLen = previewEl.textContent.length;
      const startOffset = _textOffsetInContainer(previewEl, selRange.startContainer, selRange.startOffset);
      const approxRatio = previewTextLen > 0 ? startOffset / previewTextLen : null;
      const range = _locateSourceRange(ta.value, text, approxRatio);
      if(!range){ _hideHlSelectPopup(); return; }
      pendingRange = range;
      const rect = selRange.getBoundingClientRect();
      popup.classList.add('show');
      const pw = popup.offsetWidth || 160, ph = popup.offsetHeight || 34;
      let left = rect.left + rect.width/2 - pw/2;
      left = Math.max(6, Math.min(left, window.innerWidth - pw - 6));
      let top = rect.top - ph - 8;
      if(top < 6) top = rect.bottom + 8;
      popup.style.left = `${left}px`;
      popup.style.top = `${top}px`;
    }, 0);
  });
}
document.addEventListener('mousedown', (e) => {
  if(_hlSelectPopupEl && !_hlSelectPopupEl.contains(e.target)) _hideHlSelectPopup();
});
document.addEventListener('keydown', (e) => { if(e.key === 'Escape') _hideHlSelectPopup(); });

// PDF-viewer-style annotation popover: clicking an existing highlight (or
// its 💬 badge) in ANY rendered preview opens a small card showing the
// margin note (if any) with Edit/Remove actions, instead of only a native
// hover tooltip. Registered once, delegated at the document level (like the
// wikilink click handler above) since preview panes are re-rendered
// (innerHTML replaced) on every keystroke — per-element listeners would be
// lost on each render, a delegated listener is not.
let _hlNotePopoverEl = null;
function _ensureHlNotePopover(){
  if(_hlNotePopoverEl) return _hlNotePopoverEl;
  const el = document.createElement('div');
  el.className = 'hl-note-popover';
  document.body.appendChild(el);
  _hlNotePopoverEl = el;
  return el;
}
function _hideHlNotePopover(){
  if(_hlNotePopoverEl) _hlNotePopoverEl.classList.remove('show');
}
document.addEventListener('click', (e) => {
  const mark = e.target.closest && e.target.closest('mark.hl, sup.hl-note-badge');
  if(!mark){
    if(_hlNotePopoverEl && !_hlNotePopoverEl.contains(e.target)) _hideHlNotePopover();
    return;
  }
  const wrap = mark.closest('.editor-pane-wrap');
  const ta = wrap && wrap.querySelector('textarea');
  const idx = +mark.dataset.hlIdx;
  if(!ta || Number.isNaN(idx)) return;
  const tok = _locateHighlightToken(ta.value, idx);
  if(!tok) return;
  const popover = _ensureHlNotePopover();
  popover.innerHTML = `
    <div class="hl-note-popover-body">${tok.note ? htmlesc(tok.note) : '<em>No note yet</em>'}</div>
    <div class="hl-note-popover-actions">
      <button type="button" data-hl-act="note">${tok.note ? '\u270F\uFE0F Edit' : '\u2795 Add note'}</button>
      <button type="button" data-hl-act="remove">\uD83D\uDDD1 Remove</button>
    </div>`;
  popover.querySelector('[data-hl-act="note"]').onclick = async () => {
    const note = await showPrompt('Margin note for this highlight:', tok.note || '', 'Save', 'Cancel');
    if(note === null){ return; } // cancelled
    const fresh = _locateHighlightToken(ta.value, idx); // re-locate; source may have shifted
    if(!fresh) return;
    const suffix = note.trim() ? `^[${note.trim()}]` : '';
    const prefix = fresh.color === 'y' ? '' : `${fresh.color}:`;
    _replaceSourceRangeWithUndo(ta, fresh.start, fresh.end, `==${prefix}${fresh.text}==${suffix}`, tok.note ? 'Note updated' : 'Note added');
    _hideHlNotePopover();
  };
  popover.querySelector('[data-hl-act="remove"]').onclick = () => {
    const fresh = _locateHighlightToken(ta.value, idx);
    if(!fresh) return;
    _replaceSourceRangeWithUndo(ta, fresh.start, fresh.end, fresh.text, 'Highlight removed');
    _hideHlNotePopover();
  };
  const rect = mark.getBoundingClientRect();
  popover.classList.add('show');
  const pw = popover.offsetWidth || 220, ph = popover.offsetHeight || 80;
  let left = rect.left;
  left = Math.max(6, Math.min(left, window.innerWidth - pw - 6));
  let top = rect.bottom + 8;
  if(top + ph > window.innerHeight - 6) top = rect.top - ph - 8;
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
});

function openNoteByTitle(rawTitle){
  const title = (rawTitle || '').trim();
  if (!title) return;
  const match = _resolveWikiTitle(title);
  if (match) { openNote(match.id); return; }
  const created = createNote({ title, content: '', type: 'note' });
  openNote(created.id);
}
window.openNoteByTitle = openNoteByTitle;
// Delegated click handler for wiki-links anywhere in the app
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a.wikilink');
  if (!a) return;
  e.preventDefault();
  if (a.dataset.id) {
    if (typeof openNote === 'function') openNote(a.dataset.id);
  } else if (a.dataset.title) {
    openNoteByTitle(a.dataset.title);
  }
});

// Pre-pass: pull block math ($$ ... $$ on their own lines) out before
// marked runs, render with KaTeX directly, and stash placeholders. The
// marked-katex-extension's block tokenizer was unreliable against real-world
// input (line endings, paragraph joining, ordering vs. other extensions) so
// we sidestep marked entirely for the block form. Inline $...$ is still
// handled by markedKatex.
function _extractBlockMath(md){
  const blocks = [];
  // Match $$ on its own line, content, $$ on its own line. Tolerates CRLF
  // and trailing whitespace. Non-greedy on content, requires closing $$ to
  // be at line start.
  const out = md.replace(/(^|\r?\n)\$\$[ \t]*\r?\n([\s\S]+?)\r?\n[ \t]*\$\$[ \t]*(?=\r?\n|$)/g, (_m, lead, expr) => {
    const i = blocks.length;
    blocks.push(expr);
    // Pure-ASCII sentinel: NUL gets stripped by DOMPurify/marked. The token
    // is unusual enough to not collide with real prose, and we render it as
    // a render() of the math; marked will wrap it in <p>, which we strip.
    return `${lead}xKaTeXBlocK${i}KaTeXBlocKx`;
  });
  return { out, blocks };
}
function _renderBlockMath(html, blocks){
  if(!blocks.length) return html;
  // Unwrap solo <p>token</p> first so the rendered display math isn't nested
  // inside a paragraph (invalid HTML, breaks katex-display styling).
  html = html.replace(/<p>\s*(xKaTeXBlocK\d+KaTeXBlocKx)\s*<\/p>/g, '$1');
  return html.replace(/xKaTeXBlocK(\d+)KaTeXBlocKx/g, (_m, i) => {
    const expr = blocks[+i] || '';
    if(typeof katex === 'undefined') return `<pre><code>${htmlesc('$$\n'+expr+'\n$$')}</code></pre>`;
    try { return katex.renderToString(expr, { displayMode: true, throwOnError: true, output: 'html' }); }
    catch(e){
      const msg = String(e && e.message || e);
      return `<div class="katex-error" style="border:1px solid #f55;background:rgba(255,85,85,.08);color:#f88;padding:.5em .75em;border-radius:4px;font-family:monospace;white-space:pre-wrap"><strong style="color:#f55">KaTeX error:</strong> ${htmlesc(msg)}\n${htmlesc('$$\n'+expr+'\n$$')}</div>`;
    }
  });
}

function markdownToHtml(md){
  if(!md) return '';
  const { out: mathStripped, blocks: mathBlocks } = _extractBlockMath(md);
  const { out: wikiStripped, tokens } = _extractWikiLinks(mathStripped);
  const { out: stripped, tokens: hlTokens } = _extractHighlights(wikiStripped);
  // Use marked.js if available for full markdown support
  if(typeof marked !== 'undefined'){
    try {
      // One-time wiring of optional enrichers (CDN-loaded; skipped if absent):
      //  • marked-highlight + highlight.js → syntax colors in fenced code
      //  • marked-gfm-heading-id           → id="..." on headings (deep links + TOC)
      //  • DOMPurify (applied below)       → strips <script>, event handlers, etc.
      // Each enricher is registered independently and only when its CDN
      // global is actually present. If a CDN script was slow / blocked on the
      // first preview call, the next call will retry just the missing pieces
      // instead of one-shot disabling everything.
      marked._extFlags = marked._extFlags || {};
      const _ef = marked._extFlags;
      if(!_ef.hl && typeof markedHighlight !== 'undefined' && typeof hljs !== 'undefined'){
        try {
          marked.use(markedHighlight.markedHighlight({
            langPrefix: 'hljs language-',
            highlight(code, lang){
              const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
              try { return hljs.highlight(code, { language, ignoreIllegals: true }).value; }
              catch(_) { return code; }
            }
          }));
          _ef.hl = true;
        } catch(e){ console.warn('marked-highlight setup failed:', e); _ef.hl = true; }
      }
      if(!_ef.hid && typeof markedGfmHeadingId !== 'undefined' && markedGfmHeadingId.gfmHeadingId){
        try { marked.use(markedGfmHeadingId.gfmHeadingId()); _ef.hid = true; }
        catch(e){ console.warn('gfm-heading-id setup failed:', e); _ef.hid = true; }
      }
      if(!_ef.katex && typeof markedKatex !== 'undefined' && typeof katex !== 'undefined'){
        try { marked.use(markedKatex({ throwOnError: false, output: 'html' })); _ef.katex = true; }
        catch(e){ console.warn('marked-katex setup failed:', e); _ef.katex = true; }
      }
      if(!_ef.mermaid){
        try {
          marked.use({ extensions: [{
            name: 'mermaid', level: 'block',
            start(src){ const m = src.match(/```mermaid/); return m ? m.index : -1; },
            tokenizer(src){
              const m = /^```mermaid\s*\n([\s\S]*?)\n```/.exec(src);
              if(m) return { type: 'mermaid', raw: m[0], code: m[1] };
            },
            renderer(t){ return `<div class="mermaid" data-mermaid-src="${htmlesc(t.code)}">${htmlesc(t.code)}</div>`; }
          }]});
          _ef.mermaid = true;
        } catch(e){ console.warn('mermaid block extension setup failed:', e); _ef.mermaid = true; }
      }
      // One-shot diagnostic: surface missing CDN globals so we know why a
      // feature isn't rendering, instead of silently degrading.
      if(!marked._missingWarned){
        marked._missingWarned = true;
        const missing = [];
        if(typeof markedKatex === 'undefined' || typeof katex === 'undefined') missing.push('katex');
        if(typeof DOMPurify === 'undefined') missing.push('DOMPurify');
        if(typeof hljs === 'undefined') missing.push('highlight.js');
        if(missing.length) console.warn('Markdown enrichers not loaded:', missing.join(', '), '— check network tab for CDN failures.');
      }
      // Configure marked for safe rendering
      marked.setOptions({
        breaks: true,        // Convert single line breaks to <br>
        gfm: true,          // GitHub Flavored Markdown
        sanitize: false,     // DOMPurify handles sanitization below
        smartLists: true,    // Use smarter list behavior
        smartypants: false   // Don't use smart quotes (can cause issues)
      });
      const raw = marked.parse(stripped);
      // DOMPurify removes <script>, on* handlers, javascript: urls, etc. Keep
      // id/class so heading anchors and hljs color classes survive. data-mermaid-src
      // is preserved so the lazy renderer can recover the original source even
      // after mermaid has replaced the div with rendered SVG.
      const safe = (typeof DOMPurify !== 'undefined')
        ? DOMPurify.sanitize(raw, { USE_PROFILES: { html: true }, ADD_ATTR: ['target','rel','data-mermaid-src','data-note','data-hl-idx'] })
        : raw;
      return _renderBlockMath(_injectWikiLinks(_injectHighlights(safe, hlTokens), tokens), mathBlocks);
    } catch(error) {
      console.warn('marked.js failed, falling back to basic renderer:', error);
    }
  }
  // Fallback path uses the stripped source too so wiki tokens survive escaping
  md = stripped;
  
  // Fallback basic markdown implementation
  // Escape HTML first
  let html = htmlesc(md);
  // Code fences ```content``` → <pre><code>content</code></pre>
  html = html.replace(/```([\s\S]*?)```/g, (m, code) => {
    return '<pre><code>' + code.trim().replace(/\n/g,'<br>') + '</code></pre>';
  });
  // Headings: process from largest to smallest to avoid conflicts
  html = html.replace(/^######\s+(.*)$/gm, '<h6>$1</h6>');
  html = html.replace(/^#####\s+(.*)$/gm, '<h5>$1</h5>');
  html = html.replace(/^####\s+(.*)$/gm, '<h4>$1</h4>');
  html = html.replace(/^###\s+(.*)$/gm, '<h3>$1</h3>');
  html = html.replace(/^##\s+(.*)$/gm, '<h2>$1</h2>');
  html = html.replace(/^#\s+(.*)$/gm, '<h1>$1</h1>');
  // Unordered lists: group consecutive list items into a single <ul>
  html = html.replace(/(^|\n)([-\*])\s+(.*(?:\n(?:[-\*])\s+.*)*)/g, (match, lead, bullet, items) => {
    const lines = match.trim().split(/\n/).map(l => l.replace(/^[-\*]\s+/, ''));
    return '<ul>' + lines.map(item => '<li>' + item + '</li>').join('') + '</ul>';
  });
  // Bold **text**
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic *text* or _text_
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>');
  // Inline code `code`
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Paragraphs: replace two or more newlines with <br><br>, single newline with <br>
  html = html.replace(/\n{2,}/g, '<br><br>');
  html = html.replace(/\n/g, '<br>');
  return _renderBlockMath(_injectWikiLinks(_injectHighlights(html, hlTokens), tokens), mathBlocks);
}

// Lazy mermaid loader + post-processor. Call after setting innerHTML on any
// element that contains <div class="mermaid"> blocks. Fetches mermaid.js on
// the FIRST detection so users who never write diagrams pay zero bytes.
let _mermaidLoadPromise = null;
function _ensureMermaid(){
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (typeof window.mermaid !== 'undefined') return Promise.resolve(window.mermaid);
  if (_mermaidLoadPromise) return _mermaidLoadPromise;
  _mermaidLoadPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js';
    s.async = true;
    s.onload = () => {
      try {
        window.mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });
        resolve(window.mermaid);
      } catch (e) { reject(e); }
    };
    s.onerror = () => reject(new Error('Failed to load mermaid'));
    document.head.appendChild(s);
  });
  return _mermaidLoadPromise;
}
function _processMermaid(root){
  if (!root) return;
  const nodes = root.querySelectorAll('.mermaid:not([data-rendered])');
  if (!nodes.length) return;
  // Restore each node's text from data-mermaid-src in case a prior render
  // replaced its content with an SVG and we're re-rendering on edit.
  nodes.forEach(n => {
    const src = n.getAttribute('data-mermaid-src');
    if (src) n.textContent = src;
  });
  _ensureMermaid().then(m => {
    if (!m) return;
    try { m.run({ nodes: Array.from(nodes) }); }
    catch(e) { console.warn('mermaid render failed:', e); }
    nodes.forEach(n => n.setAttribute('data-rendered', '1'));
  }).catch(err => console.warn('mermaid load failed:', err));
}

// ------------------------------------------------------------------
// Custom modal helpers
// Implement simple promise-based confirmation and prompt dialogs
// to replace native browser confirm() and prompt(). These dialogs
// integrate with the app theme via CSS classes defined in styles.css.

/**
 * Show a confirmation dialog and resolve with true if user confirms.
 * @param {string} message The message to display.
 * @param {string} okText Text for the confirmation button.
 * @param {string} cancelText Text for the cancel button.
 * @returns {Promise<boolean>} Resolves to true if confirmed, else false.
 */
function showConfirm(message, okText = 'OK', cancelText = 'Cancel'){
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'modal';
    // Escape message using htmlesc to avoid injection
    modal.innerHTML = `
      <div class="modal-body">${htmlesc(message)}</div>
      <div class="modal-footer">
        <button class="btn" id="modalCancel">${htmlesc(cancelText)}</button>
        <button class="btn acc" id="modalOk">${htmlesc(okText)}</button>
      </div>`;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    // Focus first button for accessibility
    setTimeout(()=>{
      modal.querySelector('#modalOk').focus();
    }, 0);
    modal.querySelector('#modalOk').onclick = ()=>{
      document.body.removeChild(overlay);
      resolve(true);
    };
    modal.querySelector('#modalCancel').onclick = ()=>{
      document.body.removeChild(overlay);
      resolve(false);
    };
  });
}

/**
 * Show a prompt dialog and resolve with the entered string. If the
 * user cancels, resolves to null.
 * @param {string} message The prompt message.
 * @param {string} defaultValue Default value for the input.
 * @param {string} okText OK button text.
 * @param {string} cancelText Cancel button text.
 * @returns {Promise<string|null>} The entered value or null if cancelled.
 */
function showPrompt(message, defaultValue = '', okText = 'OK', cancelText = 'Cancel'){
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-body">${htmlesc(message)}</div>
      <input id="modalInput" type="text" value="${htmlesc(defaultValue)}" />
      <div class="modal-footer">
        <button class="btn" id="modalCancel">${htmlesc(cancelText)}</button>
        <button class="btn acc" id="modalOk">${htmlesc(okText)}</button>
      </div>`;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    const inputEl = modal.querySelector('#modalInput');
    inputEl.focus();
    // handle Enter key to confirm
    inputEl.addEventListener('keydown', (e)=>{
      if(e.key === 'Enter'){
        modal.querySelector('#modalOk').click();
      }
    });
    modal.querySelector('#modalOk').onclick = ()=>{
      const val = inputEl.value;
      document.body.removeChild(overlay);
      resolve(val || '');
    };
    modal.querySelector('#modalCancel').onclick = ()=>{
      document.body.removeChild(overlay);
      resolve(null);
    };
  });
}

/**
 * Password-masked variant of showPrompt(), used to re-confirm the app
 * password before unlocking edit mode on "immutable" reference content.
 * @param {string} message The prompt message.
 * @returns {Promise<string|null>} The entered password, or null if cancelled.
 */
function showPasswordPrompt(message){
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-body">${htmlesc(message)}</div>
      <input id="modalInput" type="password" autocomplete="current-password" />
      <div class='muted' id='modalPwError' style='font-size:12px;color:#ff6b6b;margin-top:6px;display:none;'></div>
      <div class="modal-footer">
        <button class="btn" id="modalCancel">Cancel</button>
        <button class="btn acc" id="modalOk">Unlock</button>
      </div>`;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    const inputEl = modal.querySelector('#modalInput');
    inputEl.focus();
    inputEl.addEventListener('keydown', (e)=>{
      if(e.key === 'Enter'){
        modal.querySelector('#modalOk').click();
      }
    });
    modal.querySelector('#modalOk').onclick = ()=>{
      const val = inputEl.value;
      document.body.removeChild(overlay);
      resolve(val || '');
    };
    modal.querySelector('#modalCancel').onclick = ()=>{
      document.body.removeChild(overlay);
      resolve(null);
    };
  });
}

// Re-verify the app password against the server (see /api/verify-password).
// This is a UX confirmation gate for editing built-in reference content, not
// a new privilege boundary — an already-authenticated session can already
// rewrite any data via /api/db. Returns true only on an explicit {ok:true}.
async function verifyAppPassword(password){
  try{
    const res = await fetch('/api/verify-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ password })
    });
    const data = await res.json().catch(()=>({}));
    return { ok: res.ok && data.ok === true, error: data.error || (res.ok ? '' : 'Verification failed') };
  }catch(e){
    return { ok:false, error:'Network error: '+e.message };
  }
}

/**
 * Multi-line reason prompt with theme-aware textarea.
 * - opts.required (default false): if true, no Skip button and Save is
 *   disabled while the textarea is empty/whitespace-only. The user MUST
 *   provide a reason — used by the Drop-task flow.
 * - opts.skipText: label for the optional skip button (default 'Skip').
 * - Resolves to the trimmed string on Save, '' on Skip, null on Esc/Cancel.
 *   Required prompts cannot resolve to '' — they only resolve with a
 *   non-empty reason or null (Esc).
 */
function showReasonModal(message, opts = {}){
  const required = !!opts.required;
  const okText     = opts.okText     || 'Save';
  const skipText   = opts.skipText   || 'Skip';
  const cancelText = opts.cancelText || 'Cancel';
  const placeholder = opts.placeholder || (required
    ? 'Why are you dropping this? Required.'
    : 'Optional — what changed, why, what next?');
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'modal';
    const skipBtnHTML = required ? '' : `<button class="btn" id="modalSkip">${htmlesc(skipText)}</button>`;
    modal.innerHTML = `
      <div class="modal-body">${htmlesc(message)}</div>
      <textarea id="modalReason" rows="4" placeholder="${htmlesc(placeholder)}" style="width:100%;min-height:100px;background:var(--input-bg);color:var(--fg);border:1px solid var(--input-border);border-radius:6px;padding:8px;font:inherit;resize:vertical;"></textarea>
      ${required ? '<div id="modalReasonHint" class="muted" style="font-size:11px;margin-top:4px;">A reason is required to drop a task.</div>' : ''}
      <div class="modal-footer" style="margin-top:10px;">
        <button class="btn" id="modalCancel">${htmlesc(cancelText)}</button>
        ${skipBtnHTML}
        <button class="btn acc" id="modalOk">${htmlesc(okText)}</button>
      </div>`;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    const ta = modal.querySelector('#modalReason');
    const okBtn = modal.querySelector('#modalOk');
    const update = () => { if (required) okBtn.disabled = !ta.value.trim(); };
    update();
    ta.addEventListener('input', update);
    setTimeout(() => ta.focus(), 0);
    const close = (val) => { document.body.removeChild(overlay); resolve(val); };
    okBtn.onclick = () => {
      const v = (ta.value || '').trim();
      if (required && !v) { ta.focus(); return; }
      close(v);
    };
    if (!required) modal.querySelector('#modalSkip').onclick = () => close('');
    modal.querySelector('#modalCancel').onclick = () => close(null);
    // Ctrl/Cmd+Enter saves; Esc cancels.
    ta.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); okBtn.click(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(null); }
    });
  });
}
window.showReasonModal = showReasonModal;
function drawProjectsSidebar(){
  if(!projectList) return;
  projectList.innerHTML = db.projects.filter(p=> !p.deletedAt && !p.archivedAt).map(p=> `
    <button class="projBtn ${currentProjectId===p.id?"active":""}" data-proj="${p.id}" title="Select project · double-click name to rename">
      <span class="projName" data-rename="${p.id}" title="Double-click to rename" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${htmlesc(p.name)}</span>
      <span class="projDel" data-del="${p.id}" title="Delete project">✕</span>
    </button>`).join("");
  if(!projectList.dataset.bound){
    projectList.addEventListener('dblclick', (e) => {
      const name = e.target.closest('.projName');
      if (name) {
        e.preventDefault();
        e.stopPropagation();
        renameProjectFlow(name.dataset.rename);
      }
    });
    projectList.addEventListener('click', async (e) => {
      const del = e.target.closest('.projDel');
      if (del) {
        e.stopPropagation();
        const pid = del.dataset.del;
        const proj = db.projects.find(p => p.id === pid);
        if (!proj) return;
        const noteCount = db.notes.filter(n => n.projectId === pid && !n.deletedAt).length;
        const taskCount = db.tasks.filter(t => t.projectId === pid && !t.deletedAt).length;
        const msg = `Delete project "${proj.name}"${noteCount || taskCount ? ` (and its ${noteCount} notes / ${taskCount} tasks)` : ''}? This cannot be undone.`;
        const ok = await showConfirm(msg, 'Delete', 'Cancel');
        if (!ok) return;
        // Soft-delete with tombstones so the server merge propagates the
        // deletion. A hard array-splice can't be removed by POST /api/db's
        // merge-by-id, so the project (and its notes/tasks) resurrected on the
        // next fetch. deletedAt + a fresh updatedAt wins the merge; the lists
        // already filter deletedAt, and _hardDeletedIds blocks re-add this session.
        const now = new Date().toISOString();
        db.notes.forEach(n => { if (n.projectId === pid && !n.deletedAt) { n.deletedAt = now; n.updatedAt = now; window._hardDeletedIds.add(n.id); } });
        db.tasks.forEach(t => { if (t.projectId === pid && !t.deletedAt) { t.deletedAt = now; t.updatedAt = now; window._hardDeletedIds.add(t.id); } });
        if (proj) { proj.deletedAt = now; proj.archivedAt = now; proj.updatedAt = now; }
        window._hardDeletedIds.add(pid);
        if (currentProjectId === pid) currentProjectId = null;
        save();
        drawProjectsSidebar();
        if (route === 'projects') render();
        return;
      }
      const btn = e.target.closest('.projBtn');
      if (btn) {
        const pid = btn.dataset.proj;
        if (currentProjectId !== pid) {
          currentProjectId = pid;
          route = 'projects';
          render();
          drawProjectsSidebar();
        }
      }
    });
    projectList.dataset.bound='1';
  }
}

// --- Draft note helper ---
// Previously this rendered a separate stripped-down draft form, which left
// many editor features (Attach, Linked Notes, Duplicate, Export, Template
// selector, markdown toolbar, project select, etc.) inaccessible until the
// note was saved once. We now create the note immediately and open the full
// editor — instantly available features, no divergence to maintain.
function openDraftNote({title='', projectId=null, type='note', templateId=''}){
  let contentTxt='';
  if(templateId){
    const tpl = db.templates.find(t=>t.id===templateId);
    if(tpl){
      contentTxt = tpl.content
        .replace(/\[Title\]/g, title)
        .replace(/\[Date\]/g, new Date().toLocaleDateString())
        .replace(/\[Project Name\]/g, projectId? (db.projects.find(p=>p.id===projectId)?.name || '') : '');
    }
  }
  const newNote = createNote({
    title: title || 'Untitled',
    content: contentTxt,
    projectId,
    type
  });
  openNote(newNote.id);
}

// TRIAL (Option 2): Recurring monthly tasks are now rendered VIRTUALLY from
// db.monthly in the Today view via getRecurringForDate(); they are no longer
// materialized into db.tasks here. This stops daily-note creation from
// piling up duplicate task rows (Workout x35, Meditation x34, etc.). Real
// rows in db.tasks are only created when the user diverges (reschedule,
// add subtasks, etc.) — to be added in a follow-up if this UX pans out.
// The function body is kept as a no-op so existing call sites stay valid.
function syncMonthlyTasksToDaily(_daily, _dateKey){ return; }

// Return the recurring entries that should appear for a given date, with
// per-date completion status read from m.completions[dateKey].
function getRecurringForDate(dateKey){
  if(!dateKey || !Array.isArray(db.monthly)) return [];
  const dObj = new Date(dateKey + 'T00:00:00');
  const weekday = dObj.getDay();
  const monthKey = dateKey.slice(0, 7);
  const seen = new Set();
  const out = [];
  for(const m of db.monthly){
    if(m.deletedAt) continue;
    if(!m.month || m.month !== monthKey) continue;
    const tDays = Array.isArray(m.days) ? m.days : [];
    if(tDays.length && !tDays.includes(weekday)) continue;
    if(seen.has(m.title)) continue;
    seen.add(m.title);
    const completions = (m.completions && typeof m.completions === 'object') ? m.completions : {};
    out.push({ m, completed: completions[dateKey] === true });
  }
  return out;
}

// Toggle a recurring task's completion for a specific date.
function setRecurringCompletion(monthlyId, dateKey, done){
  const m = (db.monthly || []).find(x => x.id === monthlyId);
  if(!m) return;
  if(!m.completions || typeof m.completions !== 'object') m.completions = {};
  if(done) m.completions[dateKey] = true;
  else delete m.completions[dateKey];
  m.updatedAt = nowISO();
  save();
}

// Legacy helper (no longer used by syncMonthlyTasksToDaily but kept for any
// other call sites). Returns the set of lowercased titles for non-deleted
// monthly recurring tasks scoped to the same month as dateKey.
function _recurringTitlesForMonth(dateKey){
  const monthKey = (dateKey || '').slice(0, 7);
  const titles = new Set();
  (db.monthly || []).forEach(m => {
    if(m.deletedAt) return;
    if(!m.month || m.month !== monthKey) return;
    titles.add((m.title || '').toLowerCase());
  });
  return titles;
}

// Broader version: titles of ALL non-deleted recurring monthly entries
// regardless of month. Used to hide legacy materialized duplicates from
// any cross-time task listing (Pending, Upcoming, Ctrl+K palette).
function _allRecurringTitles(){
  const titles = new Set();
  (db.monthly || []).forEach(m => {
    if(m.deletedAt) return;
    titles.add((m.title || '').toLowerCase());
  });
  return titles;
}

// Shared dedup predicate: true if `t` is an undiverged materialized copy
// of a recurring monthly task (same title, no user customization). Used
// to hide such rows from listings while preserving the underlying data.
function isUndivergedRecurringTask(t, titles){
  titles = titles || _allRecurringTitles();
  if(!t || !titles.has((t.title || '').toLowerCase())) return false;
  if(t.status !== 'TODO') return false;
  if(t.due) return false;
  if(t.description) return false;
  if(Array.isArray(t.subtasks) && t.subtasks.length) return false;
  if(t.priority && t.priority !== 'medium') return false;
  if(t.projectId) return false;
  return true;
}
window.isUndivergedRecurringTask = isUndivergedRecurringTask;
window._allRecurringTitles = _allRecurringTitles;

// Dead code from the old materialize-on-render path; kept commented for
// reference until the trial is accepted or reverted.
function _OLD_syncMonthlyTasksToDaily_DISABLED(daily, dateKey){
  if(!daily || !db.monthly || !Array.isArray(db.monthly)) return;
  try {
    const dObj = new Date(dateKey + 'T00:00:00');
    const weekday = dObj.getDay();
    const monthKey = dateKey.slice(0, 7);
    let changed = false;
    // Only inject tasks that belong to the same month as dateKey.
    // Tasks from past months must be explicitly rolled over via the
    // "Roll Over Tasks" button on the Monthly page before they appear here.
    const seen = new Set();
    db.monthly.forEach(mt => {
      // Skip deleted or tasks that belong to a different month
      if(mt.deletedAt) return;
      if(!mt.month || mt.month !== monthKey) return;
      const tDays = Array.isArray(mt.days) ? mt.days : [];
      // Empty days array means "every day"; otherwise check weekday
      if(tDays.length && !tDays.includes(weekday)) return;
      // Deduplicate by title in case of duplicate entries
      if(seen.has(mt.title)) return;
      seen.add(mt.title);
      // Only count a task as existing if it is NOT soft-deleted.
      // If a past bug or accidental deletion removed a recurring task, we want it
      // to reappear automatically on the next render rather than stay gone forever.
      // (Old comment: "include deleted in check" was causing permanent disappearance.)
      const existingTask = db.tasks.find(t => t.noteId === daily.id && t.title === mt.title);
      if(existingTask && existingTask.deletedAt){
        // Undelete it instead of creating a duplicate
        delete existingTask.deletedAt;
        existingTask.status = existingTask.status === 'DONE' ? 'DONE' : 'TODO';
        existingTask.updatedAt = nowISO();
        changed = true;
      }
      const exists = !!existingTask;
      if(!exists){
        createTask({
          title: mt.title, noteId: daily.id, priority: 'medium',
          description: mt.description || '',
          subtasks: Array.isArray(mt.subtasks) && mt.subtasks.length
            ? mt.subtasks.map(s => ({ id: uid(), title: s.title, status: 'TODO' }))
            : []
        });
        changed = true;
      }
    });
    if(changed) save();
  } catch(err) {
    console.warn('syncMonthlyTasksToDaily error', err);
  }
}

// --- Views ---
function renderToday(){
  const key = selectedDailyDate || todayKey();
  const daily = db.notes.find(n=>n.type==='daily' && n.dateIndex===key && !n.deletedAt) || null;
  // Auto-reattach: if there are tasks detached from a previously-deleted daily
  // for THIS SAME date, re-link them to the current active daily so the user
  // never loses tasks just by deleting (and recreating) today's page.
  if(daily){
    const prevDailyIds = new Set(
      db.notes
        .filter(n => n.type==='daily' && n.dateIndex===key && n.deletedAt && n.id !== daily.id)
        .map(n => n.id)
    );
    if(prevDailyIds.size){
      let reattached = 0;
      const ts = nowISO();
      db.tasks.forEach(t => {
        if(t._detachedFromNoteId && prevDailyIds.has(t._detachedFromNoteId) && !t.noteId && !t.deletedAt){
          t.noteId = daily.id;
          delete t._detachedFromNoteId;
          t.updatedAt = ts;
          reattached++;
        }
      });
      if(reattached) save();
    }
  }
  // For an existing daily note, inject any monthly tasks that were added after
  // the note was originally created (or that weren't present on last open).
  if(daily) syncMonthlyTasksToDaily(daily, key);
  // Exclude archived tasks (deletedAt) when gathering project tasks pool
  // Gather project tasks for today. Exclude backlog tasks and completed tasks so
  // that only outstanding items appear in the Today view. Deleted tasks are
  // also excluded.
  const projectTasks = db.tasks
    .filter(
      (t) =>
        t.projectId &&
        !t.noteId &&
        t.status !== 'BACKLOG' &&
        t.status !== 'DROPPED' &&
        t.status !== 'DONE' &&
        !t.deletedAt
    )
    .sort((a, b) => {
      const priorities = { high: 3, medium: 2, low: 1 };
      return (priorities[b.priority] || 2) - (priorities[a.priority] || 2);
    });
  if(!daily){
    // For today: silently auto-create so the user always lands directly in the editor.
    // For past/future dates: still show the prompt so it's an explicit action.
    if (key === todayKey()) {
      createDailyNoteFor(key);
      renderToday(); // re-enter now that the note exists
      return;
    }
    const tpl = db.settings.dailyTemplate || "# Top 3\n- [ ] \n- [ ] \n- [ ] \n\n## Tasks\n\n## Journal\n\n## Wins\n";
    content.innerHTML = `
      <div class='card'>
        <strong>Create Daily for ${key}</strong>
        <div class='muted' style='margin-top:4px;font-size:12px;'>Not yet in vault. Editing below won't save until you click Create.</div>
        <div style='margin-top:8px;'><textarea id='dailyNewContent' style='min-height:300px;'>${htmlesc(tpl)}</textarea></div>
        <div class='row' style='margin-top:8px;gap:8px;flex-wrap:wrap;'>
          <button id='createDailyBtn' class='btn acc'>Create & Save</button>
        </div>
        <div class='muted' style='margin-top:6px;font-size:11px;'>Rollover / auto-carry will occur only after creation (today only).</div>
      </div>`;
    document.getElementById('createDailyBtn').onclick = ()=>{
      const contentVal = document.getElementById('dailyNewContent').value;
      createDailyNoteFor(key, contentVal);
      renderToday();
    };
    
    // Add Ctrl+S shortcut for create daily note
    const createDailyKeyHandler = (e) => {
      if(e.ctrlKey && !e.shiftKey && (e.key === 's' || e.key === 'S' || e.code === 'KeyS')) {
        e.preventDefault();
        e.stopPropagation();
        document.getElementById('createDailyBtn').click();
        return false;
      }
    };
    
    // Add shortcut to daily creation content field
    const dailyNewContent = document.getElementById('dailyNewContent');
    if(dailyNewContent) dailyNewContent.addEventListener('keydown', createDailyKeyHandler);
    return;
  }
  content.innerHTML = `
    <div class="card">
      <div class="row" style="gap:8px;flex-wrap:wrap;">
        <input id="dailyTitle" type="text" value="${htmlesc(daily.title)}"/>
      </div>
      <div style="margin-top:8px;">
        ${markdownToolbarHtml('dailyContent')}
        <textarea id="dailyContent">${htmlesc(daily.content)}</textarea>
      </div>
      <div class="row" style="margin-top:8px;flex-wrap:wrap;gap:8px;">
        <button id="saveDaily" class="btn acc">Save</button>
        <select id="templateSelect" style="padding:8px;background:var(--btn-bg);border:1px solid var(--btn-border);color:var(--fg);border-radius:6px;">
          <option value="">Apply Template...</option>
          ${db.templates.map(t=>`<option value="${t.id}">${htmlesc(t.name)}</option>`).join("")}
        </select>
        <span id="dailySaveStatus" class="muted" style="font-size:11px;"></span>
      </div>
      <div class="muted" style="margin-top:6px;font-size:11px;">${key===todayKey()? 'Current day' : 'Viewing: '+ new Date(key+"T00:00:00").toDateString()}</div>
    </div>
    <div class="grid-2">
      <div class="card">
        <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px;">
          <strong>${key===todayKey()?"Today's Tasks":"Tasks"}</strong>
          <div class="row" style="gap:6px;">
            <button id="showProjectTasks" class="btn" style="font-size:12px;">${projectTasks.length} project tasks</button>
            <button id="toggleBacklog" class="btn" style="font-size:12px;">Backlog ▾</button>
          </div>
        </div>
        <div class="row" style="margin-top:8px;gap:8px;flex-wrap:wrap;">
          <input id="taskTitle" type="text" placeholder="Quick task (Enter to add)" ${key!==todayKey()? 'disabled title="Add tasks only on current day"':''}/>
          <select id="taskPriority" style="padding:8px;background:var(--btn-bg);border:1px solid var(--btn-border);color:var(--fg);border-radius:6px;" ${key!==todayKey()? 'disabled':''}>
            <option value="low">Low</option>
            <option value="medium" selected>Medium</option>
            <option value="high">High</option>
          </select>
          <!-- Optional due date input -->
          <input id="taskDueDate" type="date" title="mm/dd/yyyy" placeholder="mm/dd/yyyy" style="padding:8px;background:var(--input-bg);border:1px solid var(--input-border);color:var(--fg);border-radius:6px;" />
          <!-- Add button for mobile or accessibility -->
          <button id="taskAddBtn" class="btn">Add</button>
        </div>
        <div id="taskDupHint" style="display:none;margin-top:4px;padding:6px 10px;background:#2a1f10;border:1px solid #f0c040;border-radius:6px;font-size:12px;color:#f0c040;"></div>
        <div id="dueBanner"></div>
        <div id="taskList" class="list" style="margin-top:8px;"></div>
        <div id="prevTaskList" class="list"></div>
        <div id="backlogList" class="list" style="margin-top:8px;display:none;border-top:1px solid #281f3e;padding-top:8px;"></div>
        <div id="projectTaskList" class="list" style="margin-top:8px;display:none;"></div>
      </div>
      <div class="card">
        <div class="muted">Quick Capture (today only)</div>
        <div class="row" style="margin-top:8px;flex-wrap:wrap;gap:8px;">
          <input id="quickCapture" type="text" placeholder="Alt+T for quick task" style="flex:1;min-width:0;" ${key!==todayKey()? 'disabled':''}/>
          <button id="captureBtn" class="btn" ${key!==todayKey()? 'disabled':''}>Add</button>
        </div>
        <div class="muted" style="margin-top:12px;">Scratchpad</div>
        <textarea id="scratch" placeholder="Temporary notes..."></textarea>
        <hr style='margin:14px 0;border-color:var(--btn-border);'/>
        <div style='display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;'>
          <div>
            <strong style='font-size:13px;'>📓 Daily Journal</strong>
            <div class='muted' style='font-size:11px;margin-top:2px;'>${key===todayKey()?'Today — '+new Date().toDateString():new Date(key+'T00:00:00').toDateString()}</div>
          </div>
          <div class='row' style='gap:4px;' id='moodRow'>
            ${[['😊','Great'],['🙂','Good'],['😐','Okay'],['😔','Tired'],['😤','Stressed']].map(([m,lbl])=>`<button class='btn mood-btn' data-mood='${m}' data-label='${lbl}'
              style='font-size:18px;padding:4px 8px;'
              title='${lbl}'>${m}</button>`).join('')}
          </div>
        </div>
        <div style='margin-top:4px;min-height:18px;'>
          <span id='moodLabel' style='font-size:12px;color:var(--acc);font-weight:600;'>
            ${daily.mood ? `Feeling: ${daily.mood} ${({'😊':'Great','🙂':'Good','😐':'Okay','😔':'Tired','😤':'Stressed'})[daily.mood]||''}` : ''}
          </span>
        </div>
        <div style='display:flex;justify-content:space-between;align-items:center;margin-top:6px;flex-wrap:wrap;gap:4px;'>
          <span class='muted' style='font-size:11px;'><span id='journalWc'>0</span> words</span>
          <div class='row' style='gap:4px;'>
            <button class='btn' id='journalStamp' style='font-size:11px;padding:3px 8px;' ${key!==todayKey()?'disabled':''}>&#9200; Stamp time</button>
            <button class='btn acc' id='journalSave' style='font-size:11px;padding:3px 8px;'>Save</button>
          </div>
        </div>
        <div style='margin-top:6px;'>
          ${markdownToolbarHtml('journalContent')}
          <textarea id='journalContent' placeholder='Write here... use \'Stamp time\' to insert a timestamp for a new entry.'
            style='min-height:180px;resize:vertical;width:100%;box-sizing:border-box;'>${htmlesc(daily.journal||'')}</textarea>
        </div>
        <div style='display:flex;justify-content:space-between;margin-top:4px;'>
          <span class='muted' style='font-size:11px;' id='journalSaveStatus'></span>
          <span class='muted' style='font-size:11px;'>Ctrl+S saves both note &amp; journal</span>
        </div>
      </div>
    </div>`;
  const doSaveDaily = () => { updateNote(daily.id, { title: $("#dailyTitle").value, content: $("#dailyContent").value }); showSavedToast('dailySaveStatus'); };
  $("#saveDaily").onclick = doSaveDaily;
  
  // Add Ctrl+S shortcut for daily save
  const dailyKeyHandler = (e) => {
    if(e.ctrlKey && !e.shiftKey && (e.key === 's' || e.key === 'S' || e.code === 'KeyS')) {
      e.preventDefault();
      e.stopPropagation();
      doSaveDaily();
      return false;
    }
  };
  
  // Add shortcut to daily form fields
  const dailyTitle = $("#dailyTitle");
  const dailyContent = $("#dailyContent");
  if(dailyTitle) dailyTitle.addEventListener('keydown', dailyKeyHandler);
  if(dailyContent) dailyContent.addEventListener('keydown', dailyKeyHandler);
  $("#templateSelect").onchange = async (e)=> {
    if(!e.target.value) return;
    const template = db.templates.find(t=> t.id === e.target.value);
    if(template){
      const ok = await showConfirm(`Apply "${template.name}" template? This will replace current content.`, 'Apply', 'Cancel');
      if(ok){
        $("#dailyContent").value = template.content.replace(/\[Date\]/g, new Date().toLocaleDateString()).replace(/\[Title\]/g, '');
      }
    }
    e.target.value = '';
  };
  // --- Markdown toolbar for daily note content ---
  bindMarkdownToolbar('dailyContent');
  wireInlineImagePasteDrop('dailyContent');

  // --- Journal card wiring ---
  const journalEl = document.getElementById('journalContent');
  const journalSaveStatusEl = ()=>document.getElementById('journalSaveStatus');
  const journalWcEl = ()=>document.getElementById('journalWc');
  const updateJournalWc = ()=>{
    const wc=(journalEl&&journalEl.value.trim())? journalEl.value.trim().split(/\s+/).filter(Boolean).length : 0;
    const el=journalWcEl(); if(el) el.textContent=wc;
  };
  if(journalEl){
    updateJournalWc();
    journalEl.addEventListener('input', ()=>{ updateJournalWc(); const s=journalSaveStatusEl(); if(s) s.textContent='Unsaved…'; });
    // Re-bind the toolbar to journalContent AFTER dailyContent was bound
    bindMarkdownToolbar('journalContent');
    wireInlineImagePasteDrop('journalContent');
  }
  const journalSaveBtn = document.getElementById('journalSave');
  const saveJournal = ()=>{
    if(!journalEl) return;
    updateNote(daily.id, { journal: journalEl.value });
    const s=journalSaveStatusEl(); if(s){ s.textContent='Saved ✓'; setTimeout(()=>{ const ss=journalSaveStatusEl(); if(ss) ss.textContent=''; },2000); }
  };
  if(journalSaveBtn) journalSaveBtn.onclick = saveJournal;
  // Mood buttons — toggle CSS class so active state is guaranteed visible
  // regardless of CSS variable specificity fights with .btn rules
  const MOOD_LABELS = {'😊':'Great','🙂':'Good','😐':'Okay','😔':'Tired','😤':'Stressed'};
  const applyMoodView = (activeMood)=>{
    document.querySelectorAll('.mood-btn').forEach(x=>{
      if(x.dataset.mood === activeMood) x.classList.add('mood-btn--active');
      else x.classList.remove('mood-btn--active');
    });
    const lbl = document.getElementById('moodLabel');
    if(lbl) lbl.textContent = activeMood ? `Feeling: ${activeMood} ${MOOD_LABELS[activeMood]||''}` : '';
  };
  // Apply saved mood immediately on render
  applyMoodView(daily.mood || '');
  // Mood buttons
  document.querySelectorAll('.mood-btn').forEach(b=>{
    b.onclick=()=>{
      const newMood = b.dataset.mood;
      // Allow un-selecting the same mood
      const next = (daily.mood === newMood) ? '' : newMood;
      daily.mood = next;
      if (next) logActivity('mood:set', 'note', daily.id, { mood: next, date: daily.dateIndex });
      updateNote(daily.id, {mood: next});
      applyMoodView(next);
    };
  });
  // Timestamp stamp button
  const stampBtn = document.getElementById('journalStamp');
  if(stampBtn && journalEl){
    stampBtn.onclick=()=>{
      const now=new Date();
      const ts=`\n\n---\n**${now.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}** — `;
      const pos=journalEl.selectionEnd;
      _undoableReplaceRange(journalEl, pos, pos, ts);
      journalEl.focus(); journalEl.dispatchEvent(new Event('input'));
    };
  }
  // Auto-save journal on blur
  if(journalEl) journalEl.addEventListener('blur', saveJournal);

  const taskInput = $("#taskTitle"); const quickCapture = $("#quickCapture");
  // Inline duplicate hint: fire on every keystroke in the task title input
  if(taskInput){
    taskInput.addEventListener('input', ()=>{
      const val = taskInput.value.trim();
      const hint = document.getElementById('taskDupHint');
      if(!hint) return;
      if(!val || val.length < 3){ hint.style.display='none'; return; }
      const existing = db.tasks.filter(t => !t.deletedAt && t.status!=='DONE' && t.id);
      const matches = existing.filter(t => taskSimilarity(val, t.title) >= 0.75);
      if(matches.length){
        hint.style.display='block';
        hint.innerHTML = '⚠️ Similar task' + (matches.length>1?'s':'') + ' already exist: ' +
          matches.map(t=>`<strong>${htmlesc(t.title)}</strong>`).join(', ');
      } else {
        hint.style.display='none';
      }
    });
  }
  if(taskInput){
    const handleAddTask = ()=>{
      const titleVal = taskInput.value.trim();
      if(!titleVal) return;
      const dueInput = document.getElementById('taskDueDate');
      let dueVal = null;
      if(dueInput && dueInput.value) {
        // Store the date as YYYY-MM-DD string to avoid timezone issues
        dueVal = dueInput.value;
      }
      createTask({title: titleVal, noteId: daily.id, priority: $("#taskPriority").value, due: dueVal});
      taskInput.value = '';
      if(dueInput) dueInput.value = '';
      // Make sure the user actually sees the row they just added.
      window._tasksCollapsed = false;
      drawTasks();
    };
    taskInput.addEventListener('keydown', e=>{
      const key = e.key || e.keyCode;
      if(key === 'Enter' || key === 13){
        e.preventDefault(); // prevent any form-submit / double-fire
        handleAddTask();
      }
    });
    // Mobile soft keyboards sometimes dispatch input event with insertLineBreak on Enter
    taskInput.addEventListener('input', e=>{
      if(e.inputType === 'insertLineBreak'){
        e.preventDefault();
        handleAddTask();
      }
    });
  }
  // Add button click handler
  const taskAddBtn = document.getElementById('taskAddBtn');
  if(taskAddBtn){
    taskAddBtn.onclick = ()=>{
      const title = taskInput?.value.trim();
      if(!title) return;
      const dueInput = document.getElementById('taskDueDate');
      let dueVal = null;
      if(dueInput && dueInput.value) {
        // Store the date as YYYY-MM-DD string to avoid timezone issues
        dueVal = dueInput.value;
      }
      createTask({title, noteId: daily.id, priority: $("#taskPriority").value, due: dueVal});
      if(taskInput) taskInput.value='';
      if(dueInput) dueInput.value='';
      window._tasksCollapsed = false;
      drawTasks();
    };
  }
  const handleQuickCapture = ()=>{ if(!quickCapture) return; const text = quickCapture.value.trim(); if(!text) return; if(text.startsWith('!')){ createTask({title:text.slice(1), noteId:daily.id, priority:'high'}); } else if(text.includes('#')) { const tags = extractTags(text); createNote({title:text, type:'idea', tags}); } else { createTask({title:text, noteId:daily.id, priority:'medium'}); } quickCapture.value=''; window._tasksCollapsed = false; drawTasks(); };
  if(quickCapture){
    ['keydown','keypress','keyup'].forEach(evt=>{
      quickCapture.addEventListener(evt, e=>{
        const key = e.key || e.keyCode;
        if(key==='Enter' || key===13){
          handleQuickCapture();
        }
      });
    });
  }
  // Returns 'overdue','due-today','due-soon', or '' — shared by drawTasks and drawProjectTasks
  function dueStatus(due){
    if(!due) return '';
    const ts = todayKey();
    if(due < ts) return 'overdue';
    if(due === ts) return 'due-today';
    const days = Math.round((new Date(due+'T00:00:00') - new Date(ts+'T00:00:00')) / 86400000);
    return days <= 2 ? 'due-soon' : '';
  }
  $("#captureBtn")?.addEventListener('click', handleQuickCapture);
  $("#showProjectTasks").onclick = ()=>{ const list = $("#projectTaskList"); const isVisible = list.style.display !== 'none'; list.style.display = isVisible? 'none':'block'; drawProjectTasks(); };
  $("#toggleBacklog").onclick = ()=>{ const bl = $("#backlogList"); bl.style.display = bl.style.display==='none'? 'block':'none'; drawBacklog(); };
  function drawTasks(){
    const list = $("#taskList"); if(!list) return;
    const todayStr = todayKey();
    // TRIAL (Option 2): hide previously-materialized recurring duplicates
    // whose titles match a non-deleted db.monthly entry for this month, and
    // render them virtually instead (see getRecurringForDate). Only hide
    // UNDIVERGED rows — anything the user customized (description, subtasks,
    // due date, non-default priority, non-TODO status) stays visible.
    const recurringTitles = _recurringTitlesForMonth(key);
    const isUndivergedRecurring = (t) => {
      if(!recurringTitles.has((t.title||'').toLowerCase())) return false;
      if(t.status !== 'TODO') return false;
      if(t.due) return false;
      if(t.description) return false;
      if(Array.isArray(t.subtasks) && t.subtasks.length) return false;
      if(t.priority && t.priority !== 'medium') return false;
      if(t.projectId) return false;
      return true;
    };
    // --- Main task list ---
    // Exclude anything with a projectId — those belong to the project page,
    // never the daily task list, even if they also carry a noteId.
    // Exception: tasks intentionally auto-carried into this daily note
    // (carriedToNoteId === daily.id) are allowed through so the auto-carry
    // feature actually surfaces them here while preserving the project link.
    const tasks = db.tasks.filter(t=> t.noteId===daily.id && (!t.projectId || t.carriedToNoteId===daily.id) && t.status!=='BACKLOG' && t.status!=='DROPPED' && !t.deletedAt && !isUndivergedRecurring(t))
      .sort((a,b)=> { if(a.status!==b.status) return a.status==='DONE'?1:-1; const p={high:3,medium:2,low:1}; return (p[b.priority]||2)-(p[a.priority]||2); });
    // Virtual recurring rows for the displayed date.
    const recurring = getRecurringForDate(key);
    if(window._recurringCollapsed === undefined) window._recurringCollapsed = false;
    if(window._tasksCollapsed === undefined) window._tasksCollapsed = false;
    const recCollapsed = window._recurringCollapsed;
    const tasksCollapsed = window._tasksCollapsed;
    const recArrow = recCollapsed ? '▶' : '▼';
    const tasksArrow = tasksCollapsed ? '▶' : '▼';
    const recurringHtml = recurring.length ? `
      <div style='margin:0 0 8px;padding:6px 8px;background:rgba(139,109,255,0.06);border:1px solid rgba(139,109,255,0.25);border-radius:6px;'>
        <div id='recurringHeader' class='muted' style='font-size:11px;margin-bottom:${recCollapsed?'0':'4px'};cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px;'>
          <span>${recArrow}</span>
          <span>🔁 Recurring (${recurring.filter(r=>!r.completed).length} open of ${recurring.length})</span>
        </div>
        ${recCollapsed ? '' : recurring.map(r => `
          <div class='row' style='justify-content:space-between;padding:2px 0;'>
            <label class='row' style='gap:8px;cursor:pointer;'>
              <input type='checkbox' ${r.completed?'checked':''} data-rec-id='${r.m.id}'/>
              <span class='${r.completed?'muted':''}' style='border-left:3px solid #8b6dff;padding-left:8px;font-size:13px;'>${htmlesc(r.m.title)}</span>
            </label>
          </div>`).join('')}
      </div>` : '';
    list.innerHTML = recurringHtml + (tasks.length ? `
      <div style='margin:0;padding:6px 8px;background:rgba(255,255,255,0.02);border:1px solid var(--border);border-radius:6px;'>
        <div id='tasksHeader' class='muted' style='font-size:11px;margin-bottom:${tasksCollapsed?'0':'4px'};cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px;'>
          <span>${tasksArrow}</span>
          <span>🗒️ Tasks (${tasks.filter(t=>t.status!=='DONE').length} open of ${tasks.length})</span>
        </div>
        ${tasksCollapsed ? '' : tasks.map(t=> {
      const colors={high:'#ff6b6b',medium:'#8b6dff',low:'#64748b'};
      const ds = dueStatus(t.due);
      const borderColor = ds==='overdue'?'#ff4444':ds==='due-today'?'#f59e0b':ds==='due-soon'?'#ca8a04':colors[t.priority||'medium'];
      let duePill = '';
      if(t.due) {
        if(t.status!=='DONE' && ds==='overdue')    duePill=`<span class='pill' style='background:#ff4444;color:#fff;font-weight:600;'>OVERDUE</span>`;
        else if(t.status!=='DONE' && ds==='due-today') duePill=`<span class='pill' style='background:#f59e0b;color:#1a1a1a;font-weight:600;'>Due Today</span>`;
        else if(t.status!=='DONE' && ds==='due-soon')  duePill=`<span class='pill' style='background:#78350f;color:#fef3c7;'>Due ${formatDateString(t.due)}</span>`;
        else duePill=`<span class='pill'>${formatDateString(t.due)}</span>`;
      }
      return `<div class='row' style='justify-content:space-between;padding:2px 0;'>
      <label class='row' style='gap:8px;'>
        <input type='checkbox' ${t.status==='DONE'? 'checked':''} data-id='${t.id}'/>
        <span class='${t.status==='DONE'?'muted':''}' style='border-left:3px solid ${borderColor};padding-left:8px;'>${htmlesc(t.title)}${duePill ? ' '+duePill : ''}</span>
      </label>
      <div class='row' style='gap:6px;'>
        <button class='btn' data-edit='${t.id}' style='font-size:11px;'>✎</button>
        ${t.status!=='DONE'?`<button class='btn' data-b='${t.id}' style='font-size:13px;padding:2px 6px;' title='Send to backlog (optional reason)'>📦</button>`:''}
        ${t.status!=='DONE'?`<button class='btn' data-drop='${t.id}' style='font-size:13px;padding:2px 6px;color:#f88;' title='Drop with required reason'>⊘</button>`:''}
        <button class='btn' data-del='${t.id}' title='Delete'>✕</button>
      </div>
    </div>`;
    }).join('')}
      </div>` : (recurring.length ? '' : '<div class="muted" style="padding:8px;text-align:center;font-size:12px;">No tasks yet</div>'));
    // bind handlers
    list.querySelector('#recurringHeader')?.addEventListener('click', () => {
      window._recurringCollapsed = !window._recurringCollapsed;
      drawTasks();
    });
    list.querySelector('#tasksHeader')?.addEventListener('click', () => {
      window._tasksCollapsed = !window._tasksCollapsed;
      drawTasks();
    });
    list.querySelectorAll("input[data-rec-id]").forEach(cb => cb.onchange = () => {
      setRecurringCompletion(cb.dataset.recId, key, cb.checked);
      drawTasks();
    });
    list.querySelectorAll("input[type=checkbox]:not([data-rec-id])").forEach(cb=> cb.onchange = ()=>{ setTaskStatus(cb.dataset.id, cb.checked? 'DONE':'TODO'); drawTasks(); drawBacklog(); });
    list.querySelectorAll('[data-del]').forEach(b=> b.onclick = ()=>{ deleteTask(b.dataset.del); drawTasks(); drawBacklog(); });
    list.querySelectorAll('[data-b]').forEach(b=> b.onclick = async ()=>{
      const reason = await showReasonModal('Send to backlog', { required: false, okText: 'Send to backlog' });
      if (reason === null) return; // user cancelled
      moveToBacklog(b.dataset.b, reason);
      drawTasks(); drawBacklog(); drawDropped && drawDropped();
    });
    list.querySelectorAll('[data-drop]').forEach(b=> b.onclick = async ()=>{
      const t = db.tasks.find(x => x.id === b.dataset.drop);
      const reason = await showReasonModal(`Drop "${t?.title || 'task'}"?`, { required: true, okText: 'Drop task' });
      if (!reason) return; // cancelled or empty
      dropTask(b.dataset.drop, reason);
      drawTasks(); drawBacklog(); drawDropped && drawDropped();
    });
    list.querySelectorAll('[data-edit]').forEach(b=> b.onclick = ()=>{ openTaskModal(b.dataset.edit); });
    // --- Overdue/due-today summary banner (informational) ---
    // Delegated to the module-level refreshDueBanner() so any save() call
    // can refresh it directly without going through a full render().
    refreshDueBanner();
    // Unfinished tasks from ALL previous daily notes (non-recurring daily tasks only)
    const prevList = document.getElementById('prevTaskList');
    if(prevList) {
      const prevDayIds = new Set((db.notes||[]).filter(n => n.type==='daily' && !n.deletedAt && n.dateIndex < todayStr).map(n => n.id));
      const monthlyTitles = new Set((db.monthly||[]).filter(m => !m.deletedAt).map(m => m.title.toLowerCase()));
      const prevTasks = (db.tasks||[]).filter(t =>
        t.status==='TODO' && !t.deletedAt && !t.projectId &&
        prevDayIds.has(t.noteId) && !monthlyTitles.has((t.title||'').toLowerCase())
      );
      if(prevTasks.length) {
        // Persist collapse state across re-renders. Default collapsed.
        if(window._prevTasksCollapsed === undefined) window._prevTasksCollapsed = true;
        const collapsed = window._prevTasksCollapsed;
        const arrow = collapsed ? '▶' : '▼';
        const taskRows = collapsed ? '' : prevTasks.map(t => {
          const noteDate = (db.notes||[]).find(n => n.id === t.noteId)?.dateIndex || '';
          const proj = t.projectId ? (db.projects||[]).find(p => p.id === t.projectId) : null;
          const source = proj ? proj.name : noteDate;
          const ds = dueStatus(t.due);
          let dp = t.due ? (ds==='overdue' ? `<span class='pill' style='background:#ff4444;color:#fff;font-size:10px;'>OVERDUE</span>` : `<span class='pill' style='font-size:10px;'>${formatDateString(t.due)}</span>`) : '';
          return `<div class='row' style='justify-content:space-between;'>
            <div class='row' style='gap:8px;align-items:center;'>
              <input type='checkbox' data-pid='${t.id}' style='cursor:pointer;flex-shrink:0;' title='Mark done'/>
              <span style='font-size:13px;border-left:2px dashed var(--btn-border);padding-left:8px;user-select:text;'>${htmlesc(t.title)} ${dp}${source ? `<span class='pill' style='font-size:10px;opacity:0.6;'>from ${htmlesc(source)}</span>` : ''}</span>
            </div>
            <div class='row' style='gap:4px;flex-shrink:0;'>
              <button class='btn' data-ppull='${t.id}' style='font-size:11px;' title='Pull to today — re-attach to today&apos;s daily'>➡️</button>
              <button class='btn' data-pbacklog='${t.id}' style='font-size:11px;' title='Move to backlog — revisit later'>📦</button>
              <button class='btn' data-pdel='${t.id}' style='font-size:11px;' title='Dismiss'>✕</button>
            </div>
          </div>`;
        }).join('');
        prevList.innerHTML =
          `<div id='prevTasksHeader' style='font-size:12px;color:var(--muted);margin:10px 0 4px;border-top:1px solid var(--btn-border);padding-top:8px;cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px;'>
            <span>${arrow}</span>
            <span>📋 Unfinished from previous days (${prevTasks.length})</span>
          </div>` + taskRows;
        // Toggle collapse on header click
        prevList.querySelector('#prevTasksHeader').onclick = () => {
          window._prevTasksCollapsed = !window._prevTasksCollapsed;
          drawTasks();
        };
        // Mark done → task disappears immediately on re-render
        prevList.querySelectorAll('[data-pid]').forEach(cb => cb.onchange = () => {
          setTaskStatus(cb.dataset.pid, 'DONE');
          drawTasks();
        });
        prevList.querySelectorAll('[data-pbacklog]').forEach(b => b.onclick = () => {
          moveToBacklog(b.dataset.pbacklog);
          showQuickToast('📦 Moved to backlog');
          drawTasks();
        });
        prevList.querySelectorAll('[data-ppull]').forEach(b => b.onclick = () => {
          const task = db.tasks.find(t => t.id === b.dataset.ppull);
          if (!task) return;
          task.noteId = daily.id;
          task.updatedAt = nowISO();
          save();
          showQuickToast('➡️ Pulled to today');
          drawTasks();
        });
        prevList.querySelectorAll('[data-pdel]').forEach(b => b.onclick = () => { deleteTask(b.dataset.pdel); drawTasks(); });
      } else {
        prevList.innerHTML = '';
        window._prevTasksCollapsed = false; // reset when no tasks remain
      }
    }
    // Sync the nav badge count after any task change
    renderNav();
  }
  function drawBacklog(){
    const list = $("#backlogList");
    if(!list || list.style.display==='none') return;
    // Show ALL non-project backlog tasks regardless of which daily they
    // originally lived on — backlog is a cross-day pile of "revisit later"
    // items, so scoping it to today's daily.id was hiding tasks moved to
    // backlog from the Unfinished-from-previous-days panel.
    const tasks = db.tasks.filter(t=> t.status==='BACKLOG' && !t.deletedAt && (!t.projectId || t.carriedToNoteId));
    let html = `<div class='muted' style='font-size:12px;margin-bottom:4px;'>Backlog (${tasks.length})</div>`;
    if (tasks.length) {
      html += tasks
        .map(t =>
          `<div class='row' style='justify-content:space-between;'>
      <span class='muted' style='font-size:12px;'>${htmlesc(t.title)}</span>
      <div class='row' style='gap:6px;'>
        <button class='btn' data-r='${t.id}' style='font-size:11px;'>Restore</button>
        <button class='btn' data-del='${t.id}' style='font-size:11px;'>✕</button>
      </div>
    </div>`
        )
        .join('');
    } else {
      html += `<div class='muted' style='font-size:12px;'>No backlog tasks</div>`;
    }
    list.innerHTML = html;
    list.querySelectorAll('[data-r]').forEach(b=> b.onclick = ()=>{
      const t = db.tasks.find(x=> x.id===b.dataset.r);
      if(t){ t.noteId = daily.id; t.updatedAt = nowISO(); }
      setTaskStatus(b.dataset.r,'TODO');
      drawTasks(); drawBacklog();
    });
    list.querySelectorAll('[data-del]').forEach(b=> b.onclick = ()=>{ deleteTask(b.dataset.del); drawBacklog(); });
  }
  function drawProjectTasks(){
    const list = $("#projectTaskList");
    if(!list) return;
    // Gather outstanding project tasks that are neither completed nor backlogged and have not
    // been deleted. Filtering out tasks with a deletedAt flag ensures that once a user
    // removes a task from a project it no longer appears in the Today page. Sorting
    // prioritizes high-priority tasks first.
    const tasks = db.tasks
      .filter(t =>
        t.projectId && !t.noteId && t.status !== 'BACKLOG' && t.status !== 'DROPPED' && t.status !== 'DONE' && !t.deletedAt
      )
      .sort((a, b) => {
        const priorities = { high: 3, medium: 2, low: 1 };
        return (priorities[b.priority] || 2) - (priorities[a.priority] || 2);
      });
    list.innerHTML = tasks
      .map(t => {
        const proj = db.projects.find(p => p.id === t.projectId);
        const colors = { high: '#ff6b6b', medium: '#8b6dff', low: '#64748b' };
        const ds = dueStatus(t.due);
        const borderColor = ds==='overdue'?'#ff4444':ds==='due-today'?'#f59e0b':ds==='due-soon'?'#ca8a04':colors[t.priority||'medium'];
        let duePill = '';
        if(t.due){
          if(ds==='overdue')        duePill=`<span class='pill' style='background:#ff4444;color:#fff;font-weight:600;'>OVERDUE</span>`;
          else if(ds==='due-today') duePill=`<span class='pill' style='background:#f59e0b;color:#1a1a1a;font-weight:600;'>Due Today</span>`;
          else if(ds==='due-soon')  duePill=`<span class='pill' style='background:#78350f;color:#fef3c7;'>Due ${formatDateString(t.due)}</span>`;
          else                      duePill=`<span class='pill'>${formatDateString(t.due)}</span>`;
        }
        return `<div class='row' style='justify-content:space-between;'>
      <label class='row' style='gap:8px;'>
        <input type='checkbox' ${t.status === 'DONE' ? 'checked' : ''} data-id='${t.id}'/>
        <span class='${t.status === 'DONE' ? 'muted' : ''}' style='border-left:3px solid ${borderColor};padding-left:8px;'>${htmlesc(t.title)}${duePill ? ' '+duePill : ''} <span class='pill'>${proj ? htmlesc(proj.name) : 'Unknown'}</span></span>
      </label>
      <div class='row' style='gap:6px;'>
        <button class='btn' data-edit='${t.id}' style='font-size:11px;'>✎</button>
        ${t.status !== 'DONE' ? `<button class='btn' data-b='${t.id}' style='font-size:13px;padding:2px 6px;' title='Send to backlog (optional reason)'>📦</button>` : ''}
        ${t.status !== 'DONE' ? `<button class='btn' data-drop='${t.id}' style='font-size:13px;padding:2px 6px;color:#f88;' title='Drop with required reason'>⊘</button>` : ''}
        <button class='btn' data-del='${t.id}'>✕</button>
      </div>
    </div>`;
      })
      .join('');
    list.querySelectorAll("input[type=checkbox]").forEach(cb => (cb.onchange = () => {
      setTaskStatus(cb.dataset.id, cb.checked ? 'DONE' : 'TODO');
      drawProjectTasks();
    }));
    list.querySelectorAll('[data-del]').forEach(
      b => (b.onclick = () => {
        deleteTask(b.dataset.del);
        drawProjectTasks();
      })
    );
    list.querySelectorAll('[data-b]').forEach(
      b => (b.onclick = async () => {
        const reason = await showReasonModal('Send to backlog', { required: false, okText: 'Send to backlog' });
        if (reason === null) return;
        moveToBacklog(b.dataset.b, reason);
        drawProjectTasks();
      })
    );
    list.querySelectorAll('[data-drop]').forEach(
      b => (b.onclick = async () => {
        const t = db.tasks.find(x => x.id === b.dataset.drop);
        const reason = await showReasonModal(`Drop "${t?.title || 'task'}"?`, { required: true, okText: 'Drop task' });
        if (!reason) return;
        dropTask(b.dataset.drop, reason);
        drawProjectTasks();
      })
    );
    list.querySelectorAll('[data-edit]').forEach(
      b => (b.onclick = () => {
        openTaskModal(b.dataset.edit);
      })
    );
    // Sync the nav badge count after any task change
    renderNav();
  }
  // Expose the drawProjectTasks function globally so other helpers (like
  // updateProjectTasksButton) can invoke it when necessary. This is safe
  // because renderToday redefines drawProjectTasks on each invocation.
  window.drawProjectTasks = drawProjectTasks;
  drawTasks(); drawBacklog();

  // ------------------------------------------------------------------
  // Global Ctrl+S binding for the Today view
  //
  // The daily page has several input elements (title, content, scratchpad,
  // quick task field) that may capture keyboard focus. Previously the
  // Ctrl+S shortcut only bound to specific fields like the title and
  // content boxes, meaning pressing Ctrl+S elsewhere would trigger the
  // browser’s default “Save page” dialog. To address this, we bind a
  // single capture‑phase listener on the document that intercepts
  // Ctrl+S regardless of focus and triggers the save action. The
  // handler reference is stored on window._todayKeyHandler so it can
  // be removed when navigating away from this view.
  // Remove any previously registered Ctrl+S handler. We attach our handler on both
  // document and window because some input elements may stop propagation at the
  // document level. If a previous handler exists, remove it from both targets.
  if (window._todayKeyHandler) {
    document.removeEventListener('keydown', window._todayKeyHandler, true);
    window.removeEventListener('keydown', window._todayKeyHandler, true);
  }
  if (window._draftKeyHandler) {
    document.removeEventListener('keydown', window._draftKeyHandler, true);
    window._draftKeyHandler = null;
  }
  const globalDailyKeyHandler = (e) => {
    // Support Ctrl (Windows/Linux) and Meta (Mac) without Shift
    const isCtrl = e.ctrlKey || e.metaKey;
    if (isCtrl && !e.shiftKey && (e.key === 's' || e.key === 'S' || e.code === 'KeyS')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      doSaveDaily();
      // Also trigger journal save if present
      const jBtn = document.getElementById('journalSave');
      if (jBtn) jBtn.click();
      return false;
    }
  };
  // Register our new handler on both document and window. Using capture phase
  // ensures the shortcut fires before focus handlers on input/textarea fields.
  // Use options object to explicitly disable passive mode. When passive is true,
  // preventDefault() may be ignored by some browsers for wheel/touch events.
  const handlerOpts = { capture: true, passive: false };
  document.addEventListener('keydown', globalDailyKeyHandler, handlerOpts);
  window.addEventListener('keydown', globalDailyKeyHandler, handlerOpts);
  window._todayKeyHandler = globalDailyKeyHandler;
}
function renderProjects(){
  const selectorHTML = db.projects && db.projects.length ? `
    <div id="projectSelectorContainer" class="card">
      <select id="projectSelector" style="width:100%;padding:8px;background:var(--btn-bg);border:1px solid var(--btn-border);color:var(--fg);border-radius:6px;">
        ${db.projects.filter(p=>!p.deletedAt).map(p=>`<option value="${p.id}" ${p.id===currentProjectId?'selected':''}>${htmlesc(p.name)}</option>`).join('')}
      </select>
    </div>
  ` : '';
  const selectedProject = db.projects.find(p=>p.id===currentProjectId) || null;
  if(!selectedProject){
    content.innerHTML = selectorHTML + `
      <div class="card">
        <strong>Select a project</strong>
        <div class="muted" style="margin-top:6px;">Pick a project in the left sidebar (or create one) to add and manage its notes.</div>
      </div>`;
    // Attach change handler for selector when no project is selected
    const selEl = document.getElementById('projectSelector');
    if(selEl){
      selEl.onchange = ()=>{
        const val = selEl.value;
        if(val && db.projects.find(p=>p.id===val)){
          currentProjectId = val;
          render();
          drawProjectsSidebar();
        }
      };
    }
    return;
  }
  let sortBy = 'date';
  content.innerHTML = renderReferencePromptsCard('projects') + selectorHTML + `
    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:center;">
        <strong id="projRename" title="Double-click to rename" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:text;">Project: ${htmlesc(selectedProject.name)}</strong>
        <div class="row" style="gap:12px;">
          <span class="muted" id="projNoteCount"></span>
          <span class="muted" id="projTaskProgress"></span>
        </div>
      </div>
      <div class="row" style="margin-top:10px;flex-wrap:wrap;gap:8px;">
        <input id="noteTitle" type="text" placeholder="New note title for this project" />
        <select id="noteTemplate" style="padding:8px;background:var(--btn-bg);border:1px solid var(--btn-border);color:var(--fg);border-radius:6px;">
          <option value="">Template...</option>
          ${db.templates.map(t=>`<option value="${t.id}">${htmlesc(t.name)}</option>`).join("")}
        </select>
        <button id="addNote" class="btn acc">Add Note</button>
      </div>
    </div>
    <div class="grid-2">
      <div class="card">
        <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px;">
          <strong>Project Tasks</strong>
          <span class="muted" id="projProgressInline"></span>
        </div>
        <div class="row" style="margin-top:8px;gap:8px;flex-wrap:wrap;">
        <input id="projTaskTitle" type="text" placeholder="New project task"/>
          <select id="projTaskPriority" style="padding:8px;background:var(--btn-bg);border:1px solid var(--btn-border);color:var(--fg);border-radius:6px;">
            <option value="low">Low</option>
            <option value="medium" selected>Medium</option>
            <option value="high">High</option>
          </select>
          <input id="projTaskDueDate" type="date" style="padding:8px;background:var(--input-bg);border:1px solid var(--input-border);color:var(--fg);border-radius:6px;"/>
          <button id="projAddTask" class="btn">Add Task</button>
        </div>
        <div id="projTaskDupHint" style="display:none;margin-top:4px;padding:6px 10px;background:#2a1f10;border:1px solid #f0c040;border-radius:6px;font-size:12px;color:#f0c040;"></div>
        <div id="taskList" class="list" style="margin-top:8px;"></div>
        <div id="projBacklogList" class="list" style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px;"></div>
      </div>
      <div class="card">
        <div class="row" style="justify-content:space-between;">
          <strong>Notes</strong>
          <div class="row">
            <button id="sortTitle" class="btn" style="font-size:12px;">A-Z</button>
            <button id="sortDate" class="btn" style="font-size:12px;">Date</button>
          </div>
        </div>
        <div id="notes" class="list" style="margin-top:8px;"></div>
      </div>
    </div>`;
  wireReferencePromptsCard();
  // Exclude deleted tasks when retrieving project tasks/backlog
  function getProjectTasks(){
    // Exclude tasks that have been soft-deleted (deletedAt) or moved to backlog. Only
    // return active tasks (TODO/DONE) for this project. Filtering out deleted tasks
    // ensures that once a user deletes a project task it no longer appears in the list.
    return db.tasks.filter(
      t => t.projectId === currentProjectId && t.status !== 'BACKLOG' && t.status !== 'DROPPED' && !t.deletedAt
    );
  }
  function getProjectBacklog(){
    // Return backlog tasks for the current project, excluding any that have been
    // soft-deleted. Without filtering deleted tasks, users would still see
    // supposedly removed tasks in the backlog.
    return db.tasks.filter(
      t => t.projectId === currentProjectId && t.status === 'BACKLOG' && !t.deletedAt
    );
  }
  function getProjectNotes(){ return db.notes.filter(n=> n.projectId===currentProjectId && (!n.type || n.type==='note') && !n.deletedAt); }
  function drawNotes(){
    const notes = getProjectNotes().sort((a,b)=> sortBy==="title"? a.title.localeCompare(b.title) : b.updatedAt.localeCompare(a.updatedAt));
    const listEl = document.getElementById("notes");
    if(!notes.length){ listEl.innerHTML = `<div class='card muted'>No notes yet. Add one above.</div>`; return; }
    listEl.innerHTML = notes.map(n=> `<div class="card">
      <div class="row" style="justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap;">
        <strong style="flex:1;min-width:0;word-break:break-word;">${htmlesc(n.title)}</strong>
        <div class="row" style="gap:8px;flex-shrink:0;">
          ${n.pinned?'<span title="Pinned">📌</span>':''}
          <div class="muted">${new Date(n.updatedAt).toLocaleDateString()}</div>
        </div>
      </div>
      ${(n.tags&&n.tags.length)?`<div style='margin-top:4px;'>${n.tags.map(tag=>`<span class='pill'>#${htmlesc(tag)}</span>`).join("")}</div>`:''}
      <div class="row" style="margin-top:8px; gap:8px;flex-wrap:wrap;">
        <button class="btn" data-open="${n.id}">Open</button>
        <button class="btn" data-pin="${n.id}">${n.pinned?'Unpin':'Pin'}</button>
        <button class="btn" data-del="${n.id}">Delete</button>
      </div>
    </div>`).join("");
    listEl.querySelectorAll('[data-open]').forEach(b=> b.onclick = ()=> openNote(b.dataset.open));
    listEl.querySelectorAll('[data-pin]').forEach(b=> b.onclick = ()=> { const note=db.notes.find(x=>x.id===b.dataset.pin); if(note){ note.pinned=!note.pinned; save(); drawNotes(); } });
    listEl.querySelectorAll('[data-del]').forEach(b=> b.onclick = async ()=> {
      const note = db.notes.find(x => x.id === b.dataset.del);
      const tCount = note ? db.tasks.filter(t => t.noteId === note.id && !t.deletedAt).length : 0;
      const isDaily = note && note.type === 'daily';
      const extra = tCount ? (isDaily
        ? ` This daily page has ${tCount} task${tCount!==1?'s':''} — they will be DETACHED (preserved, reattach on restore).`
        : ` Its ${tCount} task${tCount!==1?'s':''} will be moved to Trash.`) : '';
      const ok = await showConfirm(`Delete this note?${extra}`, 'Delete', 'Cancel');
      if(!ok) return;
      softDeleteNote(b.dataset.del);
      drawNotes();
      refreshStats();
    });
  }
  function refreshStats(){
    const tasks = getProjectTasks();
    const notes = getProjectNotes();
    const completed = tasks.filter(t=>t.status==="DONE").length;
    const progress = tasks.length ? Math.round(completed/tasks.length*100) : 0;
    const noteCountEl = document.getElementById("projNoteCount"); if(noteCountEl) noteCountEl.textContent = `${notes.length} notes`;
    const progEl = document.getElementById("projTaskProgress"); if(progEl) progEl.textContent = `${completed}/${tasks.length} tasks (${progress}%)`;
    const inline = document.getElementById("projProgressInline"); if(inline) inline.textContent = `${progress}% complete`;
  }
  document.getElementById("addNote").onclick = ()=>{
    const t = document.getElementById("noteTitle").value.trim();
    const templateId = document.getElementById("noteTemplate").value;
    openDraftNote({title:t, projectId:currentProjectId, type:'note', templateId});
  };
  {
    const renEl = document.getElementById('projRename');
    if(renEl) renEl.ondblclick = ()=> renameProjectFlow(currentProjectId);
  }
  // Allow pressing Enter in the note title input to trigger Add Note
  {
    const nt = document.getElementById('noteTitle');
    if(nt){
      nt.addEventListener('keydown', e=>{ if(e.key === 'Enter') document.getElementById('addNote').click(); });
    }
  }
  document.getElementById("projAddTask").onclick = ()=>{
    const titleEl = document.getElementById("projTaskTitle");
    const title = titleEl ? titleEl.value.trim() : '';
    if(!title) return;
    // Hide hint on successful add
    const hint = document.getElementById('projTaskDupHint');
    if(hint) hint.style.display='none';
    const dueEl = document.getElementById("projTaskDueDate");
    const dueVal = dueEl && dueEl.value ? dueEl.value : null;
    createTask({title, projectId:currentProjectId, priority:document.getElementById("projTaskPriority").value, due: dueVal});
    if(titleEl) titleEl.value="";
    if(dueEl) dueEl.value="";
    drawTasks();
    refreshStats();
  };
  document.getElementById("projTaskTitle").onkeydown = e=>{ if(e.key==="Enter") document.getElementById("projAddTask").click(); };
  // Inline dup hint for project task input
  {
    const pti = document.getElementById('projTaskTitle');
    if(pti){
      pti.addEventListener('input', ()=>{
        const val = pti.value.trim();
        const hint = document.getElementById('projTaskDupHint');
        if(!hint) return;
        if(!val || val.length < 3){ hint.style.display='none'; return; }
        const existing = db.tasks.filter(t => !t.deletedAt && t.status!=='DONE' && t.projectId===currentProjectId);
        const matches = existing.filter(t => taskSimilarity(val, t.title) >= 0.75);
        if(matches.length){
          hint.style.display='block';
          hint.innerHTML = '⚠️ Similar task' + (matches.length>1?'s':'') + ' already in this project: ' +
            matches.map(t=>`<strong>${htmlesc(t.title)}</strong>`).join(', ');
        } else {
          hint.style.display='none';
        }
      });
    }
  }
  document.getElementById("sortTitle").onclick = ()=>{ sortBy="title"; drawNotes(); };
  document.getElementById("sortDate").onclick = ()=>{ sortBy="date"; drawNotes(); };
  function drawTasks(){
    const tasks = getProjectTasks().sort((a,b)=>{ if(a.status !== b.status) return a.status==="DONE"?1:-1; const priorities={high:3,medium:2,low:1}; return (priorities[b.priority]||2)-(priorities[a.priority]||2); });
    const list = document.getElementById("taskList");
    list.innerHTML = tasks.map(t=>{
      const colors={high:"#ff6b6b",medium:"#8b6dff",low:"#64748b"};
      return `<div class="row" style="justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap;">
        <label class="row" style="gap:8px;flex:1;min-width:0;">
          <input type="checkbox" ${t.status==="DONE"?"checked":''} data-id="${t.id}" style="flex-shrink:0;"/>
          <span class="${t.status==='DONE'?'muted':''}" style="border-left:3px solid ${colors[t.priority||'medium']};padding-left:8px;word-break:break-word;flex:1;min-width:0;">${htmlesc(t.title)}${t.due ? ` <span class='pill'>${formatDateString(t.due)}</span>` : ''}</span>
        </label>
        <div class='row' style='gap:6px;flex-shrink:0;flex-wrap:wrap;'>
          <button class='btn' data-edit='${t.id}' style='font-size:11px;'>✎</button>
          ${t.status!=='DONE'?`<button class='btn' data-b='${t.id}' style='font-size:13px;padding:2px 6px;' title='Send to backlog (optional reason)'>📦</button>`:''}
          ${t.status!=='DONE'?`<button class='btn' data-drop='${t.id}' style='font-size:13px;padding:2px 6px;color:#f88;' title='Drop with required reason'>⊘</button>`:''}
          <button class='btn' data-del='${t.id}'>✕</button>
        </div>
      </div>`;
    }).join("");
    list.querySelectorAll("input[type=checkbox]").forEach(cb=> cb.onchange = ()=>{ setTaskStatus(cb.dataset.id, cb.checked?"DONE":"TODO"); drawTasks(); refreshStats(); drawBacklog(); });
    list.querySelectorAll('[data-del]').forEach(b=> b.onclick = ()=>{ deleteTask(b.dataset.del); drawTasks(); refreshStats(); drawBacklog(); });
    list.querySelectorAll('[data-b]').forEach(b=> b.onclick = async ()=>{
      const reason = await showReasonModal('Send to backlog', { required: false, okText: 'Send to backlog' });
      if (reason === null) return;
      moveToBacklog(b.dataset.b, reason);
      drawTasks(); drawBacklog(); refreshStats();
    });
    list.querySelectorAll('[data-drop]').forEach(b=> b.onclick = async ()=>{
      const t = db.tasks.find(x => x.id === b.dataset.drop);
      const reason = await showReasonModal(`Drop "${t?.title || 'task'}"?`, { required: true, okText: 'Drop task' });
      if (!reason) return;
      dropTask(b.dataset.drop, reason);
      drawTasks(); drawBacklog(); refreshStats();
    });
    list.querySelectorAll('[data-edit]').forEach(b=> b.onclick = ()=>{ openTaskModal(b.dataset.edit); });
  }
  function drawBacklog(){ const list = document.getElementById('projBacklogList'); const tasks = getProjectBacklog(); list.innerHTML = `<div class='muted' style='font-size:12px;margin-bottom:4px;'>Backlog (${tasks.length})</div>` + (tasks.length? tasks.map(t=> `<div class='row' style='justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap;'>
      <span class='muted' style='font-size:12px;flex:1;min-width:0;word-break:break-word;'>${htmlesc(t.title)}</span>
      <div class='row' style='gap:6px;flex-shrink:0;'>
        <button class='btn' data-r='${t.id}' style='font-size:11px;'>Restore</button>
        <button class='btn' data-del='${t.id}' style='font-size:11px;'>✕</button>
      </div>
    </div>`).join("") : `<div class='muted' style='font-size:12px;'>No backlog tasks</div>`); list.querySelectorAll('[data-r]').forEach(b=> b.onclick = ()=> { setTaskStatus(b.dataset.r,'TODO'); drawTasks(); drawBacklog(); }); list.querySelectorAll('[data-del]').forEach(b=> b.onclick = ()=> { deleteTask(b.dataset.del); drawBacklog(); refreshStats(); });
  }
  drawTasks();
  drawNotes();
  drawBacklog();
  refreshStats();

  // Handle project selector change (useful on mobile where sidebar is hidden)
  const selEl = document.getElementById('projectSelector');
  if(selEl){
    selEl.onchange = ()=>{
      const val = selEl.value;
      if(val && db.projects.find(p=>p.id===val)){
        currentProjectId = val;
        render();
        drawProjectsSidebar();
      }
    };
  }
}

// ============================================================================
// People — researcher dossier directory.
// Notes live in the "People" notebook. Each note has a bold-key metadata
// block at the top (Role / Affiliation / Tags / Met / Star) plus structured
// sections we parse for the table view.
// ============================================================================
function _peopleNotebookId() {
  const nb = (db.notebooks || []).find(n => !n.deletedAt && n.name === 'People');
  return nb ? nb.id : null;
}

// Parse a single bold-key line: "**Role:** Professor" → "Professor"
function _parseField(content, key) {
  const re = new RegExp('^\\s*\\*\\*' + key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&') + ':\\*\\*\\s*(.*)$', 'mi');
  const m = content.match(re);
  return m ? m[1].trim() : '';
}

// Pull all `[[Wiki Link]]` targets out of a chunk of markdown.
function _extractWikilinks(text) {
  const out = [];
  const re = /\[\[([^\]]+?)\]\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const t = m[1].split('|')[0].trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

// Topics/collaborators are *meant* to be written as [[Wiki Links]] so they can
// cross-link to real Topic Map / person notes, but nothing in the Person
// template enforces that syntax — most people just type plain bullet text
// (e.g. "- AI Safety & Robustness"). Without this fallback, plain-text topics
// silently disappear from the People table's Topics column, filter dropdown,
// and "Grouped by topic" view even though the user filled them in. Prefer
// real wiki-links when present; otherwise fall back to one entry per
// non-empty bullet line so the data the user actually typed still shows up.
function _extractWikilinksOrLines(text) {
  const wiki = _extractWikilinks(text);
  if (wiki.length) return wiki;
  return text.split(/\r?\n/)
    .map(l => l.replace(/^\s*[-*]\s*/, '').replace(/\*\*/g, '').trim())
    .filter(Boolean);
}

// Slice the body of a `## Heading` section until the next `## ` or end.
function _extractSection(content, heading) {
  const re = new RegExp('^##\\s+' + heading.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&') + '\\s*$([\\s\\S]*?)(?=^##\\s+|\\Z)', 'mi');
  const m = content.match(re);
  return m ? m[1] : '';
}

// Collaborators live in the "- Frequent collaborators: A, B, C" bullet inside
// the Lab / team section — not the whole section (which also has Lab page /
// Advisor / Advisees / Team's main focus lines we must NOT pick up). Prefer
// wiki-links if the user linked real person notes; otherwise fall back to the
// comma-separated plain-text names so they still show up in the People table.
function _extractCollaborators(labBody) {
  const wiki = _extractWikilinks(labBody);
  if (wiki.length) return wiki;
  const m = labBody.match(/-\s*Frequent collaborators:\s*(.*)/i);
  if (!m || !m[1].trim()) return [];
  return m[1].split(/[,;]/).map(s => s.replace(/\*\*/g, '').trim()).filter(Boolean);
}

function _parsePerson(note) {
  const c = note.content || '';
  const tagsRaw = _parseField(c, 'Tags');
  const tags = tagsRaw ? tagsRaw.split(/[,;]/).map(s => s.trim()).filter(Boolean) : [];
  const met  = /^(y|yes|true|1)$/i.test(_parseField(c, 'Met'));
  const star = /^(y|yes|true|1)$/i.test(_parseField(c, 'Star'));
  // Topics: wiki-links inside the Topics section (typically "[[🗺️ Topic Map — X]]"),
  // falling back to plain bullet text since most people just type "- Topic name".
  const topicsBody = _extractSection(c, 'Topics');
  const topics = _extractWikilinksOrLines(topicsBody);
  // Collaborators: wiki-links or the "Frequent collaborators:" line inside Lab / team.
  const labBody = _extractSection(c, 'Lab \\/ team') || _extractSection(c, 'Lab / team');
  const collaborators = _extractCollaborators(labBody);
  // Role bucket — derived from tags first, then from the Role field.
  const tagsLower = tags.map(t => t.toLowerCase());
  let bucket = 'Other';
  if (tagsLower.some(t => t === 'prof' || t === 'pi'))                 bucket = 'Profs / PIs';
  else if (tagsLower.some(t => t === 'hiring' || t === 'recruiter'))   bucket = 'Hiring / Recruiters';
  else if (tagsLower.some(t => t === 'engineer' || t === 'founder'))   bucket = 'Engineers / Founders';
  else if (tagsLower.some(t => t === 'researcher' || t === 'postdoc' || t === 'phd' || t === 'scientist')) bucket = 'Researchers';
  else {
    const role = (_parseField(c, 'Role') || '').toLowerCase();
    if (/prof|principal investigator|\bpi\b/.test(role))                  bucket = 'Profs / PIs';
    else if (/hiring|recruiter/.test(role))                               bucket = 'Hiring / Recruiters';
    else if (/engineer|founder|cto|ceo/.test(role))                       bucket = 'Engineers / Founders';
    else if (/postdoc|phd|researcher|scientist|student/.test(role))       bucket = 'Researchers';
  }
  return {
    id: note.id,
    title: note.title,
    role: _parseField(c, 'Role'),
    affiliation: _parseField(c, 'Affiliation'),
    location: _parseField(c, 'Location'),
    tags,
    met,
    star,
    topics,
    collaborators,
    bucket,
    updatedAt: note.updatedAt,
  };
}

// Set (or replace) the value on a `**Key:** value` line in Person-note markdown.
// Used by the People quick-add form to stamp in the few fields the user typed
// without making them fill out the whole dossier template up front.
// NOTE: trailing match must use [ \t]* (not \s*) — \s* matches newlines too,
// which let the regex greedily swallow the *next* field's line and delete it.
function _setField(content, key, value) {
  const escKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^(\\*\\*' + escKey + ':\\*\\*)[ \\t]*.*$', 'm');
  return re.test(content) ? content.replace(re, '$1 ' + value) : content;
}

// Module-scoped UI state for the People view.
let _peopleFilters = { q: '', role: '', topic: '', metOnly: false, starOnly: false, view: 'flat' };

function renderPeople() {
  const nbId = _peopleNotebookId();
  if (!nbId) {
    content.innerHTML = `
      <div class="card">
        <strong>People notebook is missing.</strong>
        <div class="muted" style="margin-top:6px;">Run <code>node scripts/scaffold_people.js</code> from the repo to set it up.</div>
      </div>`;
    return;
  }

  const allPersonNotes = (db.notes || []).filter(n =>
    !n.deletedAt && n.notebookId === nbId && n.title !== '👥 People — Index'
  );
  const people = allPersonNotes.map(_parsePerson);

  // Aggregate filter chip data.
  const allRoles  = Array.from(new Set(people.map(p => p.bucket))).sort();
  const allTopics = Array.from(new Set(people.flatMap(p => p.topics))).sort();

  const f = _peopleFilters;
  const qLower = f.q.trim().toLowerCase();
  const filtered = people.filter(p => {
    if (f.metOnly  && !p.met)  return false;
    if (f.starOnly && !p.star) return false;
    if (f.role  && p.bucket !== f.role)         return false;
    if (f.topic && !p.topics.includes(f.topic)) return false;
    if (qLower) {
      const hay = (p.title + ' ' + p.affiliation + ' ' + p.role + ' ' + p.tags.join(' ')).toLowerCase();
      if (!hay.includes(qLower)) return false;
    }
    return true;
  });

  // Sort within group / overall.
  filtered.sort((a, b) => {
    if (a.star !== b.star) return a.star ? -1 : 1;
    return a.title.localeCompare(b.title);
  });

  const indexNote = (db.notes || []).find(n => !n.deletedAt && n.notebookId === nbId && n.title === '👥 People — Index');

  const filterBarHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <strong>👥 People <span class="muted" style="font-weight:normal;">(${filtered.length}/${people.length})</span></strong>
        <div class="row" style="gap:6px;flex-wrap:wrap;">
          ${indexNote ? `<button class="btn" id="pplOpenIndex" title="Open the People — Index note">📑 Index</button>` : ''}
        </div>
      </div>
      <div class="row" style="margin-top:10px;flex-wrap:wrap;gap:8px;">
        <input id="pplNewName" type="text" placeholder="Name" style="flex:1;min-width:120px;" />
        <input id="pplNewRole" type="text" placeholder="Role (optional)" style="flex:1;min-width:120px;" />
        <input id="pplNewAffil" type="text" placeholder="Affiliation (optional)" style="flex:1;min-width:140px;" />
        <input id="pplNewTags" type="text" placeholder="tags (space, optional)" style="flex:1;min-width:120px;" />
        <button class="btn acc" id="pplAdd" title="Add — press Enter in any field to save">➕ Add</button>
      </div>
      <div class="muted" style="margin-top:4px;font-size:11px;">Just enter a name to get started — press Enter or click Add. Open the note afterward to fill in the rest of the dossier.</div>
      <div class="row" style="margin-top:10px;flex-wrap:wrap;gap:8px;">
        <input id="pplSearch" type="text" placeholder="Search name, org, role, tag…" value="${htmlesc(f.q)}" style="flex:1;min-width:180px;" />
        <select id="pplRole" style="padding:8px;background:var(--btn-bg);border:1px solid var(--btn-border);color:var(--fg);border-radius:6px;">
          <option value="">All roles</option>
          ${allRoles.map(r => `<option value="${htmlesc(r)}" ${r===f.role?'selected':''}>${htmlesc(r)}</option>`).join('')}
        </select>
        <select id="pplTopic" style="padding:8px;background:var(--btn-bg);border:1px solid var(--btn-border);color:var(--fg);border-radius:6px;">
          <option value="">All topics</option>
          ${allTopics.map(t => `<option value="${htmlesc(t)}" ${t===f.topic?'selected':''}>${htmlesc(t)}</option>`).join('')}
        </select>
        <label class="row" style="gap:4px;align-items:center;"><input type="checkbox" id="pplStar" ${f.starOnly?'checked':''}/> ⭐ Stars only</label>
        <label class="row" style="gap:4px;align-items:center;"><input type="checkbox" id="pplMet" ${f.metOnly?'checked':''}/> Met IRL</label>
        <select id="pplView" style="padding:8px;background:var(--btn-bg);border:1px solid var(--btn-border);color:var(--fg);border-radius:6px;">
          <option value="group" ${f.view==='group'?'selected':''}>Grouped by topic</option>
          <option value="flat"  ${f.view==='flat'?'selected':''}>Flat alphabetical</option>
          <option value="role"  ${f.view==='role'?'selected':''}>Grouped by role</option>
        </select>
      </div>
    </div>`;

  function rowHTML(p) {
    const star = p.star ? '⭐ ' : '';
    const met  = p.met  ? '<span title="Met IRL" style="margin-left:4px;">🤝</span>' : '';
    const tagChips = p.tags.slice(0,4).map(t => `<span class="muted" style="font-size:11px;border:1px solid var(--btn-border);border-radius:10px;padding:1px 6px;margin-right:3px;">${htmlesc(t)}</span>`).join('');
    const topicChips = p.topics.slice(0,3).map(t => {
      const short = t.replace(/^🗺️\s*Topic\s*Map\s*[—-]\s*/i, '');
      return `<span class="muted" style="font-size:11px;border:1px solid var(--btn-border);border-radius:10px;padding:1px 6px;margin-right:3px;">🗺️ ${htmlesc(short)}</span>`;
    }).join('') + (p.topics.length > 3 ? `<span class="muted" style="font-size:11px;">+${p.topics.length-3}</span>` : '');
    const collabCount = p.collaborators.length;
    return `
      <tr data-ppl-id="${p.id}" style="cursor:pointer;border-bottom:1px solid var(--btn-border);">
        <td style="padding:8px 6px;"><strong>${star}${htmlesc(p.title)}</strong>${met}<div style="margin-top:2px;">${tagChips}</div></td>
        <td style="padding:8px 6px;">${htmlesc(p.role || '—')}</td>
        <td style="padding:8px 6px;">${htmlesc(p.affiliation || '—')}</td>
        <td style="padding:8px 6px;">${topicChips || '<span class="muted">—</span>'}</td>
        <td style="padding:8px 6px;">${collabCount ? `<span class="muted">${collabCount} linked</span>` : '<span class="muted">—</span>'}</td>
      </tr>`;
  }

  function tableHTML(rows) {
    if (!rows.length) return `<div class="muted" style="padding:14px;">No people match the current filters.</div>`;
    return `
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="text-align:left;border-bottom:2px solid var(--btn-border);">
            <th style="padding:8px 6px;">Name</th>
            <th style="padding:8px 6px;">Role</th>
            <th style="padding:8px 6px;">Affiliation</th>
            <th style="padding:8px 6px;">Topics</th>
            <th style="padding:8px 6px;">Collaborators</th>
          </tr>
        </thead>
        <tbody>${rows.map(rowHTML).join('')}</tbody>
      </table>`;
  }

  let bodyHTML = '';
  if (people.length === 0) {
    bodyHTML = `
      <div class="card">
        <strong>No people yet.</strong>
        <div class="muted" style="margin-top:6px;">Type a name above and hit Enter to create your first person note. Each note becomes a researcher dossier — affiliation, lab, key papers, topics they work on. Backlinks from your paper notes will accumulate automatically.</div>
      </div>`;
  } else if (f.view === 'flat') {
    bodyHTML = `<div class="card">${tableHTML(filtered)}</div>`;
  } else {
    const groupKey = f.view === 'role' ? 'bucket' : 'topic';
    const groups = {};
    filtered.forEach(p => {
      const keys = groupKey === 'topic'
        ? (p.topics.length ? p.topics : ['(no topic)'])
        : [p.bucket];
      keys.forEach(k => { (groups[k] = groups[k] || []).push(p); });
    });
    const keysSorted = Object.keys(groups).sort((a, b) => {
      if (a === '(no topic)') return 1;
      if (b === '(no topic)') return -1;
      return a.localeCompare(b);
    });
    bodyHTML = keysSorted.map(k => {
      const label = groupKey === 'topic' ? k.replace(/^🗺️\s*Topic\s*Map\s*[—-]\s*/i, '🗺️ ') : k;
      return `<div class="card"><strong>${htmlesc(label)} <span class="muted" style="font-weight:normal;">(${groups[k].length})</span></strong>${tableHTML(groups[k])}</div>`;
    }).join('');
  }

  content.innerHTML = filterBarHTML + bodyHTML;

  // --- Wire interactions ---
  const $get = id => document.getElementById(id);
  const rerender = () => renderPeople();

  $get('pplSearch').addEventListener('input', e => { _peopleFilters.q = e.target.value; clearTimeout(window._pplDebounce); window._pplDebounce = setTimeout(rerender, 180); });
  $get('pplRole').onchange  = e => { _peopleFilters.role  = e.target.value; rerender(); };
  $get('pplTopic').onchange = e => { _peopleFilters.topic = e.target.value; rerender(); };
  $get('pplStar').onchange  = e => { _peopleFilters.starOnly = e.target.checked; rerender(); };
  $get('pplMet').onchange   = e => { _peopleFilters.metOnly  = e.target.checked; rerender(); };
  $get('pplView').onchange  = e => { _peopleFilters.view    = e.target.value; rerender(); };

  $get('pplAdd').onclick = () => {
    const nameEl = $get('pplNewName');
    const name = nameEl.value.trim();
    if (!name) { nameEl.focus(); return; }
    const dup = allPersonNotes.find(n => n.title.trim().toLowerCase() === name.toLowerCase());
    if (dup) { showQuickToast('⚠️ Person already exists'); return; }

    const role = $get('pplNewRole').value.trim();
    const affiliation = $get('pplNewAffil').value.trim();
    const tagsRaw = ($get('pplNewTags').value || '').split(/\s+/).map(t => t.startsWith('#') ? t.slice(1) : t).filter(Boolean);

    const tpl = (db.templates || []).find(t => !t.deletedAt && t.id === 'tpl_person');
    let body = tpl ? tpl.content : '# [Name]\n\n**Role:** \n**Affiliation:** \n**Tags:** \n';
    body = body.replace(/^#\s*\[Name\]\s*$/m, '# ' + name);
    body = _setField(body, 'Role', role);
    body = _setField(body, 'Affiliation', affiliation);
    if (tagsRaw.length) body = _setField(body, 'Tags', tagsRaw.join(', '));

    const note = {
      id: uid(),
      title: name,
      content: body,
      tags: ['person'],
      notebookId: nbId,
      type: 'page',
      pinned: false,
      projectId: null,
      dateIndex: null,
      attachments: [],
      links: [],
      createdAt: nowISO(),
      updatedAt: nowISO(),
    };
    db.notes.push(note);
    save();

    // Quick-add stays on the People page so you can rattle off several
    // contacts in a row — click the row later to open the full dossier.
    nameEl.value = '';
    $get('pplNewRole').value = '';
    $get('pplNewAffil').value = '';
    $get('pplNewTags').value = '';
    rerender();
    showQuickToast(`✅ Added ${name}`);
  };
  ['pplNewName', 'pplNewRole', 'pplNewAffil', 'pplNewTags'].forEach(id => {
    $get(id).onkeydown = e => { if (e.key === 'Enter') $get('pplAdd').click(); };
  });

  if (indexNote) {
    const ix = $get('pplOpenIndex');
    // openNote() already pushes its own nav-history snapshot before switching
    // views, so an extra _navPush() here double-pushed — Back had to be
    // pressed twice to actually leave the People view (the first press just
    // popped a duplicate "People" snapshot). Let openNote() own the push.
    if (ix) ix.onclick = () => { openNote(indexNote.id); };
  }

  // Row click → open the person note.
  content.querySelectorAll('tr[data-ppl-id]').forEach(tr => {
    tr.onclick = () => { openNote(tr.dataset.pplId); };
  });
}

function renderIdeas(){
  content.innerHTML = `
  <div class="card">
    <div class="row"><input id="idea" type="text" placeholder="Capture an idea… (Enter to add)" style="flex:1;"/></div>
  </div>
  <div id="ideaList" class="list"></div>`;
  const idea = $("#idea");
  idea.onkeydown = (e)=> { if(e.key==="Enter" && idea.value.trim()){ const n=createNote({title:idea.value.trim(), content:"", type:"idea"}); idea.value=""; draw(); openNote(n.id); } };
  function draw(){
    const notes = db.notes.filter(n=> n.type==="idea" && !n.deletedAt).sort((a,b)=> b.createdAt.localeCompare(a.createdAt));
    $("#ideaList").innerHTML = notes.map(n=> `
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:center;">
          <span style="flex:1;cursor:pointer;" data-open="${n.id}">${htmlesc(n.title)}${statusBadge(n.status)}</span>
          <div class="row" style="gap:6px;">
            <button class="btn" data-open="${n.id}" style="font-size:12px;">Open</button>
            <button class="btn" data-del="${n.id}" style="font-size:12px;">✕</button>
          </div>
        </div>
      </div>`).join("");
    document.querySelectorAll('[data-open]').forEach(b=> b.onclick=()=> openNote(b.dataset.open));
    document.querySelectorAll('[data-del]').forEach(b=> b.onclick=async ()=>{
      const note = db.notes.find(x => x.id === b.dataset.del);
      const tCount = note ? db.tasks.filter(t => t.noteId === note.id && !t.deletedAt).length : 0;
      const extra = tCount ? ` Its ${tCount} task${tCount!==1?'s':''} will be moved to Trash.` : '';
      const ok = await showConfirm(`Delete idea?${extra}`, 'Delete', 'Cancel');
      if(!ok) return;
      softDeleteNote(b.dataset.del);
      draw();
    });
  }
  draw();
}

function getTrashedTasks(){
  return db.tasks.filter(t=> t.deletedAt);
}
function openTaskContext(taskId){
  const t = db.tasks.find(x=>x.id===taskId);
  if(!t) return;
  if(t.noteId){
    // Only open if the note still exists; otherwise clear the stale reference
    // so the task surfaces in Review → Pending Tasks instead of going nowhere.
    const noteExists = db.notes.find(n => n.id === t.noteId);
    if(noteExists){
      openNote(t.noteId);
      return;
    } else {
      t.noteId = null;
      save();
    }
  }
  if(t.projectId){
    _navPush();
    route='projects';
    render();
    const btn = document.querySelector(`[data-project-id="${t.projectId}"]`);
    if(btn) btn.scrollIntoView({behavior:'smooth', block:'center'});
    return;
  }
  _navPush();
  route='today';
  render();
}

function openProjectContext(projectId){
  if(!projectId) return;
  _navPush();
  currentProjectId = projectId;
  route='projects';
  render();
  const btn = document.querySelector(`[data-project-id="${projectId}"]`);
  if(btn) btn.scrollIntoView({behavior:'smooth', block:'center'});
}

function renderReview(){
  // TRIAL (Option 2): treat each completed virtual recurring occurrence
  // (m.completions[dateKey] === true) as a DONE task for analytics purposes.
  // We also add it to activeTasks so percentages stay <= 100%.
  const virtualDone = [];
  (db.monthly || []).forEach(m => {
    if(m.deletedAt) return;
    const comp = m.completions || {};
    Object.keys(comp).forEach(dk => {
      if(comp[dk] !== true) return;
      virtualDone.push({
        id: 'rec:' + m.id + ':' + dk,
        title: m.title,
        status: 'DONE',
        priority: 'medium',
        completedAt: dk + 'T12:00:00.000Z',
        updatedAt: m.updatedAt || nowISO(),
        createdAt: m.createdAt || nowISO(),
        noteId: null,
        projectId: null,
        _virtualRecurring: true,
        _monthlyId: m.id,
      });
    });
  });
  // Exclude deleted tasks from analytics
  const done = [...virtualDone, ...db.tasks.filter(t=> t.status==='DONE' && !t.deletedAt)];
  // For the Completed Tasks LIST + count we show only real tasks. Recurring
  // habit completions are visualized in the Habit Streaks grid instead — mixing
  // them into the list was confusing (and Clear History couldn't touch them).
  const realDone = db.tasks.filter(t => t.status==='DONE' && !t.deletedAt);
  const activeTasks = [...virtualDone, ...db.tasks.filter(t=> t.status!=='BACKLOG' && t.status!=='DROPPED' && !t.deletedAt)];
  const total = activeTasks.length;
  const pct = total? Math.round(done.length/total*100) : 0;
  const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate()-7);
  const weekTasks = done.filter(t=> t.completedAt && new Date(t.completedAt) > weekAgo);
  const weekNotes = db.notes.filter(n=> new Date(n.createdAt) > weekAgo);

  // --- Enhanced analytics computations ---
  // Tasks completed today
  const todayStr = todayKey();
  const completedToday = done.filter(t=> t.completedAt && t.completedAt.slice(0,10) === todayStr).length;
  // Priority breakdown of pending tasks
  const pendingTasks = db.tasks.filter(t=> t.status==='TODO' && !t.deletedAt);
  const priHigh = pendingTasks.filter(t=> t.priority==='high').length;
  const priMed  = pendingTasks.filter(t=> t.priority==='medium').length;
  const priLow  = pendingTasks.filter(t=> t.priority==='low').length;
  // Overdue tasks (due date in the past, still TODO)
  const nowDate = new Date(); nowDate.setHours(0,0,0,0);
  const overdue = pendingTasks.filter(t=> t.due && new Date(t.due) < nowDate).length;
  // Most productive day of the week (based on all-time completions)
  const dayCounts = [0,0,0,0,0,0,0];
  done.forEach(t=>{ if(t.completedAt){ dayCounts[new Date(t.completedAt).getDay()]++; } });
  const maxDayCount = Math.max(...dayCounts);
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const bestDay = maxDayCount > 0 ? dayNames[dayCounts.indexOf(maxDayCount)] : null;
  // Active streak: consecutive days with at least 1 task completed (going back from today)
  let streak = 0;
  for(let i=0; i<365; i++){
    const d = new Date(); d.setDate(d.getDate()-i);
    const dk = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    if(done.some(t=> t.completedAt && t.completedAt.slice(0,10)===dk)) streak++;
    else if(i > 0) break; // today with 0 completions is ok, break on any other miss
  }
  // Week-over-week: compare this week vs last week completions
  const twoWeeksAgo = new Date(); twoWeeksAgo.setDate(twoWeeksAgo.getDate()-14);
  const lastWeekTasks = done.filter(t=> t.completedAt && new Date(t.completedAt) > twoWeeksAgo && new Date(t.completedAt) <= weekAgo).length;
  const weekDelta = weekTasks.length - lastWeekTasks;
  const weekDeltaStr = weekDelta > 0 ? `+${weekDelta} vs last week` : weekDelta < 0 ? `${weekDelta} vs last week` : `same as last week`;
  const weekDeltaColor = weekDelta > 0 ? '#4caf9e' : weekDelta < 0 ? '#ff6b6b' : 'var(--muted)';
  // Most productive project (most tasks completed)
  const projCompletions = db.projects.map(p=>({ name: p.name, count: done.filter(t=>t.projectId===p.id).length })).filter(p=>p.count>0).sort((a,b)=>b.count-a.count);
  const topProject = projCompletions[0] || null;
  // Progress bar helper
  const pbar = (val, max, color='#8b6dff') => `<div style="background:var(--btn-bg);border-radius:4px;height:6px;flex:1;min-width:60px;"><div style="background:${color};width:${max?Math.round(val/max*100):0}%;height:100%;border-radius:4px;"></div></div>`;
  const projectStats = db.projects.filter(p=>!p.deletedAt).map(p=>{
    const tasks = db.tasks.filter(t=> t.projectId === p.id && !t.deletedAt);
    const completed = tasks.filter(t=> t.status === 'DONE').length;
    return { project: p, total: tasks.length, completed, progress: tasks.length ? Math.round(completed/tasks.length*100) : 0 };
  }).filter(s=> s.total > 0);
  const pendingAll = db.tasks.filter(t=> t.status==='TODO' && t.status!=='BACKLOG' && t.status!=='DROPPED' && !t.deletedAt && !isUndivergedRecurringTask(t));
  const backlogAll = db.tasks.filter(t=> t.status==='BACKLOG' && !t.deletedAt);
  const pPriority = {high:3,medium:2,low:1};
  pendingAll.sort((a,b)=> (pPriority[b.priority]||2)-(pPriority[a.priority]||2));
  backlogAll.sort((a,b)=> (pPriority[b.priority]||2)-(pPriority[a.priority]||2));

  // Upcoming tasks: tasks with a due date within next 7 days and still pending (TODO)
  const today = new Date();
  const in7 = new Date(); in7.setDate(today.getDate()+7);
  const upcoming = db.tasks.filter(t => t.status==='TODO' && t.due && !t.deletedAt && !isUndivergedRecurringTask(t) && new Date(t.due) >= today && new Date(t.due) <= in7);
  upcoming.sort((a,b)=> new Date(a.due) - new Date(b.due));

  // Precompute HTML for completed tasks history. Sort by completion date (latest first).
  // Use realDone only — recurring habit completions live in the Habit Streaks grid.
  const completedHtml = realDone.length ? realDone.slice().sort((a,b)=>{
    // Use completedAt first, fallback to updatedAt or createdAt
    const aDate = a.completedAt || a.updatedAt || a.createdAt;
    const bDate = b.completedAt || b.updatedAt || b.createdAt;
    return (new Date(bDate)) - (new Date(aDate));
  }).map(t=>{
    const proj = t.projectId ? db.projects.find(p=> p.id === t.projectId) : null;
    const note = t.noteId ? db.notes.find(n=> n.id === t.noteId) : null;
    const ctx = proj ? `<span class='pill'>${htmlesc(proj.name)}</span>` : (note && note.type === 'daily' ? `<span class='pill'>${note.dateIndex}</span>` : '');
    const dateStr = t.completedAt ? new Date(t.completedAt).toLocaleDateString() : '';
    const goTarget = proj ? `data-open-project='${proj.id}'` : (note ? `data-open='${note.id}'` : '');
    const goBtn = goTarget ? `<button class='btn' ${goTarget} style='font-size:11px;' title='Go to context'>Go →</button>` : '';
    return `<div class='row' style='justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap;'>
      <span style='flex:1;min-width:0;word-break:break-word;'>${htmlesc(t.title)} ${ctx} <span class='pill'>${dateStr}</span></span>
      <div class='row' style='gap:4px;flex-shrink:0;'>
        <button class='btn' data-view-task='${t.id}' style='font-size:11px;'>View</button>
        ${goBtn}
        <button class='btn' data-restore='${t.id}' style='font-size:11px;'>Restore</button>
      </div>
    </div>`;
  }).join('') : '<div class="muted">No completed tasks</div>';

  // Helper to build a task row for Pending/Backlog/Upcoming sections
  function taskRow(t, extraBtns='', style=''){
    const proj = t.projectId ? db.projects.find(p=>p.id===t.projectId) : null;
    const note = t.noteId ? db.notes.find(n=>n.id===t.noteId) : null;
    const label = htmlesc(t.title);
    const ctx = proj ? `<span class='pill'>${htmlesc(proj.name)}</span>` : (note && note.type==='daily' ? `<span class='pill'>${note.dateIndex}</span>` : '');
    const goTarget = proj ? `data-open-project='${proj.id}'` : (note ? `data-open='${note.id}'` : '');
    const goBtn = goTarget ? `<button class='btn' ${goTarget} style='font-size:11px;' title='Go to context'>Go →</button>` : '';
    return `<div class='row' style='justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap;'>
      <span style='flex:1;min-width:0;word-break:break-word;${style}padding-left:6px;'>${label} ${ctx}</span>
      <div class='row' style='gap:4px;flex-shrink:0;'>
        <button class='btn' data-view-task='${t.id}' style='font-size:11px;'>View</button>
        ${goBtn}
        ${extraBtns}
      </div>
    </div>`;
  }

  // Helper to build a trash item row with wrapping text
  function trashTaskRow(t){
    const proj = t.projectId ? db.projects.find(p=>p.id===t.projectId) : null;
    const note = t.noteId ? db.notes.find(n=>n.id===t.noteId) : null;
    const label = htmlesc(t.title);
    const ctx = proj ? `<span class='pill'>${htmlesc(proj.name)}</span>` : (note && note.type==='daily' ? `<span class='pill'>${note.dateIndex}</span>` : '');
    const deletedDate = t.deletedAt ? new Date(t.deletedAt).toLocaleDateString() : '';
    return `<div class='row' style='justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap;'>
      <span class='muted' style='flex:1;min-width:0;word-break:break-word;padding-left:6px;'>📋 ${label} ${ctx} <span class='pill'>Deleted: ${deletedDate}</span></span>
      <div class='row' style='gap:4px;flex-shrink:0;'>
        <button class='btn' data-open-task-modal='${t.id}' style='font-size:11px;'>View</button>
        <button class='btn' data-restore-task='${t.id}' style='font-size:11px;'>Restore</button>
        <button class='btn' data-hard-delete='${t.id}' style='font-size:11px;color:#ff6b6b;'>Delete</button>
      </div>
    </div>`;
  }
  function trashNoteRow(n){
    const typeLabel = n.type === 'daily' ? '📅' : n.type === 'idea' ? '💡' : '📝';
    const label = htmlesc(n.title);
    const deletedDate = n.deletedAt ? new Date(n.deletedAt).toLocaleDateString() : '';
    return `<div class='row' style='justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap;'>
      <span class='muted' style='flex:1;min-width:0;word-break:break-word;padding-left:6px;'>${typeLabel} ${label} <span class='pill muted-pill'>Note</span> <span class='pill'>Deleted: ${deletedDate}</span></span>
      <div class='row' style='gap:4px;flex-shrink:0;'>
        <button class='btn' data-restore-note='${n.id}' style='font-size:11px;'>Restore</button>
        <button class='btn' data-hard-delete-note='${n.id}' style='font-size:11px;color:#ff6b6b;'>Delete</button>
      </div>
    </div>`;
  }
  function trashLinkRow(l){
    const label = htmlesc(l.title || l.url);
    const deletedDate = l.deletedAt ? new Date(l.deletedAt).toLocaleDateString() : '';
    return `<div class='row' style='justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap;'>
      <span class='muted' style='flex:1;min-width:0;word-break:break-word;padding-left:6px;'>🔗 ${label} <span class='pill muted-pill'>Link</span> <span class='pill'>Deleted: ${deletedDate}</span></span>
      <div class='row' style='gap:4px;flex-shrink:0;'>
        <button class='btn' data-restore-link='${l.id}' style='font-size:11px;'>Restore</button>
        <button class='btn' data-hard-delete-link='${l.id}' style='font-size:11px;color:#ff6b6b;'>Delete</button>
      </div>
    </div>`;
  }

  // --- Habit streak grid ---
  const habitMonthKey = todayKey().slice(0, 7);
  const habitEntries = (db.monthly || []).filter(m => !m.deletedAt && m.month === habitMonthKey);
  const habitTitles = [...new Set(habitEntries.map(m => m.title))];
  const _hToday = new Date();
  const _hYear = parseInt(habitMonthKey.split('-')[0]);
  const _hMonth = parseInt(habitMonthKey.split('-')[1]) - 1;
  const _hCurrentDay = _hToday.getFullYear() === _hYear && _hToday.getMonth() === _hMonth
    ? _hToday.getDate() : new Date(_hYear, _hMonth + 1, 0).getDate();
  function buildHabitGrid(){
    if(!habitTitles.length) return '<div class="muted" style="font-size:12px;">No habits tracked this month. Add tasks on the Monthly page first.</div>';
    const dayNames = ['Su','Mo','Tu','We','Th','Fr','Sa'];
    const days = Array.from({length: _hCurrentDay}, (_, i) => i + 1);
    let html = '<div style="overflow-x:auto;margin-top:8px;">';
    html += '<table style="border-collapse:collapse;font-size:12px;width:100%;">';
    html += '<thead><tr><th style="text-align:left;padding:4px 8px;font-weight:600;color:var(--muted);min-width:140px;">Habit</th>';
    for(const d of days){
      const dd = new Date(_hYear, _hMonth, d);
      html += `<th style="padding:2px 3px;color:var(--muted);font-weight:normal;min-width:26px;text-align:center;">${d}<br><span style="font-size:10px;">${dayNames[dd.getDay()]}</span></th>`;
    }
    html += '</tr></thead><tbody>';
    for(const title of habitTitles){
      const mt = habitEntries.find(m => m.title === title);
      const scheduledDays = mt && Array.isArray(mt.days) && mt.days.length ? mt.days : null;
      const comp = (mt && mt.completions) || {};
      html += `<tr><td style="padding:4px 8px;font-size:12px;white-space:nowrap;">${htmlesc(title)}</td>`;
      for(const d of days){
        const dateKey = `${_hYear}-${String(_hMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const weekday = new Date(_hYear, _hMonth, d).getDay();
        if(scheduledDays && !scheduledDays.includes(weekday)){
          html += `<td style="text-align:center;padding:2px 3px;color:var(--muted);font-size:11px;">–</td>`;
          continue;
        }
        // Option 2: virtual completion takes precedence.
        if(comp[dateKey] === true){
          html += `<td style="text-align:center;padding:2px 3px;" title="${htmlesc(title)} ✓ ${dateKey}">✅</td>`;
          continue;
        }
        // Legacy fallback: look for a real DONE task on that day's daily note.
        const dailyNote = db.notes.find(n => n.type==='daily' && n.dateIndex===dateKey && !n.deletedAt);
        if(!dailyNote){
          // Future days (no note yet) → neutral dot
          const dDate = new Date(_hYear, _hMonth, d);
          const isFuture = dDate > new Date();
          html += `<td style="text-align:center;padding:2px 3px;color:var(--muted);font-size:11px;">${isFuture ? '·' : '·'}</td>`;
          continue;
        }
        const task = db.tasks.find(t => t.noteId===dailyNote.id && t.title===title && !t.deletedAt);
        if(task && task.status === 'DONE'){
          html += `<td style="text-align:center;padding:2px 3px;" title="${htmlesc(title)} ✓ ${dateKey}">✅</td>`;
        } else {
          // No virtual completion, no real DONE → missed (only for past/today)
          const dDate = new Date(_hYear, _hMonth, d);
          const isFuture = dDate > new Date();
          if(isFuture){
            html += `<td style="text-align:center;padding:2px 3px;color:var(--muted);font-size:11px;">·</td>`;
          } else {
            html += `<td style="text-align:center;padding:2px 3px;" title="${htmlesc(title)} ✗ ${dateKey}">❌</td>`;
          }
        }
      }
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    // Legend
    html += '<div style="margin-top:6px;font-size:11px;color:var(--muted);">✅ Done &nbsp; ❌ Missed &nbsp; – Not scheduled &nbsp; · No daily note</div>';
    return html;
  }
  const habitGridHtml = buildHabitGrid();

  // --- Research pulse + Notebook activity ---
  const _weekAgoMs = weekAgo.getTime();
  const _researchNb = (db.notebooks||[]).find(n => !n.deletedAt && n.system && n.title === '🔬 Research');
  let researchHtml = '<div class="muted" style="font-size:12px;">Research module not initialized.</div>';
  if(_researchNb){
    const _rPages = (db.notes||[]).filter(n => n.notebookId === _researchNb.id && !n.deletedAt && n.type === 'page');
    const _inbox  = _rPages.find(p => p.title === '📥 Inbox');
    const _inboxLines = _inbox ? (_inbox.content||'').split('\n').filter(l => /^\s*-\s+\S/.test(l)).length : 0;
    const _papers = _rPages.filter(p => (p.tags||[]).includes('paper')).length;
    const _topicMaps = _rPages.filter(p => p.title.startsWith('🗺️ Topic Map — ') && p.title !== '🗺️ Topic Maps — Index').length;
    const _synths = _rPages.filter(p => (p.tags||[]).includes('synthesis') && !(p.tags||[]).includes('template'))
                          .sort((a,b)=> (b.updatedAt||'').localeCompare(a.updatedAt||''));
    const _lastSynth = _synths[0];
    const _daysSinceSynth = _lastSynth ? Math.floor((Date.now() - new Date(_lastSynth.updatedAt||_lastSynth.createdAt).getTime())/86400000) : null;
    const _synthColor = _daysSinceSynth == null ? '#64748b' : _daysSinceSynth > 35 ? '#ff6b6b' : _daysSinceSynth > 21 ? '#f0c040' : '#4caf9e';
    const _synthLabel = _daysSinceSynth == null ? 'no synthesis yet' : `${_daysSinceSynth}d since last synthesis`;
    // Open follow-ups, scoped: only count tasks whose source note is tagged 'paper'
    // or lives in the 🔬 Research notebook — otherwise checklist tasks from any
    // note (e.g. project plans) would inflate this number.
    const _resNoteById = new Map((db.notes||[]).filter(n => !n.deletedAt).map(n => [n.id, n]));
    const _isResearchSrc = (nid) => {
      const s = _resNoteById.get(nid);
      if (!s) return false;
      if ((s.tags||[]).includes('paper')) return true;
      if (s.notebookId === _researchNb.id) return true;
      return false;
    };
    const _openFollowups = (db.tasks||[]).filter(t => !t.deletedAt && t.status !== 'DONE' && (t.tags||[]).includes('paper-followup') && _isResearchSrc(t.noteId)).length;
    const _followupColor = _openFollowups === 0 ? '#4caf9e' : _openFollowups > 15 ? '#ff6b6b' : _openFollowups > 6 ? '#f0c040' : '#8b6dff';
    researchHtml = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px;">
        <div style="background:var(--btn-bg);border-radius:8px;padding:8px 10px;">
          <div style="font-size:20px;font-weight:700;color:#8b6dff;">${_inboxLines}</div>
          <div style="font-size:11px;color:var(--muted);">📥 inbox items</div>
        </div>
        <div style="background:var(--btn-bg);border-radius:8px;padding:8px 10px;">
          <div style="font-size:20px;font-weight:700;color:#4caf9e;">${_papers}</div>
          <div style="font-size:11px;color:var(--muted);">📄 paper notes</div>
        </div>
        <div style="background:var(--btn-bg);border-radius:8px;padding:8px 10px;">
          <div style="font-size:20px;font-weight:700;color:#f0c040;">${_topicMaps}</div>
          <div style="font-size:11px;color:var(--muted);">🗺️ topic maps</div>
        </div>
        <div style="background:var(--btn-bg);border-radius:8px;padding:8px 10px;">
          <div style="font-size:20px;font-weight:700;color:${_synthColor};">${_synths.length}</div>
          <div style="font-size:11px;color:var(--muted);">📊 ${_synthLabel}</div>
        </div>
        <div style="background:var(--btn-bg);border-radius:8px;padding:8px 10px;grid-column:1 / -1;">
          <div style="font-size:20px;font-weight:700;color:${_followupColor};">${_openFollowups}</div>
          <div style="font-size:11px;color:var(--muted);">📌 open follow-ups (from paper checklists)</div>
        </div>
      </div>
      <div style="margin-top:8px;"><button class="btn" data-goto-research="1" style="font-size:11px;width:100%;">Open Research dashboard →</button></div>`;
  }

  const _aliveNbs = (db.notebooks||[]).filter(n => !n.deletedAt && !n.system);
  const _nbStats = _aliveNbs.map(nb => {
    const pgs = (db.notes||[]).filter(n => n.notebookId === nb.id && !n.deletedAt);
    const recent = pgs.filter(n => n.updatedAt && new Date(n.updatedAt).getTime() > _weekAgoMs).length;
    const lastTouched = pgs.reduce((max, n) => {
      const t = n.updatedAt ? new Date(n.updatedAt).getTime() : 0;
      return t > max ? t : max;
    }, 0);
    return { nb, total: pgs.length, recent, lastTouched };
  }).sort((a,b) => b.recent - a.recent || b.lastTouched - a.lastTouched);
  const _maxNbCount = Math.max(1, ..._nbStats.map(s => s.total));
  const notebookHtml = _nbStats.length ? `
    <div class="list" style="margin-top:10px;">
      ${_nbStats.map(s => {
        const ageDays = s.lastTouched ? Math.floor((Date.now() - s.lastTouched)/86400000) : null;
        const ageStr = ageDays == null ? 'never edited' : ageDays === 0 ? 'today' : ageDays === 1 ? 'yesterday' : `${ageDays}d ago`;
        const recentBadge = s.recent > 0 ? `<span class="pill" style="background:#4caf9e;color:#fff;font-size:10px;">+${s.recent} this week</span>` : '';
        return `<div class='row' style='justify-content:space-between;align-items:center;gap:8px;'>
          <span style='flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;' title='${htmlesc(s.nb.title)}'>${htmlesc(s.nb.title)} ${recentBadge}</span>
          <div class='row' style='gap:6px;align-items:center;flex-shrink:0;'>
            ${pbar(s.total, _maxNbCount, '#8b6dff')}
            <span class='muted' style='font-size:11px;min-width:80px;text-align:right;'>${s.total}p · ${ageStr}</span>
            <button class='btn' data-open-nb='${s.nb.id}' style='font-size:11px;'>Open →</button>
          </div>
        </div>`;
      }).join('')}
    </div>` : '<div class="muted" style="font-size:12px;margin-top:8px;">No notebooks yet.</div>';

  // --- Duplicate tasks computation ---
  const dupGroups = findDuplicateTaskGroups(0.75);
  function buildDupGroupHtml(groups){
    if(!groups.length) return '<div class="muted" style="font-size:12px;">No potential duplicates found ✔</div>';
    return groups.map((group, gi) => {
      const rows = group.map(t => {
        const proj = t.projectId ? db.projects.find(p=>p.id===t.projectId) : null;
        const note = t.noteId ? db.notes.find(n=>n.id===t.noteId) : null;
        const ctx = proj ? `<span class='pill'>${htmlesc(proj.name)}</span>` : (note && note.type==='daily' ? `<span class='pill'>${note.dateIndex}</span>` : '');
        return `<div class='row' style='justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap;padding:4px 0;border-bottom:1px solid var(--btn-border);'>
          <span style='flex:1;min-width:0;word-break:break-word;font-size:13px;'>${htmlesc(t.title)} ${ctx} <span class='pill' style='font-size:10px;'>${t.status}</span></span>
          <button class='btn' data-dup-del='${t.id}' style='font-size:11px;color:#ff6b6b;flex-shrink:0;'>Remove</button>
        </div>`;
      }).join('');
      const keepId = group[0].id;
      const removeIds = group.slice(1).map(t=>t.id).join(',');
      return `<div style='margin-bottom:12px;padding:8px;background:var(--btn-bg);border-radius:8px;border:1px solid #f0c040;'>
        <div class='row' style='justify-content:space-between;align-items:center;margin-bottom:6px;'>
          <span style='font-size:12px;color:#f0c040;font-weight:600;'>⚠️ ${group.length} similar tasks</span>
          <button class='btn' data-dup-keep='${keepId}' data-dup-remove='${removeIds}' style='font-size:11px;'>Keep first, remove rest</button>
        </div>
        ${rows}
      </div>`;
    }).join('');
  }
  const dupHtml = buildDupGroupHtml(dupGroups);

  content.innerHTML = `
    <div class="review">
    <div class="grid-2">
      <details class="card" open>
        <summary style="cursor:pointer;list-style:none;"><strong>📊 Analytics</strong></summary>
        <div style="margin-top:10px;display:flex;flex-direction:column;gap:10px;">

          <div style="display:flex;align-items:center;gap:10px;">
            ${pbar(done.length, total||1, '#4caf9e')}
            <span style="font-size:12px;white-space:nowrap;">${done.length}/${total||0} done (${pct}%)</span>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
            <div style="background:var(--btn-bg);border-radius:8px;padding:8px 10px;">
              <div style="font-size:20px;font-weight:700;color:#8b6dff;">${completedToday}</div>
              <div style="font-size:11px;color:var(--muted);">done today</div>
            </div>
            <div style="background:var(--btn-bg);border-radius:8px;padding:8px 10px;">
              <div style="font-size:20px;font-weight:700;color:${weekDeltaColor};">${weekTasks.length}</div>
              <div style="font-size:11px;color:var(--muted);">this week <span style="color:${weekDeltaColor};font-size:10px;">(${weekDeltaStr})</span></div>
            </div>
            <div style="background:var(--btn-bg);border-radius:8px;padding:8px 10px;">
              <div style="font-size:20px;font-weight:700;color:${overdue>0?'#ff6b6b':'#4caf9e'};">${overdue}</div>
              <div style="font-size:11px;color:var(--muted);">overdue</div>
            </div>
            <div style="background:var(--btn-bg);border-radius:8px;padding:8px 10px;">
              <div style="font-size:20px;font-weight:700;color:#f0c040;">${streak}</div>
              <div style="font-size:11px;color:var(--muted);">day streak 🔥</div>
            </div>
          </div>

          <div>
            <div style="font-size:11px;color:var(--muted);margin-bottom:4px;">Pending by priority</div>
            <div style="display:flex;flex-direction:column;gap:4px;">
              <div style="display:flex;align-items:center;gap:8px;">
                <span style="font-size:11px;color:#ff6b6b;width:32px;">High</span>${pbar(priHigh, priHigh+priMed+priLow||1,'#ff6b6b')}<span style="font-size:11px;">${priHigh}</span>
              </div>
              <div style="display:flex;align-items:center;gap:8px;">
                <span style="font-size:11px;color:#8b6dff;width:32px;">Med</span>${pbar(priMed, priHigh+priMed+priLow||1,'#8b6dff')}<span style="font-size:11px;">${priMed}</span>
              </div>
              <div style="display:flex;align-items:center;gap:8px;">
                <span style="font-size:11px;color:#64748b;width:32px;">Low</span>${pbar(priLow, priHigh+priMed+priLow||1,'#64748b')}<span style="font-size:11px;">${priLow}</span>
              </div>
            </div>
          </div>

          ${topProject ? `<div style="font-size:12px;color:var(--muted);">🏆 Top project: <strong>${htmlesc(topProject.name)}</strong> (${topProject.count} done)</div>` : ''}
          ${bestDay ? `<div style="font-size:12px;color:var(--muted);">📅 Most productive: <strong>${bestDay}</strong></div>` : ''}
          <div style="font-size:12px;color:var(--muted);">📝 Notes this week: ${weekNotes.length}</div>
        </div>
      </details>
      <details class="card" open>
        <summary style="cursor:pointer;list-style:none;"><strong>🎯 Project Progress</strong></summary>
        <div class="list" style="margin-top:8px;">
          ${projectStats.map(s=>`<div class='row' style='justify-content:space-between;align-items:center;'>
            <span>${htmlesc(s.project.name)}</span>
            <div class='row' style='gap:6px;align-items:center;'>
              <span class='muted'>${s.completed}/${s.total} (${s.progress}%)</span>
              <button class='btn' data-open-project='${s.project.id}' style='font-size:11px;'>View →</button>
            </div>
          </div>`).join('') || '<div class="muted">No project tasks yet</div>'}
        </div>
      </details>
    </div>
    <details class="card" open>
      <summary style="cursor:pointer;list-style:none;"><strong>🔥 Habit Streaks — ${new Date(_hYear, _hMonth).toLocaleString('default',{month:'long'})} ${_hYear}</strong></summary>
      ${habitGridHtml}
    </details>
    <details class="card" open>
      <summary style="cursor:pointer;list-style:none;"><strong>🔬 Research Pulse</strong></summary>
      ${researchHtml}
    </details>
    <details class="card" open>
      <summary style="cursor:pointer;list-style:none;"><strong>📓 Notebook Activity (${_aliveNbs.length})</strong></summary>
      ${notebookHtml}
    </details>
    <details class="card" open>
      <summary style="cursor:pointer;list-style:none;"><strong>📅 Upcoming Tasks (${upcoming.length})</strong></summary>
      <div class="list" style="margin-top:8px;max-height:240px;overflow:auto;">
  ${upcoming.map(t=>{
          const proj = t.projectId ? db.projects.find(p=>p.id===t.projectId) : null;
          const note = t.noteId ? db.notes.find(n=>n.id===t.noteId) : null;
          const colors = { high: '#ff6b6b', medium: '#8b6dff', low: '#64748b' };
          const col = colors[t.priority || 'medium'];
          const dueStr = t.due ? formatDateString(t.due) : '';
          const ctx = proj ? `<span class='pill'>${htmlesc(proj.name)}</span>` : (note && note.type==='daily' ? `<span class='pill'>${note.dateIndex}</span>` : '');
          const goTarget = proj ? `data-open-project='${proj.id}'` : (note ? `data-open='${note.id}'` : '');
          const goBtn = goTarget ? `<button class='btn' ${goTarget} style='font-size:11px;' title='Go to context'>Go →</button>` : '';
          return `<div class='row' style='justify-content:space-between;align-items:center;'>
            <span style='border-left:3px solid ${col};padding-left:6px;'>${htmlesc(t.title)} ${ctx} <span class='pill'>${dueStr}</span></span>
            <div class='row' style='gap:4px;'>
              <button class='btn' data-view-task='${t.id}' style='font-size:11px;'>View</button>
              ${goBtn}
              <button class='btn' data-done='${t.id}' style='font-size:11px;'>✓ Done</button>
            </div>
          </div>`;
        }).join('') || '<div class="muted">No upcoming tasks</div>'}
      </div>
    </details>
    <details class="card" open>
      <summary style="cursor:pointer;list-style:none;"><strong>🕒 Pending Tasks (${pendingAll.length})</strong></summary>
      <div class="list" style="margin-top:8px;max-height:240px;overflow:auto;">
        ${pendingAll.map(t=>{
          const colors={high:'#ff6b6b',medium:'#8b6dff',low:'#64748b'};
          const extraBtns = `<button class='btn' data-done='${t.id}' style='font-size:11px;'>✓ Done</button>`;
          return taskRow(t, extraBtns, `border-left:3px solid ${colors[t.priority||'medium']};`);
        }).join('') || '<div class="muted">No pending tasks</div>'}
      </div>
    </details>
    <details class="card" open>
      <summary style="cursor:pointer;list-style:none;"><strong>📦 Backlog Tasks (${backlogAll.length})</strong></summary>
      <div class="list" style="margin-top:8px;max-height:240px;overflow:auto;">
        ${backlogAll.map(t=>{
          const extraBtns = `<button class='btn' data-restore='${t.id}' style='font-size:11px;'>Restore</button>`;
          return taskRow(t, extraBtns, 'color:var(--muted);');
        }).join('') || '<div class="muted">No backlog tasks</div>'}
      </div>
    </details>
    <details class="card">
      <summary style="cursor:pointer;list-style:none;"><strong>🔍 Duplicate Tasks (${dupGroups.length} group${dupGroups.length!==1?'s':''})</strong></summary>
      <div style="margin-top:8px;">${dupHtml}</div>
    </details>
    <!-- Completed tasks history (real tasks only — recurring habit completions live in the Habit Streaks grid) -->
    <details class="card">
      <summary style="cursor:pointer;list-style:none;">
        <div class="row" style="justify-content:space-between;align-items:center;">
          <strong>✅ Completed Tasks (${realDone.length})</strong>
          <button id="clearCompleted" class="btn" style="font-size:12px;">Clear History</button>
        </div>
      </summary>
      <div class="list" style="margin-top:8px;max-height:240px;overflow:auto;">
        ${completedHtml}
      </div>
    </details>
    <details class="card" open>
      <summary style="cursor:pointer;list-style:none;"><strong>📅 Recent Daily Logs</strong></summary>
      <div class="list" style="margin-top:8px;">${db.notes.filter(n=>n.type==='daily' && !n.deletedAt).slice(-7).reverse().map(n=> `<div class='row' style='justify-content:space-between;'><span>${htmlesc(n.title)}</span><button class='btn' data-open='${n.id}' style='font-size:11px;'>View →</button></div>`).join('')}</div>
    </details>
    <details class="card" open>
      <summary style="cursor:pointer;list-style:none;"><strong>🏷️ Tag Cloud</strong></summary>
  <div style="margin-top:8px;">${getAllTags().map(tag=>{
        const noteCount = db.notes.filter(n=> (n.tags||[]).includes(tag)).length;
        const linkCount = db.links ? db.links.filter(l=> !l.deletedAt && (l.tags||[]).includes(tag)).length : 0;
        const count = noteCount + linkCount;
        return `<button class='pill' data-tag='${tag}' style='cursor:pointer;margin:2px;'>#${htmlesc(tag)} (${count})</button>`;
      }).join('') || '<div class="muted">No tags yet</div>'}</div>
    </details>
    <!-- Trash section — pinned to the very bottom -->
    <details class="card">
      <summary style="cursor:pointer;list-style:none;">
        <div class="row" style="justify-content:space-between;align-items:center;">
          <strong>🗑️ Trash (${getTrashedTasks().length + getTrashedNotes().length + getTrashedLinks().length})</strong>
          <button id="emptyTrashBtn" class="btn" style="font-size:12px;">Empty Trash</button>
        </div>
      </summary>
      <div class="list" style="margin-top:8px;max-height:320px;overflow:auto;">
  ${getTrashedTasks().map(t=>trashTaskRow(t)).join('')}
  ${getTrashedNotes().map(n=>trashNoteRow(n)).join('')}
  ${getTrashedLinks().map(l=>trashLinkRow(l)).join('')}
  ${(getTrashedTasks().length + getTrashedNotes().length + getTrashedLinks().length) === 0 ? '<div class="muted" style="text-align:center;padding:12px;">Trash is empty</div>' : ''}
      </div>
    </details>
    </div>`;
  content.querySelectorAll('[data-open]').forEach(b=> b.onclick=()=> openNote(b.dataset.open));
  content.querySelectorAll('[data-open-note]').forEach(b=> b.onclick=()=> openNote(b.dataset.openNote));
  content.querySelectorAll('[data-view-task]').forEach(b=> b.onclick=()=> openTaskModal(b.dataset.viewTask));
  content.querySelectorAll('[data-open-task]').forEach(b=> b.onclick=()=> openTaskContext(b.dataset.openTask));
  content.querySelectorAll('[data-open-project]').forEach(b=> b.onclick=()=> openProjectContext(b.dataset.openProject));
  content.querySelectorAll('[data-goto-research]').forEach(b=> b.onclick=()=>{ _navPush(); route='research'; render(); });
  content.querySelectorAll('[data-open-nb]').forEach(b=> b.onclick=()=>{ _navPush(); currentNotebookId = b.dataset.openNb; currentPageId = null; route='notebooks'; render(); });
  content.querySelectorAll('[data-done]').forEach(b=> b.onclick=()=>{ setTaskStatus(b.dataset.done,'DONE'); renderReview(); });
  // Virtual recurring undo (Option 2 trial)
  content.querySelectorAll('[data-rec-uncomplete]').forEach(b=> b.onclick=()=>{
    setRecurringCompletion(b.dataset.recUncomplete, b.dataset.recDate, false);
    renderReview();
  });
  // Duplicate task remove handlers
  content.querySelectorAll('[data-dup-del]').forEach(b=> b.onclick=()=>{ deleteTask(b.dataset.dupDel); renderReview(); });
  content.querySelectorAll('[data-dup-keep]').forEach(b=> b.onclick=()=>{
    const removeIds = (b.dataset.dupRemove||'').split(',').filter(Boolean);
    removeIds.forEach(id => deleteTask(id));
    renderReview();
  });
  content.querySelectorAll('[data-restore]').forEach(b=> b.onclick=()=>{
    const id = b.dataset.restore;
    const task = db.tasks.find(t => t.id === id);
    if(task){
      // Only reassign noteId if the task's original note is gone/deleted,
      // or if the task has no noteId at all (orphaned / project task).
      // Preserving the original noteId prevents today's task list from changing
      // when a task completed from a past note is restored.
      const originalNote = task.noteId ? db.notes.find(n => n.id === task.noteId && !n.deletedAt) : null;
      if(!originalNote && !task.projectId){
        // Original note is gone — park the task on today's daily note
        const key = todayKey();
        let todayNote = db.notes.find(n => n.type === 'daily' && n.dateIndex === key && !n.deletedAt);
        if(!todayNote) todayNote = createDailyNoteFor(key);
        task.noteId = todayNote.id;
      }
      // Stamp updatedAt so the noteId change wins any pending server merge
      task.updatedAt = nowISO();
    }
    setTaskStatus(id,'TODO');
    renderReview();
  });
  content.querySelectorAll('[data-tag]').forEach(b=> b.onclick=()=>{ _navPush(); route='vault'; document.getElementById('q').value='#'+b.dataset.tag; render(); });

  // Trash handlers
  content.querySelectorAll('[data-open-task-modal]').forEach(b=> b.onclick=()=>{ openTaskModal(b.dataset.openTaskModal); });
  content.querySelectorAll('[data-restore-task]').forEach(b=> b.onclick=()=>{ restoreTask(b.dataset.restoreTask); renderReview(); });
  content.querySelectorAll('[data-hard-delete]').forEach(b=> b.onclick=async ()=>{ 
    const task = db.tasks.find(t => t.id === b.dataset.hardDelete);
    const ok = await showConfirm(`Permanently delete "${task?.title || 'this task'}"? This cannot be undone.`, 'Delete Forever', 'Cancel');
    if(ok) { hardDeleteTask(b.dataset.hardDelete); renderReview(); }
  });
  content.querySelectorAll('[data-restore-note]').forEach(b=> b.onclick=()=>{ restoreNote(b.dataset.restoreNote); renderReview(); });
  content.querySelectorAll('[data-hard-delete-note]').forEach(b=> b.onclick=async ()=>{
    const note = db.notes.find(n => n.id === b.dataset.hardDeleteNote);
    const ok = await showConfirm(`Permanently delete note "${note?.title || 'this note'}"? This cannot be undone.`, 'Delete Forever', 'Cancel');
    if(ok) { hardDeleteNote(b.dataset.hardDeleteNote); renderReview(); }
  });
  content.querySelectorAll('[data-restore-link]').forEach(b=> b.onclick=()=>{ restoreLink(b.dataset.restoreLink); renderReview(); });
  content.querySelectorAll('[data-hard-delete-link]').forEach(b=> b.onclick=async ()=>{
    const link = db.links.find(l => l.id === b.dataset.hardDeleteLink);
    const ok = await showConfirm(`Permanently delete link "${link?.title || link?.url || 'this link'}"? This cannot be undone.`, 'Delete Forever', 'Cancel');
    if(ok) { hardDeleteLink(b.dataset.hardDeleteLink); renderReview(); }
  });

  // Empty trash handler
  const emptyTrashBtn = document.getElementById('emptyTrashBtn');
  if(emptyTrashBtn){
    emptyTrashBtn.onclick = async (e) => {
      // Button lives inside a <summary>; prevent the click from toggling the details.
      e.preventDefault(); e.stopPropagation();
      const deletedTasks = getTrashedTasks();
      const deletedNotes = getTrashedNotes();
      const deletedLinks = getTrashedLinks();
      const total = deletedTasks.length + deletedNotes.length + deletedLinks.length;
      if(total === 0) return;
      const ok = await showConfirm(`Permanently delete all ${total} item${total!==1?'s':''} from trash? This cannot be undone.`, 'Empty Trash', 'Cancel');
      if(ok) { emptyTrash(); renderReview(); }
    };
  }

  // Handler for clearing completed tasks history
  const clearBtn = document.getElementById('clearCompleted');
  if(clearBtn){
    clearBtn.onclick = async (e) => {
      // Button lives inside a <summary>; prevent the click from toggling the details.
      e.preventDefault(); e.stopPropagation();
      const ok = await showConfirm('Clear all completed tasks history?', 'Clear', 'Cancel');
      if(!ok) return;
      // Soft delete all done tasks that haven't already been deleted (recurring habit completions are not affected).
      db.tasks.filter(t => t.status === 'DONE' && !t.deletedAt).forEach(t => deleteTask(t.id));
      // Re-render review after clearing
      renderReview();
    };
  }
}

// --- Journal History view ---
function renderJournalHistory() {
  // Gather all daily notes that have journal content, newest first
  const entries = (db.notes || [])
    .filter(n => n.type === 'daily' && !n.deletedAt && n.journal && n.journal.trim())
    .sort((a, b) => b.dateIndex.localeCompare(a.dateIndex));

  const MOOD_LABELS = {'😊':'Great','🙂':'Good','😐':'Okay','😔':'Tired','😤':'Stressed'};
  const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  function wordCount(text) {
    return text ? text.trim().split(/\s+/).filter(Boolean).length : 0;
  }

  function dayOfWeek(dateIndex) {
    const d = new Date(dateIndex + 'T00:00:00');
    return DAY_NAMES[d.getDay()];
  }

  // Render the list (filtered)
  function buildList(searchQ, dateFrom, dateTo) {
    let filtered = entries;
    const q = (searchQ || '').trim().toLowerCase();
    if (q) filtered = filtered.filter(e => e.journal.toLowerCase().includes(q) || e.dateIndex.includes(q));
    if (dateFrom) filtered = filtered.filter(e => e.dateIndex >= dateFrom);
    if (dateTo) filtered = filtered.filter(e => e.dateIndex <= dateTo);
    if (!filtered.length) {
      return `<div class='muted' style='text-align:center;padding:32px;'>
        ${entries.length ? 'No entries match your filter.' : 'No journal entries yet — start writing in the Daily Journal section on the <strong>Today</strong> page.'}
      </div>`;
    }
    return filtered.map(e => {
      const wc = wordCount(e.journal);
      const mood = e.mood || '';
      const moodLabel = mood ? ` ${MOOD_LABELS[mood] || ''}` : '';
      const dow = dayOfWeek(e.dateIndex);
      const dateObj = new Date(e.dateIndex + 'T00:00:00');
      const dateStr = dateObj.toLocaleDateString(undefined, {year:'numeric', month:'long', day:'numeric'});
      // Render journal markdown preview
      const previewHtml = markdownToHtml(e.journal);
      const entryId = 'jh-' + e.id;
      return `<div class='card' id='${entryId}' style='margin-bottom:10px;'>
        <div style='display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;'>
          <div>
            <div style='font-size:15px;font-weight:600;'>${htmlesc(dow)}, ${htmlesc(dateStr)}</div>
            <div style='font-size:12px;color:var(--muted);margin-top:2px;'>
              ${mood ? `<span style='font-size:16px;'>${mood}</span><span style='margin-left:4px;'>${htmlesc(moodLabel.trim())}</span> &nbsp;·&nbsp; ` : ''}
              ${wc} word${wc !== 1 ? 's' : ''}
            </div>
          </div>
          <div style='display:flex;gap:6px;flex-shrink:0;'>
            <button class='btn jh-open' data-date='${htmlesc(e.dateIndex)}' style='font-size:12px;'>Open Day →</button>
            <button class='btn jh-toggle' data-target='${entryId}-body' style='font-size:12px;'>▾ Expand</button>
          </div>
        </div>
        <div id='${entryId}-body' class='markdown-preview' style='margin-top:10px;display:none;border-top:1px solid var(--btn-border);padding-top:10px;'>
          ${previewHtml}
        </div>
      </div>`;
    }).join('');
  }

  content.innerHTML = `
    <div class='card'>
      <div class='row' style='justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;'>
        <strong style='font-size:16px;'>📖 Journal History</strong>
        <div class='muted' style='font-size:12px;'>${entries.length} entr${entries.length !== 1 ? 'ies' : 'y'}</div>
      </div>
      <div class='row' style='margin-top:10px;gap:8px;flex-wrap:wrap;'>
        <input id='jhSearch' type='text' placeholder='Search journal text…' style='flex:1;min-width:160px;' />
        <input id='jhFrom' type='date' title='From date' style='padding:8px;background:var(--input-bg);border:1px solid var(--input-border);color:var(--fg);border-radius:6px;' />
        <input id='jhTo' type='date' title='To date' style='padding:8px;background:var(--input-bg);border:1px solid var(--input-border);color:var(--fg);border-radius:6px;' />
        <button id='jhClear' class='btn' style='font-size:12px;'>Clear</button>
      </div>
      <div style='margin-top:6px;font-size:11px;color:var(--muted);'>Click <em>▾ Expand</em> to read an entry inline, or <em>Open Day →</em> to navigate to that day.</div>
    </div>
    <div id='jhList'>${buildList('', '', '')}</div>`;

  // Wire controls
  const searchEl = document.getElementById('jhSearch');
  const fromEl = document.getElementById('jhFrom');
  const toEl = document.getElementById('jhTo');
  const clearEl = document.getElementById('jhClear');

  function refreshList() {
    const listEl = document.getElementById('jhList');
    if (listEl) listEl.innerHTML = buildList(searchEl.value, fromEl.value, toEl.value);
    bindEntryHandlers();
  }

  function bindEntryHandlers() {
    // Open Day buttons
    content.querySelectorAll('.jh-open').forEach(btn => {
      btn.onclick = () => {
        _navPush();
        selectedDailyDate = btn.dataset.date;
        route = 'today';
        render();
      };
    });
    // Expand/collapse toggles
    content.querySelectorAll('.jh-toggle').forEach(btn => {
      btn.onclick = () => {
        const body = document.getElementById(btn.dataset.target);
        if (!body) return;
        const open = body.style.display !== 'none';
        body.style.display = open ? 'none' : 'block';
        btn.textContent = open ? '▾ Expand' : '▴ Collapse';
      };
    });
  }

  if (searchEl) searchEl.oninput = refreshList;
  if (fromEl) fromEl.onchange = refreshList;
  if (toEl) toEl.onchange = refreshList;
  if (clearEl) clearEl.onclick = () => {
    if (searchEl) searchEl.value = '';
    if (fromEl) fromEl.value = '';
    if (toEl) toEl.value = '';
    refreshList();
  };

  bindEntryHandlers();
}
// --- End Journal History view ---

// --- Map view ---
function renderMap() {
  // Enhanced Note Map: collapsible tree, color-coded chips, connection badges,
  // real-time filter, and an "unlinked notes" section.
  const notes = (db.notes || []).filter(n => !n.deletedAt && n.type !== 'page');

  // Project colour palette — cycled by project index
  const PROJECT_COLORS = ['#8b6dff','#6ecb6e','#f0a14e','#c97dd4','#f06e6e','#4ec9c0','#e8d96e'];
  const projectColorMap = {};
  (db.projects || []).forEach((p, i) => { projectColorMap[p.id] = PROJECT_COLORS[i % PROJECT_COLORS.length]; });

  // Build inbound / outbound connection counts
  const inboundCount  = {};
  const outboundCount = {};
  notes.forEach(n => { inboundCount[n.id] = 0; outboundCount[n.id] = 0; });
  notes.forEach(n => {
    if (Array.isArray(n.links)) {
      n.links.forEach(tid => {
        outboundCount[n.id] = (outboundCount[n.id] || 0) + 1;
        if (inboundCount[tid] !== undefined) inboundCount[tid]++;
      });
    }
  });

  const connected = notes.filter(n =>
    (Array.isArray(n.links) && n.links.length > 0) || inboundCount[n.id] > 0
  );
  const orphans = notes.filter(n =>
    !(Array.isArray(n.links) && n.links.length > 0) && !inboundCount[n.id]
  );
  const totalLinks = notes.reduce((s, n) => s + (Array.isArray(n.links) ? n.links.length : 0), 0);

  // Roots = connected notes with no incoming links
  const roots = connected.filter(n => inboundCount[n.id] === 0);
  const visited = new Set();

  function chipColor(note) {
    return (note.projectId && projectColorMap[note.projectId]) ? projectColorMap[note.projectId] : 'var(--acc)';
  }
  function connCount(note) {
    return (outboundCount[note.id] || 0) + (inboundCount[note.id] || 0);
  }
  function snippet(note) {
    return (note.content || '').replace(/[#*`\[\]>]/g, '').trim().slice(0, 140) || '(no content)';
  }

  function buildNode(note, depth) {
    if (!note || visited.has(note.id) || depth > 20) return '';
    visited.add(note.id);
    const children = Array.isArray(note.links)
      ? note.links.map(id => connected.find(m => m.id === id)).filter(Boolean)
      : [];
    const hasKids = children.length > 0;
    const color    = chipColor(note);
    const cnt      = connCount(note);
    const badge    = cnt > 1 ? `<span class="map-badge">${cnt}</span>` : '';
    const proj     = note.projectId ? (db.projects || []).find(p => p.id === note.projectId) : null;
    const projTag  = proj ? `<span class="map-proj-tag" style="background:${color}22;color:${color};">${htmlesc(proj.name)}</span>` : '';
    const toggle   = hasKids
      ? `<button class="map-toggle map-toggle--open" data-target="mc-${note.id}" aria-label="collapse">▾</button>`
      : `<span class="map-toggle-ph"></span>`;
    const childHtml = hasKids
      ? `<div id="mc-${note.id}" class="map-children-wrap"><ul class="mind-map">` +
        children.map(c => buildNode(c, depth + 1)).join('') +
        `</ul></div>`
      : '';
    return `<li class="map-li">
      <div class="map-node">
        ${toggle}
        <a href="#" class="map-chip" data-note="${note.id}" style="--chip-color:${color}" title="${htmlesc(snippet(note))}">${htmlesc(note.title)}${badge}</a>
        ${projTag}
      </div>
      ${childHtml}
    </li>`;
  }

  const sourceList = (roots.length ? roots : connected).slice().sort((a,b) => a.title.localeCompare(b.title));
  const treeHtml = sourceList.map(n => visited.has(n.id) ? '' : buildNode(n, 0)).join('');

  const orphanHtml = orphans.length ? `
    <details class="map-orphans">
      <summary>Unlinked notes <span class="map-badge map-badge--muted">${orphans.length}</span></summary>
      <div class="map-orphan-grid">
        ${orphans.slice().sort((a,b)=>a.title.localeCompare(b.title)).map(n => {
          const color = chipColor(n);
          return `<a href="#" class="map-chip" data-note="${n.id}" style="--chip-color:${color}" title="${htmlesc(snippet(n))}">${htmlesc(n.title)}</a>`;
        }).join('')}
      </div>
    </details>` : '';

  const emptyMsg = connected.length === 0 && orphans.length === 0
    ? `<p class="muted" style="text-align:center;padding:40px 0">No notes yet. Open a note and use the 🔗 Link button to connect notes.</p>`
    : '';

  content.innerHTML = `
    <div class="card map-card">
      <div class="map-header">
        <div>
          <h2 style="margin:0 0 4px">Note Map</h2>
          <span class="map-stat">${connected.length} connected · ${totalLinks} link${totalLinks !== 1 ? 's' : ''} · ${orphans.length} unlinked</span>
        </div>
        <input type="text" id="mapFilter" class="map-filter-input" placeholder="Filter notes…" autocomplete="off" />
      </div>
      ${emptyMsg}
      ${treeHtml ? `<ul class="mind-map">${treeHtml}</ul>` : ''}
      ${orphanHtml}
    </div>`;

  // Click to open note
  content.querySelectorAll('[data-note]').forEach(el => {
    el.onclick = e => { e.preventDefault(); openNote(el.dataset.note); };
  });

  // Expand / collapse toggle
  content.querySelectorAll('.map-toggle').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const wrap = document.getElementById(btn.dataset.target);
      if (!wrap) return;
      const open = btn.classList.contains('map-toggle--open');
      wrap.style.display = open ? 'none' : '';
      btn.textContent   = open ? '▸' : '▾';
      btn.classList.toggle('map-toggle--open', !open);
    };
  });

  // Real-time filter
  const filterInput = document.getElementById('mapFilter');
  if (filterInput) {
    filterInput.oninput = () => {
      const q = filterInput.value.trim().toLowerCase();
      const allLi = content.querySelectorAll('.map-li');
      if (!q) {
        allLi.forEach(li => li.style.display = '');
        content.querySelectorAll('.map-children-wrap').forEach(w => w.style.display = '');
        return;
      }
      allLi.forEach(li => li.style.display = 'none');
      content.querySelectorAll('[data-note]').forEach(el => {
        const note = (db.notes || []).find(n => n.id === el.dataset.note);
        if (!note) return;
        if ((note.title + ' ' + (note.content || '')).toLowerCase().includes(q)) {
          let li = el.closest('.map-li');
          while (li) {
            li.style.display = '';
            const wrap = li.parentElement?.closest('.map-children-wrap');
            if (wrap) wrap.style.display = '';
            li = li.parentElement?.closest('.map-li');
          }
        }
      });
    };
  }
}

// --- Assistant view ---
//
// The Assistant view provides a simple chat interface that leverages your
// existing UltraNote content to answer questions. Instead of training a
// full LLM, this feature performs a lightweight keyword search across
// your notes and tasks. When you ask a question, it looks for
// overlapping words in note titles, note content, task titles and
// descriptions. It then returns a summary of matches and offers
// convenient links back into the relevant note or task. This view
// demonstrates how your personal knowledge base can power an AI‑like
// assistant without external dependencies. In future iterations you
// could replace the `assistantAnswer` function with calls to an LLM via
// services like Parallel's Task API or Hugging Face MCP servers.

// Given a natural language query, search the DB for matching notes and
// tasks based on simple keyword overlap. Returns a summary string and
// an array of source references. The summary mentions the number of
// matches and lists up to five of each type. Source objects have
// `type` ("note" or "task"), `id` and `title` fields.
/*
 * The assistant feature has been removed. If you plan to integrate
 * a personal assistant in the future, consider implementing it as
 * a separate module or application that consumes your UltraNote
 * database via an API rather than embedding assistant logic in this
 * client. Keeping the client focused on note and task management
 * makes the core application simpler and easier to maintain.
 */

// --- Link note modal ---
let _linkTargetNoteId = null;
function openLinkModal(noteId) {
  const modal = document.getElementById('linkModal');
  const select = document.getElementById('linkSelect');
  const searchInput = document.getElementById('linkSearch');
  const addBtn = document.getElementById('linkAdd');
  const cancelBtn = document.getElementById('linkCancel');
  _linkTargetNoteId = noteId;
  // Populate select with all other notes (skip system-managed pages too —
  // user shouldn't be manually linking against Research seed pages).
  const sysNbIds = new Set((db.notebooks || [])
    .filter(nb => nb.system && !nb.deletedAt).map(nb => nb.id));
  const populate = (filter='') => {
    const opts = db.notes.filter(n =>
      n.id !== noteId &&
      !n.deletedAt &&
      !sysNbIds.has(n.notebookId) &&
      n.title.toLowerCase().includes(filter.toLowerCase())
    ).map(n => `<option value="${n.id}">${htmlesc(n.title)}</option>`).join('');
    select.innerHTML = opts;
  };
  // Reset search field and populate options
  if(searchInput) searchInput.value = '';
  populate('');
  // Filter notes on input. The linkSelect is now a .fancy-select, so we
  // auto-open its popup while the user types — filtered matches appear
  // immediately without needing a second click. The data-fancy-keepopen
  // attribute stops the outside-click handler from closing the popup
  // when the user clicks back into the search box to refine the query.
  if(searchInput) {
    searchInput.setAttribute('data-fancy-keepopen', '1');
    searchInput.oninput = () => {
      populate(searchInput.value || '');
      if (typeof select.fancyOpen === 'function') select.fancyOpen();
    };
    searchInput.onkeydown = (ev) => {
      if (ev.key === 'ArrowDown' && typeof select.fancyOpen === 'function') {
        ev.preventDefault();
        select.fancyOpen();
      }
    };
  }
  modal.classList.add('show');
  // define handlers
  addBtn.onclick = () => {
    const selectedId = select.value;
    if(selectedId) {
      const note = db.notes.find(n => n.id === _linkTargetNoteId);
      if(note) {
        if(!Array.isArray(note.links)) note.links = [];
        if(!note.links.includes(selectedId)) {
          note.links.push(selectedId);
          save();
        }
      }
      modal.classList.remove('show');
      // re-render linked notes list if editor is open
      if(typeof window._renderLinkedNotes === 'function') {
        window._renderLinkedNotes();
      }
    }
  };
  cancelBtn.onclick = () => {
    modal.classList.remove('show');
  };
}

// --- Task edit modal ---
let _editingTaskId = null;
function openTaskModal(taskId) {
  const modal = document.getElementById('taskModal');
  const titleEl = document.getElementById('taskEditTitle');
  const priorityEl = document.getElementById('taskEditPriority');
  const dueEl = document.getElementById('taskEditDue');
  const descEl = document.getElementById('taskEditDesc');
  const subtaskListEl = document.getElementById('subtaskList');
  const addSubtaskBtn = document.getElementById('subtaskAdd');
  const saveBtn = document.getElementById('taskSave');
  const cancelBtn = document.getElementById('taskCancel');
  const t = db.tasks.find(x => x.id === taskId);
  if(!t) return;
  _editingTaskId = taskId;
  // Ensure subtasks array
  if(!Array.isArray(t.subtasks)) t.subtasks = [];
  // Populate fields
  titleEl.value = t.title || '';
  priorityEl.value = t.priority || 'medium';
  dueEl.value = t.due || '';
  descEl.value = t.description || '';
  // Render subtasks
  function renderSubtasks() {
    subtaskListEl.innerHTML = t.subtasks.map(sub => {
      return `<div class='row' data-subid='${sub.id}' style='gap:6px;align-items:center;'>
        <input type='checkbox' class='subtask-status' ${sub.status==='DONE'?'checked':''} style='margin-right:4px;' />
        <input type='text' class='subtask-title' value='${htmlesc(sub.title||'')}' style='flex:1;' />
        <button class='btn' data-remove-sub='${sub.id}' style='font-size:11px;'>✕</button>
      </div>`;
    }).join('');
    // Bind remove buttons
    subtaskListEl.querySelectorAll('[data-remove-sub]').forEach(btn => {
      btn.onclick = () => {
        const subId = btn.dataset.removeSub;
        t.subtasks = t.subtasks.filter(s => s.id !== subId);
        renderSubtasks();
      };
    });
  }
  renderSubtasks();
  addSubtaskBtn.onclick = () => {
    // Before adding a new subtask, sync current UI values back into t.subtasks so that
    // partially entered titles are not lost. We iterate over each row, preserving its
    // id and reading the title/status from the inputs. Without this, adding a new
    // subtask would re-render the list from the stale t.subtasks array and erase
    // unsaved titles.
    const rows = subtaskListEl.querySelectorAll('[data-subid]');
    const updatedSubs = [];
    rows.forEach(row => {
      const sid = row.dataset.subid;
      const titleVal = row.querySelector('.subtask-title').value.trim();
      const statusVal = row.querySelector('.subtask-status').checked ? 'DONE' : 'TODO';
      updatedSubs.push({ id: sid, title: titleVal, status: statusVal });
    });
    t.subtasks = updatedSubs;
    // Add a new empty subtask placeholder
    t.subtasks.push({ id: uid(), title: '', status: 'TODO' });
    renderSubtasks();
  };
  // --- Journal section: append-only audit + freeform notes ---
  const journalListEl = document.getElementById('taskJournalList');
  const journalInput  = document.getElementById('taskJournalInput');
  const journalAddBtn = document.getElementById('taskJournalAdd');
  function renderJournal() {
    if (!journalListEl) return;
    const entries = Array.isArray(t.journal) ? t.journal : [];
    if (!entries.length) {
      journalListEl.innerHTML = `<div class='muted' style='font-size:11px;'>No entries yet. Notes added when dropping or sending to backlog show up here.</div>`;
      return;
    }
    const kindIcon = { drop: '⊘', backlog: '📦', note: '✎', done: '✓', reopen: '↩' };
    const kindLabel = { drop: 'dropped', backlog: 'backlog', note: 'note', done: 'done', reopen: 'reopen' };
    journalListEl.innerHTML = entries.slice().reverse().map(e => {
      const when = (e.at || '').replace('T', ' ').slice(0, 16);
      const ic = kindIcon[e.kind] || '•';
      const lbl = kindLabel[e.kind] || (e.kind || 'note');
      return `<div style='border-left:2px solid var(--border);padding:4px 8px;margin-bottom:4px;font-size:12px;'>
        <div class='muted' style='font-size:10px;'>${ic} ${htmlesc(lbl)} · ${htmlesc(when)}</div>
        <div style='white-space:pre-wrap;'>${htmlesc(e.text || '')}</div>
      </div>`;
    }).join('');
  }
  function addJournalEntry() {
    const v = (journalInput?.value || '').trim();
    if (!v) return;
    appendTaskJournal(t.id, 'note', v);
    journalInput.value = '';
    renderJournal();
  }
  if (journalAddBtn) journalAddBtn.onclick = addJournalEntry;
  if (journalInput)  journalInput.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); addJournalEntry(); } };
  renderJournal();
  // Save handler
  saveBtn.onclick = () => {
    t.title = titleEl.value.trim();
    t.priority = priorityEl.value;
    t.due = dueEl.value ? dueEl.value : null;
    t.description = descEl.value;
    // Update subtasks from UI
    const rows = subtaskListEl.querySelectorAll('[data-subid]');
    const newSubs = [];
    rows.forEach(row => {
      const id = row.dataset.subid;
      const title = row.querySelector('.subtask-title').value.trim();
      const status = row.querySelector('.subtask-status').checked ? 'DONE' : 'TODO';
      newSubs.push({ id, title, status });
    });
    t.subtasks = newSubs;
    // Stamp updatedAt so server mergeById knows this client version is newest
    t.updatedAt = nowISO();
    // If all subtasks are done and at least one subtask exists, automatically mark the
    // parent task as DONE; otherwise set it to TODO. This optional behavior helps
    // streamline task management. If there are no subtasks, leave the status unchanged.
    if (t.subtasks.length > 0) {
      const allDone = t.subtasks.every(sub => sub.status === 'DONE');
      t.status = allDone ? 'DONE' : 'TODO';
      // record completion time if moving to DONE
      t.completedAt = allDone ? nowISO() : null;
    }
    save();
    modal.classList.remove('show');
    // Re-render relevant views
    render();
  };
  cancelBtn.onclick = () => {
    modal.classList.remove('show');
  };
  modal.classList.add('show');
}

// --- Monthly planning view ---
// Pending subtasks for the monthly creation form; persists within a view session.
let _monthlyPendingSubs = [];
let _monthlyPendingDesc = '';
function renderMonthly(){
  _monthlyPendingSubs = []; // reset on full re-render (month navigation)
  // Ensure the monthly collection exists
  if(!db.monthly) db.monthly = [];
  // Use the dedicated month selector, not selectedDailyDate, so that navigating
  // the daily calendar never changes which month the planning view shows.
  const monthKey = selectedMonthKey;
  // Build UI for monthly planning - fix timezone issue by parsing year and month separately
  const [year, month] = monthKey.split('-');
  const monthLabel = new Date(parseInt(year), parseInt(month) - 1, 1).toLocaleDateString(undefined, { month:'long', year:'numeric' });
  const currentMonthKey = todayKey().slice(0,7);
  const isCurrentMonth = monthKey === currentMonthKey;
  
  // Preserve view mode
  const preservedViewMode = localStorage.getItem('monthlyViewMode') || 'list';
  
  content.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:8px;">
        <strong>🗓️ Monthly Planning</strong>
        <div class="row" style="gap:6px;align-items:center;">
          <button id="monthPrev" class="btn" style="padding:4px 10px;font-size:14px;">◀</button>
          <span style="font-size:14px;font-weight:600;min-width:140px;text-align:center;">${htmlesc(monthLabel)}</span>
          <button id="monthNext" class="btn" style="padding:4px 10px;font-size:14px;${isCurrentMonth ? 'opacity:.4;cursor:default;' : ''}" ${isCurrentMonth ? 'disabled' : ''}>▶</button>
        </div>
        <div class="muted" style="font-size:12px;">Tasks for daily pages</div>
      </div>
      <div class="row" style="gap:8px;">
        <button id="monthlyNew" class="btn acc" style="flex:1;">＋ New Recurring Task</button>
        <button id="monthlyCopyPrev" class="btn" title="Copy tasks from previous month">Roll Over Tasks</button>
      </div>
    </div>

    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:16px;">
        <strong>Scheduled Tasks</strong>
        <div class="row" style="gap:12px;align-items:center;">
          <div class="muted" style="font-size:12px;" id="monthlyTaskCount">0 tasks</div>
          <div class="row" style="gap:6px;">
            <button id="monthlyViewGrid" class="btn" style="font-size:11px;padding:4px 8px;" title="Grid view">⊞</button>
            <button id="monthlyViewList" class="btn" style="font-size:11px;padding:4px 8px;" title="List view">☰</button>
          </div>
        </div>
      </div>
      <div id="monthlyTasksList" class="monthly-tasks-container"></div>
    </div>`;
  // Helper to render existing monthly tasks for this month
  function drawMonthlyList(){
    const listEl = document.getElementById('monthlyTasksList');
    const countEl = document.getElementById('monthlyTaskCount');
    if(!listEl) return;
    
    // Filter tasks for current month (or tasks without explicit month), excluding deleted
    const tasks = (db.monthly || []).filter(t => !t.deletedAt && (!t.month || t.month === monthKey));
    
    // Update count
    if(countEl) {
      countEl.textContent = `${tasks.length} task${tasks.length !== 1 ? 's' : ''}`;
    }
    
    // Get current view mode
    const viewMode = localStorage.getItem('monthlyViewMode') || 'list';
    listEl.className = `monthly-tasks-container ${viewMode}-view`;
    
    // Update view toggle buttons
    const gridBtn = document.getElementById('monthlyViewGrid');
    const listBtn = document.getElementById('monthlyViewList');
    if(gridBtn && listBtn) {
      gridBtn.classList.toggle('active', viewMode === 'grid');
      listBtn.classList.toggle('active', viewMode === 'list');
    }
    
    if(!tasks.length){
      // Check if any prior month has tasks — offer smart roll-over
      const priorMonths = [...new Set((db.monthly || []).filter(t => !t.deletedAt).map(t => t.month).filter(Boolean))]
        .filter(k => k < monthKey).sort();
      const lastPopulated = priorMonths.length ? priorMonths[priorMonths.length - 1] : null;
      if(lastPopulated) {
        const lastCount = (db.monthly || []).filter(t => !t.deletedAt && t.month === lastPopulated).length;
        listEl.innerHTML = `
          <div style='text-align:center;padding:32px 16px;grid-column:1/-1;'>
            <div class='muted' style='margin-bottom:12px;'>No tasks for this month yet.</div>
            <div style='margin-bottom:16px;font-size:13px;color:var(--fg);'>
              Last active month: <strong>${lastPopulated}</strong> (${lastCount} task${lastCount!==1?'s':''})
            </div>
            <button id='smartRolloverBtn' class='btn acc' style='padding:8px 20px;'>
              ↻ Roll Over ${lastCount} task${lastCount!==1?'s':''} from ${lastPopulated}
            </button>
          </div>`;
        const srBtn = document.getElementById('smartRolloverBtn');
        if(srBtn) srBtn.onclick = () => { document.getElementById('monthlyCopyPrev')?.click(); };
      } else {
        listEl.innerHTML = `<div class='muted' style='text-align:center;padding:32px 16px;grid-column:1/-1;'>No recurring tasks yet. Add one above to get started.</div>`;
      }
      return;
    }
    
    listEl.innerHTML = tasks.map(t => {
      const tDays = Array.isArray(t.days) ? t.days : [];
      const dayNames = tDays.map(d => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d]).join(', ') || 'No days';
      const dayCount = tDays.length;
      const daysSummary = dayCount === 7 ? 'Daily' : 
                         dayCount === 5 && tDays.every(d => d >= 1 && d <= 5) ? 'Weekdays' :
                         dayCount === 2 && tDays.includes(0) && tDays.includes(6) ? 'Weekends' :
                         dayCount === 2 && tDays.includes(2) && tDays.includes(4) ? 'T/TH' :
                         dayCount === 3 && tDays.includes(1) && tDays.includes(3) && tDays.includes(5) ? 'MWF' :
                         (dayNames || 'No days set');
      
      const descSnippet = t.description ? `<div class='muted' style='font-size:12px;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'>${htmlesc(t.description.slice(0,100))}${t.description.length > 100 ? '\u2026' : ''}</div>` : '';
      const subBadge = Array.isArray(t.subtasks) && t.subtasks.length ? `<span class='pill' style='margin-left:6px;font-size:10px;'>${t.subtasks.length} subtask${t.subtasks.length !== 1 ? 's' : ''}</span>` : '';
      return `
        <div class='monthly-task-item'>
          <div class='monthly-task-header'>
            <div class='monthly-task-title'>${htmlesc(t.title)}${subBadge}</div>
            <button class='monthly-task-delete' data-del='${t.id}' title='Delete recurring task'>✕</button>
          </div>
          ${descSnippet}
          <div class='monthly-task-schedule'>
            <span class='monthly-schedule-badge'>${htmlesc(daysSummary)}</span>
            <span class='muted'>${dayCount < 7 ? `${dayCount} day${dayCount !== 1 ? 's' : ''}/week` : 'Every day'}</span>
          </div>
        </div>`;
    }).join('');
    
    // Attach delete handlers with improved confirmation
    listEl.querySelectorAll('[data-del]').forEach(btn => {
      btn.onclick = () => {
        const id = btn.dataset.del;
        const task = db.monthly.find(t => t.id === id);
        if(task) {
          // Use a more styled confirmation that matches app design
          showDeleteConfirmation(task.title, () => {
            // Soft-delete: set deletedAt so the server-side merge honors the removal.
            // Hard-deleting (filtering out) fails because the server re-adds the record
            // when it merges with its own copy during POST /api/db.
            task.deletedAt = nowISO();
            task.updatedAt = nowISO();
            // Also block same-session autosync resurrection
            window._hardDeletedIds.add(id);
            persistDB(); // immediate flush — no debounce
            drawMonthlyList();
          });
        }
      };
    });
  }
  
  // Custom styled delete confirmation
  function showDeleteConfirmation(taskTitle, onConfirm) {
    // Create modal overlay
    const modal = document.createElement('div');
    modal.style.cssText = `
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      padding: 16px;
    `;
    
    modal.innerHTML = `
      <div style="
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 24px;
        max-width: 400px;
        width: 100%;
        box-shadow: 0 10px 30px rgba(0,0,0,0.3);
      ">
        <h3 style="margin: 0 0 12px 0; color: var(--fg); font-size: 16px;">Delete Recurring Task</h3>
        <p style="margin: 0 0 20px 0; color: var(--muted); line-height: 1.4;">
          Are you sure you want to delete "<strong style="color: var(--fg);">${htmlesc(taskTitle)}</strong>"? 
          This will remove it from future daily pages.
        </p>
        <div style="display: flex; gap: 12px; justify-content: flex-end;">
          <button id="cancelDelete" class="btn" style="padding: 8px 16px;">Cancel</button>
          <button id="confirmDelete" class="btn" style="padding: 8px 16px; background: #ff6b6b; border-color: #ff6b6b; color: white;">Delete</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    // Event handlers
    modal.querySelector('#cancelDelete').onclick = () => {
      document.body.removeChild(modal);
    };
    
    modal.querySelector('#confirmDelete').onclick = () => {
      document.body.removeChild(modal);
      onConfirm();
    };
    
    // Close on backdrop click
    modal.onclick = (e) => {
      if(e.target === modal) {
        document.body.removeChild(modal);
      }
    };
    
    // Close on Escape key
    const escapeHandler = (e) => {
      if(e.key === 'Escape') {
        document.body.removeChild(modal);
        document.removeEventListener('keydown', escapeHandler);
      }
    };
    document.addEventListener('keydown', escapeHandler);
  }
  
  // Custom styled validation modal for form errors
  function showValidationModal(title, message) {
    // Create modal overlay
    const modal = document.createElement('div');
    modal.style.cssText = `
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      padding: 16px;
    `;
    
    modal.innerHTML = `
      <div style="
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 24px;
        max-width: 400px;
        width: 100%;
        box-shadow: 0 10px 30px rgba(0,0,0,0.3);
      ">
        <h3 style="margin: 0 0 12px 0; color: var(--fg); font-size: 16px;">⚠️ ${htmlesc(title)}</h3>
        <p style="margin: 0 0 20px 0; color: var(--muted); line-height: 1.4;">
          ${htmlesc(message)}
        </p>
        <div style="display: flex; gap: 12px; justify-content: flex-end;">
          <button id="validationOk" class="btn acc" style="padding: 8px 16px;">OK</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    // Event handlers
    modal.querySelector('#validationOk').onclick = () => {
      document.body.removeChild(modal);
    };
    
    // Close on backdrop click
    modal.onclick = (e) => {
      if(e.target === modal) {
        document.body.removeChild(modal);
      }
    };
    
    // Close on Escape key
    const escapeHandler = (e) => {
      if(e.key === 'Escape') {
        document.body.removeChild(modal);
        document.removeEventListener('keydown', escapeHandler);
      }
    };
    document.addEventListener('keydown', escapeHandler);
    
    // Auto-focus the OK button
    setTimeout(() => {
      modal.querySelector('#validationOk').focus();
    }, 100);
  }

  // New monthly task creation modal
  function openMonthlyCreateModal() {
    let localDesc = '';
    let localSubs = [];

    const DAYS_CFG = [
      { label: 'Mon', value: '1' }, { label: 'Tue', value: '2' }, { label: 'Wed', value: '3' },
      { label: 'Thu', value: '4' }, { label: 'Fri', value: '5' }, { label: 'Sat', value: '6' }, { label: 'Sun', value: '0' }
    ];
    const QUICK = [
      { label: 'Daily',    days: ['1','2','3','4','5','6','0'] },
      { label: 'Weekdays', days: ['1','2','3','4','5'] },
      { label: 'Weekends', days: ['6','0'] },
      { label: 'MWF',      days: ['1','3','5'] },
      { label: 'T\u2013Th',  days: ['2','4'] }
    ];

    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px;';

    const syncSubs = () => {
      modal.querySelectorAll('[data-cm-id]').forEach(row => {
        const s = localSubs.find(x => x.id === row.dataset.cmId);
        if(s) s.title = row.querySelector('.cm-stitle')?.value.trim() || '';
      });
    };

    const renderSubsHtml = () => localSubs.map(s => `
      <div class="row" data-cm-id="${s.id}" style="gap:6px;align-items:center;margin-bottom:6px;">
        <input type="text" class="cm-stitle" value="${htmlesc(s.title)}" placeholder="Subtask title\u2026" style="flex:1;" />
        <button class="btn" data-cm-remove="${s.id}" style="font-size:11px;padding:4px 8px;">\u2715</button>
      </div>`).join('');

    const buildInner = (savedTitle, savedDesc, checkedDays) => `
      <div class="sketchInner" style="max-width:480px;width:100%;max-height:88vh;overflow-y:auto;padding:24px;">
        <h3 style="margin-top:0;">New Recurring Task</h3>
        <div class="list" style="gap:10px;">
          <label>Task Name
            <input id="cmTitle" type="text" placeholder="e.g. Morning Standup" autocomplete="off" value="${htmlesc(savedTitle||'')}" />
          </label>
          <div>
            <div style="font-size:13px;color:var(--muted);margin-bottom:6px;">Repeat on</div>
            <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:6px;">
              ${DAYS_CFG.map(d => `<label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:13px;">
                <input type="checkbox" class="cm-day" value="${d.value}" ${(checkedDays||[]).includes(d.value)?'checked':''} />${d.label}
              </label>`).join('')}
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:5px;">
              ${QUICK.map(q => `<button type="button" class="btn cm-quick" data-days="${q.days.join(',')}" style="font-size:11px;padding:3px 8px;">${q.label}</button>`).join('')}
            </div>
          </div>
          <label>Description
            <textarea id="cmDesc" style="min-height:60px;resize:vertical;" placeholder="Optional notes\u2026">${htmlesc(savedDesc||'')}</textarea>
          </label>
          <div>
            <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:6px;">
              <span style="font-size:13px;color:var(--muted);">Subtasks</span>
              <button type="button" id="cmAddSub" class="btn" style="font-size:11px;padding:4px 9px;">+ Add</button>
            </div>
            <div id="cmSubList">${renderSubsHtml()}</div>
          </div>
        </div>
        <div class="row" style="justify-content:flex-end;gap:8px;margin-top:16px;">
          <button id="cmSave" class="btn acc">Save</button>
          <button id="cmCancel" class="btn">Cancel</button>
        </div>
      </div>`;

    // Block autosync re-render while the modal is open
    window._isTypingInForm = true;
    window.__typingUntil = Date.now() + 60 * 60 * 1000; // 1 hour ceiling — reset on close

    const close = () => {
      window._isTypingInForm = false;
      window.__typingUntil = 0;
      if(document.body.contains(modal)) document.body.removeChild(modal);
    };

    const rerender = () => {
      const savedTitle = modal.querySelector('#cmTitle')?.value || '';
      const savedDesc  = modal.querySelector('#cmDesc')?.value || '';
      const checkedDays = Array.from(modal.querySelectorAll('.cm-day:checked')).map(c => c.value);
      syncSubs();
      modal.innerHTML = buildInner(savedTitle, savedDesc, checkedDays);
      bindModal();
      const inputs = modal.querySelectorAll('.cm-stitle');
      if(inputs.length) inputs[inputs.length - 1].focus();
    };

    const bindModal = () => {
      modal.querySelector('#cmCancel').onclick = close;

      modal.querySelectorAll('.cm-quick').forEach(btn => {
        btn.onclick = () => {
          const days = btn.dataset.days.split(',');
          modal.querySelectorAll('.cm-day').forEach(cb => { cb.checked = days.includes(cb.value); });
        };
      });

      modal.querySelector('#cmAddSub').onclick = () => {
        syncSubs();
        localSubs.push({ id: uid(), title: '' });
        rerender();
      };

      modal.querySelectorAll('[data-cm-remove]').forEach(btn => {
        btn.onclick = () => {
          syncSubs();
          localSubs = localSubs.filter(s => s.id !== btn.dataset.cmRemove);
          rerender();
        };
      });

      modal.querySelector('#cmTitle').onkeydown = (e) => {
        if(e.key === 'Enter') { e.preventDefault(); modal.querySelector('#cmSave')?.click(); }
      };

      modal.querySelector('#cmSave').onclick = () => {
        const titleEl = modal.querySelector('#cmTitle');
        const title = titleEl?.value.trim() || '';
        if(!title) {
          titleEl?.focus();
          if(titleEl) { titleEl.style.outline = '2px solid #ff6b6b'; setTimeout(() => { titleEl.style.outline = ''; }, 2000); }
          return;
        }
        const days = Array.from(modal.querySelectorAll('.cm-day:checked')).map(cb => parseInt(cb.value, 10)).filter(d => !isNaN(d));
        if(!days.length) {
          showValidationModal('Select Days Required', 'Please select at least one day of the week for this recurring task.');
          return;
        }
        // Ghost-cleanup: soft-delete any existing non-deleted task with same title+month
        (db.monthly || []).forEach(t => {
          if(!t.deletedAt && t.month === monthKey && t.title.toLowerCase() === title.toLowerCase()) {
            t.deletedAt = nowISO();
            t.updatedAt = nowISO();
            if(window._hardDeletedIds) window._hardDeletedIds.add(t.id);
          }
        });
        syncSubs();
        const description = modal.querySelector('#cmDesc')?.value.trim() || '';
        const subtasks = localSubs.filter(s => s.title).map(s => ({ id: uid(), title: s.title, status: 'TODO' }));
        db.monthly.push({ id: uid(), title, days, month: monthKey,
          type: 'monthly_task', description, subtasks, tags: [],
          createdAt: nowISO(), updatedAt: nowISO() });
        close();
        // Immediately inject into any existing daily notes that match this task's schedule
        const todayStr = todayKey();
        const todayNote = db.notes.find(n => n.type === 'daily' && n.dateIndex === todayStr && !n.deletedAt);
        if(todayNote) syncMonthlyTasksToDaily(todayNote, todayStr);
        save();
        drawMonthlyList();
      };

      modal.onclick = (e) => { if(e.target === modal) close(); };
      const esc = (e) => { if(e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } };
      document.addEventListener('keydown', esc);
    };

    modal.innerHTML = buildInner('', '', []);
    document.body.appendChild(modal);
    bindModal();
    setTimeout(() => modal.querySelector('#cmTitle')?.focus(), 50);
  }

  // View mode toggle handlers
  function setupViewToggle() {
    const gridBtn = document.getElementById('monthlyViewGrid');
    const listBtn = document.getElementById('monthlyViewList');
    
    if(gridBtn) {
      gridBtn.onclick = () => {
        localStorage.setItem('monthlyViewMode', 'grid');
        drawMonthlyList();
      };
    }
    
    if(listBtn) {
      listBtn.onclick = () => {
        localStorage.setItem('monthlyViewMode', 'list');
        drawMonthlyList();
      };
    }
  }

  // Wire up the New Recurring Task button
  const newTaskBtn = document.getElementById('monthlyNew');
  if(newTaskBtn) newTaskBtn.onclick = openMonthlyCreateModal;



  // Copy tasks from previous month handler
  const copyPrevBtn = document.getElementById('monthlyCopyPrev');
  if(copyPrevBtn) {
    copyPrevBtn.onclick = async () => {
      // Find the most recently populated month that is strictly before the current monthKey.
      // This handles gaps (e.g. last data was Oct 2025, current view is Feb 2026).
      const allMonthsWithTasks = [...new Set((db.monthly || [])
        .filter(t => !t.deletedAt).map(t => t.month).filter(Boolean))]
        .filter(k => k < monthKey)
        .sort();
      const prevKey = allMonthsWithTasks.length ? allMonthsWithTasks[allMonthsWithTasks.length - 1] : null;
      // Find tasks from the most recent prior month (exclude deleted)
      const prevTasks = prevKey ? (db.monthly || []).filter(t => !t.deletedAt && t.month === prevKey) : [];
      if (!prevTasks.length) {
        showValidationModal('No Tasks to Roll Over', `No tasks found in any previous month. Add tasks to a prior month first, or navigate back to it.`);
        return;
      }
      const ok = await showConfirm(`Copy ${prevTasks.length} task${prevTasks.length !== 1 ? 's' : ''} from ${prevKey} into ${monthKey}?`, 'Roll Over', 'Cancel');
      if (!ok) return;
      let added = 0;
      prevTasks.forEach(t => {
        // Skip tasks that already exist in the current month (same title + days).
        const exists = (db.monthly || []).some(x => x.month === monthKey && x.title === t.title && JSON.stringify(x.days || []) === JSON.stringify(t.days || []));
        if (!exists) {
          db.monthly.push({ id: uid(), title: t.title, days: Array.isArray(t.days) ? [...t.days] : [],
            month: monthKey, type: 'monthly_task',
            description: t.description || '',
            subtasks: Array.isArray(t.subtasks) ? t.subtasks.map(s => ({ id: uid(), title: s.title, status: 'TODO' })) : [],
            tags: [],
            createdAt: nowISO(), updatedAt: nowISO() });
          added++;
        }
      });
      if (added) {
        save();
        drawMonthlyList();
      }
    };
  }
  
  setupViewToggle();
  
  // Month navigation handlers
  const monthPrevBtn = document.getElementById('monthPrev');
  const monthNextBtn = document.getElementById('monthNext');
  if(monthPrevBtn) {
    monthPrevBtn.onclick = () => {
      const [y, m] = selectedMonthKey.split('-').map(Number);
      const d = new Date(y, m - 1 - 1, 1); // one month back
      selectedMonthKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      renderMonthly();
    };
  }
  if(monthNextBtn) {
    monthNextBtn.onclick = () => {
      const currentMonthKey = todayKey().slice(0, 7);
      if(selectedMonthKey >= currentMonthKey) return; // can't go past current month
      const [y, m] = selectedMonthKey.split('-').map(Number);
      const d = new Date(y, m - 1 + 1, 1); // one month forward
      selectedMonthKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      renderMonthly();
    };
  }
  
  // Initial render
  drawMonthlyList();
}

// --- Added: Vault & Links views (previously missing) ---
function renderVault(){
  const query = (document.getElementById('q')?.value || '').trim();
  const tagFilters = (query.match(/#[\w-]+/g)||[]).map(t=>t.slice(1).toLowerCase());
  const text = query.replace(/#[\w-]+/g,'').trim().toLowerCase();
  const sysNbIds = new Set((db.notebooks || [])
    .filter(nb => nb.system && !nb.deletedAt).map(nb => nb.id));
  // Hide system-managed notes (Research module pages) — they're searchable
  // from inside the Research dashboard. Mixing them into the general Vault
  // makes the workspace feel cluttered with rows the user didn't create.
  let notes = db.notes.filter(n => !n.deletedAt && !sysNbIds.has(n.notebookId));
  if(tagFilters.length){ notes = notes.filter(n=> tagFilters.every(t=> (n.tags||[]).map(x=>x.toLowerCase()).includes(t))); }
  if(text){ notes = notes.filter(n=> n.title.toLowerCase().includes(text) || (n.content||'').toLowerCase().includes(text)); }
  // NEW: status filter — set by clicking a chip in the toolbar. Persists across re-renders.
  const sFilter = window._vaultStatusFilter || '';
  if(sFilter) notes = notes.filter(n => (n.status || '') === sFilter);
  notes.sort((a,b)=> (b.pinned?1:0)-(a.pinned?1:0) || b.updatedAt.localeCompare(a.updatedAt));
  const pinned = notes.filter(n=> n.pinned);
  const others = notes.filter(n=> !n.pinned);
  // NEW: cross-collection search (links, projects, tasks)
  let linkMatches = [];
  let projectMatches = [];
  let taskMatches = [];
  if(query){
    // Links: filter by tag filters (tags array) and text in title or URL
    linkMatches = db.links.filter(l=>{
      if(l.deletedAt) return false;
      if(tagFilters.length && !tagFilters.every(t=> (l.tags||[]).map(x=>x.toLowerCase()).includes(t))) return false;
      if(text && !((l.title||'').toLowerCase().includes(text) || (l.url||'').toLowerCase().includes(text))) return false;
      return true;
    }).sort((a,b)=> (b.pinned?1:0)-(a.pinned?1:0) || b.updatedAt.localeCompare(a.updatedAt));
    // Projects: only text filter (projects have no tags yet)
    if(text && !tagFilters.length){
      projectMatches = db.projects.filter(p=> !p.deletedAt && p.name.toLowerCase().includes(text));
    }
    // Tasks: only if no tag filters (tasks have no tags); search title
    // Skip deleted/tombstoned tasks — they may have had their title cleared.
    if(text && !tagFilters.length){
      taskMatches = db.tasks.filter(t=> !t.deletedAt && (t.title||'').toLowerCase().includes(text)).slice(0,50); // cap to avoid huge lists
    }
  }
  const highlight = (s)=>{ if(!text) return htmlesc(s); return htmlesc(s).replace(new RegExp(text.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&'),'ig'), m=>`<mark style='background:#3a2a5a;color:inherit;'>${m}</mark>`); };
  content.innerHTML = `
    <div class='card'>
      <div class='row' style='justify-content:space-between;flex-wrap:wrap;gap:8px;'>
        <strong>🔍 Vault (Global Search)</strong>
        <div class='muted' style='font-size:12px;'>${notes.length} note result${notes.length!==1?'s':''}${query? ' for "'+htmlesc(query)+'"':''}</div>
      </div>
      <div class='row' style='margin-top:8px;gap:8px;flex-wrap:wrap;'>
        <button id='newNote' class='btn acc' style='font-size:12px;'>New Note</button>
        <button id='sortRecent' class='btn' style='font-size:12px;'>Recent</button>
        <button id='sortAZ' class='btn' style='font-size:12px;'>A-Z</button>
        ${query? `<span class='muted' style='font-size:11px;'>Also searched: ${linkMatches.length} links, ${projectMatches.length} projects, ${taskMatches.length} tasks</span>`:''}
      </div>
      <div class='row' style='margin-top:8px;gap:6px;flex-wrap:wrap;align-items:center;'>
        <span class='muted' style='font-size:11px;'>Status:</span>
        ${[
          {v:'',          l:'All'},
          {v:'inbox',     l:'📥 Inbox'},
          {v:'reading',   l:'📖 Reading'},
          {v:'read',      l:'✅ Read'},
          {v:'annotated', l:'✍️ Annotated'},
          {v:'followup',  l:'🔁 Follow up'},
          {v:'archive',   l:'🗄️ Archived'},
        ].map(o => {
          const count = o.v
            ? db.notes.filter(n => !n.deletedAt && (n.status||'') === o.v).length
            : db.notes.filter(n => !n.deletedAt).length;
          const active = sFilter === o.v;
          return `<button class='btn${active?' acc':''}' data-status-filter='${o.v}'
                   style='font-size:11px;padding:3px 9px;'>${o.l} (${count})</button>`;
        }).join('')}
      </div>
      ${tagFilters.length? `<div style='margin-top:8px;'>${tagFilters.map(t=>`<span class='pill'>#${htmlesc(t)}</span>`).join('')}</div>`:''}
    </div>
    ${pinned.length? `<div class='card'><strong style='font-size:14px;'>📌 Pinned Notes</strong><div class='list' style='margin-top:8px;'>${pinned.map(n=> noteRow(n,true)).join('')}</div></div>`:''}
    <div class='card'>
      <strong style='font-size:14px;'>${pinned.length? 'Other Notes':'Notes'}</strong>
      <div class='list' style='margin-top:8px;'>${others.map(n=> noteRow(n,false)).join('') || '<div class="muted">No notes</div>'}</div>
    </div>
    ${query && linkMatches.length? `<div class='card'>
      <strong style='font-size:14px;'>🔗 Links (${linkMatches.length})</strong>
      <div class='list' style='margin-top:8px;'>${linkMatches.map(l=>`<div class='card' style='padding:10px;'>
        <div class='row' style='justify-content:space-between;'>
          <span style='flex:1;overflow:hidden;text-overflow:ellipsis;'>${l.pinned?'📌 ':''}<a href='${htmlesc(l.url)}' data-open-link='${htmlesc(l.url)}' target='_blank' rel='noopener' style='color:var(--acc);text-decoration:none;'>${highlight(l.title||l.url)}</a></span>
          <div class='row' style='gap:6px;'>
            <button class='btn' data-pin-link='${l.id}' style='font-size:11px;'>${l.pinned?'Unpin':'Pin'}</button>
          </div>
        </div>
        ${(l.tags&&l.tags.length)?`<div style='margin-top:4px;'>${l.tags.map(t=>`<span class='pill' data-tag='${t}'>#${htmlesc(t)}</span>`).join(' ')}</div>`:''}
      </div>`).join('')}</div>
    </div>`:''}
    ${query && projectMatches.length? `<div class='card'>
      <strong style='font-size:14px;'>📁 Projects (${projectMatches.length})</strong>
      <div class='list' style='margin-top:8px;'>${projectMatches.map(p=>`<div class='card' style='padding:10px;'><div class='row' style='justify-content:space-between;'>
        <span data-open-project='${p.id}' style='cursor:pointer;'>${highlight(p.name)}</span>
        <button class='btn' data-open-project='${p.id}' style='font-size:11px;'>Open</button>
      </div></div>`).join('')}</div>
    </div>`:''}
    ${query && taskMatches.length? `<div class='card'>
      <strong style='font-size:14px;'>✅ Tasks (${taskMatches.length})</strong>
      <div class='list' style='margin-top:8px;'>${taskMatches.map(t=>{ const note=t.noteId? db.notes.find(n=>n.id===t.noteId):null; const proj=t.projectId? db.projects.find(p=>p.id===t.projectId):null; return `<div class='card' style='padding:8px;'>
        <div class='row' style='justify-content:space-between;'>
          <span>${highlight(t.title)} ${(note&&note.type==='daily')?`<span class='pill'>${note.dateIndex}</span>`:''} ${proj?`<span class='pill'>${htmlesc(proj.name)}</span>`:''}</span>
          <div class='row' style='gap:4px;'>
            ${note?`<button class='btn' data-open='${note.id}' style='font-size:11px;'>Note</button>`:''}
            ${proj?`<button class='btn' data-open-project='${proj.id}' style='font-size:11px;'>Project</button>`:''}
          </div>
        </div>
      </div>`; }).join('')}</div>
    </div>`:''}`;
  function noteRow(n,isPinned){
    const preview = (n.content||'').slice(0,140).replace(/\n/g,' ');
    return `<div class='card' style='padding:10px;'>
      <div class='row' style='justify-content:space-between;'>
        <span style='cursor:pointer;' data-open='${n.id}'>${highlight(n.title)}${n.type==='daily'?` <span class='pill'>${n.dateIndex||''}</span>`:''}${n.type==='idea'?` <span class='pill'>idea</span>`:''}${statusBadge(n.status)}</span>
        <div class='row' style='gap:6px;'>
          <button class='btn' data-pin='${n.id}' style='font-size:11px;'>${isPinned?'Unpin':'Pin'}</button>
          <button class='btn' data-open='${n.id}' style='font-size:11px;'>Open</button>
          <button class='btn' data-del='${n.id}' style='font-size:11px;'>✕</button>
        </div>
      </div>
      ${preview?`<div class='muted' style='margin-top:4px;font-size:11px;'>${highlight(preview)}</div>`:''}
      ${(n.tags&&n.tags.length)?`<div style='margin-top:4px;'>${n.tags.map(t=>`<span class='pill' data-tag='${t}'>#${htmlesc(t)}</span>`).join(' ')}</div>`:''}
    </div>`;
  }
  content.querySelectorAll('[data-status-filter]').forEach(b => b.onclick = () => {
    window._vaultStatusFilter = b.dataset.statusFilter || '';
    renderVault();
  });
  content.querySelectorAll('[data-open]').forEach(b=> b.onclick=()=> openNote(b.dataset.open));
  content.querySelectorAll('[data-pin]').forEach(b=> b.onclick=()=>{ const note=db.notes.find(x=>x.id===b.dataset.pin); if(note){ note.pinned=!note.pinned; save(); renderVault(); } });
  content.querySelectorAll('[data-tag]').forEach(b=> b.onclick=()=>{ document.getElementById('q').value='#'+b.dataset.tag; renderVault(); });
  content.querySelectorAll('[data-del]').forEach(b=> b.onclick=async ()=>{
    const note = db.notes.find(x=> x.id === b.dataset.del);
    if(!note) return;
    const taskCount = db.tasks.filter(t=> t.noteId === note.id && !t.deletedAt).length;
    const taskNote = taskCount ? ` Its ${taskCount} task${taskCount!==1?'s':''} will be moved to Trash and can be restored.` : '';
    const msg = `Delete note "${note.title}"${note.type==='daily'?' (daily)':''}?${taskNote}`;
    const ok = await showConfirm(msg, 'Delete', 'Cancel');
    if(!ok) return;
    softDeleteNote(note.id);
    renderVault();
  });
  // NEW event bindings for links / projects
  content.querySelectorAll('[data-open-link]').forEach(b=> b.onclick=()=> window.open(b.dataset.openLink,'_blank'));
  content.querySelectorAll('[data-pin-link]').forEach(b=> b.onclick=()=>{ const l=db.links.find(x=>x.id===b.dataset.pinLink); if(l){ l.pinned=!l.pinned; save(); renderVault(); }});
  content.querySelectorAll('[data-open-project]').forEach(b=> b.onclick=()=>{ _navPush(); currentProjectId=b.dataset.openProject; route='projects'; render(); });
  document.getElementById('newNote').onclick = ()=> openDraftNote({});
  document.getElementById('sortAZ').onclick = ()=>{ document.getElementById('q').value=''; notes.sort((a,b)=> a.title.localeCompare(b.title)); renderVault(); };
  document.getElementById('sortRecent').onclick = ()=>{ document.getElementById('q').value=''; notes.sort((a,b)=> b.updatedAt.localeCompare(a.updatedAt)); renderVault(); };
}

// --- Shared "Reference Prompts" card (immutable, read-only) ---
// Surfaces db.agentPrompts entries — used by both the Notebooks tool and the
// Projects tool, since some entries (e.g. the Coding-Agent API Guide) are
// most useful from Projects, while others (e.g. the lecture-agent prompt)
// are more general. Kept as one shared card + wiring so both call sites
// stay in sync automatically as new entries are added.
// `scope` filters which entries show here — each entry declares the single
// tool it's intuitively tied to via its own `scope` field (e.g. 'projects'
// for the Coding-Agent API Guide, 'notebooks' for the lecture-agent prompt),
// so a prompt about managing *projects* only ever shows up in the Projects
// tool, not duplicated into Notebooks (and vice versa).
function renderReferencePromptsCard(scope){
  const prompts=(db.agentPrompts||[]).filter(p=>!scope || p.scope===scope);
  if(!prompts.length) return '';
  return `<div class='card' style='margin-bottom:14px;border-style:dashed;'>
      <div class='row' style='justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;'>
        <strong style='font-size:14px;'>\ud83d\udccc Reference Prompts</strong>
        <span class='muted' style='font-size:11px;'>Built-in &middot; password to edit</span>
      </div>
      <div class='muted' style='font-size:12px;margin-top:4px;'>
        Copy-paste system prompts / guides for external AI agents. Locked by default — enter the app password to edit.
      </div>
      <div style='margin-top:10px;display:flex;flex-direction:column;gap:8px;'>
        ${prompts.map(p=>`
          <div style='border:1px dashed var(--btn-border);border-radius:8px;padding:10px 12px;
                      display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;'>
            <div style='flex:1;min-width:0;'>
              <strong style='font-size:13px;word-break:break-word;'>\ud83d\udd12 ${htmlesc(p.title)}</strong>
              ${p.description?`<div class='muted' style='font-size:11px;margin-top:2px;'>${htmlesc(p.description)}</div>`:''}
            </div>
            <div class='row' style='gap:6px;flex-shrink:0;'>
              <button class='btn' data-view-prompt='${p.id}' style='font-size:12px;'>View</button>
              <button class='btn' data-copy-prompt='${p.id}' style='font-size:12px;'>Copy</button>
              <button class='btn' data-edit-prompt='${p.id}' style='font-size:12px;' title='Requires app password'>\ud83d\udd11 Edit</button>
            </div>
          </div>`).join('')}
      </div>
    </div>`;
}

// Fetch the text content for an agentPrompts entry. Entries either carry
// `content` inline (e.g. the lecture-agent prompt) or point at a static file
// on disk via `sourceFile` (e.g. AGENT_GUIDE.md, served by express.static),
// which is fetched fresh each time so the in-app copy never drifts out of
// sync with whatever is actually on disk.
async function getPromptContent(p){
  if(p.content) return p.content;
  if(p.sourceFile){
    const res=await fetch('/'+p.sourceFile.replace(/^\/+/, ''));
    if(!res.ok) throw new Error('Failed to load '+p.sourceFile+' ('+res.status+')');
    return await res.text();
  }
  return '';
}

// Wire up the View/Copy/Edit buttons rendered by renderReferencePromptsCard()
// within the given root element (defaults to the global #content).
// Copy `text` to the clipboard, robust to environments where the async
// Clipboard API silently fails (e.g. "NotAllowedError: Document is not
// focused", which can fire even from a genuine click depending on focus
// timing) — falls back to the classic hidden-textarea + execCommand('copy')
// approach, which doesn't have the same focus requirement. Returns true only
// if a copy method actually reported success, so callers can show accurate
// success/failure feedback instead of silently leaving the old clipboard
// contents in place (which looked like "it copied the wrong thing").
async function copyTextToClipboard(text){
  try{
    await navigator.clipboard.writeText(text);
    return true;
  }catch(_){
    try{
      const ta=document.createElement('textarea');
      ta.value=text;
      ta.setAttribute('readonly','');
      ta.style.position='fixed';
      ta.style.top='0';
      ta.style.left='-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok=document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    }catch(_e){
      return false;
    }
  }
}

function wireReferencePromptsCard(root){
  const scope = root || content;
  scope.querySelectorAll('[data-view-prompt]').forEach(b=>b.onclick=async()=>{
    const p=(db.agentPrompts||[]).find(x=>x.id===b.dataset.viewPrompt);
    if(p) showPromptViewer(p);
  });
  scope.querySelectorAll('[data-copy-prompt]').forEach(b=>b.onclick=async()=>{
    const p=(db.agentPrompts||[]).find(x=>x.id===b.dataset.copyPrompt);
    if(!p) return;
    const orig=b.textContent;
    try{
      const txt=await getPromptContent(p);
      const ok=await copyTextToClipboard(txt);
      b.textContent = ok ? 'Copied ✓' : 'Copy failed';
    }catch(_){
      b.textContent='Copy failed';
    }
    setTimeout(()=>{ b.textContent=orig; },1500);
  });
  scope.querySelectorAll('[data-edit-prompt]').forEach(b=>b.onclick=async()=>{
    const p=(db.agentPrompts||[]).find(x=>x.id===b.dataset.editPrompt);
    if(p) unlockAndEditPrompt(p);
  });
}

// Prompt for the app password, verify it against the server, and on success
// open the editor for `p`. This is the entry point for the 🔑 Edit button.
async function unlockAndEditPrompt(p){
  const pw = await showPasswordPrompt('Enter the app password to edit "'+p.title+'":');
  if(pw === null) return; // cancelled
  if(!pw){ await showConfirm('Password cannot be empty.', 'OK', 'OK'); return; }
  const { ok, error } = await verifyAppPassword(pw);
  if(!ok){
    await showConfirm('❌ ' + (error || 'Incorrect password') , 'OK', 'OK');
    return;
  }
  showPromptEditor(p);
}

// --- Notebooks view ---
function renderNotebooks(){
  if(!db.notebooks) db.notebooks=[];
  // Hide system-managed / feature-owned notebooks from the generic list —
  // they're surfaced by their own dedicated tools (🔬 Research, 👥 People)
  // and would just look like duplicates here. The People container uses a
  // {name, emoji} schema instead of {title}, so it has no `title` field;
  // listing it would also crash htmlesc(nb.title). Guard against any other
  // title-less record the same way.
  const nbs=db.notebooks
    .filter(nb=>!nb.deletedAt && !nb.system && nb.name!=='People' && nb.title)
    .sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||''));
  content.innerHTML=`
    ${renderReferencePromptsCard('notebooks')}
    <div class='card'>
      <div class='row' style='justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;'>
        <strong style='font-size:16px;'>\ud83d\udcd3 Notebooks</strong>
        <button id='newNotebook' class='btn acc'>+ New Notebook</button>
      </div>
      ${nbs.length===0?`<div class='muted' style='margin-top:20px;text-align:center;font-size:14px;'>No notebooks yet — create one to start building your knowledge base.</div>`:''}
      <div style='margin-top:14px;display:flex;flex-direction:column;gap:10px;'>
        ${nbs.map(nb=>{
          const pages=getNotebookPages(nb.id);
          const updated=(nb.updatedAt||nb.createdAt||'').slice(0,10);
          return `<div class='nb-card' data-open-nb='${nb.id}'
            style='border:1px solid var(--btn-border);border-left:3px solid var(--acc);border-radius:8px;
                   padding:14px;cursor:pointer;background:var(--card-bg);transition:opacity 0.15s;'>
            <div class='row' style='justify-content:space-between;align-items:flex-start;gap:8px;'>
              <div style='flex:1;min-width:0;'>
                <strong style='font-size:15px;word-break:break-word;'>${htmlesc(nb.title||'Untitled')}</strong>
                ${nb.description?`<div class='muted' style='font-size:12px;margin-top:3px;'>${htmlesc(nb.description)}</div>`:''}
                <div class='muted' style='font-size:11px;margin-top:5px;'>
                  ${pages.length} page${pages.length!==1?'s':''}${updated?` &nbsp;&middot;&nbsp; Updated ${updated}`:''}
                </div>
              </div>
              <div class='row' style='gap:6px;flex-shrink:0;' onclick='event.stopPropagation()'>
                <button class='btn' data-rename-nb='${nb.id}' style='font-size:12px;'>Rename</button>
                <button class='btn' style='border-color:#ff6b6b;color:#ff6b6b;font-size:12px;' data-delete-nb='${nb.id}'>Delete</button>
              </div>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  document.getElementById('newNotebook').onclick=async()=>{
    const title=await showPrompt('Notebook title:','New Notebook');
    if(!title||!title.trim()) return;
    const desc=await showPrompt('Description (optional):','');
    const nb=createNotebook({title:title.trim(), description:(desc||'').trim()});
    // Push nav state BEFORE entering the new notebook's detail view — same as
    // the data-open-nb click handler below — so "← All" correctly pops back
    // to this notebooks list instead of whatever view was open before the
    // Notebooks tool itself was opened (the bug: without this push, the nav
    // stack's top entry was stale/unrelated, so Back landed somewhere wrong).
    _navPush();
    currentNotebookId=nb.id; currentPageId=null;
    renderNotebookDetail(nb.id);
  };
  wireReferencePromptsCard();
  content.querySelectorAll('[data-open-nb]').forEach(el=>{
    el.onclick=()=>{ _navPush(); currentNotebookId=el.dataset.openNb; renderNotebookDetail(el.dataset.openNb); };
  });
  content.querySelectorAll('[data-rename-nb]').forEach(b=>b.onclick=async()=>{
    const nb=db.notebooks.find(x=>x.id===b.dataset.renameNb); if(!nb) return;
    const t=await showPrompt('New title:',nb.title); if(!t||!t.trim()) return;
    const d=await showPrompt('Description:',nb.description||'');
    updateNotebook(nb.id,{title:t.trim(), description:(d||'').trim()}); renderNotebooks();
  });
  content.querySelectorAll('[data-delete-nb]').forEach(b=>b.onclick=async()=>{
    const nb=db.notebooks.find(x=>x.id===b.dataset.deleteNb); if(!nb) return;
    const pages=getNotebookPages(nb.id);
    const ok=await showConfirm(
      `Delete notebook "${nb.title}"? ${pages.length} page${pages.length!==1?'s':''} will be moved to Trash.`,
      'Delete','Cancel');
    if(!ok) return;
    deleteNotebook(nb.id);
    if(currentNotebookId===nb.id){ currentNotebookId=null; currentPageId=null; }
    renderNotebooks();
  });
}

// Read-only viewer for a built-in "agentPrompts" entry — rendered markdown
// preview plus a one-click "Copy to clipboard" button. Deliberately has no
// edit affordances: this content is immutable, fixed reference material.
// Content is loaded async via getPromptContent() since `sourceFile`-backed
// entries fetch from disk rather than being embedded inline.
async function showPromptViewer(p){
  const overlay=document.createElement('div');
  overlay.className='modal-overlay';
  const modal=document.createElement('div');
  modal.className='modal';
  modal.style.maxWidth='720px';
  modal.style.width='90vw';
  modal.innerHTML=`
    <div class="modal-body" style="text-align:left;">
      <div class='row' style='justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px;'>
        <strong style='font-size:15px;'>🔒 ${htmlesc(p.title)}</strong>
        <span class='muted' style='font-size:11px;white-space:nowrap;'>Read-only</span>
      </div>
      <div class='markdown-preview' id='promptViewerPreview'
           style='max-height:55vh;overflow-y:auto;border:1px solid var(--btn-border);border-radius:6px;padding:12px;text-align:left;'>
           <div class='muted'>Loading…</div></div>
    </div>
    <div class="modal-footer">
      <button class="btn" id="modalCancel">Close</button>
      <button class="btn acc" id="modalOk" disabled>Copy to clipboard</button>
    </div>`;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  modal.querySelector('#modalCancel').onclick=()=>{ if(document.body.contains(overlay)) document.body.removeChild(overlay); };
  const previewEl=modal.querySelector('#promptViewerPreview');
  let text='';
  try{
    text=await getPromptContent(p);
  }catch(err){
    previewEl.innerHTML=`<div style='color:#ff6b6b;'>Failed to load content: ${htmlesc(err.message)}</div>`;
    return;
  }
  if(!document.body.contains(overlay)) return; // closed while loading
  previewEl.innerHTML=markdownToHtml(text);
  if(typeof _processMermaid==='function') _processMermaid(previewEl);
  const okBtn=modal.querySelector('#modalOk');
  okBtn.disabled=false;
  okBtn.onclick=async()=>{
    const ok=await copyTextToClipboard(text);
    okBtn.textContent = ok ? 'Copied ✓' : 'Copy failed';
    setTimeout(()=>{ if(document.body.contains(overlay)) okBtn.textContent='Copy to clipboard'; },1200);
  };
}

// Editor for an agentPrompts entry — only reachable after unlockAndEditPrompt()
// re-verifies the app password. Persists via two different paths depending
// on how the entry stores its text:
//  - `content`-backed entries (e.g. lecture-agent prompt): update the field
//    directly on the db.agentPrompts record and go through the normal
//    save()/persistDB() pipeline, same as any other note edit.
//  - `sourceFile`-backed entries (e.g. AGENT_GUIDE.md): write straight back
//    to that file on disk via POST /api/agent-prompt-file, so the file
//    stays the single source of truth and the in-app copy never drifts.
async function showPromptEditor(p){
  const overlay=document.createElement('div');
  overlay.className='modal-overlay';
  const modal=document.createElement('div');
  modal.className='modal';
  modal.style.maxWidth='760px';
  modal.style.width='92vw';
  modal.innerHTML=`
    <div class="modal-body" style="text-align:left;">
      <div class='row' style='justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px;'>
        <strong style='font-size:15px;'>🔓 Editing: ${htmlesc(p.title)}</strong>
        <span class='muted' style='font-size:11px;white-space:nowrap;'>${p.sourceFile?htmlesc('Writes to '+p.sourceFile):'Saved in-app'}</span>
      </div>
      <textarea id='promptEditorText' spellcheck='false'
        style='width:100%;height:50vh;resize:vertical;font-family:monospace;font-size:12.5px;
               background:var(--input-bg);border:1px solid var(--input-border);color:var(--fg);
               border-radius:6px;padding:10px;'>Loading…</textarea>
      <div class='muted' id='promptEditorError' style='font-size:12px;color:#ff6b6b;margin-top:6px;display:none;'></div>
    </div>
    <div class="modal-footer">
      <button class="btn" id="modalCancel">Cancel</button>
      <button class="btn acc" id="modalOk" disabled>Save</button>
    </div>`;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  modal.querySelector('#modalCancel').onclick=()=>{ if(document.body.contains(overlay)) document.body.removeChild(overlay); };
  const textEl=modal.querySelector('#promptEditorText');
  const errEl=modal.querySelector('#promptEditorError');
  const okBtn=modal.querySelector('#modalOk');
  try{
    textEl.value=await getPromptContent(p);
  }catch(err){
    textEl.value='';
    errEl.textContent='Failed to load current content: '+err.message;
    errEl.style.display='block';
  }
  if(!document.body.contains(overlay)) return; // closed while loading
  okBtn.disabled=false;
  okBtn.onclick=async()=>{
    const newText=textEl.value;
    okBtn.disabled=true; okBtn.textContent='Saving…'; errEl.style.display='none';
    try{
      if(p.sourceFile){
        const res=await fetch('/api/agent-prompt-file', {
          method:'POST',
          headers:{ 'Content-Type':'application/json', 'X-Requested-With':'XMLHttpRequest' },
          body: JSON.stringify({ file:p.sourceFile, content:newText })
        });
        const data=await res.json().catch(()=>({}));
        if(!res.ok || !data.ok) throw new Error(data.error || 'Save failed ('+res.status+')');
      } else {
        p.content=newText;
      }
      p.updatedAt=nowISO();
      save();
      document.body.removeChild(overlay);
    }catch(err){
      errEl.textContent='Save failed: '+err.message;
      errEl.style.display='block';
      okBtn.disabled=false; okBtn.textContent='Save';
    }
  };
}

function renderNotebookDetail(nbId){
  try { window.scrollTo({top:0, left:0, behavior:'instant'}); } catch(_) { window.scrollTo(0,0); }
  if (content) content.scrollTop = 0;
  if(!db.notebooks) db.notebooks=[];
  const nb=db.notebooks.find(x=>x.id===nbId && !x.deletedAt);
  if(!nb){ currentNotebookId=null; renderNotebooks(); return; }
  const pages=getNotebookPages(nbId);
  // Validate currentPageId still belongs to this notebook
  if(currentPageId && !pages.find(p=>p.id===currentPageId)) currentPageId=null;

  content.innerHTML=`
    <div style='display:flex;height:calc(100vh - 70px);min-height:400px;overflow:hidden;'>
      <!-- TOC sidebar -->
      <div id='nbToc' style='width:230px;min-width:160px;flex-shrink:0;overflow-y:auto;
           border-right:1px solid var(--btn-border);padding:10px;box-sizing:border-box;
           display:flex;flex-direction:column;gap:6px;'>
        <div class='row' style='align-items:center;gap:6px;flex-wrap:wrap;'>
          <button id='backToNbs' class='btn' style='font-size:11px;flex-shrink:0;padding:4px 8px;'>\u2190 All</button>
          <span style='font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;'
                title='${htmlesc(nb.title)}'>${htmlesc(nb.title)}</span>
        </div>
        <button id='newPage' class='btn acc' style='font-size:12px;width:100%;'>+ New Page</button>
        <button id='nbExportMd' class='btn' style='font-size:11px;width:100%;'
                title='Download every page in this notebook as one Markdown file'>⬇ Export .md</button>
        <input id='nbTocFilter' type='text' placeholder='Search titles & content…' autocomplete='off'
               style='width:100%;font-size:12px;padding:5px 7px;margin-top:2px;box-sizing:border-box;' />
        <div id='tocList' style='display:flex;flex-direction:column;gap:3px;margin-top:4px;'>
          ${(() => {
            // Build a display order that interleaves each top-level page with
            // its direct sub-pages (one level of nesting only — a sub-page
            // cannot itself have sub-pages, enforced at reparent-time below).
            // Sort within each group by sortOrder, same as the old flat list.
            const bySort = (a,b)=>(a.sortOrder||0)-(b.sortOrder||0);
            const topPages = pages.filter(p=>!p.parentPageId).sort(bySort);
            const childrenByParent = new Map();
            pages.forEach(p=>{
              if(!p.parentPageId) return;
              if(!childrenByParent.has(p.parentPageId)) childrenByParent.set(p.parentPageId, []);
              childrenByParent.get(p.parentPageId).push(p);
            });
            childrenByParent.forEach(arr=>arr.sort(bySort));
            const collapsed = new Set(nb.collapsedPageIds||[]);
            const rows = [];
            const seen = new Set();
            topPages.forEach(p=>{
              const kids = childrenByParent.get(p.id) || [];
              rows.push({ page:p, depth:0, hasChildren: kids.length>0, collapsed: collapsed.has(p.id) });
              seen.add(p.id);
              // Mark children as accounted-for regardless of collapse state
              // (only whether they're actually pushed as visible rows should
              // depend on collapse) — otherwise the orphan safety-net below
              // mistakes a collapsed child for one whose parent vanished and
              // re-adds it as an un-indented top-level row.
              kids.forEach(c=>seen.add(c.id));
              if(kids.length && !collapsed.has(p.id)){
                kids.forEach(c=>{ rows.push({ page:c, depth:1, hasChildren:false, collapsed:false }); });
              }
            });
            // Safety net: pages whose parentPageId points at a page that no
            // longer exists (deleted elsewhere without the orphan-promotion
            // below running) would otherwise silently vanish from the TOC.
            pages.forEach(p=>{ if(!seen.has(p.id)) rows.push({ page:p, depth:0, hasChildren:false, collapsed:false }); });

            return rows.map(({page:p, depth, hasChildren, collapsed:isCollapsed})=>{
              const _raw = (p.content||'').replace(/^---[\s\S]*?---\s*/, '').replace(/`{1,3}[^`]*`{1,3}/g,' ').replace(/[#>*_~`\-]+/g,' ').replace(/!?\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/\s+/g,' ').trim();
              const _snippet = _raw ? _raw.slice(0, 220) + (_raw.length > 220 ? '…' : '') : '(empty page)';
              const _isTpl = nb.templatePageId === p.id;
              const _tip = `${(p.title||'Untitled')}\n\n${_snippet}\n\nDouble-click to rename${_isTpl ? '\n\n★ Used as the template for new pages' : ''}`;
              const chevron = hasChildren
                ? `<span class='nb-toc-chevron' data-page-id='${p.id}' style='flex-shrink:0;cursor:pointer;font-size:11px;width:12px;display:inline-block;color:var(--muted);'>${isCollapsed?'\u25b8':'\u25be'}</span>`
                : (depth>0 ? `<span style='flex-shrink:0;width:12px;'></span>` : '');
              return `
              <div class='nb-toc-item' draggable='true' data-page-id='${p.id}' data-page-title='${htmlesc(p.title||'')}'
                   data-parent-page-id='${p.parentPageId||''}' data-depth='${depth}'
                   title='${htmlesc(_tip)}'
                   style='padding:7px 9px 7px ${9+depth*18}px;border-radius:5px;cursor:pointer;font-size:13px;word-break:break-word;
                          display:flex;align-items:center;gap:6px;
                          border:1px solid ${currentPageId===p.id?'var(--acc)':(_isTpl?'#f0b429':'var(--btn-border)')};
                          background:${currentPageId===p.id?'var(--acc)':'var(--card-bg)'};
                          color:${currentPageId===p.id?'#fff':'var(--fg)'};'>
                ${chevron}
                <span class='nb-toc-title' style='display:inline-block;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;'>${htmlesc(p.title||'Untitled')}</span>
                <span class='nb-toc-star' data-page-id='${p.id}' title='${_isTpl ? 'Template for new pages — click to unset' : 'Use as template for new pages'}'
                      style='flex-shrink:0;cursor:pointer;font-size:13px;opacity:${_isTpl?'1':'0.35'};'>${_isTpl?'\u2605':'\u2606'}</span>
              </div>`;
            }).join('');
          })()}
          ${pages.length===0?`<div class='muted' style='font-size:12px;text-align:center;margin-top:16px;'>No pages yet</div>`:''}
        </div>
      </div>
      <!-- Page editor panel -->
      <div id='nbPageEditor' style='flex:1;overflow-y:auto;padding:16px;box-sizing:border-box;'>
        <div class='muted' style='text-align:center;margin-top:60px;font-size:14px;'>
          Select a page from the left, or create a new one.
        </div>
      </div>
    </div>`;

  document.getElementById('backToNbs').onclick=()=>{
    if(typeof window._pgFlush === 'function'){ try { window._pgFlush(); } catch(_) {} window._pgFlush=null; }
    // "All" always means "the Notebooks list" — that's the one and only
    // parent of this view, so jump there directly instead of trusting
    // _navPop()/the history stack. The stack approach is fragile: any single
    // call path elsewhere that forgets to push (or pushes an extra time)
    // makes "All" land on a random unrelated view instead of the list, which
    // isn't how hierarchical back navigation should behave. Still pop one
    // stack entry (discarding its contents) purely to keep the stack's depth
    // in sync with the browser's native Back button.
    if (window._navHistory && window._navHistory.length) window._navHistory.pop();
    currentNotebookId=null; currentPageId=null; route='notebooks'; render();
  };
  document.getElementById('newPage').onclick=()=>{
    // Frictionless: create an Untitled page instantly and focus its title.
    // No modal — user just starts typing. If a template page is set for this
    // notebook (starred in the TOC), seed the new page from its content/tags
    // instead of starting blank.
    const tplPage = nb.templatePageId ? pages.find(x=>x.id===nb.templatePageId) : null;
    const p=createPage({
      title:'Untitled', notebookId:nbId,
      content: tplPage ? (tplPage.content||'') : '',
      tags: tplPage ? [...(tplPage.tags||[])] : []
    });
    currentPageId=p.id;
    renderNotebookDetail(nbId);
    // Defer focus until the page editor has been stamped into the DOM.
    setTimeout(()=>{
      const t=document.getElementById('pgTitle');
      if(t){ t.focus(); t.select(); }
    }, 0);
  };

  // --- TOC filter (purely client-side, doesn't persist) ---
  // Searches both page titles AND page body content (notebook-wide content
  // search), not just titles. Content is plain-text-stripped once up front
  // (same stripping used for the tooltip snippet above) and cached by page
  // id so filtering on every keystroke stays cheap.
  const _pageTextById = new Map(pages.map(p => [p.id, ((p.title||'') + ' ' + (p.content||''))
    .replace(/^---[\s\S]*?---\s*/, '')
    .replace(/`{1,3}[^`]*`{1,3}/g, ' ')
    .replace(/[#>*_~`\-]+/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()]));
  const filterEl=document.getElementById('nbTocFilter');
  if(filterEl){
    filterEl.addEventListener('input', ()=>{
      const q=filterEl.value.trim().toLowerCase();
      let visibleCount = 0;
      content.querySelectorAll('.nb-toc-item').forEach(el=>{
        const text = _pageTextById.get(el.dataset.pageId) || '';
        const match = !q || text.includes(q);
        el.style.display = match ? '' : 'none';
        if(match) visibleCount++;
      });
      const emptyEl = document.getElementById('nbTocFilterEmpty');
      if(q && visibleCount===0 && pages.length>0){
        if(!emptyEl){
          const div=document.createElement('div');
          div.id='nbTocFilterEmpty';
          div.className='muted';
          div.style.cssText='font-size:12px;text-align:center;margin-top:10px;';
          div.textContent='No pages match your search.';
          document.getElementById('tocList').after(div);
        }
      } else if(emptyEl){
        emptyEl.remove();
      }
    });
  }

  // --- Inline rename on double-click ---
  // Replaces the title span with an input. Enter commits, Esc cancels.
  // Drag is temporarily disabled while editing so the textfield is selectable.
  content.querySelectorAll('.nb-toc-item').forEach(item=>{
    const titleSpan=item.querySelector('.nb-toc-title');
    if(!titleSpan) return;
    titleSpan.addEventListener('dblclick', e=>{
      e.preventDefault(); e.stopPropagation();
      _startInlineRename(item, titleSpan, nbId);
    });
  });

  // --- Template-page star toggle ---
  // Exactly one page per notebook can be starred as the template; "+ New
  // Page" seeds new pages from it. Click again to unset (back to blank pages).
  content.querySelectorAll('.nb-toc-star').forEach(star=>{
    star.addEventListener('click', e=>{
      e.preventDefault(); e.stopPropagation();
      const pid = star.dataset.pageId;
      const next = nb.templatePageId === pid ? null : pid;
      updateNotebook(nbId, { templatePageId: next });
      renderNotebookDetail(nbId);
    });
  });

  const exportMdBtn = document.getElementById('nbExportMd');
  if (exportMdBtn) {
    exportMdBtn.onclick = () => {
      const lines = [`# ${nb.title}`];
      if (nb.description) lines.push('', `> ${nb.description}`);
      lines.push('', `_Exported ${new Date().toISOString().slice(0,10)} · ${pages.length} page${pages.length!==1?'s':''}_`, '');
      pages.forEach((p, i) => {
        lines.push('', '---', '', `# ${p.title || 'Untitled'}`);
        if ((p.tags||[]).length) lines.push('', '_Tags:_ ' + p.tags.map(t=>'`#'+t+'`').join(' '));
        lines.push('', (p.content || '').trim() || '_(empty page)_');
      });
      const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${(nb.title||'notebook').replace(/[^a-z0-9]+/gi,'_')}.md`;
      a.click();
      URL.revokeObjectURL(a.href);
    };
  }

  // TOC item clicks
  content.querySelectorAll('.nb-toc-item').forEach(el=>{
    el.onclick=()=>{ currentPageId=el.dataset.pageId; openPageInNotebook(el.dataset.pageId, nbId); };
  });

  // --- Expand/collapse chevron for pages with sub-pages ---
  content.querySelectorAll('.nb-toc-chevron').forEach(ch=>{
    ch.addEventListener('click', e=>{
      e.preventDefault(); e.stopPropagation();
      const pid = ch.dataset.pageId;
      const set = new Set(nb.collapsedPageIds||[]);
      if(set.has(pid)) set.delete(pid); else set.add(pid);
      updateNotebook(nbId, { collapsedPageIds:[...set] });
      renderNotebookDetail(nbId);
    });
  });

  // Drag-to-reorder / drag-to-nest (one level of nesting only). Dropping on
  // the middle 50% of a top-level page nests the dragged page as its child;
  // dropping on the top/bottom edge of any item reorders the dragged page
  // as a sibling, adopting that item's own parent. A page that already has
  // its own sub-pages always stays top-level when dropped (keeps nesting to
  // a single level rather than trying to support arbitrary depth).
  let _dragSrc=null;
  const tocList=document.getElementById('tocList');
  function reorderWithinGroup(pageId, newParentId, referenceId, position){
    const p = db.notes.find(x=>x.id===pageId);
    if(!p) return;
    p.parentPageId = newParentId || null;
    p.updatedAt = nowISO();
    const groupPages = db.notes.filter(x=>x.notebookId===p.notebookId && !x.deletedAt && x.type==='page'
      && (x.parentPageId||null)===(newParentId||null) && x.id!==pageId)
      .sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0));
    let insertAt = groupPages.length;
    if(referenceId && position!=='end'){
      const idx = groupPages.findIndex(x=>x.id===referenceId);
      if(idx>=0) insertAt = position==='before' ? idx : idx+1;
    }
    groupPages.splice(insertAt, 0, p);
    groupPages.forEach((x,i)=>{ x.sortOrder=i; });
    save();
  }
  content.querySelectorAll('.nb-toc-item').forEach(el=>{
    el.addEventListener('dragstart', e=>{
      _dragSrc=el; el.style.opacity='0.45';
      e.dataTransfer.effectAllowed='move';
      e.dataTransfer.setData('text/plain', el.dataset.pageId);
    });
    el.addEventListener('dragend', ()=>{
      el.style.opacity='';
      content.querySelectorAll('.nb-toc-item').forEach(x=>x.classList.remove('nb-drag-over','nb-drag-before','nb-drag-after','nb-drag-nest'));
    });
    el.addEventListener('dragover', e=>{
      e.preventDefault(); e.dataTransfer.dropEffect='move';
      content.querySelectorAll('.nb-toc-item').forEach(x=>{ if(x!==el) x.classList.remove('nb-drag-over','nb-drag-before','nb-drag-after','nb-drag-nest'); });
      const rect = el.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const isTopLevel = el.dataset.depth==='0';
      let zone;
      if(isTopLevel && y > rect.height*0.25 && y < rect.height*0.75) zone='nest';
      else zone = y < rect.height*0.5 ? 'before' : 'after';
      el.dataset.dropZone = zone;
      el.classList.remove('nb-drag-before','nb-drag-after','nb-drag-nest');
      el.classList.add(zone==='nest' ? 'nb-drag-nest' : (zone==='before' ? 'nb-drag-before' : 'nb-drag-after'));
    });
    el.addEventListener('drop', e=>{
      e.preventDefault();
      content.querySelectorAll('.nb-toc-item').forEach(x=>x.classList.remove('nb-drag-over','nb-drag-before','nb-drag-after','nb-drag-nest'));
      if(!_dragSrc || _dragSrc===el) return;
      const srcId = _dragSrc.dataset.pageId;
      const dstId = el.dataset.pageId;
      const dstParent = el.dataset.parentPageId || null;
      const zone = el.dataset.dropZone || 'after';
      const srcHasChildren = pages.some(x=>x.parentPageId===srcId);
      if(srcHasChildren){
        const anchorId = dstParent || dstId;
        reorderWithinGroup(srcId, null, anchorId, 'after');
      } else if(zone==='nest' && el.dataset.depth==='0'){
        reorderWithinGroup(srcId, dstId, null, 'end');
      } else {
        reorderWithinGroup(srcId, dstParent, dstId, zone==='nest' ? 'after' : zone);
      }
      renderNotebookDetail(nbId);
    });
  });

  // Open current page if one is selected
  if(currentPageId) openPageInNotebook(currentPageId, nbId);
}

function openPageInNotebook(pageId, nbId){
  // Flush any pending autosave from the previously-open page before swapping
  // editors out — this guarantees no debounced keystrokes are lost when the
  // user clicks another TOC entry.
  if(typeof window._pgFlush === 'function'){
    try { window._pgFlush(); } catch(_) {}
    window._pgFlush = null;
  }
  const p=db.notes.find(x=>x.id===pageId && !x.deletedAt);
  if(!p){ currentPageId=null; renderNotebookDetail(nbId); return; }
  const editor=document.getElementById('nbPageEditor');
  if(!editor) return;
  currentPageId=pageId;
  // Highlight active TOC item
  content.querySelectorAll('.nb-toc-item').forEach(el=>{
    const isActive=el.dataset.pageId===pageId;
    el.style.background=isActive?'var(--acc)':'var(--card-bg)';
    el.style.color=isActive?'#fff':'var(--fg)';
    el.style.borderColor=isActive?'var(--acc)':'var(--btn-border)';
  });
  editor.innerHTML=`
    <div style='max-width:100%;'>
      ${(() => {
        const nb = (db.notebooks || []).find(x => x.id === nbId);
        if (!nb || !nb.system) return '';
        return `<div style='font-size:11px;padding:6px 10px;margin-bottom:8px;
                  background:rgba(139,109,255,0.08);border:1px solid rgba(139,109,255,0.25);
                  border-radius:6px;color:var(--muted,#8b6dff);'>
                  🔬 Managed by Research — this page is surfaced by the Research dashboard.
                  Editing here works, but the dashboard expects its current structure.
                </div>`;
      })()}
      <input id='pgTitle' type='text' value='${htmlesc(p.title)}'
             style='width:100%;font-size:17px;font-weight:600;margin-bottom:8px;box-sizing:border-box;' />
      ${(() => {
        if(!p.parentPageId) return '';
        const parent = db.notes.find(x=>x.id===p.parentPageId && !x.deletedAt);
        return parent ? `<div class='muted' style='font-size:11px;margin:-4px 0 8px;'>\u21b3 Sub-page of <strong>${htmlesc(parent.title||'Untitled')}</strong></div>` : '';
      })()}
      <input id='pgTags' type='text' placeholder='Tags (e.g. #ml #ros2)'
             value='${(p.tags||[]).map(t=>'#'+t).join(' ')}'
             style='width:100%;margin-bottom:8px;font-size:13px;box-sizing:border-box;' />
      <div class='row' style='margin-bottom:8px;gap:8px;align-items:center;flex-wrap:wrap;'>
        <button id='pgToggleModeBtn' class='btn acc' style='font-size:12px;' title='Cycle Edit → Split → Preview'>Split</button>
        <span style='font-size:11px;color:var(--muted);'>Ctrl+Shift+V cycles view</span>
        ${!p.parentPageId ? `<button id='pgAddSubpage' class='btn' style='font-size:11px;margin-left:auto;' title='Create a sub-page nested under this one'>+ Sub-page</button>` : ''}
      </div>
      <div id='pgHeadingNav' style='display:none;margin-bottom:8px;padding:6px 8px;
           border:1px solid var(--btn-border);border-radius:6px;max-height:130px;overflow-y:auto;'></div>
      ${markdownToolbarHtml('pgContent')}
      <div id='pgEditorPaneWrap' class='editor-pane-wrap' data-mode='edit'>
        <textarea id='pgContent' class='pane-editor' style='width:100%;min-height:320px;height:calc(100vh - 360px);
                  resize:vertical;box-sizing:border-box;'>${htmlesc(p.content||'')}</textarea>
        <div id='pgPreview' class='markdown-preview pane-preview' style='min-height:320px;height:calc(100vh - 360px);'></div>
      </div>
      <div id='pgFollowupsSection' style='margin-top:12px;'></div>
      <div class='row' style='margin-top:10px;gap:8px;flex-wrap:wrap;align-items:center;'>
        <button id='pgSave' class='btn acc'>Save</button>
        <button id='pgExportMd' class='btn' style='font-size:12px;' title='Download just this page as a Markdown file'>⬇ Export page</button>
        <button id='pgDelete' class='btn' style='border-color:#ff6b6b;color:#ff6b6b;'>Delete Page</button>
        <span class='muted' id='pgSaveStatus' style='font-size:12px;'></span>
      </div>
      <div class='muted' style='font-size:11px;margin-top:8px;'>
        Ctrl+S to save &nbsp; Created ${p.createdAt.slice(0,10)} &nbsp; Updated ${p.updatedAt.slice(0,10)}
      </div>
    </div>`;

  const titleEl=document.getElementById('pgTitle');
  const contentEl=document.getElementById('pgContent');
  const tagsEl=document.getElementById('pgTags');
  const statusEl=()=>document.getElementById('pgSaveStatus');

  // --- "On this page" heading mini-nav — pulled from the page's own
  // H1/H2/H3 lines so long lecture-style pages are easy to jump around in.
  // Correlates by order (Nth heading line ↔ Nth <h1..h3> in the preview),
  // which holds as long as fenced code blocks don't contain literal "#"
  // lines — a reasonable tradeoff to avoid depending on the optional
  // CDN heading-id extension for anchor ids.
  const pgHeadingNavEl = document.getElementById('pgHeadingNav');
  function _pgExtractHeadings(md){
    const heads = [];
    const lines = (md || '').split('\n');
    let offset = 0;
    lines.forEach((line, idx) => {
      const m = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
      if(m) heads.push({ level: m[1].length, text: m[2], line: idx, offset });
      offset += line.length + 1;
    });
    return heads;
  }
  function renderPgHeadingNav(){
    if(!pgHeadingNavEl) return;
    const heads = _pgExtractHeadings(contentEl.value);
    if(!heads.length){ pgHeadingNavEl.style.display='none'; pgHeadingNavEl.innerHTML=''; return; }
    pgHeadingNavEl.style.display='block';
    pgHeadingNavEl.innerHTML = `<div class='muted' style='font-size:10px;text-transform:uppercase;letter-spacing:.03em;margin-bottom:4px;'>On this page</div>` +
      heads.map((h,i)=>`<div class='pg-heading-item' data-idx='${i}'
        style='cursor:pointer;font-size:12px;padding:2px 0 2px ${(h.level-1)*12}px;color:var(--acc);
               white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' title='${htmlesc(h.text)}'>${htmlesc(h.text)}</div>`).join('');
    pgHeadingNavEl.querySelectorAll('.pg-heading-item').forEach(el=>{
      el.onclick = () => {
        const h = heads[+el.dataset.idx];
        if(!h) return;
        if(pgCurrentMode === 'edit'){
          contentEl.focus();
          contentEl.setSelectionRange(h.offset, h.offset + h.text.length + h.level + 1);
          const total = contentEl.value.split('\n').length || 1;
          contentEl.scrollTop = (h.line / total) * contentEl.scrollHeight;
        } else {
          const hEls = pgPreviewEl ? pgPreviewEl.querySelectorAll('h1,h2,h3') : [];
          const target = hEls[+el.dataset.idx];
          if(target) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
        }
      };
    });
  }

  // --- Checklist promoter, scoped to notebook pages -------------------
  // Notebook-page-native equivalent of power-features.js's standalone-note
  // checklist promoter (renderFollowupsPanel). Kept separate/local (rather
  // than reused) because it targets `pgContent`/`#pgFollowupsSection` and
  // notebook page ids instead of `contentBox`/`#noteFollowupsSection` and
  // standalone note ids — the two editors are deliberately kept independent.
  // Scans the page for markdown "- [ ]"/"- [x]" lines and lets the user
  // promote any of them into a real db.tasks entry linked to this page
  // (noteId set to the page id, tag 'notebook-followup' added). Promoted
  // lines are detected by matching task title + noteId, so re-opening the
  // page shows them as already tracked instead of offering the button again.
  const pgFollowupsEl = document.getElementById('pgFollowupsSection');
  let _pgFollowupsSig = '';
  function renderPgFollowupsPanel(){
    if(!pgFollowupsEl) return;
    const src = contentEl.value || '';
    const items = [];
    src.split('\n').forEach((line, idx) => {
      const m = line.match(/^\s*-\s*\[\s*([ xX])\s*\]\s*(.+?)\s*$/);
      if(!m) return;
      const text = m[2].trim();
      if(!text) return;
      items.push({ idx, checked: m[1] !== ' ', text });
    });
    if(!items.length){ pgFollowupsEl.innerHTML=''; _pgFollowupsSig=''; return; }

    const pageTasks = (db.tasks||[]).filter(t => t.noteId===pageId && !t.deletedAt);
    const norm = s => s.replace(/\s+/g,' ').trim().toLowerCase();
    const matchTask = text => pageTasks.find(t => norm(t.title)===norm(text));

    const sig = items.length + '\u0000' + items.map(it=>(it.checked?'x':'o')+':'+it.text).join('|') +
      '\u0000' + pageTasks.map(t=>t.id+':'+t.status).join('|');
    if(sig === _pgFollowupsSig) return;
    _pgFollowupsSig = sig;

    const untracked = items.filter(it => !matchTask(it.text)).length;

    pgFollowupsEl.innerHTML = `
      <div class='row' style='justify-content:space-between;align-items:center;'>
        <h3 style='margin:0;font-size:14px;'>Checklist in this page (${items.length})</h3>
        <span class='muted' style='font-size:11px;'>${untracked} untracked \u00b7 click \u2192 Task to promote</span>
      </div>
      <div style='margin-top:6px;'>
        ${items.map(it=>{
          const t = matchTask(it.text);
          const tracked = !!t;
          const done = tracked && t.status==='DONE';
          const badge = tracked
            ? `<span class='pill' style='background:${done?'#4caf9e':'#8b6dff'};color:#fff;font-size:10px;margin-left:6px;'>${done?'\u2713 done':'\u2192 tracked'}</span>`
            : '';
          const rowStyle = it.checked ? 'opacity:.55;text-decoration:line-through;' : '';
          return `<div class='row' style='justify-content:space-between;gap:8px;align-items:flex-start;padding:4px 0;border-bottom:1px solid var(--btn-border);'>
            <span style='flex:1;font-size:13px;${rowStyle}'>${it.checked?'\u2611':'\u2610'} ${htmlesc(it.text)} ${badge}</span>
            ${tracked ? '' : `<button class='btn' data-pg-fup-promote='${it.idx}' style='font-size:11px;flex-shrink:0;' title='Create a tracked task for this line'>\u2192 Task</button>`}
          </div>`;
        }).join('')}
      </div>`;

    pgFollowupsEl.querySelectorAll('[data-pg-fup-promote]').forEach(btn=>{
      btn.onclick = () => {
        const idx = +btn.dataset.pgFupPromote;
        const it = items.find(x=>x.idx===idx);
        if(!it) return;
        createTask({
          title: it.text,
          noteId: pageId,
          priority: 'medium',
          tags: ['notebook-followup'],
        });
        save();
        _pgFollowupsSig = '';
        renderPgFollowupsPanel();
      };
    });
  }
  contentEl.addEventListener('input', renderPgFollowupsPanel);
  renderPgFollowupsPanel();

  // --- Autosave: debounced (~500ms after last keystroke) so the user never
  // loses work by switching pages or clicking "← All". Ctrl+S / the Save
  // button still work and flush immediately. Both paths go through the same
  // doSavePage() so behaviour is identical.
  let _autosaveTimer = null;
  let _statusClearTimer = null;
  const setStatus = (msg, fade=false) => {
    const s=statusEl(); if(!s) return;
    s.textContent = msg;
    if(_statusClearTimer){ clearTimeout(_statusClearTimer); _statusClearTimer=null; }
    if(fade) _statusClearTimer = setTimeout(()=>{ const ss=statusEl(); if(ss && ss.textContent===msg) ss.textContent=''; }, 1800);
  };
  const markDirty = () => {
    setStatus('Saving\u2026');
    if(_autosaveTimer) clearTimeout(_autosaveTimer);
    _autosaveTimer = setTimeout(()=>{ _autosaveTimer=null; doSavePage(/*fromAutosave*/true); }, 500);
  };
  [titleEl, contentEl, tagsEl].forEach(el=>{
    if(el) el.addEventListener('input', markDirty);
  });
  contentEl.addEventListener('input', renderPgHeadingNav);
  renderPgHeadingNav();

  // Bind markdown toolbar AFTER HTML is stamped into the DOM
  bindMarkdownToolbar('pgContent');
  wireInlineImagePasteDrop('pgContent');

  // --- Edit / Split / Preview cycle (mirrors the same feature in openNote) ---
  const pgPreviewEl = document.getElementById('pgPreview');
  const pgPaneWrap = document.getElementById('pgEditorPaneWrap');
  const pgToggleModeBtn = document.getElementById('pgToggleModeBtn');
  const PG_MODES = ['edit', 'split', 'preview'];
  const PG_NEXT_LABEL = { edit: 'Split', split: 'Preview', preview: 'Edit' };
  const pgNarrow = () => (window.innerWidth || document.documentElement.clientWidth) < 720;
  let pgCurrentMode = (db.settings && PG_MODES.includes(db.settings.noteViewMode))
    ? db.settings.noteViewMode : 'edit';
  if (pgCurrentMode === 'split' && pgNarrow()) pgCurrentMode = 'edit';
  _wireHighlightSelectionPopup(pgPreviewEl, contentEl);
  let _pgPreviewRaf = 0;
  function renderPgPreview() {
    if (!pgPreviewEl) return;
    const sH = pgPreviewEl.scrollHeight || 1;
    const ratio = pgPreviewEl.scrollTop / sH;
    pgPreviewEl.innerHTML = markdownToHtml(contentEl.value);
    if (typeof _processMermaid === 'function') _processMermaid(pgPreviewEl);
    const newH = pgPreviewEl.scrollHeight || 1;
    pgPreviewEl.scrollTop = ratio * newH;
  }
  function schedulePgPreview() {
    if (pgCurrentMode === 'edit') return;
    if (_pgPreviewRaf) cancelAnimationFrame(_pgPreviewRaf);
    _pgPreviewRaf = requestAnimationFrame(() => { _pgPreviewRaf = 0; renderPgPreview(); });
  }
  function applyPgMode(mode) {
    if (!PG_MODES.includes(mode)) mode = 'edit';
    if (mode === 'split' && pgNarrow()) mode = 'preview';
    pgCurrentMode = mode;
    if (pgPaneWrap) pgPaneWrap.setAttribute('data-mode', mode);
    if (pgToggleModeBtn) pgToggleModeBtn.textContent = PG_NEXT_LABEL[mode];
    if (mode !== 'edit') renderPgPreview();
    if (mode === 'edit') contentEl.focus();
    else if (mode === 'preview') pgPreviewEl.focus();
    if (db && db.settings) {
      db.settings.noteViewMode = mode;
      save();
    }
  }
  function cyclePgMode() {
    const i = PG_MODES.indexOf(pgCurrentMode);
    applyPgMode(PG_MODES[(i + 1) % PG_MODES.length]);
  }
  applyPgMode(pgCurrentMode);
  contentEl.addEventListener('input', schedulePgPreview);
  if (contentEl && pgPreviewEl) {
    contentEl.addEventListener('scroll', () => {
      if (pgCurrentMode !== 'split') return;
      const sh = contentEl.scrollHeight - contentEl.clientHeight;
      if (sh <= 0) return;
      const r = contentEl.scrollTop / sh;
      const psh = pgPreviewEl.scrollHeight - pgPreviewEl.clientHeight;
      pgPreviewEl.scrollTop = r * psh;
    });
  }
  if (pgToggleModeBtn) pgToggleModeBtn.onclick = cyclePgMode;
  if (pgPreviewEl) pgPreviewEl.setAttribute('tabindex', '0');

  // Ctrl+S — use window._pgKeyHandler so it is properly cleaned up when
  // switching pages or navigating away (prevents stale handler accumulation)
  if(window._pgKeyHandler){
    document.removeEventListener('keydown', window._pgKeyHandler, true);
    document.removeEventListener('keydown', window._pgKeyHandler);
  }
  const doSavePage = (fromAutosave=false) => {
    if(_autosaveTimer){ clearTimeout(_autosaveTimer); _autosaveTimer=null; }
    const tags=(document.getElementById('pgTags').value||'')
      .split(/\s+/).map(t=>t.startsWith('#')?t.slice(1):t).filter(Boolean);
    const nextTitle = titleEl.value.trim()||'Untitled';
    updateNote(p.id,{
      title: nextTitle,
      content: contentEl.value,
      tags
    });
    // Keep the TOC item label in sync without re-rendering the whole detail
    content.querySelectorAll('.nb-toc-item').forEach(el=>{
      if(el.dataset.pageId===p.id){
        el.dataset.pageTitle = nextTitle;
        const span = el.querySelector('.nb-toc-title');
        if(span) span.textContent = nextTitle;
      }
    });
    setStatus(fromAutosave ? 'Saved \u2713' : 'Saved \u2713', /*fade*/true);
  };
  const pgKeyHandler=e=>{
    if((e.ctrlKey||e.metaKey) && !e.shiftKey && e.key==='s'){
      e.preventDefault();
      e.stopPropagation();
      doSavePage();
    } else if(e.ctrlKey && e.shiftKey && (e.key==='V' || e.key==='v' || e.code==='KeyV')){
      e.preventDefault();
      cyclePgMode();
    }
  };
  document.addEventListener('keydown', pgKeyHandler, true);
  window._pgKeyHandler = pgKeyHandler;
  // Expose a flusher so other navigation (page switch, back, delete) can
  // force any pending debounced save through before tearing down the editor.
  window._pgFlush = () => { if(_autosaveTimer) doSavePage(true); };

  document.getElementById('pgSave').onclick = doSavePage;

  const pgAddSubpageBtn = document.getElementById('pgAddSubpage');
  if(pgAddSubpageBtn){
    pgAddSubpageBtn.onclick = () => {
      if(_autosaveTimer){ clearTimeout(_autosaveTimer); _autosaveTimer=null; doSavePage(true); }
      const sub = createPage({ title:'Untitled', notebookId:nbId, parentPageId:p.id });
      currentPageId = sub.id;
      renderNotebookDetail(nbId);
      setTimeout(()=>{
        const t=document.getElementById('pgTitle');
        if(t){ t.focus(); t.select(); }
      }, 0);
    };
  }

  document.getElementById('pgExportMd').onclick = () => {
    // Flush any pending edit first so the export matches what's on screen.
    if(_autosaveTimer){ clearTimeout(_autosaveTimer); _autosaveTimer=null; doSavePage(true); }
    const lines = [`# ${titleEl.value.trim() || 'Untitled'}`];
    const tagVals = (tagsEl.value||'').split(/\s+/).map(t=>t.startsWith('#')?t.slice(1):t).filter(Boolean);
    if(tagVals.length) lines.push('', '_Tags:_ ' + tagVals.map(t=>'`#'+t+'`').join(' '));
    lines.push('', contentEl.value.trim() || '_(empty page)_');
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(titleEl.value.trim()||'page').replace(/[^a-z0-9]+/gi,'_')}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  document.getElementById('pgDelete').onclick=async()=>{
    const childCount = getNotebookPages(nbId).filter(x=>x.parentPageId===p.id).length;
    const warn = childCount ? ` Its ${childCount} sub-page${childCount===1?'':'s'} will be promoted to top-level pages.` : '';
    const ok=await showConfirm(`Delete page "${p.title}"?${warn} It can be restored from Review.`,'Delete','Cancel');
    if(!ok) return;
    // Cancel any pending autosave so it doesn't resurrect the row we just nuked.
    if(_autosaveTimer){ clearTimeout(_autosaveTimer); _autosaveTimer=null; }
    window._pgFlush = null;
    document.removeEventListener('keydown', window._pgKeyHandler, true);
    document.removeEventListener('keydown', window._pgKeyHandler);
    window._pgKeyHandler = null;
    // Promote any sub-pages to top-level rather than cascade-deleting them —
    // deleting a parent shouldn't silently take its children down with it.
    db.notes.filter(x=>x.notebookId===nbId && !x.deletedAt && x.type==='page' && x.parentPageId===p.id)
      .forEach(x=>{ x.parentPageId=null; x.updatedAt=nowISO(); });
    softDeleteNote(p.id);
    currentPageId=null;
    renderNotebookDetail(nbId);
  };

  contentEl.focus();
}
// --- End added views ---

// --- Links view (restored) ---
function renderLinks(){
  const prevFilter = document.getElementById('linksFilter')?.value || '';
  content.innerHTML = `
    <div class='card'>
      <div class='row' style='justify-content:space-between;flex-wrap:wrap;gap:8px;'>
        <strong>🔗 Links</strong>
        <div class='muted' style='font-size:12px;'>Save & manage web resources</div>
      </div>
      <div class='row' style='margin-top:8px;gap:8px;flex-wrap:wrap;'>
        <input id='linkTitle' type='text' placeholder='Title' style='flex:1;min-width:140px;' />
        <input id='linkUrl' type='text' placeholder='https://...' style='flex:1;min-width:180px;' />
        <input id='linkTags' type='text' placeholder='tags (space)' autocomplete='off' style='flex:1;min-width:120px;' />
        <button id='addLink' class='btn acc'>Add</button>
      </div>
      <div id='linkTagSuggestRow' class='row' style='margin-top:4px;flex-wrap:wrap;gap:4px;align-items:center;font-size:11px;min-height:0;'></div>
      <div class='row' style='margin-top:8px;gap:8px;flex-wrap:wrap;'>
        <input id='linksFilter' type='text' placeholder='Filter or #tag' style='flex:1;min-width:160px;' value='${htmlesc(prevFilter)}' />
        <button id='exportLinks' class='btn' style='font-size:12px;'>Export</button>
        <button id='clearLinks' class='btn' style='font-size:12px;'>Clear All</button>
      </div>
    </div>
    <div id='linksList' class='list'></div>`;
  const filterEl = document.getElementById('linksFilter');
  function draw(){
    const q = (filterEl.value||'').trim();
    const tagFilters = (q.match(/#[\w-]+/g)||[]).map(t=>t.slice(1).toLowerCase());
    const text = q.replace(/#[\w-]+/g,'').trim().toLowerCase();
    let links = db.links.filter(l => !l.deletedAt);
    if(tagFilters.length){ links = links.filter(l=> tagFilters.every(t=> (l.tags||[]).map(x=>x.toLowerCase()).includes(t))); }
    if(text){ links = links.filter(l=> l.title.toLowerCase().includes(text) || l.url.toLowerCase().includes(text)); }
    links.sort((a,b)=> (b.pinned?1:0)-(a.pinned?1:0) || b.updatedAt.localeCompare(a.updatedAt));
    const list = document.getElementById('linksList');
    list.innerHTML = links.map(l=> row(l)).join('') || `<div class='card muted'>No links</div>`;
    list.querySelectorAll('[data-open]').forEach(b=> b.onclick=()=> window.open(b.dataset.open,'_blank'));
    list.querySelectorAll('[data-pin]').forEach(b=> b.onclick=()=>{ const l=db.links.find(x=>x.id===b.dataset.pin); if(l){ l.pinned=!l.pinned; save(); draw(); } });
    list.querySelectorAll('[data-del]').forEach(b=> b.onclick=async ()=>{
      const ok = await showConfirm('Delete link?', 'Delete', 'Cancel');
      if(!ok) return;
      deleteLink(b.dataset.del);
      draw();
    });
    list.querySelectorAll('[data-edit]').forEach(b=> b.onclick=()=> editLink(b.dataset.edit));
    list.querySelectorAll('[data-tag]').forEach(b=> b.onclick=()=>{ const tag=b.dataset.tag; filterEl.value = (filterEl.value.includes('#'+tag)? filterEl.value : (filterEl.value+ ' #'+tag)).trim(); draw(); });
  }
  function row(l){
    return `<div class='card' style='padding:10px;'>
      <div class='row' style='justify-content:space-between;flex-wrap:wrap;gap:6px;'>
        <span style='flex:1;min-width:200px;overflow:hidden;text-overflow:ellipsis;'>${l.pinned?'📌 ':''}<a href='${htmlesc(l.url)}' data-open='${htmlesc(l.url)}' target='_blank' rel='noopener' style='color:var(--acc);text-decoration:none;'>${htmlesc(l.title||l.url)}</a></span>
        <div class='row' style='gap:6px;'>
          <button class='btn' data-edit='${l.id}' style='font-size:11px;'>Edit</button>
          <button class='btn' data-pin='${l.id}' style='font-size:11px;'>${l.pinned?'Unpin':'Pin'}</button>
          <button class='btn' data-del='${l.id}' style='font-size:11px;'>✕</button>
        </div>
      </div>
      <div class='muted' style='margin-top:4px;font-size:11px;'>${htmlesc(l.url)}</div>
      ${(l.tags&&l.tags.length)?`<div style='margin-top:4px;'>${l.tags.map(t=>`<span class='pill' data-tag='${t}'>#${htmlesc(t)}</span>`).join(' ')}</div>`:''}
    </div>`;
  }
  function editLink(id){
    const l = db.links.find(x => x.id === id); if(!l) return;
    (async ()=>{
      const newTitle = await showPrompt('Title', l.title, 'OK', 'Cancel');
      if(newTitle === null) return;
      const newUrl = await showPrompt('URL', l.url, 'OK', 'Cancel');
      if(newUrl === null) return;
      const newTags = await showPrompt('Tags (space)', (l.tags || []).join(' '), 'OK', 'Cancel');
      if(newTags === null) return;
      const dup = db.links.find(x=> x.id !== id && !x.deletedAt && normUrl(x.url) === normUrl(newUrl));
      if(dup){
        showQuickToast('⚠️ Link already saved');
        return;
      }
      updateLink(id, {title: newTitle.trim() || newUrl.trim(), url: newUrl.trim(), tags: newTags.split(/\s+/).map(t=> t.startsWith('#') ? t.slice(1) : t).filter(Boolean)});
      draw();
    })();
  }
  const normUrl = u => (u||'').trim().replace(/\/+$/,'').toLowerCase();
  document.getElementById('addLink').onclick = ()=>{
    const title = document.getElementById('linkTitle').value.trim();
    const url = document.getElementById('linkUrl').value.trim();
    if(!url) return;
    const dup = db.links.find(l=> !l.deletedAt && normUrl(l.url) === normUrl(url));
    if(dup){
      showQuickToast('⚠️ Link already saved');
      return;
    }
    const tags = (document.getElementById('linkTags').value||'').split(/\s+/).map(t=>t.startsWith('#')?t.slice(1):t).filter(Boolean);
    createLink({title: title || url, url, tags});
    document.getElementById('linkTitle').value='';
    document.getElementById('linkUrl').value='';
    document.getElementById('linkTags').value='';
    draw();
  };
  filterEl.oninput = draw;
  document.getElementById('exportLinks').onclick = ()=>{
    const blob = new Blob([JSON.stringify(db.links,null,2)], {type:'application/json'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='links-export.json'; a.click(); URL.revokeObjectURL(a.href);
  };
  document.getElementById('clearLinks').onclick = async ()=>{
    const ok = await showConfirm('Delete ALL links?', 'Delete', 'Cancel');
    if(!ok) return;
    db.links = [];
    save();
    draw();
  };
  // --- Subtle tag suggestions for the new-link form ---
  // Re-rank against title + url + currently-typed tags. Empty by default;
  // chips appear only when the corpus has matches. Click to append.
  {
    const titleI = document.getElementById('linkTitle');
    const urlI   = document.getElementById('linkUrl');
    const tagsI  = document.getElementById('linkTags');
    const row    = document.getElementById('linkTagSuggestRow');
    if (tagsI && row) {
      const used = () => (tagsI.value || '').split(/\s+/)
        .map(t => t.startsWith('#') ? t.slice(1) : t).map(t => t.trim().toLowerCase()).filter(Boolean);
      const refresh = () => {
        const text = ((titleI?.value || '') + ' ' + (urlI?.value || '')).slice(0, 2000);
        if (!text.trim()) { row.innerHTML = ''; return; }
        const sugg = smartSuggestTags(text, used(), 8);
        if (!sugg.length) { row.innerHTML = ''; return; }
        row.innerHTML =
          `<span class='tag-sugg-label'>Suggested:</span>` +
          sugg.map(s => {
            const cls   = 'tag-sugg-chip' + (s.isNew ? ' is-new' : '');
            const title = s.isNew
              ? 'New tag extracted from this entry · click to add'
              : `Used ${s.count}\u00d7 \u00b7 click to add`;
            const prefix = s.isNew ? '\u2728 ' : '+ ';
            return `<button type='button' class='${cls}' data-suggest='${htmlesc(s.tag)}' title='${title}'>${prefix}#${htmlesc(s.tag)}</button>`;
          }).join('');
        row.querySelectorAll('[data-suggest]').forEach(b => b.onclick = () => {
          const tag = b.dataset.suggest;
          if (used().includes(tag.toLowerCase())) return;
          const cur = (tagsI.value || '').trim();
          tagsI.value = (cur ? cur + ' ' : '') + '#' + tag;
          refresh();
        });
      };
      let _t;
      const debounced = () => { clearTimeout(_t); _t = setTimeout(refresh, 200); };
      [titleI, urlI, tagsI].forEach(el => el && el.addEventListener('input', debounced));
      refresh();
      // Token-aware autocomplete popup (replaces native datalist) — uses
      // the same .fancy-select-popup styling as every other dropdown.
      try {
        attachFancyAutocomplete(tagsI, (q, val) => tagAutocompleteOptions(q, val));
      } catch(_){}
    }
  }
  draw();
}
// --- End Links view ---

// --- Note editor ---
function openNote(id){
  // Clear any competing keyboard handlers from other views before installing
  // the note editor's own handler. Without this, navigating from Today or
  // Notebooks to a note stacks multiple capture-phase Ctrl+S listeners and
  // causes them to fight each other.
  if(window._todayKeyHandler){
    document.removeEventListener('keydown', window._todayKeyHandler, true);
    window.removeEventListener('keydown', window._todayKeyHandler, true);
    window._todayKeyHandler = null;
  }
  if(window._pgKeyHandler){
    document.removeEventListener('keydown', window._pgKeyHandler, true);
    document.removeEventListener('keydown', window._pgKeyHandler);
    window._pgKeyHandler = null;
  }
  if(window._draftKeyHandler){
    document.removeEventListener('keydown', window._draftKeyHandler, true);
    window._draftKeyHandler = null;
  }
  const n = db.notes.find(x=>x.id===id);
  if(!n){
    // Note was deleted. Find any task referencing this id and clear the orphaned link.
    db.tasks.forEach(t => { if(t.noteId === id) t.noteId = null; });
    save();
    // Prefer the previous view (e.g. the list the user clicked from)
    // rather than dumping them on Today.
    _navBackOr(() => { route='today'; render(); });
    return;
  }
  if(n.deletedAt){
    // Note is in trash – go back to where the user came from if possible,
    // otherwise route to Review so they can restore it.
    _navBackOr(() => { route='review'; render(); });
    return;
  }
  // Push navigation state BEFORE switching to the note editor so Back returns here.
  _navPush();
  try { window.scrollTo({top:0, left:0, behavior:'instant'}); } catch(_) { window.scrollTo(0,0); }
  if (content) content.scrollTop = 0;
  // Record which note is open and reset dirty flag when opening.
  window._openNoteId = n.id;
  window._editorDirty = false;
  try { if(typeof _navSaveSession === 'function') _navSaveSession(); } catch(_) {}
  content.innerHTML = `
    <div class="card">
      ${(() => {
        const nb = n.notebookId ? (db.notebooks || []).find(x => x.id === n.notebookId) : null;
        if (!nb || !nb.system) return '';
        return `<div style='font-size:11px;padding:6px 10px;margin-bottom:8px;
                  background:rgba(139,109,255,0.08);border:1px solid rgba(139,109,255,0.25);
                  border-radius:6px;color:var(--muted,#8b6dff);'>
                  🔬 Managed by Research — this page is surfaced by the Research dashboard.
                  Editing here works, but the dashboard expects its current structure.
                </div>`;
      })()}
      <input id="title" type="text" value="${htmlesc(n.title)}" />
      <div class="row" style="margin-top:8px;flex-wrap:wrap;gap:8px;">
        <input id="tags" type="text" placeholder="Tags (space separated)" value="${(n.tags||[]).map(t=>'#'+t).join(' ')}" autocomplete="off" />
        <label style="margin-left:8px;"><input id="pinned" type="checkbox" ${n.pinned?'checked':''}> Pin</label>
        <select id="noteProject" style="padding:8px;background:var(--btn-bg);border:1px solid var(--btn-border);color:var(--fg);border-radius:6px;" title="Assign to project">
          <option value="">— No Project —</option>
          ${db.projects.filter(p=>!p.deletedAt).map(p=>`<option value="${p.id}" ${n.projectId===p.id?'selected':''}>${htmlesc(p.name)}</option>`).join('')}
        </select>
        <select id="noteStatus" title="Reading status — handy for papers and long reads"
                style="padding:8px;background:var(--btn-bg);border:1px solid var(--btn-border);color:var(--fg);border-radius:6px;">
          ${[
            {v:'',          l:'⚪ No status'},
            {v:'inbox',     l:'📥 Inbox'},
            {v:'reading',   l:'📖 Reading'},
            {v:'read',      l:'✅ Read'},
            {v:'annotated', l:'✍️ Annotated'},
            {v:'followup',  l:'🔁 Follow up'},
            {v:'archive',   l:'🗄️ Archived'},
          ].map(o=>`<option value='${o.v}' ${(n.status||'')===o.v?'selected':''}>${o.l}</option>`).join('')}
        </select>
        <button id="addSketch" class="btn" style="font-size:12px;" title="Draw a sketch">🎨 Sketch</button>
        <button id="addVoice" class="btn" style="font-size:12px;" title="Record voice note">🎙 Voice</button>
        <!-- Inline image — embeds into the note body via markdown ![](...), unlike Attach below -->
        <label class="btn" for="noteInlineImageFile" style="font-size:12px;" title="Insert an image inline in the text (or just paste/drag one into the editor)">🖼️ Image</label>
        <input id="noteInlineImageFile" type="file" accept="image/*" class="hidden" multiple />
        <!-- Attachment uploader -->
        <label class="btn" for="noteAttachFile" style="font-size:12px;" title="Attach a file">📎 Attach</label>
        <input id="noteAttachFile" type="file" class="hidden" multiple />
        <select id="noteApplyTemplate" title="Apply a template to this note">
          <option value="">📋 Apply Template…</option>
          ${(db.templates||[]).map(t=>`<option value="${t.id}">${htmlesc(t.name)}</option>`).join('')}
        </select>
      </div>
      <div id="tagSuggestRow" class="row" style="margin-top:4px;flex-wrap:wrap;gap:4px;align-items:center;font-size:11px;"></div>
      <div class="row" style="margin-top:8px; gap:8px; align-items:center;">
        <button id="toggleModeBtn" class="btn acc" style="font-size:12px;" title="Cycle Edit → Split → Preview">Split</button>
        <span style="font-size:12px; color:var(--muted);">Ctrl+Shift+V cycles view | Ctrl+S to save | paste/drag an image to insert it inline</span>
      </div>
      <div style="margin-top:8px;">
        ${markdownToolbarHtml('contentBox')}
        <div id="editorPaneWrap" class="editor-pane-wrap" data-mode="edit">
          <textarea id="contentBox" style="min-height:300px;">${htmlesc(n.content||'')}</textarea>
          <div id="markdownPreview" class="markdown-preview" style="min-height:300px;"></div>
        </div>
      </div>
      <div id="attachments" class="list" style="margin-top:8px;"></div>
      <!-- Linked notes section -->
      <div id="linkedNotesSection" style="margin-top:8px;">
        <div class="row" style="justify-content:space-between; align-items:center;">
          <h3 style="margin:0;font-size:16px;">Linked Notes</h3>
          <button id="addLinkBtn" class="btn" style="font-size:12px;">Add Link</button>
        </div>
        <div id="linkedNotesList" class="list" style="margin-top:6px;"></div>
      </div>
      <div class="row" style="margin-top:8px; gap:8px;flex-wrap:wrap;align-items:center;">
        <button id="save" class="btn acc">Save</button>
        <button id="back" class="btn">Back</button>
        <button id="duplicate" class="btn">Duplicate</button>
        <button id="export" class="btn">Export</button>
        <button id="delete" class="btn" style="border-color:#ff6b6b;color:#ff6b6b;">Delete</button>
        <span id="noteSaveStatus" class="muted" style="font-size:11px;"></span>
      </div>`;
  // Bind the markdown toolbar to the content box
  bindMarkdownToolbar('contentBox');
  // Attach listeners to detect editing and mark the note as dirty. We attach after
  // injecting the HTML so the elements exist. Editing any field will set
  // `_editorDirty` to true until the note is saved.
  {
    const titleEl = document.getElementById('title');
    const contentEl = document.getElementById('contentBox');
    ['input','change'].forEach(evt=>{
      if(titleEl) titleEl.addEventListener(evt, () => { window._editorDirty = true; });
      if(contentEl) contentEl.addEventListener(evt, () => { window._editorDirty = true; });
    });
  }
  // --- Tag suggestion chips (subtle) ---
  // Renders a quiet row of ghost chips below the tags input — only when
  // the corpus has relevant matches against title + content. Click to
  // append. Hidden entirely when nothing relevant is found, so the row
  // doesn't yell at the user with empty-state messaging.
  {
    const tagsEl  = document.getElementById('tags');
    const titleEl = document.getElementById('title');
    const contentEl = document.getElementById('contentBox');
    const row     = document.getElementById('tagSuggestRow');
    if (tagsEl && row) {
      const currentTagList = () => (tagsEl.value || '').split(/\s+/)
        .map(t => t.startsWith('#') ? t.slice(1) : t).map(t => t.trim().toLowerCase()).filter(Boolean);
      const refresh = () => {
        const text = ((titleEl?.value || '') + ' ' + (contentEl?.value || '')).slice(0, 4000);
        const sugg = smartSuggestTags(text, currentTagList(), 10);
        if (!sugg.length) { row.innerHTML = ''; return; }
        row.innerHTML =
          `<span class='tag-sugg-label'>Suggested:</span>` +
          sugg.map(s => {
            const cls   = 'tag-sugg-chip' + (s.isNew ? ' is-new' : '');
            const title = s.isNew
              ? 'New tag extracted from this note \u00b7 click to add'
              : `Used ${s.count}\u00d7 \u00b7 click to add`;
            const prefix = s.isNew ? '\u2728 ' : '+ ';
            return `<button type='button' class='${cls}' data-suggest='${htmlesc(s.tag)}' title='${title}'>${prefix}#${htmlesc(s.tag)}</button>`;
          }).join('');
        row.querySelectorAll('[data-suggest]').forEach(b => b.onclick = () => {
          const tag = b.dataset.suggest;
          if (currentTagList().includes(tag.toLowerCase())) return;
          const cur = (tagsEl.value || '').trim();
          tagsEl.value = (cur ? cur + ' ' : '') + '#' + tag;
          window._editorDirty = true;
          refresh();
        });
      };
      let _tagSuggestTimer;
      const debouncedRefresh = () => { clearTimeout(_tagSuggestTimer); _tagSuggestTimer = setTimeout(refresh, 250); };
      ['input','change','blur'].forEach(evt => {
        if (titleEl)   titleEl.addEventListener(evt, debouncedRefresh);
        if (contentEl) contentEl.addEventListener(evt, debouncedRefresh);
        if (tagsEl)    tagsEl.addEventListener(evt, debouncedRefresh);
      });
      refresh();
      // Token-aware autocomplete popup (replaces native datalist) — uses
      // the same .fancy-select-popup styling as every other dropdown.
      try {
        attachFancyAutocomplete(tagsEl, (q, val) => tagAutocompleteOptions(q, val));
      } catch(_){}
    }
  }
  const saveBtn = document.getElementById('save');
  const doSaveNote = () => {
    const tagText = document.getElementById('tags').value;
    const tags = tagText ? tagText.split(/\s+/).map(t => t.startsWith('#') ? t.slice(1) : t).filter(Boolean) : [];
    const selectedProjectId = document.getElementById('noteProject')?.value || null;
    const selectedStatus = document.getElementById('noteStatus')?.value || '';
    updateNote(n.id, {
      title: document.getElementById('title').value,
      content: document.getElementById('contentBox').value,
      tags,
      pinned: document.getElementById('pinned').checked,
      projectId: selectedProjectId || null,
      status: selectedStatus || null
    });
    window._editorDirty = false;
    showSavedToast('noteSaveStatus');
  };
  saveBtn.onclick = doSaveNote;
  window._doSaveNote = doSaveNote;
  document.getElementById('back').onclick = ()=> _navPop();
  // Apply Template dropdown — replaces or appends template content into this note.
  const applyTplSel = document.getElementById('noteApplyTemplate');
  if(applyTplSel){
    applyTplSel.onchange = async (ev) => {
      const tplId = ev.target.value;
      if(!tplId){ return; }
      const tpl = (db.templates||[]).find(x => x.id === tplId);
      ev.target.value = '';
      if(!tpl) return;
      const box = document.getElementById('contentBox');
      const current = (box.value || '').trim();
      const prepared = tpl.content
        .replace(/\[Title\]/g, document.getElementById('title').value || '')
        .replace(/\[Date\]/g, new Date().toLocaleDateString())
        .replace(/\[Project Name\]/g, n.projectId ? (db.projects.find(p=>p.id===n.projectId)?.name || '') : '');
      let mode = 'replace';
      if(current){
        const replace = await showConfirm(
          `Apply "${tpl.name}" template?\n\nOK = REPLACE current content.\nCancel = APPEND below current content.`,
          'Replace', 'Append'
        );
        mode = replace ? 'replace' : 'append';
      }
      box.value = mode === 'append' ? (current + '\n\n' + prepared) : prepared;
      window._editorDirty = true;
    };
  }
  document.getElementById('duplicate').onclick = ()=>{
    const copy = createNote({
      title: document.getElementById('title').value + ' (Copy)',
      content: document.getElementById('contentBox').value,
      tags: (document.getElementById('tags').value||'').split(/\s+/).map(t=>t.startsWith('#')?t.slice(1):t).filter(Boolean),
      projectId: n.projectId,
      type: n.type
    });
    openNote(copy.id);
  };
  document.getElementById('export').onclick = ()=>{
    const blob = new Blob([document.getElementById('contentBox').value], {type:'text/plain'});
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${n.title.replace(/[^a-z0-9]/gi,'_')}.txt`; a.click(); URL.revokeObjectURL(a.href);
  };
  document.getElementById('delete').onclick = async ()=>{
    const linkedTaskCount = db.tasks.filter(t=> t.noteId === n.id && !t.deletedAt).length;
    const taskNote = linkedTaskCount ? (n.type === 'daily'
      ? ` This daily page has ${linkedTaskCount} task${linkedTaskCount!==1?'s':''} — they will be DETACHED (preserved, reattach on restore).`
      : ` ${linkedTaskCount} task${linkedTaskCount!==1?'s':''} will be moved to Trash and can be restored from Review.`) : '';
    const ok = await showConfirm(`Delete this note?${taskNote}`, 'Delete', 'Cancel');
    if(!ok) return;
    softDeleteNote(n.id);
    // Prefer the user's actual previous view (e.g. People, Notebooks, Vault
    // search results). Fall back to a sensible default by note type only
    // when there's no history (e.g. arrived via deep link).
    _navBackOr(() => {
      if (n.type === 'daily')      { route = 'today'; }
      else if (n.projectId)        { route = 'projects'; }
      else if (n.type === 'idea')  { route = 'ideas'; }
      else                         { route = 'vault'; }
      render();
    });
  };
  const addSketchBtn = document.getElementById('addSketch');
  if(typeof openSketchModal === 'function') addSketchBtn.onclick = ()=> openSketchModal(n.id);

  // Voice button handler
  const addVoiceBtn = document.getElementById('addVoice');
  if(typeof openVoiceModal === 'function' && addVoiceBtn){
    addVoiceBtn.onclick = () => openVoiceModal(n.id);
  }

  // Attachments handling
  // Ensure attachments array exists on note
  if(!n.attachments) n.attachments = [];
  const attachInput = document.getElementById('noteAttachFile');
  const attList = document.getElementById('attachments');

  // Inline images: 🖼️ Image button (file picker) + paste/drag directly into
  // the editor. Both funnel through _uploadAndInsertImage, which embeds a
  // markdown ![]( ) pointer to the out-of-band store — see the comment on
  // that function for why this keeps large images out of data.json.
  wireInlineImagePicker('noteInlineImageFile', 'contentBox');
  wireInlineImagePasteDrop('contentBox');

  function renderAttachmentsList(){
    if(!attList) return;
    if(!n.attachments || n.attachments.length===0){
      attList.innerHTML = '';
      return;
    }
    attList.innerHTML = n.attachments.map(att=>{
      const t = att.type || '';
      const isImg   = t.startsWith('image');
      const isAudio = t.startsWith('audio');
      const isVideo = t.startsWith('video');
      const isPdf   = t === 'application/pdf';
      const isText  = t.startsWith('text');
      const src = attachmentSrc(att);
      let preview;
      if(isImg){
        preview = `<img src="${src}" alt="${htmlesc(att.name)}" loading="lazy"
          style="max-width:100%;max-height:200px;border:1px solid var(--btn-border);border-radius:8px;display:block;" />`;
      } else if(isAudio){
        preview = `<audio controls preload="none" src="${src}" style="width:100%;margin-top:4px;"></audio>
          <div style="font-size:11px;color:var(--muted);margin-top:2px;">${htmlesc(att.name)}</div>`;
      } else if(isVideo){
        preview = `<video controls preload="none" src="${src}"
          style="max-width:100%;max-height:200px;border:1px solid var(--btn-border);border-radius:8px;display:block;"></video>
          <div style="font-size:11px;color:var(--muted);margin-top:2px;">${htmlesc(att.name)}</div>`;
      } else if(isPdf){
        preview = `<a href="${src}" target="_blank" rel="noopener"
          style="display:inline-flex;align-items:center;gap:6px;font-size:13px;">📄 ${htmlesc(att.name)}</a>`;
      } else if(isText){
        preview = `<a href="${src}" download="${htmlesc(att.name)}"
          style="display:inline-flex;align-items:center;gap:6px;font-size:13px;">📝 ${htmlesc(att.name)}</a>`;
      } else {
        // Generic download link for anything else (zip, docx, etc.)
        preview = `<a href="${src}" download="${htmlesc(att.name)}"
          style="display:inline-flex;align-items:center;gap:6px;font-size:13px;">📎 ${htmlesc(att.name)}</a>`;
      }
      return `<div class='row' style='justify-content:space-between;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid var(--btn-border);'>
        <div style='flex:1;min-width:0;'>${preview}</div>
        <button class='btn' data-remove='${att.id}' style='font-size:11px;flex-shrink:0;'>✕ Remove</button>
      </div>`;
    }).join('');
    // Bind remove handlers
    attList.querySelectorAll('[data-remove]').forEach(b=> b.onclick = ()=>{
      const id = b.dataset.remove;
      const removed = n.attachments.find(x=> x.id === id);
      n.attachments = n.attachments.filter(x=> x.id !== id);
      save();
      renderAttachmentsList();
      // Free the on-disk blob for out-of-band attachments (legacy inline-base64
      // records have no server-side file to clean up, so skip the call for those).
      if (removed && !removed.data) {
        fetch('/api/attachments/' + encodeURIComponent(id), { method: 'DELETE', headers: { 'X-Requested-With': 'XMLHttpRequest' } })
          .catch(()=>{ /* non-critical: an orphaned file on disk is harmless */ });
      }
    });
  }
  renderAttachmentsList();
  if(attachInput){
    attachInput.onchange = (e)=>{
      const files = Array.from(e.target.files || []);
      e.target.value = ''; // reset early so the same file can be picked again
      if (!files.length) return;
      // Upload each file to the out-of-band attachment store (keeps data.json
      // small — see uploadAttachmentFile()) then append the small pointer
      // records and save in one shot. If the upload fails (offline/server
      // error) we fall back to the old inline-base64 behavior for that file
      // so attaching still works, just without the size benefit.
      // Reading/uploading them one-at-a-time with separate save() calls causes
      // a race: the debounced persistDB can fire between readers, the server
      // response then replaces db.notes, detaching the `n` reference so later
      // pushes end up on a stale object that is never serialised.
      Promise.all(files.map(file =>
        uploadAttachmentFile(file).catch(async err => {
          console.warn('Out-of-band attachment upload failed, falling back to inline:', err);
          const dataUrl = await readFileAsDataURL(file);
          return { id: uid(), name: file.name, type: file.type, data: dataUrl };
        })
      )).then(newAtts => {
        if (!n.attachments) n.attachments = [];
        newAtts.forEach(att => n.attachments.push(att));
        // Stamp updatedAt so the autosync / persistDB response merges correctly
        // identify this local version as the newest and don't overwrite it.
        n.updatedAt = nowISO();
        // Mark that a local attachment save has occurred so the background-fetch
        // does not overwrite these newly added attachments.
        if (typeof window._notifyAttachmentSaved === 'function') window._notifyAttachmentSaved();
        save();
        renderAttachmentsList();
      });
    };
  }

  // Expose attachment renderer so other modals (e.g., voice, sketch) can refresh attachments
  window._renderAttachments = renderAttachmentsList;

  // Flag set to true the moment any attachment is saved locally (file, sketch, voice).
  // Used to prevent the background-fetch from clobbering a freshly-added attachment.
  let localAttachmentsSaved = false;
  window._notifyAttachmentSaved = () => { localAttachmentsSaved = true; };

  // Background-fetch the latest server state so changes saved on another device
  // (e.g. a voice note recorded on the phone) are visible immediately when this
  // note is opened on the PC.  We update only the attachments on the live `n`
  // object so the editor content is not disturbed.
  // Skip the overwrite if the user has already saved attachments locally in this
  // session to avoid a race that erases just-added sketches / files.
  (async () => {
    try {
      const fresh = await fetchDB();
      if (fresh && Array.isArray(fresh.notes) && !localAttachmentsSaved) {
        const freshNote = fresh.notes.find(x => x.id === id);
        if (freshNote && freshNote.attachments) {
          n.attachments = freshNote.attachments;
          renderAttachmentsList();
        }
      }
    } catch(e) { /* non-critical, local state is still shown */ }
  })();

  // Ensure links array exists on the note
  if(!Array.isArray(n.links)) n.links = [];
  // Linked notes rendering
  const linkListEl = document.getElementById('linkedNotesList');
  function renderLinkedList() {
    if(!linkListEl) return;
    if(!n.links || n.links.length === 0) {
      linkListEl.innerHTML = `<div class='muted' style='font-size:12px;'>No linked notes</div>`;
    } else {
      linkListEl.innerHTML = n.links.map(lid => {
        const ln = db.notes.find(x => x.id === lid);
        return ln ? `<div class='row' style='justify-content:space-between;align-items:center;'>
          <a href='#' data-open-note='${ln.id}' style='flex:1;'>${htmlesc(ln.title)}</a>
          <button class='btn' data-unlink='${lid}' style='font-size:11px;'>✕</button>
        </div>` : '';
      }).join('');
    }
    // Attach handlers
    linkListEl.querySelectorAll('[data-open-note]').forEach(el => {
      el.onclick = (ev) => { ev.preventDefault(); openNote(el.dataset.openNote); };
    });
    linkListEl.querySelectorAll('[data-unlink]').forEach(btn => {
      btn.onclick = () => {
        const idToRemove = btn.dataset.unlink;
        n.links = n.links.filter(x => x !== idToRemove);
        save();
        renderLinkedList();
      };
    });
  }
  renderLinkedList();
  // expose renderer to global so modal can refresh
  window._renderLinkedNotes = renderLinkedList;
  const addLinkBtn = document.getElementById('addLinkBtn');
  if(addLinkBtn) {
    addLinkBtn.onclick = () => {
      openLinkModal(n.id);
    };
  }

  // Initialize markdown view-mode cycle (edit → split → preview → edit).
  // Persists the chosen mode in db.settings.noteViewMode so every note opens
  // the way you left it. Live re-renders the preview as you type in split or
  // preview modes (debounced ~150ms) so Ctrl+Shift+V no longer has to be
  // pressed to refresh.
  const previewEl    = document.getElementById('markdownPreview');
  const contentBoxEl = document.getElementById('contentBox');
  const toggleModeBtn = document.getElementById('toggleModeBtn');
  const paneWrap     = document.getElementById('editorPaneWrap');

  const MODES = ['edit', 'split', 'preview'];
  // Label = the action the button performs (the NEXT mode in the cycle).
  const NEXT_LABEL = { edit: 'Split', split: 'Preview', preview: 'Edit' };

  // Honor saved preference; fall back to edit. On narrow screens, demote
  // 'split' to 'edit' since side-by-side panes are not useful below ~720px.
  const narrow = () => (window.innerWidth || document.documentElement.clientWidth) < 720;
  let currentMode = (db.settings && MODES.includes(db.settings.noteViewMode))
    ? db.settings.noteViewMode : 'edit';
  if (currentMode === 'split' && narrow()) currentMode = 'edit';
  _wireHighlightSelectionPopup(previewEl, contentBoxEl);

  let _previewRaf = 0;
  function renderPreview() {
    if (!previewEl) return;
    // Preserve scroll proportion so live edits don't jump the preview.
    const sH = previewEl.scrollHeight || 1;
    const ratio = previewEl.scrollTop / sH;
    previewEl.innerHTML = markdownToHtml(contentBoxEl.value);
    // Render any ```mermaid blocks (lazy-loads mermaid.js on first sight).
    if (typeof _processMermaid === 'function') _processMermaid(previewEl);
    const newH = previewEl.scrollHeight || 1;
    previewEl.scrollTop = ratio * newH;
  }
  function schedulePreview() {
    if (currentMode === 'edit') return;
    if (_previewRaf) cancelAnimationFrame(_previewRaf);
    _previewRaf = requestAnimationFrame(() => { _previewRaf = 0; renderPreview(); });
  }

  function applyMode(mode) {
    if (!MODES.includes(mode)) mode = 'edit';
    if (mode === 'split' && narrow()) mode = 'preview';
    currentMode = mode;
    if (paneWrap) paneWrap.setAttribute('data-mode', mode);
    if (toggleModeBtn) toggleModeBtn.textContent = NEXT_LABEL[mode];
    if (mode !== 'edit') renderPreview();
    if (mode === 'edit') contentBoxEl.focus();
    else if (mode === 'preview') previewEl.focus();
    // Persist preference (debounced via save()).
    if (db && db.settings) {
      db.settings.noteViewMode = mode;
      save();
    }
  }
  function cycleMode() {
    const i = MODES.indexOf(currentMode);
    const next = MODES[(i + 1) % MODES.length];
    applyMode(next);
  }
  applyMode(currentMode);

  // Live preview while typing.
  if (contentBoxEl) contentBoxEl.addEventListener('input', schedulePreview);

  // Proportional scroll-sync in split mode: editor drives the preview.
  if (contentBoxEl && previewEl) {
    contentBoxEl.addEventListener('scroll', () => {
      if (currentMode !== 'split') return;
      const sh = contentBoxEl.scrollHeight - contentBoxEl.clientHeight;
      if (sh <= 0) return;
      const r = contentBoxEl.scrollTop / sh;
      const psh = previewEl.scrollHeight - previewEl.clientHeight;
      previewEl.scrollTop = r * psh;
    });
  }

  if (toggleModeBtn) toggleModeBtn.onclick = cycleMode;

  // Ctrl+S handler — bound directly to the editable elements so it fires
  // before any browser-level "Save Page" interception, regardless of focus.
  const onCtrlS = (e) => {
    const isCtrl = e.ctrlKey || e.metaKey;
    if(isCtrl && !e.shiftKey && (e.key === 's' || e.key === 'S' || e.code === 'KeyS')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      saveBtn.click();
    }
  };
  // Ctrl+Shift+V cycles Edit → Split → Preview
  const onCtrlShiftV = (e) => {
    if(e.ctrlKey && e.shiftKey && (e.key === 'V' || e.key === 'v' || e.code === 'KeyV')) {
      e.preventDefault();
      cycleMode();
    }
  };
  // Bind to the actual input elements — most reliable: fires before browser shortcuts
  const titleEl = document.getElementById('title');
  if(contentBoxEl) { contentBoxEl.addEventListener('keydown', onCtrlS); contentBoxEl.addEventListener('keydown', onCtrlShiftV); }
  if(titleEl)      { titleEl.addEventListener('keydown', onCtrlS); titleEl.addEventListener('keydown', onCtrlShiftV); }
  if(previewEl)    { previewEl.setAttribute('tabindex','0'); previewEl.addEventListener('keydown', onCtrlS); previewEl.addEventListener('keydown', onCtrlShiftV); }
  // Also capture on document+window as belt-and-suspenders
  if(window._noteKeyHandler) {
    document.removeEventListener('keydown', window._noteKeyHandler, true);
    window.removeEventListener('keydown', window._noteKeyHandler, true);
    window._noteKeyHandler = null;
  }
  document.addEventListener('keydown', onCtrlS, { capture: true, passive: false });
  window.addEventListener('keydown', onCtrlS,   { capture: true, passive: false });
  window._noteKeyHandler = onCtrlS;
}

// --- Sketch modal functionality ---
// Opens a modal with a canvas for drawing sketches. Users can draw with touch or mouse,
// choose brush color and size, undo strokes, clear the canvas, and insert the drawing
// into the current note or draft as a Markdown image. The modal uses elements defined
// in index.html with IDs: sketchModal, sketchPad, sketchColor, sketchSize, sketchUndo,
// sketchClear, sketchInsert and sketchClose.
function openSketchModal(noteId) {
  const modal = document.getElementById('sketchModal');
  const canvas = document.getElementById('sketchPad');
  if (!modal || !canvas) return;
  const ctx = canvas.getContext('2d');
  const colorInput = document.getElementById('sketchColor');
  const sizeInput = document.getElementById('sketchSize');
  const undoBtn = document.getElementById('sketchUndo');
  const clearBtn = document.getElementById('sketchClear');
  const insertBtn = document.getElementById('sketchInsert');
  const closeBtn = document.getElementById('sketchClose');
  // Drawing state
  let drawing = false;
  let lines = [];
  let currentLine = [];
  let brushColor = colorInput ? colorInput.value : '#ffffff';
  let brushSize = sizeInput ? parseInt(sizeInput.value, 10) : 3;
  // Resize canvas to fit its container while preserving aspect ratio
  function resizeCanvas() {
    const rect = canvas.parentElement.getBoundingClientRect();
    const maxWidth = rect.width - 32; // leave padding
    const ratio = canvas.height / canvas.width;
    canvas.width = maxWidth > 0 ? maxWidth : 600;
    canvas.height = canvas.width * ratio;
    // Clear and redraw existing lines
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    lines.forEach(line => {
      ctx.strokeStyle = line.color;
      ctx.lineWidth = line.size;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      line.points.forEach((pt, idx) => {
        if (idx === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      });
      ctx.stroke();
    });
  }
  // Convert pointer/touch event to canvas coordinates
  function getCanvasPos(e) {
    const rect = canvas.getBoundingClientRect();
    let clientX, clientY;
    if (e.touches && e.touches.length) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }
    return { x: clientX - rect.left, y: clientY - rect.top };
  }
  function startDrawing(e) {
    e.preventDefault();
    drawing = true;
    currentLine = [];
    const pos = getCanvasPos(e);
    currentLine.push(pos);
  }
  function draw(e) {
    if (!drawing) return;
    e.preventDefault();
    const pos = getCanvasPos(e);
    currentLine.push(pos);
    const len = currentLine.length;
    if (len > 1) {
      const p1 = currentLine[len - 2];
      const p2 = currentLine[len - 1];
      ctx.strokeStyle = brushColor;
      ctx.lineWidth = brushSize;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }
  }
  function stopDrawing(e) {
    if (!drawing) return;
    e.preventDefault();
    drawing = false;
    if (currentLine.length) {
      lines.push({ points: currentLine.slice(), color: brushColor, size: brushSize });
    }
  }
  function undoStroke() {
    if (!lines.length) return;
    lines.pop();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    lines.forEach(line => {
      ctx.strokeStyle = line.color;
      ctx.lineWidth = line.size;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      line.points.forEach((pt, idx) => {
        if (idx === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      });
      ctx.stroke();
    });
  }
  function clearCanvas() {
    lines = [];
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  function closeModal() {
    modal.style.display = 'none';
    canvas.removeEventListener('pointerdown', startDrawing);
    canvas.removeEventListener('pointermove', draw);
    canvas.removeEventListener('pointerup', stopDrawing);
    canvas.removeEventListener('pointerleave', stopDrawing);
    canvas.removeEventListener('touchstart', startDrawing);
    canvas.removeEventListener('touchmove', draw);
    canvas.removeEventListener('touchend', stopDrawing);
    if (undoBtn) undoBtn.removeEventListener('click', undoStroke);
    if (clearBtn) clearBtn.removeEventListener('click', clearCanvas);
    if (insertBtn) insertBtn.removeEventListener('click', handleInsert);
    if (closeBtn) closeBtn.removeEventListener('click', closeModal);
    if (colorInput) colorInput.removeEventListener('change', updateColor);
    if (sizeInput) sizeInput.removeEventListener('change', updateSize);
  }
  function handleInsert() {
    const dataURL = canvas.toDataURL('image/png');
    // If inserting into an existing note, attach as an attachment rather than inline markdown
    if (noteId === '__draft__') {
      // For drafts, accumulate sketches as attachments in a global array. These will
      // be applied as attachments when the draft is saved. Do not insert
      // markdown into the draft content.
      if (!window._draftSketches) window._draftSketches = [];
      const sketchName = `Sketch ${window._draftSketches.length + 1}.png`;
      window._draftSketches.push({ id: uid(), name: sketchName, type: 'image/png', data: dataURL });
    } else {
      // For an existing note, attach the sketch directly to the note's attachments array.
      const note = db.notes.find(n => n.id === noteId);
      if (note) {
        if (!note.attachments) note.attachments = [];
        const sketchName = `Sketch ${note.attachments.length + 1}.png`;
        note.attachments.push({ id: uid(), name: sketchName, type: 'image/png', data: dataURL });
        // Stamp updatedAt so merge logic knows local is newest, preventing overwrite.
        note.updatedAt = nowISO();
        // Notify openNote's background-fetch guard so it won't overwrite this new sketch.
        if (typeof window._notifyAttachmentSaved === 'function') window._notifyAttachmentSaved();
        save();
        // Trigger global attachment re-renderer if available to ensure voice/sketch coexist
        if (typeof window._renderAttachments === 'function') {
          window._renderAttachments();
        }
      }
    }
    closeModal();
  }
  function updateColor() { brushColor = colorInput.value; }
  function updateSize() { brushSize = parseInt(sizeInput.value, 10) || 3; }
  // Show modal and set canvas size
  modal.style.display = 'flex';
  resizeCanvas();
  // Attach listeners
  canvas.addEventListener('pointerdown', startDrawing);
  canvas.addEventListener('pointermove', draw);
  canvas.addEventListener('pointerup', stopDrawing);
  canvas.addEventListener('pointerleave', stopDrawing);
  canvas.addEventListener('touchstart', startDrawing, { passive: false });
  canvas.addEventListener('touchmove', draw, { passive: false });
  canvas.addEventListener('touchend', stopDrawing);
  if (undoBtn) undoBtn.addEventListener('click', undoStroke);
  if (clearBtn) clearBtn.addEventListener('click', clearCanvas);
  if (insertBtn) insertBtn.addEventListener('click', handleInsert);
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (colorInput) colorInput.addEventListener('change', updateColor);
  if (sizeInput) sizeInput.addEventListener('change', updateSize);
  // Resize canvas on window resize
  window.addEventListener('resize', resizeCanvas, { once: true });
}

// --- Global app logic ---
function render(){
  // Always scroll to top when switching views — prevents the new page from
  // inheriting the scroll position of the previous one.
  try { window.scrollTo({top:0, left:0, behavior:'instant'}); } catch(_) { window.scrollTo(0,0); }
  if (content) content.scrollTop = 0;
  // When rendering a new section (today, projects, ideas, etc.), we are no longer editing a note.
  // Reset the open note tracking so that background sync will not reopen a note when the user has navigated away.
  window._openNoteId = null;
  window._editorDirty = false;
  window._doSaveNote = null;
  
  // Clean up note-specific keyboard shortcuts
  if(window._noteKeyHandler) {
    document.removeEventListener('keydown', window._noteKeyHandler, true);
    window.removeEventListener('keydown', window._noteKeyHandler, true);
    window._noteKeyHandler = null;
  }

  // Clean up Today page shortcut handler when leaving Today view.
  if(window._todayKeyHandler) {
    document.removeEventListener('keydown', window._todayKeyHandler, true);
    window._todayKeyHandler = null;
  }
  // Clean up notebook page Ctrl+S handler when navigating away from Notebooks
  if(window._pgKeyHandler) {
    document.removeEventListener('keydown', window._pgKeyHandler, true);
    document.removeEventListener('keydown', window._pgKeyHandler);
    window._pgKeyHandler = null;
  }
  
  // Apply current theme before rendering UI elements
  applyTheme();
  renderNav();
  // Keep the window-mirrored route in sync for deferred modules.
  window.route = route;
  if(route==='today') renderToday();
  else if(route==='projects') renderProjects();
  else if(route==='ideas') renderIdeas();
  else if(route==='links') renderLinks(); // NEW
  else if(route==='notebooks') renderNotebooks();
  else if(route==='research') {
    if (typeof window.renderResearch === 'function') {
      window.renderResearch();
    } else {
      // research-mode.js is loaded with `defer` and its init() polls for
      // window.db. On a hard reload that lands on this route, render() can
      // run before the module registers window.renderResearch — previously
      // we painted a static "loading…" placeholder and never retried, so
      // the view hung forever. Poll until the module appears, then render.
      content.innerHTML = '<p style="padding:24px;">Research module loading…</p>';
      let _tries = 0;
      (function _retry(){
        if (route !== 'research') return;            // user navigated away
        if (typeof window.renderResearch === 'function') {
          try { window.renderResearch(); } catch(e){ console.error('renderResearch', e); }
          return;
        }
        if (++_tries > 50) {                         // ~10s ceiling
          content.innerHTML = '<p style="padding:24px;color:#f88;">Research module failed to load. Reload the page or check the console.</p>';
          return;
        }
        setTimeout(_retry, 200);
      })();
    }
  }
  else if(route==='vault') renderVault();
  else if(route==='monthly') renderMonthly();
  else if(route==='review') renderReview();
  else if(route==='map') renderMap(); // handle map view
  else if(route==='people') renderPeople();
  else if(route==='journal') renderJournalHistory();
  // Update mobile bar active states
  const mb = document.getElementById('mobileBar');
  if(mb){
    mb.querySelectorAll('button[data-nav]').forEach(b=>{
      if(b.dataset.nav===route) b.classList.add('active'); else b.classList.remove('active');
    });
  }
  // Show selected daily date (or today) in sidebar
  const todayDisplayEl = document.getElementById('todayStr');
  if(todayDisplayEl){
    const sel = selectedDailyDate || todayKey();
    if(sel===todayKey()) todayDisplayEl.textContent = new Date().toDateString();
    else todayDisplayEl.textContent = new Date(sel+'T00:00:00').toDateString();
  }
  document.getElementById("dailyRollover").checked = !!db.settings.rollover;
  document.getElementById("dailyRollover").onchange = ()=>{ db.settings.rollover = document.getElementById("dailyRollover").checked; save(); };
  const autoCarryEl = document.getElementById("autoCarryTasks");
  if(autoCarryEl){
    autoCarryEl.checked = !!db.settings.autoCarryTasks;
    autoCarryEl.onchange = ()=>{ db.settings.autoCarryTasks = autoCarryEl.checked; save(); };
  }

  // Bind auto-reload toggle. If undefined, default to true for legacy DBs.
  const autoReloadEl = document.getElementById('autoReload');
  if(autoReloadEl){
    if(typeof db.settings.autoReload === 'undefined') db.settings.autoReload = false; // stability default OFF
    autoReloadEl.checked = !!db.settings.autoReload;
    autoReloadEl.onchange = () => { db.settings.autoReload = autoReloadEl.checked; save(); };
  }
  const dateInput = document.getElementById('dailyDateNav');
  if(dateInput){
    dateInput.value = selectedDailyDate;
    const prevBtn = document.getElementById('prevDay');
    const nextBtn = document.getElementById('nextDay');
    const today = todayKey();
    // Use local-date arithmetic (split string → Date(y,m,d)) to avoid the UTC-midnight
    // offset bug where new Date("YYYY-MM-DD") parses as UTC and getDate() returns the
    // wrong local day for users in negative-offset timezones.
    const localDateStr = (d) => d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    prevBtn.onclick = ()=>{ const [y,mo,d]=selectedDailyDate.split('-').map(Number); selectedDailyDate=localDateStr(new Date(y,mo-1,d-1)); route='today'; render(); };
    nextBtn.onclick = ()=>{ if(selectedDailyDate===today) return; const [y,mo,d]=selectedDailyDate.split('-').map(Number); const newKey=localDateStr(new Date(y,mo-1,d+1)); if(newKey>today) return; selectedDailyDate=newKey; route='today'; render(); };
    dateInput.onchange = ()=>{ const v=dateInput.value; if(v){ const today=todayKey(); selectedDailyDate = v>today? today : v; route='today'; render(); } };
    nextBtn.disabled = (selectedDailyDate===today);
    nextBtn.style.opacity = nextBtn.disabled? .4 : 1;
  }
  const scratchEl = document.getElementById("scratch");
  if(scratchEl){
    // Populate scratchpad with the draft if available, otherwise from settings.
    // Without using scratchDraft, the scratchpad would reset to the last saved
    // value on every render, causing characters typed during rapid
    // interactions to be lost.
    scratchEl.value = (typeof scratchDraft === 'string' && scratchDraft.length > 0) ? scratchDraft : (db.settings.scratchpad || "");
    scratchEl.oninput = ()=>{
      scratchDraft = scratchEl.value;
      db.settings.scratchpad = scratchEl.value;
      // Immediately persist scratch changes; do not rely on debounced save
      // so that refreshes pick up the latest value.
      persistDB();
    };
  }
  if(!db.settings.seenTip){ const t = document.getElementById("tip"); t.style.display="block"; document.getElementById("closeTip").onclick = ()=>{ db.settings.seenTip=true; save(); t.style.display="none"; }; }

  // Only auto-focus the search box on the Vault page, where typing-into-search
  // is the primary action. On every other route this stole focus from the
  // body and blocked all keyboard shortcuts (Alt+I, Alt+P, Alt+N, etc.) until
  // the user clicked into the canvas. Press `/` from anywhere to grab search.
  if (route === 'vault') {
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body || active === document.documentElement) {
        const q = document.getElementById('q');
        if (q) q.focus();
      }
    });
  }
}
document.getElementById("addProject").onclick = ()=> { const name = document.getElementById("newProjectName").value.trim(); if(!name) return; const p = createProject(name); document.getElementById("newProjectName").value=""; currentProjectId = p.id; route='projects'; render(); drawProjectsSidebar(); };
// Allow pressing Enter in the New Project input to trigger Add
{
  const projInput = document.getElementById('newProjectName');
  if(projInput){
    projInput.addEventListener('keydown', e=>{ if(e.key === 'Enter') document.getElementById('addProject').click(); });
  }
}

// --- Voice recorder modal ---
function openVoiceModal(noteId) {
  const modal = document.getElementById('voiceModal');
  if (!modal) return;
  const startBtn = document.getElementById('voiceStart');
  const stopBtn = document.getElementById('voiceStop');
  const insertBtn = document.getElementById('voiceInsert');
  const closeBtn = document.getElementById('voiceClose');
  const previewEl = document.getElementById('voicePreview');
  const timerEl = document.getElementById('voiceTimer');
  // Recording state
  let chunks = [];
  let recordedBlob = null;      // the last complete recorded Blob (set in onstop)
  let mediaRecorder = null;
  let timerInterval = null;
  let startTime = 0;
  const MAX_RECORDING_SECS = 10 * 60; // 10-minute hard limit
  // Update timer display, auto-stop at limit
  function updateTimer() {
    const elapsed = Date.now() - startTime;
    const secs = Math.floor(elapsed / 1000);
    if (secs >= MAX_RECORDING_SECS) {
      // Auto-stop: call stopBtn click to go through normal onstop path
      if (stopBtn && !stopBtn.disabled) stopBtn.click();
      return;
    }
    const mins = String(Math.floor(secs / 60)).padStart(2, '0');
    const sec = String(secs % 60).padStart(2, '0');
    if (timerEl) timerEl.textContent = `${mins}:${sec}`;
  }
  // Reset state
  function reset() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      try { mediaRecorder.stop(); } catch (err) { }
    }
    chunks = [];
    recordedBlob = null;
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    if (timerEl) {
      timerEl.textContent = '00:00';
      timerEl.classList.remove('rec-active');
    }
    if (startBtn) startBtn.disabled = false;
    if (stopBtn) stopBtn.disabled = true;
    if (insertBtn) insertBtn.disabled = true;
    if (previewEl) previewEl.src = '';
    // Clear the fallback file input value so that subsequent recordings can re-trigger capture
    const fallbackInput = document.getElementById('voiceFileFallback');
    if (fallbackInput) fallbackInput.value = '';
  }
  if (closeBtn) {
    closeBtn.onclick = () => {
      reset();
      modal.style.display = 'none';
      modal.classList.remove('show');
    };
  }
  if (startBtn) {
    // Feature detection and fallback: attempt to use MediaRecorder on secure origins. Otherwise, fall back to
    // a file input that triggers the native recorder (works on most mobile browsers).
    startBtn.onclick = async () => {
      // Determine if the environment is considered secure for getUserMedia (https or localhost). Some mobile
      // browsers block microphone access on file:// or custom origins.
      const isSecure = (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1');
      const hasMediaRecorder = typeof window.MediaRecorder !== 'undefined';
      // Helper to check supported MIME types when MediaRecorder is available
      const supportsType = (t) => {
        try {
          return hasMediaRecorder && window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(t);
        } catch (e) {
          return false;
        }
      };
      // Preferred MIME types in order of common support: modern Chrome/Edge uses webm; Safari often uses mp4.
      const preferredTypes = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/ogg;codecs=opus'
      ];
      const chosenType = preferredTypes.find(supportsType) || '';
      const fallbackInput = document.getElementById('voiceFileFallback');

      // If MediaRecorder API is completely unavailable, go straight to file picker
      if (!hasMediaRecorder) {
        if (fallbackInput) {
          fallbackInput.click();
        } else {
          alert('Recording is not supported in this browser.');
        }
        return;
      }
      try {
        // Request microphone stream — will throw on non-secure origins or if permission denied
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Initialize MediaRecorder with supported MIME type if provided
        mediaRecorder = chosenType ? new MediaRecorder(stream, { mimeType: chosenType }) : new MediaRecorder(stream);
        mediaRecorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunks.push(e.data);
        };
        mediaRecorder.onstop = () => {
          // When recording stops, create blob and preview
          const blobType = chosenType || 'audio/webm';
          recordedBlob = new Blob(chunks, { type: blobType });
          const url = URL.createObjectURL(recordedBlob);
          if (previewEl) previewEl.src = url;
          if (insertBtn) insertBtn.disabled = false;
          if (timerEl) timerEl.classList.remove('rec-active');
          // Stop capturing from microphone
          stream.getTracks().forEach(t => t.stop());
        };
        // Reset chunks and start recording
        recordedBlob = null;
        chunks = [];
        mediaRecorder.start();
        startTime = Date.now();
        timerInterval = setInterval(updateTimer, 200);
        startBtn.disabled = true;
        if (timerEl) timerEl.classList.add('rec-active');
        if (stopBtn) stopBtn.disabled = false;
        if (insertBtn) insertBtn.disabled = true;
      } catch (err) {
        // Microphone access failed (permission denied, non-secure origin, etc.)
        // Offer file picker as alternative so user can attach a pre-recorded audio file
        const msg = !isSecure
          ? 'Microphone recording requires accessing the app via localhost or HTTPS.\nYou can instead pick an audio file from your device.'
          : 'Could not access microphone: ' + err.message + '\nYou can instead pick an audio file.';
        alert(msg);
        if (fallbackInput) fallbackInput.click();
      }
    };
  }
  if (stopBtn) {
    stopBtn.onclick = () => {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
        if (timerInterval) {
          clearInterval(timerInterval);
          timerInterval = null;
        }
        stopBtn.disabled = true;
      }
    };
  }
  async function blobToDataURL(blob) {
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
  if (insertBtn) {
    insertBtn.onclick = async () => {
      if (!recordedBlob) return;
      const mimeType = recordedBlob.type.split(';')[0] || 'audio/webm';
      const ext = (mimeType.split('/')[1] || 'webm');
      const dataUrl = await blobToDataURL(recordedBlob);
      const name = `Voice ${new Date().toLocaleString()}.${ext}`;
      if (noteId === '__draft__') {
        if (!window._draftVoices) window._draftVoices = [];
        window._draftVoices.push({ id: uid(), name, type: mimeType, data: dataUrl });
      } else {
        const note = db.notes.find(n => n.id === noteId);
        if (note) {
          if (!note.attachments) note.attachments = [];
          note.attachments.push({ id: uid(), name, type: mimeType, data: dataUrl });
          // Stamp updatedAt so merge logic knows local is newest, preventing overwrite.
          note.updatedAt = nowISO();
          // Notify openNote's background-fetch guard so it won't overwrite this new voice note.
          if (typeof window._notifyAttachmentSaved === 'function') window._notifyAttachmentSaved();
          save();
        }
      }
      // Refresh attachment list via the canonical renderer registered by openNote()
      if (noteId !== '__draft__' && typeof window._renderAttachments === 'function') {
        window._renderAttachments();
      }
      reset();
      modal.style.display = 'none';
      modal.classList.remove('show');
    };
  }

  // Fallback input change handler: triggered when the user records audio via native recorder (file input capture).
  {
    const fallbackInput = document.getElementById('voiceFileFallback');
    if (fallbackInput) {
      fallbackInput.onchange = async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        // Clear previous timer and reset UI
        if (timerInterval) {
          clearInterval(timerInterval);
          timerInterval = null;
        }
        if (timerEl) timerEl.textContent = '00:00';
        // Create a clone of the blob to maintain consistent type property
        const arrayBuffer = await file.arrayBuffer();
        const blobClone = new Blob([arrayBuffer], { type: file.type || 'audio/mp4' });
        // Store as recordedBlob so insertBtn handler can use it (and chunks for legacy compat)
        recordedBlob = blobClone;
        chunks = [blobClone];
        // Update preview
        const url = URL.createObjectURL(blobClone);
        if (previewEl) previewEl.src = url;
        // Enable insert button
        if (insertBtn) insertBtn.disabled = false;
        // Ensure buttons reflect idle state
        if (startBtn) startBtn.disabled = false;
        if (stopBtn) stopBtn.disabled = true;
        // Clear the file input value so the same file can be recorded again later
        fallbackInput.value = '';
      };
    }
  }
  // Show modal
  modal.style.display = 'flex';
  modal.classList.add('show');
}
document.getElementById("newDaily").onclick = createOrOpenDaily;
document.getElementById("newNoteBtn").onclick = ()=> {
  (async ()=>{
    const t = await showPrompt('New note title', '', 'Create', 'Cancel');
    if(!t) return;
    const n = createNote({title: t});
    openNote(n.id);
  })();
};

// Theme toggle handler
const themeToggleBtn = document.getElementById('themeToggle');
if(themeToggleBtn){
  themeToggleBtn.onclick = ()=>{
    if(!db || !db.settings) return;
    const current = db.settings.theme || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    db.settings.theme = next;
    save();
    applyTheme();
  };
}

// Global Tab key handler: insert two spaces instead of moving focus when editing text
// This improves note-taking experience by allowing quick indentation in notes,
// tasks and scratchpad fields. Only triggers for textarea and text input elements.
// Skips the 4 textareas that editor-extras.js already manages (contentBox,
// pgContent, dailyContent, dailyNewContent) — that file has its own, richer
// Tab-indent (multi-line block indent/outdent) wired to the same keydown
// event; without this guard BOTH handlers fired on every Tab press, which
// silently double-indented (4 spaces instead of 2) and, worse, this handler
// used to mutate `.value` directly, which completely destroys the browser's
// native undo/redo stack. Kept here (now undo-safe via execCommand) only for
// the handful of plain textareas/inputs that aren't in editor-extras.js's list.
const _EDITOR_EXTRAS_MANAGED_IDS = ['contentBox', 'pgContent', 'dailyContent', 'dailyNewContent'];
document.addEventListener('keydown', (e) => {
  if(e.key === 'Tab'){
    const el = e.target;
    if(el && _EDITOR_EXTRAS_MANAGED_IDS.includes(el.id)) return; // editor-extras.js owns these
    if(el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text'))){
      e.preventDefault();
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const insertion = '  '; // two spaces
      el.focus();
      el.setSelectionRange(start, end);
      let ok = false;
      try { ok = document.execCommand('insertText', false, insertion); } catch(_) { ok = false; }
      if(!ok){
        const value = el.value;
        el.value = value.slice(0, start) + insertion + value.slice(end);
        const cursor = start + insertion.length;
        el.selectionStart = el.selectionEnd = cursor;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  }
});

// Template management
document.getElementById("manageTemplates").onclick = ()=> {
  content.innerHTML = `
    <div class="card">
      <strong>📝 Manage Templates</strong>
      <div class="row" style="margin-top:8px;">
        <input id="templateName" type="text" placeholder="Template name"/>
        <button id="addTemplate" class="btn acc">Add Template</button>
      </div>
      <div style="margin-top:8px;">
        <textarea id="templateContent" placeholder="Template content..."></textarea>
      </div>
    </div>
    <div class="list" id="templateList">
      ${db.templates.map(t=>`
        <div class="card">
          <div class="row" style="justify-content:space-between;">
            <strong>${htmlesc(t.name)}</strong>
            <button class="btn" data-del="${t.id}">Delete</button>
          </div>
          <div class="muted" style="margin-top:4px;">${htmlesc(t.content.slice(0,100))}...</div>
        </div>
      `).join("")}
    </div>
    <div style="margin-top:16px;">
      <button class="btn" onclick="render()">← Back</button>
    </div>`;
    
  document.getElementById("addTemplate").onclick = ()=>{
    const name = document.getElementById("templateName").value.trim();
    const content = document.getElementById("templateContent").value.trim();
    if(!name || !content) return;
    createTemplate(name, content);
    document.getElementById("templateName").value = "";
    document.getElementById("templateContent").value = "";
    document.getElementById("manageTemplates").click(); // Refresh
  };
  
  // Scope to #templateList to avoid accidentally rebinding delete handlers
  // on other elements (notes, tasks, links) that also use data-del attributes.
  document.getElementById('templateList').querySelectorAll("[data-del]").forEach(b=> b.onclick = ()=>{
    (async ()=>{
      const ok = await showConfirm('Delete this template?', 'Delete', 'Cancel');
      if(!ok) return;
      db.templates = db.templates.filter(t => t.id !== b.dataset.del);
      save();
      document.getElementById('manageTemplates').click(); // Refresh
    })();
  });
};

document.addEventListener('DOMContentLoaded', () => {
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      // This will hit the /logout route you added on the server
      window.location.href = '/logout';
    });
  }
});


// Search
document.getElementById("q").addEventListener("input", ()=> { if(route!=="vault"){ route="vault"; render(); } else renderVault(); });

// Press `/` from anywhere (when not already in an input) to focus search.
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  const tag = (t && t.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || (t && t.isContentEditable)) return;
  e.preventDefault();
  const q = document.getElementById('q');
  if (q) { q.focus(); q.select(); }
});

// Quick add
document.addEventListener("keydown", (e)=>{
  // Quick Capture: Alt+N. We avoid Ctrl+Shift+N because the browser captures
  // that combo at the OS level to open an incognito/private window before any
  // page handler ever runs. Alt+N reaches us cleanly on every major browser.
  if(e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey &&
     (e.key === 'n' || e.key === 'N')){
    e.preventDefault();
    openQuickCapture();
    return;
  }
  // Quick task: Alt+T (was Ctrl+Shift+K, which some browsers also map).
  if(e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey &&
     (e.key === 't' || e.key === 'T')){
    e.preventDefault();
    openQuickCapture('!');
    return;
  }
});

// --- Quick Capture floating bar ---
// Single low-friction input reachable from anywhere. Prefix grammar:
//   (default)       → idea note (with #tags extracted)
//   "! something"   → high-priority task on today's daily
//   ". something"   → normal task on today's daily
//   "> Title"       → full note (opens editor immediately)
//   "j something"   → appended to today's Journal section
function openQuickCapture(prefill=''){
  // Build the panel once and reuse.
  let panel = document.getElementById('quickCapturePanel');
  if(!panel){
    panel = document.createElement('div');
    panel.id = 'quickCapturePanel';
    panel.innerHTML = `
      <div class="qc-backdrop"></div>
      <div class="qc-panel" role="dialog" aria-label="Quick capture">
        <input id="qcInput" type="text" autocomplete="off" spellcheck="false"
          placeholder="Capture anything…" />
        <div class="qc-legend" aria-hidden="true">
          <span><kbd>!</kbd> high-priority task</span>
          <span><kbd>.</kbd> task</span>
          <span><kbd>&gt;</kbd> full note</span>
          <span><kbd>j</kbd> journal</span>
          <span><kbd>#tag</kbd> idea + tag</span>
          <span class="qc-legend-default">(default → idea)</span>
        </div>
        <div class="qc-hint" id="qcHint">Idea</div>
      </div>`;
    document.body.appendChild(panel);
    panel.querySelector('.qc-backdrop').onclick = closeQuickCapture;
  }
  panel.classList.add('show');
  const input = panel.querySelector('#qcInput');
  const hint  = panel.querySelector('#qcHint');
  input.value = prefill;
  // Focus AFTER paint so the cursor lands inside reliably.
  requestAnimationFrame(()=> { input.focus(); input.setSelectionRange(input.value.length, input.value.length); });
  const detect = v => {
    const s = (v||'').trimStart();
    if(s.startsWith('!')) return 'High-priority task → Today';
    if(s.startsWith('.')) return 'Task → Today';
    if(s.startsWith('>')) return 'New full note (opens editor)';
    if(s.startsWith('j ') || s.startsWith('J ')) return 'Append to today\'s Journal';
    return 'Idea note';
  };
  hint.textContent = detect(input.value);
  input.oninput = () => { hint.textContent = detect(input.value); };
  input.onkeydown = (ev) => {
    if(ev.key === 'Escape'){ ev.preventDefault(); closeQuickCapture(); return; }
    if(ev.key === 'Enter'){
      ev.preventDefault();
      const raw = input.value.trim();
      if(!raw){ closeQuickCapture(); return; }
      submitQuickCapture(raw);
      closeQuickCapture();
    }
  };
}
function closeQuickCapture(){
  const panel = document.getElementById('quickCapturePanel');
  if(panel) panel.classList.remove('show');
}
function submitQuickCapture(raw){
  const s = raw.trimStart();
  // Helper: ensure today's daily exists and return it
  const ensureToday = () => {
    const key = todayKey();
    let daily = db.notes.find(n => n.type === 'daily' && !n.deletedAt && n.dateIndex === key);
    if(!daily){
      const tpl = db.settings.dailyTemplate || "# Top 3\n- [ ] \n- [ ] \n- [ ] \n\n## Tasks\n\n## Journal\n\n## Wins\n";
      daily = createNote({title:`${key} — Daily`, type:'daily', dateIndex:key, content:tpl});
    }
    return daily;
  };
  if(s.startsWith('!') || s.startsWith('.')){
    const daily = ensureToday();
    const priority = s.startsWith('!') ? 'high' : 'medium';
    createTask({title: s.slice(1).trim(), noteId: daily.id, priority});
    showQuickToast(priority === 'high' ? '🔥 Task added' : '✓ Task added');
    if(route === 'today') render();
    return;
  }
  if(s.startsWith('>')){
    const title = s.slice(1).trim() || 'Untitled';
    const n = createNote({title, content:'', type:'note'});
    openNote(n.id);
    return;
  }
  if(s.startsWith('j ') || s.startsWith('J ')){
    const daily = ensureToday();
    const stamp = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    const line = `- ${stamp} — ${s.slice(2).trim()}`;
    // Detect an existing "## Journal" heading. The previous regex
    // /^|\n## Journal\b/m was buggy (the `^|` alternation matches the start
    // of any line and is always true), so when no heading existed the entry
    // was silently dropped. Use a clean anchored test instead.
    if(/^##\s+Journal\b/m.test(daily.content)){
      // Insert immediately after the "## Journal" heading line.
      daily.content = daily.content.replace(
        /(^|\n)(##\s+Journal[^\n]*)(\n?)/,
        (_m, p1, p2)=> `${p1}${p2}\n${line}\n`
      );
    } else {
      // No heading yet — append a fresh Journal section so the entry is
      // guaranteed to land somewhere visible on today's daily.
      const sep = (daily.content || '').endsWith('\n') ? '\n' : '\n\n';
      daily.content = (daily.content || '') + `${sep}## Journal\n${line}\n`;
    }
    daily.updatedAt = nowISO();
    save();
    showQuickToast('📓 Added to today\'s Journal');
    if(route === 'today') render();
    return;
  }
  // Default: idea note (extract #tags)
  const tags = (s.match(/#[\w-]+/g) || []).map(t => t.slice(1));
  const titleClean = s.replace(/#[\w-]+/g,'').trim() || 'Idea';
  createNote({title: titleClean, content:'', type:'idea', tags});
  showQuickToast('💡 Idea saved');
  if(route === 'ideas') render();
}
function showQuickToast(text){
  let t = document.getElementById('qcToast');
  if(!t){
    t = document.createElement('div');
    t.id = 'qcToast';
    document.body.appendChild(t);
  }
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(window._qcToastT);
  window._qcToastT = setTimeout(()=> t.classList.remove('show'), 1800);
}

// Export
// Make this DOMContentLoaded handler asynchronous so we can await
// initialization functions such as initApp(). Without the async keyword,
// using await inside will cause a syntax error.
document.addEventListener('DOMContentLoaded', async () => {
  const exportBtn = document.getElementById('exportBtn');
  if(exportBtn){
    exportBtn.onclick = ()=>{
      const blob = new Blob([JSON.stringify(db, null, 2)], {type:'application/json'});
      const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`ultranote-backup-${new Date().toISOString().slice(0,10)}.json`; a.click(); URL.revokeObjectURL(a.href);
    };
  }
  const importFile = document.getElementById('importFile');
  if(importFile){
    importFile.addEventListener('change', (e)=>{
      const file = e.target.files[0]; if(!file) return;
      const reader = new FileReader();
      reader.onload = async ()=>{
        try{
          const data = JSON.parse(reader.result);
          if(!data.notes || !data.tasks) throw new Error('Invalid backup file');
          db = data; await persistDB(); location.reload();
        }catch(err){ alert('Import failed: '+err.message); }
      }; reader.readAsText(file);
    });
  }
  // Mobile nav & drawer bindings
  const mobileBar = document.getElementById('mobileBar');
  if(mobileBar && !mobileBar.dataset.bound){
    mobileBar.addEventListener('click', e=>{
      const btn = e.target.closest('button[data-nav]');
      if(!btn) return;
      route = btn.dataset.nav;
      if(route==='today') selectedDailyDate = todayKey();
      render();
    });
    mobileBar.dataset.bound='1';
  }
  const menuBtn = document.getElementById('menuToggle');
  if(menuBtn && !menuBtn.dataset.bound){
    menuBtn.onclick = (e)=>{ e.stopPropagation(); document.body.classList.toggle('drawer-open'); };
    menuBtn.dataset.bound='1';
  }
  // Desktop sidebar collapse toggle (#sidebarToggle in the header).
  // State persists across reloads via localStorage; Ctrl+\ also toggles.
  const sidebarBtn = document.getElementById('sidebarToggle');
  const SIDEBAR_KEY = 'ultranote-sidebar-collapsed';
  const applyCollapsed = (v) => {
    document.body.classList.toggle('sidebar-collapsed', !!v);
    if (sidebarBtn) sidebarBtn.setAttribute('aria-pressed', v ? 'true' : 'false');
  };
  try { applyCollapsed(localStorage.getItem(SIDEBAR_KEY) === '1'); } catch(_){}
  if (sidebarBtn && !sidebarBtn.dataset.bound) {
    sidebarBtn.onclick = () => {
      const next = !document.body.classList.contains('sidebar-collapsed');
      applyCollapsed(next);
      try { localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0'); } catch(_){}
    };
    sidebarBtn.dataset.bound = '1';
  }
  if (!window._sidebarShortcutBound) {
    window._sidebarShortcutBound = true;
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === '\\') {
        e.preventDefault();
        if (sidebarBtn) sidebarBtn.click();
      }
    });
  }
  // Close drawer when: (a) clicking the backdrop / anywhere outside the
  // sidebar, or (b) tapping an actionable element inside the sidebar so
  // navigation closes the drawer automatically.
  document.addEventListener('click', e=>{
    if(!document.body.classList.contains('drawer-open')) return;
    const inAside = e.target.closest('aside');
    const onMenuBtn = e.target.closest('#menuToggle');
    if(onMenuBtn) return; // handled by the toggle above
    if(!inAside){
      document.body.classList.remove('drawer-open');
      return;
    }
    // Inside aside: close when user taps a button/link/note item so the
    // selected view becomes visible. Plain clicks on whitespace stay open.
    if(e.target.closest('button, a, [data-note-id], .projBtn, [role="button"]')){
      document.body.classList.remove('drawer-open');
    }
  });
  // Await initialization to avoid race conditions on first user actions.
  await initApp();
  // Begin checking for due task notifications after the app has been
  // initialized. This ensures db is loaded and available.
  startDueTaskNotifications();

  // ----------------------------------------------------------------
  // Mobile floating quick-capture button. Hidden on desktop via CSS.
  // Bound here (rather than inside initApp) because the FAB lives in
  // the static page body and only needs a single one-time wire-up.
  // ----------------------------------------------------------------
  const fab = document.getElementById('mbCaptureFab');
  if(fab && !fab.dataset.bound){
    fab.addEventListener('click', () => {
      if(typeof openQuickCapture === 'function') openQuickCapture();
    });
    fab.dataset.bound = '1';
  }

  // ----------------------------------------------------------------
  // Mobile "Tools" card inside the sidebar drawer. Each button has a
  // data-proxy="<selector>" attribute pointing at the original desktop
  // control; clicking the mobile button forwards .click() to the
  // original so handlers stay single-source. Each settings checkbox
  // has a data-mirror="<selector>" attribute; we keep .checked in sync
  // both directions and dispatch 'change' on the original so its
  // existing onchange handler runs (writes to db.settings, saves).
  // ----------------------------------------------------------------
  const mobileTools = document.getElementById('mobileTools');
  if(mobileTools && !mobileTools.dataset.bound){
    // Proxy buttons.
    mobileTools.addEventListener('click', e => {
      const btn = e.target.closest('[data-proxy]');
      if(!btn) return;
      const target = document.querySelector(btn.dataset.proxy);
      if(target) target.click();
      // Close the drawer so the user sees the result of the action.
      document.body.classList.remove('drawer-open');
    });
    // Mirror checkboxes (run once at boot; render() may later reassign
    // the originals' .onchange, but dispatching 'change' invokes whichever
    // handler is currently attached, so the mirror keeps working).
    const syncMirror = (mirror, orig) => {
      mirror.checked = !!orig.checked;
    };
    mobileTools.querySelectorAll('[data-mirror]').forEach(mirror => {
      const orig = document.querySelector(mirror.dataset.mirror);
      if(!orig) return;
      syncMirror(mirror, orig);
      // Re-sync whenever the desktop control changes (e.g. via render()).
      orig.addEventListener('change', () => syncMirror(mirror, orig));
      // Mobile -> desktop: push the new value and fire the change event
      // so the existing handler (set inside render()) runs.
      mirror.addEventListener('change', () => {
        orig.checked = mirror.checked;
        orig.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });
    // Re-sync every time the drawer is opened, since render() may have
    // refreshed the desktop checkbox states in between opens.
    const menuBtn = document.getElementById('menuToggle');
    if(menuBtn){
      menuBtn.addEventListener('click', () => {
        setTimeout(() => {
          mobileTools.querySelectorAll('[data-mirror]').forEach(mirror => {
            const orig = document.querySelector(mirror.dataset.mirror);
            if(orig) syncMirror(mirror, orig);
          });
        }, 0);
      });
    }
    mobileTools.dataset.bound = '1';
  }

  // ----------------------------------------------------------------
  // External quick-capture entry point.
  //
  // History: v103 attempted to handle ?capture=<text> here as well, but
  // research-mode.js already owns ?capture= (silent append into the
  // 🔬 Research Inbox via appendCaptureToInbox — the long-standing
  // bookmarklet contract). The v103 handler raced research-mode and
  // sometimes stripped the param first, routing to the idea/quick-
  // capture panel instead. That regression is reverted.
  //
  // Reserved param now:
  //   ?qc=<text>       Explicitly open the quick-capture (idea) panel
  //                    pre-filled. Use this when you DO want the idea
  //                    flow rather than research inbox.
  //
  // Web Share Target (?title=&text=&url=) is left alone; without a PWA
  // install over HTTPS browsers won't dispatch it anyway. When that
  // lights up later we can decide where to route it (inbox vs idea)
  // without further breaking the bookmarklet contract.
  // ----------------------------------------------------------------
  try {
    const p = new URLSearchParams(location.search);
    const qc = p.get('qc');
    if(qc){
      const u = new URL(location.href);
      u.searchParams.delete('qc');
      history.replaceState(null, '', u.pathname + (u.search ? '?'+u.searchParams.toString() : '') + u.hash);
      setTimeout(() => {
        if(typeof openQuickCapture === 'function') openQuickCapture(qc);
      }, 150);
    }
  } catch(err){
    console.warn('qc URL param parse failed', err);
  }
});

// ------------------------------------------------------------------
// Periodic sync is owned exclusively by autosync.js (startAutoSync), which
// performs a content-aware merge that respects in-progress edits and never
// wholesale-replaces the local db with stale server data.
//
// A second polling loop used to live here that did `db = remote` every 10s
// — that was destructive: if the user had unsaved edits or persistDB() had
// not yet flushed, the next tick would overwrite the in-memory db with
// older server state, and then the next save would push that older state
// back to the server, causing real data loss (see daily-notes bug 2026-05-18).
// The loop has been intentionally removed. Do not re-add a second sync loop
// here without coordinating with autosync.js — they will race.
// ------------------------------------------------------------------