// The classes of a game server, as the core dumps them at every start
// (OpenZone_Core, OZ_ClassDump): a line per class in
// <profile>/OpenZone/classes.tsv, tab-separated -- the root (0..4, the
// order of ROOTS), the name, the parent, the game name in the stringtables'
// original column and in the English one, the item's size in cells
// (itemSize: width, height) and its cargo's (itemsCargoSize: width,
// height; 0 0 when it holds nothing), all read on the server out of its
// configs and archives. The bridge turns the dump into the index the admin
// site reads (web-src/src/core/classes/classIndex.ts) and into the sizes
// the storage kind counts a box's cells with: every mod's editor checks and
// searches against the live server, not against PBOs read elsewhere.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stampNow } from './storage-wire.js';

export const CLASSES_FILE = 'classes.tsv';

// The five roots the mods check classes in, in the order of the dump and
// of the site's index.
export const ROOTS = ['CfgVehicles', 'CfgMagazines', 'CfgNonAIVehicles', 'CfgAmmo', 'cfgWeapons'];

// A game name that is still a bare key (a dangling $STR_) is no name; the
// engine's $UNT$ mark on an untranslated string is not part of the name.
const nameOrNothing = (v) => {
  const s = String(v ?? '').trim().replace(/^\$UNT\$/, '');
  return /^\$?STR_/i.test(s) ? '' : s;
};

const cells = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : 0;
};

// The dump under `profileDir` (the server's $profile:OpenZone), parsed:
// null when the file is not there. A dump from a core older than the size
// columns reads with sizes of 0, which the counting treats as unknown.
export function readClassDump(profileDir) {
  if (!profileDir) return null;
  const p = join(profileDir, CLASSES_FILE);
  if (!existsSync(p)) return null;
  const rows = [];
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    const f = line.split('\t');
    const root = Number(f[0]);
    const name = (f[1] || '').trim();
    if (!Number.isInteger(root) || root < 0 || root >= ROOTS.length || !name) continue;
    rows.push({
      root, name, base: (f[2] || '').trim(), original: nameOrNothing(f[3]), english: nameOrNothing(f[4]),
      w: cells(f[5]), h: cells(f[6]), cw: cells(f[7]), ch: cells(f[8]),
    });
  }
  return { rows, count: rows.length, at: stampNow(new Date(statSync(p).mtimeMs)), file: p };
}

// The class index the admin site reads, out of one server's dump: the
// shape classIndex.ts parses (v4 rows: name, parent row, mod, root, the
// original column's name, the English one's, item width and height, cargo
// width and height) with one "mod", the server itself, because the game
// does not say which addon declared a class. The parent is looked up in
// the same root first (the game inherits within a root), then in any.
export function serverClassIndex(rows, server, at) {
  const byRoot = new Map();
  const byName = new Map();
  rows.forEach((r, i) => {
    const low = r.name.toLowerCase();
    byRoot.set(`${r.root}:${low}`, i);
    if (!byName.has(low)) byName.set(low, i);
  });
  const classes = rows.map((r) => {
    const low = r.base.toLowerCase();
    let parent = -1;
    if (low) {
      const same = byRoot.get(`${r.root}:${low}`);
      parent = same !== undefined ? same : (byName.get(low) ?? -1);
    }
    return [r.name, parent, 0, r.root, r.original, r.english, cells(r.w), cells(r.h), cells(r.cw), cells(r.ch)];
  });
  return { v: 4, generated: at, mods: [server], classes };
}

// The sizes out of an index: class name (lower case) -> { w, h, cw, ch }.
// A v3 index (no size columns) gives an empty map.
export function sizesOfIndex(index) {
  const map = new Map();
  for (const row of index?.classes || []) {
    if (!Array.isArray(row) || row.length < 8) continue;
    map.set(String(row[0]).toLowerCase(), { w: cells(row[6]), h: cells(row[7]), cw: cells(row[8]), ch: cells(row[9]) });
  }
  return map;
}

// The sizes per server, kept in memory once read: the storage kind asks
// for them at every box page and every give.
const sizesBy = new Map();

export function classSizes(store, server) {
  const sid = String(server || '');
  if (!sid) return null;
  if (sizesBy.has(sid)) return sizesBy.get(sid);
  const row = store.metaGet(`classindex:${sid}`);
  if (!row) return null;
  let map = null;
  try {
    map = sizesOfIndex(JSON.parse(row.value));
  } catch {
    map = null;
  }
  if (map) sizesBy.set(sid, map);
  return map;
}

// The dump read and stored for one server: the index whole under
// `classindex:<server>`, a summary (count, when the game wrote the file)
// under `classes:<server>`, the sizes in memory. Answers what was stored,
// or null without a dump.
export function storeClassDump(store, profileDir, server, at = stampNow()) {
  const dump = readClassDump(profileDir);
  if (!dump || !dump.count) return null;
  const index = serverClassIndex(dump.rows, server, dump.at);
  store.metaSet(`classindex:${server}`, JSON.stringify(index), at);
  store.metaSet(`classes:${server}`, JSON.stringify({ count: dump.count, at: dump.at }), at);
  sizesBy.set(String(server), sizesOfIndex(index));
  return { count: dump.count, at: dump.at, file: dump.file };
}
