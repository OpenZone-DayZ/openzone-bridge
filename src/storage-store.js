// The storage tables (design 2026-09-19, section 4): where a CLOSED box
// lives. A version is a list of root chunks kept byte for byte, deduplicated
// by hash; the item rows of the CURRENT version answer the queries; any past
// composition is read back out of its chunks. On the bridge's own database,
// beside the chat tables, but in its own module: nothing here is chat.

import { createHash } from 'node:crypto';
import { parseChunk, stampNow, typesOf, unplace } from './storage-wire.js';

const DDL = [
  `CREATE TABLE IF NOT EXISTS storage_boxes (
     box_id          TEXT PRIMARY KEY,
     class           TEXT NOT NULL DEFAULT '',
     pos             TEXT NOT NULL DEFAULT '',
     placed_at       TEXT NOT NULL DEFAULT '',
     placed_by       TEXT NOT NULL DEFAULT '',
     removed_at      TEXT NOT NULL DEFAULT '',
     status          TEXT NOT NULL DEFAULT 'closed',
     current_version INTEGER NOT NULL DEFAULT 0,
     last_seen_at    TEXT NOT NULL DEFAULT '',
     cache_stamp     TEXT NOT NULL DEFAULT '',
     cache_size      INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS storage_versions (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     box_id       TEXT NOT NULL,
     stamp        TEXT NOT NULL,
     created_at   TEXT NOT NULL,
     source       TEXT NOT NULL,
     save_version INTEGER NOT NULL DEFAULT 0,
     roots        INTEGER NOT NULL DEFAULT 0,
     entities     INTEGER NOT NULL DEFAULT 0,
     note         TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE INDEX IF NOT EXISTS storage_versions_box ON storage_versions(box_id, id)`,
  `CREATE TABLE IF NOT EXISTS storage_roots (
     version_id INTEGER NOT NULL,
     idx        INTEGER NOT NULL,
     hash       TEXT NOT NULL,
     PRIMARY KEY (version_id, idx)
   )`,
  `CREATE INDEX IF NOT EXISTS storage_roots_hash ON storage_roots(hash)`,
  `CREATE TABLE IF NOT EXISTS storage_blobs (
     hash  TEXT PRIMARY KEY,
     bytes BLOB NOT NULL,
     size  INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS storage_items (
     box_id   TEXT NOT NULL,
     root_idx INTEGER NOT NULL,
     node_idx INTEGER NOT NULL,
     parent   INTEGER NOT NULL,
     type     TEXT NOT NULL,
     loc_type INTEGER NOT NULL,
     slot     INTEGER NOT NULL,
     row      INTEGER NOT NULL,
     col      INTEGER NOT NULL,
     flip     INTEGER NOT NULL,
     health   REAL NOT NULL,
     quantity REAL NOT NULL,
     liquid   INTEGER NOT NULL,
     ammo     INTEGER NOT NULL,
     has_blob INTEGER NOT NULL,
     PRIMARY KEY (box_id, root_idx, node_idx)
   )`,
  `CREATE INDEX IF NOT EXISTS storage_items_type ON storage_items(type)`,
  `CREATE TABLE IF NOT EXISTS storage_parked (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     box_id       TEXT NOT NULL,
     parked_at    TEXT NOT NULL,
     reason       TEXT NOT NULL,
     type         TEXT NOT NULL,
     types        TEXT NOT NULL,
     hash         TEXT NOT NULL,
     from_version INTEGER NOT NULL,
     restored_at  TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE TABLE IF NOT EXISTS storage_events (
     id        INTEGER PRIMARY KEY AUTOINCREMENT,
     at        TEXT NOT NULL,
     kind      TEXT NOT NULL,
     box_id    TEXT NOT NULL DEFAULT '',
     uid       TEXT NOT NULL DEFAULT '',
     name      TEXT NOT NULL DEFAULT '',
     type      TEXT NOT NULL DEFAULT '',
     qty       REAL NOT NULL DEFAULT 0,
     row       INTEGER NOT NULL DEFAULT -1,
     col       INTEGER NOT NULL DEFAULT -1,
     slot      TEXT NOT NULL DEFAULT '',
     note      TEXT NOT NULL DEFAULT '',
     server_id TEXT NOT NULL DEFAULT '',
     admin     TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE INDEX IF NOT EXISTS storage_events_box ON storage_events(box_id, id)`,
  `CREATE INDEX IF NOT EXISTS storage_events_uid ON storage_events(uid, id)`,
];

const hashOf = (bytes) => createHash('sha256').update(bytes).digest('hex');
const asBuffer = (b) => (Buffer.isBuffer(b) ? b : Buffer.from(b));

export class StorageStore {
  constructor(store) {
    this.db = store.db;
    for (const ddl of DDL) this.db.exec(ddl);
    const q = (sql) => this.db.prepare(sql);
    this.q = {
      boxGet: q('SELECT * FROM storage_boxes WHERE box_id = ?'),
      boxSeen: q(`INSERT INTO storage_boxes(box_id, class, pos, placed_at, placed_by, last_seen_at)
                  VALUES (?, ?, ?, ?, ?, ?)
                  ON CONFLICT(box_id) DO UPDATE SET
                    class = CASE WHEN excluded.class = '' THEN class ELSE excluded.class END,
                    pos = CASE WHEN excluded.pos = '' THEN pos ELSE excluded.pos END,
                    placed_at = CASE WHEN placed_at = '' THEN excluded.placed_at ELSE placed_at END,
                    placed_by = CASE WHEN placed_by = '' THEN excluded.placed_by ELSE placed_by END,
                    last_seen_at = excluded.last_seen_at`),
      boxStatus: q('UPDATE storage_boxes SET status = ? WHERE box_id = ?'),
      boxCurrent: q(`UPDATE storage_boxes SET current_version = ?, status = 'closed', cache_stamp = '', cache_size = 0
                     WHERE box_id = ?`),
      boxCache: q('UPDATE storage_boxes SET cache_stamp = ?, cache_size = ? WHERE box_id = ?'),
      boxRemoved: q(`UPDATE storage_boxes SET status = 'removed', removed_at = ? WHERE box_id = ?`),
      boxIds: q(`SELECT box_id FROM storage_boxes WHERE status != 'removed' ORDER BY box_id`),
      boxesLive: q(`SELECT box_id, status, current_version FROM storage_boxes
                    WHERE status != 'removed' AND current_version > 0 ORDER BY box_id`),

      verIns: q(`INSERT INTO storage_versions(box_id, stamp, created_at, source, save_version, roots, entities, note)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
      verGet: q('SELECT * FROM storage_versions WHERE id = ?'),
      verOf: q('SELECT * FROM storage_versions WHERE box_id = ? ORDER BY id DESC LIMIT ?'),
      verOld: q(`SELECT v.id FROM storage_versions v JOIN storage_boxes b ON b.box_id = v.box_id
                 WHERE v.created_at < ? AND v.id != b.current_version`),
      verDel: q('DELETE FROM storage_versions WHERE id = ?'),

      rootIns: q('INSERT INTO storage_roots(version_id, idx, hash) VALUES (?, ?, ?)'),
      rootsOf: q(`SELECT r.idx, b.bytes FROM storage_roots r JOIN storage_blobs b ON b.hash = r.hash
                  WHERE r.version_id = ? ORDER BY r.idx`),
      rootsDel: q('DELETE FROM storage_roots WHERE version_id = ?'),
      blobIns: q('INSERT OR IGNORE INTO storage_blobs(hash, bytes, size) VALUES (?, ?, ?)'),
      blobGet: q('SELECT bytes FROM storage_blobs WHERE hash = ?'),
      blobGc: q(`DELETE FROM storage_blobs
                 WHERE NOT EXISTS (SELECT 1 FROM storage_roots r WHERE r.hash = storage_blobs.hash)
                   AND NOT EXISTS (SELECT 1 FROM storage_parked p WHERE p.hash = storage_blobs.hash)`),

      itemsDel: q('DELETE FROM storage_items WHERE box_id = ?'),
      itemIns: q(`INSERT INTO storage_items(box_id, root_idx, node_idx, parent, type, loc_type, slot, row, col, flip,
                                            health, quantity, liquid, ammo, has_blob)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      itemsOf: q('SELECT * FROM storage_items WHERE box_id = ? ORDER BY root_idx, node_idx'),
      itemsByType: q(`SELECT i.*, b.status, b.class AS box_class, b.pos FROM storage_items i
                      JOIN storage_boxes b ON b.box_id = i.box_id
                      WHERE i.type = ? ORDER BY i.box_id, i.root_idx, i.node_idx`),
      classesLive: q('SELECT DISTINCT type FROM storage_items ORDER BY type'),

      parkIns: q(`INSERT INTO storage_parked(box_id, parked_at, reason, type, types, hash, from_version)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`),
      parkOpen: q(`SELECT * FROM storage_parked WHERE restored_at = '' ORDER BY id`),
      parkGet: q('SELECT * FROM storage_parked WHERE id = ?'),
      parkDone: q('UPDATE storage_parked SET restored_at = ? WHERE id = ?'),
      parkDel: q('DELETE FROM storage_parked WHERE id = ?'),

      evIns: q(`INSERT INTO storage_events(at, kind, box_id, uid, name, type, qty, row, col, slot, note, server_id, admin)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      evOfBox: q('SELECT * FROM storage_events WHERE box_id = ? ORDER BY id DESC LIMIT ?'),
      evOfUid: q('SELECT * FROM storage_events WHERE uid = ? ORDER BY id DESC LIMIT ?'),
      evOld: q('DELETE FROM storage_events WHERE at < ?'),
    };
  }

  // ---- plumbing ----

  #tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  #reindex(boxId, parsed) {
    this.q.itemsDel.run(boxId);
    parsed.forEach((p, rootIdx) => {
      p.nodes.forEach((n, nodeIdx) => {
        this.q.itemIns.run(boxId, rootIdx, nodeIdx, n.parent, n.type, n.locType, n.slot, n.row, n.col, n.flip,
          n.health, n.quantity, n.liquid, n.ammo, n.hasBlob ? 1 : 0);
      });
    });
  }

  // A new current version of a box out of the chunks given. Inside a
  // transaction of the caller's or its own.
  #newVersion(boxId, chunks, { stamp = stampNow(), at = stampNow(), source, saveVer = 0, note = '' }) {
    const parsed = chunks.map((c) => parseChunk(c));
    let entities = 0;
    for (const p of parsed) entities += p.nodes.length;
    const version = Number(this.q.verIns.run(boxId, stamp, at, source, saveVer | 0, chunks.length, entities, note).lastInsertRowid);
    chunks.forEach((c, i) => {
      const h = hashOf(c);
      this.q.blobIns.run(h, c, c.length);
      this.q.rootIns.run(version, i, h);
    });
    this.#reindex(boxId, parsed);
    this.q.boxCurrent.run(version, boxId);
    return { version, roots: chunks.length, entities };
  }

  // ---- boxes ----

  seen(boxId, { class: cls = '', pos = '', at = stampNow(), by = '' } = {}) {
    this.q.boxSeen.run(boxId, cls, pos, at, by, at);
  }

  boxOf(boxId) {
    return this.q.boxGet.get(boxId) || null;
  }

  knownIds() {
    return this.q.boxIds.all().map((r) => r.box_id);
  }

  removed(boxId, at = stampNow()) {
    this.q.boxRemoved.run(at, boxId);
  }

  markOpen(boxId, at = stampNow()) {
    const box = this.boxOf(boxId);
    if (!box || box.status === 'removed') return false;
    this.q.boxStatus.run('open', boxId);
    this.q.boxSeen.run(boxId, '', '', '', '', at);
    return true;
  }

  markClosed(boxId) {
    const box = this.boxOf(boxId);
    if (!box || box.status === 'removed') return false;
    this.q.boxStatus.run('closed', boxId);
    return true;
  }

  cacheNote(boxId, stamp, size) {
    this.q.boxCache.run(stamp, size | 0, boxId);
  }

  // The boot exchange (design section 3.3): every box the engine has, with
  // what SQL knows about each, and every class that SQL holds anywhere.
  boot(boxes, at = stampNow()) {
    const out = [];
    for (const b of boxes) {
      this.seen(b.id, { class: b.class || '', pos: b.pos || '', at });
      const row = this.boxOf(b.id);
      if (!row || row.current_version === 0 || row.status === 'removed') {
        out.push({ id: b.id, status: 'none', version: 0, roots: 0 });
        continue;
      }
      const v = this.q.verGet.get(row.current_version);
      out.push({ id: b.id, status: row.status, version: row.current_version, roots: v ? v.roots : 0 });
    }
    return { boxes: out, classes: this.classes() };
  }

  classes() {
    const set = new Set(this.q.classesLive.all().map((r) => r.type));
    for (const p of this.q.parkOpen.all()) {
      let types = [];
      try { types = JSON.parse(p.types); } catch { types = [p.type]; }
      for (const t of types) set.add(t);
    }
    return [...set].sort();
  }

  // ---- versions ----

  ingestClose({ boxId, header, chunks, by = '', why = 'player', at = stampNow() }) {
    return this.#tx(() => {
      this.seen(boxId, { class: header.boxClass || '', at });
      return this.#newVersion(boxId, chunks.map(asBuffer), {
        stamp: header.stamp || at,
        at,
        source: why === 'boot' ? 'boot' : 'close',
        saveVer: header.saveVer,
        note: by,
      });
    });
  }

  currentChunks(boxId) {
    const box = this.boxOf(boxId);
    if (!box || box.current_version === 0) return null;
    const v = this.q.verGet.get(box.current_version);
    if (!v) return null;
    const chunks = this.q.rootsOf.all(v.id).map((r) => asBuffer(r.bytes));
    return {
      version: v.id, stamp: v.stamp, saveVer: v.save_version, boxClass: box.class,
      roots: v.roots, entities: v.entities, chunks,
    };
  }

  versionsOf(boxId, limit = 50) {
    return this.q.verOf.all(boxId, limit);
  }

  itemsOf(boxId) {
    return this.q.itemsOf.all(boxId);
  }

  itemsOfVersion(versionId) {
    return this.q.rootsOf.all(versionId).map((r) => ({ rootIdx: r.idx, nodes: parseChunk(asBuffer(r.bytes)).nodes }));
  }

  find(type) {
    return this.q.itemsByType.all(type);
  }

  // ---- parking (design sections 3.2, 3.3) ----

  parked(boxId = '') {
    const rows = this.q.parkOpen.all();
    return boxId ? rows.filter((r) => r.box_id === boxId) : rows;
  }

  park({ boxId, rootIdx, reason, at = stampNow(), note = '' }) {
    const cur = this.currentChunks(boxId);
    if (!cur || rootIdx < 0 || rootIdx >= cur.chunks.length) return null;
    return this.#tx(() => {
      const chunk = cur.chunks[rootIdx];
      const nodes = parseChunk(chunk).nodes;
      const keep = cur.chunks.filter((_, i) => i !== rootIdx);
      const { version } = this.#newVersion(boxId, keep, { at, source: 'park', saveVer: cur.saveVer, note });
      const parked = Number(this.q.parkIns.run(boxId, at, reason, nodes[0].type, JSON.stringify(typesOf(nodes)), hashOf(chunk), cur.version).lastInsertRowid);
      return { version, parked, type: nodes[0].type };
    });
  }

  parkMissing(missing, at = stampNow()) {
    const gone = new Set(missing);
    const boxes = [];
    let parked = 0;
    if (!gone.size) return { parked, boxes };
    for (const b of this.q.boxesLive.all()) {
      const cur = this.currentChunks(b.box_id);
      if (!cur) continue;
      const keep = [];
      const out = [];
      for (const c of cur.chunks) {
        const nodes = parseChunk(c).nodes;
        const types = typesOf(nodes);
        (types.some((t) => gone.has(t)) ? out : keep).push({ c, nodes, types });
      }
      if (!out.length) continue;
      this.#tx(() => {
        this.#newVersion(b.box_id, keep.map((k) => k.c), { at, source: 'park', saveVer: cur.saveVer, note: 'missing class' });
        for (const o of out) {
          this.q.parkIns.run(b.box_id, at, 'missing_class', o.nodes[0].type, JSON.stringify(o.types), hashOf(o.c), cur.version);
        }
      });
      parked += out.length;
      boxes.push(b.box_id);
    }
    return { parked, boxes };
  }

  unparkPresent(present, at = stampNow()) {
    const have = new Set(present);
    const boxes = new Set();
    let unparked = 0;
    for (const p of this.q.parkOpen.all()) {
      let types = [];
      try { types = JSON.parse(p.types); } catch { types = [p.type]; }
      if (!types.every((t) => have.has(t))) continue;
      const box = this.boxOf(p.box_id);
      if (!box || box.status !== 'closed') continue;
      const blob = this.q.blobGet.get(p.hash);
      if (!blob) continue;
      const cur = this.currentChunks(p.box_id);
      const chunks = cur ? cur.chunks : [];
      this.#tx(() => {
        this.#newVersion(p.box_id, [...chunks, unplace(asBuffer(blob.bytes))], {
          at, source: 'unpark', saveVer: cur ? cur.saveVer : 0, note: `parked ${p.id} (${p.type})`,
        });
        this.q.parkDone.run(at, p.id);
      });
      unparked++;
      boxes.add(p.box_id);
    }
    return { unparked, boxes: [...boxes] };
  }

  // ---- rollback (design section 4.4) ----

  rollback(boxId, versionId, { at = stampNow(), admin = '' } = {}) {
    const box = this.boxOf(boxId);
    if (!box || box.status === 'removed') return { ok: false, why: 'unknown box' };
    if (box.status === 'open') return { ok: false, why: 'the box is open; close it first' };
    const v = this.q.verGet.get(versionId);
    if (!v || v.box_id !== boxId) return { ok: false, why: 'no such version of this box' };
    const chunks = this.q.rootsOf.all(v.id).map((r) => asBuffer(r.bytes));
    const { version } = this.#tx(() => this.#newVersion(boxId, chunks, {
      at, source: 'rollback', saveVer: v.save_version, note: `from ${v.id}${admin ? ` by ${admin}` : ''}`,
    }));
    return { ok: true, version };
  }

  // ---- events (design section 3.4) ----

  events(list, serverId = '') {
    let stored = 0;
    this.#tx(() => {
      for (const e of list) {
        const kind = String(e?.kind || '').slice(0, 32);
        if (!kind) continue;
        const at = String(e.at || stampNow());
        const box = String(e.box || '');
        const uid = String(e.uid || '');
        this.q.evIns.run(at, kind, box, uid, String(e.name || ''), String(e.type || ''), Number(e.qty) || 0,
          Number.isInteger(e.row) ? e.row : -1, Number.isInteger(e.col) ? e.col : -1, String(e.slot || ''),
          String(e.note || ''), String(serverId || ''), String(e.admin || ''));
        stored++;
        if (kind === 'placed' && box) this.seen(box, { class: String(e.type || ''), pos: String(e.note || ''), at, by: uid });
        if (kind === 'removed' && box) this.removed(box, at);
      }
    });
    return stored;
  }

  eventsOf(boxId, limit = 100) {
    return this.q.evOfBox.all(boxId, limit);
  }

  eventsBy(uid, limit = 100) {
    return this.q.evOfUid.all(uid, limit);
  }

  // ---- retention (design section 4.3) ----

  keep({ versionsDays, eventsDays, now = new Date() }) {
    const cutoff = (days) => stampNow(new Date(now.getTime() - days * 86400 * 1000));
    return this.#tx(() => {
      const old = this.q.verOld.all(cutoff(versionsDays));
      for (const v of old) {
        this.q.rootsDel.run(v.id);
        this.q.verDel.run(v.id);
      }
      const blobs = this.q.blobGc.run().changes;
      const events = this.q.evOld.run(cutoff(eventsDays)).changes;
      return { versions: old.length, blobs: Number(blobs), events: Number(events) };
    });
  }
}
