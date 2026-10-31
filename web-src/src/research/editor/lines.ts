// What the editor knows about a class of OpenZone Research: whether the
// server has it, its root, what it is (a sample, a carrier, a packer, an
// analyzer, a module, a terminal) and its line.
//
// The role comes from the class hierarchy: the server's class index when
// the bridge holds one (OZL_Lines.IsSample is IsKindOf OZL_Sample_Base),
// the mod's naming without it. The line is a property in the mod's
// config.cpp (ozlLine), and the class dump has the parents of every class
// but none of its properties, so the lines are mirrored here from
// config.cpp as of 2026-10-31: a line's sample, carrier and stations share
// its suffix (OZL_Sample_Bio, OZL_Carrier_Bio, OZL_Eco_Pack_Bio,
// OZL_Sky_Proc_Bio), its modules are named one by one. A class inherits the
// line of its nearest ancestor that has one, as config properties do. A
// sample, carrier, station or module this mirror does not know has an
// UNKNOWN line (null), and a check that needs it says so as a warning:
// a refusal must never come from the mirror being older than the mod.

import { isKindOf, type ClassIndex } from '../../core/classes/classIndex';

export type Role = 'sample' | 'carrier' | 'packer' | 'analyzer' | 'terminal' | 'module';

// The line ids, in the order of the mod's default point types.
export const LINE_IDS = ['bio', 'anomaly', 'electronics', 'khabar', 'trails', 'ballistics', 'protection'] as const;

// The suffix a line's sample, carrier, packers and analyzers carry.
const SUFFIX: Record<string, string> = {
  bio: 'bio', anom: 'anomaly', electro: 'electronics', khabar: 'khabar', trail: 'trails', ball: 'ballistics', prot: 'protection',
};

// The modules (OZL_Tool_Base) and their lines.
const MODULE_LINE: Record<string, string> = {
  ozl_tool_optics: 'bio', ozl_tool_centrifuge: 'bio', ozl_tool_reagents: 'bio',
  ozl_tool_anomprobe: 'anomaly', ozl_tool_radiometer: 'anomaly', ozl_tool_leadshield: 'anomaly',
  ozl_tool_oscilloscope: 'electronics', ozl_tool_solderstation: 'electronics', ozl_tool_programmer: 'electronics',
  ozl_tool_dosimeter: 'khabar', ozl_tool_jewelerloupe: 'khabar', ozl_tool_leadcapsule: 'khabar',
  ozl_tool_pdareader: 'trails', ozl_tool_radioscanner: 'trails', ozl_tool_mapboard: 'trails',
  ozl_tool_barrelvise: 'ballistics', ozl_tool_borescope: 'ballistics', ozl_tool_gaugeset: 'ballistics',
  ozl_tool_compressor: 'protection', ozl_tool_gasanalyzer: 'protection', ozl_tool_plateclamp: 'protection',
};

// The module classes of the mod, as config.cpp spells them.
export const MODULE_CLASSES: string[] = [
  'OZL_Tool_Optics', 'OZL_Tool_Centrifuge', 'OZL_Tool_Reagents', 'OZL_Tool_AnomProbe', 'OZL_Tool_Radiometer', 'OZL_Tool_LeadShield',
  'OZL_Tool_Oscilloscope', 'OZL_Tool_SolderStation', 'OZL_Tool_Programmer', 'OZL_Tool_Dosimeter', 'OZL_Tool_JewelerLoupe', 'OZL_Tool_LeadCapsule',
  'OZL_Tool_PdaReader', 'OZL_Tool_RadioScanner', 'OZL_Tool_MapBoard', 'OZL_Tool_BarrelVise', 'OZL_Tool_Borescope', 'OZL_Tool_GaugeSet',
  'OZL_Tool_Compressor', 'OZL_Tool_GasAnalyzer', 'OZL_Tool_PlateClamp',
];

// The base of each role, and the mod's bases, which carry no line.
const BASES: [Role, string][] = [
  ['sample', 'OZL_Sample_Base'], ['carrier', 'OZL_Carrier_Base'], ['packer', 'OZL_Packer_Base'],
  ['analyzer', 'OZL_Analyzer_Base'], ['terminal', 'OZL_Terminal_Base'], ['module', 'OZL_Tool_Base'],
];
const NO_LINE = new Set(['ozl_sample_base', 'ozl_carrier_base', 'ozl_packer_base', 'ozl_analyzer_base', 'ozl_terminal_base', 'ozl_tool_base', 'ozl_staticdevice_base']);

// OZL_Match.StripExact: "Class|1" means exactly that class.
export function stripExact(cls: string): string {
  const at = cls.indexOf('|');
  return at > -1 ? cls.slice(0, at) : cls;
}

// The role by the mod's naming alone: what the index would say of the
// mod's own classes.
function roleByName(cls: string): Role | null {
  const low = cls.toLowerCase();
  for (const [role, base] of BASES) if (low === base.toLowerCase()) return role;
  if (low.startsWith('ozl_sample_')) return 'sample';
  if (low.startsWith('ozl_carrier_')) return 'carrier';
  if (low.startsWith('ozl_tool_')) return 'module';
  if (/^ozl_[a-z]+_pack_/.test(low)) return 'packer';
  if (/^ozl_[a-z]+_proc_/.test(low)) return 'analyzer';
  if (/^ozl_[a-z]+_terminal/.test(low)) return 'terminal';
  return null;
}

// The line the mirror knows for the class itself (not its ancestors).
function ownLine(cls: string): string | undefined {
  const low = cls.toLowerCase();
  if (NO_LINE.has(low)) return '';
  if (MODULE_LINE[low]) return MODULE_LINE[low];
  const m = /^ozl_(?:sample|carrier|[a-z]+_pack|[a-z]+_proc)_([a-z]+)$/.exec(low);
  if (m && SUFFIX[m[1]]) return SUFFIX[m[1]];
  return undefined;
}

export type ClassFacts = {
  // Does the server have the class? null: there is no class list to ask.
  exists: (cls: string) => boolean | null;
  // Is it a magazine (CfgMagazines)? null when unknown.
  isMagazine: (cls: string) => boolean | null;
  // IsKindOf: the real hierarchy when the index has the class, the mod's
  // naming otherwise; "X|1" means exactly X.
  kindOf: (cls: string, base: string) => boolean;
  role: (cls: string) => Role | null;
  // '' -- no line (a vanilla item, a terminal, a base); null -- a class
  // that should have one and the mirror does not know it.
  line: (cls: string) => string | null;
};

// The facts with the server's index, or without one; `names` stands in for
// the index's existence answers where there is no index (tests, an index
// that has not arrived).
export function classFacts(index: ClassIndex | null, names?: Iterable<string> | null): ClassFacts {
  const listed = names ? new Set([...names].map((n) => n.toLowerCase())) : null;
  const inIndex = (cls: string): boolean => !!index && index.byName.has(stripExact(cls).toLowerCase());
  const exists = (cls: string): boolean | null => {
    const bare = stripExact(cls).toLowerCase();
    if (index) return index.byName.has(bare);
    if (listed) return listed.has(bare);
    return null;
  };
  const isMagazine = (cls: string): boolean | null => {
    if (!index) return null;
    const at = index.byName.get(stripExact(cls).toLowerCase());
    return at === undefined ? null : index.classes[at][3] === 1;
  };
  const kindOf = (cls: string, base: string): boolean => {
    if (base === '') return false;
    const at = base.indexOf('|');
    if (at > -1) return cls.toLowerCase() === base.slice(0, at).toLowerCase();
    const bare = stripExact(cls);
    if (inIndex(bare)) return isKindOf(index as ClassIndex, bare, base);
    if (bare.toLowerCase() === base.toLowerCase()) return true;
    const low = base.toLowerCase();
    if (low === 'inventory_base' || low === 'itembase') return true;
    if (low === 'ozl_staticdevice_base') return ['packer', 'analyzer', 'terminal'].includes(roleByName(bare) || '');
    const as = BASES.find(([, b]) => b.toLowerCase() === low);
    return !!as && roleByName(bare) === as[0];
  };
  const role = (cls: string): Role | null => {
    for (const [r, base] of BASES) if (kindOf(cls, base)) return r;
    return null;
  };
  const line = (cls: string): string | null => {
    const bare = stripExact(cls);
    const own = ownLine(bare);
    if (own !== undefined) return own;
    // The nearest ancestor with a line, when the index knows the parents.
    // Reaching one of the mod's bases settles nothing: the class itself may
    // name a line the mirror has not heard of.
    if (index) {
      let at = index.byName.get(bare.toLowerCase());
      for (let depth = 0; at !== undefined && at >= 0 && depth < 64; depth++) {
        const row = index.classes[at];
        const found = ownLine(row[0]);
        if (found) return found;
        if (found === '') break;
        at = row[1];
      }
    }
    const r = role(bare);
    return r === null || r === 'terminal' ? '' : null;
  };
  return { exists, isMagazine, kindOf, role, line };
}

// OZL_Lines.SameLine: both have a line and it is the same. Undefined when
// either line is unknown to the mirror.
export function sameLine(facts: ClassFacts, a: string, b: string): boolean | undefined {
  const la = facts.line(a);
  const lb = facts.line(b);
  if (la === null || lb === null) return undefined;
  return la !== '' && la === lb;
}

// OZL_PointTypes.BasePurityOf with the "not set" of 0: the line's base
// purity, 0.7 when the type sets none, null when there is no such type.
export const DEFAULT_PURITY = 0.7;

export function basePurityOf(pointTypes: unknown, line: string): number | null {
  if (!line) return null;
  const list = pointTypes && typeof pointTypes === 'object' && Array.isArray((pointTypes as { PointTypes?: unknown }).PointTypes) ? (pointTypes as { PointTypes: unknown[] }).PointTypes : [];
  for (const raw of list) {
    const pt = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    if (pt.Id !== line) continue;
    const v = typeof pt.BasePurity === 'number' && Number.isFinite(pt.BasePurity) ? pt.BasePurity : 0;
    if (v <= 0) return DEFAULT_PURITY;
    return Math.min(1, v);
  }
  return null;
}

// OZL_Rules.StartPurity: the rule's own purity when it is above 0; else the
// base of the station's line, else of the line of the rule's output sample,
// else 0.7. `line` says where the answer came from ('' for the rule itself
// or the fallback); `unknown` is set when the mirror could not tell a line.
export function startPurity(rule: Record<string, unknown>, facts: ClassFacts, pointTypes: unknown): { purity: number; line: string; own: boolean; unknown: boolean } {
  const own = typeof rule.Purity === 'number' ? rule.Purity : -1;
  if (own > 0) return { purity: own, line: '', own: true, unknown: false };
  let unknown = false;
  const tryLine = (cls: string) => {
    const l = facts.line(cls);
    if (l === null) unknown = true;
    if (!l) return null;
    const p = basePurityOf(pointTypes, l);
    return p === null ? null : { purity: p, line: l, own: false, unknown: false };
  };
  const fromDevice = tryLine(String(rule.Device ?? ''));
  if (fromDevice) return fromDevice;
  const outs = Array.isArray(rule.Outputs) ? (rule.Outputs as Record<string, unknown>[]) : [];
  for (const o of outs) {
    const cls = String(o?.Classname ?? '');
    if (facts.role(cls) !== 'sample') continue;
    const fromSample = tryLine(cls);
    if (fromSample) return fromSample;
  }
  return { purity: DEFAULT_PURITY, line: '', own: false, unknown };
}
