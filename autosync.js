// autosync.js
// Drop-in auto-sync loop that polls the server and merges inbound changes safely.
// Requires that app.js defines: db, fetchDB(), render() (or a lightweight redraw), and the "Auto-sync updates" checkbox exists in the header.

(function(){
  function _isNewer(a,b){
    const ta = Date.parse(a?.updatedAt || a?.createdAt || 0);
    const tb = Date.parse(b?.updatedAt || b?.createdAt || 0);
    return tb > ta;
  }
  function _contentLen(r){ return ((r.content||'')+(r.journal||'')+(r.description||'')).length; }
  function _mergeArrayById(localArr=[], remoteArr=[]){
    // Never re-add items that were hard-deleted this session
    const hardDeleted = (typeof window !== 'undefined' && window._hardDeletedIds) ? window._hardDeletedIds : new Set();
    const out = new Map();
    localArr.forEach(i=>{ if(!hardDeleted.has(i.id)) out.set(i.id, {...i}); });
    remoteArr.forEach(r=>{
      if(hardDeleted.has(r.id)) return; // block resurrection
      const l = out.get(r.id);
      if(!l){ out.set(r.id,{...r}); return; }
      if(l.deletedAt || r.deletedAt){
        const newer = _isNewer(l,r) ? r : l;
        out.set(r.id,{...newer, deletedAt: l.deletedAt || r.deletedAt || new Date().toISOString()});
        return;
      }
      // Prefer the version with more content when the other is template-only,
      // regardless of timestamp — prevents auto-created stubs from overwriting real data.
      const rl = _contentLen(r), ll = _contentLen(l);
      if (rl > 100 && ll < rl && ll < 100) { out.set(r.id, {...l, ...r}); return; }
      if (ll > 100 && rl < ll && rl < 100) { /* keep local */ return; }
      out.set(r.id, _isNewer(l,r) ? {...l, ...r} : {...r, ...l});
    });
    return Array.from(out.values());
  }
  function _mergeInbound(remote){
    if(!remote || typeof remote!=='object' || !window.db){
      console.log('⚠️ Auto-sync: Invalid remote data or no local db');
      return false;
    }
    const ARR = ['notes','tasks','projects','templates','links','monthly','notebooks','activity'];
    let changed=false;
    ARR.forEach(k=>{
      const localA = Array.isArray(db[k])? db[k]:[];
      const remoteA = Array.isArray(remote[k])? remote[k]:[];
      const merged = _mergeArrayById(localA, remoteA);
      if(JSON.stringify(merged)!==JSON.stringify(localA)) changed=true;
      // Update in-place to keep open-closure references (e.g. openNote's `n`) alive.
      // If we replace the array wholesale, the captured `n` detaches and further
      // attachment pushes / saves operate on an orphaned object.
      if (!Array.isArray(db[k])) { db[k] = merged; return; }
      // Remove items that don't appear in merged (hard-deleted remotely)
      const mergedIds = new Set(merged.map(x=>x.id));
      for (let i = db[k].length - 1; i >= 0; i--) {
        if (!mergedIds.has(db[k][i].id)) db[k].splice(i, 1);
      }
      // Update existing + add new
      merged.forEach(m => {
        const idx = db[k].findIndex(x => x.id === m.id);
        if (idx >= 0) { Object.assign(db[k][idx], m); }
        else { db[k].push(m); }
      });
    });
    const prevAuto = db.settings && Object.prototype.hasOwnProperty.call(db.settings,'autoReload') ? db.settings.autoReload : undefined;
    db.settings = { ...(remote.settings||{}), ...(db.settings||{}) };
    if(prevAuto !== undefined) {
      db.settings.autoReload = prevAuto; // force preserve local preference
    }
    Object.keys(remote).forEach(k=>{ if(!(k in db)) db[k]=remote[k]; });
    if(!changed) console.log('✅ Auto-sync: No changes to merge');
    return changed;
  }
  async function _runOnce(opts={}){
    const { bypassTyping=false } = opts;
    try{
      console.log('🔄 Auto-sync: Checking for remote changes...');
      const remote = await (typeof fetchDB==='function'? fetchDB(): null);
      if(!remote){ console.log('📭 Auto-sync: No remote data received'); return; }
      if(!bypassTyping){
        const active = document.activeElement;
        const typing = (window.__typingUntil && Date.now() < window.__typingUntil) || (active && (active.tagName==='TEXTAREA' || (active.tagName==='INPUT' && /text|search|date|number|email|url|password/.test(active.type)) || active.isContentEditable)) || window._isTypingInForm;
        if(typing){
          console.log('⏳ Auto-sync: Deferred (user typing)');
          return;
        }
      }
      console.log('📥 Auto-sync: Merging remote changes...');
      const hadChanges = _mergeInbound(remote);
      if(hadChanges){
        if(typeof save==='function'){
          setTimeout(()=>save(), 500);
          console.log('⬆️ Auto-sync: Uploading merged local state to server');
        }
        // If a note is currently open, only refresh the attachments list — do NOT call
        // render() because that would overwrite the note editor with the route view.
        if(window._openNoteId && typeof window._renderAttachments === 'function'){
          window._renderAttachments();
          console.log('🔄 Auto-sync: Refreshed open note attachments');
        } else if(typeof render==='function'){
          render();
          console.log('🔄 Auto-sync: UI refreshed');
        }
      }
    }catch(e){ console.warn('❌ Auto-sync fetch failed', e); }
  }
  function startAutoSync(){
    const toggleOn = () => {
      const el = document.getElementById('autoReload');
      if(!el) return false; // default OFF for stability
      return !!el.checked;
    };
    let timer=null;
    const tick = async ()=>{ if(!toggleOn()) return; await _runOnce(); };
    setTimeout(tick, 2000); // initial delayed tick
    clearInterval(timer);
    timer = setInterval(tick, 10000); // slower interval
    const syncBtn = document.getElementById('syncNowBtn');
    if(syncBtn && !syncBtn.dataset.boundByAutoSync){
      syncBtn.dataset.boundByAutoSync='1';
      syncBtn.addEventListener('click', ()=> manualSync());
    }
    document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) tick(); });
  }
  async function manualSync(){
    console.log('⚡ Manual sync invoked');
    await _runOnce({ bypassTyping:true });
  }
  if(typeof window!=='undefined'){
    window.startAutoSync = startAutoSync;
    window.manualSync = manualSync;
  }
})();
