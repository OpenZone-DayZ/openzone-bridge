// The research tables (design 2026-09-20, section 6): every version of the
// nine research configs of the game server, the commands the admin side
// sent to the game and what the game answered, and a journal. The truth of
// a config is the file in the game's profile; this is its history and its
// mail. On the bridge's own database, beside the chat and storage tables.
//
// A version is a text kept whole, deduplicated by a CANONICAL hash: the
// parsed value serialised with sorted keys. The game rewrites every file it
// applies in its own formatting, so hashing the bytes would make each edit
// two versions -- the admin's candidate and the game's rewrite of it. With
// the canonical hash the rewrite promotes the candidate instead, and a file
// that differs in substance (the game's Validate fixed a value) is what
// becomes a new version of its own.

import { createHash } from 'node:crypto';
import { stampNow } from './storage-wire.js';

const DDL = [
  `CREATE TABLE IF NOT EXISTS research_configs (
     id        INTEGER PRIMARY KEY AUTOINCREMENT,
     server_id TEXT NOT NULL DEFAULT '',
     name      TEXT NOT NULL,
     version   INTEGER NOT NULL,
     hash      TEXT NOT NULL,
     at        TEXT NOT NULL,
     by        TEXT NOT NULL DEFAULT '',
     source    TEXT NOT NULL DEFAULT 'game',
     status    TEXT NOT NULL DEFAULT 'applied',
     why       TEXT NOT NULL DEFAULT '',
     token     TEXT NOT NULL DEFAULT '',
     size      INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS research_configs_name ON research_configs(name, version)`,
  `CREATE INDEX IF NOT EXISTS research_configs_token ON research_configs(token)`,
  `CREATE TABLE IF NOT EXISTS research_blobs (
     hash TEXT PRIMARY KEY,
     json TEXT NOT NULL,
     size INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS research_commands (
     token       TEXT PRIMARY KEY,
     server_id   TEXT NOT NULL DEFAULT '',
     op          TEXT NOT NULL,
     args        TEXT NOT NULL DEFAULT '{}',
     by          TEXT NOT NULL DEFAULT '',
     at          TEXT NOT NULL,
     status      TEXT NOT NULL DEFAULT 'queued',
     ok          INTEGER NOT NULL DEFAULT 0,
     answer      TEXT NOT NULL DEFAULT '',
     answered_at TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE TABLE IF NOT EXISTS research_events (
     id        INTEGER PRIMARY KEY AUTOINCREMENT,
     at        TEXT NOT NULL,
     kind      TEXT NOT NULL,
     note      TEXT NOT NULL DEFAULT '',
     server_id TEXT NOT NULL DEFAULT '',
     admin     TEXT NOT NULL DEFAULT '',
     name      TEXT NOT NULL DEFAULT '',
     token     TEXT NOT NULL DEFAULT ''
   )`,
];

// The parsed value with its keys sorted at every depth: what two texts of
// the same config have in common whatever their formatting.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashOfText(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    // Not json: hash the bytes, so an unreadable file is still one version.
    return createHash('sha256').update(text, 'utf8').digest('hex');
  }
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

const STATUSES = new Set(['applied', 'pending', 'rejected']);
const cutoff = (days, now) => stampNow(new Date(now.getTime() - days * 24 * 60 * 60 * 1000));

export class ResearchStore {
  constructor(store) {
    this.db = store.db;
    for (const ddl of DDL) this.db.exec(ddl);
    const q = (sql) => this.db.prepare(sql);
    this.q = {
      nextVersion: q('SELECT COALESCE(MAX(version), 0) + 1 AS n FROM research_configs WHERE name = ?'),
      cfgIns: q(`INSERT INTO research_configs(server_id, name, version, hash, at, by, source, status, why, token, size)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      cfgLatest: q('SELECT * FROM research_configs WHERE name = ? ORDER BY version DESC LIMIT 1'),
      cfgCurrent: q(`SELECT * FROM research_configs WHERE name = ? AND status = 'applied' ORDER BY version DESC LIMIT 1`),
      cfgPendingByHash: q(`SELECT * FROM research_configs WHERE name = ? AND hash = ? AND status = 'pending' ORDER BY version DESC LIMIT 1`),
      cfgByToken: q('SELECT * FROM research_configs WHERE token = ? LIMIT 1'),
      cfgOf: q('SELECT * FROM research_configs WHERE name = ? ORDER BY version DESC LIMIT ?'),
      cfgVersion: q('SELECT * FROM research_configs WHERE name = ? AND version = ?'),
      cfgStatus: q('UPDATE research_configs SET status = ?, why = ?, at = ? WHERE id = ?'),
      cfgPendingCount: q(`SELECT COUNT(*) AS n FROM research_configs WHERE name = ? AND status = 'pending'`),
      cfgOld: q(`SELECT c.id, c.hash FROM research_configs c
                 WHERE c.at < ? AND c.status != 'pending'
                   AND c.id NOT IN (SELECT id FROM research_configs x
                                    WHERE x.status = 'applied' AND x.name = c.name
                                    ORDER BY x.version DESC LIMIT 1)`),
      cfgDel: q('DELETE FROM research_configs WHERE id = ?'),

      blobIns: q('INSERT OR IGNORE INTO research_blobs(hash, json, size) VALUES (?, ?, ?)'),
      blobGet: q('SELECT json FROM research_blobs WHERE hash = ?'),
      blobOrphans: q('DELETE FROM research_blobs WHERE hash NOT IN (SELECT hash FROM research_configs)'),

      cmdIns: q(`INSERT INTO research_commands(token, server_id, op, args, by, at, status) VALUES (?, ?, ?, ?, ?, ?, 'queued')`),
      cmdGet: q('SELECT * FROM research_commands WHERE token = ?'),
      cmdUnanswered: q(`SELECT * FROM research_commands WHERE status != 'answered' ORDER BY rowid`),
      cmdSent: q(`UPDATE research_commands SET status = 'sent' WHERE token = ? AND status != 'answered'`),
      cmdAnswer: q(`UPDATE research_commands SET status = 'answered', ok = ?, answer = ?, answered_at = ? WHERE token = ?`),
      cmdKeep: q(`SELECT token FROM research_commands WHERE NOT (status = 'answered' AND ok = 1)`),
      cmdRecent: q('SELECT * FROM research_commands ORDER BY rowid DESC LIMIT ?'),
      cmdOld: q(`DELETE FROM research_commands WHERE status = 'answered' AND answered_at < ?`),

      evIns: q('INSERT INTO research_events(at, kind, note, server_id, admin, name, token) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      evList: q("SELECT * FROM research_events WHERE (? = '' OR server_id = ? OR server_id = '') ORDER BY id DESC LIMIT ?"),
      evOld: q('DELETE FROM research_events WHERE at < ?'),
    };
  }

  // A version of `name` with this text. Applied text that the newest
  // applied version already holds is not a new version; applied text that a
  // pending candidate holds promotes that candidate (the game just applied
  // it); pending text is always a new version, tied to its command's token.
  snapshot({ name, text, by = '', source = 'game', status = 'applied', why = '', token = '', serverId = '', at = stampNow() }) {
    if (!STATUSES.has(status)) throw new Error(`bad status: ${status}`);
    const hash = hashOfText(text);
    const size = Buffer.byteLength(text, 'utf8');
    if (status === 'applied') {
      const pending = this.q.cfgPendingByHash.get(name, hash);
      if (pending) {
        this.q.cfgStatus.run('applied', '', at, pending.id);
        return { version: pending.version, id: pending.id, hash, fresh: false, promoted: true };
      }
      const current = this.q.cfgCurrent.get(name);
      if (current && current.hash === hash) return { version: current.version, id: current.id, hash, fresh: false, promoted: false };
    }
    const version = this.q.nextVersion.get(name).n;
    this.q.blobIns.run(hash, text, size);
    const r = this.q.cfgIns.run(serverId, name, version, hash, at, by, source, status, why, token, size);
    return { version, id: Number(r.lastInsertRowid), hash, fresh: true, promoted: false };
  }

  // The candidate of a command, once the game answered.
  applied(token, at = stampNow()) {
    const row = this.q.cfgByToken.get(token);
    if (!row) return null;
    if (row.status === 'pending') this.q.cfgStatus.run('applied', '', at, row.id);
    return this.q.cfgVersion.get(row.name, row.version);
  }

  rejected(token, why, at = stampNow()) {
    const row = this.q.cfgByToken.get(token);
    if (!row) return null;
    if (row.status === 'pending') this.q.cfgStatus.run('rejected', String(why || ''), at, row.id);
    return this.q.cfgVersion.get(row.name, row.version);
  }

  // The newest version of any status; the newest APPLIED one; a numbered one.
  latest(name) {
    return this.q.cfgLatest.get(name) || null;
  }

  current(name) {
    return this.q.cfgCurrent.get(name) || null;
  }

  version(name, n) {
    return this.q.cfgVersion.get(name, Number(n) || 0) || null;
  }

  versions(name, limit = 50) {
    return this.q.cfgOf.all(name, Math.max(1, Math.min(1000, Math.trunc(Number(limit)) || 50)));
  }

  pendingCount(name) {
    return this.q.cfgPendingCount.get(name).n;
  }

  byToken(token) {
    return this.q.cfgByToken.get(token) || null;
  }

  text(hash) {
    const row = this.q.blobGet.get(hash);
    return row ? row.json : null;
  }

  // ---------- commands ----------

  queue({ token, op, args = {}, by = '', serverId = '', at = stampNow() }) {
    this.q.cmdIns.run(token, serverId, op, JSON.stringify(args), by, at);
    return this.command(token);
  }

  command(token) {
    const row = this.q.cmdGet.get(token);
    return row ? withArgs(row) : null;
  }

  unanswered() {
    return this.q.cmdUnanswered.all().map(withArgs);
  }

  sent(tokens) {
    for (const t of tokens) this.q.cmdSent.run(t);
  }

  // The game's answer. Null for an unknown token; `already` when it was
  // answered before (the game repeats a stored answer for a re-sent command).
  answer(token, ok, why = '', note = '', at = stampNow()) {
    const row = this.q.cmdGet.get(token);
    if (!row) return null;
    if (row.status === 'answered') return { ...withArgs(row), already: true };
    this.q.cmdAnswer.run(ok ? 1 : 0, ok ? String(note || '') : String(why || ''), at, token);
    return { ...withArgs(this.q.cmdGet.get(token)), already: false };
  }

  // Tokens whose candidate file must stay in the exchange directory: not
  // answered yet, or refused (kept for the admin to look at).
  keepTokens() {
    return this.q.cmdKeep.all().map((r) => r.token);
  }

  commands(limit = 100) {
    return this.q.cmdRecent.all(Math.max(1, Math.min(1000, Math.trunc(Number(limit)) || 100))).map(withArgs);
  }

  // ---------- journal ----------

  record({ kind, note = '', serverId = '', admin = '', name = '', token = '', at = stampNow() }) {
    this.q.evIns.run(at, String(kind), String(note), String(serverId), String(admin), String(name), String(token));
  }

  // `serverId` narrows to one game server's events; the bridge's own
  // (server_id empty) always show.
  events(limit = 100, serverId = '') {
    const s = String(serverId || '');
    return this.q.evList.all(s, s, Math.max(1, Math.min(1000, Math.trunc(Number(limit)) || 100)));
  }

  // ---------- retention ----------

  // Versions older than the window go, except each config's newest applied
  // one and anything pending; blobs nobody references go with them; events
  // and answered commands older than their window go.
  keep({ versionsDays, eventsDays, now = new Date() }) {
    const vcut = cutoff(versionsDays, now);
    const ecut = cutoff(eventsDays, now);
    let versions = 0;
    for (const row of this.q.cfgOld.all(vcut)) {
      this.q.cfgDel.run(row.id);
      versions++;
    }
    const blobs = versions ? Number(this.q.blobOrphans.run().changes) : 0;
    const events = Number(this.q.evOld.run(ecut).changes);
    const commands = Number(this.q.cmdOld.run(ecut).changes);
    return { versions, blobs, events, commands };
  }

  keepPreview({ versionsDays, eventsDays, now = new Date() }) {
    const vcut = cutoff(versionsDays, now);
    const ecut = cutoff(eventsDays, now);
    const versions = this.q.cfgOld.all(vcut).length;
    const events = this.db.prepare('SELECT COUNT(*) AS n FROM research_events WHERE at < ?').get(ecut).n;
    return { versions, events };
  }
}

function withArgs(row) {
  let args = {};
  try {
    args = JSON.parse(row.args || '{}');
  } catch {
    args = {};
  }
  return { ...row, ok: !!row.ok, args };
}
