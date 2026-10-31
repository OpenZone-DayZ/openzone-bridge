// The seven research configs as the game declares them (OZL_*.c in
// openzone-research, 3_Game, the lines of 2026-10-30 and the per-line
// purity of 2026-10-31): every field in the class's order, with the default
// the class initialises it to. The order matters twice: the game writes
// files in it, and the canonical hash on the bridge ignores it, so a
// candidate serialised here promotes cleanly when the game rewrites it.
//
// `normalize` is the tolerant reader: whatever the text holds, the result
// has every field of the schema, typed, in order, and nothing else, at the
// version this build of the mod reads -- an older file converted the way
// the game's loader converts it (OZL_*.Migrate).

export const NAMES = [
  'ResearchSettings', 'ResearchPointTypes', 'ResearchOwners', 'ResearchRules', 'ResearchTree',
  'ResearchModules', 'ResearchStatics',
] as const;
export type ConfigName = (typeof NAMES)[number];

// LatestVersion() of each config class. The game refuses a candidate of
// any other version of point types, rules, tree and modules (OZL_Config.Stale),
// so the editor always writes these.
export const LATEST: Record<ConfigName, number> = {
  ResearchSettings: 1, ResearchPointTypes: 3, ResearchOwners: 1, ResearchRules: 3, ResearchTree: 2, ResearchModules: 2, ResearchStatics: 1,
};

// The versions the game converts when it loads them (Migrate returns true);
// any other older version goes to the core's quarantine.
export const CONVERTS: Partial<Record<ConfigName, number[]>> = { ResearchPointTypes: [2], ResearchRules: [2] };

// The tree windows the menu can draw (OZL_Owners.IsKnownSkin); '' is "by
// the faction's own id".
export const SKINS = ['ecolog', 'clearsky', 'duty', 'freedom', 'sop', 'bandit', 'neutral'] as const;

// OZL_Const.DEFAULT_PURITY: a line's base purity when nothing sets one.
export const DEFAULT_PURITY = 0.7;

export type FieldKind = 'string' | 'int' | 'float' | 'bool' | 'strings' | 'numbers' | 'list' | 'object';

export type Field = {
  key: string;
  kind: FieldKind;
  default?: unknown;
  // For 'list' and 'object': the fields of each element / of the object.
  of?: Field[];
  // For 'string': the allowed values, when the game only knows a few.
  options?: string[];
  // Shown wide in a form (descriptions, notes).
  long?: boolean;
};

const s = (key: string, dflt = '', extra: Partial<Field> = {}): Field => ({ key, kind: 'string', default: dflt, ...extra });
const i = (key: string, dflt = 0): Field => ({ key, kind: 'int', default: dflt });
const f = (key: string, dflt = 0): Field => ({ key, kind: 'float', default: dflt });
const b = (key: string, dflt = false): Field => ({ key, kind: 'bool', default: dflt });
const ss = (key: string): Field => ({ key, kind: 'strings', default: [] });
const ns = (key: string): Field => ({ key, kind: 'numbers', default: [] });
const list = (key: string, of: Field[]): Field => ({ key, kind: 'list', of, default: [] });
const obj = (key: string, of: Field[]): Field => ({ key, kind: 'object', of });

// OZL_PointType: a point type is a line; BasePurity is the purity every
// sample of the line starts with (0 or missing: not set, 0.7).
export const POINT_TYPE: Field[] = [s('Id'), s('Name'), s('Icon'), s('Color'), i('SortOrder'), f('BasePurity', DEFAULT_PURITY)];
export const OWNER: Field[] = [s('Id'), ss('TerminalClasses'), ss('DeviceClasses'), s('Skin', '', { options: ['', ...SKINS] })];
export const RULE_INPUT: Field[] = [s('Classname'), i('Quantity', 1), b('ConsumeInput', true), b('RequireFullQuantity', false)];
export const RULE_CONSUMABLE: Field[] = [s('Classname'), i('Quantity', 1)];
// Points: what a sample out of a packer is worth (1..1000); 0 for anything else.
export const RULE_OUTPUT: Field[] = [s('Classname'), i('Quantity', 1), f('Chance', 1), i('Points', 0)];
// Purity: above 0 -- this item's own starting purity; 0 or below (-1 by
// default) -- the BasePurity of the line.
export const RULE: Field[] = [
  s('Id'), b('Enabled', true), s('Device'), obj('InputItem', RULE_INPUT), f('Purity', -1), f('TimeSec', 10),
  list('Consumables', RULE_CONSUMABLE), list('Outputs', RULE_OUTPUT), s('RequiredNode'), ss('RequiredFactions'), ss('RequiredWorn'), ss('RequiredTools'),
  s('Notes', '', { long: true }),
];
export const RULE_GROUP: Field[] = [s('Id'), list('Rules', RULE)];
export const TREE_COST: Field[] = [s('Type'), i('Amount', 0)];
export const TREE_ITEM_COST: Field[] = [s('Classname'), i('Quantity', 1)];
export const TREE_NODE: Field[] = [
  s('Id'), s('Name'), s('Description', '', { long: true }), s('Icon'), i('Tier', 1), ss('Parents'), s('ParentsMode', 'all', { options: ['all', 'any'] }),
  list('Cost', TREE_COST), list('ItemCost', TREE_ITEM_COST), i('ResearchTimeSec', 0), ss('RequiredFactions'),
];
export const TREE_BRANCH: Field[] = [s('Id'), s('Name'), s('Icon'), i('SortOrder'), ss('Owners'), list('Nodes', TREE_NODE)];
export const MODULE: Field[] = [s('Classname'), f('PurityBonus', 0.1), f('DoubleChance', 0.1), s('Notes', '', { long: true })];
export const STATIC_ENTRY: Field[] = [s('Id'), s('ClassName'), ns('Pos'), f('Yaw', 0), s('Note')];

export type ConfigSchema = {
  fields: Field[];
  // The array the table of the editor shows: its key, and, when the rows
  // live one level down (Rules in Groups, Nodes in Branches), the inner key.
  rows: { key: string; inner?: string };
};

export const SCHEMA: Record<ConfigName, ConfigSchema> = {
  ResearchSettings: {
    fields: [i('Version', 1), s('DefaultOwner', 'loner'), s('ResearchPost'), s('BasePost'), i('TreeVisibilityDepth', 1)],
    rows: { key: '' },
  },
  ResearchPointTypes: { fields: [i('Version', 3), list('PointTypes', POINT_TYPE)], rows: { key: 'PointTypes' } },
  ResearchOwners: { fields: [i('Version', 1), list('Owners', OWNER)], rows: { key: 'Owners' } },
  ResearchRules: { fields: [i('Version', 3), list('Groups', RULE_GROUP)], rows: { key: 'Groups', inner: 'Rules' } },
  ResearchTree: { fields: [i('Version', 2), list('Branches', TREE_BRANCH)], rows: { key: 'Branches', inner: 'Nodes' } },
  ResearchModules: { fields: [i('Version', 2), list('Modules', MODULE)], rows: { key: 'Modules' } },
  ResearchStatics: { fields: [i('Version', 1), list('Entries', STATIC_ENTRY)], rows: { key: 'Entries' } },
};

export type Doc = Record<string, unknown>;

export function isName(name: string): name is ConfigName {
  return (NAMES as readonly string[]).includes(name);
}

// The Version a text claims, 0 when it claims none.
export function versionOf(raw: unknown): number {
  const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? Number((raw as Doc).Version) : NaN;
  return Number.isInteger(v) && v > 0 ? v : 0;
}

// OZL_Rules.Migrate(2): version 2 wrote Purity 0.7 into every rule, which
// meant "nothing chosen"; it becomes -1, the line's. Any other value stays.
function rulesFrom2(raw: Doc): Doc {
  const groups = Array.isArray(raw.Groups) ? raw.Groups : [];
  return {
    ...raw,
    Groups: groups.map((g) => {
      if (!g || typeof g !== 'object' || !Array.isArray((g as Doc).Rules)) return g;
      return {
        ...(g as Doc),
        Rules: ((g as Doc).Rules as unknown[]).map((r) => {
          if (!r || typeof r !== 'object') return r;
          const p = Number((r as Doc).Purity);
          return Number.isFinite(p) && Math.abs(p - DEFAULT_PURITY) < 0.001 ? { ...(r as Doc), Purity: -1 } : r;
        }),
      };
    }),
  };
}

// The text converted to the latest version the way the game's loader does
// it. Point types of version 2 have no BasePurity: the schema's default,
// 0.7, is exactly what OZL_PointTypes.Migrate(2) gives every line.
function migrate(name: ConfigName, raw: unknown): unknown {
  const v = versionOf(raw);
  if (name === 'ResearchRules' && v === 2) return rulesFrom2(raw as Doc);
  return raw;
}

// A float as the admin meant it. The game keeps a float in 32 bits and
// writes it back widened -- the 0.7 the site sent comes back as
// 0.699999988079071 -- so the shortest decimal that is the same float32 is
// what was typed, and what the game will read again. Only the spelling
// changes: the float32 the game holds, and the bridge's hash of the text
// (research-store.js, canonical), stay the same. Whole numbers pass as
// they are.
export function shortFloat(x: number): number {
  if (!Number.isFinite(x) || Number.isInteger(x)) return x;
  const f = Math.fround(x);
  for (let p = 1; p <= 9; p++) {
    const s = Number(f.toPrecision(p));
    if (Math.fround(s) === f) return s;
  }
  return x;
}

// A fresh element of a list field, every field at its default.
export function blank(fields: Field[]): Doc {
  const out: Doc = {};
  for (const fld of fields) out[fld.key] = valueOf(fld, undefined);
  return out;
}

function valueOf(fld: Field, raw: unknown): unknown {
  switch (fld.kind) {
    case 'string': {
      const v = raw === undefined || raw === null ? String(fld.default ?? '') : typeof raw === 'string' ? raw : String(raw);
      return fld.options && !fld.options.includes(v) ? v : v;
    }
    case 'int': {
      const n = Number(raw);
      return raw === undefined || raw === null || raw === '' || !Number.isFinite(n) ? Number(fld.default ?? 0) : Math.trunc(n);
    }
    case 'float': {
      const n = Number(raw);
      return raw === undefined || raw === null || raw === '' || !Number.isFinite(n) ? Number(fld.default ?? 0) : shortFloat(n);
    }
    case 'bool':
      return raw === undefined || raw === null ? !!fld.default : raw === true || raw === 1 || raw === 'true' || raw === '1';
    case 'strings':
      return Array.isArray(raw) ? raw.map((x) => (typeof x === 'string' ? x : String(x ?? ''))) : [];
    case 'numbers':
      return Array.isArray(raw) ? raw.map((x) => Number(x)).filter((x) => Number.isFinite(x)).map(shortFloat) : [];
    case 'list':
      return Array.isArray(raw) ? raw.map((x) => normalizeFields(fld.of || [], x)) : [];
    case 'object':
      return normalizeFields(fld.of || [], raw);
  }
}

export function normalizeFields(fields: Field[], raw: unknown): Doc {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Doc) : {};
  const out: Doc = {};
  for (const fld of fields) out[fld.key] = valueOf(fld, src[fld.key]);
  return out;
}

export function normalize(name: ConfigName, raw: unknown): Doc {
  const doc = normalizeFields(SCHEMA[name].fields, migrate(name, raw));
  doc.Version = LATEST[name];
  return doc;
}

// The text the game will read, spelled the way the game writes its own
// files: four spaces, the class's order, a bool as 1 or 0.
export function serialize(name: ConfigName, doc: unknown): string {
  return JSON.stringify(normalize(name, doc), (_, v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v), 4);
}

// `version` is what the text claims (0: nothing), before any conversion.
export function parseText(name: ConfigName, text: string): { doc: Doc; why: string; version: number } {
  try {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { doc: normalize(name, {}), why: 'not an object', version: 0 };
    return { doc: normalize(name, raw), why: '', version: versionOf(raw) };
  } catch (e) {
    return { doc: normalize(name, {}), why: (e as Error).message, version: 0 };
  }
}

// The rows of the editor's table: [{ path, row }], where path addresses
// the row in the doc ([listIndex] or [outerIndex, innerIndex]).
export type RowRef = { path: number[]; row: Doc; group?: Doc };

export function rowsOf(name: ConfigName, doc: Doc): RowRef[] {
  const { rows } = SCHEMA[name];
  if (!rows.key) return [];
  const outer = doc[rows.key];
  if (!Array.isArray(outer)) return [];
  if (!rows.inner) return outer.map((row, idx) => ({ path: [idx], row: row as Doc }));
  const out: RowRef[] = [];
  outer.forEach((group, gi) => {
    const inner = (group as Doc)[rows.inner as string];
    if (!Array.isArray(inner)) return;
    inner.forEach((row, ri) => out.push({ path: [gi, ri], row: row as Doc, group: group as Doc }));
  });
  return out;
}

// The fields of one row of the table.
export function rowFields(name: ConfigName): Field[] {
  const { fields, rows } = SCHEMA[name];
  const outer = fields.find((x) => x.key === rows.key);
  if (!outer || !outer.of) return [];
  if (!rows.inner) return outer.of;
  const inner = outer.of.find((x) => x.key === rows.inner);
  return inner?.of || [];
}

// A copy of the doc with the row at `path` replaced (or removed when
// `row` is null), so the editor never mutates what it was given.
export function withRow(name: ConfigName, doc: Doc, path: number[], row: Doc | null): Doc {
  const { rows } = SCHEMA[name];
  const copy = structuredClone(doc);
  const outer = copy[rows.key] as Doc[];
  if (!rows.inner) {
    if (row === null) outer.splice(path[0], 1);
    else if (path[0] >= outer.length) outer.push(row);
    else outer[path[0]] = row;
    return copy;
  }
  const inner = (outer[path[0]] as Doc)[rows.inner] as Doc[];
  if (row === null) inner.splice(path[1], 1);
  else if (path[1] >= inner.length) inner.push(row);
  else inner[path[1]] = row;
  return copy;
}

// The key of the row's identity: Id for most, Classname for modules.
export function idKey(name: ConfigName): string {
  return name === 'ResearchModules' ? 'Classname' : 'Id';
}
