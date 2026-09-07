// TZ-2 R1.1: news live in the bot's store, Discord is a surface.
//
// Owner's decision 2026-09-01: "пусть бот держит и новости у себя в базе, а
// дискорд -- только миррор". Before that the index lived in memory only and
// was rebuilt from Discord on every start, which meant a bot that could not
// reach the guild had no news at all -- the feed was exactly as optional as
// Discord was, which is the thing TZ-2 exists to stop being true.
//
// The property under test is therefore precise: news must exist BEFORE
// Discord is asked anything. So this never constructs a client and never
// calls start(); it builds News over a store and reads it.
//
// Runs against a throwaway state file. Touches neither Discord nor the stand.

import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { News, chunkBody, CHUNK_MAX } from '../src/news.js';

const path = join(tmpdir(), `oz-news-home-${process.pid}.json`);
if (existsSync(path)) unlinkSync(path);

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

function post(id, title, ts) {
  return { Id: id, Title: title, Who: 'admin', At: '2026-09-01 12:00:00', ts, Body: `body of ${title}`, Replies: 0 };
}

console.log('news live in the store');

const store = new Store(path, 100);
store.newsPut(post('1', 'older', 1000));
store.newsPut(post('2', 'newer', 2000));

// No client, no start(): Discord is never contacted.
const news = new News(store);

ok('a fresh News over a store already has the posts',
  news.list().Items.map((p) => p.Title), ['newer', 'older']);

ok('newest first, by timestamp',
  news.list().Items[0].Title, 'newer');

// The body rides as an ARRAY of chunks (TZ-5 R-D1.4): no single JSON string
// value can be longer than 1023 bytes on the game's parse side, so the one
// thing a long post cannot be is one string. A short body is one chunk.
ok('open() returns the body without Discord',
  news.open('1').Body, ['body of older']);

ok('an unknown id still refuses',
  news.open('nope'), { Error: 'no_post' });

// A body written before R-D1.4, read back from a database that holds one
// string: converted on read, never a crash and never a lost post.
ok('a stored string body reads back as chunks',
  new News(new Store(path, 100)).open('2').Body, ['body of newer']);

// A second process over the same file sees the same feed -- that is what
// "home" means, as opposed to a cache that dies with the process.
//
// No flush step: a write is on disk by the time the store's method returns,
// which is one of the three things TZ-2 R6.1 wanted a real database for.
const again = new News(new Store(path, 100));
ok('the feed survives a restart with Discord unreachable',
  again.list().Items.map((p) => p.Title), ['newer', 'older']);

// ALL OF THEM, AND FOREVER (TZ-5 R-D1.1, owner 2026-09-01). A ring buffer of
// fifty stood here, in News and in the store both; a post past the fiftieth
// stopped existing for the game and no restart brought it back.
store.newsPut(post('3', 'third', 3000));
{
  for (let i = 4; i < 60; i++) store.newsPut(post(String(i), `p${i}`, 3000 + i));

  const feed = new News(new Store(path, 100));
  ok('nothing is evicted -- 59 posts stay 59 posts',
    feed.list('', 100).Items.length, 59);

  // A PAGE, AND A CURSOR THAT IS A FACT (R-D1.2): Next is empty only at the
  // real bottom, and paging with it walks the feed exactly once.
  const p1 = feed.list('', 10);
  ok('a page is as long as it was asked to be', p1.Items.length, 10);
  ok('and it says where the next one starts', p1.Next !== '', true);

  const seen = [];
  let cursor = '';
  for (let guard = 0; guard < 20; guard++) {
    const page = feed.list(cursor, 10);
    for (const it of page.Items) seen.push(it.Id);
    cursor = page.Next;
    if (!cursor) break;
  }
  ok('paging by cursor walks the whole feed', seen.length, 59);
  ok('and never repeats a post', new Set(seen).size, 59);
  ok('newest first across pages', seen[0], '59');

  ok('a page in the middle is not a restart', feed.list(p1.Next, 10).Restarted, false);

  // A cursor naming a post deleted since starts over rather than answering
  // an empty page for a feed that is not empty -- AND SAYS IT STARTED OVER.
  //
  // Without the word the PDA appends: it asked for what comes after row 30
  // and got rows 1..5, which it inserts under the thirty already on screen.
  // The newest posts then appear twice, and the reader has no way to tell
  // which half is real. Next goes empty with it, because the walk that
  // cursor belonged to no longer exists.
  const stale = feed.list('999999:gone', 5);
  ok('a stale cursor is not an empty feed', stale.Items.length, 5);
  ok('it is the top of the feed again', stale.Items[0].Id, '59');
  ok('and it says so, so the page replaces rather than appends', stale.Restarted, true);
  ok('with no Next to continue a walk that is over', stale.Next, '');
}

// AN EDIT AND A DELETE ARE NEWS TOO.
//
// The game caches v1/news/list and v1/news/open for a minute and forgets them
// when a poll envelope of kind "news" arrives. Only a genuinely new post used
// to push one, so an edited -- or deleted -- post stayed on every PDA for the
// full TTL. Still no Discord here: the two doors those event handlers call are
// public for exactly this reason.
//
// Last in the file: dropping a post touches the store the assertions above
// read.
const rung = [];
news.onNews = (p, fresh) => rung.push([p.Id, fresh]);

news.edit('1', 'a corrected body', 'admin');
ok('an edited body rings, and not as a fresh post', rung, [['1', false]]);
ok('the edit is what open() serves', news.open('1').Body, ['a corrected body']);

news.edit('1', 'a corrected body', 'admin');
ok('the same body again rings nothing', rung.length, 1);

// THE STARTER WAS DELETED IN DISCORD (R-D1.3, H24), which is not the same
// fact as a post with nothing written in it: the page has to be able to say
// so, and it needs to be told which of the two this is.
news.starterGone('1');
ok('a deleted starter empties the body', news.open('1').Body, []);
ok('and says it was deleted', news.open('1').Deleted, true);
ok('a post with a body is not "deleted"', news.open('2').Deleted, false);
ok('the deletion rings the feed', rung.length, 2);

news.drop('2');
ok('a deleted post rings', rung.length, 3);
ok('and it is gone from the list',
  news.list().Items.filter((p) => p.Id === '2').length, 0);

news.drop('2');
ok('dropping what is already gone rings nothing', rung.length, 3);

// ---- the cut itself (R-D1.5) ----
//
// On LINE boundaries, never mid-word, and never over CHUNK_MAX bytes.
{
  const lines = [];
  for (let i = 0; i < 60; i++) lines.push(`рядок ${i} про Зону та все, що в ній діється`);
  const cut = chunkBody(lines.join('\n'));

  ok('a long body becomes several chunks', cut.length > 1, true);
  ok('no chunk is over the ceiling',
    cut.every((c) => Buffer.byteLength(c, 'utf8') <= CHUNK_MAX), true);
  ok('gluing them back gives the original', cut.join(''), lines.join('\n'));
  ok('every cut lands on a line boundary',
    cut.slice(0, -1).every((c) => c.endsWith('\n')), true);

  // One line longer than a chunk on its own: there is no boundary to use, so
  // the byte-safe clip takes over and no glyph is halved.
  const huge = chunkBody('я'.repeat(1500));
  ok('one over-long line is split without breaking a character',
    huge.join(''), 'я'.repeat(1500));
  ok('and still respects the ceiling',
    huge.every((c) => Buffer.byteLength(c, 'utf8') <= CHUNK_MAX), true);

  ok('an empty body is no chunks at all', chunkBody(''), []);

  // THE CHUNK IS BOUNDED WHERE THE PARSER COUNTS -- ON THE WIRE (note 6).
  //
  // JsonFileLoader keeps 1023 bytes of a JSON string VALUE, and a parser
  // counts the token it reads, escapes and all. A chunk of nothing but
  // newlines doubles: at the old 900 that was 1800 bytes, 777 over. Every
  // chunk of every shape below has to survive JSON.stringify inside 1023.
  const nasty = [
    '\n'.repeat(4000),                              // every byte a two-byte escape
    'x\n'.repeat(2000),                             // 450-lines-of-one-character, at length
    '"'.repeat(4000),                               // quotes escape the same way
    'рядок "з лапками"\t- і табуляція\n'.repeat(200), // a body somebody might write
  ];
  ok('no chunk of any body crosses 1023 bytes once it is escaped',
    nasty.every((body) => chunkBody(body)
      .every((c) => Buffer.byteLength(JSON.stringify(c), 'utf8') <= 1023)), true);
  ok('and every one of them still glues back byte for byte',
    nasty.every((body) => chunkBody(body).join('') === body), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
