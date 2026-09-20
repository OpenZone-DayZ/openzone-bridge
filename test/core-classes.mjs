// The core's class dump: read from the profile directory, turned into the
// index the site parses, stored per server, answered by the core admin.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { CoreStore } from '../src/core-store.js';
import { CLASSES_FILE, readClassDump, serverClassIndex, storeClassDump } from '../src/core-classes.js';
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
  '0\tInventory_Base\tStatic\t\t',
  '0\tAll\t\tSTR_DN_UNKNOWN\tSTR_DN_UNKNOWN',
  '0\tOZL_Microscope\tInventory_Base\tМікроскоп\tMicroscope',
  '0\tMouflonSteakMeat\tEdible_Base\t$UNT$Mouflon Steak\t$UNT$Mouflon Steak',
  '4\tAKM\tRifle_Base\tKA-M\tKA-M',
  '',
  'not a row',
  '9\tNope\t\t\t',
  '',
].join('\r\n'), 'utf8');
const dump = readClassDump(profile);
ok('rows carry root, parent and names; a bare key is no name, $UNT$ no part of one, a broken line and a bad root nothing', dump.rows, [
  { root: 0, name: 'Inventory_Base', base: 'Static', original: '', english: '' },
  { root: 0, name: 'All', base: '', original: '', english: '' },
  { root: 0, name: 'OZL_Microscope', base: 'Inventory_Base', original: 'Мікроскоп', english: 'Microscope' },
  { root: 0, name: 'MouflonSteakMeat', base: 'Edible_Base', original: 'Mouflon Steak', english: 'Mouflon Steak' },
  { root: 4, name: 'AKM', base: 'Rifle_Base', original: 'KA-M', english: 'KA-M' },
]);
ok('the count and a stamp', [dump.count, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(dump.at)], [5, true]);

console.log('the index');

const idx = serverClassIndex(dump.rows, 'stand', dump.at);
ok('rows in the site shape, the parent as a row number, one mod (the server)', [idx.v, idx.mods, idx.generated === dump.at, idx.classes], [3, ['stand'], true, [
  ['Inventory_Base', -1, 0, 0, '', ''],
  ['All', -1, 0, 0, '', ''],
  ['OZL_Microscope', 0, 0, 0, 'Мікроскоп', 'Microscope'],
  ['MouflonSteakMeat', -1, 0, 0, 'Mouflon Steak', 'Mouflon Steak'],
  ['AKM', -1, 0, 4, 'KA-M', 'KA-M'],
]]);
ok('a parent is found in the same root first, then in any', serverClassIndex([
  { root: 4, name: 'AKM', base: 'Rifle_Base', original: '', english: '' },
  { root: 0, name: 'Rifle_Base', base: '', original: '', english: '' },
  { root: 4, name: 'Rifle_Base', base: '', original: '', english: '' },
  { root: 1, name: 'Mag', base: 'rifle_base', original: '', english: '' },
], 's', 'x').classes.map((c) => c[1]), [2, -1, -1, 1]);

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
ok('storeClassDump answers the summary', [stored.count, stored.at === dump.at], [5, true]);
ok('and stores nothing without a file', storeClassDump(core, join(dir, 'nowhere'), 'other'), null);
storeClassDump(core, profile, 'older', '2026-09-19 03:00:01');
ok('classes names the server that dumped last, or the one asked for', [admin.classes({}).server, admin.classes({}).count, admin.classes({ server: 'older' }).server, admin.classes({ server: 'nope' }).count], ['stand', 5, 'older', 0]);
const answer = admin.classindex({ server: 'stand' });
ok('classindex is the stored index with when the game wrote the dump', [answer.server, answer.index.classes.length, answer.index.classes[2], answer.at === dump.at], ['stand', 5, ['OZL_Microscope', 0, 0, 0, 'Мікроскоп', 'Microscope'], true]);
ok('servers and status come from the bridge', [admin.servers().servers.length, admin.status().profileDir === profile], [1, true]);

base.close?.();
rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
