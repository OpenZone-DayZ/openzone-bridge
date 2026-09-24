// The storage routes (design 2026-09-19, section 3): what the game posts
// through OZ_BridgeClient. Every answer is an object; a refusal is
// { ok: false, why } in words, never a thrown error, because the game reads
// the body and a 500 says nothing it can act on.

import { Xchg } from './storage-xchg.js';
import { buildFile, parseChunk, parseFile, stampNow, WireError } from './storage-wire.js';

const list = (v) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []);

export function storageRoutes({ store, xchg, admin }) {
  const off = { ok: false, why: 'storage not configured' };
  const bad = (why) => ({ ok: false, why });
  const boxId = (j) => (Xchg.isBoxId(j?.id) ? String(j.id) : '');

  return {
    '/v1/storage/boot': async ({ Json }) => {
      if (!xchg) return off;
      const boxes = (Array.isArray(Json?.boxes) ? Json.boxes : [])
        // `cls` is the game's spelling: `class` is a keyword in Enforce Script.
        .map((b) => ({ id: String(b?.id || ''), class: String(b?.class || b?.cls || ''), state: String(b?.state || ''), entities: Number(b?.entities) || 0, pos: String(b?.pos || '') }))
        .filter((b) => Xchg.isBoxId(b.id));
      const answer = store.boot(boxes);
      try {
        const swept = xchg.sweep(store.knownIds());
        if (swept.length) console.log(`[storage] boot: swept ${swept.length} stale file(s) from the exchange directory`);
      } catch (e) {
        console.warn(`[storage] boot: sweep failed (${e.code || e.message})`);
      }
      console.log(`[storage] boot: ${boxes.length} box(es), ${answer.classes.length} class(es) to check`);
      if (answer.back.length) {
        console.log(`[storage] boot: ${answer.back.length} archived box(es) are in the world again and were brought back closed: ${answer.back.join(', ')}`);
      }
      return { ok: true, ...answer };
    },

    '/v1/storage/classes': async ({ Json }) => {
      if (!xchg) return off;
      const parked = store.parkMissing(list(Json?.missing));
      const unparked = store.unparkPresent(list(Json?.present));
      for (const id of new Set([...parked.boxes, ...unparked.boxes])) xchg.dropCache(id);
      if (parked.parked || unparked.unparked) console.log(`[storage] classes: parked ${parked.parked}, unparked ${unparked.unparked}`);
      return { ok: true, parked: parked.parked, unparked: unparked.unparked };
    },

    '/v1/storage/close': async ({ Json }) => {
      if (!xchg) return off;
      const id = boxId(Json);
      if (!id) return bad('bad box id');
      const roots = Number(Json.roots) || 0;
      const by = String(Json.by || '');
      const why = String(Json.why || 'player');
      const name = String(Json.file || '');
      if (roots === 0 && name === '') {
        const r = store.ingestClose({ boxId: id, header: { stamp: String(Json.stamp || stampNow()), boxClass: '', saveVer: 0 }, chunks: [], by, why });
        xchg.dropCache(id);
        return { ok: true, version: r.version };
      }
      if (!Xchg.closeName(name, id)) return bad(`bad file name: ${name}`);
      let parsed;
      try {
        parsed = parseFile(xchg.readClose(name, id));
      } catch (e) {
        xchg.discard(name);
        return bad(e instanceof WireError ? `file refused: ${e.message}` : `file unreadable: ${e.code || e.message}`);
      }
      if (parsed.header.boxId !== id) {
        xchg.discard(name);
        return bad('the file belongs to another box');
      }
      if (parsed.header.roots !== roots) {
        xchg.discard(name);
        return bad(`the file holds ${parsed.header.roots} root(s), the request says ${roots}`);
      }
      const r = store.ingestClose({ boxId: id, header: parsed.header, chunks: parsed.roots.map((x) => x.bytes), by, why });
      try {
        const size = xchg.promote(name, id);
        store.cacheNote(id, parsed.header.stamp, size);
      } catch (e) {
        console.warn(`[storage] close of ${id}: the file could not become the cache (${e.code || e.message}); it is rebuilt at the next open`);
        xchg.discard(name);
      }
      return { ok: true, version: r.version, roots: r.roots, entities: r.entities };
    },

    // One turn of a proxy session (design 2026-09-24 section 7). The roots the
    // turn changed, the roots it removed and the roots it added, in one letter
    // so a turn that touches two roots cannot half-happen.
    '/v1/storage/op': async ({ Json }) => {
      if (!xchg) return off;
      const id = boxId(Json);
      if (!id) return bad('bad box id');
      const rewrite = (Array.isArray(Json.rewrite) ? Json.rewrite : []).map((x) => Number(x) | 0);
      const drop = (Array.isArray(Json.drop) ? Json.drop : []).map((x) => Number(x) | 0);
      const adds = Number(Json.adds) || 0;
      const name = String(Json.file || '');
      let chunks = [];
      if (rewrite.length + adds > 0) {
        if (!Xchg.opName(name, id)) return bad(`bad file name: ${name}`);
        let parsed;
        try {
          parsed = parseFile(xchg.readOp(name, id));
        } catch (e) {
          xchg.discard(name);
          return bad(e instanceof WireError ? `file refused: ${e.message}` : `file unreadable: ${e.code || e.message}`);
        }
        if (parsed.header.boxId !== id) {
          xchg.discard(name);
          return bad('the file belongs to another box');
        }
        chunks = parsed.roots.map((x) => x.bytes);
      }
      let r;
      try {
        r = store.applyOps({ boxId: id, chunks, rewrite, drop, adds, by: 'session' });
      } catch (e) {
        xchg.discard(name);
        return bad(`the turn was refused: ${e.message}`);
      }
      // The file has been read into SQL; it is nobody's any more.
      if (name) xchg.discard(name);
      return { ok: true, version: r.version, roots: r.roots, entities: r.entities };
    },

    '/v1/storage/closed': async ({ Json }) => {
      if (!xchg) return off;
      const id = boxId(Json);
      if (!id) return bad('bad box id');
      return store.markClosed(id) ? { ok: true } : bad('unknown box');
    },

    '/v1/storage/open': async ({ Json }) => {
      if (!xchg) return off;
      const id = boxId(Json);
      if (!id) return bad('bad box id');
      const box = store.boxOf(id);
      if (box && box.status === 'removed') return bad('unknown box');
      if (!box) {
        // A box the engine has and SQL does not: new, and empty (design
        // section 3.3, status none). Its first close makes its first version.
        store.seen(id, { by: String(Json.by || '') });
        store.markOpen(id);
        return { ok: true, empty: true };
      }
      if (box.status === 'open') console.warn(`[storage] open of ${id}, which SQL believed open already; the engine knows better`);
      const cur = store.currentChunks(id);
      if (!cur || cur.chunks.length === 0) {
        store.markOpen(id);
        return { ok: true, empty: true };
      }
      const info = xchg.cacheInfo(id);
      const valid = info && box.cache_size > 0 && info.size === box.cache_size && info.stamp === cur.stamp;
      if (!valid) {
        try {
          const size = xchg.writeCache(id, buildFile({ saveVer: cur.saveVer, stamp: cur.stamp, boxClass: cur.boxClass, boxId: id }, cur.chunks));
          store.cacheNote(id, cur.stamp, size);
        } catch (e) {
          console.warn(`[storage] open of ${id}: cache write failed (${e.code || e.message})`);
          return bad('the exchange directory is not writable');
        }
      }
      // COMPUTED THE SAME WAY THE FILE ITSELF WOULD ANSWER, not read back off
      // the version row: the two must never be able to disagree about what
      // the game is about to parse.
      let entities = 0;
      try {
        for (const c of cur.chunks) entities += parseChunk(c).nodes.length;
      } catch (e) {
        return bad(`a stored root cannot be parsed: ${e.message}`);
      }
      store.markOpen(id);
      return { ok: true, file: xchg.cacheName(id), stamp: cur.stamp, roots: cur.chunks.length, entities };
    },

    '/v1/storage/opened': async ({ Json }) => {
      if (!xchg) return off;
      const id = boxId(Json);
      if (!id) return bad('bad box id');
      return store.markOpen(id) ? { ok: true } : bad('unknown box');
    },

    '/v1/storage/park': async ({ Json }) => {
      if (!xchg) return off;
      const id = boxId(Json);
      if (!id) return bad('bad box id');
      const root = Number(Json.root);
      if (!Number.isInteger(root) || root < 0) return bad('bad root index');
      const reasons = ['refused', 'desync', 'no_room'];
      const why = String(Json.why || '');
      const r = store.park({
        boxId: id,
        rootIdx: root,
        reason: reasons.includes(why) ? why : 'refused',
        note: String(Json.type || ''),
      });
      if (!r) return bad('no such root of this box');
      xchg.dropCache(id);
      console.log(`[storage] parked root ${root} (${r.type}) of ${id}: ${why || 'refused'}`);
      return { ok: true, version: r.version, parked: r.parked, type: r.type };
    },

    '/v1/storage/events': async ({ Json, ServerId }) => {
      if (!xchg) return off;
      const events = Array.isArray(Json?.events) ? Json.events.slice(0, 500) : [];
      const stored = store.events(events, String(ServerId || ''));
      return { ok: true, stored };
    },

    // The admin side: the console today, the web tomorrow (design sections
    // 4.5 and 8). One op per call, named in Json.op; `admin` names who.
    '/v1/storage/admin': async ({ Json }) => {
      if (!xchg) return off;
      if (!admin) return bad('no admin side');
      const op = String(Json?.op || '');
      const fn = Object.prototype.hasOwnProperty.call(admin, op) ? admin[op] : null;
      if (typeof fn !== 'function') return bad(`unknown op: ${op}`);
      try {
        return await fn({ ...Json, admin: String(Json?.admin || 'cli') });
      } catch (e) {
        console.warn(`[storage] admin ${op}: ${e.message}`);
        return bad(`${op} failed: ${e.message}`);
      }
    },
  };
}
