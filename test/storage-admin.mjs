// The admin side of the storage (design 2026-09-19, sections 4.4, 4.5, 8):
// what an admin may do to a closed box through SQL, and how a live command
// reaches the game's poll. Offline, throwaway database and directory.

import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { StorageStore } from '../src/storage-store.js';
import { Xchg } from '../src/storage-xchg.js';
// import { storageAdmin } from '../src/storage-admin.js';
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
const hex = (b) => Buffer.from(b).toString('hex');

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
ok('the gift has no body, no cell, the quantity and a default health', [gift.type, gift.hasBlob, gift.row, gift.col, gift.quantity, gift.health], ['Rag', 0, -1, -1, 3, 0]);
ok('the gift is indexed', s.find('Rag').length, 1);
ok('a bad class name is refused', s.give(BOX, 'Rag; DROP', 1), { ok: false, why: 'bad class name' });
ok('an unknown box is refused', s.give('1-2-3-4', 'Rag', 1), { ok: false, why: 'unknown box' });
ok('the version notes who gave what', s.versionsOf(BOX)[0].note, 'give Rag by owner');

ok('empty makes a version with no roots', s.empty(BOX, { at: '2026-09-19 07:05:00', admin: 'owner' }), { ok: true, version: 6 });
ok('and the box has none', [s.currentChunks(BOX).roots, s.itemsOf(BOX).length], [0, 0]);
s.markOpen(BOX);
ok('an open box cannot be emptied through SQL', s.empty(BOX), { ok: false, why: 'the box is open; close it first' });
s.markClosed(BOX);

s.events([{ at: '2026-09-19 07:06:00', kind: 'admin_result', box: BOX, name: 'owner', note: 'abc123: ok CLOSED entities=0' }], 'stand');
ok('resultOf finds the answer by its ref', s.resultOf('abc123').note, 'abc123: ok CLOSED entities=0');
ok('resultOf of an unknown ref is null', s.resultOf('nope'), null);

console.log(`\n${pass} passed, ${fail} failed`);
base.close();
rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
