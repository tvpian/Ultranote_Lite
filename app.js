// This file contains all the JavaScript logic for UltraNote Lite.
// Extracted from the original index.html to improve modularity and maintainability.

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
let selectedDailyDate = todayKey();
function createDailyNoteFor(dateKey, contentOverride){
  const exists = db.notes.find(n=>n.type==='daily' && n.dateIndex===dateKey);
  if(exists) return exists;
  const isToday = dateKey === todayKey();
  const templateContent = contentOverride !== undefined ? contentOverride : (db.settings.dailyTemplate || "# Top 3\n- [ ] \n- [ ] \n- [ ] \n\n## Tasks\n\n## Journal\n\n## Wins\n");
  const daily = createNote({title:`${dateKey} — Daily`, type:'daily', dateIndex:dateKey, content:templateContent});
  if(isToday){
    if(db.settings.rollover){
      // Find the most recent previous daily note before the current dateKey
      const prior = db.notes
        .filter(n => n.type === 'daily' && n.dateIndex && n.dateIndex < dateKey)
        .sort((a,b) => b.dateIndex.localeCompare(a.dateIndex))[0];
      if(prior){
        const carryTasks = db.tasks.filter(t => t.noteId === prior.id && t.status !== 'DONE' && t.status !== 'BACKLOG');
        carryTasks.forEach(t => {
          // Move the task to the new daily note rather than duplicating it
          t.noteId = daily.id;
          t.createdAt = nowISO();
        });
        if(carryTasks.length) save();
      }
    }
    if(db.settings.autoCarryTasks){
      const priorities={high:3,medium:2,low:1};
      const projectPool = db.tasks.filter(t=> t.projectId && !t.noteId && t.status==='TODO')
        .sort((a,b)=>(priorities[b.priority]||2)-(priorities[a.priority]||2))
        .slice(0,5);
      // Move existing project tasks to the new daily note rather than cloning them
      projectPool.forEach(t=>{
        t.noteId = daily.id;
        t.createdAt = nowISO();
      });
      if(projectPool.length) save();
    }
  }
  // Insert recurring monthly tasks for the given date (runs for any date)
  if(db.monthly && Array.isArray(db.monthly)){
    try {
      const dObj = new Date(dateKey + 'T00:00:00');
      const weekday = dObj.getDay();
      const monthKey = dateKey.slice(0,7);
      db.monthly.forEach(mt => {
        if(mt.month && mt.month !== monthKey) return;
        if(!Array.isArray(mt.days) || !mt.days.includes(weekday)) return;
        const exists = db.tasks.some(t => t.noteId === daily.id && !t.deletedAt && t.title === mt.title);
        if(!exists){
          createTask({ title: mt.title, noteId: daily.id, priority: 'medium' });
        }
      });
    } catch(err) {
      console.warn('Monthly task injection error', err);
    }
  }
  return daily;
}
// NEW: unified handler to open or create the selected daily note (deferred creation)
function createOrOpenDaily(){
  const dateInput = document.getElementById('dailyDateNav');
  const today = todayKey();
  let key = (dateInput && dateInput.value) ? dateInput.value : (selectedDailyDate || today);
  if(key > today) key = today; // prevent future
  selectedDailyDate = key;
  // Do NOT auto-create daily note here; only render view; creation happens on user Save
  route='today';
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
  await fetch('/api/db', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(db)
    });
    // Optionally refresh local data from the server after saving to incorporate
    // remote merges. If fetch fails we silently ignore; the periodic sync will
    // update the state.
  // Removed immediate post-save fetch to avoid overwriting in-progress edits; inbound merges handled by autosync/manual sync.
  window.db = db;
  } catch (e) {
    console.error('Persist failed', e);
  }
  try {
    localStorage.setItem(storeKey, JSON.stringify(db));
  } catch(err) {
    /* ignore */
  }
}

const seed = {
  version:1,
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
    {id:"tpl3", name:"Weekly Review", content:"# Week of [Date]\n\n## Wins\n- \n\n## Challenges\n- \n\n## Lessons Learned\n- \n\n## Next Week Focus\n- [ ] \n"}
  ],
  // NEW collection for saved links
  links:[
    {id:"l1", title:"UltraNote Example", url:"https://example.com", tags:["ref"], pinned:true, status:"NEW", createdAt:nowISO(), updatedAt:nowISO()}
  ]
  ,
  // NEW: recurring monthly tasks for planning (empty by default)
  monthly: []
};
const defaults = seed;

// Theme definitions. Each theme defines CSS variable values for our design tokens.
const THEMES = {
  dark: {
    '--bg': '#0b0f14',
    '--fg': '#e8eef7',
    '--muted': '#a9b6c6',
    '--card': '#121924',
    '--acc': '#4ea1ff'
    ,
    '--border': '#1e2938',
    '--btn-bg': '#122134',
    '--btn-border': '#274768',
    '--pill-border': '#334759',
    '--header-bg': '#0e141d',
    '--input-bg': '#0f1621',
    '--input-border': '#203041'
    , '--btn-active-bg': '#182330'
    , '--kbd-border': '#3a4a60'
  },
  light: {
    '--bg': '#f8f9fa',
    '--fg': '#1a202c',
    '--muted': '#6c757d',
    '--card': '#ffffff',
    '--acc': '#007bff',
    '--border': '#d0d7e2',
    '--btn-bg': '#f5f7fa',
    '--btn-border': '#cbd5e0',
    '--pill-border': '#cbd5e0',
    '--header-bg': '#f8f9fa',
    '--input-bg': '#ffffff',
    '--input-border': '#d1d5db'
    , '--btn-active-bg': '#e7ecf3'
    , '--kbd-border': '#cbd5e0'
  }
};

// Apply the current theme by setting CSS variables on the root element.
function applyTheme(){
  const theme = (db && db.settings && db.settings.theme) ? db.settings.theme : 'dark';
  const vars = THEMES[theme] || THEMES.dark;
  const root = document.documentElement;
  Object.entries(vars).forEach(([key,val])=> root.style.setProperty(key, val));
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
// Track when user is actively typing in forms to prevent background sync interference
window._isTypingInForm = false;
let _typingTimer = null;
function uid(){ return Math.random().toString(36).slice(2,10); }
// Backwards compatibility: some calls still pass db => ignore param
function save(){ persistDB(); }
// Debounced override to reduce write frequency
let _saveTimer; function save(){ clearTimeout(_saveTimer); _saveTimer = setTimeout(()=>persistDB(), 400); }

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

async function initApp(){
  // 1. Try server
  let serverData = await fetchDB();
  if(serverData && Object.keys(serverData).length){
    db = serverData;
  window.db = db; // expose globally for autosync
  } else {
    // 2. Fallback to any localStorage copy
    try { db = JSON.parse(localStorage.getItem(storeKey)||'null'); } catch(_) { db = null; }
    if(!db) db = JSON.parse(JSON.stringify(defaults));
    await persistDB();
  window.db = db;
  }
  // Defensive: ensure collections exist (added links)
  // Ensure all collections exist on db. Include new 'monthly' plan storage.
  ['notes','tasks','projects','templates','settings','links','monthly'].forEach(k=>{
    if(!db[k]) db[k] = Array.isArray(seed[k]) ? [] : {};
  });
  // Ensure theme setting exists (default to dark)
  if(!db.settings.theme){ db.settings.theme = 'dark'; }
  // Draw initial UI
  drawProjectsSidebar();
  applyTheme();
  render();
  
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
  bindTypingGuards();
  // Re-bind after each render by monkey-patching render once (idempotent)
  if(!window.__originalRender){
    window.__originalRender = render;
    window.render = function(){
      window.__originalRender.apply(this, arguments);
  window.db = db; // keep global pointer current
      bindTypingGuards();
    };
  }
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
              const list = ['notes','tasks','projects','templates','links','monthly'];
              const mapify = a=>{const m=new Map(); a.forEach(o=>m.set(o.id,o)); return m;};
              list.forEach(k=>{
                const localArr = Array.isArray(db[k])? db[k]:[];
                const remoteArr = Array.isArray(remote[k])? remote[k]:[];
                const m = mapify(localArr);
                remoteArr.forEach(r=>{
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
  db.notes.push(n); save(); return n;
}
function updateNote(id, patch){ const n=db.notes.find(x=>x.id===id); if(!n) return; Object.assign(n, patch, {updatedAt:nowISO()}); save(); return n; }
function createTask({title, due=null, noteId=null, projectId=null, priority="medium", description="", subtasks=[]}){
  // Tasks now support an optional description and a list of subtasks. Subtasks should be an array of
  // objects with id, title and status. If none provided, default to empty array.
  const t = { id: uid(), title, status: "TODO", due, noteId, projectId, priority, description, subtasks, createdAt: nowISO(), completedAt: null };
  db.tasks.push(t);
  // When creating a project task, update the Today page counter if present. This must occur
  // before returning so the counter updates immediately on task creation. Note: checking
  // for existence of updateProjectTasksButton guards against calling it before it is defined.
  if (projectId && typeof updateProjectTasksButton === 'function') {
    updateProjectTasksButton();
  }
  save();
  return t;
}
function setTaskStatus(id, status){
  const t = db.tasks.find(x => x.id === id);
  if (!t) return;
  t.status = status;
  t.completedAt = status === 'DONE' ? nowISO() : null;
  save();
  // If a project task status changes, update the Today page project tasks button count
  const ptBtn = document.getElementById('showProjectTasks');
  if (ptBtn) {
    // Defer updating project tasks count to a helper for consistency
    if (typeof updateProjectTasksButton === 'function') updateProjectTasksButton();
  }
}
// New helper to move a task to backlog
function moveToBacklog(id) {
  const t = db.tasks.find(x => x.id === id);
  if (!t) return;
  // Mark task as backlog
  t.status = 'BACKLOG';
  save();
  // If it's a project task (belongs to a project but not attached to a note) then update the
  // project task button counter on the Today page. This ensures the badge reflects the new
  // backlog status without automatically revealing the list.
  if (t.projectId && !t.noteId && typeof updateProjectTasksButton === 'function') {
    updateProjectTasksButton();
  }
}
// Soft-delete a task by marking it archived. Tasks are not removed from DB to allow history viewing.
function deleteTask(id){
  const t = db.tasks.find(x => x.id === id);
  if (!t) return;
  t.deletedAt = nowISO();
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
  save();
}

function hardDeleteTask(id){
  // Permanently delete the task from the database
  const taskIndex = db.tasks.findIndex(x => x.id === id);
  if (taskIndex === -1) return;
  db.tasks.splice(taskIndex, 1);
  save();
}

function emptyTrash() {
  showConfirm("Permanently delete ALL trashed tasks? This cannot be undone.", 'Empty Trash', 'Cancel').then(ok=>{
    if(!ok) return;
    const before = db.tasks.length;
    db.tasks = db.tasks.filter(x => !x.deletedAt);
    if(db.tasks.length !== before) save();
    if(route==='review') renderReview();
  });
}
function createProject(name){ const p={id:uid(), name, createdAt:nowISO()}; db.projects.push(p); save(); return p; }
function createTemplate(name, content){ const t={id:uid(), name, content, createdAt:nowISO()}; db.templates.push(t); save(); return t; }
function addTag(text){ const tags = extractTags(text); if(tags.length) { const uniqueTags = [...new Set([...getAllTags(), ...tags])]; } return tags; }
// Collect unique tags from notes and links (ideas/notes use tags on note; links have their own tags)
function getAllTags(){
  // Tags explicitly stored on notes
  const noteTags = db.notes.flatMap(n => n.tags || []);
  // Inline hashtags inside note content (e.g. "#research")
  const inlineContentTags = db.notes.flatMap(n => extractTags(n.content || ''));
  // Tags stored on links
  const linkTags = db.links ? db.links.flatMap(l => l.tags || []) : [];
  // Merge + dedupe
  return [...new Set([...noteTags, ...inlineContentTags, ...linkTags].filter(Boolean))].sort((a,b)=> a.localeCompare(b));
}
function extractTags(text){ return (text.match(/#[\w-]+/g) || []).map(tag => tag.slice(1)); }
// --- Links helpers ---
function createLink({title,url,tags=[],pinned=false,status="NEW"}){ const l={id:uid(), title, url, tags, pinned, status, createdAt:nowISO(), updatedAt:nowISO()}; db.links.push(l); save(); return l; }
function updateLink(id, patch){ const l=db.links.find(x=>x.id===id); if(!l) return; Object.assign(l, patch, {updatedAt:nowISO()}); save(); return l; }
function deleteLink(id){ db.links = db.links.filter(l=> l.id!==id); save(); }

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
  {id:"map", label:"🗺️ Map"}, // NEW: map view to visualize note links
  {id:"vault", label:"🔍 Vault"},
  // NEW: monthly planning view
  {id:"monthly", label:"🗓️ Monthly"},
  {id:"review", label:"📊 Review"},
];
let route = "today";
let currentProjectId = null; // NEW: selected project

function renderNav(){
  nav.innerHTML = sections.map(s => `<button data-route="${s.id}" class="${route===s.id?'active':''}">${s.label}</button>`).join("");
  nav.querySelectorAll("button").forEach(b=> b.onclick = ()=>{ route=b.dataset.route; if(route==='today') selectedDailyDate = todayKey(); render(); });
}

function htmlesc(s){ return s.replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[m])); }

// Enhanced markdown rendering using marked.js library with fallback
// This function provides:
//  - Full markdown support via marked.js when available
//  - Safe HTML rendering to prevent XSS attacks
//  - Basic markdown support as fallback if marked.js fails to load
//  - Converts headings, lists, code blocks, emphasis, and more
function markdownToHtml(md){
  if(!md) return '';
  
  // Use marked.js if available for full markdown support
  if(typeof marked !== 'undefined'){
    try {
      // Configure marked for safe rendering
      marked.setOptions({
        breaks: true,        // Convert single line breaks to <br>
        gfm: true,          // GitHub Flavored Markdown
        sanitize: false,     // We'll handle sanitization ourselves
        smartLists: true,    // Use smarter list behavior
        smartypants: false   // Don't use smart quotes (can cause issues)
      });
      return marked.parse(md);
    } catch(error) {
      console.warn('marked.js failed, falling back to basic renderer:', error);
    }
  }
  
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
  return html;
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

// Restored: drawProjectsSidebar (was missing causing project UI break)
function drawProjectsSidebar(){
  if(!projectList) return;
  projectList.innerHTML = db.projects.map(p=> `
    <button class="projBtn ${currentProjectId===p.id?"active":""}" data-proj="${p.id}" title="Select project">
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${htmlesc(p.name)}</span>
      <span class="projDel" data-del="${p.id}" title="Delete project">✕</span>
    </button>`).join("");
  if(!projectList.dataset.bound){
    projectList.addEventListener('click', async (e) => {
      const del = e.target.closest('.projDel');
      if (del) {
        e.stopPropagation();
        const pid = del.dataset.del;
        const proj = db.projects.find(p => p.id === pid);
        if (!proj) return;
        const noteCount = db.notes.filter(n => n.projectId === pid).length;
        const taskCount = db.tasks.filter(t => t.projectId === pid).length;
        const msg = `Delete project "${proj.name}"${noteCount || taskCount ? ` (and its ${noteCount} notes / ${taskCount} tasks)` : ''}? This cannot be undone.`;
        const ok = await showConfirm(msg, 'Delete', 'Cancel');
        if (!ok) return;
        db.notes = db.notes.filter(n => n.projectId !== pid);
        db.tasks = db.tasks.filter(t => t.projectId !== pid);
        db.projects = db.projects.filter(p => p.id !== pid);
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

function htmlesc(s){ return s.replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[m])); }

// --- Draft note helper ---
function openDraftNote({title='', projectId=null, type='note', templateId=''}){
  // Prepare initial content from template if provided
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
  // Reset draft sketches array when opening a new draft so previous sketches don't persist
  window._draftSketches = [];
  // Reset draft voices array when opening a new draft so previous voices don't persist
  window._draftVoices = [];
  content.innerHTML = `
    <div class="card">
      <div class="muted" style="margin-bottom:6px;">Draft (not saved yet)</div>
      <input id="draftTitle" type="text" value="${htmlesc(title)}" placeholder="Title" />
      <div class="row" style="margin-top:8px;flex-wrap:wrap;gap:8px;">
        <input id="draftTags" type="text" placeholder="Tags (space separated)" />
        <label style="margin-left:8px;"><input id="draftPinned" type="checkbox"> Pin</label>
        <button id="draftAddSketch" class="btn" style="font-size:12px;">Add Sketch</button>
        <button id="draftAddVoice" class="btn" style="font-size:12px;">Add Voice</button>
      </div>
      <div style="margin-top:8px;"><textarea id="draftContent" style="min-height:300px;">${htmlesc(contentTxt)}</textarea></div>
      <div class="row" style="margin-top:8px; gap:8px;flex-wrap:wrap;">
        <button id="draftSave" class="btn acc">Save</button>
        <button id="draftCancel" class="btn">Cancel</button>
      </div>
    </div>`;
  document.getElementById('draftSave').onclick = () => {
    const t = document.getElementById('draftTitle').value.trim() || 'Untitled';
    const tags = (document.getElementById('draftTags').value || '').split(/\s+/).map(x => x.startsWith('#') ? x.slice(1) : x).filter(Boolean);
    const newNote = createNote({ title: t, content: document.getElementById('draftContent').value, tags, projectId, type, pinned: document.getElementById('draftPinned').checked });
    // If there are sketches attached to the draft, assign them as attachments to the new note
    if (window._draftSketches && window._draftSketches.length) {
      // Clone sketches to avoid reusing the same object reference
      newNote.attachments = window._draftSketches.map(att => ({ ...att }));
      save();
      // Clear the draft sketches so they don't leak into subsequent drafts
      window._draftSketches = [];
    }
    // If there are voices attached to the draft, append them as attachments
    if (window._draftVoices && window._draftVoices.length) {
      if (!newNote.attachments) newNote.attachments = [];
      newNote.attachments = newNote.attachments.concat(window._draftVoices.map(att => ({ ...att })));
      save();
      // Clear the draft voices so they don't leak into subsequent drafts
      window._draftVoices = [];
    }
    openNote(newNote.id);
  };
  
  // Add Ctrl+S shortcut for draft save
  const draftKeyHandler = (e) => {
    if(e.ctrlKey && !e.shiftKey && (e.key === 's' || e.key === 'S' || e.code === 'KeyS')) {
      e.preventDefault();
      e.stopPropagation();
      document.getElementById('draftSave').click();
      return false;
    }
  };
  
  // Add shortcut to draft form fields
  ['draftTitle', 'draftTags', 'draftContent'].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.addEventListener('keydown', draftKeyHandler);
  });
  document.getElementById('draftCancel').onclick = ()=>{ if(projectId){ route='projects'; render(); } else { route='vault'; render(); } };
  const addSketchBtn = document.getElementById('draftAddSketch');
  if(typeof openSketchModal==='function') addSketchBtn.onclick = ()=>{
    // Insert sketch at caret later; for draft we reuse existing sketch logic by temporarily creating an off-screen note? Simplest: open modal and after insert we append to textarea.
    const originalInsert = window.openSketchModal;
    // Use existing openSketchModal but pass a temporary note id not used; after export we just append.
    openSketchModal('__draft__');
    // Monkey patch insertion handler after modal opens handled in existing code (not perfect, kept simple)
  };

  // Voice button handler for draft
  const addVoiceBtn = document.getElementById('draftAddVoice');
  if(typeof openVoiceModal==='function' && addVoiceBtn){
    addVoiceBtn.onclick = () => openVoiceModal('__draft__');
  }
}

// --- Views ---
function renderToday(){
  const key = selectedDailyDate || todayKey();
  const daily = db.notes.find(n=>n.type==='daily' && n.dateIndex===key) || null;
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
        t.status !== 'DONE' &&
        !t.deletedAt
    )
    .sort((a, b) => {
      const priorities = { high: 3, medium: 2, low: 1 };
      return (priorities[b.priority] || 2) - (priorities[a.priority] || 2);
    });
  if(!daily){
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
      <div style="margin-top:8px;"><textarea id="dailyContent">${htmlesc(daily.content)}</textarea></div>
      <div class="row" style="margin-top:8px;flex-wrap:wrap;gap:8px;">
        <button id="saveDaily" class="btn acc">Save</button>
        <select id="templateSelect" style="padding:8px;background:var(--btn-bg);border:1px solid var(--btn-border);color:var(--fg);border-radius:6px;">
          <option value="">Apply Template...</option>
          ${db.templates.map(t=>`<option value="${t.id}">${htmlesc(t.name)}</option>`).join("")}
        </select>
        <button id="toggleBacklog" class="btn" style="font-size:12px;">Backlog ▾</button>
      </div>
      <div class="muted" style="margin-top:6px;font-size:11px;">${key===todayKey()? 'Current day' : 'Viewing: '+ new Date(key+"T00:00:00").toDateString()}</div>
    </div>
    <div class="grid-2">
      <div class="card">
        <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px;">
          <strong>${key===todayKey()?"Today's Tasks":"Tasks"}</strong>
          <div class="row" style="gap:6px;">
            <button id="showProjectTasks" class="btn" style="font-size:12px;">${projectTasks.length} project tasks</button>
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
        <div id="taskList" class="list" style="margin-top:8px;"></div>
        <div id="backlogList" class="list" style="margin-top:8px;display:none;border-top:1px solid #1e2938;padding-top:8px;"></div>
        <div id="projectTaskList" class="list" style="margin-top:8px;display:none;"></div>
      </div>
      <div class="card">
        <div class="muted">Quick Capture (today only)</div>
        <div class="row" style="margin-top:8px;flex-wrap:wrap;gap:8px;">
          <input id="quickCapture" type="text" placeholder="⌘/Ctrl+Shift+K for quick add" style="flex:1;min-width:0;" ${key!==todayKey()? 'disabled':''}/>
          <button id="captureBtn" class="btn" ${key!==todayKey()? 'disabled':''}>Add</button>
        </div>
        <div class="muted" style="margin-top:12px;">Scratchpad</div>
        <textarea id="scratch" placeholder="Temporary notes..."></textarea>
      </div>
    </div>`;
  $("#saveDaily").onclick = ()=> { updateNote(daily.id, { title: $("#dailyTitle").value, content: $("#dailyContent").value }); };
  
  // Add Ctrl+S shortcut for daily save
  const dailyKeyHandler = (e) => {
    if(e.ctrlKey && !e.shiftKey && (e.key === 's' || e.key === 'S' || e.code === 'KeyS')) {
      e.preventDefault();
      e.stopPropagation();
      $("#saveDaily").click();
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
  const taskInput = $("#taskTitle"); const quickCapture = $("#quickCapture");
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
      drawTasks();
    };
    ['keydown','keypress','keyup'].forEach(evt=>{
      taskInput.addEventListener(evt, e=>{
        const key = e.key || e.keyCode;
        if(key === 'Enter' || key === 13){
          handleAddTask();
        }
      });
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
      drawTasks();
    };
  }
  const handleQuickCapture = ()=>{ if(!quickCapture) return; const text = quickCapture.value.trim(); if(!text) return; if(text.startsWith('!')){ createTask({title:text.slice(1), noteId:daily.id, priority:'high'}); } else if(text.includes('#')) { const tags = extractTags(text); createNote({title:text, type:'idea', tags}); } else { createTask({title:text, noteId:daily.id, priority:'medium'}); } quickCapture.value=''; drawTasks(); };
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
  $("#captureBtn")?.addEventListener('click', handleQuickCapture);
  $("#showProjectTasks").onclick = ()=>{ const list = $("#projectTaskList"); const isVisible = list.style.display !== 'none'; list.style.display = isVisible? 'none':'block'; drawProjectTasks(); };
  $("#toggleBacklog").onclick = ()=>{ const bl = $("#backlogList"); bl.style.display = bl.style.display==='none'? 'block':'none'; drawBacklog(); };
  function drawTasks(){
    const list = $("#taskList"); if(!list) return;
    const tasks = db.tasks.filter(t=> t.noteId===daily.id && t.status!=='BACKLOG' && !t.deletedAt)
      .sort((a,b)=> { if(a.status!==b.status) return a.status==='DONE'?1:-1; const p={high:3,medium:2,low:1}; return (p[b.priority]||2)-(p[a.priority]||2); });
    list.innerHTML = tasks.map(t=> {
      const colors={high:'#ff6b6b',medium:'#4ea1ff',low:'#64748b'};
      return `<div class='row' style='justify-content:space-between;'>
      <label class='row' style='gap:8px;'>
        <input type='checkbox' ${t.status==='DONE'? 'checked':''} data-id='${t.id}'/>
        <span class='${t.status==='DONE'?'muted':''}' style='border-left:3px solid ${colors[t.priority||'medium']};padding-left:8px;'>${htmlesc(t.title)}${t.due ? ` <span class='pill'>${formatDateString(t.due)}</span>` : ''}</span>
      </label>
      <div class='row' style='gap:6px;'>
        <button class='btn' data-edit='${t.id}' style='font-size:11px;'>✎</button>
        ${t.status!=='DONE'?`<button class='btn' data-b='${t.id}' style='font-size:11px;'>Backlog</button>`:''}
        <button class='btn' data-del='${t.id}' title='Delete'>✕</button>
      </div>
    </div>`;
    }).join('');
    // bind handlers
    list.querySelectorAll("input[type=checkbox]").forEach(cb=> cb.onchange = ()=>{ setTaskStatus(cb.dataset.id, cb.checked? 'DONE':'TODO'); drawTasks(); drawBacklog(); });
    list.querySelectorAll('[data-del]').forEach(b=> b.onclick = ()=>{
      // Delete the task and re-render local lists. We intentionally avoid calling
      // drawProjectTasks() here to prevent auto-revealing the project tasks list.
      deleteTask(b.dataset.del);
      drawTasks();
      drawBacklog();
      // Update the project task badge if necessary. deleteTask already triggers
      // updateProjectTasksButton for project tasks, so no additional call needed.
    });
    list.querySelectorAll('[data-b]').forEach(b=> b.onclick = ()=>{
      // Move task to backlog. Avoid calling drawProjectTasks() here to respect the
      // user's toggle state. The badge will update via moveToBacklog().
      moveToBacklog(b.dataset.b);
      drawTasks();
      drawBacklog();
    });
    list.querySelectorAll('[data-edit]').forEach(b=> b.onclick = ()=>{ openTaskModal(b.dataset.edit); });
  }
  function drawBacklog(){
    const list = $("#backlogList");
    if(!list || list.style.display==='none') return;
    const tasks = db.tasks.filter(t=> t.noteId===daily.id && t.status==='BACKLOG' && !t.deletedAt);
    // Compose a header showing backlog count styled like the project page
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
    list.querySelectorAll('[data-r]').forEach(b=> b.onclick = ()=>{ setTaskStatus(b.dataset.r,'TODO'); drawTasks(); drawBacklog(); });
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
        t.projectId && !t.noteId && t.status !== 'BACKLOG' && t.status !== 'DONE' && !t.deletedAt
      )
      .sort((a, b) => {
        const priorities = { high: 3, medium: 2, low: 1 };
        return (priorities[b.priority] || 2) - (priorities[a.priority] || 2);
      });
    list.innerHTML = tasks
      .map(t => {
        const proj = db.projects.find(p => p.id === t.projectId);
        const colors = { high: '#ff6b6b', medium: '#4ea1ff', low: '#64748b' };
        return `<div class='row' style='justify-content:space-between;'>
      <label class='row' style='gap:8px;'>
        <input type='checkbox' ${t.status === 'DONE' ? 'checked' : ''} data-id='${t.id}'/>
        <span class='${t.status === 'DONE' ? 'muted' : ''}' style='border-left:3px solid ${colors[t.priority || 'medium']};padding-left:8px;'>${htmlesc(t.title)}${t.due ? ` <span class='pill'>${formatDateString(t.due)}</span>` : ''} <span class='pill'>${proj ? htmlesc(proj.name) : 'Unknown'}</span></span>
      </label>
      <div class='row' style='gap:6px;'>
        <button class='btn' data-edit='${t.id}' style='font-size:11px;'>✎</button>
        ${t.status !== 'DONE' ? `<button class='btn' data-b='${t.id}' style='font-size:11px;'>Backlog</button>` : ''}
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
      b => (b.onclick = () => {
        moveToBacklog(b.dataset.b);
        drawProjectTasks();
      })
    );
    list.querySelectorAll('[data-edit]').forEach(
      b => (b.onclick = () => {
        openTaskModal(b.dataset.edit);
      })
    );
  }
  // Expose the drawProjectTasks function globally so other helpers (like
  // updateProjectTasksButton) can invoke it when necessary. This is safe
  // because renderToday redefines drawProjectTasks on each invocation.
  window.drawProjectTasks = drawProjectTasks;
  drawTasks(); drawBacklog();
}
function renderProjects(){
  const selectorHTML = db.projects && db.projects.length ? `
    <div id="projectSelectorContainer" class="card">
      <select id="projectSelector" style="width:100%;padding:8px;background:var(--btn-bg);border:1px solid var(--btn-border);color:var(--fg);border-radius:6px;">
        ${db.projects.map(p=>`<option value="${p.id}" ${p.id===currentProjectId?'selected':''}>${htmlesc(p.name)}</option>`).join('')}
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
  content.innerHTML = selectorHTML + `
    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:center;">
        <strong>Project: ${htmlesc(selectedProject.name)}</strong>
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
  // Exclude deleted tasks when retrieving project tasks/backlog
  function getProjectTasks(){
    // Exclude tasks that have been soft-deleted (deletedAt) or moved to backlog. Only
    // return active tasks (TODO/DONE) for this project. Filtering out deleted tasks
    // ensures that once a user deletes a project task it no longer appears in the list.
    return db.tasks.filter(
      t => t.projectId === currentProjectId && t.status !== 'BACKLOG' && !t.deletedAt
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
  function getProjectNotes(){ return db.notes.filter(n=> n.projectId===currentProjectId && (!n.type || n.type==='note')); }
  function drawNotes(){
    const notes = getProjectNotes().sort((a,b)=> sortBy==="title"? a.title.localeCompare(b.title) : b.updatedAt.localeCompare(a.updatedAt));
    const listEl = document.getElementById("notes");
    if(!notes.length){ listEl.innerHTML = `<div class='card muted'>No notes yet. Add one above.</div>`; return; }
    listEl.innerHTML = notes.map(n=> `<div class="card">
      <div class="row" style="justify-content:space-between;">
        <strong>${htmlesc(n.title)}</strong>
        <div class="row" style="gap:8px;">
          ${n.pinned?'<span title="Pinned">📌</span>':''}
          <div class="muted">${new Date(n.updatedAt).toLocaleDateString()}</div>
        </div>
      </div>
      ${(n.tags&&n.tags.length)?`<div style='margin-top:4px;'>${n.tags.map(tag=>`<span class='pill'>#${htmlesc(tag)}</span>`).join("")}</div>`:''}
      <div class="row" style="margin-top:8px; gap:8px;">
        <button class="btn" data-open="${n.id}">Open</button>
        <button class="btn" data-pin="${n.id}">${n.pinned?'Unpin':'Pin'}</button>
        <button class="btn" data-del="${n.id}">Delete</button>
      </div>
    </div>`).join("");
    listEl.querySelectorAll('[data-open]').forEach(b=> b.onclick = ()=> openNote(b.dataset.open));
    listEl.querySelectorAll('[data-pin]').forEach(b=> b.onclick = ()=> { const note=db.notes.find(x=>x.id===b.dataset.pin); if(note){ note.pinned=!note.pinned; save(); drawNotes(); } });
    listEl.querySelectorAll('[data-del]').forEach(b=> b.onclick = async ()=> {
      const ok = await showConfirm('Delete this note?', 'Delete', 'Cancel');
      if(!ok) return;
      db.notes = db.notes.filter(x=> x.id !== b.dataset.del);
      save();
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
    const dueEl = document.getElementById("projTaskDueDate");
    const dueVal = dueEl && dueEl.value ? dueEl.value : null;
    createTask({title, projectId:currentProjectId, priority:document.getElementById("projTaskPriority").value, due: dueVal});
    if(titleEl) titleEl.value="";
    if(dueEl) dueEl.value="";
    drawTasks();
    refreshStats();
  };
  document.getElementById("projTaskTitle").onkeydown = e=>{ if(e.key==="Enter") document.getElementById("projAddTask").click(); };
  document.getElementById("sortTitle").onclick = ()=>{ sortBy="title"; drawNotes(); };
  document.getElementById("sortDate").onclick = ()=>{ sortBy="date"; drawNotes(); };
  function drawTasks(){
    const tasks = getProjectTasks().sort((a,b)=>{ if(a.status !== b.status) return a.status==="DONE"?1:-1; const priorities={high:3,medium:2,low:1}; return (priorities[b.priority]||2)-(priorities[a.priority]||2); });
    const list = document.getElementById("taskList");
    list.innerHTML = tasks.map(t=>{
      const colors={high:"#ff6b6b",medium:"#4ea1ff",low:"#64748b"};
      return `<div class="row" style="justify-content:space-between;">
        <label class="row" style="gap:8px;">
          <input type="checkbox" ${t.status==="DONE"?"checked":''} data-id="${t.id}"/>
          <span class="${t.status==='DONE'?'muted':''}" style="border-left:3px solid ${colors[t.priority||'medium']};padding-left:8px;">${htmlesc(t.title)}${t.due ? ` <span class='pill'>${formatDateString(t.due)}</span>` : ''}</span>
        </label>
        <div class='row' style='gap:6px;'>
          <button class='btn' data-edit='${t.id}' style='font-size:11px;'>✎</button>
          ${t.status!=='DONE'?`<button class='btn' data-b='${t.id}' style='font-size:11px;'>Backlog</button>`:''}
          <button class='btn' data-del='${t.id}'>✕</button>
        </div>
      </div>`;
    }).join("");
    list.querySelectorAll("input[type=checkbox]").forEach(cb=> cb.onchange = ()=>{ setTaskStatus(cb.dataset.id, cb.checked?"DONE":"TODO"); drawTasks(); refreshStats(); drawBacklog(); });
    list.querySelectorAll('[data-del]').forEach(b=> b.onclick = ()=>{ deleteTask(b.dataset.del); drawTasks(); refreshStats(); drawBacklog(); });
    list.querySelectorAll('[data-b]').forEach(b=> b.onclick = ()=>{ moveToBacklog(b.dataset.b); drawTasks(); drawBacklog(); refreshStats(); });
    list.querySelectorAll('[data-edit]').forEach(b=> b.onclick = ()=>{ openTaskModal(b.dataset.edit); });
  }
  function drawBacklog(){ const list = document.getElementById('projBacklogList'); const tasks = getProjectBacklog(); list.innerHTML = `<div class='muted' style='font-size:12px;margin-bottom:4px;'>Backlog (${tasks.length})</div>` + (tasks.length? tasks.map(t=> `<div class='row' style='justify-content:space-between;'>
      <span class='muted' style='font-size:12px;'>${htmlesc(t.title)}</span>
      <div class='row' style='gap:6px;'>
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
function renderIdeas(){
  content.innerHTML = `
  <div class="card">
    <div class="row"><input id="idea" type="text" placeholder="Capture an idea… (Enter to add)" style="flex:1;"/></div>
  </div>
  <div id="ideaList" class="list"></div>`;
  const idea = $("#idea");
  idea.onkeydown = (e)=> { if(e.key==="Enter" && idea.value.trim()){ const n=createNote({title:idea.value.trim(), content:"", type:"idea"}); idea.value=""; draw(); openNote(n.id); } };
  function draw(){
    const notes = db.notes.filter(n=> n.type==="idea").sort((a,b)=> b.createdAt.localeCompare(a.createdAt));
    $("#ideaList").innerHTML = notes.map(n=> `
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:center;">
          <span style="flex:1;cursor:pointer;" data-open="${n.id}">${htmlesc(n.title)}</span>
          <div class="row" style="gap:6px;">
            <button class="btn" data-open="${n.id}" style="font-size:12px;">Open</button>
            <button class="btn" data-del="${n.id}" style="font-size:12px;">✕</button>
          </div>
        </div>
      </div>`).join("");
    document.querySelectorAll('[data-open]').forEach(b=> b.onclick=()=> openNote(b.dataset.open));
    document.querySelectorAll('[data-del]').forEach(b=> b.onclick=async ()=>{
      const ok = await showConfirm('Delete idea?', 'Delete', 'Cancel');
      if(!ok) return;
      db.notes = db.notes.filter(x=> x.id !== b.dataset.del);
      save();
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
    openNote(t.noteId);
    return;
  }
  if(t.projectId){
    route='projects';
    render();
    const btn = document.querySelector(`[data-project-id="${t.projectId}"]`);
    if(btn) btn.scrollIntoView({behavior:'smooth', block:'center'});
    return;
  }
  route='today';
  render();
}

function openProjectContext(projectId){
  if(!projectId) return;
  currentProjectId = projectId;
  route='projects';
  render();
  const btn = document.querySelector(`[data-project-id="${projectId}"]`);
  if(btn) btn.scrollIntoView({behavior:'smooth', block:'center'});
}

function renderReview(){
  // Exclude deleted tasks from analytics
  const done = db.tasks.filter(t=> t.status==='DONE' && !t.deletedAt);
  const activeTasks = db.tasks.filter(t=> t.status!=='BACKLOG' && !t.deletedAt);
  const total = activeTasks.length; // fix 0/1 bug
  const pct = total? Math.round(done.length/total*100) : 0;
  const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate()-7);
  const weekTasks = db.tasks.filter(t=> t.completedAt && new Date(t.completedAt) > weekAgo && !t.deletedAt);
  const weekNotes = db.notes.filter(n=> new Date(n.createdAt) > weekAgo);
  const projectStats = db.projects.map(p=>{
    const tasks = db.tasks.filter(t=> t.projectId === p.id && !t.deletedAt);
    const completed = tasks.filter(t=> t.status === 'DONE').length;
    return { project: p, total: tasks.length, completed, progress: tasks.length ? Math.round(completed/tasks.length*100) : 0 };
  }).filter(s=> s.total > 0);
  const pendingAll = db.tasks.filter(t=> t.status==='TODO' && t.status!=='BACKLOG' && !t.deletedAt);
  const backlogAll = db.tasks.filter(t=> t.status==='BACKLOG' && !t.deletedAt);
  const pPriority = {high:3,medium:2,low:1};
  pendingAll.sort((a,b)=> (pPriority[b.priority]||2)-(pPriority[a.priority]||2));
  backlogAll.sort((a,b)=> (pPriority[b.priority]||2)-(pPriority[a.priority]||2));

  // Upcoming tasks: tasks with a due date within next 7 days and still pending (TODO)
  const today = new Date();
  const in7 = new Date(); in7.setDate(today.getDate()+7);
  const upcoming = db.tasks.filter(t => t.status==='TODO' && t.due && !t.deletedAt && new Date(t.due) >= today && new Date(t.due) <= in7);
  upcoming.sort((a,b)=> new Date(a.due) - new Date(b.due));

  // Precompute HTML for completed tasks history. Sort by completion date (latest first).
  const completedHtml = done.length ? done.slice().sort((a,b)=>{
    // Use completedAt first, fallback to updatedAt or createdAt
    const aDate = a.completedAt || a.updatedAt || a.createdAt;
    const bDate = b.completedAt || b.updatedAt || b.createdAt;
    return (new Date(bDate)) - (new Date(aDate));
  }).map(t=>{
    const proj = t.projectId ? db.projects.find(p=> p.id === t.projectId) : null;
    const note = t.noteId ? db.notes.find(n=> n.id === t.noteId) : null;
    const ctx = proj ? `<span class='pill'>${htmlesc(proj.name)}</span>` : (note && note.type === 'daily' ? `<span class='pill'>${note.dateIndex}</span>` : '');
    const dateStr = t.completedAt ? new Date(t.completedAt).toLocaleDateString() : '';
    return `<div class='row' style='justify-content:space-between;align-items:center;'>
      <span style='flex:1;'>${htmlesc(t.title)} ${ctx} <span class='pill'>${dateStr}</span></span>
      <div class='row' style='gap:4px;'>
        <button class='btn' data-open-task='${t.id}' style='font-size:11px;'>Open</button>
        <button class='btn' data-restore='${t.id}' style='font-size:11px;'>Restore</button>
      </div>
    </div>`;
  }).join('') : '<div class="muted">No completed tasks</div>';

  content.innerHTML = `
    <div class="review">
    <div class="grid-2">
      <div class="card">
        <strong>📊 Analytics</strong>
        <div class="muted" style="margin-top:6px;">Tasks completed: ${done.length}/${total||0} (${pct}%)</div>
        <div class="muted">This week: ${weekTasks.length} tasks, ${weekNotes.length} notes</div>
      </div>
      <div class="card">
        <strong>🎯 Project Progress</strong>
        <div class="list" style="margin-top:8px;">
          ${projectStats.map(s=>`<div class='row' style='justify-content:space-between;align-items:center;'>
            <span>${htmlesc(s.project.name)}</span>
            <div class='row' style='gap:6px;align-items:center;'>
              <span class='muted'>${s.completed}/${s.total} (${s.progress}%)</span>
              <button class='btn' data-open-project='${s.project.id}' style='font-size:11px;'>Open</button>
            </div>
          </div>`).join('') || '<div class="muted">No project tasks yet</div>'}
        </div>
      </div>
    </div>
    <div class="card">
      <strong>📅 Upcoming Tasks (${upcoming.length})</strong>
      <div class="list" style="margin-top:8px;max-height:240px;overflow:auto;">
  ${upcoming.map(t=>{
          const proj = t.projectId ? db.projects.find(p=>p.id===t.projectId) : null;
          const note = t.noteId ? db.notes.find(n=>n.id===t.noteId) : null;
          const ctx = proj ? `<span class='pill'>${htmlesc(proj.name)}</span>` : (note && note.type==='daily' ? `<span class='pill'>${note.dateIndex}</span>` : '');
          const dueStr = t.due ? formatDateString(t.due) : '';
          const colors = { high: '#ff6b6b', medium: '#4ea1ff', low: '#64748b' };
          const col = colors[t.priority || 'medium'];
          return `<div class='row' style='justify-content:space-between;align-items:center;'>
            <span style='border-left:3px solid ${col};padding-left:6px;'>${htmlesc(t.title)} ${ctx} <span class='pill'>${dueStr}</span></span>
            <div class='row' style='gap:4px;'>
              <button class='btn' data-open-task='${t.id}' style='font-size:11px;'>Open</button>
              <button class='btn' data-done='${t.id}' style='font-size:11px;'>✓</button>
            </div>
          </div>`;
        }).join('') || '<div class="muted">No upcoming tasks</div>'}
      </div>
    </div>
    <div class="card">
      <strong>🕒 Pending Tasks (${pendingAll.length})</strong>
      <div class="list" style="margin-top:8px;max-height:240px;overflow:auto;">
        ${pendingAll.map(t=>{ const proj = t.projectId ? db.projects.find(p=>p.id===t.projectId) : null; const note = t.noteId ? db.notes.find(n=>n.id===t.noteId) : null; const label = htmlesc(t.title); const ctx = proj? `<span class='pill'>${htmlesc(proj.name)}</span>` : (note && note.type==='daily'? `<span class='pill'>${note.dateIndex}</span>` : ''); const colors={high:'#ff6b6b',medium:'#4ea1ff',low:'#64748b'}; return `<div class='row' style='justify-content:space-between;align-items:center;'>
          <span style='border-left:3px solid ${colors[t.priority||'medium']};padding-left:6px;'>${label} ${ctx}</span>
          <div class='row' style='gap:4px;'>
            <button class='btn' data-open-task='${t.id}' style='font-size:11px;'>Open</button>
            <button class='btn' data-done='${t.id}' style='font-size:11px;'>✓</button>
          </div>
        </div>`; }).join('') || '<div class="muted">No pending tasks</div>'}
      </div>
    </div>
    <div class="card">
      <strong>📦 Backlog Tasks (${backlogAll.length})</strong>
      <div class="list" style="margin-top:8px;max-height:240px;overflow:auto;">
        ${backlogAll.map(t=>{ const proj = t.projectId ? db.projects.find(p=>p.id===t.projectId) : null; const note = t.noteId ? db.notes.find(n=>n.id===t.noteId) : null; const label = htmlesc(t.title); const ctx = proj? `<span class='pill'>${htmlesc(proj.name)}</span>` : (note && note.type==='daily'? `<span class='pill'>${note.dateIndex}</span>` : ''); return `<div class='row' style='justify-content:space-between;align-items:center;'>
          <span class='muted' style='padding-left:6px;'>${label} ${ctx}</span>
          <div class='row' style='gap:4px;'>
            <button class='btn' data-open-task='${t.id}' style='font-size:11px;'>Open</button>
            <button class='btn' data-restore='${t.id}' style='font-size:11px;'>Restore</button>
          </div>
        </div>`; }).join('') || '<div class="muted">No backlog tasks</div>'}
      </div>
    </div>
    <!-- Completed tasks history -->
    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:center;">
        <strong>✅ Completed Tasks (${done.length})</strong>
        <button id="clearCompleted" class="btn" style="font-size:12px;">Clear History</button>
      </div>
      <div class="list" style="margin-top:8px;max-height:240px;overflow:auto;">
        ${completedHtml}
      </div>
    </div>
    <!-- Trash section for soft-deleted tasks -->
    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:center;">
        <strong>🗑️ Trash (${getTrashedTasks().length})</strong>
        <button id="emptyTrashBtn" class="btn" style="font-size:12px;">Empty Trash</button>
      </div>
      <div class="list" style="margin-top:8px;max-height:240px;overflow:auto;">
  ${getTrashedTasks().map(t=>{
          const proj = t.projectId ? db.projects.find(p=>p.id===t.projectId) : null;
          const note = t.noteId ? db.notes.find(n=>n.id===t.noteId) : null;
          const label = htmlesc(t.title);
          const ctx = proj ? `<span class='pill'>${htmlesc(proj.name)}</span>` : (note && note.type==='daily' ? `<span class='pill'>${note.dateIndex}</span>` : '');
          const deletedDate = t.deletedAt ? new Date(t.deletedAt).toLocaleDateString() : '';
          return `<div class='row' style='justify-content:space-between;align-items:center;'>
            <span class='muted' style='padding-left:6px;'>${label} ${ctx} <span class='pill'>Deleted: ${deletedDate}</span></span>
            <div class='row' style='gap:4px;'>
              <button class='btn' data-open-task='${t.id}' style='font-size:11px;'>Open</button>
              <button class='btn' data-restore-task='${t.id}' style='font-size:11px;'>Restore</button>
              <button class='btn' data-hard-delete='${t.id}' style='font-size:11px;color:#ff6b6b;'>Delete</button>
            </div>
          </div>`;
        }).join('') || '<div class="muted">Trash is empty</div>'}
      </div>
    </div>
    <div class="card">
      <strong>📅 Recent Daily Logs</strong>
      <div class="list" style="margin-top:8px;">${db.notes.filter(n=>n.type==='daily').slice(-7).reverse().map(n=> `<div class='row' style='justify-content:space-between;'><span>${htmlesc(n.title)}</span><button class='btn' data-open='${n.id}'>Open</button></div>`).join('')}</div>
    </div>
    <div class="card">
      <strong>🏷️ Tag Cloud</strong>
  <div style="margin-top:8px;">${getAllTags().map(tag=>{
        const noteCount = db.notes.filter(n=> (n.tags||[]).includes(tag)).length;
        const linkCount = db.links ? db.links.filter(l=> (l.tags||[]).includes(tag)).length : 0;
        const count = noteCount + linkCount;
        return `<button class='pill' data-tag='${tag}' style='cursor:pointer;margin:2px;'>#${htmlesc(tag)} (${count})</button>`;
      }).join('') || '<div class="muted">No tags yet</div>'}</div>
    </div>
    </div>`;
  content.querySelectorAll('[data-open]').forEach(b=> b.onclick=()=> openNote(b.dataset.open));
  content.querySelectorAll('[data-open-note]').forEach(b=> b.onclick=()=> openNote(b.dataset.openNote));
  content.querySelectorAll('[data-open-task]').forEach(b=> b.onclick=()=> openTaskContext(b.dataset.openTask));
  content.querySelectorAll('[data-open-project]').forEach(b=> b.onclick=()=> openProjectContext(b.dataset.openProject));
  content.querySelectorAll('[data-done]').forEach(b=> b.onclick=()=>{ setTaskStatus(b.dataset.done,'DONE'); renderReview(); });
  content.querySelectorAll('[data-restore]').forEach(b=> b.onclick=()=>{
    const id = b.dataset.restore;
    const task = db.tasks.find(t => t.id === id);
    if(task){
      // If restoring a completed task (status DONE), reassign it to today's daily note
      if(task.status === 'DONE'){
        const key = selectedDailyDate || todayKey();
        let daily = db.notes.find(n => n.type === 'daily' && n.dateIndex === key);
        if(!daily) daily = createDailyNoteFor(key);
        // Assign task to today's daily note
        task.noteId = daily.id;
      }
    }
    setTaskStatus(id,'TODO');
    renderReview();
  });
  content.querySelectorAll('[data-tag]').forEach(b=> b.onclick=()=>{ route='vault'; document.getElementById('q').value='#'+b.dataset.tag; render(); });

  // Trash handlers
  content.querySelectorAll('[data-restore-task]').forEach(b=> b.onclick=()=>{ restoreTask(b.dataset.restoreTask); renderReview(); });
  content.querySelectorAll('[data-hard-delete]').forEach(b=> b.onclick=async ()=>{ 
    const task = db.tasks.find(t => t.id === b.dataset.hardDelete);
    const ok = await showConfirm(`Permanently delete "${task?.title || 'this task'}"? This cannot be undone.`, 'Delete Forever', 'Cancel');
    if(ok) { hardDeleteTask(b.dataset.hardDelete); renderReview(); }
  });

  // Empty trash handler
  const emptyTrashBtn = document.getElementById('emptyTrashBtn');
  if(emptyTrashBtn){
    emptyTrashBtn.onclick = async () => {
      const deletedTasks = getTrashedTasks();
      if(deletedTasks.length === 0) return;
      const ok = await showConfirm(`Permanently delete all ${deletedTasks.length} tasks from trash? This cannot be undone.`, 'Empty Trash', 'Cancel');
      if(ok) { emptyTrash(); renderReview(); }
    };
  }

  // Handler for clearing completed tasks history
  const clearBtn = document.getElementById('clearCompleted');
  if(clearBtn){
    clearBtn.onclick = async () => {
      const ok = await showConfirm('Clear all completed tasks history?', 'Clear', 'Cancel');
      if(!ok) return;
      // Soft delete all done tasks that haven't already been deleted
      db.tasks.filter(t => t.status === 'DONE' && !t.deletedAt).forEach(t => deleteTask(t.id));
      // Re-render review after clearing
      renderReview();
    };
  }
}

// --- Map view ---
function renderMap() {
  // Build a structured mind-map view. We consider only notes that either link to others
  // or are linked to. To make the visualization more intuitive, we treat notes with no
  // incoming links as roots and build trees from them. If cycles exist, the first
  // unvisited note becomes the root of its own tree. Each note appears only once to
  // prevent infinite loops. This results in a clean, hierarchical overview of your
  // linked notes network.
  const notes = db.notes || [];
  // Identify notes involved in at least one link (as source or target)
  const connected = notes.filter(n => {
    const hasOut = Array.isArray(n.links) && n.links.length > 0;
    const hasIn = notes.some(other => Array.isArray(other.links) && other.links.includes(n.id));
    return hasOut || hasIn;
  });
  // Build a map from note id to list of incoming link counts
  const incomingCount = {};
  connected.forEach(n => { incomingCount[n.id] = 0; });
  connected.forEach(n => {
    if (Array.isArray(n.links)) {
      n.links.forEach(target => {
        if (incomingCount[target] !== undefined) incomingCount[target]++;
      });
    }
  });
  // Determine root notes: those with no incoming links. If none found (cycle), treat
  // all connected notes as potential roots and rely on visited set to avoid repeats.
  const roots = connected.filter(n => incomingCount[n.id] === 0);
  const visited = new Set();
  function buildList(note, depth) {
    // Avoid infinite recursion and deep nesting
    if (!note || visited.has(note.id) || depth > 20) return '';
    visited.add(note.id);
    // Determine children from the note's links. Only include children that are in the
    // connected set to avoid showing unrelated notes.
    const children = Array.isArray(note.links) ? note.links.map(id => connected.find(m => m.id === id)).filter(Boolean) : [];
    const childHtml = children.length
      ? `<ul>${children.map(child => buildList(child, depth + 1)).join('')}</ul>`
      : '';
    return `<li><a href="#" data-note="${note.id}">${htmlesc(note.title)}</a>${childHtml}</li>`;
  }
  // Build HTML for the map. Use roots if available; otherwise fall back to all connected
  // notes. Sorting by title improves predictability of ordering.
  const sourceList = roots.length ? roots : connected;
  sourceList.sort((a,b) => a.title.localeCompare(b.title));
  const mapHtml = `<ul class="mind-map">${sourceList.map(n => {
    if (visited.has(n.id)) return '';
    return buildList(n, 0);
  }).join('')}</ul>`;
  content.innerHTML = `<div class="card"><h2>Note Map</h2>${mapHtml}</div>`;
  // Bind click events on map links to open notes. Use event delegation for safety.
  content.querySelectorAll('[data-note]').forEach(el => {
    el.onclick = (e) => {
      e.preventDefault();
      const id = el.dataset.note;
      openNote(id);
    };
  });
}

// --- Link note modal ---
let _linkTargetNoteId = null;
function openLinkModal(noteId) {
  const modal = document.getElementById('linkModal');
  const select = document.getElementById('linkSelect');
  const searchInput = document.getElementById('linkSearch');
  const addBtn = document.getElementById('linkAdd');
  const cancelBtn = document.getElementById('linkCancel');
  _linkTargetNoteId = noteId;
  // Populate select with all other notes
  const populate = (filter='') => {
    const opts = db.notes.filter(n => n.id !== noteId && n.title.toLowerCase().includes(filter.toLowerCase())).map(n => `<option value="${n.id}">${htmlesc(n.title)}</option>`).join('');
    select.innerHTML = opts;
  };
  // Reset search field and populate options
  if(searchInput) searchInput.value = '';
  populate('');
  // Filter notes on input
  if(searchInput) {
    searchInput.oninput = () => {
      populate(searchInput.value || '');
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
function renderMonthly(){
  // Ensure the monthly collection exists
  if(!db.monthly) db.monthly = [];
  // Determine current month key (YYYY-MM) for grouping
  const monthKey = (selectedDailyDate || todayKey()).slice(0,7);
  // Build UI for monthly planning - fix timezone issue by parsing year and month separately
  const [year, month] = monthKey.split('-');
  const monthLabel = new Date(parseInt(year), parseInt(month) - 1, 1).toLocaleDateString(undefined, { month:'long', year:'numeric' });
  
  // Preserve input state if re-rendering
  const preservedTitle = document.getElementById('monthlyTaskTitle')?.value || '';
  const preservedDays = Array.from(document.querySelectorAll('.monthly-day-option input:checked') || []).map(cb => cb.value);
  
  // Preserve view mode
  const preservedViewMode = localStorage.getItem('monthlyViewMode') || 'list';
  
  content.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:16px;">
        <strong>🗓️ Monthly Planning — ${htmlesc(monthLabel)}</strong>
        <div class="muted" style="font-size:12px;">Recurring tasks for daily pages</div>
      </div>
      
      <div style="margin-bottom:16px;">
        <label for="monthlyTaskTitle" class="muted" style="display:block;margin-bottom:6px;">Task Name</label>
        <input id="monthlyTaskTitle" type="text" 
               placeholder="e.g., Review emails, Morning workout" 
               value="${htmlesc(preservedTitle)}" 
               style="margin-bottom:12px;" />
        
        <div class="row" style="gap:8px;margin-bottom:16px;">
          <button id="monthlyAdd" class="btn acc">➕ Add Task</button>
          <button id="monthlyClear" class="btn">Clear</button>
        </div>
        
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start;">
          <div>
            <label for="monthlyTaskDays" class="muted" style="display:block;margin-bottom:6px;">Select Days</label>
            <div class="monthly-days-grid">
              <label class="monthly-day-option"><input type="checkbox" value="1" data-day="1"> Monday</label>
              <label class="monthly-day-option"><input type="checkbox" value="2" data-day="2"> Tuesday</label>
              <label class="monthly-day-option"><input type="checkbox" value="3" data-day="3"> Wednesday</label>
              <label class="monthly-day-option"><input type="checkbox" value="4" data-day="4"> Thursday</label>
              <label class="monthly-day-option"><input type="checkbox" value="5" data-day="5"> Friday</label>
              <label class="monthly-day-option"><input type="checkbox" value="6" data-day="6"> Saturday</label>
              <label class="monthly-day-option"><input type="checkbox" value="0" data-day="0"> Sunday</label>
            </div>
          </div>
          
          <div>
            <div class="muted" style="margin-bottom:6px;">Quick Select</div>
            <div style="display:flex;flex-direction:column;gap:4px;">
              <button type="button" class="btn" data-days="1,2,3,4,5" style="font-size:12px;padding:6px 12px;text-align:left;">Weekdays (Mon-Fri)</button>
              <button type="button" class="btn" data-days="0,6" style="font-size:12px;padding:6px 12px;text-align:left;">Weekends (Sat-Sun)</button>
              <button type="button" class="btn" data-days="1,3,5" style="font-size:12px;padding:6px 12px;text-align:left;">MWF</button>
              <button type="button" class="btn" data-days="2,4" style="font-size:12px;padding:6px 12px;text-align:left;">T/TH</button>
              <button type="button" class="btn" data-days="0,1,2,3,4,5,6" style="font-size:12px;padding:6px 12px;text-align:left;">Daily</button>
            </div>
          </div>
        </div>
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
    
    // Filter tasks for current month (or tasks without explicit month)
    const tasks = (db.monthly || []).filter(t => (!t.month || t.month === monthKey));
    
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
      listEl.innerHTML = `<div class='muted' style='text-align:center;padding:32px 16px;grid-column:1/-1;'>No recurring tasks yet. Add one above to get started.</div>`;
      return;
    }
    
    listEl.innerHTML = tasks.map(t => {
      const dayNames = t.days.map(d => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d]).join(', ');
      const dayCount = t.days.length;
      const daysSummary = dayCount === 7 ? 'Daily' : 
                         dayCount === 5 && t.days.every(d => d >= 1 && d <= 5) ? 'Weekdays' :
                         dayCount === 2 && t.days.includes(0) && t.days.includes(6) ? 'Weekends' :
                         dayCount === 2 && t.days.includes(2) && t.days.includes(4) ? 'T/TH' :
                         dayCount === 3 && t.days.includes(1) && t.days.includes(3) && t.days.includes(5) ? 'MWF' :
                         dayNames;
      
      return `
        <div class='monthly-task-item'>
          <div class='monthly-task-header'>
            <div class='monthly-task-title'>${htmlesc(t.title)}</div>
            <button class='monthly-task-delete' data-del='${t.id}' title='Delete recurring task'>✕</button>
          </div>
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
            db.monthly = db.monthly.filter(x => x.id !== id);
            save();
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

  // Restore selected days from preserved state
  setTimeout(() => {
    const dayCheckboxes = document.querySelectorAll('.monthly-day-option input[type="checkbox"]');
    if(dayCheckboxes.length && preservedDays.length) {
      dayCheckboxes.forEach(cb => {
        cb.checked = preservedDays.includes(cb.value);
      });
    }
  }, 0);

  // Quick select handlers for day buttons
  function setupQuickSelect() {
    document.querySelectorAll('[data-days]').forEach(btn => {
      btn.onclick = () => {
        const days = btn.dataset.days.split(',');
        const checkboxes = document.querySelectorAll('.monthly-day-option input[type="checkbox"]');
        if(checkboxes.length) {
          checkboxes.forEach(cb => {
            cb.checked = days.includes(cb.value);
          });
          // Visual feedback
          const originalBg = btn.style.background;
          btn.style.background = 'var(--acc)';
          btn.style.color = 'white';
          setTimeout(() => {
            btn.style.background = originalBg;
            btn.style.color = '';
          }, 300);
        }
      };
    });
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

  // Add monthly task with improved validation and UX
  function handleAddTask() {
    const titleEl = document.getElementById('monthlyTaskTitle');
    const title = titleEl ? titleEl.value.trim() : '';
    
    // Visual feedback for missing title
    if(!title) {
      titleEl?.focus();
      // Visual feedback by temporarily changing border color
      if(titleEl) {
        const originalBorder = titleEl.style.borderColor;
        titleEl.style.borderColor = '#ff6b6b';
        setTimeout(() => {
          titleEl.style.borderColor = originalBorder;
        }, 2000);
      }
      return;
    }

    const checkboxes = document.querySelectorAll('.monthly-day-option input:checked');
    const days = Array.from(checkboxes).map(cb => parseInt(cb.value, 10)).filter(d => !isNaN(d));
    
    if(!days.length){
      // Visual feedback for missing days
      const daysContainer = document.querySelector('.monthly-days-grid');
      if(daysContainer) {
        const originalBorder = daysContainer.style.borderColor;
        daysContainer.style.borderColor = '#ff6b6b';
        setTimeout(() => {
          daysContainer.style.borderColor = originalBorder;
        }, 2000);
      }
      showValidationModal('Select Days Required', 'Please select at least one day of the week for this recurring task.');
      return;
    }

    // Check for duplicate task names
    const exists = db.monthly.find(t => t.title.toLowerCase() === title.toLowerCase() && (!t.month || t.month === monthKey));
    if(exists) {
      showValidationModal('Duplicate Task', 'A task with this name already exists for this month. Please choose a different name.');
      titleEl?.focus();
      return;
    }

    const id = uid();
    db.monthly.push({ id, title, days, month: monthKey, createdAt: nowISO() });
    
    // Clear form
    if(titleEl) titleEl.value = '';
    const allCheckboxes = document.querySelectorAll('.monthly-day-option input[type="checkbox"]');
    allCheckboxes.forEach(cb => cb.checked = false);
    
    // Visual feedback for successful addition
    const addBtn = document.getElementById('monthlyAdd');
    const originalText = addBtn?.innerHTML;
    if(addBtn) {
      addBtn.innerHTML = '✅ Added!';
      addBtn.style.background = '#22c55e';
      addBtn.style.borderColor = '#22c55e';
      setTimeout(() => {
        addBtn.innerHTML = originalText;
        addBtn.style.background = '';
        addBtn.style.borderColor = '';
      }, 1500);
    }
    
    save();
    drawMonthlyList();
    titleEl?.focus(); // Keep focus for easy addition of more tasks
  }
  // Event handlers with improved UX
  const addBtn = document.getElementById('monthlyAdd');
  const clearBtn = document.getElementById('monthlyClear');
  const titleInput = document.getElementById('monthlyTaskTitle');
  
  // Helper to track typing activity and prevent background sync interference
  function setTypingState(isTyping) {
    window._isTypingInForm = isTyping;
    if(_typingTimer) clearTimeout(_typingTimer);
    if(isTyping) {
      // Clear the typing state after 3 seconds of inactivity
      _typingTimer = setTimeout(() => {
        window._isTypingInForm = false;
      }, 3000);
    }
  }
  
  // Add task handler
  if(addBtn) {
    addBtn.onclick = handleAddTask;
  }
  
  // Clear form handler
  if(clearBtn) {
    clearBtn.onclick = () => {
      if(titleInput) titleInput.value = '';
      const checkboxes = document.querySelectorAll('.monthly-day-option input[type="checkbox"]');
      checkboxes.forEach(cb => cb.checked = false);
      titleInput?.focus();
    };
  }
  
  // Enter key to add task
  if(titleInput) {
    titleInput.onkeydown = (e) => {
      if(e.key === 'Enter') {
        e.preventDefault();
        handleAddTask();
      }
    };
    
    // Track typing to prevent background sync interference
    titleInput.oninput = () => {
      setTypingState(true);
    };
    
    titleInput.onfocus = () => setTypingState(true);
    titleInput.onblur = () => setTypingState(false);
  }
  
  // Track focus on days selection
  const dayCheckboxes = document.querySelectorAll('.monthly-day-option input[type="checkbox"]');
  dayCheckboxes.forEach(cb => {
    cb.onfocus = () => setTypingState(true);
    cb.onblur = () => setTypingState(false);
  });
  
  // Setup quick select buttons and view toggles
  setupQuickSelect();
  setupViewToggle();
  
  // Initial render
  drawMonthlyList();
}

// --- Added: Vault & Links views (previously missing) ---
function renderVault(){
  const query = (document.getElementById('q')?.value || '').trim();
  const tagFilters = (query.match(/#[\w-]+/g)||[]).map(t=>t.slice(1).toLowerCase());
  const text = query.replace(/#[\w-]+/g,'').trim().toLowerCase();
  let notes = db.notes.slice();
  if(tagFilters.length){ notes = notes.filter(n=> tagFilters.every(t=> (n.tags||[]).map(x=>x.toLowerCase()).includes(t))); }
  if(text){ notes = notes.filter(n=> n.title.toLowerCase().includes(text) || (n.content||'').toLowerCase().includes(text)); }
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
      if(tagFilters.length && !tagFilters.every(t=> (l.tags||[]).map(x=>x.toLowerCase()).includes(t))) return false;
      if(text && !(l.title.toLowerCase().includes(text) || l.url.toLowerCase().includes(text))) return false;
      return true;
    }).sort((a,b)=> (b.pinned?1:0)-(a.pinned?1:0) || b.updatedAt.localeCompare(a.updatedAt));
    // Projects: only text filter (projects have no tags yet)
    if(text && !tagFilters.length){
      projectMatches = db.projects.filter(p=> p.name.toLowerCase().includes(text));
    }
    // Tasks: only if no tag filters (tasks have no tags); search title
    if(text && !tagFilters.length){
      taskMatches = db.tasks.filter(t=> t.title.toLowerCase().includes(text)).slice(0,50); // cap to avoid huge lists
    }
  }
  const highlight = (s)=>{ if(!text) return htmlesc(s); return htmlesc(s).replace(new RegExp(text.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&'),'ig'), m=>`<mark style='background:#274768;color:inherit;'>${m}</mark>`); };
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
          <span>${highlight(htmlesc(t.title))} ${(note&&note.type==='daily')?`<span class='pill'>${note.dateIndex}</span>`:''} ${proj?`<span class='pill'>${htmlesc(proj.name)}</span>`:''}</span>
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
        <span style='cursor:pointer;' data-open='${n.id}'>${highlight(n.title)}${n.type==='daily'?` <span class='pill'>${n.dateIndex||''}</span>`:''}${n.type==='idea'?` <span class='pill'>idea</span>`:''}</span>
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
  content.querySelectorAll('[data-open]').forEach(b=> b.onclick=()=> openNote(b.dataset.open));
  content.querySelectorAll('[data-pin]').forEach(b=> b.onclick=()=>{ const note=db.notes.find(x=>x.id===b.dataset.pin); if(note){ note.pinned=!note.pinned; save(); renderVault(); } });
  content.querySelectorAll('[data-tag]').forEach(b=> b.onclick=()=>{ document.getElementById('q').value='#'+b.dataset.tag; renderVault(); });
  content.querySelectorAll('[data-del]').forEach(b=> b.onclick=async ()=>{
    const note = db.notes.find(x=> x.id === b.dataset.del);
    if(!note) return;
    const msg = `Delete note \"${note.title}\"${note.type==='daily'?' (daily)':''}? This will also remove its tasks.`;
    const ok = await showConfirm(msg, 'Delete', 'Cancel');
    if(!ok) return;
    db.tasks = db.tasks.filter(t=> t.noteId !== note.id);
    db.notes = db.notes.filter(n=> n.id !== note.id);
    save();
    renderVault();
  });
  // NEW event bindings for links / projects
  content.querySelectorAll('[data-open-link]').forEach(b=> b.onclick=()=> window.open(b.dataset.openLink,'_blank'));
  content.querySelectorAll('[data-pin-link]').forEach(b=> b.onclick=()=>{ const l=db.links.find(x=>x.id===b.dataset.pinLink); if(l){ l.pinned=!l.pinned; save(); renderVault(); }});
  content.querySelectorAll('[data-open-project]').forEach(b=> b.onclick=()=>{ currentProjectId=b.dataset.openProject; route='projects'; render(); });
  document.getElementById('newNote').onclick = ()=> openDraftNote({});
  document.getElementById('sortAZ').onclick = ()=>{ document.getElementById('q').value=''; notes.sort((a,b)=> a.title.localeCompare(b.title)); renderVault(); };
  document.getElementById('sortRecent').onclick = ()=>{ document.getElementById('q').value=''; notes.sort((a,b)=> b.updatedAt.localeCompare(a.updatedAt)); renderVault(); };
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
        <input id='linkTags' type='text' placeholder='tags (space)' style='flex:1;min-width:120px;' />
        <button id='addLink' class='btn acc'>Add</button>
      </div>
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
    let links = db.links.slice();
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
      updateLink(id, {title: newTitle.trim() || newUrl.trim(), url: newUrl.trim(), tags: newTags.split(/\s+/).map(t=> t.startsWith('#') ? t.slice(1) : t).filter(Boolean)});
      draw();
    })();
  }
  document.getElementById('addLink').onclick = ()=>{
    const title = document.getElementById('linkTitle').value.trim();
    const url = document.getElementById('linkUrl').value.trim();
    if(!url) return;
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
  draw();
}
// --- End Links view ---

// --- Note editor ---
function openNote(id){
  const n = db.notes.find(x=>x.id===id);
  if(!n){ alert('Note not found'); return; }
  // Record which note is open and reset dirty flag when opening.
  window._openNoteId = n.id;
  window._editorDirty = false;
  content.innerHTML = `
    <div class="card">
      <input id="title" type="text" value="${htmlesc(n.title)}" />
      <div class="row" style="margin-top:8px;flex-wrap:wrap;gap:8px;">
        <input id="tags" type="text" placeholder="Tags (space separated)" value="${(n.tags||[]).map(t=>'#'+t).join(' ')}" />
        <label style="margin-left:8px;"><input id="pinned" type="checkbox" ${n.pinned?'checked':''}> Pin</label>
        <button id="addSketch" class="btn" style="font-size:12px;">Add Sketch</button>
        <button id="addVoice" class="btn" style="font-size:12px;">Add Voice</button>
        <!-- Attachment uploader -->
        <label class="btn" for="noteAttachFile" style="font-size:12px;">Attach</label>
        <input id="noteAttachFile" type="file" class="hidden" multiple />
      </div>
      <div class="row" style="margin-top:8px; gap:8px; align-items:center;">
        <button id="toggleModeBtn" class="btn acc" style="font-size:12px;">Edit</button>
        <span style="font-size:12px; color:var(--muted);">Ctrl+Shift+V to toggle | Ctrl+S to save</span>
      </div>
      <div style="margin-top:8px;">
        <textarea id="contentBox" style="min-height:300px;">${htmlesc(n.content||'')}</textarea>
        <div id="markdownPreview" class="markdown-preview" style="min-height:300px; display:none;"></div>
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
      <div class="row" style="margin-top:8px; gap:8px;flex-wrap:wrap;">
        <button id="save" class="btn acc">Save</button>
        <button id="back" class="btn">Back</button>
        <button id="duplicate" class="btn">Duplicate</button>
        <button id="export" class="btn">Export</button>
        <button id="delete" class="btn" style="border-color:#ff6b6b;color:#ff6b6b;">Delete</button>
      </div>`;
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
  const saveBtn = document.getElementById('save');
  saveBtn.onclick = () => {
    const tagText = document.getElementById('tags').value;
    const tags = tagText ? tagText.split(/\s+/).map(t => t.startsWith('#') ? t.slice(1) : t).filter(Boolean) : [];
    updateNote(n.id, {
      title: document.getElementById('title').value,
      content: document.getElementById('contentBox').value,
      tags,
      pinned: document.getElementById('pinned').checked
    });
    // Mark the note as no longer dirty once it has been saved.
    window._editorDirty = false;
  };
  document.getElementById('back').onclick = ()=>{
    if(n.type==='daily'){ route='today'; render(); }
    else if(n.projectId){ route='projects'; render(); }
    else if(n.type==='idea'){ route='ideas'; render(); }
    else { route='vault'; render(); }
  };
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
    const ok = await showConfirm('Delete this note and its tasks? This cannot be undone.', 'Delete', 'Cancel');
    if(!ok) return;
    // Remove tasks linked to this note
    db.tasks = db.tasks.filter(t=> t.noteId !== n.id);
    // Remove the note
    db.notes = db.notes.filter(x=> x.id !== n.id);
    save();
    if(n.type==='daily'){ route='today'; render(); }
    else if(n.projectId){ route='projects'; render(); }
    else if(n.type==='idea'){ route='ideas'; render(); }
    else { route='vault'; render(); }
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
  function renderAttachmentsList(){
    if(!attList) return;
    if(!n.attachments || n.attachments.length===0){
      attList.innerHTML = '';
      return;
    }
    attList.innerHTML = n.attachments.map(att=>{
      // Show image or audio preview for supported types, else show file name
      const isImg = att.type && att.type.startsWith('image');
      const isAudio = att.type && att.type.startsWith('audio');
      let preview;
      if(isImg){
        preview = `<img src="${att.data}" alt="${htmlesc(att.name)}" style="max-width:100%;max-height:150px;border:1px solid #203041;border-radius:8px;" />`;
      } else if(isAudio){
        preview = `<audio controls src="${att.data}" style="width:100%;"></audio>`;
      } else {
        preview = `<span class='pill' style='margin-right:6px;'>${htmlesc(att.name)}</span>`;
      }
      return `<div class='row' style='justify-content:space-between;align-items:center;'>
        <div style='flex:1;'>${preview}</div>
        <button class='btn' data-remove='${att.id}' style='font-size:12px;'>Remove</button>
      </div>`;
    }).join('');
    // Bind remove handlers
    attList.querySelectorAll('[data-remove]').forEach(b=> b.onclick = ()=>{
      const id = b.dataset.remove;
      n.attachments = n.attachments.filter(x=> x.id !== id);
      save();
      renderAttachmentsList();
    });
  }
  renderAttachmentsList();
  if(attachInput){
    attachInput.onchange = (e)=>{
      const files = Array.from(e.target.files || []);
      files.forEach(file=>{
        const reader = new FileReader();
        reader.onload = (ev)=>{
          const dataUrl = ev.target.result;
          n.attachments.push({id: uid(), name: file.name, type: file.type, data: dataUrl});
          save();
          renderAttachmentsList();
        };
        reader.readAsDataURL(file);
      });
      // Reset input so same file can be selected again
      e.target.value = '';
    };
  }

  // Expose attachment renderer so other modals (e.g., voice, sketch) can refresh attachments
  window._renderAttachments = renderAttachmentsList;

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

  // Initialize markdown preview toggle functionality
  // This provides a clean edit/preview mode toggle with single button
  const previewEl = document.getElementById('markdownPreview');
  const contentBoxEl = document.getElementById('contentBox');
  const toggleModeBtn = document.getElementById('toggleModeBtn');
  
  let isPreviewMode = false;
  
  const toggleMode = () => {
    if (isPreviewMode) {
      // Switch to edit mode
      isPreviewMode = false;
      contentBoxEl.style.display = 'block';
      previewEl.style.display = 'none';
      toggleModeBtn.classList.add('acc');
      toggleModeBtn.textContent = 'Edit';
      // Focus the content box for immediate editing
      contentBoxEl.focus();
    } else {
      // Switch to preview mode
      isPreviewMode = true;
      previewEl.innerHTML = markdownToHtml(contentBoxEl.value);
      contentBoxEl.style.display = 'none';
      previewEl.style.display = 'block';
      toggleModeBtn.classList.remove('acc');
      toggleModeBtn.textContent = 'Preview';
      // Make preview focusable and focus it so shortcuts work
      previewEl.setAttribute('tabindex', '0');
      previewEl.focus();
    }
  };
  
  // Button event listener
  if(toggleModeBtn) toggleModeBtn.onclick = toggleMode;
  
  // Keyboard shortcuts for this note editor
  const keyHandler = (e) => {
    // Ctrl+Shift+V to toggle edit/preview
    if(e.ctrlKey && e.shiftKey && (e.key === 'V' || e.key === 'v' || e.code === 'KeyV' || e.keyCode === 86)) {
      e.preventDefault();
      e.stopPropagation();
      toggleMode();
      return false;
    }
    
    // Ctrl+S to save note
    if(e.ctrlKey && !e.shiftKey && (e.key === 's' || e.key === 'S' || e.code === 'KeyS')) {
      e.preventDefault();
      e.stopPropagation();
      // Trigger the same save functionality as the save button
      const saveBtn = document.getElementById('save');
      if(saveBtn) {
        saveBtn.click();
      }
      return false;
    }
  };
  
  // Add keyboard shortcuts with capture phase to ensure they work
  // Document level listener first (highest priority)
  document.addEventListener('keydown', keyHandler, true); // true = capture phase
  
  // Add to specific elements as backup
  if(contentBoxEl) {
    contentBoxEl.addEventListener('keydown', keyHandler);
  }
  // Also add to title field for convenience
  const titleEl = document.getElementById('title');
  if(titleEl) {
    titleEl.addEventListener('keydown', keyHandler);
  }
  // Add to preview element so shortcuts work in preview mode
  if(previewEl) {
    previewEl.addEventListener('keydown', keyHandler);
  }
  
  // Store the handler globally so it can be cleaned up when leaving the note
  window._noteKeyHandler = keyHandler;
  
  // Start in edit mode
  isPreviewMode = false;
  contentBoxEl.style.display = 'block';
  previewEl.style.display = 'none';
  toggleModeBtn.classList.add('acc');
  toggleModeBtn.textContent = 'Edit';
  
  // Make preview element focusable for keyboard shortcuts
  if(previewEl) {
    previewEl.setAttribute('tabindex', '0');
  }
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
        save();
        // Trigger global attachment re-renderer if available to ensure voice/sketch coexist
        if (typeof window._renderAttachments === 'function') {
          window._renderAttachments();
        }
        // Update the attachments list if the note editor is open.
        const attList = document.getElementById('attachments');
        if (attList) {
          // Simple re-render: rebuild the list and bind remove handlers.
          if (!note.attachments || note.attachments.length === 0) {
            attList.innerHTML = '';
          } else {
            attList.innerHTML = note.attachments.map(att => {
              const isImg = att.type && att.type.startsWith('image');
              const isAudio = att.type && att.type.startsWith('audio');
              let preview;
              if (isImg) {
                preview = `<img src="${att.data}" alt="${htmlesc(att.name)}" style="max-width:100%;max-height:150px;border:1px solid #203041;border-radius:8px;" />`;
              } else if (isAudio) {
                preview = `<audio controls src="${att.data}" style="width:100%;"></audio>`;
              } else {
                preview = `<span class='pill' style='margin-right:6px;'>${htmlesc(att.name)}</span>`;
              }
              return `<div class='row' style='justify-content:space-between;align-items:center;'>
        <div style='flex:1;'>${preview}</div>
        <button class='btn' data-remove='${att.id}' style='font-size:12px;'>Remove</button>
      </div>`;
            }).join('');
            attList.querySelectorAll('[data-remove]').forEach(b => {
              b.onclick = () => {
                const id = b.dataset.remove;
                note.attachments = note.attachments.filter(x => x.id !== id);
                save();
                // Refresh list after deletion
                if (!note.attachments || note.attachments.length === 0) {
                  attList.innerHTML = '';
                } else {
                  attList.innerHTML = note.attachments.map(att => {
                    const isImg2 = att.type && att.type.startsWith('image');
                    const isAudio2 = att.type && att.type.startsWith('audio');
                    let preview2;
                    if (isImg2) {
                      preview2 = `<img src="${att.data}" alt="${htmlesc(att.name)}" style="max-width:100%;max-height:150px;border:1px solid #203041;border-radius:8px;" />`;
                    } else if (isAudio2) {
                      preview2 = `<audio controls src="${att.data}" style="width:100%;"></audio>`;
                    } else {
                      preview2 = `<span class='pill' style='margin-right:6px;'>${htmlesc(att.name)}</span>`;
                    }
                    return `<div class='row' style='justify-content:space-between;align-items:center;'>
        <div style='flex:1;'>${preview2}</div>
        <button class='btn' data-remove='${att.id}' style='font-size:12px;'>Remove</button>
      </div>`;
                  }).join('');
                  // Re-bind remove handlers after updating
                  attList.querySelectorAll('[data-remove]').forEach(btn => {
                    btn.onclick = () => {
                      const id2 = btn.dataset.remove;
                      note.attachments = note.attachments.filter(x => x.id !== id2);
                      save();
                      if (!note.attachments || note.attachments.length === 0) {
                        attList.innerHTML = '';
                      } else {
                        attList.innerHTML = note.attachments.map(att => {
                          const isImg3 = att.type && att.type.startsWith('image');
                          const preview3 = isImg3 ? `<img src="${att.data}" alt="${htmlesc(att.name)}" style="max-width:100%;max-height:150px;border:1px solid #203041;border-radius:8px;" />` : `<span class='pill' style='margin-right:6px;'>${htmlesc(att.name)}</span>`;
                          return `<div class='row' style='justify-content:space-between;align-items:center;'>
        <div style='flex:1;'>${preview3}</div>
        <button class='btn' data-remove='${att.id}' style='font-size:12px;'>Remove</button>
      </div>`;
                        }).join('');
                        // Final re-bind to avoid stale handlers
                        attList.querySelectorAll('[data-remove]').forEach(reBtn => {
                          reBtn.onclick = () => {
                            const id3 = reBtn.dataset.remove;
                            note.attachments = note.attachments.filter(x => x.id !== id3);
                            save();
                            if (!note.attachments || note.attachments.length === 0) {
                              attList.innerHTML = '';
                            } else {
                              attList.innerHTML = note.attachments.map(att => {
                                const isImg4 = att.type && att.type.startsWith('image');
                                const preview4 = isImg4 ? `<img src="${att.data}" alt="${htmlesc(att.name)}" style="max-width:100%;max-height:150px;border:1px solid #203041;border-radius:8px;" />` : `<span class='pill' style='margin-right:6px;'>${htmlesc(att.name)}</span>`;
                                return `<div class='row' style='justify-content:space-between;align-items:center;'>
        <div style='flex:1;'>${preview4}</div>
        <button class='btn' data-remove='${att.id}' style='font-size:12px;'>Remove</button>
      </div>`;
                              }).join('');
                            }
                          };
                        });
                      }
                    };
                  });
                }
              };
            });
          }
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
  // When rendering a new section (today, projects, ideas, etc.), we are no longer editing a note.
  // Reset the open note tracking so that background sync will not reopen a note when the user has navigated away.
  window._openNoteId = null;
  window._editorDirty = false;
  
  // Clean up note-specific keyboard shortcuts
  if(window._noteKeyHandler) {
    document.removeEventListener('keydown', window._noteKeyHandler, true); // Remove capture phase listener
    document.removeEventListener('keydown', window._noteKeyHandler); // Remove bubble phase listener
    window._noteKeyHandler = null;
  }
  
  // Apply current theme before rendering UI elements
  applyTheme();
  renderNav();
  if(route==='today') renderToday();
  else if(route==='projects') renderProjects();
  else if(route==='ideas') renderIdeas();
  else if(route==='links') renderLinks(); // NEW
  else if(route==='vault') renderVault();
  else if(route==='monthly') renderMonthly(); // NEW
  else if(route==='review') renderReview();
  else if(route==='map') renderMap(); // handle map view
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
  document.getElementById("dailyRollover").onchange = ()=>{ db.settings.rollover = document.getElementById("dailyRollover").checked; save(db); };
  const autoCarryEl = document.getElementById("autoCarryTasks");
  if(autoCarryEl){
    autoCarryEl.checked = !!db.settings.autoCarryTasks;
    autoCarryEl.onchange = ()=>{ db.settings.autoCarryTasks = autoCarryEl.checked; save(db); };
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
    prevBtn.onclick = ()=>{ const d=new Date(selectedDailyDate); d.setDate(d.getDate()-1); selectedDailyDate = d.toISOString().slice(0,10); route='today'; render(); };
    nextBtn.onclick = ()=>{ if(selectedDailyDate===today) return; const d=new Date(selectedDailyDate); d.setDate(d.getDate()+1); const newKey=d.toISOString().slice(0,10); if(newKey>today) return; selectedDailyDate=newKey; route='today'; render(); };
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
  if(!db.settings.seenTip){ const t = document.getElementById("tip"); t.style.display="block"; document.getElementById("closeTip").onclick = ()=>{ db.settings.seenTip=true; save(db); t.style.display="none"; }; }
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
  let mediaRecorder = null;
  let timerInterval = null;
  let startTime = 0;
  // Update timer display
  function updateTimer() {
    const now = Date.now();
    const elapsed = now - startTime;
    const secs = Math.floor(elapsed / 1000);
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
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    if (timerEl) timerEl.textContent = '00:00';
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

      // If MediaRecorder is unavailable or the context is not secure, use fallback
      if (!hasMediaRecorder || !isSecure) {
        if (fallbackInput) {
          // Trigger native file/audio capture. The onchange handler will handle the file.
          fallbackInput.click();
        } else {
          alert('Recording is not supported in this environment.');
        }
        return;
      }
      try {
        // Request microphone stream
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Initialize MediaRecorder with supported MIME type if provided
        mediaRecorder = chosenType ? new MediaRecorder(stream, { mimeType: chosenType }) : new MediaRecorder(stream);
        mediaRecorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunks.push(e.data);
        };
        mediaRecorder.onstop = () => {
          // When recording stops, create blob and preview
          const blobType = chosenType || 'audio/webm';
          const blob = new Blob(chunks, { type: blobType });
          const url = URL.createObjectURL(blob);
          if (previewEl) previewEl.src = url;
          if (insertBtn) insertBtn.disabled = false;
          // Stop capturing from microphone
          stream.getTracks().forEach(t => t.stop());
        };
        // Reset chunks and start recording
        chunks = [];
        mediaRecorder.start();
        startTime = Date.now();
        timerInterval = setInterval(updateTimer, 200);
        startBtn.disabled = true;
        if (stopBtn) stopBtn.disabled = false;
        if (insertBtn) insertBtn.disabled = true;
      } catch (err) {
        // If microphone access fails, fall back to file input if available
        if (fallbackInput) {
          alert('Could not access microphone. Using the system recorder instead.');
          fallbackInput.click();
        } else {
          alert('Could not access microphone: ' + err.message);
        }
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
      if (!chunks.length) return;
      const blob = new Blob(chunks, { type: 'audio/webm' });
      const dataUrl = await blobToDataURL(blob);
      const name = `Voice ${new Date().toLocaleString()}.webm`;
      if (noteId === '__draft__') {
        if (!window._draftVoices) window._draftVoices = [];
        window._draftVoices.push({ id: uid(), name, type: 'audio/webm', data: dataUrl });
      } else {
        const note = db.notes.find(n => n.id === noteId);
        if (note) {
          if (!note.attachments) note.attachments = [];
          note.attachments.push({ id: uid(), name, type: 'audio/webm', data: dataUrl });
          save();
        }
      }
      // Update attachments list in open note view
      if (noteId !== '__draft__') {
        const attList = document.getElementById('attachments');
        if (attList) {
          const note = db.notes.find(n => n.id === noteId);
          if (note) {
            attList.innerHTML = (note.attachments || []).map(att => {
              const isImg = att.type && att.type.startsWith('image');
              const isAudio = att.type && att.type.startsWith('audio');
              let preview;
              if (isImg) {
                preview = `<img src="${att.data}" alt="${htmlesc(att.name)}" style="max-width:100%;max-height:150px;border:1px solid #203041;border-radius:8px;" />`;
              } else if (isAudio) {
                preview = `<audio controls src="${att.data}" style="width:100%;"></audio>`;
              } else {
                preview = `<span class='pill' style='margin-right:6px;'>${htmlesc(att.name)}</span>`;
              }
              return `<div class='row' style='justify-content:space-between;align-items:center;'>
        <div style='flex:1;'>${preview}</div>
        <button class='btn' data-remove='${att.id}' style='font-size:12px;'>Remove</button>
      </div>`;
            }).join('');
            attList.querySelectorAll('[data-remove]').forEach(b => {
              b.onclick = () => {
                const id2 = b.dataset.remove;
                note.attachments = note.attachments.filter(x => x.id !== id2);
                save();
                // Remove the row and update list
                const parent = b.closest('.row');
                if (parent) parent.remove();
              };
            });
          }
        }
      }
      // After inserting audio, ensure the attachments list is refreshed using the global renderer
      if(noteId !== '__draft__' && typeof window._renderAttachments === 'function') {
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
        // Replace chunks with the single blob
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
document.addEventListener('keydown', (e) => {
  if(e.key === 'Tab'){
    const el = e.target;
    if(el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text'))){
      e.preventDefault();
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const value = el.value;
      const insertion = '  '; // two spaces
      el.value = value.slice(0, start) + insertion + value.slice(end);
      const cursor = start + insertion.length;
      el.selectionStart = el.selectionEnd = cursor;
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
  
  document.querySelectorAll("[data-del]").forEach(b=> b.onclick = ()=>{
    (async ()=>{
      const ok = await showConfirm('Delete this template?', 'Delete', 'Cancel');
      if(!ok) return;
      db.templates = db.templates.filter(t => t.id !== b.dataset.del);
      save(db);
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

// Quick add
document.addEventListener("keydown", (e)=>{
  (async ()=>{
    if((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'k'){
      e.preventDefault();
      const t = await showPrompt('Quick add note title', '', 'Create', 'Cancel');
      if(t){
        const n = createNote({title: t});
        openNote(n.id);
      }
    }
    // Quick task shortcut (Ctrl/Meta + Shift + K)
    if((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'k'){
      e.preventDefault();
      const t = await showPrompt('Quick task (goes to today)', '', 'Add', 'Cancel');
      if(t){
        const key = todayKey();
        let daily = db.notes.find(n => n.type === 'daily' && n.dateIndex === key);
        if(!daily){
          daily = createNote({title: `${key} — Daily`, type: 'daily', dateIndex: key, content: db.settings.dailyTemplate || "# Top 3\n- [ ] \n- [ ] \n- [ ] \n\n## Tasks\n\n## Journal\n\n## Wins\n"});
        }
        const priority = t.startsWith('!') ? 'high' : 'medium';
        const title = t.startsWith('!') ? t.slice(1) : t;
        createTask({title, noteId: daily.id, priority});
        if(route !== 'today'){
          route = 'today';
          render();
        } else {
          // if already on Today, refresh the view to show new task
          render();
        }
      }
    }
  })();
});

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
    menuBtn.onclick = ()=>{ document.body.classList.toggle('drawer-open'); };
    menuBtn.dataset.bound='1';
  }
  // Close drawer when navigating (desktop or mobile)
  document.addEventListener('click', e=>{
    if(document.body.classList.contains('drawer-open')){
      if(e.target.matches('main, main *')){ document.body.classList.remove('drawer-open'); }
    }
  });
  // Await initialization to avoid race conditions on first user actions.
  await initApp();
  // Begin checking for due task notifications after the app has been
  // initialized. This ensures db is loaded and available.
  startDueTaskNotifications();
});

// ------------------------------------------------------------------
// Background sync: periodically fetch latest DB from server
// to reflect changes made from other devices or tabs. If the
// remote DB differs from the current in-memory state, we update
// our local DB, apply the theme, redraw sidebar and rerender the
// current route. This runs every 10 seconds.
setInterval(async () => {
  try {
    // If auto reload is disabled in settings, skip periodic sync entirely. This helps avoid
    // interference while the user is actively editing notes or experiencing glitches.
    if(db && db.settings && db.settings.autoReload === false) return;
    const remote = await fetchDB().catch(() => null);
    if (!remote) return;
    // Deep equality check via JSON string
    const localStr = JSON.stringify(db);
    const remoteStr = JSON.stringify(remote);
    if (localStr === remoteStr) return;
    // Always load the remote snapshot
    db = remote;
    // Ensure any missing collections are initialized
    ['notes','tasks','projects','templates','settings','links','monthly'].forEach(k => {
      if (!db[k]) db[k] = Array.isArray(seed[k]) ? [] : {};
    });
    // If a note is currently open, preserve its state on sync
    if (window._openNoteId) {
      // When the user has unsaved edits, merge them into the fresh DB snapshot before re‑rendering
      if (window._editorDirty) {
        const editingNote = db.notes.find(x => x.id === window._openNoteId);
        const titleEl = document.getElementById('title');
        const contentEl = document.getElementById('contentBox');
        if (editingNote) {
          if (titleEl) editingNote.title = titleEl.value;
          if (contentEl) editingNote.content = contentEl.value;
        }
      }
      // Reapply theme and sidebar updates
      applyTheme();
      drawProjectsSidebar();
      // Re‑open the same note so the editor remains visible
      openNote(window._openNoteId);
    } else if (window._isTypingInForm) {
      // User is actively typing in a form - skip re-rendering to avoid interruption
      // Still update the data but preserve the UI state
      applyTheme();
      drawProjectsSidebar();
    } else {
      // For all other routes, simply re‑render
      applyTheme();
      drawProjectsSidebar();
      render();
    }
  } catch (err) {
    console.warn('Periodic sync failed', err);
  }
}, 10000);