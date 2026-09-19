// The storage routes end to end (design 2026-09-19, section 3): the REAL
// entry point in a child process with no Discord bot, a throwaway database
// and a throwaway exchange directory, driven over the socket the way the
// game drives it. Plus the one thing a booted bridge cannot show: what the
// routes answer when STORAGE_XCHG_DIR is not set at all.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { StorageStore } from '../src/storage-store.js';
import { storageRoutes } from '../src/storage-routes.js';
import { buildChunk, buildFile, parseFile } from '../src/storage-wire.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = join(tmpdir(), `oz-storage-routes-${process.pid}.sqlite`);
const xdir = mkdtempSync(join(tmpdir(), 'oz-storage-xchg-'));
const SECRET = 'storage-routes-test-secret';

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

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const BOX = '-1836652215-591616390-994303877-1955932247';
const paper = (row, col) => ({ parent: -1, type: 'Paper', locType: 3, slot: -1, row, col, flip: 0, health: 15, quantity: 1, liquid: 0, ammo: 0, hasBlob: 1 });
const pouch = [
  { parent: -1, type: 'PlateCarrierPouches', locType: 3, slot: -1, row: 2, col: 4, flip: 0, health: 100, quantity: 0, liquid: 0, ammo: 0, hasBlob: 1 },
  { parent: 0, type: 'SmallProtectorCase', locType: 3, slot: -1, row: 0, col: 0, flip: 0, health: 100, quantity: 0, liquid: 0, ammo: 0, hasBlob: 1 },
];
const chunks = [buildChunk([paper(0, 0)], Buffer.from('aa', 'hex')), buildChunk(pouch, Buffer.from('bbcc', 'hex')), buildChunk([paper(0, 1)], Buffer.from('dd', 'hex'))];
const hex = (b) => Buffer.from(b).toString('hex');

console.log('without STORAGE_XCHG_DIR');

{
  const base = new Store(join(tmpdir(), `oz-storage-routes-off-${process.pid}.sqlite`));
  const routes = storageRoutes({ store: new StorageStore(base), xchg: null });
  ok('every route refuses in words', await routes['/v1/storage/open']({ Json: { id: BOX }, ServerId: 't' }), { ok: false, why: 'storage not configured' });
  ok('boot too', (await routes['/v1/storage/boot']({ Json: { boxes: [] }, ServerId: 't' })).ok, false);
  base.close();
}

console.log('the bridge with an exchange directory');

const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['src/index.js'], {
  cwd: root,
  env: {
    ...process.env,
    DISCORD_BOT_TOKEN: '',
    DISCORD_CLIENT_ID: '',
    DISCORD_GUILD_ID: '',
    DISCORD_PARENT_CHANNEL_ID: '',
    OZ_SHARED_SECRET: SECRET,
    BRIDGE_PORT: String(port),
    BRIDGE_DB: db,
    POLL_HOLD_SECONDS: '1',
    STORAGE_XCHG_DIR: xdir,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (b) => { log += b.toString(); });
child.stderr.on('data', (b) => { log += b.toString(); });

async function ready(ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`the bridge exited with ${child.exitCode}\n${log}`);
    if (log.includes('[bridge] ready')) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the bridge never said it was ready\n${log}`);
}

async function call(path, json) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ Secret: SECRET, ServerId: 'storage-test', Json: JSON.stringify(json) }),
  });
  const body = await r.json();
  if (r.status !== 200) throw new Error(`${path} -> ${r.status} ${JSON.stringify(body)}`);
  return body;
}

try {
  await ready();

  ok('boot of an unknown box answers none', await call('/v1/storage/boot', { boxes: [{ id: BOX, cls: 'OZ_StorageBox_Large', state: 'CLOSED', entities: 0, pos: '4650 339 10400' }] }),
    { ok: true, boxes: [{ id: BOX, status: 'none', version: 0, roots: 0 }], classes: [] });

  // A close: the game writes the file, then tells the bridge.
  const name = `${BOX}-20260919-051530.bin`;
  const bytes = buildFile({ saveVer: 142, stamp: '2026-09-19 05:15:30', boxClass: 'OZ_StorageBox_Large', boxId: BOX }, chunks);
  writeFileSync(join(xdir, name), bytes);
  ok('close ingests the file', await call('/v1/storage/close', { id: BOX, stamp: '2026-09-19 05:15:30', file: name, roots: 3, entities: 4, by: '76561198000000001', why: 'player' }),
    { ok: true, version: 1, roots: 3, entities: 4 });
  ok('the file became the cache', [existsSync(join(xdir, name)), existsSync(join(xdir, `${BOX}.bin`))], [false, true]);
  ok('closed is acknowledged', await call('/v1/storage/closed', { id: BOX, version: 1 }), { ok: true });

  // An open: the cache is current, so nothing is written.
  const before = statSync(join(xdir, `${BOX}.bin`)).mtimeMs;
  ok('open names the cache', await call('/v1/storage/open', { id: BOX, by: '76561198000000001' }),
    { ok: true, file: `${BOX}.bin`, stamp: '2026-09-19 05:15:30', roots: 3, entities: 4 });
  ok('and did not rewrite it', statSync(join(xdir, `${BOX}.bin`)).mtimeMs, before);
  ok('opened marks the box open', await call('/v1/storage/opened', { id: BOX, stamp: '2026-09-19 05:15:30' }), { ok: true });
  ok('boot now says open', (await call('/v1/storage/boot', { boxes: [{ id: BOX, class: '', state: 'OPEN', entities: 4, pos: '' }] })).boxes, [{ id: BOX, status: 'open', version: 1, roots: 3 }]);

  // The engine could not read root 1: it parks it and asks again.
  const parked = await call('/v1/storage/park', { id: BOX, stamp: '2026-09-19 05:15:30', root: 1, type: 'PlateCarrierPouches', why: 'refused' });
  ok('park answers the new version', [parked.ok, parked.version, parked.type], [true, 2, 'PlateCarrierPouches']);
  ok('a park without a root index is refused', await call('/v1/storage/park', { id: BOX, stamp: 'x', why: 'refused' }), { ok: false, why: 'bad root index' });
  ok('park drops the cache', existsSync(join(xdir, `${BOX}.bin`)), false);
  const again = await call('/v1/storage/open', { id: BOX, by: '76561198000000001' });
  ok('the next open rebuilds it with two roots', [again.ok, again.roots, again.entities], [true, 2, 2]);
  const rebuilt = parseFile(readFileSync(join(xdir, `${BOX}.bin`)));
  ok('the rebuilt cache holds the surviving roots byte for byte', rebuilt.roots.map((r) => hex(r.bytes)), [hex(chunks[0]), hex(chunks[2])]);
  ok('and carries the version stamp', rebuilt.header.stamp, again.stamp);

  // Classes at boot: Paper left the server, the pouch is back.
  const cls = await call('/v1/storage/classes', { missing: ['Paper'], present: ['PlateCarrierPouches', 'SmallProtectorCase'] });
  ok('classes parks and unparks', [cls.ok, cls.parked, cls.unparked], [true, 2, 1]);
  const after = await call('/v1/storage/open', { id: BOX, by: '' });
  ok('the box now holds the pouch alone, unplaced', [after.roots, parseFile(readFileSync(join(xdir, `${BOX}.bin`))).roots[0].nodes[0].row], [1, -1]);

  // Events, including the ones that touch boxes.
  ok('events are stored', await call('/v1/storage/events', { events: [
    { at: '2026-09-19 05:30:00', kind: 'placed', box: '1-2-3-4', uid: '76561198000000002', name: 'Сидорович', type: 'OZ_StorageBox_Small', note: '1 2 3' },
    { at: '2026-09-19 05:30:10', kind: 'put', box: '1-2-3-4', uid: '76561198000000002', name: 'Сидорович', type: 'AKM', qty: 1, row: 3, col: 0 },
  ] }), { ok: true, stored: 2 });

  // Refusals.
  ok('a close naming a path is refused', (await call('/v1/storage/close', { id: BOX, stamp: 'x', file: `../${BOX}-20260919-051530.bin`, roots: 1 })).why.startsWith('bad file name'), true);
  ok('a close of a missing file is refused', (await call('/v1/storage/close', { id: BOX, stamp: 'x', file: `${BOX}-20260919-051531.bin`, roots: 1 })).ok, false);
  writeFileSync(join(xdir, `${BOX}-20260919-051532.bin`), bytes.subarray(0, 40));
  const broken = await call('/v1/storage/close', { id: BOX, stamp: 'x', file: `${BOX}-20260919-051532.bin`, roots: 3 });
  ok('a broken file is refused and discarded', [broken.ok, broken.why.startsWith('file refused'), existsSync(join(xdir, `${BOX}-20260919-051532.bin`))], [false, true, false]);
  ok('a bad box id is refused', await call('/v1/storage/open', { id: 'x' }), { ok: false, why: 'bad box id' });
  ok('a box SQL has never seen opens as empty', await call('/v1/storage/open', { id: '9-9-9-9' }), { ok: true, empty: true });
  ok('an empty close needs no file', await call('/v1/storage/close', { id: '1-2-3-4', stamp: '2026-09-19 05:31:00', file: '', roots: 0, entities: 0, why: 'boot' }), { ok: true, version: 5 });
  ok('an empty box opens as empty', await call('/v1/storage/open', { id: '1-2-3-4' }), { ok: true, empty: true });

  // The admin route: reads, a version change that drops the cache, a live
  // command that shows up in the game's poll.
  const boxes = await call('/v1/storage/admin', { op: 'boxes' });
  ok('admin boxes', [boxes.ok, boxes.boxes.map((b) => b.box_id).includes(BOX)], [true, true]);
  ok('admin unknown op', await call('/v1/storage/admin', { op: 'nope' }), { ok: false, why: 'unknown op: nope' });
  await call('/v1/storage/open', { id: BOX, by: '' });
  ok('the cache exists before the rollback', existsSync(join(xdir, `${BOX}.bin`)), true);
  const rb = await call('/v1/storage/admin', { op: 'rollback', id: BOX, version: 1, admin: 'owner' });
  ok('admin rollback', rb.ok, true);
  ok('and the cache is gone', existsSync(join(xdir, `${BOX}.bin`)), false);
  const back = await call('/v1/storage/open', { id: BOX, by: '' });
  ok('the next open rebuilds it with the rolled-back roots', [back.ok, back.roots], [true, 3]);
  const gift = await call('/v1/storage/admin', { op: 'give', id: BOX, type: 'Rag', qty: 2, admin: 'owner' });
  ok('admin give', gift.ok, true);
  const withGift = await call('/v1/storage/open', { id: BOX, by: '' });
  ok('the next open has the gift', [withGift.ok, withGift.roots], [true, 4]);
  // A server's first poll starts at the current push cursor, so the game
  // must have polled once before a command is queued for it.
  const pollOnce = (fresh) => fetch(`${BASE}/v1/poll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ Secret: SECRET, ServerId: 'storage-test', Cursor: 0, Fresh: fresh, Uids: [], Mirrors: [] }),
  }).then((r) => r.json());
  await pollOnce(true);
  const liveClose = await call('/v1/storage/admin', { op: 'close', id: BOX, admin: 'owner' });
  ok('admin close answers a ref', [liveClose.ok, typeof liveClose.ref], [true, 'string']);
  const polled = await pollOnce(false);
  const storageItems = (polled.Items || []).filter((i) => i.Kind === 'storage').map((i) => JSON.parse(i.Json));
  ok('the poll carries the command to the game', storageItems.map((i) => [i.cmd, i.id, i.by, i.token === liveClose.ref]), [['close', BOX, 'owner', true]]);
  ok('the result is not there until the engine answers', await call('/v1/storage/admin', { op: 'result', ref: liveClose.ref }), { ok: true, result: null });
  await call('/v1/storage/events', { events: [{ at: '2026-09-19 05:40:00', kind: 'admin_result', box: BOX, note: `${liveClose.ref}: ok closing` }] });
  ok('and is there once it has', (await call('/v1/storage/admin', { op: 'result', ref: liveClose.ref })).result.note, `${liveClose.ref}: ok closing`);
} catch (e) {
  fail++;
  console.log(`  FAIL ${e.message}`);
} finally {
  child.kill();
  await new Promise((r) => child.once('exit', r));
  for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
  rmSync(xdir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
