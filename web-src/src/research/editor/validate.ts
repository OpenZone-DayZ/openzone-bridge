// The mirror of the game's Validate() and Check() of every research
// config (OZL_*.c), so the admin sees before sending what the game would
// do with the text. Four weights:
//
//   drop     the game drops the element (or the whole group) on load;
//   disable  the game keeps the element but switches it off (a rule);
//   warn     the game keeps it and writes a WARNING;
//   info     a fact worth knowing, nothing the game complains about.
//
// A class the server's list does not hold is always `warn`: the list is
// a dump from the last boot, and a mod added since would make a false
// alarm out of a hard refusal. The message says what the game would do.

import type { Doc } from './schema';
import { unreachable } from './treeModel';

export type Severity = 'drop' | 'disable' | 'warn' | 'info';
export type Problem = { path: string; severity: Severity; message: string };

export type Context = {
  // Every CfgVehicles class name the server dumped at boot; null = unknown.
  classes?: Set<string> | null;
  // The ids of PointTypes (from the point types config, or this one).
  pointTypes?: Set<string>;
  // The node ids of the tree (for RequiredNode).
  nodeIds?: Set<string>;
  // The owner ids (the factions of the core); optional, informative.
  owners?: Set<string>;
};

const MIN_TIME = 5;
const MAX_TIME = 604800;
const MAX_RESEARCH = 2592000;
const MAX_CARRIER = 1000;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const rec = (v: unknown): Doc => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Doc) : {});

// OZL_Ids.IsPathSafe: letters, digits, underscore, dash; nothing else.
export function isPathSafe(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

// OZL_Match.StripExact: "Class|1" means exactly that class.
export function stripExact(cls: string): string {
  const at = cls.indexOf('|');
  return at > -1 ? cls.slice(0, at) : cls;
}

export const isSampleClass = (cls: string): boolean => stripExact(cls).startsWith('OZL_Sample_');
export const isCarrierClass = (cls: string): boolean => stripExact(cls).startsWith('OZL_Carrier_');
export const isDataClass = (cls: string): boolean => stripExact(cls).startsWith('OZL_Data_');

// OZL_CarrierState.Parse: "<point type>:<1..1000>", the number printed back
// the same way it was written.
export function parseCarrierState(state: string): { type: string; amount: number } | null {
  const sep = state.indexOf(':');
  if (sep < 1 || sep >= state.length - 1) return null;
  const type = state.slice(0, sep);
  const tail = state.slice(sep + 1);
  const amount = Number(tail);
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_CARRIER || String(amount) !== tail) return null;
  return { type, amount };
}

function classKnown(ctx: Context, cls: string): boolean | null {
  if (!ctx.classes) return null;
  return ctx.classes.has(stripExact(cls));
}

// OZL_Rules.ContentProblem, as a message or ''.
function contentProblem(where: string, cls: string, content: string, ctx: Context): string {
  const carrier = isCarrierClass(cls);
  if (content === '') return carrier ? `${where}: carrier '${cls}' needs Content of the form <point type>:<amount>` : '';
  if (!isSampleClass(cls) && !carrier) return `${where}: Content given for '${cls}', but only samples and carriers carry content`;
  if (content.length > 64) return `${where}: Content longer than 64 characters`;
  if (content.trim() !== content) return `${where}: Content '${content}' has leading or trailing spaces`;
  if (carrier) {
    const st = parseCarrierState(content);
    if (!st) return `${where}: carrier state '${content}' must be <point type>:<1..${MAX_CARRIER}>`;
    if (ctx.pointTypes && !ctx.pointTypes.has(st.type)) return `${where}: carrier promises point type '${st.type}', which PointTypes does not know`;
  }
  return '';
}

function classCheck(out: Problem[], ctx: Context, path: string, cls: string, what: string, consequence: string) {
  const known = classKnown(ctx, cls);
  if (known === false) out.push({ path, severity: 'warn', message: `${what} '${cls}' is not in the server's class list; if it is really missing, ${consequence}` });
}

export function validate(name: string, doc: Doc, ctx: Context = {}): Problem[] {
  switch (name) {
    case 'ResearchSettings': return settings(doc);
    case 'ResearchPointTypes': return pointTypes(doc);
    case 'ResearchOwners': return owners(doc);
    case 'ResearchRules': return rules(doc, ctx);
    case 'ResearchTree': return tree(doc, ctx);
    case 'ResearchDataItems': return dataItems(doc, ctx);
    case 'ResearchModules': return modules(doc, ctx);
    case 'ResearchSampleTypes': return sampleTypes(doc, ctx);
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
  const seen = new Set<string>();
  arr(doc.PointTypes).forEach((raw, i) => {
    const pt = rec(raw);
    const id = str(pt.Id);
    const path = `PointTypes[${i}]`;
    if (id === '') return out.push({ path, severity: 'drop', message: 'a point type with no Id is dropped' });
    if (seen.has(id)) return out.push({ path, severity: 'drop', message: `duplicate Id '${id}' is dropped` });
    if (str(pt.Name) === '') return out.push({ path, severity: 'drop', message: `type '${id}' has no Name and is dropped` });
    const tier = num(pt.Tier);
    if (tier < 0 || tier > 10) return out.push({ path, severity: 'drop', message: `type '${id}': Tier outside 0..10, dropped` });
    seen.add(id);
  });
  const cats = new Set(arr(doc.Categories).map((d) => str(rec(d).Id)));
  const kinds = new Set(arr(doc.Kinds).map((d) => str(rec(d).Id)));
  const missingCats = new Set<string>();
  const missingKinds = new Set<string>();
  for (const raw of arr(doc.PointTypes)) {
    const pt = rec(raw);
    if (str(pt.Category) && !cats.has(str(pt.Category))) missingCats.add(str(pt.Category));
    if (str(pt.Kind) && !kinds.has(str(pt.Kind))) missingKinds.add(str(pt.Kind));
  }
  if (missingCats.size) out.push({ path: 'Categories', severity: 'info', message: `categories the types use but the list does not describe: ${[...missingCats].join(', ')}; the game names them by their id` });
  if (missingKinds.size) out.push({ path: 'Kinds', severity: 'info', message: `kinds the types use but the list does not describe: ${[...missingKinds].join(', ')}; the game names them by their id` });
  return out;
}

function owners(doc: Doc): Problem[] {
  const out: Problem[] = [];
  const seen = new Set<string>();
  const dropped = new Set<number>();
  const list = arr(doc.Owners).map(rec);
  list.forEach((o, i) => {
    const id = str(o.Id);
    const path = `Owners[${i}]`;
    if (id === '') return dropped.add(i) && out.push({ path, severity: 'drop', message: 'an owner with no Id is dropped' });
    if (!isPathSafe(id)) return dropped.add(i) && out.push({ path, severity: 'drop', message: `Id '${id}' is not safe as a file name, dropped` });
    if (seen.has(id)) return dropped.add(i) && out.push({ path, severity: 'drop', message: `duplicate Id '${id}' is dropped` });
    seen.add(id);
    if (arr(o.TerminalClasses).some((c) => str(c) === '')) out.push({ path: `${path}.TerminalClasses`, severity: 'warn', message: 'an empty terminal class is removed' });
    if (arr(o.DeviceClasses).some((c) => str(c) === '')) out.push({ path: `${path}.DeviceClasses`, severity: 'warn', message: 'an empty device class is removed' });
  });
  // The game drops first and looks at the survivors after.
  const kept = list.map((o, i) => ({ o, i })).filter(({ i }) => !dropped.has(i));
  const anyT = kept.some(({ o }) => arr(o.TerminalClasses).length > 0);
  const anyD = kept.some(({ o }) => arr(o.DeviceClasses).length > 0);
  kept.forEach(({ o, i }) => {
    if (anyT && arr(o.TerminalClasses).length === 0) out.push({ path: `Owners[${i}]`, severity: 'warn', message: `'${str(o.Id)}' owns no terminals while others do: its players will open no tree` });
    if (anyD && arr(o.DeviceClasses).length === 0) out.push({ path: `Owners[${i}]`, severity: 'warn', message: `'${str(o.Id)}' owns no devices while others do: its players will run no station` });
  });
  for (let a = 0; a < kept.length; a++) {
    for (let b2 = a + 1; b2 < kept.length; b2++) {
      const shared = arr(kept[a].o.TerminalClasses).filter((c) => arr(kept[b2].o.TerminalClasses).includes(c));
      if (shared.length) out.push({ path: `Owners[${kept[a].i}]`, severity: 'info', message: `'${str(kept[a].o.Id)}' and '${str(kept[b2].o.Id)}' share the terminal ${shared.join(', ')}: they see each other's trees` });
    }
  }
  return out;
}

function rules(doc: Doc, ctx: Context): Problem[] {
  const out: Problem[] = [];
  const seenGroups = new Set<string>();
  const seenRules = new Set<string>();
  arr(doc.Groups).forEach((graw, gi) => {
    const g = rec(graw);
    const gid = str(g.Id);
    const gpath = `Groups[${gi}]`;
    if (gid === '' || seenGroups.has(gid)) return out.push({ path: gpath, severity: 'drop', message: gid === '' ? 'a group with no Id is dropped, with every rule in it' : `duplicate group Id '${gid}' is dropped, with every rule in it` });
    seenGroups.add(gid);
    arr(g.Rules).forEach((rraw, ri) => {
      const r = rec(rraw);
      const id = str(r.Id);
      const path = `${gpath}.Rules[${ri}]`;
      if (id === '' || seenRules.has(id)) return out.push({ path, severity: 'drop', message: id === '' ? 'a rule with no Id is dropped' : `duplicate rule Id '${id}' is dropped` });
      seenRules.add(id);
      if (r.Enabled === false) return out.push({ path, severity: 'info', message: `rule '${id}' is disabled` });
      const why = ruleProblem(r, ctx, out, path);
      if (why) out.push({ path, severity: 'disable', message: `rule '${id}' is disabled by the game: ${why}` });
      if (str(r.RequiredNode) && ctx.nodeIds && !ctx.nodeIds.has(str(r.RequiredNode))) out.push({ path: `${path}.RequiredNode`, severity: 'warn', message: `rule '${id}' requires node '${str(r.RequiredNode)}', which the tree does not have: nobody can ever run it` });
    });
  });
  return out;
}

// OZL_Rules.Problem: the first reason, or ''. Class existence rides beside
// it as a warning (the game would disable the rule if the class is
// really missing).
function ruleProblem(r: Doc, ctx: Context, out: Problem[], path: string): string {
  const t = num(r.TimeSec);
  if (t < MIN_TIME) return `TimeSec below the minimum of ${MIN_TIME} s`;
  if (t > MAX_TIME) return 'TimeSec above 7 days';
  const pmin = num(r.BasePurityMin);
  const pmax = num(r.BasePurityMax);
  if (pmin < 0 || pmin > 2 || pmax < 0 || pmax > 2) return 'BasePurity outside 0..2';
  if (pmax < pmin) return 'BasePurityMax below BasePurityMin';
  const device = str(r.Device);
  if (device === '') return 'no Device';
  classCheck(out, ctx, `${path}.Device`, device, 'device', 'the game disables the rule');
  const input = rec(r.InputItem);
  const icls = str(input.Classname);
  if (icls === '') return 'no InputItem.Classname';
  classCheck(out, ctx, `${path}.InputItem.Classname`, icls, 'input class', 'the game disables the rule');
  const iq = num(input.Quantity);
  if (iq < 1 || iq > 100) return 'InputItem.Quantity outside 1..100';
  if (input.ConsumeInput === false) return 'ConsumeInput=false would make an endless conveyor';
  let err = contentProblem('InputItem', icls, str(input.Content), ctx);
  if (err) return err;
  for (const [i, tool] of arr(r.RequiredTools).entries()) classCheck(out, ctx, `${path}.RequiredTools[${i}]`, str(tool), 'tool class', 'the game disables the rule');
  for (const [i, worn] of arr(r.RequiredWorn).entries()) classCheck(out, ctx, `${path}.RequiredWorn[${i}]`, str(worn), 'worn class', 'the game disables the rule');
  for (const [i, craw] of arr(r.Consumables).entries()) {
    const c = rec(craw);
    if (str(c.Classname) === '') return 'a consumable with no Classname';
    classCheck(out, ctx, `${path}.Consumables[${i}]`, str(c.Classname), 'consumable class', 'the game disables the rule');
    const q = num(c.Quantity);
    if (q < 1 || q > 100) return 'Consumable.Quantity outside 1..100';
    err = contentProblem('Consumable', str(c.Classname), str(c.Content), ctx);
    if (err) return err;
  }
  for (const [i, oraw] of arr(r.Outputs).entries()) {
    const o = rec(oraw);
    if (str(o.Classname) === '') return 'an output with no Classname';
    classCheck(out, ctx, `${path}.Outputs[${i}]`, str(o.Classname), 'output class', 'the game disables the rule');
    const ch = num(o.Chance);
    if (ch < 0 || ch > 1) return 'Output.Chance outside 0..1';
    const q = num(o.Quantity);
    if (q < 1 || q > 100) return 'Output.Quantity outside 1..100';
    err = contentProblem('Output', str(o.Classname), str(o.Content), ctx);
    if (err) return err;
    if (isSampleClass(str(o.Classname)) && str(o.Content) === '') return `output '${str(o.Classname)}' has no Content: no rule could ever take that sample`;
  }
  return '';
}

function tree(doc: Doc, ctx: Context): Problem[] {
  const out: Problem[] = [];
  const seenBranches = new Set<string>();
  const seenNodes = new Set<string>();
  const allIds = new Set<string>();
  for (const braw of arr(doc.Branches)) for (const nraw of arr(rec(braw).Nodes)) allIds.add(str(rec(nraw).Id));
  arr(doc.Branches).forEach((braw, bi) => {
    const br = rec(braw);
    const bid = str(br.Id);
    const bpath = `Branches[${bi}]`;
    if (bid === '' || seenBranches.has(bid)) return out.push({ path: bpath, severity: 'drop', message: bid === '' ? 'a branch with no Id is dropped, with every node in it' : `duplicate branch Id '${bid}' is dropped, with every node in it` });
    seenBranches.add(bid);
    if (ctx.owners) for (const o of arr(br.Owners)) if (!ctx.owners.has(str(o))) out.push({ path: `${bpath}.Owners`, severity: 'warn', message: `branch '${bid}' names owner '${str(o)}', which the owners config does not have` });
    arr(br.Nodes).forEach((nraw, ni) => {
      const n = rec(nraw);
      const id = str(n.Id);
      const path = `${bpath}.Nodes[${ni}]`;
      if (id === '') return out.push({ path, severity: 'drop', message: 'a node with no Id is dropped' });
      if (seenNodes.has(id)) return out.push({ path, severity: 'drop', message: `duplicate node Id '${id}' is dropped` });
      if (str(n.Name) === '') return out.push({ path, severity: 'drop', message: `node '${id}' has no Name and is dropped` });
      const pm = str(n.ParentsMode).toLowerCase();
      if (pm !== 'all' && pm !== 'any') return out.push({ path, severity: 'drop', message: `node '${id}': ParentsMode must be all or any, dropped` });
      const rt = num(n.ResearchTimeSec);
      if (rt < 0 || rt > MAX_RESEARCH) return out.push({ path, severity: 'drop', message: `node '${id}': ResearchTimeSec outside 0..30 days, dropped` });
      seenNodes.add(id);
      const seenCost = new Set<string>();
      for (const [i, craw] of arr(n.Cost).entries()) {
        const c = rec(craw);
        const type = str(c.Type);
        if (ctx.pointTypes && !ctx.pointTypes.has(type)) return out.push({ path: `${path}.Cost[${i}]`, severity: 'drop', message: `node '${id}': unknown point type '${type}' in Cost, the node is dropped` });
        const a = num(c.Amount);
        if (a < 0 || a > 1000000) return out.push({ path: `${path}.Cost[${i}]`, severity: 'drop', message: `node '${id}': Cost.Amount outside 0..1000000, the node is dropped` });
        if (seenCost.has(type)) return out.push({ path: `${path}.Cost[${i}]`, severity: 'drop', message: `node '${id}': point type '${type}' twice in Cost, the node is dropped` });
        seenCost.add(type);
      }
      for (const [i, iraw] of arr(n.ItemCost).entries()) {
        const ic = rec(iraw);
        const cls = str(ic.Classname);
        if (cls === '') return out.push({ path: `${path}.ItemCost[${i}]`, severity: 'drop', message: `node '${id}': an ItemCost with no Classname, the node is dropped` });
        classCheck(out, ctx, `${path}.ItemCost[${i}]`, cls, 'item cost class', 'the game drops the node');
        const q = num(ic.Quantity);
        if (q < 1 || q > 100) return out.push({ path: `${path}.ItemCost[${i}]`, severity: 'drop', message: `node '${id}': ItemCost.Quantity outside 1..100, the node is dropped` });
        const err = contentProblem('ItemCost', cls, str(ic.Content), ctx);
        if (err) return out.push({ path: `${path}.ItemCost[${i}]`, severity: 'drop', message: `node '${id}': ${err}, the node is dropped` });
      }
      for (const p of arr(n.Parents)) if (!allIds.has(str(p))) out.push({ path: `${path}.Parents`, severity: 'warn', message: `node '${id}' names parent '${str(p)}', which no branch has: the node is unreachable` });
      if (ctx.owners) for (const o of arr(n.RequiredFactions)) if (!ctx.owners.has(str(o))) out.push({ path: `${path}.RequiredFactions`, severity: 'warn', message: `node '${id}' requires faction '${str(o)}', which the owners config does not have` });
    });
  });
  for (const id of unreachable(doc)) out.push({ path: `node:${id}`, severity: 'warn', message: `node '${id}' is unreachable (a cycle or a missing parent)` });
  return out;
}

function dataItems(doc: Doc, ctx: Context): Problem[] {
  const out: Problem[] = [];
  const seen = new Set<string>();
  arr(doc.Items).forEach((raw, i) => {
    const d = rec(raw);
    const id = str(d.Id);
    const path = `Items[${i}]`;
    if (id === '') return out.push({ path, severity: 'drop', message: 'an entry with no Id is dropped' });
    const key = id.toLowerCase();
    if (seen.has(key)) return out.push({ path, severity: 'drop', message: `duplicate Id '${id}' is dropped` });
    if (str(d.Name) === '') return out.push({ path, severity: 'drop', message: `'${id}' has no Name and is dropped` });
    seen.add(key);
    if (!isDataClass(id)) out.push({ path, severity: 'drop', message: `'${id}' is not a data item class of the mod (OZL_Data_*): the game drops it` });
    else classCheck(out, ctx, path, id, 'data item class', 'the game drops the entry');
    arr(d.Points).forEach((praw, pi) => {
      const p = rec(praw);
      const type = str(p.Type);
      if (type === '') return;
      if (ctx.pointTypes && !ctx.pointTypes.has(type)) out.push({ path: `${path}.Points[${pi}]`, severity: 'warn', message: `'${id}' rewards unknown point type '${type}': it is never granted` });
      const a = num(p.Amount);
      if (a < 0 || a > 1000000) out.push({ path: `${path}.Points[${pi}]`, severity: 'warn', message: `'${id}': Amount outside 0..1000000` });
    });
  });
  return out;
}

function modules(doc: Doc, ctx: Context): Problem[] {
  const out: Problem[] = [];
  const seen = new Set<string>();
  arr(doc.Modules).forEach((raw, i) => {
    const m = rec(raw);
    const cls = str(m.Classname);
    const path = `Modules[${i}]`;
    if (cls === '') return out.push({ path, severity: 'drop', message: 'a module with no Classname is dropped' });
    if (seen.has(cls)) return out.push({ path, severity: 'drop', message: `duplicate class '${cls}' is dropped` });
    const bonus = num(m.PurityBonus);
    if (bonus < 0 || bonus > 2) return out.push({ path, severity: 'drop', message: `PurityBonus of '${cls}' outside 0..2, dropped` });
    seen.add(cls);
    classCheck(out, ctx, path, cls, 'module class', 'the game drops the module');
    for (const [di, d] of arr(m.Devices).entries()) classCheck(out, ctx, `${path}.Devices[${di}]`, str(d), 'device class', 'the game writes a warning');
  });
  return out;
}

function sampleTypes(doc: Doc, ctx: Context): Problem[] {
  const out: Problem[] = [];
  const seen = new Set<string>();
  arr(doc.Items).forEach((raw, i) => {
    const d = rec(raw);
    const id = str(d.Id);
    const path = `Items[${i}]`;
    if (id === '') return out.push({ path, severity: 'drop', message: 'an entry with no Id is dropped' });
    const key = id.toLowerCase();
    if (seen.has(key)) return out.push({ path, severity: 'drop', message: `duplicate Id '${id}' is dropped` });
    if (str(d.Name) === '') return out.push({ path, severity: 'drop', message: `sample type '${id}' has no Name and is dropped` });
    seen.add(key);
    if (!isSampleClass(id)) out.push({ path, severity: 'drop', message: `'${id}' is not a sample class of the mod (OZL_Sample_*): the game drops it` });
    else classCheck(out, ctx, path, id, 'sample class', 'the game drops the entry');
  });
  return out;
}

function statics(doc: Doc, ctx: Context): Problem[] {
  const out: Problem[] = [];
  const seen = new Set<string>();
  arr(doc.Entries).forEach((raw, i) => {
    const e = rec(raw);
    const id = str(e.Id);
    const path = `Entries[${i}]`;
    if (id === '') return out.push({ path, severity: 'drop', message: 'an entry with no Id is dropped' });
    if (seen.has(id)) return out.push({ path, severity: 'drop', message: `duplicate Id '${id}' is dropped` });
    if (str(e.ClassName) === '') return out.push({ path, severity: 'drop', message: `'${id}' has no ClassName and is dropped` });
    if (arr(e.Pos).length !== 3) return out.push({ path, severity: 'drop', message: `'${id}' needs Pos of three numbers, dropped` });
    seen.add(id);
    classCheck(out, ctx, path, str(e.ClassName), 'static class', 'the game skips the entry at spawn');
  });
  return out;
}

export function worst(problems: Problem[]): Severity | null {
  const order: Severity[] = ['drop', 'disable', 'warn', 'info'];
  for (const sev of order) if (problems.some((p) => p.severity === sev)) return sev;
  return null;
}
