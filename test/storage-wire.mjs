// The version-3 storage wire (design 2026-09-19, section 2), offline.
//
// The engine's FileSerializer writes a flat stream of raw little-endian
// values with no header of its own; the fixture is a real file it wrote on
// the stand, so the first assertions pin our reader to the engine's layout,
// and the rest exercise what this module adds on top: chunks separated by a
// random marker, a descriptor per root, and a rebuild that is byte-exact.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BIN_END, MARKER_BYTES, Reader, Writer, WireError,
  buildChunk, buildFile, parseChunk, parseFile, parseHeader, stampNow, typesOf, unplace,
} from '../src/storage-wire.js';

const here = dirname(fileURLToPath(import.meta.url));
const engineRecord = readFileSync(join(here, 'fixtures', 'storage', 'engine-record.bin'));

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
function throwsWire(what, fn, fragment) {
  try {
    fn();
    fail++;
    console.log(`  FAIL ${what}: no error`);
  } catch (e) {
    const good = e instanceof WireError && e.message.includes(fragment);
    if (good) pass++; else fail++;
    console.log(`  ${good ? 'ok  ' : 'FAIL'} ${what}${good ? '' : `: ${e.message}`}`);
  }
}

console.log('the engine layout');

{
  // A version-2 root file written by the engine: int 2, string stamp,
  // int index, then the record. The reader must walk it exactly.
  const r = new Reader(engineRecord);
  ok('int32 LE', r.int(), 2);
  ok('string = int32 length + bytes', r.str(), '2026-09-19 00:09:07');
  ok('the next int is the root index', r.int(), 1399);
  ok('the record starts with the class', r.str(), 'Paper');
  ok('the file ends with BIN_END', engineRecord.readInt32LE(engineRecord.length - 4), BIN_END);
}

{
  const w = new Writer().int(-5).float(1.5).str('Paper').str('').toBuffer();
  ok('writer bytes', w.toString('hex'), 'fbffffff0000c03f05000000506170657200000000');
  const r = new Reader(w);
  ok('writer and reader agree', [r.int(), r.float(), r.str(), r.str()], [-5, 1.5, 'Paper', '']);
  throwsWire('reading past the end is a WireError', () => r.int(), 'truncated');
}

console.log('chunks');

const paper = (row, col) => ({ parent: -1, type: 'Paper', locType: 3, slot: -1, row, col, flip: 0, health: 15, quantity: 1, liquid: 0, ammo: 0, hasBlob: 1 });
const pouch = [
  { parent: -1, type: 'PlateCarrierPouches', locType: 3, slot: -1, row: 2, col: 4, flip: 0, health: 100, quantity: 0, liquid: 0, ammo: 0, hasBlob: 1 },
  { parent: 0, type: 'SmallProtectorCase', locType: 3, slot: -1, row: 0, col: 0, flip: 0, health: 100, quantity: 0, liquid: 0, ammo: 0, hasBlob: 1 },
  { parent: 1, type: 'BandageDressing', locType: 3, slot: -1, row: 0, col: 0, flip: 0, health: 100, quantity: 1, liquid: 0, ammo: 0, hasBlob: 1 },
];

{
  const chunk = buildChunk([paper(0, 0)], Buffer.from([1, 2, 3]));
  ok('descriptor then body', chunk.toString('hex'),
    '01000000' + 'ffffffff' + '0500000050617065' + '72' + '03000000' + 'ffffffff' + '00000000' + '00000000' + '00000000' + '00007041' + '0000803f' + '00000000' + '00000000' + '01000000' + '010203');
  const p = parseChunk(chunk);
  ok('the descriptor parses back', p.nodes, [paper(0, 0)]);
  ok('the body starts after the descriptor', chunk.subarray(p.bodyOffset).toString('hex'), '010203');
}

{
  const chunk = buildChunk(pouch, engineRecord);
  const p = parseChunk(chunk);
  ok('a subtree keeps its parents', p.nodes.map((n) => n.parent), [-1, 0, 1]);
  ok('types are unique and sorted', typesOf(p.nodes), ['BandageDressing', 'PlateCarrierPouches', 'SmallProtectorCase']);
  ok('the body is the engine record byte for byte', chunk.subarray(p.bodyOffset).equals(engineRecord), true);
  const moved = unplace(chunk);
  const q = parseChunk(moved);
  ok('unplace puts the root at -1/-1', [q.nodes[0].row, q.nodes[0].col], [-1, -1]);
  ok('unplace leaves the children where they were', [q.nodes[1].row, q.nodes[2].col], [0, 0]);
  ok('unplace leaves the body alone', moved.subarray(q.bodyOffset).equals(engineRecord), true);
}

throwsWire('a child pointing forward is refused', () => parseChunk(buildChunk([{ ...paper(0, 0) }, { ...paper(0, 1), parent: 5 }])), 'parent');
throwsWire('a root that is not a root is refused', () => parseChunk(buildChunk([{ ...paper(0, 0), parent: 0 }])), 'parent');
throwsWire('an empty type is refused', () => parseChunk(buildChunk([{ ...paper(0, 0), type: '' }])), 'type');

console.log('files');

const header = { saveVer: 142, stamp: '2026-09-19 05:15:30', boxClass: 'OZ_StorageBox_Large', boxId: '-1836652215-591616390-994303877-1955932247' };

{
  const chunks = [buildChunk([paper(0, 0)], Buffer.from('aa', 'hex')), buildChunk(pouch, engineRecord), buildChunk([paper(1, 1)])];
  const file = buildFile(header, chunks);
  const h = parseHeader(file);
  ok('header fields', [h.version, h.saveVer, h.stamp, h.boxClass, h.boxId, h.roots, h.entities], [3, 142, header.stamp, header.boxClass, header.boxId, 3, 5]);
  ok('the marker is sixteen bytes', h.marker.length, MARKER_BYTES);
  const parsed = parseFile(file);
  ok('every root comes back byte for byte', parsed.roots.map((r, i) => r.bytes.equals(chunks[i])), [true, true, true]);
  ok('the descriptors come with them', parsed.roots[1].nodes.map((n) => n.type), ['PlateCarrierPouches', 'SmallProtectorCase', 'BandageDressing']);
  const again = buildFile(header, parsed.roots.map((r) => r.bytes));
  ok('a rebuilt file differs only by its marker', again.length, file.length);
  ok('a rebuilt file parses to the same roots', parseFile(again).roots.map((r) => r.bytes.toString('hex')), chunks.map((c) => c.toString('hex')));
  ok('two builds never share a marker', parseHeader(again).marker.equals(h.marker), false);
}

{
  const empty = buildFile(header, []);
  ok('an empty box is a header and the trailer', parseFile(empty).roots.length, 0);
  ok('an empty file has zero entities', parseHeader(empty).entities, 0);
}

{
  // A body that contains the first fifteen bytes of the marker must not
  // fool the carving: only the full sixteen end a root.
  const marker = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const near = Buffer.concat([marker.subarray(0, 15), Buffer.from([marker[15] ^ 0xff])]);
  const tricky = buildFile(header, [buildChunk([paper(0, 0)], near), buildChunk([paper(0, 1)])], marker);
  const parsed = parseFile(tricky);
  ok('a near-marker inside a body is carried as body bytes', parsed.roots.map((r) => r.nodes[0].col), [0, 1]);
  ok('and the body comes back whole', parsed.roots[0].bytes.subarray(parseChunk(parsed.roots[0].bytes).bodyOffset).equals(near), true);
  ok('a wrong-sized marker is refused', (() => { try { buildFile(header, [], Buffer.alloc(3)); return 'built'; } catch (e) { return e instanceof WireError ? 'refused' : 'wrong error'; } })(), 'refused');
}

{
  const file = buildFile(header, [buildChunk([paper(0, 0)])]);
  const wrongVersion = Buffer.from(file); wrongVersion.writeInt32LE(2, 0);
  throwsWire('version 2 is refused', () => parseFile(wrongVersion), 'version 2 is not 3');
  throwsWire('a truncated file is refused', () => parseFile(file.subarray(0, file.length - 6)), 'marker');
  const noTrailer = Buffer.from(file); noTrailer.writeInt32LE(1, file.length - 4);
  throwsWire('a wrong trailer is refused', () => parseFile(noTrailer), 'BIN_END');
  const moreRoots = Buffer.from(file);
  const h = parseHeader(file);
  moreRoots.writeInt32LE(2, h.length - MARKER_BYTES - 8); // roots field sits before entities and the marker
  throwsWire('a header that promises more roots than the file holds is refused', () => parseFile(moreRoots), 'root 1 of 2');
  const wrongEntities = Buffer.from(file);
  wrongEntities.writeInt32LE(9, h.length - MARKER_BYTES - 4);
  throwsWire('a wrong entity count is refused', () => parseFile(wrongEntities), 'entities');
}

ok('stampNow is UTC in the engine format', stampNow(new Date(Date.UTC(2026, 8, 19, 5, 15, 30))), '2026-09-19 05:15:30');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
