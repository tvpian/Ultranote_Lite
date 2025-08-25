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
    if(!r.ok) throw new Error('Fetch failed');
    const data = await r.json();
    if(!data || !Object.keys(data).length) return null;
    return data;
  }catch(e){ console.warn('Fetch DB error', e); return null; }
}
async function persistDB(){
  try{
    await fetch('/api/db', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(db)});
  }catch(e){ console.error('Persist failed', e); }
  // Always keep a browser backup too (legacy compatibility / offline resilience)
  try { localStorage.setItem(storeKey, JSON.stringify(db)); } catch(err) { /* ignore */ }
}

const seed = {
  version:1,
  settings:{rollover:true, seenTip:false, autoCarryTasks:true, dailyTemplate:"# Top 3\n- [ ] \n- [ ] \n- [ ] \n\n## Tasks\n\n## Journal\n\n## Wins\n"},
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

async function initApp(){
  // 1. Try server
  let serverData = await fetchDB();
  if(serverData && Object.keys(serverData).length){
    db = serverData;
  } else {
    // 2. Fallback to any localStorage copy
    try { db = JSON.parse(localStorage.getItem(storeKey)||'null'); } catch(_) { db = null; }
    if(!db) db = JSON.parse(JSON.stringify(defaults));
    await persistDB();
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
}
// --- End restored runtime glue ---

// Patch model functions to call save() without args
function createNote({title, content="", tags=[], projectId=null, dateIndex=null, type="note", pinned=false}){
  const n = { id:uid(), title, content, tags, projectId, dateIndex, type, pinned, createdAt:nowISO(), updatedAt:nowISO(), attachments: [] };
  db.notes.push(n); save(); return n;
}
function updateNote(id, patch){ const n=db.notes.find(x=>x.id===id); if(!n) return; Object.assign(n, patch, {updatedAt:nowISO()}); save(); return n; }
function createTask({title, due=null, noteId=null, projectId=null, priority="medium"}){
  const t = { id:uid(), title, status:"TODO", due, noteId, projectId, priority, createdAt:nowISO(), completedAt:null };
  db.tasks.push(t); save(); return t;
}
function setTaskStatus(id, status){ const t=db.tasks.find(x=>x.id===id); if(!t) return; t.status=status; t.completedAt = status==="DONE"? nowISO(): null; save(); }
// New helper to move a task to backlog
function moveToBacklog(id){ const t=db.tasks.find(x=>x.id===id); if(!t) return; t.status='BACKLOG'; save(); }
// Soft-delete a task by marking it archived. Tasks are not removed from DB to allow history viewing.
function deleteTask(id){
  const t = db.tasks.find(x => x.id === id);
  if(!t) return;
  t.deletedAt = nowISO();
  save();
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
  db.tasks = db.tasks.filter(x => x.id !== id);
  save();
}

function emptyTrash(){
  db.tasks = db.tasks.filter(t => !t.deletedAt);
  save();
}

// Helper to get active (non-deleted) tasks
function getActiveTasks(){
  return db.tasks.filter(t => !t.deletedAt);
}

function getTrashedTasks(){
  return db.tasks.filter(t => t.deletedAt);
}
function createProject(name){ const p={id:uid(), name, createdAt:nowISO()}; db.projects.push(p); save(); return p; }
function createTemplate(name, content){ const t={id:uid(), name, content, createdAt:nowISO()}; db.templates.push(t); save(); return t; }
function addTag(text){ const tags = extractTags(text); if(tags.length) { const uniqueTags = [...new Set([...getAllTags(), ...tags])]; } return tags; }
// Collect unique tags from notes and links (ideas/notes use tags on note; links have their own tags)
function getAllTags(){
  const noteTags = db.notes.flatMap(n => n.tags || []);
  const linkTags = db.links ? db.links.flatMap(l => l.tags || []) : [];
  return [...new Set([...noteTags, ...linkTags].filter(Boolean))];
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
  content.innerHTML = `
    <div class="card">
      <div class="muted" style="margin-bottom:6px;">Draft (not saved yet)</div>
      <input id="draftTitle" type="text" value="${htmlesc(title)}" placeholder="Title" />
      <div class="row" style="margin-top:8px;flex-wrap:wrap;gap:8px;">
        <input id="draftTags" type="text" placeholder="Tags (space separated)" />
        <label style="margin-left:8px;"><input id="draftPinned" type="checkbox"> Pin</label>
        <button id="draftAddSketch" class="btn" style="font-size:12px;">Add Sketch</button>
      </div>
      <div style="margin-top:8px;"><textarea id="draftContent" style="min-height:300px;">${htmlesc(contentTxt)}</textarea></div>
      <div class="row" style="margin-top:8px; gap:8px;flex-wrap:wrap;">
        <button id="draftSave" class="btn acc">Save</button>
        <button id="draftCancel" class="btn">Cancel</button>
      </div>
    </div>`;
  document.getElementById('draftSave').onclick = ()=>{
    const t = document.getElementById('draftTitle').value.trim() || 'Untitled';
    const tags = (document.getElementById('draftTags').value||'').split(/\s+/).map(x=>x.startsWith('#')?x.slice(1):x).filter(Boolean);
    const n = createNote({title:t, content:document.getElementById('draftContent').value, tags, projectId, type, pinned: document.getElementById('draftPinned').checked});
    openNote(n.id);
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
}

// --- Views ---
function renderToday(){
  const key = selectedDailyDate || todayKey();
  const daily = db.notes.find(n=>n.type==='daily' && n.dateIndex===key) || null;
  // Exclude archived tasks (deletedAt) when gathering project tasks pool
  const projectTasks = db.tasks.filter(t=> t.projectId && !t.noteId && t.status!=='BACKLOG' && !t.deletedAt).sort((a,b)=> { const priorities={high:3,medium:2,low:1}; return (priorities[b.priority]||2)-(priorities[a.priority]||2); });
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
          <input id="taskDueDate" type="date" title="mm/dd/yyyy" placeholder="mm/dd/yyyy" style="padding:8px;background:var(--btn-bg);border:1px solid var(--btn-border);color:var(--fg);border-radius:6px;" ${key!==todayKey()? 'disabled':''}/>
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
      const dueVal = dueInput && dueInput.value ? dueInput.value : null;
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
      const dueVal = dueInput && dueInput.value ? dueInput.value : null;
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
    list.innerHTML = tasks.map(t=> { const colors={high:'#ff6b6b',medium:'#4ea1ff',low:'#64748b'}; return `<div class='row' style='justify-content:space-between;'>
      <label class='row' style='gap:8px;'>
        <input type='checkbox' ${t.status==='DONE'? 'checked':''} data-id='${t.id}'/>
        <span class='${t.status==='DONE'?'muted':''}' style='border-left:3px solid ${colors[t.priority||'medium']};padding-left:8px;'>${htmlesc(t.title)}${t.due ? ` <span class='pill'>${new Date(t.due).toLocaleDateString()}</span>` : ''}</span>
      </label>
      <div class='row' style='gap:6px;'>
        ${t.status!=='DONE'?`<button class='btn' data-b='${t.id}' style='font-size:11px;'>Backlog</button>`:''}
        <button class='btn' data-del='${t.id}' title='Delete'>✕</button>
      </div>
    </div>`; }).join('');
    list.querySelectorAll("input[type=checkbox]").forEach(cb=> cb.onchange = ()=>{ setTaskStatus(cb.dataset.id, cb.checked? 'DONE':'TODO'); drawTasks(); drawBacklog(); });
    list.querySelectorAll('[data-del]').forEach(b=> b.onclick = ()=>{ deleteTask(b.dataset.del); drawTasks(); drawProjectTasks(); drawBacklog(); });
    list.querySelectorAll('[data-b]').forEach(b=> b.onclick = ()=>{ moveToBacklog(b.dataset.b); drawTasks(); drawBacklog(); });
  }
  function drawBacklog(){ const list = $("#backlogList"); if(!list || list.style.display==='none') return; const tasks = db.tasks.filter(t=> t.noteId===daily.id && t.status==='BACKLOG' && !t.deletedAt); list.innerHTML = tasks.length? tasks.map(t=> `<div class='row' style='justify-content:space-between;'>
      <span class='muted' style='font-size:12px;'>${htmlesc(t.title)}</span>
      <div class='row' style='gap:6px;'>
        <button class='btn' data-r='${t.id}' style='font-size:11px;'>Restore</button>
        <button class='btn' data-del='${t.id}' style='font-size:11px;'>✕</button>
      </div>
    </div>`).join('') : `<div class='muted' style='font-size:12px;'>No backlog tasks</div>`; list.querySelectorAll('[data-r]').forEach(b=> b.onclick = ()=>{ setTaskStatus(b.dataset.r,'TODO'); drawTasks(); drawBacklog(); }); list.querySelectorAll('[data-del]').forEach(b=> b.onclick = ()=>{ deleteTask(b.dataset.del); drawBacklog(); }); }
  function drawProjectTasks(){ const list = $("#projectTaskList"); if(!list) return; const tasks = projectTasks.slice(0,10); list.innerHTML = tasks.map(t=> { const proj=db.projects.find(p=>p.id===t.projectId); const colors={high:'#ff6b6b',medium:'#4ea1ff',low:'#64748b'}; return `<div class='row' style='justify-content:space-between;'>
      <label class='row' style='gap:8px;'>
        <input type='checkbox' ${t.status==='DONE'? 'checked':''} data-id='${t.id}'/>
        <span class='${t.status==='DONE'?'muted':''}' style='border-left:3px solid ${colors[t.priority||'medium']};padding-left:8px;'>${htmlesc(t.title)}${t.due ? ` <span class='pill'>${new Date(t.due).toLocaleDateString()}</span>` : ''} <span class='pill'>${proj?htmlesc(proj.name):'Unknown'}</span></span>
      </label>
      <div class='row' style='gap:6px;'>
        ${t.status!=='DONE'?`<button class='btn' data-b='${t.id}' style='font-size:11px;'>Backlog</button>`:''}
        <button class='btn' data-del='${t.id}'>✕</button>
      </div>
    </div>`; }).join(''); list.querySelectorAll("input[type=checkbox]").forEach(cb=> cb.onchange = ()=>{ setTaskStatus(cb.dataset.id, cb.checked? 'DONE':'TODO'); drawProjectTasks(); }); list.querySelectorAll('[data-del]').forEach(b=> b.onclick = ()=>{ deleteTask(b.dataset.del); drawProjectTasks(); }); list.querySelectorAll('[data-b]').forEach(b=> b.onclick = ()=>{ moveToBacklog(b.dataset.b); drawProjectTasks(); });
  }
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
          <input id="projTaskDueDate" type="date" style="padding:8px;background:var(--btn-bg);border:1px solid var(--btn-border);color:var(--fg);border-radius:6px;"/>
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
  function getProjectTasks(){ return db.tasks.filter(t=> t.projectId===currentProjectId && t.status!=='BACKLOG' && !t.deletedAt); }
  function getProjectBacklog(){ return db.tasks.filter(t=> t.projectId===currentProjectId && t.status==='BACKLOG' && !t.deletedAt); }
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
  function drawTasks(){ const tasks = getProjectTasks().sort((a,b)=>{ if(a.status !== b.status) return a.status==="DONE"?1:-1; const priorities={high:3,medium:2,low:1}; return (priorities[b.priority]||2)-(priorities[a.priority]||2); }); const list = document.getElementById("taskList"); list.innerHTML = tasks.map(t=>{ const colors={high:"#ff6b6b",medium:"#4ea1ff",low:"#64748b"}; return `<div class="row" style="justify-content:space-between;">
        <label class="row" style="gap:8px;">
          <input type="checkbox" ${t.status==="DONE"?"checked":''} data-id="${t.id}"/>
          <span class="${t.status==='DONE'?'muted':''}" style="border-left:3px solid ${colors[t.priority||'medium']};padding-left:8px;">${htmlesc(t.title)}${t.due ? ` <span class='pill'>${new Date(t.due).toLocaleDateString()}</span>` : ''}</span>
        </label>
        <div class='row' style='gap:6px;'>
          ${t.status!=='DONE'?`<button class='btn' data-b='${t.id}' style='font-size:11px;'>Backlog</button>`:''}
          <button class='btn' data-del='${t.id}'>✕</button>
        </div>
      </div>`; }).join(""); list.querySelectorAll("input[type=checkbox]").forEach(cb=> cb.onchange = ()=>{ setTaskStatus(cb.dataset.id, cb.checked?"DONE":"TODO"); drawTasks(); refreshStats(); drawBacklog(); }); list.querySelectorAll('[data-del]').forEach(b=> b.onclick = ()=>{ deleteTask(b.dataset.del); drawTasks(); refreshStats(); drawBacklog(); }); list.querySelectorAll('[data-b]').forEach(b=> b.onclick = ()=>{ moveToBacklog(b.dataset.b); drawTasks(); drawBacklog(); refreshStats(); }); }
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
    return `<div class='row' style='justify-content:space-between;'><span style='flex:1;'>${htmlesc(t.title)} ${ctx} <span class='pill'>${dateStr}</span></span></div>`;
  }).join('') : '<div class="muted">No completed tasks</div>';

  content.innerHTML = `
    <div class="grid-2">
      <div class="card">
        <strong>📊 Analytics</strong>
        <div class="muted" style="margin-top:6px;">Tasks completed: ${done.length}/${total||0} (${pct}%)</div>
        <div class="muted">This week: ${weekTasks.length} tasks, ${weekNotes.length} notes</div>
      </div>
      <div class="card">
        <strong>🎯 Project Progress</strong>
        <div class="list" style="margin-top:8px;">
          ${projectStats.map(s=>`<div class='row' style='justify-content:space-between;'><span>${htmlesc(s.project.name)}</span><span class='muted'>${s.completed}/${s.total} (${s.progress}%)</span></div>`).join('') || '<div class="muted">No project tasks yet</div>'}
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
          const dueStr = t.due ? new Date(t.due).toLocaleDateString() : '';
          const colors = { high: '#ff6b6b', medium: '#4ea1ff', low: '#64748b' };
          const col = colors[t.priority || 'medium'];
          return `<div class='row' style='justify-content:space-between;align-items:center;'>
            <span style='border-left:3px solid ${col};padding-left:6px;'>${htmlesc(t.title)} ${ctx} <span class='pill'>${dueStr}</span></span>
            <div class='row' style='gap:4px;'>
              ${note ? `<button class='btn' data-open-note='${note.id}' style='font-size:11px;'>Open</button>` : ''}
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
            ${note? `<button class='btn' data-open-note='${note.id}' style='font-size:11px;'>Open</button>`:''}
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
            ${note? `<button class='btn' data-open-note='${note.id}' style='font-size:11px;'>Open</button>`:''}
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
              <button class='btn' data-restore-task='${t.id}' style='font-size:11px;'>Restore</button>
              <button class='btn' data-hard-delete='${t.id}' style='font-size:11px;color:#ff6b6b;'>Delete Forever</button>
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
      <div style="margin-top:8px;">${getAllTags().slice(0,20).map(tag=>{
        const noteCount = db.notes.filter(n=> (n.tags||[]).includes(tag)).length;
        const linkCount = db.links ? db.links.filter(l=> (l.tags||[]).includes(tag)).length : 0;
        const count = noteCount + linkCount;
        return `<button class='pill' data-tag='${tag}' style='cursor:pointer;margin:2px;'>#${htmlesc(tag)} (${count})</button>`;
      }).join('') || '<div class="muted">No tags yet</div>'}</div>
    </div>`;
  content.querySelectorAll('[data-open]').forEach(b=> b.onclick=()=> openNote(b.dataset.open));
  content.querySelectorAll('[data-open-note]').forEach(b=> b.onclick=()=> openNote(b.dataset.openNote));
  content.querySelectorAll('[data-done]').forEach(b=> b.onclick=()=>{ setTaskStatus(b.dataset.done,'DONE'); renderReview(); });
  content.querySelectorAll('[data-restore]').forEach(b=> b.onclick=()=>{ setTaskStatus(b.dataset.restore,'TODO'); renderReview(); });
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
      // Show image preview for image types, else show file name
      const isImg = att.type && att.type.startsWith('image');
      const preview = isImg ? `<img src="${att.data}" alt="${htmlesc(att.name)}" style="max-width:100%;max-height:150px;border:1px solid #203041;border-radius:8px;" />` : `<span class='pill' style='margin-right:6px;'>${htmlesc(att.name)}</span>`;
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
document.addEventListener('DOMContentLoaded', ()=>{
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
  initApp();
});

// ------------------------------------------------------------------
// Background sync: periodically fetch latest DB from server
// to reflect changes made from other devices or tabs. If the
// remote DB differs from the current in-memory state, we update
// our local DB, apply the theme, redraw sidebar and rerender the
// current route. This runs every 10 seconds.
setInterval(async () => {
  try {
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