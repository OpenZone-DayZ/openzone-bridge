// A code review of the OpenZone PDA mod (2026-09-28) asked for four additive
// changes to the game-facing chat contract, implemented opposite an engineer
// changing the PDA side at the same time -- every existing field stays:
//
//  4a. An anonymous zone line carries Anon: true, in the push and in every
//      view that lists lines (open, older) -- and a line stored before the
//      field existed is still recognised by its placeholder Who.
//  4b. A chat push's Json is Text wrapped in several other fields; when the
//      whole object would clear the engine's 1023-byte ceiling on a string
//      value, Text gives way and Clipped: true says so. The stored line
//      itself is never touched -- open still serves it whole.
//  4c. A group-invite toast carries Kind: 'invite' and Title, additively --
//      Text is exactly what it always was, for a client that does not know
//      the new fields yet.
//  4d. Members (and a line's Who) no longer fall back to the raw Steam64
//      when nobody has a name for someone; empty instead.
//
// Same harness as no-bot.mjs: the real entry point, in a child process, with
// an empty DISCORD_BOT_TOKEN. None of this depends on a Discord application.
// Its own port, its own throwaway database, its own secret.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { stamp } from '../src/clip.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = join(tmpdir(), `oz-chat-push-contract-${process.pid}.sqlite`);
const SECRET = 'chat-push-contract-test-secret';
const SERVER = 'chat-push-contract-test';

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

console.log('the game-facing chat contract (review 2026-09-28)');

const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;

const A = '76561100000020001'; // sends the anonymous zone line
const B = '76561100000020002'; // reads the zone as a stranger
const D1 = '76561100000020101'; // a direct conversation, for the clip test
const D2 = '76561100000020102';
const G1 = '76561100000020201'; // the invite toast
const G2 = '76561100000020202';
const M1 = '76561100000020301'; // never named, never linked

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
    body: JSON.stringify({ Secret: SECRET, ServerId: SERVER, Json: json }),
  });
  const body = await r.json();
  if (r.status !== 200) throw new Error(`${path} -> ${r.status} ${JSON.stringify(body)}`);
  return body;
}

function poll(cursor, uids, fresh = false) {
  return fetch(`${BASE}/v1/poll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ Secret: SECRET, ServerId: SERVER, Cursor: cursor, Uids: uids, Fresh: fresh }),
  }).then((r) => r.json());
}

try {
  await ready();

  // A cursor of exactly 0 reads as "a server with no history yet" no matter
  // what Fresh says (index.js drain: replay = !Fresh && from > 0) -- true of
  // a real server by the time anybody polls it, never true of this throwaway
  // database until something primes it. One throwaway line first, so every
  // baseline cursor taken below is the kind a real poll would ever see.
  await call('/v1/chat/send', { Uid: A, Name: 'Гравець', Id: 'zone', Text: '(prime)' });

  console.log('--- 4a: an anonymous zone line ---');
  const base = await poll(0, [B], true);
  await call('/v1/chat/send', { Uid: A, Name: 'Гравець', Id: 'zone', Text: 'Хто тут? 4a-1', Anon: true });
  const afterAnon = await poll(base.Cursor, [B], false);
  const pushedAnon = afterAnon.Items
    .filter((i) => i.Kind === 'chat')
    .map((i) => JSON.parse(i.Json))
    .find((l) => l.Text === 'Хто тут? 4a-1');
  ok('the push shows a stranger the placeholder name', pushedAnon?.Who, 'Невідомий сталкер');
  ok('carries no author', pushedAnon?.AUid, '');
  ok('and is flagged anonymous', pushedAnon?.Anon, true);

  const openedAnon = await call('/v1/chat/open', { Uid: B, Id: 'zone', Limit: 5 });
  const lineAnon = openedAnon.Lines.find((l) => l.Text === 'Хто тут? 4a-1');
  ok('open flags it too', lineAnon?.Anon, true);

  await call('/v1/chat/send', { Uid: A, Name: 'Гравець', Id: 'zone', Text: 'Звичайна фраза 4a-2' });
  const openedPlain = await call('/v1/chat/open', { Uid: B, Id: 'zone', Limit: 5 });
  const linePlain = openedPlain.Lines.find((l) => l.Text === 'Звичайна фраза 4a-2');
  ok('an ordinary line is not flagged', linePlain?.Anon, false);
  ok("and keeps the sender's name", linePlain?.Who, 'Гравець');

  console.log('--- 4a: a line stored before the field existed ---');
  {
    // Bypasses the route on purpose: this is what pre-fix data looks like,
    // written the way the pre-fix code always wrote it -- no anon field, just
    // the placeholder name. WAL takes a second writer; the running bridge is
    // untouched by opening its own database file a second time (roundtrip.mjs
    // does the same in its teardown).
    const side = new Store(db);
    side.addMessage('zone', {
      id: 'legacy-anon-1', at: stamp(), uid: null, who: 'Невідомий сталкер',
      text: 'Стара анонімна лінія', fromDiscord: false, inDiscord: false,
    });
    side.close();
  }
  const openedLegacy = await call('/v1/chat/open', { Uid: B, Id: 'zone', Limit: 10 });
  const legacy = openedLegacy.Lines.find((l) => l.Text === 'Стара анонімна лінія');
  ok('a legacy line with no anon field is still recognised by its placeholder name',
    legacy?.Anon, true);

  console.log("--- 4b: a push that would clear the engine's ceiling clips Text, not the store ---");
  await call('/v1/chat/start', { Uid: D1, Name: 'П3', OtherUid: D2, OtherName: 'П4' });
  const dKey = `d:${D1 < D2 ? D1 : D2}:${D1 < D2 ? D2 : D1}`;
  const baseD = await poll(0, [D2], true);
  // byteClip caps the STORED text at 500 chars / 1000 bytes on the way in;
  // wrapping those 1000 bytes in Uid/Id/At/Who/Mine/AUid/Kind/Title/Anon is
  // what pushes the whole envelope past the engine's ceiling.
  const longText = 'я'.repeat(600);
  await call('/v1/chat/send', { Uid: D1, Name: 'П3', Id: dKey, Text: longText });
  const afterLong = await poll(baseD.Cursor, [D2], false);
  const pushedLong = afterLong.Items.filter((i) => i.Kind === 'chat').find((i) => {
    try { return JSON.parse(i.Json).Id === dKey; } catch { return false; }
  });
  ok('the push item exists', !!pushedLong, true);
  ok('the whole envelope stays at or under the ceiling',
    Buffer.byteLength(pushedLong?.Json || '', 'utf8') <= 1000, true);
  const parsedLong = JSON.parse(pushedLong.Json);
  ok('and says so', parsedLong.Clipped, true);
  ok('Text is what gave up the room', parsedLong.Text.length < 500, true);

  const openedD = await call('/v1/chat/open', { Uid: D2, Id: dKey, Limit: 5 });
  ok('the stored line was never touched -- open serves it whole',
    openedD.Lines.at(-1)?.Text, 'я'.repeat(500));

  console.log('--- 4c: a group-invite toast names itself ---');
  const grp = await call('/v1/chat/group_new', { Uid: G1, Title: 'Барахолка' });
  const baseG = await poll(0, [G2], true);
  await call('/v1/chat/group_add', { Uid: G1, Id: grp.Id, OtherUid: G2 });
  const afterInvite = await poll(baseG.Cursor, [G2], false);
  const pushedInvite = afterInvite.Items
    .map((i) => { try { return JSON.parse(i.Json); } catch { return null; } })
    .find((l) => l?.Kind === 'invite');
  ok('the toast is there', !!pushedInvite, true);
  ok('addressed to the invitee', pushedInvite?.Uid, G2);
  ok('names the group', pushedInvite?.Title, 'Барахолка');
  ok('and keeps the old free-text line for a client that does not know Kind yet',
    pushedInvite?.Text, 'Запрошення до групи «Барахолка»');

  console.log("--- 4d: nobody's Steam64 is shown for a name nobody knows ---");
  const soloGrp = await call('/v1/chat/group_new', { Uid: M1, Title: 'Нікому не відомий' });
  const openedSolo = await call('/v1/chat/open', { Uid: M1, Id: soloGrp.Id });
  ok("a member with no game name and no link shows empty, not his Steam64",
    openedSolo.Members, ['']);
} catch (err) {
  fail++;
  console.log(`  FAIL ${err.message}\n${err.stack}`);
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 300));
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(db + suffix); } catch { /* never written */ }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
