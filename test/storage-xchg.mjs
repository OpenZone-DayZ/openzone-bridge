// The exchange directory (design 2026-09-19, sections 1 and 3): one owner
// per file at any moment, handover by message, never by watching the
// directory. Offline, in a throwaway directory.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Xchg } from '../src/storage-xchg.js';
import { buildChunk, buildFile, parseHeader } from '../src/storage-wire.js';

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

const dir = mkdtempSync(join(tmpdir(), 'oz-xchg-'));
const BOX = '-1836652215-591616390-994303877-1955932247';
const OTHER = '1-2-3-4';
const paper = { parent: -1, type: 'Paper', locType: 3, slot: -1, row: 0, col: 0, flip: 0, health: 15, quantity: 1, liquid: 0, ammo: 0, hasBlob: 1 };
const file = (stamp) => buildFile({ saveVer: 142, stamp, boxClass: 'OZ_StorageBox_Large', boxId: BOX }, [buildChunk([paper])]);

console.log('names');

ok('a box id is four signed integers', [Xchg.isBoxId(BOX), Xchg.isBoxId(OTHER), Xchg.isBoxId('1-2-3'), Xchg.isBoxId('a-b-c-d'), Xchg.isBoxId('../1-2-3-4')], [true, true, false, false, false]);
ok('a close file is the box id, a file stamp and .bin', Xchg.closeName(`${BOX}-20260919-051530.bin`, BOX), true);
ok('another box\'s name is refused', Xchg.closeName(`${OTHER}-20260919-051530.bin`, BOX), false);
ok('a path is refused', [Xchg.closeName(`../${BOX}-20260919-051530.bin`, BOX), Xchg.closeName(`${BOX}.bin`, BOX), Xchg.closeName(`${BOX}-2026-09-19.bin`, BOX)], [false, false, false]);

// A PERSONAL STASH is keyed by a pair, `s_<anchor>_<uid>` (design
// 2026-09-23). The exchange has to accept it as a box id and as a file name,
// and it must still refuse everything it refused before.
const STASH = 's_11539x3377_76561198014475380';

ok('a stash id is the pair', [Xchg.isBoxId(STASH), Xchg.isBoxId('s_11539x3377_1'), Xchg.isBoxId('s__76561198014475380'), Xchg.isBoxId('s_11539_76561198014475380')], [true, false, false, false]);
ok('a stash close file is named like any other', Xchg.closeName(`${STASH}-20260923-134501.bin`, STASH), true);
ok('a stash name is refused for a box and the other way round', [Xchg.closeName(`${STASH}-20260923-134501.bin`, BOX), Xchg.closeName(`${BOX}-20260923-134501.bin`, STASH)], [false, false]);
ok('a path is refused in a stash name too', Xchg.closeName(`../${STASH}-20260923-134501.bin`, STASH), false);
ok('a stash id splits into anchor and owner', Xchg.splitId(STASH), { kind: 'stash', anchor: '11539x3377', owner: '76561198014475380' });
ok('a plain box id splits into nothing', Xchg.splitId(BOX), { kind: 'box', anchor: '', owner: '' });
ok('nonsense splits into a box rather than throwing', [Xchg.splitId(''), Xchg.splitId('s_'), Xchg.splitId(null)], [{ kind: 'box', anchor: '', owner: '' }, { kind: 'box', anchor: '', owner: '' }, { kind: 'box', anchor: '', owner: '' }]);

console.log('the close file becomes the cache');

const x = new Xchg(dir);
const name = `${BOX}-20260919-051530.bin`;
const bytes = file('2026-09-19 05:15:30');
writeFileSync(join(dir, name), bytes);
ok('readClose returns the bytes', x.readClose(name, BOX).equals(bytes), true);
let refused = '';
try { x.readClose(`${OTHER}-20260919-051530.bin`, BOX); } catch (e) { refused = e.constructor.name; }
ok('readClose refuses a name that is not this box\'s', refused, 'WireError');
ok('promote renames into the cache and returns the size', [x.promote(name, BOX), existsSync(join(dir, name)), existsSync(x.cachePath(BOX))], [bytes.length, false, true]);
ok('cacheInfo reads the header stamp and the size', x.cacheInfo(BOX), { size: bytes.length, stamp: '2026-09-19 05:15:30' });
ok('cacheInfo of a box without a cache is null', x.cacheInfo(OTHER), null);

console.log('the bridge writes a cache');

const rebuilt = file('2026-09-19 05:20:00');
ok('writeCache returns the size', x.writeCache(BOX, rebuilt), rebuilt.length);
ok('and leaves no .part behind', existsSync(x.cachePath(BOX) + '.part'), false);
ok('the cache is the new file', parseHeader(readFileSync(x.cachePath(BOX))).stamp, '2026-09-19 05:20:00');
x.dropCache(BOX);
ok('dropCache removes it', existsSync(x.cachePath(BOX)), false);
x.dropCache(BOX);
ok('dropping twice is fine', true, true);

console.log('sweep');

writeFileSync(join(dir, `${OTHER}.bin.part`), 'half');
writeFileSync(join(dir, `${OTHER}.bin`), file('2026-09-19 05:21:00'));
writeFileSync(x.cachePath(BOX), file('2026-09-19 05:22:00'));
const fresh = `${BOX}-20260919-052300.bin`;
const stale = `${BOX}-20260919-040000.bin`;
writeFileSync(join(dir, fresh), bytes);
writeFileSync(join(dir, stale), bytes);
const old = new Date(Date.now() - 10 * 60 * 1000);
utimesSync(join(dir, stale), old, old);
const removed = x.sweep([BOX]).sort();
ok('sweep drops .part files, stale close files and caches of unknown boxes', removed, [`${OTHER}.bin`, `${OTHER}.bin.part`, stale].sort());
ok('and keeps a fresh close file and a known cache', [existsSync(join(dir, fresh)), existsSync(x.cachePath(BOX))], [true, true]);
ok('a fresh close file is untouched', statSync(join(dir, fresh)).size, bytes.length);

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
