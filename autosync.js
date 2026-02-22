// autosync.js
// Drop-in auto-sync loop that polls the server and merges inbound changes safely.
// Requires that app.js defines: db, fetchDB(), render() (or a lightweight redraw), and the "Auto-sync updates" checkbox exists in the header.

(function(){
  function _isNewer(a,b){
    const ta = Date.parse(a?.updatedAt || a?.createdAt || 0);
    const tb = Date.parse(b?.updatedAt || b?.createdAt || 0);
    return tb > ta;
  }
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
        // Pick the item that was modified more recently as the base, then force deletedAt so
        // a deletion from either side always wins. _isNewer(l,r) returns true when remote (r)
        // is newer, so we take r in that case.
        const newer = _isNewer(l,r) ? r : l;
        out.set(r.id,{...newer, deletedAt: l.deletedAt || r.deletedAt || new Date().toISOString()});
        return;
      }
      out.set(r.id, _isNewer(l,r) ? {...l, ...r} : {...r, ...l});
    });
    return Array.from(out.values());
  }
  function _mergeInbound(remote){
    if(!remote || typeof remote!=='object' || !window.db){
      console.log('⚠️ Auto-sync: Invalid remote data or no local db');
      return;
    }
    const ARR = ['notes','tasks','projects','templates','links','monthly','notebooks'];
    let changed=false;
    ARR.forEach(k=>{
      const localA = Array.isArray(db[k])? db[k]:[];
      const remoteA = Array.isArray(remote[k])? remote[k]:[];
      const merged = _mergeArrayById(localA, remoteA);
      if(JSON.stringify(merged)!==JSON.stringify(localA)) changed=true;
      db[k]=merged;
    });
    const prevAuto = db.settings && Object.prototype.hasOwnProperty.call(db.settings,'autoReload') ? db.settings.autoReload : undefined;
    db.settings = { ...(remote.settings||{}), ...(db.settings||{}) };
    if(prevAuto !== undefined) {
      db.settings.autoReload = prevAuto; // force preserve local preference
    }
    Object.keys(remote).forEach(k=>{ if(!(k in db)) db[k]=remote[k]; });
    if(!changed) console.log('✅ Auto-sync: No changes to merge');
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
      _mergeInbound(remote);
      if(typeof render==='function'){ render(); console.log('🔄 Auto-sync: UI refreshed'); }
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
