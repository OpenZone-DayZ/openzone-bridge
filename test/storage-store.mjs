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
  { boxes: [{ id: BOX, status: 'none', version: 0, roots: 0 }], classes: [] });
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

const empty = s.ingestClose({ boxId: BOX, header: header('2026-09-19 05:03:00'), chunks: [], why: 'boot' });
ok('a close with no roots is a version too', [empty.version, empty.roots, s.versionsOf(BOX)[0].source], [3, 0, 'boot']);
ok('an empty current version has no item rows', s.itemsOf(BOX).length, 0);

s.cacheNote(BOX, '2026-09-19 05:03:00', 321);
ok('the cache note is kept on the box', [s.boxOf(BOX).cache_stamp, s.boxOf(BOX).cache_size], ['2026-09-19 05:03:00', 321]);

s.removed(BOX, '2026-09-19 05:04:00');
ok('a removed box leaves knownIds', s.knownIds(), []);
ok('but keeps its versions', s.versionsOf(BOX).length, 3);

console.log(`\n${pass} passed, ${fail} failed`);
base.close();
process.exit(fail ? 1 : 0);
