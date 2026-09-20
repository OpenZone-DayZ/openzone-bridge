// The admin side of the server itself (the kind `core` of the admin site):
// the servers the bridge has heard from and the classes each dumped at its
// last start. Read-only: nothing here reaches the game.

export function coreAdmin({ store, servers, profileDir = '' }) {
  // The server whose dump to answer: the named one, else the last to have
  // dumped. What the poll handler stored: a summary (count, when the game
  // wrote the dump) beside the index itself.
  function pickServer(server) {
    const sid = String(server || '');
    const rows = store.metaList('classes:');
    const row = sid ? rows.find((r) => r.key === `classes:${sid}`) : rows[0];
    if (!row) return null;
    let summary = { count: 0, at: '' };
    try {
      summary = JSON.parse(row.value);
    } catch {
      // an unreadable summary counts as none
    }
    return { server: row.key.slice('classes:'.length), summary };
  }

  return {
    servers: () => ({ ok: true, servers: servers ? servers() : [] }),

    // The classes of the chosen server as the core dumped them at its
    // start: the count and when here, the index whole from `classindex` --
    // the shape the site's classIndex.ts parses, with the parents and the
    // names in both languages the server read out of its stringtables.
    classes: ({ server } = {}) => {
      const found = pickServer(server);
      if (!found) return { ok: true, server: '', count: 0, at: '' };
      return { ok: true, server: found.server, ...found.summary };
    },

    classindex: ({ server } = {}) => {
      const found = pickServer(server);
      if (!found) return { ok: true, server: '', index: null, at: '' };
      const row = store.metaGet(`classindex:${found.server}`);
      if (!row) return { ok: true, server: found.server, index: null, at: '' };
      try {
        return { ok: true, server: found.server, index: JSON.parse(row.value), at: found.summary.at };
      } catch {
        return { ok: true, server: found.server, index: null, at: '' };
      }
    },

    status: () => ({ ok: true, profileDir, servers: servers ? servers() : [] }),
  };
}
