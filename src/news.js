// News: a Discord FORUM channel read from the game.
//
// The forum finally lands where it belongs (the owner asked about forums
// twice): PUBLIC, admin-authored posts -- announcements, lore, patch news --
// readable from every PDA. Exactly the content forums are for, and exactly
// what the private notebook could not be.
//
// WHERE NEWS LIVE: in the bot's own store. Discord is where they are
// WRITTEN and a surface they also appear on -- owner's decision 2026-09-01:
// the bot keeps the news in its own base and Discord is only a mirror of
// them, which is TZ-2 R1.1 for this kind.
//
// This used to say "Discord is the truth and the ONLY writer", and the index
// lived in MEMORY only, rebuilt from Discord on every start. The cost of that
// was not obvious until TZ-2 named it: a bot that could not reach the guild
// had no news AT ALL, so the feed was exactly as optional as Discord was --
// the thing TZ-2 exists to stop being true.
//
// Now the store owns the posts and the guild refreshes them. A restart with
// Discord unreachable serves what it already had; the warm-up sweep updates
// rather than creates.
//
// Admins still author in Discord: @everyone loses SendMessages and
// SendMessagesInThreads on the channel, so the feed stays clean
// (administrators bypass overwrites). The bot may post too -- game events
// will author news one day.
//
// The post id is the thread snowflake. Unlike chat there is nothing for the
// bot to name itself: the post is created in Discord and arrives with an id.
//
// Listing live on every PDA open would cost ~32 REST calls for 30 posts
// against the global 50/s budget shared with chat; the store pays once.

import { ChannelType } from 'discord.js';
import { byteClip, stamp } from './clip.js';

// ONE CHUNK OF A BODY, IN BYTES (TZ-5 R-D1.5/R-D1.6).
//
// 900, and deliberately the same number as the envelope's own slicing
// (OZ_Const.RPC_STR_CHUNK): two different ceilings for one and the same
// engine limit is a way to miss by a hundred bytes exactly once.
const CHUNK_MAX = 900;

// How many archived pages the warm-up walks. Not a ring buffer -- nothing is
// deleted by it -- only a bound on how much REST one start-up spends.
const WARM_PAGES = 8;

// The text of a post, cut into pieces the game's JSON parser can carry.
//
// WHY AT ALL: JsonFileLoader truncates every JSON STRING VALUE at 1023 bytes
// on the PARSE side (measured on the stand 2026-08-28), so no single string
// field can hold a long post however the envelope is sliced. An ARRAY of
// short strings can, and the client glues it back when it draws (R-D1.4).
//
// ON LINE BOUNDARIES, not on bytes: a cut mid-sentence is what the old
// single-string clip did, and it is what the owner refused. A line longer
// than a whole chunk on its own is the one case where there is no boundary
// to use, and there the byte-safe clip is the fallback -- it steps back over
// UTF-8 continuation bytes, so a glyph is never halved.
export function chunkBody(text) {
  const s = String(text ?? '');
  if (s === '') return [];

  const out = [];
  let cur = '';
  // The newline stays with the line it ends, so gluing is a plain join('').
  const lines = s.split('\n').map((l, i, all) => (i < all.length - 1 ? l + '\n' : l));

  const bytes = (v) => Buffer.byteLength(v, 'utf8');

  for (let line of lines) {
    // A single line that cannot fit a chunk by itself: spend whole chunks on
    // it until what is left does fit.
    while (bytes(line) > CHUNK_MAX) {
      if (cur !== '') { out.push(cur); cur = ''; }
      const head = byteClip(line, CHUNK_MAX);
      out.push(head);
      line = line.slice(head.length);
    }
    if (line === '') continue;
    if (bytes(cur) + bytes(line) > CHUNK_MAX) {
      out.push(cur);
      cur = '';
    }
    cur += line;
  }
  if (cur !== '') out.push(cur);
  return out;
}

// A body read back from a database written before R-D1.4: one string where
// an array now lives. Converted on read, never rewritten in place -- the
// next edit or warm-up writes the new shape anyway.
function asChunks(body) {
  if (Array.isArray(body)) return body;
  return chunkBody(body || '');
}

export class News {
  // The store is the home, and it is not optional: the feed exists so that a
  // bot which cannot reach the guild still has news (TZ-2 R1.1).
  constructor(store) {
    this.discord = null;
    this.channelId = null;
    this.store = store;
    // A read cache, not a second home: every write goes through #keep, which
    // writes the store first. It exists because a PDA opening the feed would
    // otherwise parse fifty rows for a list of titles.
    this.posts = new Map(); // threadId -> { Id, Title, Who, At, ts, Body, Replies }
    for (const p of store.newsAll()) {
      p.Body = asChunks(p.Body);
      this.posts.set(p.Id, p);
    }
    // Ids for posts the bridge mints itself -- a post written from the game
    // with no guild to author it in (R2.6). "n" keeps them apart from
    // Discord's 19-digit thread snowflakes at a glance.
    this.ownSeq = 0;
  }

  #ownId() {
    this.ownSeq = (this.ownSeq + 1) % 100000;
    return `n${Date.now()}${String(this.ownSeq).padStart(5, '0')}`;
  }

  // One place to write, so nothing can update the memory copy and forget
  // the durable one.
  #keep(post) {
    this.posts.set(post.Id, post);
    this.store.newsPut(post);
  }

  // Everything about a post the game can see. A threadUpdate fires on archive
  // flips and other noise the feed does not show, and a poll envelope costs
  // every player's news cache -- so the ring below asks this first.
  #face(p) {
    if (!p) return '';
    // noStarter counts: "no body yet" and "the body was deleted" draw
    // differently on the page (R-D1.3), so the change between them is one
    // the game has to be told about.
    return JSON.stringify([p.Title, p.Who, p.At, p.Replies, p.Body, !!p.noStarter]);
  }

  // TELL THE GAME THE FEED MOVED.
  //
  // The core caches bridge reads and drops them by KIND when a poll envelope
  // arrives (OZ_BridgeCache.Invalidate). Only a genuinely new post used to
  // push one, so an edited -- or a DELETED -- post stayed in v1/news/list and
  // v1/news/open for the full 60 s TTL. Before the cache was made per-kind any
  // chat line cleared everything and hid this.
  //
  // `fresh` separates "a new post" from "a post changed": the first is worth a
  // toast on every PDA, the second is only worth forgetting the cache.
  #ring(post, fresh) {
    if (!post) return;
    this.onNews?.(post, fresh);
  }

  async start(discord, knownId) {
    this.discord = discord;
    const guild = discord.guild;

    const ch = await discord.findOrCreateChannel({
      knownId,
      name: 'новини',
      type: ChannelType.GuildForum,
      topic: 'Новини Зони. Пости пишуть адміністратори; гра читає їх на КПК.',
      reason: 'OpenZone news feed',
    });

    // The two overwrites the bot owns, edited in place. set() replaced the
    // whole list on every start and took an admin's own overwrites with it.
    const reason = 'OpenZone: the news forum the bot owns';
    await ch.permissionOverwrites.edit(guild.roles.everyone.id, {
      SendMessages: false,
      SendMessagesInThreads: false,
    }, { reason });
    await ch.permissionOverwrites.edit(discord.client.user.id, {
      ViewChannel: true,
      ReadMessageHistory: true,
      ManageThreads: true,
      // The bot may post too: game events will author news one day, and the
      // everyone-deny above would bind the bot without this.
      SendMessages: true,
      SendMessagesInThreads: true,
    }, { reason });

    this.channelId = ch.id;
    await this.#warm(ch);

    const c = discord.client;
    // Пост, редагування й видалення однаково застарюють кеш новин у грі;
    // тостом дзвонить лише справді новий -- див. #ring.
    c.on('threadCreate', (th) => this.#onThread(th));
    c.on('threadUpdate', (_o, th) => this.#onThread(th));
    c.on('threadDelete', (th) => this.drop(th.id));
    // The starter message shares the thread's id -- that is how a forum
    // post's body edit is told apart from a mere reply.
    c.on('messageCreate', (m) => { if (m.id === m.channelId) this.edit(m.channelId, m.content, m.member?.displayName || m.author?.username); });
    c.on('messageUpdate', (_o, m) => { if (m && m.id === m.channelId) this.edit(m.channelId, m.content, m.member?.displayName || m.author?.username); });
    // The starter is gone: the post keeps its title and SAYS SO (R-D1.3).
    // This called edit(id, '', '') and left an empty body behind, which the
    // page drew as silence -- a post with nothing in it and no reason given.
    c.on('messageDelete', (m) => { if (m.id === m.channelId) this.starterGone(m.channelId); });

    console.log(`[news] #новини ready, ${this.posts.size} post(s) cached`);
    return ch;
  }

  async #warm(ch) {
    const found = [];
    const act = await ch.threads.fetchActive();
    for (const th of act.threads.values()) found.push(th);

    // Archived come back by archive time, which lies about creation order --
    // we sort by the snowflake timestamp ourselves below.
    let before;
    for (let page = 0; page < WARM_PAGES; page++) {
      const arch = await ch.threads.fetchArchived({ type: 'public', before }).catch(() => null);
      if (!arch || arch.threads.size === 0) break;
      for (const th of arch.threads.values()) found.push(th);
      if (!arch.hasMore) break;
      before = found[found.length - 1].id;
    }

    // EVERY post the guild handed back, and none dropped (R-D1.1). This used
    // to keep the newest fifty and evict the rest from the store as well:
    // a post older than the fiftieth did not exist for the game at all.
    found.sort((a, b) => Number(BigInt(b.id) - BigInt(a.id)));
    for (const th of found) {
      await this.#onThread(th, true);
    }
  }

  // The single writing door: a forum post authored by `who`. Everything else
  // about the feed is read-only, and the channel permissions agree.
  //
  // WITH NO GUILD THE POST STILL LANDS (TZ-2 R1.1 + R2.6). The home of a news
  // post is this bot's own base; Discord is where admins happen to write them
  // and a surface they also appear on. Without a bot there is no webhook and
  // no thread to echo back, so the row is minted here instead -- the feed
  // reads exactly the same from the game either way.
  async post(who, title, body) {
    if (!this.discord?.configured || !this.channelId) {
      const p = {
        Id: this.#ownId(),
        Title: String(title).slice(0, 90),
        Who: String(who),
        ts: Date.now(),
        At: stamp(),
        Body: chunkBody(body),
        Replies: 0,
      };
      this.#keep(p);
      this.#ring(p, true);
      return;
    }

    const ch = await this.discord.client.channels.fetch(this.channelId);
    const hook = await this.discord.webhookFor(ch);
    if (!hook) throw new Error('no webhook on the news forum');

    await hook.send({
      threadName: title.slice(0, 90),
      username: who.slice(0, 80),
      content: byteClip(body, 2000),
    });
  }

  async #onThread(th, warm = false) {
    if (th.parentId !== this.channelId) return;

    const known = this.posts.get(th.id);
    // Taken BEFORE the mutations below, because `post` is `known` itself.
    const was = this.#face(known);
    const post = known || {
      Id: th.id, Title: '', Who: '', At: '', ts: 0, Body: [], Replies: 0,
    };

    post.Title = th.name;
    post.ts = th.createdTimestamp || post.ts;
    post.At = stamp(post.ts);
    // Discord's message_count already excludes the starter message, so it
    // IS the reply count -- subtracting one here ate a reply per post.
    post.Replies = Math.max(0, th.messageCount || 0);

    // ASKED ONCE PER POST, NOT ONCE PER REPLY. threadUpdate fires on every
    // reply in the forum, and a post whose starter message was deleted has
    // no body to find -- so this went back to Discord over REST for that
    // same missing message on every reply to that thread, for ever.
    if (!known || warm || (!post.Body?.length && !post.noStarter)) {
      try {
        const starter = await th.fetchStarterMessage();
        post.Body = chunkBody(starter?.content || '');
        post.Who = starter?.member?.displayName || starter?.author?.username || post.Who;
        post.noStarter = false;
      } catch {
        // Starter deleted: the post keeps its title and an empty body, and
        // we stop asking. An edit to the starter would arrive as its own
        // event (#onStarter), which clears the flag by writing a body.
        post.noStarter = true;
      }
    }

    const fresh = !known;
    this.#keep(post);

    // NOTHING IS EVICTED HERE ANY MORE (R-D1.1, owner 2026-09-01). A ring
    // buffer of fifty posts stood here and in the store beside it: anything
    // older simply stopped existing for the game, and a bot restart could not
    // bring it back. The ceiling was a consequence of the old JSON blob, not
    // a decision -- with SQLite the whole feed is cheap, and /v1/news/list
    // hands it out a page at a time instead.

    // The warm-up sweep is silent on purpose: it runs before the game has
    // asked anything, and fifty envelopes at start-up would be fifty toasts.
    if (!warm && (fresh || this.#face(post) !== was)) this.#ring(post, fresh);
  }

  // The body of a post changed -- the starter message was written, edited, or
  // deleted (empty body). Public because that is what "an edit" is, and it is
  // what the test drives without a Discord client.
  edit(id, body, who) {
    const p = this.posts.get(id);
    if (!p) return;

    const was = this.#face(p);
    p.Body = chunkBody(body || '');
    p.Who = who || p.Who;
    p.noStarter = false;
    this.#keep(p);

    if (this.#face(p) !== was) this.#ring(p, false);
  }

  // The starter message was DELETED in Discord (R-D1.3, H24). Not the same
  // thing as an empty edit: the post keeps its title and says outright that
  // the text is gone, instead of showing a blank page nobody can explain.
  // The words themselves are the client's -- it draws them in the player's
  // own language; the bridge only states the fact.
  starterGone(id) {
    const p = this.posts.get(id);
    if (!p) return;

    const was = this.#face(p);
    p.Body = [];
    p.noStarter = true;
    this.#keep(p);

    if (this.#face(p) !== was) this.#ring(p, false);
  }

  // The post is gone. The game holds a list that still has it, so this is
  // news to it in exactly the way a new post is.
  drop(id) {
    const p = this.posts.get(id);
    if (!p) return;

    this.posts.delete(id);
    this.store.newsDrop(id);
    this.#ring(p, false);
  }

  // ONE PAGE OF THE FEED, NEWEST FIRST (R-D1.1/R-D1.2).
  //
  // The whole feed used to ride in one answer, which was survivable only
  // because the feed was capped at fifty. With the cap gone the list has to
  // be walked, and the walk needs a place to stand: `Cursor` is the last row
  // of the page before this one, and `Next` is the one to ask for after it.
  // An empty `Next` means the bottom, and it is a FACT -- the page below was
  // looked for, not guessed.
  //
  // The cursor is "<ts>:<id>", not an index: rows appear and disappear while
  // a player reads, and an offset would then skip or repeat one. Sorting ties
  // break on the id so the order is total and the same on every call.
  list(cursor = '', limit = 0) {
    const n = Math.min(Math.max(Number(limit) || 30, 1), 100);

    const all = [...this.posts.values()]
      .sort((a, b) => (b.ts - a.ts) || (a.Id < b.Id ? 1 : a.Id > b.Id ? -1 : 0));

    let from = 0;
    if (cursor) {
      const at = all.findIndex((p) => `${p.ts}:${p.Id}` === String(cursor));
      // A cursor that named a post since deleted: start from the top rather
      // than answer an empty page for a feed that has plenty in it.
      from = at < 0 ? 0 : at + 1;
    }

    const page = all.slice(from, from + n);
    const last = page[page.length - 1];
    const more = from + page.length < all.length;

    return {
      Items: page.map((p) => ({ Id: p.Id, Title: p.Title, Who: p.Who, At: p.At, Replies: p.Replies })),
      Next: more && last ? `${last.ts}:${last.Id}` : '',
    };
  }

  open(id) {
    const p = this.posts.get(id);
    if (!p) return { Error: 'no_post' };
    // Body rides as an ARRAY of chunks (R-D1.4/R-D1.5); the client glues it.
    // Deleted says the starter message is gone in Discord, which is not the
    // same as a post with nothing written in it (R-D1.3).
    return {
      Id: p.Id,
      Title: p.Title,
      Who: p.Who,
      At: p.At,
      Body: asChunks(p.Body),
      Deleted: !!p.noStarter,
    };
  }
}
