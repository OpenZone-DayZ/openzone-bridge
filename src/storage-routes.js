// The storage routes (design 2026-09-19, section 3): what the game posts
// through OZ_BridgeClient. Every answer is an object; a refusal is
// { ok: false, why } in words, never a thrown error, because the game reads
// the body and a 500 says nothing it can act on.

import { Xchg } from './storage-xchg.js';
import { buildFile, parseFile, stampNow, WireError } from './storage-wire.js';

const list = (v) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []);

export function storageRoutes({ store, xchg }) {
  const off = { ok: false, why: 'storage not configured' };
  const bad = (why) => ({ ok: false, why });
  const boxId = (j) => (Xchg.isBoxId(j?.id) ? String(j.id) : '');

  return {
    '/v1/storage/boot': async ({ Json }) => {
      if (!xchg) return off;
      const boxes = (Array.isArray(Json?.boxes) ? Json.boxes : [])
        .map((b) => ({ id: String(b?.id || ''), class: String(b?.class || ''), state: String(b?.state || ''), entities: Number(b?.entities) || 0, pos: String(b?.pos || '') }))
        .filter((b) => Xchg.isBoxId(b.id));
      const answer = store.boot(boxes);
      const swept = xchg.sweep(store.knownIds());
      if (swept.length) console.log(`[storage] boot: swept ${swept.length} stale file(s) from the exchange directory`);
      console.log(`[storage] boot: ${boxes.length} box(es), ${answer.classes.length} class(es) to check`);
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
      if (!Xchg.closeName(name, id)) return bad('bad file name');
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
      if (!box || box.status === 'removed') return bad('unknown box');
      if (box.status === 'open') console.warn(`[storage] open of ${id}, which SQL believed open already; the engine knows better`);
      const cur = store.currentChunks(id);
      if (!cur || cur.chunks.length === 0) return { ok: true, empty: true };
      const info = xchg.cacheInfo(id);
      const valid = info && box.cache_size > 0 && info.size === box.cache_size && info.stamp === cur.stamp;
      if (!valid) {
        const size = xchg.writeCache(id, buildFile({ saveVer: cur.saveVer, stamp: cur.stamp, boxClass: cur.boxClass, boxId: id }, cur.chunks));
        store.cacheNote(id, cur.stamp, size);
      }
      return { ok: true, file: xchg.cacheName(id), stamp: cur.stamp, roots: cur.roots, entities: cur.entities };
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
  };
}
