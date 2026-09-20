// The nine research configs as the game declares them (OZL_*.c in
// openzone-research, 3_Game): every field in the class's order, with the
// default the class initialises it to. The order matters twice: the game
// writes files in it, and the canonical hash on the bridge ignores it, so
// a candidate serialised here promotes cleanly when the game rewrites it.
//
// `normalize` is the tolerant reader: whatever the text holds, the result
// has every field of the schema, typed, in order, and nothing else -- the
// same thing the game's loader produces from the same text.

export const NAMES = [
  'ResearchSettings', 'ResearchPointTypes', 'ResearchOwners', 'ResearchRules', 'ResearchTree',
  'ResearchDataItems', 'ResearchModules', 'ResearchSampleTypes', 'ResearchStatics',
] as const;
export type ConfigName = (typeof NAMES)[number];

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

export const POINT_TYPE: Field[] = [s('Id'), s('Name'), s('Icon'), s('Color'), i('SortOrder'), s('Category'), s('Kind'), i('Tier', 1)];
export const DIMENSION: Field[] = [s('Id'), s('Name'), i('SortOrder')];
export const OWNER: Field[] = [s('Id'), ss('TerminalClasses'), ss('DeviceClasses'), s('TreeBackground')];
export const RULE_INPUT: Field[] = [s('Classname'), i('Quantity', 1), b('ConsumeInput', true), s('Content'), b('RequireFullQuantity', false)];
export const RULE_CONSUMABLE: Field[] = [s('Classname'), i('Quantity', 1), s('Content')];
export const RULE_OUTPUT: Field[] = [s('Classname'), i('Quantity', 1), f('Chance', 1), s('Content')];
export const RULE: Field[] = [
  s('Id'), b('Enabled', true), s('Device'), obj('InputItem', RULE_INPUT), f('BasePurityMin', 0.5), f('BasePurityMax', 0.5), f('TimeSec', 10),
  list('Consumables', RULE_CONSUMABLE), list('Outputs', RULE_OUTPUT), s('RequiredNode'), ss('RequiredFactions'), ss('RequiredWorn'), ss('RequiredTools'),
  s('Notes', '', { long: true }),
];
export const RULE_GROUP: Field[] = [s('Id'), list('Rules', RULE)];
export const TREE_COST: Field[] = [s('Type'), i('Amount', 0)];
export const TREE_ITEM_COST: Field[] = [s('Classname'), i('Quantity', 1), s('Content')];
export const TREE_NODE: Field[] = [
  s('Id'), s('Name'), s('Description', '', { long: true }), s('Icon'), i('Tier', 1), ss('Parents'), s('ParentsMode', 'all', { options: ['all', 'any'] }),
  list('Cost', TREE_COST), list('ItemCost', TREE_ITEM_COST), i('ResearchTimeSec', 0), ss('RequiredFactions'),
];
export const TREE_BRANCH: Field[] = [s('Id'), s('Name'), s('Icon'), i('SortOrder'), ss('Owners'), list('Nodes', TREE_NODE)];
export const DATA_REWARD: Field[] = [s('Type'), i('Amount', 0)];
export const DATA_ITEM: Field[] = [s('Id'), b('Enabled', true), s('Name'), s('Description', '', { long: true }), list('Points', DATA_REWARD)];
export const MODULE: Field[] = [s('Classname'), f('PurityBonus', 0), ss('Devices'), s('Notes', '', { long: true })];
export const SAMPLE_TYPE: Field[] = [s('Id'), b('Enabled', true), s('Name'), s('Description', '', { long: true })];
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
  ResearchPointTypes: {
    fields: [i('Version', 1), list('PointTypes', POINT_TYPE), list('Categories', DIMENSION), list('Kinds', DIMENSION)],
    rows: { key: 'PointTypes' },
  },
  ResearchOwners: { fields: [i('Version', 1), list('Owners', OWNER)], rows: { key: 'Owners' } },
  ResearchRules: { fields: [i('Version', 1), list('Groups', RULE_GROUP)], rows: { key: 'Groups', inner: 'Rules' } },
  ResearchTree: { fields: [i('Version', 1), list('Branches', TREE_BRANCH)], rows: { key: 'Branches', inner: 'Nodes' } },
  ResearchDataItems: { fields: [i('Version', 1), list('Items', DATA_ITEM)], rows: { key: 'Items' } },
  ResearchModules: { fields: [i('Version', 1), list('Modules', MODULE)], rows: { key: 'Modules' } },
  ResearchSampleTypes: { fields: [i('Version', 1), list('Items', SAMPLE_TYPE)], rows: { key: 'Items' } },
  ResearchStatics: { fields: [i('Version', 1), list('Entries', STATIC_ENTRY)], rows: { key: 'Entries' } },
};

export type Doc = Record<string, unknown>;

export function isName(name: string): name is ConfigName {
  return (NAMES as readonly string[]).includes(name);
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
      return raw === undefined || raw === null || raw === '' || !Number.isFinite(n) ? Number(fld.default ?? 0) : n;
    }
    case 'bool':
      return raw === undefined || raw === null ? !!fld.default : raw === true || raw === 1 || raw === 'true' || raw === '1';
    case 'strings':
      return Array.isArray(raw) ? raw.map((x) => (typeof x === 'string' ? x : String(x ?? ''))) : [];
    case 'numbers':
      return Array.isArray(raw) ? raw.map((x) => Number(x)).filter((x) => Number.isFinite(x)) : [];
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
  return normalizeFields(SCHEMA[name].fields, raw);
}

// The text the game will read: four spaces, the class's order.
export function serialize(name: ConfigName, doc: unknown): string {
  return JSON.stringify(normalize(name, doc), null, 4);
}

export function parseText(name: ConfigName, text: string): { doc: Doc; why: string } {
  try {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { doc: normalize(name, {}), why: 'not an object' };
    return { doc: normalize(name, raw), why: '' };
  } catch (e) {
    return { doc: normalize(name, {}), why: (e as Error).message };
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
