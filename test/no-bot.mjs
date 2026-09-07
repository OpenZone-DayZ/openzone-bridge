// THE BRIDGE WITHOUT A DISCORD BOT (TZ-2 R2.6, acceptance 10.11).
//
// The property under test is that the whole HTTP side -- chat, groups, the
// wipe, the news feed -- does not depend on a Discord application existing.
// So this boots the REAL entry point in a child process with an empty
// DISCORD_BOT_TOKEN and talks to it over the socket, rather than importing
// pieces: "the bridge starts" is exactly the thing that used to be false, and
// only a start can prove it.
//
// dotenv does not overwrite a variable that is already set, and an empty
// string counts as set -- which is how the token in .env is kept out of the
// child without touching the file.
//
// It also proves the founder's succession (TZ-5 R-F4.4/R-F4.5): a group whose
// founder is wiped passes to the longest-standing member left, and goes away
// entirely when nobody is left. That path has no Discord in it at all, which
// is why it can be driven here.
//
// Its own port, its own throwaway database, its own secret. Touches neither
// the guild nor the running bridge.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = join(tmpdir(), `oz-no-bot-${process.pid}.sqlite`);
const SECRET = 'no-bot-test-secret';

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

console.log('the bridge runs without a Discord bot');

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
    // The old JSON document may still sit beside the real database; this one
    // is new by definition, and the refusal to start beside an unmigrated
    // document is not what is under test here.
    BRIDGE_DB_FRESH: '1',
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
    body: JSON.stringify({ Secret: SECRET, ServerId: 'no-bot-test', Json: json }),
  });
  const body = await r.json();
  if (r.status !== 200) throw new Error(`${path} -> ${r.status} ${JSON.stringify(body)}`);
  return body;
}

const A = '76561100000000101';
const B = '76561100000000102';
const C = '76561100000000103';

try {
  await ready();

  ok('it starts and serves HTTP with no token', true, true);
  ok('and says so in one line, naming the mode',
    log.includes('[discord] no bot token'), true);

  // ---- /v1/ping tells the two failures apart (R2.6) ----
  const ping = await fetch(`${BASE}/v1/ping`).then((r) => r.json());
  ok('ping answers without a secret', ping.ok, true);
  ok('and carries discord: false', ping.discord, false);

  // ---- the doors that need a guild refuse in words ----
  ok('/link has nobody to redeem a code',
    await call('/v1/link/begin', { Uid: A }), { Error: 'discord_off' });

  const fill = await call('/v1/mirror/fill', { Kind: 'chat' });
  ok('a mirror cannot be filled', fill.Ok, false);
  ok('and the reason names Discord, not a dead bridge',
    /Discord is not configured/.test(fill.Why), true);

  // ---- chat, groups and the wipe run entirely on the store ----
  await call('/v1/chat/start', { Uid: A, Name: 'Bродяга', OtherUid: B, OtherName: 'Сидорович' });
  const list = await call('/v1/chat/list', { Uid: A });
  ok('a direct conversation exists with no thread anywhere',
    list.Items.some((i) => i.Kind === 'direct'), true);
  ok('and the zone is there too -- the town square needs no channel',
    list.Items.some((i) => i.Kind === 'zone'), true);

  ok('a broken contact still freezes the pair',
    await call('/v1/chat/pair_freeze', { A, B }), { ok: true });
  ok('and a frozen pair refuses new lines',
    (await call('/v1/chat/send', { Uid: A, Name: 'Bродяга', Id: `d:${A < B ? A : B}:${A < B ? B : A}`, Text: 'hello' })).Error,
    'read_only');

  const grp = await call('/v1/chat/group_new', { Uid: A, Title: 'Звалище' });
  ok('a group is founded', !!grp.Id, true);

  for (const who of [B, C]) {
    await call('/v1/chat/group_add', { Uid: A, Id: grp.Id, OtherUid: who });
    await call('/v1/chat/invite_accept', { Uid: who, Id: grp.Id });
  }

  ok('the founder owns it', (await call('/v1/chat/open', { Uid: A, Id: grp.Id })).Owner, true);
  ok('a member does not', (await call('/v1/chat/open', { Uid: B, Id: grp.Id })).Owner, false);
  ok('and a member cannot delete it',
    (await call('/v1/chat/group_del', { Uid: B, Id: grp.Id })).Error, 'not_owner');

  // ---- founding passes on a permadeath (R-F4.4/R-F4.5, H36) ----
  ok('the founder is wiped', await call('/v1/player/wipe', { Uid: A, FromGame: true }), { Ok: true, Why: '' });
  ok('the group is not his any more',
    (await call('/v1/chat/open', { Uid: A, Id: grp.Id })).Error, 'no_chat');
  ok('founding passed to the longest-standing member left',
    (await call('/v1/chat/open', { Uid: B, Id: grp.Id })).Owner, true);
  ok('who is now the one who can delete it -- and C cannot',
    (await call('/v1/chat/group_del', { Uid: C, Id: grp.Id })).Error, 'not_owner');

  await call('/v1/player/wipe', { Uid: B, FromGame: true });
  ok('it passes again rather than becoming ownerless',
    (await call('/v1/chat/open', { Uid: C, Id: grp.Id })).Owner, true);

  await call('/v1/player/wipe', { Uid: C, FromGame: true });
  ok('with nobody left the group is gone, not orphaned',
    (await call('/v1/chat/open', { Uid: C, Id: grp.Id })).Error, 'no_chat');

  // ---- the news feed answers, paged, with no forum to read ----
  const news = await call('/v1/news/list', {});
  ok('the feed answers a page', Array.isArray(news.Items), true);
  ok('and says whether there is another', news.Next, '');
} catch (err) {
  fail++;
  console.log(`  FAIL ${err.message}`);
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 300));
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(db + suffix); } catch { /* never written */ }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
