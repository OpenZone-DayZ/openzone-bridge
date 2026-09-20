// The admin side of research (design 2026-09-20, section 6): what the
// console and the web may do. Reads come from the versions in SQL and from
// the game's own files; a change is a CANDIDATE -- checked for shape, written
// into the exchange directory, announced to the game as a command -- and the
// version stays pending until the game answers; a live command is queued for
// the game's poll and answered by a result letter that carries its token.

import { randomBytes } from 'node:crypto';
import { NAMES, SHAPES, ResearchXchg } from './research-xchg.js';
import { stampNow } from './storage-wire.js';

// A poll item's Json must stay well under a kilobyte (index.js, the
// roster): the game truncates the field above that.
const COMMAND_MAX = 800;
const BY_MAX = 40;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function researchAdmin({ store, xchg, push, status }) {
  const bad = (why) => ({ ok: false, why });
  const off = bad('research not configured');
  const limitOf = (v) => Math.min(1000, Math.max(1, Math.trunc(Number(v)) || 100));
  const who = (admin) => String(admin || 'admin').slice(0, BY_MAX);
  const idOf = (v) => (ID.test(String(v ?? '')) ? String(v) : '');

  // A command for the game: in SQL first (so a bridge restart re-sends it),
  // then into every server's next poll.
  function command(op, args, admin, note) {
    if (!xchg) return off;
    if (!push) return bad('no live channel');
    const by = who(admin);
    const token = randomBytes(6).toString('hex');
    const letter = { op, token, by, ...args };
    if (Buffer.byteLength(JSON.stringify(letter), 'utf8') > COMMAND_MAX) return bad('command too long for the poll');
    store.queue({ token, op, args, by });
    push(letter);
    store.sent([token]);
    store.record({ kind: `admin_${op}`, token, admin: by, name: String(args.name || ''), note });
    return { ok: true, token };
  }

  // The shape check of a candidate: json, an object, an integer Version,
  // the array the config is built around. Everything finer is the game's.
  function parse(name, json) {
    let value;
    try {
      value = typeof json === 'string' ? JSON.parse(json) : json;
    } catch (e) {
      return { why: `not json: ${e.message}` };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { why: 'not an object' };
    if (!Number.isInteger(value.Version) || value.Version < 1) return { why: 'Version must be a positive integer' };
    const field = SHAPES[name];
    if (field && !Array.isArray(value[field])) return { why: `${field} must be an array` };
    return { value, text: JSON.stringify(value, null, 4) };
  }

  async function candidate(name, text, admin, note) {
    const by = who(admin);
    const token = randomBytes(6).toString('hex');
    const file = ResearchXchg.candidateName(name, token);
    const letter = { op: 'cfg_apply', token, by, name, file };
    try {
      xchg.writeCandidate(name, token, text);
    } catch (e) {
      return bad(`the exchange directory is not writable: ${e.code || e.message}`);
    }
    const v = store.snapshot({ name, text, by, source: 'admin', status: 'pending', token });
    store.queue({ token, op: 'cfg_apply', args: { name, file }, by });
    push(letter);
    store.sent([token]);
    store.record({ kind: 'admin_save', token, admin: by, name, note: `${note}: version ${v.version} as ${file}` });
    return { ok: true, token, version: v.version, file };
  }

  const summary = (name) => {
    const latest = store.latest(name);
    const current = store.current(name);
    const info = xchg ? xchg.configInfo(name) : { exists: false, size: 0, mtime: 0 };
    return {
      name,
      file: ResearchXchg.fileOf(name),
      exists: info.exists,
      size: info.size,
      version: current ? current.version : 0,
      at: current ? current.at : '',
      by: current ? current.by : '',
      source: current ? current.source : '',
      latest: latest ? latest.version : 0,
      latestStatus: latest ? latest.status : '',
      pending: store.pendingCount(name),
    };
  };

  return {
    configs: () => {
      if (!xchg) return off;
      return { ok: true, configs: NAMES.map(summary) };
    },

    // One version's text: the numbered one, or the newest. A config with
    // no version yet (the bridge is up, the game has not booted) is read
    // from the file and becomes version 1.
    config: async ({ name, version }) => {
      if (!xchg) return off;
      if (!ResearchXchg.isName(name)) return bad('unknown config');
      let row = version ? store.version(name, version) : store.latest(name);
      if (!row && !version) {
        let r;
        try {
          r = await xchg.readConfig(name);
        } catch (e) {
          return bad(`unreadable: ${e.message}`);
        }
        if (!r) return bad('no such file');
        store.snapshot({ name, text: r.text, by: 'game', source: 'game', status: 'applied' });
        row = store.latest(name);
      }
      if (!row) return bad('no such version');
      const { id, ...rest } = row;
      return { ok: true, ...rest, text: store.text(row.hash) || '' };
    },

    history: ({ name, limit }) => {
      if (!xchg) return off;
      if (!ResearchXchg.isName(name)) return bad('unknown config');
      return { ok: true, versions: store.versions(name, limitOf(limit)).map(({ id, ...v }) => v) };
    },

    save: async ({ name, json, admin }) => {
      if (!xchg) return off;
      if (!push) return bad('no live channel');
      if (!ResearchXchg.isName(name)) return bad('unknown config');
      const p = parse(name, json);
      if (p.why) return bad(p.why);
      return candidate(name, p.text, admin, 'save');
    },

    restore: async ({ name, version, admin }) => {
      if (!xchg) return off;
      if (!push) return bad('no live channel');
      if (!ResearchXchg.isName(name)) return bad('unknown config');
      const row = store.version(name, version);
      if (!row) return bad('no such version');
      const text = store.text(row.hash);
      if (text === null) return bad('the text of that version is gone');
      const p = parse(name, text);
      if (p.why) return bad(`version ${row.version} is not a valid candidate: ${p.why}`);
      return candidate(name, p.text, admin, `restore of version ${row.version}`);
    },

    result: ({ token }) => {
      if (!xchg) return off;
      if (!ResearchXchg.isToken(token)) return bad('bad token');
      const c = store.command(token);
      if (!c) return { ok: true, result: null };
      const v = c.op === 'cfg_apply' ? store.byToken(token) : null;
      return { ok: true, result: { ...c, version: v ? { name: v.name, version: v.version, status: v.status, why: v.why } : null } };
    },

    state: () => {
      if (!xchg) return off;
      return { ok: true, owners: xchg.readStates() };
    },

    classes: () => {
      if (!xchg) return off;
      return { ok: true, ...xchg.readClasses() };
    },

    reset: ({ owner, admin }) => {
      const o = idOf(owner);
      if (!o) return bad('bad owner');
      return command('reset', { owner: o }, admin, o);
    },

    grant: ({ owner, type, amount, admin }) => {
      const o = idOf(owner);
      const t = idOf(type);
      const n = Math.trunc(Number(amount));
      if (!o) return bad('bad owner');
      if (!t) return bad('bad point type');
      if (!Number.isFinite(n) || n === 0) return bad('bad amount');
      return command('grant', { owner: o, type: t, amount: String(n) }, admin, `${o} ${t} ${n}`);
    },

    complete: ({ owner, node, admin }) => {
      const o = idOf(owner);
      const nd = idOf(node);
      if (!o) return bad('bad owner');
      if (!nd) return bad('bad node');
      return command('complete', { owner: o, node: nd }, admin, `${o} ${nd}`);
    },

    reload: ({ admin }) => command('reload', {}, admin, ''),

    respawn: ({ id, admin }) => {
      const s = idOf(id);
      if (!s) return bad('bad static id');
      return command('respawn', { id: s }, admin, s);
    },

    events: ({ limit }) => {
      if (!xchg) return off;
      return { ok: true, events: store.events(limitOf(limit)) };
    },

    commands: ({ limit }) => {
      if (!xchg) return off;
      return { ok: true, commands: store.commands(limitOf(limit)) };
    },

    // The kind's own state for the health page: what index.js knows (the
    // directories, the booted servers, the class list) plus the mail.
    status: () => ({
      ok: true,
      configured: !!xchg,
      dir: xchg ? xchg.dir : '',
      xchg: xchg ? xchg.xchgDir : '',
      ...(status ? status() : {}),
      unanswered: xchg ? store.unanswered().length : 0,
      at: stampNow(),
    }),
  };
}
