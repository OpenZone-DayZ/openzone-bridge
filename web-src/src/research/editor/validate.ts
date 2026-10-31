// The mirror of the game's Validate() and Check() of every research
// config (OZL_*.c), so the admin sees before sending what the game would
// do with the text. Four weights:
//
//   drop     the game drops the element (or the whole group) on load;
//   disable  the game keeps the element but switches it off (a rule);
//   warn     the game keeps it and writes a WARNING, or the editor knows it
//            can never work;
//   info     a fact worth knowing, nothing the game complains about.
//
// A class the server's list does not hold is always `warn`: the list is
// a dump from the last boot, and a mod added since would make a false
// alarm out of a hard refusal. The message says what the game would do.
// The same goes for a line the editor's mirror of config.cpp does not know
// (lines.ts): the game decides, the editor only says it cannot.
//
// Validate() walks every list from the END, so of two elements with one
// Id the game keeps the LAST; the walks here go the same way.

import { DEFAULT_PURITY, SKINS, type Doc } from './schema';
import { unreachable } from './treeModel';
import { LINE_IDS, MODULE_CLASSES, classFacts, sameLine, stripExact, type ClassFacts } from './lines';
import { matchClass } from './chain';

export type Severity = 'drop' | 'disable' | 'warn' | 'info';
export type Problem = { path: string; severity: Severity; message: string };

export type Context = {
  // What the editor knows of classes: existence, roles, lines. Without it,
  // a mirror with no class list (`classes` stands in for the list).
  facts?: ClassFacts;
  // Every class name the server dumped at boot; null = unknown.
  classes?: Set<string> | null;
  // The ids of PointTypes (from the point types config, or this one).
  pointTypes?: Set<string>;
  // The node ids of the tree (for RequiredNode).
  nodeIds?: Set<string>;
  // The owner ids (the factions of the core); optional, informative.
  owners?: Set<string>;
  // The owners config itself: who owns which device (rules).
  ownersDoc?: Doc | null;
};

const MIN_TIME = 5;
const MAX_TIME = 604800;
const MAX_RESEARCH = 2592000;
// OZL_Payload.MAX_POINTS: what a sample can carry.
export const MAX_POINTS = 1000;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const rec = (v: unknown): Doc => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Doc) : {});

// OZL_Ids.IsPathSafe: letters, digits, underscore, dash; nothing else.
export function isPathSafe(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

export { stripExact };

// OZL_PointTypes.ColorArgb reads "#RRGGBB" or "RRGGBB"; anything else is 0,
// and the tree screen takes a colour of its own.
export function isColor(c: string): boolean {
  return /^#?[0-9A-Fa-f]{6}$/.test(c.trim());
}

function factsOf(ctx: Context): ClassFacts {
  return ctx.facts ?? classFacts(null, ctx.classes ?? null);
}

function classCheck(out: Problem[], facts: ClassFacts, path: string, cls: string, what: string, consequence: string) {
  if (facts.exists(cls) === false) out.push({ path, severity: 'warn', message: `${what} '${cls}' is not in the server's class list; if it is really missing, ${consequence}` });
}

// The indices a reverse walk keeps: `why(i, seen)` names the reason an
// element is dropped, '' keeps it; `id(i)` is what `seen` remembers.
function keptFromEnd(n: number, why: (i: number, seen: Set<string>) => string, id: (i: number) => string, dropped: Map<number, string>): Set<number> {
  const seen = new Set<string>();
  const kept = new Set<number>();
  for (let i = n - 1; i >= 0; i--) {
    const w = why(i, seen);
    if (w) {
      dropped.set(i, w);
      continue;
    }
    seen.add(id(i));
    kept.add(i);
  }
  return kept;
}

export function validate(name: string, doc: Doc, ctx: Context = {}): Problem[] {
  switch (name) {
    case 'ResearchSettings': return settings(doc);
    case 'ResearchPointTypes': return pointTypes(doc);
    case 'ResearchOwners': return owners(doc, ctx);
    case 'ResearchRules': return rules(doc, ctx);
    case 'ResearchTree': return tree(doc, ctx);
    case 'ResearchModules': return modules(doc, ctx);
    case 'ResearchStatics': return statics(doc, ctx);
    default: return [];
  }
}

function settings(doc: Doc): Problem[] {
  const out: Problem[] = [];
  if (!isPathSafe(str(doc.DefaultOwner))) out.push({ path: 'DefaultOwner', severity: 'warn', message: `DefaultOwner '${str(doc.DefaultOwner)}' is not safe as a file name; the game uses 'loner'` });
  const depth = num(doc.TreeVisibilityDepth);
  if (depth < 0 || depth > 10) out.push({ path: 'TreeVisibilityDepth', severity: 'warn', message: `TreeVisibilityDepth ${depth} is outside 0..10; the game uses 1` });
  return out;
}

function pointTypes(doc: Doc): Problem[] {
  const out: Problem[] = [];
  const list = arr(doc.PointTypes).map(rec);
  const dropped = new Map<number, string>();
  const kept = keptFromEnd(list.length, (i, seen) => {
    const id = str(list[i].Id);
    if (id === '') return 'a point type with no Id is dropped';
    if (seen.has(id)) return `duplicate Id '${id}' is dropped (the game keeps the last one)`;
    if (str(list[i].Name) === '') return `type '${id}' has no Name and is dropped`;
    return '';
  }, (i) => str(list[i].Id), dropped);
  list.forEach((pt, i) => {
    const path = `PointTypes[${i}]`;
    if (dropped.has(i)) return out.push({ path, severity: 'drop', message: dropped.get(i) as string });
    const id = str(pt.Id);
    const bp = num(pt.BasePurity);
    if (bp <= 0) out.push({ path: `${path}.BasePurity`, severity: 'warn', message: `type '${id}': BasePurity ${bp} is not set; the game uses ${DEFAULT_PURITY} and writes it back` });
    else if (bp > 1) out.push({ path: `${path}.BasePurity`, severity: 'warn', message: `type '${id}': BasePurity ${bp} is above 1; the game sets it to 1` });
    if (str(pt.Color) !== '' && !isColor(str(pt.Color))) out.push({ path: `${path}.Color`, severity: 'info', message: `type '${id}': Color '${str(pt.Color)}' is not #RRGGBB; the tree screen uses a colour of its own` });
    if (!(LINE_IDS as readonly string[]).includes(id)) out.push({ path, severity: 'info', message: `type '${id}' is no line of the mod: no carrier carries it, so no terminal ever pays it` });
  });
  const ids = new Set([...kept].map((i) => str(list[i].Id)));
  const missing = LINE_IDS.filter((l) => !ids.has(l));
  if (missing.length) out.push({ path: 'PointTypes', severity: 'info', message: `lines of the mod with no point type: ${missing.join(', ')}; the game disables nothing, but their carriers cannot be deposited` });
  return out;
}

function owners(doc: Doc, ctx: Context): Problem[] {
  const out: Problem[] = [];
  const facts = factsOf(ctx);
  const list = arr(doc.Owners).map(rec);
  const dropped = new Map<number, string>();
  const kept = keptFromEnd(list.length, (i, seen) => {
    const id = str(list[i].Id);
    if (id === '') return 'an owner with no Id is dropped';
    if (!isPathSafe(id)) return `Id '${id}' is not safe as a file name, dropped`;
    if (seen.has(id)) return `duplicate Id '${id}' is dropped (the game keeps the last one)`;
    return '';
  }, (i) => str(list[i].Id), dropped);
  const skins = SKINS as readonly string[];
  list.forEach((o, i) => {
    const path = `Owners[${i}]`;
    if (dropped.has(i)) return out.push({ path, severity: 'drop', message: dropped.get(i) as string });
    const id = str(o.Id);
    const skin = str(o.Skin);
    if (skin !== '' && !skins.includes(skin)) out.push({ path: `${path}.Skin`, severity: 'warn', message: `'${id}': unknown Skin '${skin}', the game clears it` });
    if ((skin === '' || !skins.includes(skin)) && !skins.includes(id)) out.push({ path: `${path}.Skin`, severity: 'warn', message: `owner '${id}' has no skin of its own and its id names no window: it looks through neutral` });
    if (arr(o.TerminalClasses).some((c) => str(c) === '')) out.push({ path: `${path}.TerminalClasses`, severity: 'warn', message: 'an empty terminal class is removed' });
    if (arr(o.DeviceClasses).some((c) => str(c) === '')) out.push({ path: `${path}.DeviceClasses`, severity: 'warn', message: 'an empty device class is removed' });
    arr(o.TerminalClasses).forEach((c, k) => { if (str(c)) classCheck(out, facts, `${path}.TerminalClasses[${k}]`, str(c), 'terminal class', 'no terminal ever matches it'); });
    arr(o.DeviceClasses).forEach((c, k) => { if (str(c)) classCheck(out, facts, `${path}.DeviceClasses[${k}]`, str(c), 'device class', 'no station ever matches it'); });
  });
  // OZL_Owners.WarnShared: on the survivors, after the drops.
  const live = [...kept].sort((a, b) => a - b).map((i) => ({ o: list[i], i }));
  const terms = (o: Doc) => arr(o.TerminalClasses).map(str).filter(Boolean);
  const devs = (o: Doc) => arr(o.DeviceClasses).map(str).filter(Boolean);
  for (let a = 0; a < live.length; a++) {
    for (let b2 = a + 1; b2 < live.length; b2++) {
      const t = terms(live[a].o).filter((c) => terms(live[b2].o).includes(c));
      if (t.length) out.push({ path: `Owners[${live[a].i}]`, severity: 'info', message: `'${str(live[a].o.Id)}' and '${str(live[b2].o.Id)}' share the terminal ${t.join(', ')}: they see each other's trees` });
      const d = devs(live[a].o).filter((c) => devs(live[b2].o).includes(c));
      if (d.length) out.push({ path: `Owners[${live[a].i}]`, severity: 'info', message: `'${str(live[a].o.Id)}' and '${str(live[b2].o.Id)}' share the device ${d.join(', ')}` });
    }
  }
  const anyT = live.some(({ o }) => terms(o).length > 0);
  const anyD = live.some(({ o }) => devs(o).length > 0);
  for (const { o, i } of live) {
    if (anyT && terms(o).length === 0) out.push({ path: `Owners[${i}]`, severity: 'warn', message: `'${str(o.Id)}' owns no terminals while others do: its players will open no tree` });
    if (anyD && devs(o).length === 0) out.push({ path: `Owners[${i}]`, severity: 'warn', message: `'${str(o.Id)}' owns no devices while others do: its players will run no station` });
  }
  return out;
}

// Who may run a station of this class: the owners whose DeviceClasses
// match it; everyone ('*') when no owner lists devices.
export function deviceOwners(ownersDoc: Doc | null | undefined, device: string, facts: ClassFacts): string[] {
  const list = arr(ownersDoc?.Owners).map(rec).filter((o) => isPathSafe(str(o.Id)));
  if (!list.some((o) => arr(o.DeviceClasses).some((c) => str(c) !== ''))) return ['*'];
  const actual = stripExact(device);
  return list.filter((o) => arr(o.DeviceClasses).some((c) => str(c) !== '' && matchClass(actual, str(c), facts.kindOf))).map((o) => str(o.Id));
}

function rules(doc: Doc, ctx: Context): Problem[] {
  const out: Problem[] = [];
  const facts = factsOf(ctx);
  const groups = arr(doc.Groups).map(rec);
  // OZL_Rules.Validate: groups from the end, rules from the end of each,
  // one set of rule ids across all of them.
  const droppedGroups = new Map<number, string>();
  const droppedRules = new Map<string, string>();
  const seenGroups = new Set<string>();
  const seenRules = new Set<string>();
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const gid = str(groups[gi].Id);
    if (gid === '' || seenGroups.has(gid)) {
      droppedGroups.set(gi, gid === '' ? 'a group with no Id is dropped, with every rule in it' : `duplicate group Id '${gid}' is dropped, with every rule in it (the game keeps the last one)`);
      continue;
    }
    seenGroups.add(gid);
    const rs = arr(groups[gi].Rules).map(rec);
    for (let ri = rs.length - 1; ri >= 0; ri--) {
      const id = str(rs[ri].Id);
      if (id === '' || seenRules.has(id)) {
        droppedRules.set(`${gi}:${ri}`, id === '' ? 'a rule with no Id is dropped' : `duplicate rule Id '${id}' is dropped (the game keeps the last one)`);
        continue;
      }
      seenRules.add(id);
    }
  }
  groups.forEach((g, gi) => {
    const gpath = `Groups[${gi}]`;
    if (droppedGroups.has(gi)) return out.push({ path: gpath, severity: 'drop', message: droppedGroups.get(gi) as string });
    arr(g.Rules).map(rec).forEach((r, ri) => {
      const path = `${gpath}.Rules[${ri}]`;
      const why = droppedRules.get(`${gi}:${ri}`);
      if (why) return out.push({ path, severity: 'drop', message: why });
      const id = str(r.Id);
      if (r.Enabled === false) return out.push({ path, severity: 'info', message: `rule '${id}' is disabled` });
      const problem = ruleProblem(r, facts, out, path);
      if (problem) out.push({ path, severity: 'disable', message: `rule '${id}' is disabled by the game: ${problem}` });
      else carrierPoolCheck(r, facts, ctx, out, path);
      ruleReach(r, facts, ctx, out, path);
    });
  });
  return out;
}

// OZL_Rules.Problem: the first reason, or ''. Class existence rides beside
// it as a warning (the game would disable the rule if the class is
// really missing).
function ruleProblem(r: Doc, facts: ClassFacts, out: Problem[], path: string): string {
  const t = num(r.TimeSec);
  if (t < MIN_TIME) return `TimeSec below the minimum of ${MIN_TIME} s`;
  if (t > MAX_TIME) return 'TimeSec above 7 days';
  if (num(r.Purity) > 1) return 'Purity above 1 (0 or below takes the BasePurity of the line)';
  const device = str(r.Device);
  if (device === '') return "unknown Device ''";
  classCheck(out, facts, `${path}.Device`, device, 'device', 'the game disables the rule');
  const input = rec(r.InputItem);
  const icls = str(input.Classname);
  if (icls === '') return 'no InputItem.Classname';
  classCheck(out, facts, `${path}.InputItem.Classname`, icls, 'input class', 'the game disables the rule');
  const iq = num(input.Quantity);
  if (iq < 1 || iq > 100) return 'InputItem.Quantity outside 1..100';
  if (input.ConsumeInput === false) return 'ConsumeInput=false would make an endless conveyor';
  if (facts.isMagazine(icls)) return 'an input from CfgMagazines is not supported';
  for (const [i, tool] of arr(r.RequiredTools).entries()) classCheck(out, facts, `${path}.RequiredTools[${i}]`, str(tool), 'tool class', 'the game disables the rule');
  for (const [i, worn] of arr(r.RequiredWorn).entries()) classCheck(out, facts, `${path}.RequiredWorn[${i}]`, str(worn), 'worn class', 'the game disables the rule');
  for (const [i, craw] of arr(r.Consumables).entries()) {
    const c = rec(craw);
    const cls = str(c.Classname);
    if (cls === '') return 'unknown Consumable (no Classname)';
    classCheck(out, facts, `${path}.Consumables[${i}]`, cls, 'consumable class', 'the game disables the rule');
    const q = num(c.Quantity);
    if (q < 1 || q > 100) return 'Consumable.Quantity outside 1..100';
    if (facts.isMagazine(cls)) return 'a consumable from CfgMagazines is not supported';
    const role = facts.role(cls);
    if (role === 'sample' || role === 'carrier') return 'a sample or a carrier cannot be a consumable';
  }
  for (const [i, oraw] of arr(r.Outputs).entries()) {
    const o = rec(oraw);
    const cls = str(o.Classname);
    if (cls === '') return 'unknown Output (no Classname)';
    // The game looks an output up as written: "X|1" is no class.
    if (cls.includes('|')) return `unknown Output '${cls}': an output is a class to make, the |1 mark does not belong there`;
    classCheck(out, facts, `${path}.Outputs[${i}]`, cls, 'output class', 'the game disables the rule');
    const ch = num(o.Chance);
    if (ch < 0 || ch > 1) return 'Output.Chance outside 0..1';
    const q = num(o.Quantity);
    if (q < 1 || q > 100) return 'Output.Quantity outside 1..100';
  }
  return lineProblem(r, facts, out, path);
}

// OZL_Rules.LineProblem: a sample goes only out of a packer of its line
// and only into an analyzer of its line; a carrier comes only out of the
// analysis of a sample of its line, and exactly one. A line the mirror does
// not know turns the check into a warning.
function lineProblem(r: Doc, facts: ClassFacts, out: Problem[], path: string): string {
  const dev = stripExact(str(r.Device));
  const input = stripExact(str(rec(r.InputItem).Classname));
  const outputs = arr(r.Outputs).map(rec);
  const unsure = (a: string, b: string) => out.push({ path, severity: 'warn', message: `the editor does not know the line of '${facts.line(a) === null ? a : b}' (its mirror of the mod's config.cpp is older than the class); the game checks that the lines match` });
  if (facts.role(input) === 'sample') {
    const same = sameLine(facts, dev, input);
    if (facts.role(dev) !== 'analyzer') return `sample '${input}' goes into '${dev}', which is not an analyzer of its line`;
    if (same === false) return `sample '${input}' goes into '${dev}', which is not an analyzer of its line`;
    if (same === undefined) unsure(dev, input);
    if (num(rec(r.InputItem).Quantity) !== 1) return 'an analysis takes exactly one sample';
    const o = outputs[0];
    if (outputs.length !== 1 || facts.role(str(o.Classname)) !== 'carrier') return "an analysis gives exactly one carrier of the sample's line";
    const carrierSame = sameLine(facts, str(o.Classname), input);
    if (carrierSame === false) return "an analysis gives exactly one carrier of the sample's line";
    if (carrierSame === undefined) unsure(str(o.Classname), input);
    if (num(o.Points) !== 0) return 'Points on an analysis output: a carrier takes the points of its sample';
    return '';
  }
  for (const o of outputs) {
    const cls = stripExact(str(o.Classname));
    const role = facts.role(cls);
    if (role === 'carrier') return `carrier '${cls}' comes out of something other than the analysis of a sample`;
    if (role === 'sample') {
      const same = sameLine(facts, dev, cls);
      if (facts.role(dev) !== 'packer' || same === false) return `sample '${cls}' comes out of '${dev}', which is not a packer of its line`;
      if (same === undefined) unsure(dev, cls);
      const p = num(o.Points);
      if (p < 1 || p > MAX_POINTS) return `sample output '${cls}' needs Points 1..${MAX_POINTS}`;
    } else if (num(o.Points) !== 0) {
      return `Points given for '${cls}', which is not a sample`;
    }
  }
  return '';
}

// OZL_Rules.Check, after Problem passed: an analysis whose carrier's line
// has no point type works, but no terminal takes the carrier.
function carrierPoolCheck(r: Doc, facts: ClassFacts, ctx: Context, out: Problem[], path: string) {
  if (!ctx.pointTypes) return;
  const outputs = arr(r.Outputs).map(rec);
  if (outputs.length !== 1 || facts.role(str(outputs[0].Classname)) !== 'carrier') return;
  const line = facts.line(str(outputs[0].Classname));
  if (line && !ctx.pointTypes.has(line)) out.push({ path, severity: 'warn', message: `rule '${str(r.Id)}': line '${line}' has no point type, its carriers cannot be deposited` });
}

// What the game does not check but the editor can see: a rule nobody can
// ever run.
function ruleReach(r: Doc, facts: ClassFacts, ctx: Context, out: Problem[], path: string) {
  const id = str(r.Id);
  if (str(r.RequiredNode) && ctx.nodeIds && !ctx.nodeIds.has(str(r.RequiredNode))) out.push({ path: `${path}.RequiredNode`, severity: 'warn', message: `rule '${id}' requires node '${str(r.RequiredNode)}', which the tree does not have: nobody can ever run it` });
  if (ctx.owners) for (const f of arr(r.RequiredFactions)) if (str(f) && !ctx.owners.has(str(f))) out.push({ path: `${path}.RequiredFactions`, severity: 'warn', message: `rule '${id}' names faction '${str(f)}', which the owners config does not have` });
  const dev = str(r.Device);
  if (dev && ctx.ownersDoc && deviceOwners(ctx.ownersDoc, dev, facts).length === 0) out.push({ path: `${path}.Device`, severity: 'info', message: `rule '${id}': no owner lists '${dev}' among its devices, so nobody can start it` });
  // A tool must sit in the station's slots: modules go only on a packer of
  // their own line, and an analyzer has no slots for them.
  const devRole = facts.role(stripExact(dev));
  for (const [i, raw] of arr(r.RequiredTools).entries()) {
    const tool = stripExact(str(raw));
    if (!tool || facts.role(tool) !== 'module') continue;
    if (devRole === 'analyzer' || devRole === 'terminal') out.push({ path: `${path}.RequiredTools[${i}]`, severity: 'warn', message: `rule '${id}' requires module '${tool}', but '${stripExact(dev)}' has no module slots: the rule never runs` });
    else if (devRole === 'packer' && sameLine(facts, tool, dev) === false) out.push({ path: `${path}.RequiredTools[${i}]`, severity: 'warn', message: `rule '${id}' requires module '${tool}' of line '${facts.line(tool)}', which does not go on '${stripExact(dev)}' of line '${facts.line(dev)}': the rule never runs` });
  }
}

function tree(doc: Doc, ctx: Context): Problem[] {
  const out: Problem[] = [];
  const facts = factsOf(ctx);
  const branches = arr(doc.Branches).map(rec);
  // OZL_TreeConfig.Validate: branches from the end, nodes from the end of
  // each, one set of node ids across all branches.
  const droppedBranches = new Map<number, string>();
  const dropped = new Map<string, string>();
  const seenBranches = new Set<string>();
  const seenNodes = new Set<string>();
  for (let bi = branches.length - 1; bi >= 0; bi--) {
    const bid = str(branches[bi].Id);
    if (bid === '' || seenBranches.has(bid)) {
      droppedBranches.set(bi, bid === '' ? 'a branch with no Id is dropped, with every node in it' : `duplicate branch Id '${bid}' is dropped, with every node in it (the game keeps the last one)`);
      continue;
    }
    seenBranches.add(bid);
    const nodes = arr(branches[bi].Nodes).map(rec);
    for (let ni = nodes.length - 1; ni >= 0; ni--) {
      const n = nodes[ni];
      const id = str(n.Id);
      const pm = str(n.ParentsMode).toLowerCase();
      const rt = num(n.ResearchTimeSec);
      let why = '';
      if (id === '') why = 'a node with no Id is dropped';
      else if (seenNodes.has(id)) why = `duplicate node Id '${id}' is dropped (the game keeps the last one)`;
      else if (str(n.Name) === '') why = `node '${id}' has no Name and is dropped`;
      else if (pm !== 'all' && pm !== 'any') why = `node '${id}': ParentsMode must be all or any, dropped`;
      else if (rt < 0 || rt > MAX_RESEARCH) why = `node '${id}': ResearchTimeSec outside 0..30 days, dropped`;
      if (why) {
        dropped.set(`${bi}:${ni}`, why);
        continue;
      }
      seenNodes.add(id);
    }
  }
  const allIds = new Set<string>();
  branches.forEach((br, bi) => {
    if (droppedBranches.has(bi)) return;
    arr(br.Nodes).forEach((n, ni) => { if (!dropped.has(`${bi}:${ni}`)) allIds.add(str(rec(n).Id)); });
  });
  branches.forEach((br, bi) => {
    const bid = str(br.Id);
    const bpath = `Branches[${bi}]`;
    if (droppedBranches.has(bi)) return out.push({ path: bpath, severity: 'drop', message: droppedBranches.get(bi) as string });
    if (ctx.owners) for (const o of arr(br.Owners)) if (!ctx.owners.has(str(o))) out.push({ path: `${bpath}.Owners`, severity: 'warn', message: `branch '${bid}' names owner '${str(o)}', which the owners config does not have` });
    arr(br.Nodes).map(rec).forEach((n, ni) => {
      const path = `${bpath}.Nodes[${ni}]`;
      const why = dropped.get(`${bi}:${ni}`);
      if (why) return out.push({ path, severity: 'drop', message: why });
      const id = str(n.Id);
      // OZL_TreeConfig.NodeProblem: the node is dropped from the live copy.
      const problem = nodeProblem(n, facts, ctx, out, path);
      if (problem) {
        dropped.set(`${bi}:${ni}`, problem.message);
        return out.push({ path: problem.path, severity: 'drop', message: `node '${id}': ${problem.message}, the node is dropped` });
      }
      for (const p of arr(n.Parents)) if (!allIds.has(str(p))) out.push({ path: `${path}.Parents`, severity: 'warn', message: `node '${id}' names parent '${str(p)}', which no branch has: the node is unreachable` });
      if (ctx.owners) for (const o of arr(n.RequiredFactions)) if (!ctx.owners.has(str(o))) out.push({ path: `${path}.RequiredFactions`, severity: 'warn', message: `node '${id}' requires faction '${str(o)}', which the owners config does not have` });
    });
  });
  const keep = (bi: number, ni: number) => !droppedBranches.has(bi) && !dropped.has(`${bi}:${ni}`);
  for (const id of unreachable(doc, keep)) out.push({ path: `node:${id}`, severity: 'warn', message: `node '${id}' is unreachable (a cycle or a missing parent)` });
  return out;
}

function nodeProblem(n: Doc, facts: ClassFacts, ctx: Context, out: Problem[], path: string): { path: string; message: string } | null {
  const seenCost = new Set<string>();
  for (const [i, craw] of arr(n.Cost).entries()) {
    const c = rec(craw);
    const type = str(c.Type);
    const at = `${path}.Cost[${i}]`;
    if (ctx.pointTypes && !ctx.pointTypes.has(type)) return { path: at, message: `unknown point type '${type}' in Cost` };
    const a = num(c.Amount);
    if (a < 0 || a > 1000000) return { path: at, message: 'Cost.Amount outside 0..1000000' };
    if (seenCost.has(type)) return { path: at, message: `point type '${type}' twice in Cost` };
    seenCost.add(type);
  }
  for (const [i, iraw] of arr(n.ItemCost).entries()) {
    const ic = rec(iraw);
    const cls = str(ic.Classname);
    const at = `${path}.ItemCost[${i}]`;
    if (cls === '') return { path: at, message: 'an ItemCost with no Classname' };
    classCheck(out, facts, at, cls, 'item cost class', 'the game drops the node');
    const q = num(ic.Quantity);
    if (q < 1 || q > 100) return { path: at, message: 'ItemCost.Quantity outside 1..100' };
  }
  return null;
}

function modules(doc: Doc, ctx: Context): Problem[] {
  const out: Problem[] = [];
  const facts = factsOf(ctx);
  const list = arr(doc.Modules).map(rec);
  const dropped = new Map<number, string>();
  keptFromEnd(list.length, (i, seen) => {
    const cls = str(list[i].Classname);
    const bonus = num(list[i].PurityBonus);
    const dbl = num(list[i].DoubleChance);
    if (cls === '') return 'a module with no Classname is dropped';
    if (seen.has(cls)) return `duplicate class '${cls}' is dropped (the game keeps the last one)`;
    if (bonus < 0 || bonus > 1) return `PurityBonus of '${cls}' outside 0..1, dropped`;
    if (dbl < 0 || dbl > 1) return `DoubleChance of '${cls}' outside 0..1, dropped`;
    return '';
  }, (i) => str(list[i].Classname), dropped);
  const listed = new Set<string>();
  list.forEach((m, i) => {
    const path = `Modules[${i}]`;
    if (dropped.has(i)) return out.push({ path, severity: 'drop', message: dropped.get(i) as string });
    const cls = stripExact(str(m.Classname));
    listed.add(cls.toLowerCase());
    // OZL_Modules.Check: a line module of this mod, or dropped.
    if (facts.exists(cls) === false) return out.push({ path, severity: 'warn', message: `module class '${cls}' is not in the server's class list; if it is really missing, the game drops the module` });
    if (facts.role(cls) !== 'module') return out.push({ path, severity: 'drop', message: `'${str(m.Classname)}' is not a line module of this mod (OZL_Tool_Base), dropped` });
    const line = facts.line(cls);
    if (line === '') return out.push({ path, severity: 'drop', message: `'${str(m.Classname)}' has no line, dropped` });
    if (line === null) out.push({ path, severity: 'warn', message: `the editor does not know the line of '${cls}'; the game drops the module if it has none` });
  });
  const unlisted = MODULE_CLASSES.filter((c) => !listed.has(c.toLowerCase()) && facts.exists(c) !== false);
  if (unlisted.length) out.push({ path: 'Modules', severity: 'info', message: `modules of the mod this list leaves out give nothing in a packer: ${unlisted.join(', ')}` });
  return out;
}

function statics(doc: Doc, ctx: Context): Problem[] {
  const out: Problem[] = [];
  const facts = factsOf(ctx);
  const list = arr(doc.Entries).map(rec);
  const dropped = new Map<number, string>();
  keptFromEnd(list.length, (i, seen) => {
    const id = str(list[i].Id);
    if (id === '') return 'an entry with no Id is dropped';
    if (seen.has(id)) return `duplicate Id '${id}' is dropped (the game keeps the last one)`;
    if (str(list[i].ClassName) === '') return `'${id}' has no ClassName and is dropped`;
    if (arr(list[i].Pos).length !== 3) return `'${id}' needs Pos of three numbers, dropped`;
    return '';
  }, (i) => str(list[i].Id), dropped);
  list.forEach((e, i) => {
    const path = `Entries[${i}]`;
    if (dropped.has(i)) return out.push({ path, severity: 'drop', message: dropped.get(i) as string });
    classCheck(out, facts, path, str(e.ClassName), 'static class', 'the game skips the entry at spawn');
  });
  return out;
}

export function worst(problems: Problem[]): Severity | null {
  const order: Severity[] = ['drop', 'disable', 'warn', 'info'];
  for (const sev of order) if (problems.some((p) => p.severity === sev)) return sev;
  return null;
}
