// The storage tables (design 2026-09-19, section 4), offline against a
// throwaway SQLite file. A closed box's truth is a version: a list of root
// chunks kept byte for byte and deduplicated by hash, plus item rows of the
// current version for the queries. Touches neither Discord nor the stand.

import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { StorageStore } from '../src/storage-store.js';
import { buildChunk, parseChunk } from '../src/storage-wire.js';

const path = join(tmpdir(), `oz-storage-store-${process.pid}.sqlite`);
for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) unlinkSync(f);

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
const hex = (b) => Buffer.from(b).toString('hex');

const base = new Store(path);
const s = new StorageStore(base);

console.log('boot and close');

ok('an unknown box boots as none', s.boot([{ id: BOX, class: 'OZ_StorageBox_Large', state: 'CLOSED', entities: 0, pos: '4650 339 10400' }]),
  { boxes: [{ id: BOX, status: 'none', version: 0, roots: 0 }], classes: [], back: [] });
ok('boot remembers the box', [s.boxOf(BOX).class, s.boxOf(BOX).pos], ['OZ_StorageBox_Large', '4650 339 10400']);

const c0 = buildChunk([paper(0, 0)], Buffer.from('aa', 'hex'));
const c1 = buildChunk(pouch, Buffer.from('bbcc', 'hex'));
const c2 = buildChunk([paper(0, 0)], Buffer.from('aa', 'hex')); // identical to c0

const v1 = s.ingestClose({ boxId: BOX, header: header('2026-09-19 05:00:00'), chunks: [c0, c1, c2], by: '76561198000000001', why: 'player', at: '2026-09-19 05:00:01' });
ok('the first close is version 1 with three roots and four entities', v1, { version: 1, roots: 3, entities: 4 });
ok('the box is closed on version 1', [s.boxOf(BOX).status, s.boxOf(BOX).current_version], ['closed', 1]);
ok('identical roots share one blob', base.db.prepare('SELECT COUNT(*) AS n FROM storage_blobs').get().n, 2);

const cur = s.currentChunks(BOX);
ok('the current version returns the chunks byte for byte', cur.chunks.map(hex), [hex(c0), hex(c1), hex(c2)]);
ok('and the header fields', [cur.version, cur.stamp, cur.saveVer, cur.boxClass, cur.roots, cur.entities], [1, '2026-09-19 05:00:00', 142, 'OZ_StorageBox_Large', 3, 4]);

ok('item rows are indexed for the current version', s.itemsOf(BOX).map((i) => [i.root_idx, i.node_idx, i.parent, i.type, i.row, i.col]),
  [[0, 0, -1, 'Paper', 0, 0], [1, 0, -1, 'PlateCarrierPouches', 2, 4], [1, 1, 0, 'SmallProtectorCase', 0, 0], [2, 0, -1, 'Paper', 0, 0]]);
ok('find by type', s.find('SmallProtectorCase').map((i) => [i.box_id, i.root_idx, i.status]), [[BOX, 1, 'closed']]);
ok('boot now answers closed with the version', s.boot([{ id: BOX, class: '', state: 'CLOSED', entities: 0, pos: '' }]).boxes, [{ id: BOX, status: 'closed', version: 1, roots: 3 }]);
ok('boot lists the classes of every current version', s.boot([]).classes, ['Paper', 'PlateCarrierPouches', 'SmallProtectorCase']);

ok('markOpen', [s.markOpen(BOX, '2026-09-19 05:01:00'), s.boxOf(BOX).status], [true, 'open']);
ok('markOpen of an unknown box is false', s.markOpen('1-2-3-4'), false);

const v2 = s.ingestClose({ boxId: BOX, header: header('2026-09-19 05:02:00'), chunks: [c1], why: 'idle', at: '2026-09-19 05:02:01' });
ok('the second close is version 2', v2, { version: 2, roots: 1, entities: 2 });
ok('item rows follow the current version', s.itemsOf(BOX).map((i) => i.type), ['PlateCarrierPouches', 'SmallProtectorCase']);
ok('versions are listed newest first', s.versionsOf(BOX).map((v) => [v.id, v.source, v.roots]), [[2, 'close', 1], [1, 'close', 3]]);
ok('a past version is readable through its chunks', s.itemsOfVersion(1).map((r) => [r.rootIdx, r.nodes.map((n) => n.type)]),
  [[0, ['Paper']], [1, ['PlateCarrierPouches', 'SmallProtectorCase']], [2, ['Paper']]]);

const empty = s.ingestClose({ boxId: BOX, header: header('2026-09-19 05:03:00'), chunks: [], why: 'boot', at: '2026-09-19 05:03:01' });
ok('a close with no roots is a version too', [empty.version, empty.roots, s.versionsOf(BOX)[0].source], [3, 0, 'boot']);
ok('an empty current version has no item rows', s.itemsOf(BOX).length, 0);

s.cacheNote(BOX, '2026-09-19 05:03:00', 321);
ok('the cache note is kept on the box', [s.boxOf(BOX).cache_stamp, s.boxOf(BOX).cache_size], ['2026-09-19 05:03:00', 321]);

s.removed(BOX, '2026-09-19 05:04:00');
ok('a removed box leaves knownIds', s.knownIds(), []);
ok('but keeps its versions', s.versionsOf(BOX).length, 3);

console.log('parking');

const P = '1-2-3-4';
s.seen(P, { class: 'OZ_StorageBox_Small', at: '2026-09-19 06:00:00' });
const pc0 = buildChunk([paper(0, 0)], Buffer.from('01', 'hex'));
const pc1 = buildChunk(pouch, Buffer.from('02', 'hex'));
const pc2 = buildChunk([paper(0, 1)], Buffer.from('03', 'hex'));
s.ingestClose({ boxId: P, header: header('2026-09-19 06:00:10'), chunks: [pc0, pc1, pc2], at: '2026-09-19 06:00:11' });

const parked = s.park({ boxId: P, rootIdx: 1, reason: 'refused', at: '2026-09-19 06:01:00', note: 'OnStoreLoad refused' });
ok('parking a root makes a new version without it', [parked.type, s.currentChunks(P).chunks.map(hex)], ['PlateCarrierPouches', [hex(pc0), hex(pc2)]]);
ok('the new version says park', s.versionsOf(P)[0].source, 'park');
ok('the parked row keeps the types of the subtree', s.parked(P).map((p) => [p.reason, p.type, JSON.parse(p.types)]),
  [['refused', 'PlateCarrierPouches', ['PlateCarrierPouches', 'SmallProtectorCase']]]);
ok('parking out of range is null', s.park({ boxId: P, rootIdx: 7, reason: 'desync' }), null);
ok('the class list still names the parked classes', s.classes().includes('SmallProtectorCase'), true);

const missing = s.parkMissing(['Paper'], '2026-09-19 06:02:00');
ok('a missing class parks every root that holds it', [missing.parked, missing.boxes], [2, [P]]);
ok('the box is left with no roots', s.currentChunks(P).chunks.length, 0);
ok('nothing to park is nothing', s.parkMissing(['Paper']), { parked: 0, boxes: [] });

const back = s.unparkPresent(['Paper', 'PlateCarrierPouches'], '2026-09-19 06:03:00');
ok('only roots whose every class is present come back', [back.unparked, back.boxes], [2, [P]]);
ok('they come back unplaced, body intact', s.currentChunks(P).chunks.map((c) => [parseChunk(c).nodes[0].type, parseChunk(c).nodes[0].row, hex(c.subarray(parseChunk(c).bodyOffset))]),
  [['Paper', -1, '01'], ['Paper', -1, '03']]);
ok('the pouch waits for its case', s.parked(P).map((p) => p.type), ['PlateCarrierPouches']);
const back2 = s.unparkPresent(['Paper', 'PlateCarrierPouches', 'SmallProtectorCase'], '2026-09-19 06:03:30');
ok('and comes back once the case exists', [back2.unparked, s.parked(P).length, s.currentChunks(P).chunks.length], [1, 0, 3]);

console.log('rollback');

const target = s.versionsOf(P).find((v) => v.source === 'park' && v.roots === 2).id;
ok('rollback to a past version is a new version with its roots', s.rollback(P, target, { at: '2026-09-19 06:04:00', admin: 'owner' }).ok, true);
ok('with the same chunks', s.currentChunks(P).chunks.map(hex), [hex(pc0), hex(pc2)]);
ok('and the source says so', [s.versionsOf(P)[0].source, s.versionsOf(P)[0].note], ['rollback', `from ${target} by owner`]);
ok('rollback to another box\'s version is refused', s.rollback(P, 1, {}).ok, false);
s.markOpen(P);
ok('rollback of an open box is refused', s.rollback(P, target, {}), { ok: false, why: 'the box is open; close it first' });
s.markClosed(P);

console.log('events');

const n = s.events([
  { at: '2026-09-19 06:05:00', kind: 'placed', box: '5-6-7-8', uid: '76561198000000002', name: 'Сидорович', type: 'OZ_StorageBox_Small', note: '4650 339 10400' },
  { at: '2026-09-19 06:05:10', kind: 'put', box: '5-6-7-8', uid: '76561198000000002', name: 'Сидорович', type: 'AKM', qty: 1, row: 3, col: 0 },
  { at: '2026-09-19 06:05:20', kind: 'take', box: '5-6-7-8', uid: '76561198000000002', name: 'Сидорович', type: 'AKM', qty: 1, row: 3, col: 0, note: 'mag=30' },
  { at: '2026-09-19 06:05:30', kind: 'removed', box: '5-6-7-8', uid: '' },
  { kind: '' },
], 'stand');
ok('four of five events are stored', n, 4);
ok('placed made the box known', [s.boxOf('5-6-7-8').class, s.boxOf('5-6-7-8').placed_by, s.boxOf('5-6-7-8').pos], ['OZ_StorageBox_Small', '76561198000000002', '4650 339 10400']);
ok('removed marked it', s.boxOf('5-6-7-8').status, 'removed');
ok('events by box, newest first', s.eventsOf('5-6-7-8').map((e) => [e.kind, e.type, e.qty, e.note, e.server_id]),
  [['removed', '', 0, '', 'stand'], ['take', 'AKM', 1, 'mag=30', 'stand'], ['put', 'AKM', 1, '', 'stand'], ['placed', 'OZ_StorageBox_Small', 0, '4650 339 10400', 'stand']]);
ok('events by player', s.eventsBy('76561198000000002').map((e) => e.kind), ['take', 'put', 'placed']);

console.log('turns of a proxy session (design 2026-09-24 section 7)');

// A box of four loose roots to shuffle about.
const T = '9-9-9-9';
const t0 = buildChunk([paper(0, 0)]);
const t1 = buildChunk([paper(0, 1)]);
const t2 = buildChunk([paper(0, 2)]);
const t3 = buildChunk([paper(0, 3)]);
s.boot([{ id: T, class: 'OZ_StorageBox_Small', state: 'CLOSED', entities: 0, pos: '1 2 3' }]);
const tBase = s.ingestClose({ boxId: T, header: header('2026-09-24 10:00:00'), chunks: [t0, t1, t2, t3] });
ok('the box starts with four roots', [tBase.roots, tBase.entities], [4, 4]);

// One root moved: its chunk is replaced in place.
const moved = buildChunk([paper(5, 5)]);
const turn1 = s.applyOps({ boxId: T, chunks: [moved], rewrite: [1], adds: 0 });
ok('a rewrite keeps the count', [turn1.roots, turn1.entities], [4, 4]);
ok('and forks the version once', turn1.version !== tBase.version, true);
ok('the moved root is the one that changed', s.currentChunks(T).chunks.map(hex), [hex(t0), hex(moved), hex(t2), hex(t3)]);
ok('the item rows follow it', s.itemsOf(T).map((i) => [i.root_idx, i.row, i.col]), [[0, 0, 0], [1, 5, 5], [2, 0, 2], [3, 0, 3]]);
ok('history kept what the session started from', s.versionsOf(T).length, 2);

// A second turn of the same session mutates the fork rather than forking again.
const moved2 = buildChunk([paper(6, 6)]);
const turn2 = s.applyOps({ boxId: T, chunks: [moved2], rewrite: [3], adds: 0 });
ok('the same session keeps one version', [turn2.version === turn1.version, s.versionsOf(T).length], [true, 2]);

// An item taken out: the root leaves and the rest close up, on both sides.
const turn3 = s.applyOps({ boxId: T, chunks: [], rewrite: [], drop: [0], adds: 0 });
ok('a drop shortens the record', [turn3.roots, turn3.entities], [3, 3]);
ok('and renumbers what is left', s.currentChunks(T).chunks.map(hex), [hex(moved), hex(t2), hex(moved2)]);

// An item put in joins the end.
const arrived = buildChunk(pouch);
const turn4 = s.applyOps({ boxId: T, chunks: [arrived], rewrite: [], adds: 1 });
ok('an addition joins the end', [turn4.roots, turn4.entities], [4, 5]);
ok('with its whole subtree', s.itemsOf(T).filter((i) => i.root_idx === 3).map((i) => i.type), ['PlateCarrierPouches', 'SmallProtectorCase']);

// A rewrite and an addition in one letter, the file's order: rewrites first.
const turn5 = s.applyOps({ boxId: T, chunks: [t1, t3], rewrite: [0], adds: 1 });
ok('one letter can do both', s.currentChunks(T).chunks.map(hex), [hex(t1), hex(t2), hex(moved2), hex(arrived), hex(t3)]);
ok('and the counts follow', [turn5.roots, turn5.entities], [5, 6]);

// What must be refused.
const refused = (what, fn) => { try { fn(); ok(what, 'no refusal', 'a refusal'); } catch (e) { ok(what, true, true); } };
refused('a position that is not in the record', () => s.applyOps({ boxId: T, chunks: [t0], rewrite: [99], adds: 0 }));
refused('a letter whose file holds the wrong number of roots', () => s.applyOps({ boxId: T, chunks: [t0, t1], rewrite: [0], adds: 0 }));
refused('a box with no record at all', () => s.applyOps({ boxId: 'nobody', chunks: [], drop: [0] }));
ok('a refusal changed nothing', s.currentChunks(T).chunks.map(hex), [hex(t1), hex(t2), hex(moved2), hex(arrived), hex(t3)]);

// A close after a session starts a fresh history entry, and the next session
// forks again.
s.ingestClose({ boxId: T, header: header('2026-09-24 11:00:00'), chunks: [t0] });
const after = s.applyOps({ boxId: T, chunks: [t1], rewrite: [0], adds: 0 });
ok('a session after a close forks again', s.versionsOf(T).length, 4);
ok('and reads the close it started from', s.currentChunks(T).chunks.map(hex), [hex(t1)]);
ok('the close and the session are separate versions', after.version !== s.versionsOf(T)[1].id, true);

console.log('keep');

const now = new Date(Date.UTC(2026, 9, 19, 0, 0, 0)); // a month later
const before = base.db.prepare('SELECT COUNT(*) AS n FROM storage_blobs').get().n;
const kept = s.keep({ versionsDays: 14, eventsDays: 90, now });
ok('old versions go, the current ones stay', [kept.versions > 0, s.versionsOf(P).length, s.versionsOf(BOX).length], [true, 1, 1]);
ok('blobs nobody references go with them', kept.blobs > 0 && base.db.prepare('SELECT COUNT(*) AS n FROM storage_blobs').get().n < before, true);
ok('events inside the window stay', [kept.events, s.eventsOf('5-6-7-8').length], [0, 4]);
const later = s.keep({ versionsDays: 14, eventsDays: 1, now });
ok('events past the window go', [later.events, s.eventsOf('5-6-7-8').length], [4, 0]);
ok('the current version is still readable', s.currentChunks(P).chunks.map(hex), [hex(pc0), hex(pc2)]);

console.log(`\n${pass} passed, ${fail} failed`);
base.close();
process.exit(fail ? 1 : 0);
