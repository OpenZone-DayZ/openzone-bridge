// The admin side of the storage (design 2026-09-19, sections 4.4, 4.5, 8):
// what the console and, later, the web may do. Reads come from SQL; a change
// of a version works on a closed box, drops its cache so the next open
// rebuilds it, and leaves an event with the admin's name; a live command is
// pushed into the game's poll and the engine answers with an admin_result
// event that carries the command's ref.

import { randomBytes } from 'node:crypto';
import { stampNow } from './storage-wire.js';

// The difference between two versions as classes, counted: what a rollback
// from `a` to `b` makes disappear and appear. Every node of every root
// counts, not only the roots, so a pouch that lost its contents shows them.
export function diffRoots(aRoots, bRoots) {
  const count = (roots) => {
    const m = new Map();
    for (const r of roots) for (const n of r.nodes) m.set(n.type, (m.get(n.type) || 0) + 1);
    return m;
  };
  const a = count(aRoots);
  const b = count(bRoots);
  const gone = [];
  const came = [];
  for (const [type, n] of a) if (n > (b.get(type) || 0)) gone.push({ type, n: n - (b.get(type) || 0) });
  for (const [type, n] of b) if (n > (a.get(type) || 0)) came.push({ type, n: n - (a.get(type) || 0) });
  const byType = (x, y) => (x.type < y.type ? -1 : x.type > y.type ? 1 : 0);
  return { gone: gone.sort(byType), came: came.sort(byType) };
}

// The cargo of a box in cells, out of the server's class sizes (the core's
// dump): every root in the cargo by its item's width times height -- an
// item turned on its side covers the same count -- against the box's own
// cargo size. A class the dump does not size counts as one cell and is
// reported as unknown; a box class it does not size falls back to the
// series' three boxes.
const FALLBACK_CARGO = { oz_storagebox_small: 250, oz_storagebox_medium: 500, oz_storagebox_large: 1000 };
export function cellsOf(boxClass, items, sizes) {
  const cls = String(boxClass || '').toLowerCase();
  const own = sizes ? sizes.get(cls) : null;
  const max = own && own.cw && own.ch ? own.cw * own.ch : (FALLBACK_CARGO[cls] || 0);
  let used = 0;
  let unknown = 0;
  for (const it of items) {
    if (it.parent !== -1 || it.loc_type !== 3) continue;
    const sz = sizes ? sizes.get(String(it.type).toLowerCase()) : null;
    if (sz && sz.w && sz.h) used += sz.w * sz.h;
    else {
      used += 1;
      unknown++;
    }
  }
  return { used, max, unknown };
}

// The cells each ROOT of a box costs, by root index. cellsOf adds these up;
// a restore that cannot move everything needs them one by one. A root that
// is not in the cargo (attached in a slot) costs the cargo nothing.
export function rootCells(items, sizes) {
  const per = new Map();
  for (const it of items) {
    if (it.parent !== -1) continue;
    if (it.loc_type !== 3) {
      per.set(it.root_idx, 0);
      continue;
    }
    const sz = sizes ? sizes.get(String(it.type).toLowerCase()) : null;
    per.set(it.root_idx, sz && sz.w && sz.h ? sz.w * sz.h : 1);
  }
  return per;
}

export function storageAdmin({ store, xchg, push, health, sizes = null }) {
  // The class sizes of the chosen server, else of the first that runs
  // storage: what the core dumped at its start (core-classes.js).
  function sizesFor(server) {
    if (!sizes) return null;
    const sid = String(server || '');
    if (sid) return sizes(sid);
    const list = health ? (health().servers || []) : [];
    const srv = list.find((x) => x.kinds && x.kinds.storage) || list[0];
    return srv ? sizes(srv.id) : null;
  }

  // Was a box in the world when the chosen server last started? The boot
  // letter names every box the engine has and each is stamped seen at
  // that moment (index.js takes the kind's time just before), so a box
  // last seen before the storage boot was not there: gone, or the world
  // reset. 'unknown' before any boot the bridge saw. The chosen server,
  // else the first that booted storage.
  function inWorld(server) {
    const servers = health ? (health().servers || []) : [];
    const sid = String(server || '');
    const srv = (sid && servers.find((x) => x.id === sid)) || servers.find((x) => x.kinds && x.kinds.storage) || null;
    const boot = srv && srv.kinds && srv.kinds.storage ? stampNow(new Date(srv.kinds.storage)) : '';
    return (b) => ({ ...b, in_world: boot ? (b.last_seen_at >= boot ? 'yes' : 'no') : 'unknown', world_boot: boot });
  }

  const bad = (why) => ({ ok: false, why });
  const limitOf = (v) => Math.min(1000, Math.max(1, Math.trunc(Number(v)) || 100));
  const dropCache = (id) => {
    if (xchg) xchg.dropCache(id);
  };
  const record = (kind, boxId, admin, note) => {
    store.events([{ at: stampNow(), kind, box: boxId, admin: String(admin || ''), note }], 'admin');
  };
  // For the ops that CHANGE a box: a removed box is not a target, and
  // neither is one SQL never heard of.
  const known = (id) => {
    const box = store.boxOf(String(id || ''));
    if (!box || box.status === 'removed') return null;
    return box;
  };

  // For the ops that only READ one. A removed box IS the archive -- its
  // versions, items and events are kept on purpose -- so reading it is the
  // whole point of keeping the row. Sharing the write gate answered
  // 'unknown box' for a box whose id, class, 853 items and version 3356 the
  // list beside it was printing at that very moment (owner, 2026-09-22).
  const archived = (id) => store.boxOf(String(id || '')) || null;

  // The one rule that lets SQL decide a box's fate by itself: the server did
  // not have it at its last boot. Anything else belongs to the game.
  function absent(box, server) {
    const seen = inWorld(server)(box);
    if (seen.in_world === 'no') return { boot: seen.world_boot, why: '' };
    return {
      boot: seen.world_boot,
      why: seen.in_world === 'yes'
        ? 'the box is in the world; {live} it with the live command instead'
        : 'no server has booted storage yet, so the world cannot be asked; try once one has',
    };
  }

  function live(cmd, id, admin) {
    if (!known(id)) return bad('unknown box');
    if (!push) return bad('no live channel');
    const ref = randomBytes(6).toString('hex');
    push({ cmd, id: String(id), by: String(admin || 'admin'), token: ref });
    record(`admin_${cmd}`, String(id), admin, `ref ${ref}`);
    return { ok: true, ref };
  }

  return {
    // Every box, each with whether the chosen server had it in the world at
    // its last boot.
    boxes: ({ server } = {}) => ({ ok: true, boxes: store.boxes().map(inWorld(server)) }),

    box: ({ id, server }) => {
      const box = archived(id);
      if (!box) return bad('unknown box');
      const items = store.itemsOf(box.box_id);
      return { ok: true, box: { ...inWorld(server)(box), cells: cellsOf(box.class, items, sizesFor(server)) }, items, versions: store.versionsOf(box.box_id, 20) };
    },

    history: ({ id, limit }) => {
      const box = archived(id);
      if (!box) return bad('unknown box');
      const n = limitOf(limit);
      return { ok: true, events: store.eventsOf(box.box_id, n), versions: store.versionsOf(box.box_id, n) };
    },

    player: ({ uid, limit }) => ({ ok: true, events: store.eventsBy(String(uid || ''), limitOf(limit)) }),

    find: ({ type }) => ({ ok: true, items: store.find(String(type || '')), last: store.lastTake(String(type || '')) }),

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

    // A give the box has no cells for is refused here, before a version is
    // made: the game would only park the item at the next open.
    give: ({ id, type, qty, admin, server }) => {
      const box = known(id);
      if (box && box.status === 'closed') {
        const map = sizesFor(server);
        const sz = map ? map.get(String(type || '').toLowerCase()) : null;
        if (sz && sz.w && sz.h) {
          const c = cellsOf(box.class, store.itemsOf(box.box_id), map);
          if (c.max > 0 && c.used + sz.w * sz.h > c.max) return bad(`no room: ${c.max - c.used} cell(s) free, ${type} needs ${sz.w}×${sz.h}`);
        }
      }
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

    diff: ({ a, b }) => {
      const av = Number(a) || 0;
      const bv = Number(b) || 0;
      return { ok: true, a: av, b: bv, ...diffRoots(store.itemsOfVersion(av), store.itemsOfVersion(bv)) };
    },

    // A root of a closed box onto the shelf: parked with the reason admin,
    // its bytes intact, to be returned or thrown away later.
    shelve: ({ id, root, admin }) => {
      const box = known(id);
      if (!box) return bad('unknown box');
      if (box.status !== 'closed') return bad('the box is open; close it first');
      const idx = Number(root);
      if (!Number.isInteger(idx) || idx < 0) return bad('bad root index');
      const r = store.park({ boxId: box.box_id, rootIdx: idx, reason: 'admin', note: `shelved by ${admin || 'admin'}` });
      if (!r) return bad('no such root of this box');
      dropCache(box.box_id);
      record('admin_shelve', box.box_id, admin, `root ${idx} (${r.type}) to the shelf as parked ${r.parked}, version ${r.version}`);
      return { ok: true, ...r };
    },

    move: ({ from, root, to, admin }) => {
      const r = store.moveRoot(String(from || ''), Number(root), String(to || ''), { admin });
      if (!r.ok) return r;
      dropCache(String(from));
      dropCache(String(to));
      record('admin_move', String(from), admin, `${r.type} to ${to}, version ${r.fromVersion}`);
      record('admin_move', String(to), admin, `${r.type} from ${from}, version ${r.toVersion}`);
      return r;
    },

    // Un-archiving. The cargo of a deleted box poured into one that exists:
    // the admin names the target, and its next open carries everything. The
    // room is checked here, before a version is made, for the same reason a
    // give is -- what does not fit would only be parked at the open.
    restore: ({ id, to, admin, server }) => {
      const from = archived(id);
      if (!from) return bad('unknown box');
      const target = known(to);
      if (!target) return bad('unknown target box');
      // As many roots as the target has cells for, in order; the rest stay
      // where they are and go into the next box. A box filled when the
      // classes gave it more cells than they do today holds more than any
      // one of today's boxes can take, and all-or-nothing would strand it
      // for good.
      let take = null;
      const map = sizesFor(server);
      if (map) {
        const have = cellsOf(target.class, store.itemsOf(target.box_id), map);
        const per = rootCells(store.itemsOf(from.box_id), map);
        if (have.max > 0) {
          let free = have.max - have.used;
          take = [];
          for (const [idx, cost] of [...per].sort((a, b) => a[0] - b[0])) {
            if (cost > free) continue;
            free -= cost;
            take.push(idx);
          }
          if (take.length === 0) {
            const smallest = Math.min(...[...per.values()]);
            return bad(`no room: ${have.max - have.used} cell(s) free in the target, its smallest root needs ${smallest}`);
          }
        }
      }
      const r = store.restoreBox(String(id || ''), String(to || ''), { admin, take });
      if (!r.ok) return r;
      dropCache(String(id));
      dropCache(String(to));
      const rest = r.left ? `, ${r.left} left` : '';
      record('admin_restore', String(id), admin, `${r.roots} root(s) into ${to}, version ${r.fromVersion}${rest}`);
      record('admin_restore', String(to), admin, `${r.roots} root(s) from ${id}, version ${r.toVersion}`);
      return r;
    },

    // A box SQL believes open that the world does not have. Every operation
    // that writes refuses an open box, and the only road to closing one runs
    // through the game -- which cannot answer for a box it does not have. So
    // the cargo of a box that vanished while open is walled in, with no way
    // out at all. This is that way out, and it is allowed for exactly the
    // case that makes it safe: the server did not report the box at its last
    // boot, so no one in the game can be looking inside it. A box that IS in
    // the world keeps the game as the only authority -- use the live close.
    markClosed: ({ id, admin, server }) => {
      const box = known(id);
      if (!box) return bad('unknown box');
      if (box.status !== 'open') return bad('the box is not open');
      const gone = absent(box, server);
      if (gone.why) return bad(gone.why.replace('{live}', 'close'));
      if (!store.markClosed(String(id || ''))) return bad('unknown box');
      dropCache(String(id));
      record('admin_mark_closed', String(id), admin, `stuck open, absent from the world since ${gone.boot}`);
      return { ok: true, status: 'closed' };
    },

    // Archiving a box the world lost. The live remove deletes an entity and
    // then writes this down; for a box the game no longer has there is no
    // entity to delete, so that road ends in silence and the box sits in the
    // live list for ever. This writes it down on its own.
    //
    // Nothing is thrown away: archiving is a status, and the versions, items
    // and events stay exactly as restore will want them. It works whatever
    // shape the box is stuck in, open included, since a removed box is no
    // longer an open one. The same rule guards it: only a box the server did
    // not report at its last boot. One that IS there must really be deleted,
    // by the live remove, or SQL would lie about a box players can still open.
    markRemoved: ({ id, admin, server }) => {
      const box = known(id);
      if (!box) return bad('unknown box');
      const gone = absent(box, server);
      if (gone.why) return bad(gone.why.replace('{live}', 'remove'));
      store.removed(String(id || ''));
      dropCache(String(id));
      record('admin_mark_removed', String(id), admin, `was ${box.status}, absent from the world since ${gone.boot}`);
      return { ok: true, status: 'removed' };
    },

    edit: ({ id, root, node, quantity, health: hp, reset, admin }) => {
      const doReset = reset === true || reset === 1 || reset === 'true' || reset === '1';
      const r = store.editNode(String(id || ''), Number(root), Number(node), { quantity, health: hp, reset: doReset }, { admin });
      if (!r.ok) return r;
      dropCache(String(id));
      record('admin_edit', String(id), admin, `${r.type}${r.reset ? ', state reset' : ''}: quantity ${quantity ?? '-'}, health ${hp ?? '-'}, version ${r.version}`);
      return r;
    },

    // The bridge's own state for the health page: what index.js knows
    // (the exchange directory, the database, the servers, the clean-up) plus
    // the boxes SQL believes open -- a live open, or a transition cut short.
    health: () => ({
      ok: true,
      ...(health ? health() : {}),
      open: store.boxes().filter((b) => b.status === 'open').map((b) => ({ box_id: b.box_id, class: b.class, last_seen_at: b.last_seen_at })),
    }),

    close: ({ id, admin }) => live('close', id, admin),
    remove: ({ id, admin }) => live('remove', id, admin),
    report: ({ id, admin }) => live('report', id, admin),

    result: ({ ref }) => ({ ok: true, result: store.resultOf(String(ref || '')) }),

    journal: ({ limit, server }) => ({ ok: true, events: store.journal(limitOf(limit), String(server || '')) }),

    // The game servers the bridge has heard from, for the site's switch.
    servers: () => ({ ok: true, servers: health ? (health().servers || []) : [] }),
  };
}
