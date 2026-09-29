// A code review of the OpenZone PDA mod (2026-09-28) verified three defects
// in how permadeath cleans up chat state:
//
//  1. group_new's ceiling counted a group by its KEY'S prefix, which never
//     changes once minted -- so a deleted (archived) group, or one whose
//     founding had already passed to somebody else on an earlier wipe, kept
//     counting against the uid that used to found it. Create, delete, two
//     groups (the usual ceiling) then left groups_full forever.
//  2. A group invite is keyed by Steam64, and wipePlayer never dropped the
//     ones addressed to the uid it just wiped -- so the next character on
//     the same account could accept an invitation that was never sent to him.
//  3. An npc pager thread is keyed by npc id and Steam64 alone, both of which
//     survive a permadeath -- so the next character inherited a dead man's
//     quest dialogue, and the next /v1/npc/say appended onto it.
//
// Same harness as no-bot.mjs: the real entry point, in a child process, with
// an empty DISCORD_BOT_TOKEN. The property under test is what the STORE does
// across a wipe, and none of it depends on a Discord application existing.
// Its own port, its own throwaway database, its own secret.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = join(tmpdir(), `oz-permadeath-cleanup-${process.pid}.sqlite`);
const SECRET = 'permadeath-cleanup-test-secret';
const SERVER = 'permadeath-cleanup-test';

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

// A port nobody is on, asked for by binding zero and letting go.
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

console.log('permadeath cleans up what it leaves behind');

const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;

// One range per scenario, so a failing assertion's uid says which one it
// belongs to.
const X = '76561100000010001'; // ceiling: an archived group, then a transfer
const Y = '76561100000010002';
const P = '76561100000010101'; // an invite addressed to a wiped uid
const Q = '76561100000010102';
const N = '76561100000010201'; // an npc pager thread

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
    // Nothing here waits on a long poll -- every assertion already knows
    // what it is looking for -- so hold it for a second, not the usual eight.
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

try {
  await ready();

  console.log('--- 1: the ceiling ignores an archived group ---');
  const g1 = await call('/v1/chat/group_new', { Uid: X, Title: 'Перший', Max: 2 });
  ok('group 1 founded', !!g1.Id, true);
  const g2 = await call('/v1/chat/group_new', { Uid: X, Title: 'Другий', Max: 2 });
  ok('group 2 founded', !!g2.Id, true);
  ok('a third hits the ceiling',
    await call('/v1/chat/group_new', { Uid: X, Title: 'Третій', Max: 2 }), { Error: 'groups_full' });

  ok('the founder deletes the first', await call('/v1/chat/group_del', { Uid: X, Id: g1.Id }), { ok: true });
  const g3 = await call('/v1/chat/group_new', { Uid: X, Title: 'Третій', Max: 2 });
  ok('deleting one frees the seat the archived row used to hold forever', !!g3.Id, true);

  console.log('--- 1: the ceiling ignores a group whose founding moved on ---');
  // Y joins g2, so wiping X leaves somebody left for founding to pass to.
  await call('/v1/chat/group_add', { Uid: X, Id: g2.Id, OtherUid: Y });
  await call('/v1/chat/invite_accept', { Uid: Y, Id: g2.Id });
  ok('X is wiped', await call('/v1/player/wipe', { Uid: X, FromGame: true }), { Ok: true, Why: '' });
  // Both preconditions proven directly, not assumed, before the ceiling
  // check that depends on them means anything.
  ok('g2 passed to Y, not X', (await call('/v1/chat/open', { Uid: Y, Id: g2.Id })).Owner, true);
  ok('g3 had nobody left and is gone outright', (await call('/v1/chat/open', { Uid: X, Id: g3.Id })).Error, 'no_chat');

  const g4 = await call('/v1/chat/group_new', { Uid: X, Title: 'Четвертий', Max: 2 });
  ok('X (same uid, next character) founds again at zero, not at two', !!g4.Id, true);

  console.log('--- 2: an invite addressed to a wiped uid does not survive him ---');
  const g5 = await call('/v1/chat/group_new', { Uid: P, Title: "П'ятий" });
  await call('/v1/chat/group_add', { Uid: P, Id: g5.Id, OtherUid: Q });
  ok('the invite is filed', (await call('/v1/chat/list', { Uid: Q })).Invites.some((i) => i.Id === g5.Id), true);

  await call('/v1/player/wipe', { Uid: Q, FromGame: true });
  ok('it is gone from his list', (await call('/v1/chat/list', { Uid: Q })).Invites.some((i) => i.Id === g5.Id), false);
  ok('and cannot be accepted by his next character',
    await call('/v1/chat/invite_accept', { Uid: Q, Id: g5.Id }), { Error: 'no_chat' });

  console.log('--- 3: an npc pager thread does not survive its player ---');
  const npcKey = `npc:barman:${N}`;
  await call('/v1/npc/say', { NpcId: 'barman', Name: 'Бармен', Uid: N, Text: 'Перша репліка.' });
  const first = await call('/v1/chat/open', { Uid: N, Id: npcKey });
  ok('the first line is there', first.Lines?.map((l) => l.Text), ['Перша репліка.']);

  await call('/v1/player/wipe', { Uid: N, FromGame: true });
  ok('the old thread is gone', (await call('/v1/chat/open', { Uid: N, Id: npcKey })).Error, 'no_chat');

  await call('/v1/npc/say', { NpcId: 'barman', Name: 'Бармен', Uid: N, Text: 'Друга репліка.' });
  const second = await call('/v1/chat/open', { Uid: N, Id: npcKey });
  ok('the next character starts a fresh, empty thread -- not appended to',
    second.Lines?.map((l) => l.Text), ['Друга репліка.']);
  ok('and it is not listed twice',
    (await call('/v1/chat/list', { Uid: N })).Items.filter((i) => i.Id === npcKey).length, 1);
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
