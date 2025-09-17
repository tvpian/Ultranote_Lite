// autosync.js
// Drop-in auto-sync loop that polls the server and merges inbound changes safely.
// Requires that app.js defines: db, fetchDB(), render() (or a lightweight redraw), and the "Auto-sync updates" checkbox exists in the header.

(function () {
  // Prefer newer updatedAt; fallback to createdAt
  function _isNewer(a, b) {
    const ta = Date.parse(a?.updatedAt || a?.createdAt || 0);
    const tb = Date.parse(b?.updatedAt || b?.createdAt || 0);
    return tb > ta;
  }

  function _mergeArrayById(localArr = [], remoteArr = []) {
    const out = new Map();
    localArr.forEach(item => out.set(item.id, { ...item }));
    remoteArr.forEach(r => {
      const l = out.get(r.id);
      if (!l) { out.set(r.id, { ...r }); return; }
      // If either marks deleted, keep deletion and prefer the newer timestamp
      if (l.deletedAt || r.deletedAt) {
        const newer = _isNewer(l, r) ? l : r;
        out.set(r.id, { ...newer, deletedAt: l.deletedAt || r.deletedAt || new Date().toISOString() });
        return;
      }
      // Otherwise prefer the newer record, shallow-merged to avoid dropping fields
      out.set(r.id, _isNewer(l, r) ? { ...l, ...r } : { ...r, ...l });
    });
    return Array.from(out.values());
  }

  function _mergeInbound(remote) {
    if (!remote || typeof remote !== 'object' || !window.db) {
      console.log('⚠️ Auto-sync: Invalid remote data or no local db');
      return;
    }

    // Array collections we maintain
    const ARR = ['notes', 'tasks', 'projects', 'templates', 'links', 'monthly'];
    let hasChanges = false;
    ARR.forEach(k => {
      const localA = Array.isArray(db[k]) ? db[k] : [];
      const remoteA = Array.isArray(remote[k]) ? remote[k] : [];
      const merged = _mergeArrayById(localA, remoteA);
      if (JSON.stringify(merged) !== JSON.stringify(localA)) {
        console.log(`📝 Auto-sync: Changes detected in ${k}`);
        hasChanges = true;
      }
      db[k] = merged;
    });
    
    if (!hasChanges) {
      console.log('✅ Auto-sync: No changes to merge');
    }

    // Shallow-merge settings (server first, then local to preserve local toggles)
    db.settings = { ...(remote.settings || {}), ...(db.settings || {}) };

    // Bring over any unknown top-level keys that local doesn’t have
    Object.keys(remote).forEach(k => {
      if (!(k in db)) db[k] = remote[k];
    });
  }

  async function _runOnce() {
    try {
      console.log('🔄 Auto-sync: Checking for remote changes...');
      const remote = await (typeof fetchDB === 'function' ? fetchDB() : null);
      if (!remote) {
        console.log('📭 Auto-sync: No remote data received');
        return;
      }
      // Skip if the user is actively typing (typing guard set in initApp)
      if (window.__typingUntil && Date.now() < window.__typingUntil) {
        console.log('⏳ Auto-sync: Deferred (user typing)');
        return;
      }
      console.log('📥 Auto-sync: Merging remote changes...');
      _mergeInbound(remote);
      if (typeof render === 'function') {
        render();
        console.log('🔄 Auto-sync: UI refreshed');
      }
    } catch (e) {
      console.warn('❌ Auto-sync fetch failed', e);
    }
  }

  // Public starter: call after your app has initialized db/render
  function startAutoSync() {
    // If the checkbox isn't present, we treat it as ON by default.
    const toggleOn = () => {
      const el = document.getElementById('autoReload');
        if (!el) return false; // default OFF now unless user enables
      return !!el.checked;
    };

    let timer = null;

    const tick = async () => {
      if (!toggleOn()) return;
      await _runOnce();
    };

  // Kick once after a short delay so initial render is settled
    setTimeout(tick, 2000);
    clearInterval(timer);
    timer = setInterval(tick, 10000); // slower to prioritize usability

      // Manual sync button
      const syncBtn = document.getElementById('syncNowBtn');
      if (syncBtn) {
        syncBtn.onclick = () => {
          console.log('🧭 Manual sync triggered');
          _runOnce();
        };
      }

    // Also sync when tab becomes visible again
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) tick();
    });
  }

  // Expose to window so you can call it from initApp in app.js
  if (typeof window !== 'undefined') {
    window.startAutoSync = startAutoSync;
  }
})();
