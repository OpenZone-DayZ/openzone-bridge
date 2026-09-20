// What the bridge keeps about a game server as such -- the core's facts,
// not a mod's: which kinds it booted since its last start, the class
// index out of its dump. One key/value table, so a kind that comes later
// finds its server already described.

import { stampNow } from './storage-wire.js';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS core_meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     at    TEXT NOT NULL
   )`,
];

export class CoreStore {
  constructor(base) {
    this.db = base.db;
    for (const sql of SCHEMA) this.db.exec(sql);
    const q = (sql) => this.db.prepare(sql);
    this.q = {
      metaGet: q('SELECT value, at FROM core_meta WHERE key = ?'),
      metaSet: q('INSERT INTO core_meta(key, value, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at'),
      metaList: q("SELECT key, value, at FROM core_meta WHERE key LIKE ? ESCAPE '\\' ORDER BY at DESC, key"),
    };
  }

  metaGet(key) {
    return this.q.metaGet.get(key) || null;
  }

  // Every row whose key starts with `prefix`, newest first.
  metaList(prefix) {
    return this.q.metaList.all(`${String(prefix).replace(/[\\%_]/g, '\\$&')}%`);
  }

  metaSet(key, value, at = stampNow()) {
    this.q.metaSet.run(key, String(value), at);
  }
}
