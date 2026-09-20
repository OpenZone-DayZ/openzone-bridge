// The class index: every class the chosen server knows, with its parent,
// its root and its game name in the two languages of the site -- the dump
// the core writes at every server start (the mods' stringtables read on
// the server itself), turned into rows by the bridge and kept there per
// server. The
// row shape comes from ZP_Research's web editor, grown by a sixth element
// (the English name beside the original column's); `mods` holds one
// entry, the server, because the game does not say which addon declared
// a class.
//
// Rows are arrays, not objects: tens of thousands of classes travel as a
// few megabytes this way. `baseIdx` is the index of the PARENT row (-1 when
// the parent is outside the index or the class is a forward declaration).

export type Root = 0 | 1 | 2 | 3 | 4;

// The five roots OZL_Match.ClassExists asks the game about (the order here
// is the index's own, kept from ZP; `cfgWeapons` is the real spelling of
// the root in the game's configs).
export const ROOT_NAMES: readonly [string, string, string, string, string] = [
  'CfgVehicles',
  'CfgMagazines',
  'CfgNonAIVehicles',
  'CfgAmmo',
  'cfgWeapons',
];

// name, parent row, mod, root, display (original column), display (english column)
export type ClassRow = [name: string, baseIdx: number, modIdx: number, root: Root, original: string, english: string];

export interface RawClassIndex {
  v: number;
  generated: string;
  mods: string[];
  classes: Array<[string, number, number, number, string] | ClassRow>;
}

export interface ClassIndex {
  v: number;
  generated: string;
  mods: string[];
  classes: ClassRow[];
  // name.toLowerCase() -> row index. Lower-case on purpose: the game's
  // MatchClass and IsKindOf ignore case, so must the index. One flat map
  // for all five roots; a name that exists in two roots keeps the later
  // one (the index is written root by root, 0..4).
  byName: Map<string, number>;
}

export interface ClassHit {
  name: string;
  root: Root;
  mod: string;
  display: string;
}

export type Lang = 'en' | 'uk';

// The one way a ClassIndex is built out of JSON: the importer's result,
// the bridge's stored copy, a file. Accepts v2 rows (five elements, from
// the ZP editor) and v3 rows; refuses garbage loudly, because a silently
// broken index would show "class not found" all over the editor.
export function parseClassIndexJson(data: unknown): ClassIndex {
  if (typeof data !== 'object' || data === null) throw new Error('ClassIndex: not an object');
  const obj = data as Partial<RawClassIndex>;
  if (typeof obj.v !== 'number' || !Array.isArray(obj.mods) || !Array.isArray(obj.classes)) {
    throw new Error('ClassIndex: v, mods or classes missing');
  }
  const classes: ClassRow[] = [];
  const byName = new Map<string, number>();
  for (let i = 0; i < obj.classes.length; i++) {
    const row = obj.classes[i] as unknown[];
    if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[1] !== 'number' || typeof row[2] !== 'number' || typeof row[3] !== 'number') {
      throw new Error(`ClassIndex: broken row #${i}`);
    }
    const original = typeof row[4] === 'string' ? row[4] : '';
    const english = typeof row[5] === 'string' ? row[5] : original;
    classes.push([row[0], row[1], row[2], row[3] as Root, original, english]);
    byName.set(row[0].toLowerCase(), i);
  }
  return { v: obj.v, generated: typeof obj.generated === 'string' ? obj.generated : '', mods: obj.mods, classes, byName };
}

const MAX_CHAIN_DEPTH = 64;

function displayOf(row: ClassRow, lang: Lang): string {
  // The original column is the mod's own language (Ukrainian in this
  // series, English in vanilla); the english column is English wherever
  // the stringtable had one.
  return lang === 'en' ? (row[5] || row[4]) : (row[4] || row[5]);
}

// The game name of a class: its own display, or the nearest ancestor's
// (the engine merges config properties down the inheritance), or the
// class name itself.
export function displayNameOf(index: ClassIndex, cls: string, lang: Lang): string {
  const start = index.byName.get(cls.toLowerCase());
  if (start === undefined) return cls;
  const seen = new Set<number>();
  let cursor: number = start;
  let depth = 0;
  while (depth < MAX_CHAIN_DEPTH) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const row = index.classes[cursor];
    const d = displayOf(row, lang);
    if (d !== '') return d;
    if (row[1] < 0) break;
    cursor = row[1];
    depth++;
  }
  return index.classes[start][0];
}

// Is `cls` the class `base`, or a descendant of it? "X|N" means exactly X,
// as OZL_Match.MatchClass reads it; case never matters, at any step.
export function isKindOf(index: ClassIndex, cls: string, base: string): boolean {
  const pipeAt = base.indexOf('|');
  if (pipeAt > -1) return cls.toLowerCase() === base.slice(0, pipeAt).toLowerCase();
  const clsLower = cls.toLowerCase();
  const baseLower = base.toLowerCase();
  if (clsLower === baseLower) return true;
  const start = index.byName.get(clsLower);
  if (start === undefined) return false;
  const seen = new Set<number>();
  let depth = 0;
  let cursor: number = start;
  while (depth < MAX_CHAIN_DEPTH) {
    if (seen.has(cursor)) return false;
    seen.add(cursor);
    const row = index.classes[cursor];
    if (row[0].toLowerCase() === baseLower) return true;
    if (row[1] < 0) return false;
    cursor = row[1];
    depth++;
  }
  return false;
}

// Live search: class names that start with the query first, then names
// that contain it, then display names (in the chosen language) that
// contain it. One hit per class.
export function searchClasses(index: ClassIndex, query: string, limit: number, lang: Lang = 'uk'): ClassHit[] {
  const needle = query.toLowerCase();
  if (needle === '') return [];
  const prefixHits: ClassHit[] = [];
  const otherHits: ClassHit[] = [];
  const displayHits: ClassHit[] = [];
  for (const row of index.classes) {
    const name = row[0];
    const low = name.toLowerCase();
    const pos = low.indexOf(needle);
    const hit = (): ClassHit => ({ name, root: row[3], mod: index.mods[row[2]], display: displayOf(row, lang) });
    if (pos === 0) {
      prefixHits.push(hit());
      if (prefixHits.length >= limit) break;
      continue;
    }
    if (pos > 0) {
      if (otherHits.length < limit) otherHits.push(hit());
      continue;
    }
    if (displayHits.length < limit) {
      const d = displayOf(row, lang);
      if (d !== '' && d.toLowerCase().includes(needle)) displayHits.push(hit());
    }
  }
  return prefixHits.concat(otherHits, displayHits).slice(0, limit);
}

export function classRoot(index: ClassIndex, cls: string): Root | undefined {
  const idx = index.byName.get(cls.toLowerCase());
  return idx === undefined ? undefined : index.classes[idx][3];
}

export function hasClass(index: ClassIndex, cls: string): boolean {
  return index.byName.has(stripExact(cls).toLowerCase());
}

// OZL_Match.StripExact: the "|N" mark comes off before any lookup.
export function stripExact(configured: string): string {
  const sep = configured.indexOf('|');
  return sep > -1 ? configured.slice(0, sep) : configured;
}
