// The classes of a game server, as the core dumps them at every start
// (OpenZone_Core, OZ_ClassDump): a line per class in
// <profile>/OpenZone/classes.tsv, tab-separated -- the root (0..4, the
// order of ROOTS), the name, the parent, the game name in the stringtables'
// original column and in the English one, read on the server out of its
// archives. The bridge turns the dump into the index the admin site reads
// (web-src/src/core/classes/classIndex.ts): every mod's editor checks and
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

// The dump under `profileDir` (the server's $profile:OpenZone), parsed:
// null when the file is not there.
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
    rows.push({ root, name, base: (f[2] || '').trim(), original: nameOrNothing(f[3]), english: nameOrNothing(f[4]) });
  }
  return { rows, count: rows.length, at: stampNow(new Date(statSync(p).mtimeMs)), file: p };
}

// The class index the admin site reads, out of one server's dump: the
// shape classIndex.ts parses (v3 rows: name, parent row, mod, root, the
// original column's name, the English one's) with one "mod", the server
// itself, because the game does not say which addon declared a class.
// The parent is looked up in the same root first (the game inherits
// within a root), then in any.
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
    return [r.name, parent, 0, r.root, r.original, r.english];
  });
  return { v: 3, generated: at, mods: [server], classes };
}

// The dump read and stored for one server: the index whole under
// `classindex:<server>`, a summary (count, when the game wrote the file)
// under `classes:<server>`. Answers what was stored, or null without a
// dump.
export function storeClassDump(store, profileDir, server, at = stampNow()) {
  const dump = readClassDump(profileDir);
  if (!dump || !dump.count) return null;
  store.metaSet(`classindex:${server}`, JSON.stringify(serverClassIndex(dump.rows, server, dump.at)), at);
  store.metaSet(`classes:${server}`, JSON.stringify({ count: dump.count, at: dump.at }), at);
  return { count: dump.count, at: dump.at, file: dump.file };
}
