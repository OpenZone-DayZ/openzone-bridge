// End-to-end check against a running bridge and a real guild.
//
// Proves the one thing that matters for a Discord-first chat: a message the
// game sends is not in the conversation until DISCORD hands it back. So we
// send, then poll, and the poll is what confirms it — not the send's own reply.
//
//   node test/roundtrip.mjs
//
// Reads the secret from .env; it is never printed.
//
// IT CLEANS UP AFTER ITSELF, and it has to. This ran as an ordinary server
// under the stand's own id and left its fake characters, their conversations
// and a group called «Звалище» in the live base on every single run.
//
// Two halves to that. The ServerId is this test's own, so the bridge has
// never heard it declare a mirror and nothing here reaches the guild at all
// (a conversation gets a Discord thread only where chat is mirrored). And
// what it wrote into the base it deletes at the end, through the same store
// the running bridge has open -- SQLite in WAL mode takes a second writer.

import 'dotenv/config';
import { Store } from '../src/store.js';

const BASE = `http://127.0.0.1:${process.env.BRIDGE_PORT || 8787}`;
const SECRET = process.env.OZ_SHARED_SECRET;
// Not the stand's id: a server the bridge has not met mirrors nothing.
const SERVER = 'roundtrip-test';

const A = { uid: '76561100000000001', name: 'Bродяга' };
const B = { uid: '76561100000000002', name: 'Сидорович' };

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
  return fetch(BASE + '/v1/poll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ Secret: SECRET, ServerId: SERVER, Cursor: cursor, Uids: uids, Fresh: fresh }),
  }).then((r) => r.json());
}

function ok(label, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) process.exitCode = 1;
}

console.log('--- start a direct conversation ---');
const started = await call('/v1/chat/start', {
  Uid: A.uid, Name: A.name, OtherUid: B.uid, OtherName: B.name,
});
ok('thread created', !!started.Id, started.Id);
const key = started.Id;

console.log('--- both sides see it in their list ---');
const listA = await call('/v1/chat/list', { Uid: A.uid });
const listB = await call('/v1/chat/list', { Uid: B.uid });
ok('A sees the conversation', listA.Items.some((i) => i.Id === key));
ok('B sees the same one', listB.Items.some((i) => i.Id === key));

console.log('--- a fresh poll hands over the cursor, not the history ---');
// A game server that has just booted holds no cursor. It used to be answered
// with everything the store remembers for every player it named, in one
// batch of RPCs, while it was still starting up.
const firstPoll = await poll(0, [A.uid, B.uid], true);
// A conversation line names its conversation; a one-shot toast (an invite
// waiting from an earlier run) rides the same pipe with an empty Id and is
// not history.
const replayed = firstPoll.Items
  .filter((i) => i.Kind === 'chat')
  .map((i) => JSON.parse(i.Json))
  .filter((l) => l.Id);
ok('a fresh poll carries no chat history',
  replayed.length === 0, `${firstPoll.Items.length} item(s), ${replayed.length} of them history`);
ok('and says where the stream is', Number.isInteger(firstPoll.Cursor) && firstPoll.Cursor > 0, String(firstPoll.Cursor));

console.log('--- send from the game ---');
// The probe text carries a per-run nonce: identical texts across runs let a
// LATE Discord echo of the previous run claim this run's expect, and the
// line lands unowned (measured 2026-08-30: reruns flipped Mine/name).
const probe = `Перевірка зв'язку ${Date.now().toString(36)}. Чути?`;
await call('/v1/chat/send', { Uid: A.uid, Name: A.name, Id: key, Text: probe });

console.log('--- poll: the message arrives only once Discord has it ---');
const t0 = Date.now();
const batch = await poll(firstPoll.Cursor, [A.uid, B.uid]);
const held = Date.now() - t0;

// CHAT lines only: a fresh server id is also handed the roster and the role
// projections in the same batch, and those carry no Uid (measured 2026-09-03:
// a bridge restart before the run put four roster parts in the batch and the
// "both members" set counted an undefined third member).
const lines = batch.Items.filter((i) => i.Kind === 'chat').map((i) => JSON.parse(i.Json));
ok('poll returned the message', lines.some((l) => l.Text.includes(probe)), `${held} ms, ${batch.Items.length} item(s)`);
ok('it is addressed to both members', new Set(lines.map((l) => l.Uid)).size === 2);

// Other conversations may have moved while this ran, so pick OUR line rather
// than merely the first one addressed to A.
const mineForA = lines.find((l) => l.Uid === A.uid && l.Text.includes(probe));
ok('A sees it as their own', mineForA?.Mine === true);
ok('the speaker kept their name', mineForA?.Who === A.name, mineForA?.Who);

console.log('--- read the thread back ---');
const open = await call('/v1/chat/open', { Uid: B.uid, Id: key, Limit: 20 });
ok('B can open it', open.Id === key, open.Title);
ok('the line is in the history', open.Lines.some((l) => l.Text.includes(probe)));
ok('and is NOT B own', open.Lines.at(-1)?.Mine === false);

console.log('--- a stranger cannot open it ---');
const stranger = await call('/v1/chat/open', { Uid: '76561100000000009', Id: key, Limit: 5 });
ok('refused', !!stranger.Error, stranger.Error);

console.log('--- group ---');
const grp = await call('/v1/chat/group_new', { Uid: A.uid, Title: 'Звалище' });
ok('group created', !!grp.Id, grp.Id);
const add = await call('/v1/chat/group_add', { Uid: A.uid, Id: grp.Id, OtherUid: B.uid });
ok('B invited', add.ok === true);
// Nobody lands in a group unasked: the add only files an invite, so the
// group stays closed to B until B accepts it himself.
const early = await call('/v1/chat/open', { Uid: B.uid, Id: grp.Id });
ok('B cannot open before accepting', early.Error === 'no_chat');
const accept = await call('/v1/chat/invite_accept', { Uid: B.uid, Id: grp.Id });
ok('B accepted the invite', accept.ok === true);
const grpOpen = await call('/v1/chat/open', { Uid: B.uid, Id: grp.Id });
ok('B can open the group', grpOpen.Id === grp.Id, grpOpen.Title);

console.log('--- link status of an unlinked player ---');
const st = await call('/v1/link/status', { Uid: A.uid });
ok('not linked yet', st.Linked === false);
const begin = await call('/v1/link/begin', { Uid: A.uid });
ok('link url issued', begin.Url.startsWith('https://discord.com/api/oauth2/authorize'));

console.log('--- a wrong secret is refused ---');
const bad = await fetch(BASE + '/v1/chat/list', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ Secret: 'nope', ServerId: SERVER, Json: { Uid: A.uid } }),
});
ok('403', bad.status === 403);

console.log('--- and the base is left as it was found ---');
{
  // The same file the bridge is serving from, opened a second time: WAL
  // makes that safe, and the bridge holds no conversation in memory.
  const store = new Store(process.env.BRIDGE_DB || './state/bridge.sqlite');
  let gone = 0;
  for (const k of [key, grp.Id]) if (store.dropConvo(k)) gone++;
  for (const uid of [A.uid, B.uid]) store.forgetName(uid);
  const left = store.convosAll().filter((c) => c.members?.some((m) => m === A.uid || m === B.uid));
  store.close();
  ok('the conversations this run made are gone', gone === 2, `${gone} dropped`);
  ok('and nothing of its characters is left behind', left.length === 0, `${left.length} left`);
}

