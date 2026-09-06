// Conversation history BY COUNT, not by clock (TZ-4 R-D2.1..R-D2.4).
//
// The old pages were 8-hour windows anchored to the newest line, and the
// game's ChatHistoryOpen / ChatHistoryPage numbers travelled here to be
// ignored. Now a page is N lines: open() hands back the newest N, older()
// the N before a given line, and "there is more" is a FACT read from the
// store rather than a guess about the tail being full.
//
// THE PAGE IS CUT IN SQL. Both of these used to load the WHOLE conversation
// -- every line, JSON.parsed -- to show twenty of them and then throw the
// rest away. With the mirror off a tail grows without limit, so opening one
// chat could parse thousands of records; the (key, cursor) index has always
// been there for exactly this.
//
// Pure functions over the store so a test can drive them without Discord;
// the Discord tier (lines deeper than the store remembers) stays in the
// route, because only the route has a client.

import { stamp } from './clip.js';

// The freeze stamp of a sealed capsule, in the store's own dialect. The
// store compares it against the `at` column; both are UTC.
export function untilStamp(until) {
  const ms = Number(until) || 0;
  return ms > 0 ? stamp(ms) : '';
}

const pageSize = (limit) => Math.min(Math.max(Number(limit) || 20, 1), 100);

export function openPage({ store, key, uid, limit, until }) {
  const cut = untilStamp(until);
  const shown = store.tailOf(key, pageSize(limit), cut);
  return {
    lines: shown.map((m) => toLine(m, uid)),
    // More lines exist in the store before the ones shown: a fact.
    more: shown.length > 0 && store.hasBefore(key, shown[0].id, cut),
    before: shown[0]?.id || '',
  };
}

// The page BEFORE `before`, from the store. Null when the store holds
// nothing older than that line -- the caller then asks Discord, which is
// the only party that remembers past the tail.
export function olderFromStore({ store, key, uid, before, limit, until }) {
  if (!before) return null;
  const cut = untilStamp(until);
  const chunk = store.beforeOf(key, before, pageSize(limit), cut);
  if (!chunk.length) return null;

  const more = store.hasBefore(key, chunk[0].id, cut);
  return {
    lines: chunk.map((m) => toLine(m, uid)),
    more,
    before: chunk[0].id,
    // Whether the store's edge was reached with this page: when the chunk
    // starts at the very first stored line, whatever lies deeper is in
    // Discord and the route has to ask there before saying "no more".
    atStoreEdge: !more,
  };
}

// Who said the lines Discord could not attribute. A webhook post carries no
// author but a name, and the store still knows the author of anything inside
// its tail -- by our own id for a line the game sent, and by the Discord
// snowflake the echo wrote down for the same line over there.
export function fillFromTail(lines, tail) {
  const known = new Map();
  for (const m of tail) {
    if (!m.uid) continue;
    known.set(m.id, m.uid);
    if (m.dId) known.set(m.dId, m.uid);
  }
  for (const m of lines) if (!m.uid && known.has(m.id)) m.uid = known.get(m.id);
  return lines;
}

export function toLine(m, uid) {
  return { At: m.at, Who: m.who, Text: m.text, Mine: !!m.uid && m.uid === uid, AUid: m.uid || '' };
}
