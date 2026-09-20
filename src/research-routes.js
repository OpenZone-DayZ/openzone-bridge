// The research routes (design 2026-09-20, section 4.2): what the game posts
// through OZ_BridgeClient, and the research items of a poll. Every answer is
// an object; a refusal is { ok: false, why } in words, never a thrown error,
// because the game reads the body and a 500 says nothing it can act on.
//
// The bridge reads the game's config files ITSELF: a letter only says which
// file changed and who did it. Nothing the game sends is a config.

import { ResearchXchg } from './research-xchg.js';
import { stampNow } from './storage-wire.js';

const list = (v) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []);

export function researchRoutes({ store, xchg, admin }) {
  const off = { ok: false, why: 'research not configured' };
  const bad = (why) => ({ ok: false, why });

  // Per server, since the bridge started: what it told us at boot; whether
  // the boot request went out; whether its unanswered mail was re-sent.
  const booted = new Map();
  const helloed = new Set();
  const served = new Set();
  let classes = { names: [], count: 0, at: '' };

  const routes = {
    // The game after its start: which configs it holds, at which revision,
    // and the class list it dumped. Every file becomes a version unless the
    // newest applied one already holds its text.
    '/v1/research/boot': async ({ Json, ServerId }) => {
      if (!xchg) return off;
      const sid = String(ServerId || '');
      const rev = Number(Json?.Revision) || 0;
      const counters = String(Json?.Counters || '');
      const names = list(Json?.Names).filter(ResearchXchg.isName);
      let configs = 0;
      let fresh = 0;
      for (const name of names) {
        let r;
        try {
          r = await xchg.readConfig(name);
        } catch (e) {
          console.warn(`[research] boot: ${e.message}`);
          store.record({ kind: 'unreadable', name, note: e.message, serverId: sid });
          continue;
        }
        if (!r) {
          console.warn(`[research] boot: ${ResearchXchg.fileOf(name)} is not in ${xchg.dir}`);
          continue;
        }
        const s = store.snapshot({ name, text: r.text, by: 'game', source: 'game', status: 'applied', serverId: sid });
        configs++;
        if (s.fresh) fresh++;
      }
      classes = xchg.readClasses();
      booted.set(sid, { revision: rev, counters, at: stampNow(), classes: classes.count });
      helloed.delete(sid);
      try {
        const swept = xchg.sweep(store.keepTokens());
        if (swept.length) console.log(`[research] boot: swept ${swept.length} file(s) from the exchange directory`);
      } catch (e) {
        console.warn(`[research] boot: sweep failed (${e.code || e.message})`);
      }
      store.record({ kind: 'boot', serverId: sid, note: `revision ${rev}: ${configs} config(s), ${fresh} new version(s), ${classes.count} class(es); ${counters}` });
      console.log(`[research] boot from ${sid}: ${configs} configs (${fresh} new versions), ${classes.count} classes, revision ${rev}`);
      return { ok: true, configs, versions: fresh, classes: classes.count };
    },

    // The game applied an edit (the VPP editor, or our candidate): read the
    // file back. Our candidate's text promotes its pending version; any
    // other text is a new version of the game's own.
    '/v1/research/changed': async ({ Json, ServerId }) => {
      if (!xchg) return off;
      const sid = String(ServerId || '');
      const name = String(Json?.Name || '');
      if (!ResearchXchg.isName(name)) return bad('unknown config');
      const by = String(Json?.By || '');
      const rev = Number(Json?.Revision) || 0;
      let r;
      try {
        r = await xchg.readConfig(name);
      } catch (e) {
        console.warn(`[research] changed: ${e.message}`);
        store.record({ kind: 'unreadable', name, note: e.message, serverId: sid, admin: by });
        return bad(`unreadable: ${e.message}`);
      }
      if (!r) return bad('no such file');
      const s = store.snapshot({ name, text: r.text, by, source: 'game', status: 'applied', serverId: sid });
      let what = 'the same text';
      if (s.promoted) what = 'the candidate applied';
      else if (s.fresh) what = 'a new version';
      if (s.fresh || s.promoted) console.log(`[research] ${name} changed by ${by}: version ${s.version} (${what}), revision ${rev}`);
      store.record({ kind: 'changed', name, note: `by ${by}: version ${s.version}, ${what}, revision ${rev}`, serverId: sid, admin: by });
      return { ok: true, version: s.version };
    },

    // The game's answer to a command, by token. A candidate's file is the
    // game's to delete on success; if it could not, the bridge does.
    '/v1/research/result': async ({ Json, ServerId }) => {
      if (!xchg) return off;
      const sid = String(ServerId || '');
      const token = String(Json?.Token || '');
      if (!ResearchXchg.isToken(token)) return bad('bad token');
      const ok = !!Json?.Ok;
      const why = String(Json?.Why || '');
      const note = String(Json?.Note || '');
      const c = store.answer(token, ok, why, note);
      if (!c) {
        console.warn(`[research] result for an unknown token ${token} from ${sid}`);
        return bad('unknown token');
      }
      if (c.already) return { ok: true, already: true };
      if (c.op === 'cfg_apply') {
        if (ok) {
          store.applied(token);
          if (xchg.hasCandidate(c.args.file) && xchg.discard(c.args.file)) console.log(`[research] ${c.args.file}: the game left it behind, removed`);
        } else {
          store.rejected(token, why);
        }
      }
      const text = ok ? `ok ${note}`.trim() : `refused: ${why}`;
      console.log(`[research] result ${token} (${c.op} by ${c.by}): ${text}`);
      store.record({ kind: 'result', token, name: String(c.args.name || ''), note: `${c.op}: ${text}`, serverId: sid, admin: c.by });
      return { ok: true };
    },

    // The admin side: the console and the web. One op per call, named in
    // Json.op; `admin` names who.
    '/v1/research/admin': async ({ Json }) => {
      if (!xchg) return off;
      if (!admin) return bad('no admin side');
      const op = String(Json?.op || '');
      const fn = Object.prototype.hasOwnProperty.call(admin, op) ? admin[op] : null;
      if (typeof fn !== 'function') return bad(`unknown op: ${op}`);
      try {
        return await fn({ ...Json, admin: String(Json?.admin || 'cli') });
      } catch (e) {
        console.warn(`[research] admin ${op}: ${e.message}`);
        return bad(`${op} failed: ${e.message}`);
      }
    },
  };

  // The research items of one poll. The first poll of a server since the
  // bridge started -- and the first after the game restarted (Fresh) --
  // carries every command still unanswered, straight into this server's
  // items rather than the shared queue (a server's first poll skips the
  // queue). A server whose boot letter the bridge has not seen is asked for
  // it once with {op:"hello"}; a fresh game boots by itself.
  function poll(serverId, fresh) {
    const items = [];
    if (!xchg) return items;
    const sid = String(serverId || '');
    if (fresh) {
      booted.delete(sid);
      helloed.delete(sid);
      served.delete(sid);
    }
    if (!served.has(sid)) {
      served.add(sid);
      const rows = store.unanswered();
      for (const c of rows) items.push({ Kind: 'research', Json: JSON.stringify({ op: c.op, token: c.token, by: c.by, ...c.args }) });
      if (rows.length) {
        store.sent(rows.map((r) => r.token));
        console.log(`[research] ${sid}: ${rows.length} unanswered command(s) re-sent`);
      }
    }
    if (!fresh && !booted.has(sid) && !helloed.has(sid)) {
      helloed.add(sid);
      items.push({ Kind: 'research', Json: JSON.stringify({ op: 'hello' }) });
    }
    return items;
  }

  return {
    routes,
    poll,
    classes: () => classes,
    booted: () => [...booted].map(([id, b]) => ({ id, ...b })),
  };
}
