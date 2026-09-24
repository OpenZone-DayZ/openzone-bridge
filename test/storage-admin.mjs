// The admin side of the storage (design 2026-09-19, sections 4.4, 4.5, 8):
// what an admin may do to a closed box through SQL, and how a live command
// reaches the game's poll. Offline, throwaway database and directory.

import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { StorageStore } from '../src/storage-store.js';
import { Xchg } from '../src/storage-xchg.js';
import { storageAdmin, diffRoots } from '../src/storage-admin.js';
import { buildChunk, parseChunk } from '../src/storage-wire.js';

const path = join(tmpdir(), `oz-storage-admin-${process.pid}.sqlite`);
for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) unlinkSync(f);
const dir = mkdtempSync(join(tmpdir(), 'oz-admin-xchg-'));

let pass = 0;
let fail = 0;
function ok(what, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass++;
    console.log(`  ok   ${what}`);
    return;
  }
  fail++;
  console.log(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
}

const BOX = '-1836652215-591616390-994303877-1955932247';
const paper = (row, col) => ({ parent: -1, type: 'Paper', locType: 3, slot: -1, row, col, flip: 0, health: 15, quantity: 1, liquid: 0, ammo: 0, hasBlob: 1 });
const pouch = [
  { parent: -1, type: 'PlateCarrierPouches', locType: 3, slot: -1, row: 2, col: 4, flip: 0, health: 100, quantity: 0, liquid: 0, ammo: 0, hasBlob: 1 },
  { parent: 0, type: 'SmallProtectorCase', locType: 3, slot: -1, row: 0, col: 0, flip: 0, health: 100, quantity: 0, liquid: 0, ammo: 0, hasBlob: 1 },
];
const header = (stamp) => ({ stamp, boxClass: 'OZ_StorageBox_Large', saveVer: 142 });

const base = new Store(path);
const s = new StorageStore(base);
const c0 = buildChunk([paper(0, 0)], Buffer.from('aa', 'hex'));
const c1 = buildChunk(pouch, Buffer.from('bb', 'hex'));
s.ingestClose({ boxId: BOX, header: header('2026-09-19 07:00:00'), chunks: [c0, c1], at: '2026-09-19 07:00:01' });

console.log('store: the admin operations');

ok('boxes lists the box with the roots of its current version', s.boxes().map((b) => [b.box_id, b.status, b.roots]), [[BOX, 'closed', 2]]);

const parked = s.park({ boxId: BOX, rootIdx: 1, reason: 'admin', at: '2026-09-19 07:01:00' });
ok('a parked root can be returned one by one', s.unparkOne(parked.parked, '2026-09-19 07:02:00'), { ok: true, version: 3, boxId: BOX, type: 'PlateCarrierPouches' });
ok('and comes back unplaced', parseChunk(s.currentChunks(BOX).chunks[1]).nodes[0].row, -1);
ok('returning it twice is refused', s.unparkOne(parked.parked), { ok: false, why: 'already returned' });
ok('an unknown parked id is refused', s.unparkOne(99), { ok: false, why: 'no such parked root' });

const parked2 = s.park({ boxId: BOX, rootIdx: 0, reason: 'admin', at: '2026-09-19 07:03:00' });
s.markOpen(BOX);
ok('an open box takes no parked root back', s.unparkOne(parked2.parked), { ok: false, why: 'the box is open; close it first' });
s.markClosed(BOX);
ok('a parked root can be thrown away', s.discardParked(parked2.parked), { ok: true, boxId: BOX, type: 'Paper' });
ok('and is gone from the parked list', s.parked(BOX).length, 0);
ok('throwing away twice is refused', s.discardParked(parked2.parked), { ok: false, why: 'no such parked root' });

const given = s.give(BOX, 'Rag', 3, { at: '2026-09-19 07:04:00', admin: 'owner' });
ok('give makes a new version with one more root', [given.ok, given.version, s.currentChunks(BOX).roots], [true, 5, 2]);
const gift = parseChunk(s.currentChunks(BOX).chunks[1]).nodes[0];
ok('the gift has no body, no cell, the quantity and a default health of -1', [gift.type, gift.hasBlob, gift.row, gift.col, gift.quantity, gift.health], ['Rag', 0, -1, -1, 3, -1]);
ok('the gift is indexed', s.find('Rag').length, 1);
ok('a bad class name is refused', s.give(BOX, 'Rag; DROP', 1), { ok: false, why: 'bad class name' });
ok('an unknown box is refused', s.give('1-2-3-4', 'Rag', 1), { ok: false, why: 'unknown box' });
ok('the version notes who gave what', s.versionsOf(BOX)[0].note, 'give Rag by owner');

ok('empty makes a version with no roots', s.empty(BOX, { at: '2026-09-19 07:05:00', admin: 'owner' }), { ok: true, version: 6 });
ok('and the box has none', [s.currentChunks(BOX).roots, s.itemsOf(BOX).length], [0, 0]);
s.markOpen(BOX);
ok('an open box cannot be emptied through SQL', s.empty(BOX), { ok: false, why: 'the box is open; close it first' });
s.markClosed(BOX);

s.events([{ at: '2026-09-19 07:06:00', kind: 'admin_result', box: BOX, name: 'owner', note: 'abc123abc123: ok CLOSED entities=0' }], 'stand');
ok('resultOf finds the answer by its ref', s.resultOf('abc123abc123').note, 'abc123abc123: ok CLOSED entities=0');
ok('resultOf of an unknown ref is null', s.resultOf('nope'), null);

console.log('admin ops');

const pushed = [];
const x = new Xchg(dir);
const admin = storageAdmin({ store: s, xchg: x, push: (o) => pushed.push(o) });

s.ingestClose({ boxId: BOX, header: header('2026-09-19 07:10:00'), chunks: [c0, c1], at: '2026-09-19 07:10:01' });
writeFileSync(x.cachePath(BOX), 'cache');
ok('boxes', admin.boxes().boxes.map((b) => b.box_id), [BOX]);
ok('box', Object.keys(admin.box({ id: BOX })).sort(), ['box', 'items', 'ok', 'versions']);
ok('box of an unknown id', admin.box({ id: '9-9-9-9' }), { ok: false, why: 'unknown box' });
ok('find', admin.find({ type: 'Paper' }).items.length, 1);
ok('parked', admin.parked().parked.length, 0);
ok('history answers events and versions', Object.keys(admin.history({ id: BOX })).sort(), ['events', 'ok', 'versions']);
ok('history of an unknown box is refused', admin.history({ id: '9-9-9-9' }), { ok: false, why: 'unknown box' });
ok('player answers events', admin.player({ uid: 'nobody' }), { ok: true, events: [] });
ok('a fractional limit is coerced, not thrown', admin.history({ id: BOX, limit: 1.5 }).ok, true);

const target = s.versionsOf(BOX).find((v) => v.roots === 0).id;
const rb = admin.rollback({ id: BOX, version: target, admin: 'owner' });
ok('rollback answers the new version', [rb.ok, rb.version > target], [true, true]);
ok('rollback drops the cache', existsSync(x.cachePath(BOX)), false);
ok('rollback is an event with the admin', s.eventsOf(BOX)[0].kind + ' ' + s.eventsOf(BOX)[0].admin, 'admin_rollback owner');
ok('rollback to another own version succeeds', admin.rollback({ id: BOX, version: 1, admin: 'owner' }).ok, true);

const g = admin.give({ id: BOX, type: 'Rag', qty: 2, admin: 'owner' });
ok('give', [g.ok, s.currentChunks(BOX).roots], [true, 3]);
ok('give is an event', s.eventsOf(BOX)[0].kind, 'admin_give');
const p = s.park({ boxId: BOX, rootIdx: 0, reason: 'admin', at: '2026-09-19 07:11:00' });
ok('unpark by id', admin.unpark({ parked: p.parked, admin: 'owner' }).ok, true);
const p2 = s.park({ boxId: BOX, rootIdx: 0, reason: 'admin', at: '2026-09-19 07:12:00' });
ok('discard by id', admin.discard({ parked: p2.parked, admin: 'owner' }), { ok: true, boxId: BOX, type: 'PlateCarrierPouches' });
ok('empty', admin.empty({ id: BOX, admin: 'owner' }).ok, true);
ok('version lists the roots of any version', admin.version({ version: target + 1 }).roots.length > 0, true);

const live = admin.close({ id: BOX, admin: 'owner' });
ok('a live command is pushed with a ref', [live.ok, live.ref.length, pushed.length, pushed[0].cmd, pushed[0].id, pushed[0].by, pushed[0].token === live.ref], [true, 12, 1, 'close', BOX, 'owner', true]);
ok('a live command is an event', s.eventsOf(BOX)[0].kind, 'admin_close');
ok('report and remove push too', [admin.report({ id: BOX, admin: 'owner' }).ok, admin.remove({ id: BOX, admin: 'owner' }).ok, pushed.length], [true, true, 3]);
ok('a live command on an unknown box is refused', admin.close({ id: '9-9-9-9', admin: 'owner' }), { ok: false, why: 'unknown box' });
ok('result of an unanswered ref is null', admin.result({ ref: live.ref }), { ok: true, result: null });
s.events([{ at: '2026-09-19 07:13:00', kind: 'admin_result', box: BOX, note: `${live.ref}: ok closing` }], 'stand');
ok('result of an answered ref is the event', admin.result({ ref: live.ref }).result.note, `${live.ref}: ok closing`);

console.log('store: move, edit, last take, keep preview');

const BOX2 = '1-2-3-4';
s.seen(BOX2, { class: 'OZ_StorageBox_Small', at: '2026-09-19 08:00:00' });
s.ingestClose({ boxId: BOX, header: header('2026-09-19 08:00:00'), chunks: [c0, c1], at: '2026-09-19 08:00:01' });
s.ingestClose({ boxId: BOX2, header: header('2026-09-19 08:00:00'), chunks: [c0], at: '2026-09-19 08:00:01' });
ok('boxes carries the roots and the entities of the current version', s.boxes().map((b) => [b.box_id, b.roots, b.entities]), [[BOX, 2, 3], [BOX2, 1, 1]]);

const mv = s.moveRoot(BOX, 1, BOX2, { at: '2026-09-19 08:01:00', admin: 'owner' });
ok('move takes a root out of one closed box into another', [mv.ok, mv.type, s.currentChunks(BOX).roots, s.currentChunks(BOX2).roots], [true, 'PlateCarrierPouches', 1, 2]);
ok('the moved root arrives unplaced, its body and its children intact', (() => {
  const p = parseChunk(s.currentChunks(BOX2).chunks[1]);
  return [p.nodes[0].row, p.nodes[0].col, p.nodes.length, p.nodes[0].hasBlob];
})(), [-1, -1, 2, 1]);
ok('both new versions say what happened', [s.versionsOf(BOX)[0].note, s.versionsOf(BOX2)[0].note], [`move PlateCarrierPouches to ${BOX2} by owner`, `move PlateCarrierPouches from ${BOX} by owner`]);
ok('the index of both boxes follows', [s.itemsOf(BOX).length, s.itemsOf(BOX2).length], [1, 3]);
ok('a move into the same box is refused', s.moveRoot(BOX, 0, BOX), { ok: false, why: 'the same box' });
ok('a move of a root that is not there is refused', s.moveRoot(BOX, 5, BOX2), { ok: false, why: 'no such root of this box' });
s.markOpen(BOX2);
ok('a move into an open box says which box is open', s.moveRoot(BOX, 0, BOX2), { ok: false, why: 'the target box is open; close it first' });
s.markClosed(BOX2);
s.markOpen(BOX);
ok('and a move out of an open box says the same of the source', s.moveRoot(BOX, 0, BOX2), { ok: false, why: 'the box is open; close it first' });
s.markClosed(BOX);
ok('a move into an unknown box is refused', s.moveRoot(BOX, 0, '9-9-9-9'), { ok: false, why: 'unknown target box' });
ok('a move out of an unknown box is refused', s.moveRoot('9-9-9-9', 0, BOX), { ok: false, why: 'unknown box' });

const BOX3 = '5-6-7-8';
s.seen(BOX3, { class: 'OZ_StorageBox_Small', at: '2026-09-19 08:01:30' });
ok('a move into a box that never had a version keeps the source\'s save version', [s.moveRoot(BOX2, 1, BOX3, { at: '2026-09-19 08:01:31' }).ok, s.versionsOf(BOX3)[0].save_version], [true, 142]);
s.empty(BOX3, { at: '2026-09-19 08:01:32' });
ok('a move into an emptied box does not inherit its zero save version', [s.moveRoot(BOX2, 0, BOX3, { at: '2026-09-19 08:01:33' }).ok, s.versionsOf(BOX3)[0].save_version], [true, 142]);

ok('a node with a body is not edited in place', s.editNode(BOX, 0, 0, { quantity: 2 }), { ok: false, why: 'the item carries mod state; reset it to edit' });
const ed = s.editNode(BOX, 0, 0, { quantity: 2, health: 50, reset: true }, { at: '2026-09-19 08:02:00', admin: 'owner' });
ok('with reset the edit is taken', [ed.ok, ed.reset, ed.type], [true, true, 'Paper']);
ok('the descriptor carries the edit and the body is gone', (() => {
  const c = s.currentChunks(BOX).chunks[0];
  const p = parseChunk(c);
  return [p.nodes[0].quantity, p.nodes[0].health, p.nodes[0].hasBlob, c.length - p.bodyOffset];
})(), [2, 50, 0, 0]);
ok('the version notes the reset and the admin', s.versionsOf(BOX)[0].note, 'edit Paper (state reset) by owner');
ok('the index follows the edit', [s.itemsOf(BOX)[0].quantity, s.itemsOf(BOX)[0].health, s.itemsOf(BOX)[0].has_blob], [2, 50, 0]);
ok('a bodiless node is edited in place, one field at a time', [s.editNode(BOX, 0, 0, { health: 20 }).ok, parseChunk(s.currentChunks(BOX).chunks[0]).nodes[0].quantity], [true, 2]);
ok('bad numbers are refused', [s.editNode(BOX, 0, 0, { quantity: -1 }).why, s.editNode(BOX, 0, 0, { health: 'x' }).why, s.editNode(BOX, 0, 0, {}).why], ['bad quantity', 'bad health', 'nothing to change']);
ok('an unknown node is refused', s.editNode(BOX, 0, 7, { quantity: 1 }), { ok: false, why: 'no such node of this root' });
ok('an unknown root is refused', s.editNode(BOX, 3, 0, { quantity: 1 }), { ok: false, why: 'no such root of this box' });
s.markOpen(BOX);
ok('an open box is not edited', s.editNode(BOX, 0, 0, { quantity: 1 }), { ok: false, why: 'the box is open; close it first' });
s.markClosed(BOX);

s.events([{ at: '2026-09-19 08:03:00', kind: 'take', box: BOX, uid: '7656', name: 'Stalker', type: 'Paper', qty: 1 }], 'stand');
ok('lastTake names who took the class last', [s.lastTake('Paper').uid, s.lastTake('Paper').name, s.lastTake('Paper').box_id], ['7656', 'Stalker', BOX]);
ok('lastTake of a class nobody took is null', s.lastTake('Rag'), null);

const preview = s.keepPreview({ versionsDays: 0, eventsDays: 0, now: new Date('2030-01-01T00:00:00Z') });
ok('keepPreview counts what keep would delete', [preview.versions > 0, preview.events > 0], [true, true]);
ok('and deletes nothing', s.versionsOf(BOX).length > 1, true);
ok('a far cut-off counts nothing', s.keepPreview({ versionsDays: 36500, eventsDays: 36500 }), { versions: 0, events: 0 });

s.ingestClose({ boxId: BOX, header: header('2026-09-19 08:04:00'), chunks: [c0, c1], at: '2026-09-19 08:04:01' });
const parked3 = s.park({ boxId: BOX, rootIdx: 1, reason: 'admin', at: '2026-09-19 08:04:02' });
s.empty(BOX, { at: '2026-09-19 08:04:03' });
ok('a parked root returned into an emptied box brings back the save version it was parked under', [s.unparkOne(parked3.parked, '2026-09-19 08:04:04').ok, s.versionsOf(BOX)[0].save_version], [true, 142]);

console.log('admin ops: the shelf, move, edit, diff, health');

const admin2 = storageAdmin({ store: s, xchg: x, push: (o) => pushed.push(o), health: () => ({ xchg: true, dbBytes: 1, servers: [], keep: { versions: 0, events: 0 }, auth: false }) });
s.ingestClose({ boxId: BOX, header: header('2026-09-19 09:00:00'), chunks: [c0, c1], at: '2026-09-19 09:00:01' });
s.ingestClose({ boxId: BOX2, header: header('2026-09-19 09:00:00'), chunks: [], at: '2026-09-19 09:00:01' });

const vX = s.currentChunks(BOX).version;
s.give(BOX, 'Rag', 1, { at: '2026-09-19 09:01:00' });
const vY = s.currentChunks(BOX).version;
ok('diff from the newer to the older version says what goes', admin2.diff({ a: vY, b: vX }), { ok: true, a: vY, b: vX, gone: [{ type: 'Rag', n: 1 }], came: [] });
ok('and the other way what comes', admin2.diff({ a: vX, b: vY }).came, [{ type: 'Rag', n: 1 }]);
ok('a version against itself differs in nothing', admin2.diff({ a: vX, b: vX }), { ok: true, a: vX, b: vX, gone: [], came: [] });
ok('diffRoots counts nested nodes too, sorted by class', diffRoots([{ rootIdx: 0, nodes: pouch }], []), { gone: [{ type: 'PlateCarrierPouches', n: 1 }, { type: 'SmallProtectorCase', n: 1 }], came: [] });
ok('diff of unknown versions is empty, not an error', admin2.diff({ a: 999, b: 998 }), { ok: true, a: 999, b: 998, gone: [], came: [] });

ok('find names who took the class last', admin2.find({ type: 'Paper' }).last.name, 'Stalker');
ok('find of a class nobody took has no last', admin2.find({ type: 'Rag' }).last, null);

writeFileSync(x.cachePath(BOX), 'cache');
const sh = admin2.shelve({ id: BOX, root: 1, admin: 'owner' });
ok('shelve parks a root of a closed box with the reason admin', [sh.ok, sh.type, s.parked(BOX)[0].reason, s.parked(BOX)[0].id === sh.parked], [true, 'PlateCarrierPouches', 'admin', true]);
ok('shelve drops the cache and is an event with the admin', [existsSync(x.cachePath(BOX)), s.eventsOf(BOX)[0].kind, s.eventsOf(BOX)[0].admin], [false, 'admin_shelve', 'owner']);
ok('shelve of a root that is not there is refused', admin2.shelve({ id: BOX, root: 9, admin: 'owner' }), { ok: false, why: 'no such root of this box' });
ok('shelve of a bad index is refused', admin2.shelve({ id: BOX, root: -1, admin: 'owner' }), { ok: false, why: 'bad root index' });
ok('shelve of an unknown box is refused', admin2.shelve({ id: '9-9-9-9', root: 0, admin: 'owner' }), { ok: false, why: 'unknown box' });
s.markOpen(BOX);
ok('shelve needs a closed box', admin2.shelve({ id: BOX, root: 0, admin: 'owner' }), { ok: false, why: 'the box is open; close it first' });
s.markClosed(BOX);

writeFileSync(x.cachePath(BOX), 'cache');
writeFileSync(x.cachePath(BOX2), 'cache');
const mv2 = admin2.move({ from: BOX, root: 0, to: BOX2, admin: 'owner' });
ok('move answers both versions and the type', [mv2.ok, mv2.type, typeof mv2.fromVersion, typeof mv2.toVersion], [true, 'Paper', 'number', 'number']);
ok('move drops both caches', [existsSync(x.cachePath(BOX)), existsSync(x.cachePath(BOX2))], [false, false]);
ok('move is an event on both boxes', [s.eventsOf(BOX)[0].kind, s.eventsOf(BOX2)[0].kind, s.eventsOf(BOX2)[0].admin], ['admin_move', 'admin_move', 'owner']);
ok('move refuses in the store\'s words', admin2.move({ from: BOX, root: 0, to: BOX, admin: 'owner' }), { ok: false, why: 'the same box' });

writeFileSync(x.cachePath(BOX2), 'cache');
ok('edit without reset on an item with a body is refused in the store\'s words', admin2.edit({ id: BOX2, root: 0, node: 0, quantity: 3, admin: 'owner' }), { ok: false, why: 'the item carries mod state; reset it to edit' });
ok('the refusal left the cache alone', existsSync(x.cachePath(BOX2)), true);
const e1 = admin2.edit({ id: BOX2, root: 0, node: 0, quantity: 3, reset: true, admin: 'owner' });
ok('edit with reset answers the version', [e1.ok, e1.reset, e1.type], [true, true, 'Paper']);
ok('edit drops the cache and is an event', [existsSync(x.cachePath(BOX2)), s.eventsOf(BOX2)[0].kind, s.eventsOf(BOX2)[0].note.includes('state reset')], [false, 'admin_edit', true]);
ok('edit takes reset as a string too', admin2.edit({ id: BOX2, root: 0, node: 0, health: 40, reset: 'true', admin: 'owner' }).ok, true);

const hl = admin2.health();
ok('health carries the bridge facts and the open boxes', [hl.ok, hl.xchg, hl.dbBytes, hl.auth, hl.open.length], [true, true, 1, false, 0]);
s.markOpen(BOX);
ok('an open box shows in health', admin2.health().open.map((b) => b.box_id), [BOX]);
s.markClosed(BOX);
ok('health without a health function still answers', admin.health().ok, true);

console.log('store: the save version of a version with bodies');

// (a) unparkPresent into an emptied box: a root parked as missing_class
// (by parkMissing) comes back once its classes are all present again, and
// the box it returns into has since been emptied (save_version 0) -- the
// box's own last known save version (142, from the original ingestClose)
// must survive the round trip.
s.ingestClose({ boxId: BOX, header: header('2026-09-19 10:00:00'), chunks: [c0, c1], at: '2026-09-19 10:00:01' });
s.parkMissing(['PlateCarrierPouches']);
s.empty(BOX, { at: '2026-09-19 10:00:02' });
const backA = s.unparkPresent(['PlateCarrierPouches', 'SmallProtectorCase'], '2026-09-19 10:00:03');
// Two, not one: the shelved root from the "admin ops" section above (never
// unparked) carries the same classes and is legitimately restored too.
ok('unparkPresent restores every root parked with these classes', [backA.unparked, backA.boxes], [2, [BOX]]);
ok('the box\'s new version keeps its last known save version, not the emptied box\'s zero', s.versionsOf(BOX)[0].save_version, 142);
ok('and the root is back', parseChunk(s.currentChunks(BOX).chunks.at(-1)).nodes[0].type, 'PlateCarrierPouches');

// (b) unparkOne whose origin version was purged (by keep(), simulated here
// by deleting it directly): the save version is found on an older
// surviving version of the same box instead.
s.ingestClose({ boxId: BOX, header: header('2026-09-19 10:01:00'), chunks: [c0, c1], at: '2026-09-19 10:01:01' });
const fromVersion = s.currentChunks(BOX).version;
const parkedB = s.park({ boxId: BOX, rootIdx: 1, reason: 'admin', at: '2026-09-19 10:01:02' });
s.db.prepare('DELETE FROM storage_versions WHERE id = ?').run(fromVersion);
s.db.prepare('DELETE FROM storage_roots WHERE version_id = ?').run(fromVersion);
s.empty(BOX, { at: '2026-09-19 10:01:03' });
const backB = s.unparkOne(parkedB.parked, '2026-09-19 10:01:04');
ok('unparkOne whose origin version was purged still succeeds', backB.ok, true);
ok('its save version is found on an older surviving version of the box', s.versionsOf(BOX)[0].save_version, 142);

console.log('cells and give against the server\'s sizes');

{
  // The sizes the core's dump gives (core-classes.js): the box, one small
  // item, one that never fits.
  const sizes = () => new Map([
    ['oz_storagebox_large', { w: 10, h: 5, cw: 10, ch: 150 }],
    ['apple', { w: 1, h: 1, cw: 0, ch: 0 }],
    ['tent', { w: 10, h: 150, cw: 0, ch: 0 }],
  ]);
  const sized = storageAdmin({ store: s, xchg: x, push: (o) => pushed.push(o), health: () => ({ servers: [{ id: 'stand', at: '', since: '', kinds: { storage: '2026-09-20T00:00:00Z' } }] }), sizes });
  const before = sized.box({ id: BOX }).box.cells;
  ok('the box page counts the cargo in cells against the box\'s own cargo, unsized items as one', [before.max, before.used > 0, before.unknown > 0], [1500, true, true]);
  ok('a give that fits is made', sized.give({ id: BOX, type: 'Apple', qty: 0, admin: 'tester' }).ok, true);
  ok('and the count grew by its size', sized.box({ id: BOX }).box.cells.used, before.used + 1);
  ok('a give with no room is refused before any version', [sized.give({ id: BOX, type: 'Tent', qty: 0, admin: 'tester' }).why.startsWith('no room:'), sized.box({ id: BOX }).box.cells.used], [true, before.used + 1]);
  ok('an unsized class is given (the game decides at the open)', sized.give({ id: BOX, type: 'Mystery', qty: 0, admin: 'tester' }).ok, true);
  ok('without sizes nothing is refused', storageAdmin({ store: s, xchg: x, push: () => {}, health: () => ({ servers: [] }) }).give({ id: BOX, type: 'Tent', qty: 0, admin: 'tester' }).ok, true);
}

console.log('a deleted box is still readable');

{
  // The archive. Removing a box keeps every row it had; the only thing that
  // changes is the status. Reading it was gated behind the same check the
  // WRITING operations use, so the page answered 'unknown box' for a box the
  // list beside it was printing in full (owner, 2026-09-22).
  const GONE = '-777-777-777-777';
  s.ingestClose({ boxId: GONE, header: header('2026-09-19 10:00:00'), chunks: [c0, c1], at: '2026-09-19 10:00:01' });
  const versionsBefore = s.versionsOf(GONE, 20).length;
  s.removed(GONE, '2026-09-19 10:05:00');

  const read = admin.box({ id: GONE });
  ok('the box page opens a deleted box', [read.ok, read.box.status, read.items.length > 0], [true, 'removed', true]);
  ok('and keeps every version it had', admin.box({ id: GONE }).versions.length, versionsBefore);
  ok('its history opens too', admin.history({ id: GONE }).ok, true);
  ok('an id SQL never saw is still unknown', admin.box({ id: '9-9-9-9' }), { ok: false, why: 'unknown box' });

  // Writing to it stays refused: there is no entity in the game to change.
  ok('but nothing can be given to it', admin.give({ id: GONE, type: 'Rag', qty: 1, admin: 'tester' }).ok, false);
  ok('and no root can be shelved off it', admin.shelve({ id: GONE, root: 0, admin: 'tester' }), { ok: false, why: 'unknown box' });
}

console.log('versions belong to one box');

{
  // Version ids come from one sequence for the whole database, so two boxes
  // interleave in the numbering -- but every version carries the box it was
  // made for, and nothing crosses. A rollback never rewinds: it writes a NEW
  // version holding what the old one held, so the history only grows.
  const ONE = '-201-201-201-201';
  const TWO = '-202-202-202-202';
  s.ingestClose({ boxId: ONE, header: header('2026-09-19 12:00:00'), chunks: [c0], at: '2026-09-19 12:00:01' });
  s.ingestClose({ boxId: TWO, header: header('2026-09-19 12:00:00'), chunks: [c0, c1], at: '2026-09-19 12:00:01' });
  const oneV1 = s.boxOf(ONE).current_version;
  const twoV1 = s.boxOf(TWO).current_version;

  s.give(ONE, 'Rag', 1, { at: '2026-09-19 12:01:00' });
  const oneV2 = s.boxOf(ONE).current_version;
  ok('a version of one box is not a version of the other', s.rollback(TWO, oneV2, { admin: 'tester' }), { ok: false, why: 'no such version of this box' });

  const twoRootsBefore = s.currentChunks(TWO).chunks.length;
  const back = s.rollback(ONE, oneV1, { admin: 'tester' });
  ok('rolling one box back succeeds', back.ok, true);
  ok('and writes a new version rather than rewinding', back.version > oneV2, true);
  ok('the rolled box holds what that version held', s.currentChunks(ONE).chunks.length, 1);
  ok('the other box does not move', [s.boxOf(TWO).current_version, s.currentChunks(TWO).chunks.length], [twoV1, twoRootsBefore]);
  ok('nor does its index', s.itemsOf(TWO).length, 3);
  ok('and the version it was rolled back FROM is still there', s.versionsOf(ONE, 50).some((v) => v.id === oneV2), true);

  // The bytes of a root are shared between boxes by their hash, so the two
  // boxes above point at one blob row. That sharing must never let one box's
  // clean-up take bytes another still needs.
  const held = base.db.prepare('SELECT COUNT(DISTINCT v.box_id) n FROM storage_roots r JOIN storage_versions v ON v.id = r.version_id WHERE r.hash = ?');
  const hash = base.db.prepare('SELECT hash FROM storage_roots WHERE version_id = ?').get(twoV1).hash;
  ok('one blob is shared by both boxes', held.get(hash).n > 1, true);
  s.keep({ versionsDays: 0, eventsDays: 0, now: new Date('2027-01-01T00:00:00Z') });
  ok('a sweep keeps every box its current version', [s.currentChunks(ONE).chunks.length, s.currentChunks(TWO).chunks.length], [1, twoRootsBefore]);
  ok('and the shared bytes survive it', !!base.db.prepare('SELECT 1 FROM storage_blobs WHERE hash = ?').get(hash), true);
}

console.log('un-archiving a deleted box into a living one');

{
  // The engine's id never returns, so a restore always lands in another
  // box. The cargo MOVES: the archive is left holding nothing, or one
  // archive poured twice would mint items.
  const GONE2 = '-888-888-888-888';
  const HOME = '-999-999-999-999';
  s.ingestClose({ boxId: GONE2, header: header('2026-09-19 11:00:00'), chunks: [c0, c1], at: '2026-09-19 11:00:01' });
  s.ingestClose({ boxId: HOME, header: header('2026-09-19 11:00:00'), chunks: [c0], at: '2026-09-19 11:00:01' });
  const held = s.currentChunks(GONE2).chunks.length;
  s.removed(GONE2, '2026-09-19 11:01:00');

  ok('a restore needs a target that exists', admin.restore({ id: GONE2, to: 'no-such-box', admin: 'tester' }), { ok: false, why: 'unknown target box' });
  ok('and will not pour a box into itself', admin.restore({ id: GONE2, to: GONE2, admin: 'tester' }), { ok: false, why: 'unknown target box' });

  const before = s.currentChunks(HOME).chunks.length;
  const r = admin.restore({ id: GONE2, to: HOME, admin: 'tester' });
  ok('the archive is poured into the living box', [r.ok, r.roots], [true, held]);
  ok('which now holds what it had plus what came', s.currentChunks(HOME).chunks.length, before + held);
  ok('the archive is left with nothing', s.currentChunks(GONE2).chunks.length, 0);
  ok('and is still an archive, not a live box again', s.boxOf(GONE2).status, 'removed');
  ok('its deletion time is untouched', s.boxOf(GONE2).removed_at, '2026-09-19 11:01:00');
  ok('pouring the same archive twice gives nothing the second time', admin.restore({ id: GONE2, to: HOME, admin: 'tester' }), { ok: false, why: 'there is nothing in it to restore' });
  ok('both sides record who did it', [s.eventsOf(HOME)[0].kind, s.eventsOf(GONE2)[0].kind, s.eventsOf(HOME)[0].admin], ['admin_restore', 'admin_restore', 'tester']);
  ok('what it held before the restore is still readable', s.versionsOf(GONE2, 20).length > 1, true);

  // One root at a time out of an archive, the same way as between two
  // living boxes.
  const GONE3 = '-101-101-101-101';
  s.ingestClose({ boxId: GONE3, header: header('2026-09-19 11:10:00'), chunks: [c0, c1], at: '2026-09-19 11:10:01' });
  s.removed(GONE3, '2026-09-19 11:11:00');
  const one = admin.move({ from: GONE3, root: 0, to: HOME, admin: 'tester' });
  ok('a single root can be taken out of an archive', [one.ok, one.type], [true, 'Paper']);
  ok('the archive keeps the rest and stays deleted', [s.currentChunks(GONE3).chunks.length, s.boxOf(GONE3).status], [1, 'removed']);
  ok('a deleted box is never a target', admin.move({ from: HOME, root: 0, to: GONE3, admin: 'tester' }), { ok: false, why: 'unknown target box' });
}

console.log('recovering a box the world lost');

{
  // The general case the owner asked for: a box SQL still believes alive
  // that the server no longer has. Two things stand in the way -- a stale
  // open flag, and a box filled when its class gave it more cells than it
  // does now, so its cargo fits in no single box of today.
  const sizes = () => new Map([
    ['oz_storagebox_large', { w: 10, h: 5, cw: 10, ch: 4 }],   // 40 cells
    ['plate', { w: 5, h: 5, cw: 0, ch: 0 }],                   // 25 each
    ['paper', { w: 1, h: 1, cw: 0, ch: 0 }],
  ]);
  const boot = '2026-09-20T00:00:00Z';
  const rescue = storageAdmin({
    store: s, xchg: x, push: (o) => pushed.push(o), sizes,
    health: () => ({ servers: [{ id: 'stand', at: '', since: '', kinds: { storage: boot } }] }),
  });
  const plate = (n) => buildChunk([{ parent: -1, type: 'Plate', locType: 3, slot: -1, row: n, col: 0, flip: 0, health: 100, quantity: 0, liquid: 0, ammo: 0, hasBlob: 1 }], Buffer.from('cc', 'hex'));

  const LOST = '-301-301-301-301';
  const HOME1 = '-302-302-302-302';
  const HOME2 = '-303-303-303-303';
  // Three plates, 75 cells: more than a 40-cell box can take.
  s.ingestClose({ boxId: LOST, header: header('2026-09-19 13:00:00'), chunks: [plate(0), plate(1), plate(2)], at: '2026-09-19 13:00:01' });
  s.ingestClose({ boxId: HOME1, header: header('2026-09-21 13:00:00'), chunks: [], at: '2026-09-21 13:00:01' });
  s.ingestClose({ boxId: HOME2, header: header('2026-09-21 13:00:00'), chunks: [], at: '2026-09-21 13:00:01' });
  // The two homes were seen after the boot; the lost box was not.
  s.seen(HOME1, { at: '2026-09-21 13:00:01' });
  s.seen(HOME2, { at: '2026-09-21 13:00:01' });

  s.markOpen(LOST, '2026-09-19 13:00:02');
  ok('a stranded box stuck open cannot be poured out', rescue.restore({ id: LOST, to: HOME1, admin: 'tester' }), { ok: false, why: 'the box is open; close it first' });
  ok('the world says it is not there', rescue.box({ id: LOST, server: 'stand' }).box.in_world, 'no');
  ok('so SQL can be told to stop believing it open', rescue.unstick({ id: LOST, admin: 'tester', server: 'stand' }), { ok: true, status: 'closed' });
  ok('and it leaves a trace of who did it', s.eventsOf(LOST)[0].kind, 'admin_mark_closed');
  ok('doing it twice is refused', rescue.unstick({ id: LOST, admin: 'tester', server: 'stand' }), { ok: false, why: 'the box is not open' });
  s.markOpen(HOME1, '2026-09-21 13:00:01');
  ok('a box the world DOES have is left to the game', rescue.unstick({ id: HOME1, admin: 'tester', server: 'stand' }), { ok: false, why: 'the box is in the world; close it with the live command instead' });
  s.markClosed(HOME1);

  // 40 cells take one plate of 25; the other two stay for the next box.
  const first = rescue.restore({ id: LOST, to: HOME1, admin: 'tester' });
  ok('a restore moves what fits and says what is left', [first.ok, first.roots, first.left], [true, 1, 2]);
  ok('the target holds it', s.currentChunks(HOME1).chunks.length, 1);
  const second = rescue.restore({ id: LOST, to: HOME2, admin: 'tester' });
  ok('the next box takes the next one', [second.roots, second.left], [1, 1]);
  ok('a full target is refused with what it would need', rescue.restore({ id: LOST, to: HOME1, admin: 'tester' }).why, 'no room: 15 cell(s) free in the target, its smallest root needs 25');
  ok('and the last root is still waiting, not lost', s.currentChunks(LOST).chunks.length, 1);

  // Writing a stranded box off. The live remove deletes an entity and then
  // records it; with no entity there is nothing to delete, so SQL records it
  // alone -- and keeps every row, because that is what the archive is.
  const WRITEOFF = '-304-304-304-304';
  s.ingestClose({ boxId: WRITEOFF, header: header('2026-09-19 13:00:00'), chunks: [plate(0), plate(1)], at: '2026-09-19 13:00:01' });
  s.markOpen(WRITEOFF, '2026-09-19 13:00:02');
  ok('a stranded box is archived whatever shape it is stuck in', rescue.archive({ id: WRITEOFF, admin: 'tester', server: 'stand' }), { ok: true, status: 'removed' });
  ok('it keeps everything it held', [s.boxOf(WRITEOFF).status, s.currentChunks(WRITEOFF).chunks.length, s.itemsOf(WRITEOFF).length], ['removed', 2, 2]);
  ok('the page still opens it', rescue.box({ id: WRITEOFF, server: 'stand' }).ok, true);
  // A target with room of its own: HOME2 already took a plate above and has
  // 15 cells left, less than a plate needs.
  const HOME3 = '-305-305-305-305';
  s.ingestClose({ boxId: HOME3, header: header('2026-09-21 13:00:00'), chunks: [], at: '2026-09-21 13:00:01' });
  s.seen(HOME3, { at: '2026-09-21 13:00:01' });
  ok('and its cargo can still be poured out', rescue.restore({ id: WRITEOFF, to: HOME3, admin: 'tester' }).ok, true);
  ok('archiving it twice is refused', rescue.archive({ id: WRITEOFF, admin: 'tester', server: 'stand' }), { ok: false, why: 'unknown box' });
  s.markOpen(HOME1, '2026-09-21 13:00:01');
  ok('a box the world DOES have must really be deleted', rescue.archive({ id: HOME1, admin: 'tester', server: 'stand' }), { ok: false, why: 'the box is in the world; remove it with the live command instead' });
  s.markClosed(HOME1);
  const blind = storageAdmin({ store: s, xchg: x, push: () => {}, sizes, health: () => ({ servers: [] }) });
  ok('and with no boot to judge by, neither op guesses', [blind.archive({ id: HOME1, admin: 't' }).why, blind.unstick({ id: HOME1, admin: 't' }).why],
    ['no server has booted storage yet, so the world cannot be asked; try once one has', 'the box is not open']);
}

console.log('the four corners the owner asked about');

{
  const sizes = () => new Map([
    ['oz_storagebox_large', { w: 10, h: 5, cw: 10, ch: 4 }],
    ['paper', { w: 1, h: 1, cw: 0, ch: 0 }],
  ]);
  const boot = '2026-09-20T00:00:00Z';
  const withWorld = storageAdmin({
    store: s, xchg: x, push: () => {}, sizes,
    health: () => ({ servers: [{ id: 'stand', at: '', since: '', kinds: { storage: boot } }] }),
  });

  // 1. A target the world does not have either.
  const SRC = '-401-401-401-401';
  const LOSTTOO = '-402-402-402-402';
  const REAL = '-403-403-403-403';
  s.ingestClose({ boxId: SRC, header: header('2026-09-19 14:00:00'), chunks: [c0], at: '2026-09-19 14:00:01' });
  s.ingestClose({ boxId: LOSTTOO, header: header('2026-09-19 14:00:00'), chunks: [], at: '2026-09-19 14:00:01' });
  s.ingestClose({ boxId: REAL, header: header('2026-09-21 14:00:00'), chunks: [], at: '2026-09-21 14:00:01' });
  s.seen(REAL, { at: '2026-09-21 14:00:01' });
  ok('a restore into a box the world lost too is refused', withWorld.restore({ id: SRC, to: LOSTTOO, admin: 't', server: 'stand' }),
    { ok: false, why: 'the target is not in the world either; pick a box the server has' });
  ok('and into one the world has it goes', withWorld.restore({ id: SRC, to: REAL, admin: 't', server: 'stand' }).ok, true);

  // 2. An archived box the world has again.
  const RISEN = '-404-404-404-404';
  s.ingestClose({ boxId: RISEN, header: header('2026-09-19 14:00:00'), chunks: [c0, c1], at: '2026-09-19 14:00:01' });
  const heldVersion = s.boxOf(RISEN).current_version;
  s.removed(RISEN, '2026-09-19 14:05:00');
  const answer = s.boot([{ id: RISEN, class: 'OZ_StorageBox_Large', pos: '' }], '2026-09-21 14:00:01');
  ok('the boot brings it back rather than calling it none', answer.boxes[0], { id: RISEN, status: 'closed', version: heldVersion, roots: 2 });
  ok('it is a live box again, with its deletion time cleared', [s.boxOf(RISEN).status, s.boxOf(RISEN).removed_at], ['closed', '']);
  ok('the boot names which came back', answer.back, [RISEN]);
  ok('and leaves a trace of it', s.eventsOf(RISEN)[0].kind, 'back_in_world');

  // 3. No class dump at all: a root still cannot cost less than one cell.
  const blind = storageAdmin({ store: s, xchg: x, push: () => {}, health: () => ({ servers: [{ id: 'stand', at: '', since: '', kinds: { storage: boot } }] }) });
  const MANY = '-405-405-405-405';
  const SMALL = '-406-406-406-406';
  s.ingestClose({ boxId: MANY, header: header('2026-09-19 14:00:00'), chunks: Array.from({ length: 300 }, (_, i) => buildChunk([paper(i % 10, 0)], Buffer.from('dd', 'hex'))), at: '2026-09-19 14:00:01' });
  s.ingestClose({ boxId: SMALL, header: { stamp: '2026-09-21 14:00:00', boxClass: 'OZ_StorageBox_Small', saveVer: 142 }, chunks: [], at: '2026-09-21 14:00:01' });
  s.seen(SMALL, { class: 'OZ_StorageBox_Small', at: '2026-09-21 14:00:01' });
  const floor = blind.restore({ id: MANY, to: SMALL, admin: 't', server: 'stand' });
  ok('without sizes a restore still stops at the cargo the box has', [floor.ok, floor.roots, floor.left], [true, 250, 50]);

  // 4. A root named by a number that has since moved.
  const DRIFT = '-407-407-407-407';
  s.ingestClose({ boxId: DRIFT, header: header('2026-09-21 14:00:00'), chunks: [c0, c1], at: '2026-09-21 14:00:01' });
  s.seen(DRIFT, { at: '2026-09-21 14:00:01' });
  const drawn = s.boxOf(DRIFT).current_version;
  s.give(DRIFT, 'Rag', 1, { at: '2026-09-21 14:01:00' });
  const now = s.boxOf(DRIFT).current_version;
  const said = `the box moved on: you are looking at version ${drawn}, it is at ${now}. Reload and try again`;
  ok('a shelve from a page that has gone stale is refused', withWorld.shelve({ id: DRIFT, root: 0, admin: 't', version: drawn }), { ok: false, why: said });
  ok('so is a move', withWorld.move({ from: DRIFT, root: 0, to: REAL, admin: 't', version: drawn }), { ok: false, why: said });
  ok('so is an edit', withWorld.edit({ id: DRIFT, root: 0, node: 0, quantity: '2', admin: 't', version: drawn }), { ok: false, why: said });
  ok('with the version it really is at, the shelve goes through', withWorld.shelve({ id: DRIFT, root: 0, admin: 't', version: now }).ok, true);
  ok('and a caller that names no version is trusted as before', withWorld.shelve({ id: DRIFT, root: 0, admin: 't' }).ok, true);
}

console.log('a personal stash is a box with a pair for a key');

{
  // The stash's key carries the anchor and the owner (design 2026-09-23), so
  // the listing can show a `Whose` column without the boxes table growing one.
  const STASH = 's_11539x3377_76561198014475380';
  s.ingestClose({ boxId: STASH, header: { stamp: '2026-09-23 13:45:00', boxClass: 'OZ_PersonalStash', saveVer: 142 }, chunks: [buildChunk([paper(0, 0)], Buffer.from('cc', 'hex'))], at: '2026-09-23 13:45:01' });
  const a = storageAdmin({ store: s, xchg: new Xchg(dir) });
  const rows = a.boxes().boxes;
  const stash = rows.find((b) => b.box_id === STASH);
  const plain = rows.find((b) => b.box_id === BOX);
  ok('the stash is in the ordinary list', !!stash, true);
  ok('and it carries its anchor and its owner', [stash.kind, stash.anchor, stash.owner], ['stash', '11539x3377', '76561198014475380']);
  ok('a plain box carries neither', [plain.kind, plain.anchor, plain.owner], ['box', '', '']);
  ok('a stash opens like any other box', a.box({ id: STASH }).ok, true);
  ok('and its version history is its own', a.box({ id: STASH }).versions.length, 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
base.close();
rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
