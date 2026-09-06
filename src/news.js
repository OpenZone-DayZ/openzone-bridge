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
import { byteClip, stamp, GAME_STR_MAX } from './clip.js';

const KEEP = 50;
const BODY_MAX = GAME_STR_MAX; // game JSON parse cap, see clip.js

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
    for (const p of store.newsAll()) this.posts.set(p.Id, p);
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
    return JSON.stringify([p.Title, p.Who, p.At, p.Replies, p.Body]);
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
    // The starter is gone: the post keeps its title and loses its body.
    c.on('messageDelete', (m) => { if (m.id === m.channelId) this.edit(m.channelId, '', ''); });

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
    for (let page = 0; page < 4 && found.length < KEEP * 2; page++) {
      const arch = await ch.threads.fetchArchived({ type: 'public', before }).catch(() => null);
      if (!arch || arch.threads.size === 0) break;
      for (const th of arch.threads.values()) found.push(th);
      if (!arch.hasMore) break;
      before = found[found.length - 1].id;
    }

    found.sort((a, b) => Number(BigInt(b.id) - BigInt(a.id)));
    for (const th of found.slice(0, KEEP)) {
      await this.#onThread(th, true);
    }
  }

  // The single writing door: a forum post authored by `who`. Everything else
  // about the feed is read-only, and the channel permissions agree.
  async post(who, title, body) {
    const ch = await this.discord.client.channels.fetch(this.channelId);
    const hook = await this.discord.webhookFor(ch);
    if (!hook) throw new Error('no webhook on the news forum');

    await hook.send({
      threadName: title.slice(0, 90),
      username: who.slice(0, 80),
      content: byteClip(body),
    });
  }

  async #onThread(th, warm = false) {
    if (th.parentId !== this.channelId) return;

    const known = this.posts.get(th.id);
    // Taken BEFORE the mutations below, because `post` is `known` itself.
    const was = this.#face(known);
    const post = known || {
      Id: th.id, Title: '', Who: '', At: '', ts: 0, Body: '', Replies: 0,
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
    if (!known || warm || (!post.Body && !post.noStarter)) {
      try {
        const starter = await th.fetchStarterMessage();
        post.Body = byteClip(starter?.content || '', BODY_MAX);
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

    // The cap holds on live inserts too, not only at warm-up. Safe to drop
    // in a way chat is not: news are authored in Discord and stay there, so
    // an evicted post is still where it was written. Only an INSERT can
    // cross the cap -- an update of a post we already had cannot -- and the
    // store trims itself with the same rule.
    if (fresh && this.posts.size > KEEP) {
      const oldest = [...this.posts.values()].sort((a, b) => a.ts - b.ts)[0];
      this.posts.delete(oldest.Id);
      this.store.newsDrop(oldest.Id);
      this.store.newsTrim(KEEP);
    }

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
    p.Body = byteClip(body || '', BODY_MAX);
    p.Who = who || p.Who;
    p.noStarter = false;
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

  list() {
    const items = [...this.posts.values()]
      .sort((a, b) => b.ts - a.ts)
      .map((p) => ({ Id: p.Id, Title: p.Title, Who: p.Who, At: p.At, Replies: p.Replies }));
    return { Items: items };
  }

  open(id) {
    const p = this.posts.get(id);
    if (!p) return { Error: 'no_post' };
    return { Id: p.Id, Title: p.Title, Who: p.Who, At: p.At, Body: p.Body };
  }
}
