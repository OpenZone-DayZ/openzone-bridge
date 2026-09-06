// D77: who said it in history deeper than the store tail.
//
// The live guild on the dev stand has no history older than its own tail, so
// the Discord tier cannot be exercised against it. This drives the same two
// pieces of logic directly: the resolution fetchOlder does per Discord
// message (authorOf) and the attribution the /v1/chat/older route does per
// line (fillFromTail + toLine).
//
// BOTH ARE IMPORTED, NOT COPIED. This file used to carry its own transcript
// of the rule and assert against that -- a test that passes while the code it
// names is broken -- and it read the LIVE stand database with two hard-coded
// ids, so it failed on any other host and after any relink.
//
// Runs against a throwaway store. Touches neither Discord nor the stand.

import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { authorOf } from '../src/discord.js';
import { fillFromTail, toLine } from '../src/history.js';

const path = join(tmpdir(), `oz-older-authorship-${process.pid}.sqlite`);
for (const f of [path, path + '-wal', path + '-shm']) if (existsSync(f)) unlinkSync(f);

let pass = 0;
let fail = 0;
function ok(what, got, want) {
  const good = JSON.stringify(got) === JSON.stringify(want);
  if (good) pass++;
  else {
    fail++;
    console.log(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
    return;
  }
  console.log(`  ok   ${what}`);
}

// A link table of this test's own making.
const LINKED_DISCORD = '242189070724235264';
const LINKED_STEAM = '76561198000000001';
const OTHER_STEAM = '76561198000000002';
const BOT = '999999999999999999';

const store = new Store(path);
store.link(LINKED_STEAM, LINKED_DISCORD, 'linked');

console.log('fetchOlder: who said it');
ok('a linked player typing in Discord resolves to his stalker',
  authorOf({ author: { id: LINKED_DISCORD } }, BOT, store), LINKED_STEAM);
ok('an unlinked Discord account resolves to nobody',
  authorOf({ author: { id: '111111111111111111' } }, BOT, store), '');
ok('a webhook post (a line the game sent) resolves to nobody, never by name',
  authorOf({ webhookId: 'w1', author: { id: BOT } }, BOT, store), '');
ok('the bot speaking as itself resolves to nobody',
  authorOf({ author: { id: BOT } }, BOT, store), '');

// --- what the route does with those uids ---
function attribute(lines, reader, tail) {
  return fillFromTail(lines, tail).map((m) => {
    const l = toLine({ at: m.at, who: m.who, text: m.text, uid: m.uid }, reader);
    return { Who: l.Who, Mine: l.Mine, AUid: l.AUid };
  });
}

console.log('\n/v1/chat/older: attribution');

// The whole point of the defect: a rename must not move history, and a
// namesake must not inherit it.
const renamed = attribute(
  [{ id: '1', who: 'Survivor', uid: LINKED_STEAM }],
  LINKED_STEAM, []);
ok('my own line is mine even though I have since been renamed',
  renamed[0], { Who: 'Survivor', Mine: true, AUid: LINKED_STEAM });

const namesake = attribute(
  [{ id: '2', who: 'Survivor', uid: OTHER_STEAM }],
  LINKED_STEAM, []);
ok('a namesake does NOT inherit my line',
  namesake[0], { Who: 'Survivor', Mine: false, AUid: OTHER_STEAM });

const unknown = attribute(
  [{ id: '3', who: 'Survivor', uid: '' }],
  LINKED_STEAM, []);
ok('an unattributable line is neutral, not mine, not coloured',
  unknown[0], { Who: 'Survivor', Mine: false, AUid: '' });

// The overlap tier: Discord cannot attribute a webhook post, but the tail
// still remembers who sent it.
const filled = attribute(
  [{ id: '4', who: 'Survivor', uid: '' }],
  LINKED_STEAM,
  [{ id: '4', uid: LINKED_STEAM }]);
ok('a game-relayed line still inside the tail is recovered from the tail',
  filled[0], { Who: 'Survivor', Mine: true, AUid: LINKED_STEAM });

// The same line under the two ids it really has: ours in the store, the
// snowflake in Discord. Without the echo's note this one was unknowable.
const bySnowflake = attribute(
  [{ id: '1234567890123456789', who: 'Survivor', uid: '' }],
  LINKED_STEAM,
  [{ id: 'o170000000000000001', uid: LINKED_STEAM, dId: '1234567890123456789' }]);
ok('a line the game sent is recovered through the snowflake the echo noted',
  bySnowflake[0], { Who: 'Survivor', Mine: true, AUid: LINKED_STEAM });

const past = attribute(
  [{ id: '5', who: 'Survivor', uid: '' }],
  LINKED_STEAM,
  [{ id: '4', uid: LINKED_STEAM }]);
ok('a line past the tail stays honest rather than guessing',
  past[0], { Who: 'Survivor', Mine: false, AUid: '' });

store.close();
for (const f of [path, path + '-wal', path + '-shm']) if (existsSync(f)) unlinkSync(f);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
