// The core's class dump: read from the profile directory, turned into the
// index the site parses, stored per server, answered by the core admin.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { CoreStore } from '../src/core-store.js';
import { CLASSES_FILE, classSizes, readClassDump, serverClassIndex, sizesOfIndex, storeClassDump } from '../src/core-classes.js';
import { coreAdmin } from '../src/core-admin.js';

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

const dir = mkdtempSync(join(tmpdir(), 'oz-core-classes-'));
const profile = join(dir, 'OpenZone');
mkdirSync(profile, { recursive: true });

console.log('the dump');

ok('no file is null', readClassDump(profile), null);
ok('no directory is null', readClassDump(''), null);
writeFileSync(join(profile, CLASSES_FILE), [
  '0\tInventory_Base\tStatic\t\t\t0\t0\t0\t0',
  '0\tAll\t\tSTR_DN_UNKNOWN\tSTR_DN_UNKNOWN',
  '0\tOZL_Microscope\tInventory_Base\tМікроскоп\tMicroscope\t3\t2\t0\t0',
  '0\tMouflonSteakMeat\tEdible_Base\t$UNT$Mouflon Steak\t$UNT$Mouflon Steak\t1\t1\t0\t0',
  '4\tAKM\tRifle_Base\tKA-M\tKA-M\t5\t2\t0\t0',
  '0\tOZ_StorageBox_Large\tSeaChest\tВелика скриня\tLarge storage box\t10\t5\t10\t150',
  '',
  'not a row',
  '9\tNope\t\t\t',
  '',
].join('\r\n'), 'utf8');
const dump = readClassDump(profile);
ok('rows carry root, parent, names and sizes; a bare key is no name, $UNT$ no part of one, missing sizes 0, a broken line and a bad root nothing', dump.rows, [
  { root: 0, name: 'Inventory_Base', base: 'Static', original: '', english: '', w: 0, h: 0, cw: 0, ch: 0 },
  { root: 0, name: 'All', base: '', original: '', english: '', w: 0, h: 0, cw: 0, ch: 0 },
  { root: 0, name: 'OZL_Microscope', base: 'Inventory_Base', original: 'Мікроскоп', english: 'Microscope', w: 3, h: 2, cw: 0, ch: 0 },
  { root: 0, name: 'MouflonSteakMeat', base: 'Edible_Base', original: 'Mouflon Steak', english: 'Mouflon Steak', w: 1, h: 1, cw: 0, ch: 0 },
  { root: 4, name: 'AKM', base: 'Rifle_Base', original: 'KA-M', english: 'KA-M', w: 5, h: 2, cw: 0, ch: 0 },
  { root: 0, name: 'OZ_StorageBox_Large', base: 'SeaChest', original: 'Велика скриня', english: 'Large storage box', w: 10, h: 5, cw: 10, ch: 150 },
]);
ok('the count and a stamp', [dump.count, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(dump.at)], [6, true]);

console.log('the index');

const idx = serverClassIndex(dump.rows, 'stand', dump.at);
ok('rows in the site shape with sizes, the parent as a row number, one mod (the server)', [idx.v, idx.mods, idx.generated === dump.at, idx.classes], [4, ['stand'], true, [
  ['Inventory_Base', -1, 0, 0, '', '', 0, 0, 0, 0],
  ['All', -1, 0, 0, '', '', 0, 0, 0, 0],
  ['OZL_Microscope', 0, 0, 0, 'Мікроскоп', 'Microscope', 3, 2, 0, 0],
  ['MouflonSteakMeat', -1, 0, 0, 'Mouflon Steak', 'Mouflon Steak', 1, 1, 0, 0],
  ['AKM', -1, 0, 4, 'KA-M', 'KA-M', 5, 2, 0, 0],
  ['OZ_StorageBox_Large', -1, 0, 0, 'Велика скриня', 'Large storage box', 10, 5, 10, 150],
]]);
ok('sizesOfIndex maps lower-case names to sizes, a v3 row to nothing', [sizesOfIndex(idx).get('ozl_microscope'), sizesOfIndex(idx).get('oz_storagebox_large'), sizesOfIndex({ classes: [['X', -1, 0, 0, '', '']] }).size], [{ w: 3, h: 2, cw: 0, ch: 0 }, { w: 10, h: 5, cw: 10, ch: 150 }, 0]);
ok('a parent is found in the same root first, then in any', serverClassIndex([
  { root: 4, name: 'AKM', base: 'Rifle_Base', original: '', english: '' },
  { root: 0, name: 'Rifle_Base', base: '', original: '', english: '' },
  { root: 4, name: 'Rifle_Base', base: '', original: '', english: '' },
  { root: 1, name: 'Mag', base: 'rifle_base', original: '', english: '' },
], 's', 'x').classes.map((c) => c[1]), [2, -1, -1, 1]);
ok('a row without sizes indexes as zeros', serverClassIndex([{ root: 0, name: 'X', base: '', original: '', english: '' }], 's', 'x').classes[0].slice(6), [0, 0, 0, 0]);

console.log('the store and the admin');

const base = new Store(join(dir, 'core.sqlite'));
const core = new CoreStore(base);
ok('meta is empty', [core.metaGet('x'), core.metaList('classes:')], [null, []]);
core.metaSet('k_1', 'a', '2026-09-20 01:00:00');
core.metaSet('k%2', 'b', '2026-09-20 02:00:00');
core.metaSet('kx3', 'c', '2026-09-20 03:00:00');
ok('metaList takes a literal prefix, newest first', core.metaList('k_').map((r) => r.key), ['k_1']);
ok('and escapes a percent sign too', core.metaList('k%').map((r) => r.key), ['k%2']);
const servers = () => [{ id: 'stand', at: '2026-09-20 03:00:00', since: '', kinds: {} }];
const admin = coreAdmin({ store: core, servers, profileDir: profile });
ok('classes before any dump is nothing', admin.classes({}), { ok: true, server: '', count: 0, at: '' });
ok('classindex too', admin.classindex(), { ok: true, server: '', index: null, at: '' });
const stored = storeClassDump(core, profile, 'stand', '2026-09-20 03:00:01');
ok('storeClassDump answers the summary', [stored.count, stored.at === dump.at], [6, true]);
ok('classSizes answers the stored sizes, from memory after the first read, nothing for an unknown server', [classSizes(core, 'stand').get('akm'), classSizes(core, 'stand') === classSizes(core, 'stand'), classSizes(core, 'nope')], [{ w: 5, h: 2, cw: 0, ch: 0 }, true, null]);
ok('and stores nothing without a file', storeClassDump(core, join(dir, 'nowhere'), 'other'), null);
storeClassDump(core, profile, 'older', '2026-09-19 03:00:01');
ok('classes names the server that dumped last, or the one asked for', [admin.classes({}).server, admin.classes({}).count, admin.classes({ server: 'older' }).server, admin.classes({ server: 'nope' }).count], ['stand', 6, 'older', 0]);
const answer = admin.classindex({ server: 'stand' });
ok('classindex is the stored index with when the game wrote the dump', [answer.server, answer.index.classes.length, answer.index.classes[2], answer.at === dump.at], ['stand', 6, ['OZL_Microscope', 0, 0, 0, 'Мікроскоп', 'Microscope', 3, 2, 0, 0], true]);
ok('servers and status come from the bridge', [admin.servers().servers.length, admin.status().profileDir === profile], [1, true]);

base.close?.();
rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
