// The admin side of the storage (design 2026-09-19, sections 4.4, 4.5, 8):
// what the console and, later, the web may do. Reads come from SQL; a change
// of a version works on a closed box, drops its cache so the next open
// rebuilds it, and leaves an event with the admin's name; a live command is
// pushed into the game's poll and the engine answers with an admin_result
// event that carries the command's ref.

import { randomBytes } from 'node:crypto';
import { stampNow } from './storage-wire.js';

export function storageAdmin({ store, xchg, push }) {
  const bad = (why) => ({ ok: false, why });
  const dropCache = (id) => {
    if (xchg) xchg.dropCache(id);
  };
  const record = (kind, boxId, admin, note) => {
    store.events([{ at: stampNow(), kind, box: boxId, admin: String(admin || ''), note }], 'admin');
  };
  const known = (id) => {
    const box = store.boxOf(String(id || ''));
    if (!box || box.status === 'removed') return null;
    return box;
  };

  function live(cmd, id, admin) {
    if (!known(id)) return bad('unknown box');
    if (!push) return bad('no live channel');
    const ref = randomBytes(6).toString('hex');
    push({ cmd, id: String(id), by: String(admin || 'admin'), ref });
    record(`admin_${cmd}`, String(id), admin, `ref ${ref}`);
    return { ok: true, ref };
  }

  return {
    boxes: () => ({ ok: true, boxes: store.boxes() }),

    box: ({ id }) => {
      const box = known(id);
      if (!box) return bad('unknown box');
      return { ok: true, box, items: store.itemsOf(box.box_id), versions: store.versionsOf(box.box_id, 20) };
    },

    history: ({ id, limit }) => {
      const box = known(id);
      if (!box) return bad('unknown box');
      const n = Number(limit) || 100;
      return { ok: true, events: store.eventsOf(box.box_id, n), versions: store.versionsOf(box.box_id, n) };
    },

    player: ({ uid, limit }) => ({ ok: true, events: store.eventsBy(String(uid || ''), Number(limit) || 100) }),

    find: ({ type }) => ({ ok: true, items: store.find(String(type || '')) }),

    parked: () => ({ ok: true, parked: store.parked() }),

    version: ({ version }) => ({ ok: true, roots: store.itemsOfVersion(Number(version) || 0) }),

    rollback: ({ id, version, admin }) => {
      const r = store.rollback(String(id || ''), Number(version), { admin });
      if (!r.ok) return r;
      dropCache(String(id));
      record('admin_rollback', String(id), admin, `to version ${Number(version)}, now ${r.version}`);
      return r;
    },

    unpark: ({ parked, admin }) => {
      const r = store.unparkOne(Number(parked));
      if (!r.ok) return r;
      dropCache(r.boxId);
      record('admin_unpark', r.boxId, admin, `parked ${Number(parked)} (${r.type}) back in version ${r.version}`);
      return r;
    },

    discard: ({ parked, admin }) => {
      const r = store.discardParked(Number(parked));
      if (!r.ok) return r;
      record('admin_discard', r.boxId, admin, `parked ${Number(parked)} (${r.type}) thrown away`);
      return r;
    },

    give: ({ id, type, qty, admin }) => {
      const r = store.give(String(id || ''), String(type || ''), Number(qty) || 0, { admin });
      if (!r.ok) return r;
      dropCache(String(id));
      record('admin_give', String(id), admin, `${type} x${Number(qty) || 0}, version ${r.version}`);
      return r;
    },

    empty: ({ id, admin }) => {
      const r = store.empty(String(id || ''), { admin });
      if (!r.ok) return r;
      dropCache(String(id));
      record('admin_empty', String(id), admin, `version ${r.version}`);
      return r;
    },

    close: ({ id, admin }) => live('close', id, admin),
    remove: ({ id, admin }) => live('remove', id, admin),
    report: ({ id, admin }) => live('report', id, admin),

    result: ({ ref }) => ({ ok: true, result: store.resultOf(String(ref || '')) }),
  };
}
