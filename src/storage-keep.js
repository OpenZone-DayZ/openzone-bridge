// Retention (design 2026-09-19, section 4.3): versions older than the
// window go, except every box's current one; blobs nobody references go
// with them; events older than their window go. Parked roots never go on
// their own.

export function runKeep(store, cfg, now = new Date()) {
  const r = store.keep({
    versionsDays: cfg.storageKeepVersionsDays,
    eventsDays: cfg.storageKeepEventsDays,
    now,
  });
  if (r.versions || r.blobs || r.events) {
    console.log(`[storage] keep: ${r.versions} version(s), ${r.blobs} blob(s), ${r.events} event(s) removed`);
  }
  return r;
}
