// What the lines give and what the tree takes, per point type (a line) and
// per owner: a tree that costs points of a line nobody can make, or that a
// faction has no station for, is the mistake the admin cannot see one
// config at a time.
//
// A line gives through its chain: a packer rule turns raw input into the
// line's sample worth its Points, starting at the rule's own purity or the
// line's BasePurity; an analyzer rule turns the sample into the line's
// carrier with the sample's purity as the chance; a terminal pays the
// carrier's points into the pool. The best cycle is the packer rule whose
// sample brings the most points on average -- Points x Quantity x Chance x
// purity x the best analysis Chance -- without modules (each adds its
// PurityBonus and a chance of a second sample) or the double roll.

import type { Doc } from './schema';
import { DEFAULT_PURITY, basePurityOf, startPurity, stripExact, type ClassFacts } from './lines';
import { deviceOwners } from './validate';

export type BalanceRow = {
  type: string;
  name: string;
  // The point types have this line: a terminal pays its carriers.
  known: boolean;
  basePurity: number;
  packers: number;
  pointsMin: number;
  pointsMax: number;
  analyzers: number;
  // Expected points of one cycle of the best packer rule, analysed; 0 when
  // the line has no packer or no analyzer.
  bestCycle: number;
  spent: number;
  spentBy: Map<string, number>;
  nodes: number;
  // Owners that can run both a packer and an analyzer rule of the line;
  // '*' when no owner lists devices (everyone can).
  earners: Set<string>;
};

const arr = (v: unknown): Doc[] => (Array.isArray(v) ? (v as Doc[]) : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const rec = (v: unknown): Doc => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Doc) : {});

// Who may run a rule: the owners of its device, narrowed by its
// RequiredFactions ('*' stays '*' only when the rule names none).
function runners(rule: Doc, owners: Doc | null, facts: ClassFacts): string[] {
  const by = deviceOwners(owners, str(rule.Device), facts);
  const req = arr(rule.RequiredFactions).map(String).filter(Boolean);
  if (!req.length) return by;
  return by.includes('*') ? req : by.filter((o) => req.includes(o));
}

export function balance(tree: Doc | null, rules: Doc | null, pointTypes: Doc | null, owners: Doc | null, facts: ClassFacts): BalanceRow[] {
  const rows = new Map<string, BalanceRow>();
  const names = new Map<string, string>();
  for (const pt of arr(pointTypes?.PointTypes)) names.set(str(pt.Id), str(pt.Name));
  const row = (type: string): BalanceRow => {
    let r = rows.get(type);
    if (!r) {
      r = {
        type, name: names.get(type) || type, known: names.has(type), basePurity: basePurityOf(pointTypes, type) ?? DEFAULT_PURITY,
        packers: 0, pointsMin: 0, pointsMax: 0, analyzers: 0, bestCycle: 0, spent: 0, spentBy: new Map(), nodes: 0, earners: new Set(),
      };
      rows.set(type, r);
    }
    return r;
  };
  for (const [id] of names) row(id);

  const packYield = new Map<string, number>();
  const analysisChance = new Map<string, number>();
  const packRunners = new Map<string, Set<string>>();
  const analyzeRunners = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, line: string, who: string[]) => {
    const set = m.get(line) || new Set<string>();
    for (const w of who) set.add(w);
    m.set(line, set);
  };
  for (const g of arr(rules?.Groups)) {
    for (const r of arr(g.Rules)) {
      if (r.Enabled === false) continue;
      const input = stripExact(str(rec(r.InputItem).Classname));
      if (facts.role(input) === 'sample') {
        // An analysis: one sample in, one carrier of its line out.
        const line = facts.line(input);
        if (!line) continue;
        const rr = row(line);
        rr.analyzers++;
        const chance = Math.min(1, Math.max(0, num(rec(arr(r.Outputs)[0]).Chance)));
        analysisChance.set(line, Math.max(analysisChance.get(line) ?? 0, chance));
        add(analyzeRunners, line, runners(r, owners, facts));
        continue;
      }
      for (const o of arr(r.Outputs)) {
        const cls = stripExact(str(o.Classname));
        if (facts.role(cls) !== 'sample') continue;
        const line = facts.line(cls);
        if (!line) continue;
        const rr = row(line);
        const pts = num(o.Points);
        rr.pointsMin = rr.packers === 0 ? pts : Math.min(rr.pointsMin, pts);
        rr.pointsMax = Math.max(rr.pointsMax, pts);
        rr.packers++;
        const purity = Math.min(1, startPurity(r, facts, pointTypes).purity);
        const expected = pts * Math.max(1, num(o.Quantity)) * Math.min(1, Math.max(0, num(o.Chance))) * purity;
        packYield.set(line, Math.max(packYield.get(line) ?? 0, expected));
        add(packRunners, line, runners(r, owners, facts));
      }
    }
  }
  for (const r of rows.values()) {
    r.bestCycle = (packYield.get(r.type) ?? 0) * (analysisChance.get(r.type) ?? 0);
    const p = packRunners.get(r.type) || new Set<string>();
    const a = analyzeRunners.get(r.type) || new Set<string>();
    if (p.has('*') && a.has('*')) r.earners.add('*');
    for (const w of p) if (w !== '*' && (a.has(w) || a.has('*'))) r.earners.add(w);
    if (p.has('*')) for (const w of a) if (w !== '*') r.earners.add(w);
  }

  for (const br of arr(tree?.Branches)) {
    const brOwners = arr(br.Owners).map(String);
    for (const n of arr(br.Nodes)) {
      const who = arr(n.RequiredFactions).length ? arr(n.RequiredFactions).map(String) : brOwners.length ? brOwners : ['*'];
      for (const c of arr(n.Cost)) {
        const t = str(c.Type);
        if (!t) continue;
        const r = row(t);
        r.spent += num(c.Amount);
        r.nodes += 1;
        for (const w of who) r.spentBy.set(w, (r.spentBy.get(w) || 0) + num(c.Amount));
      }
    }
  }
  return [...rows.values()].sort((a, b) => a.type.localeCompare(b.type));
}

// Can this owner make the line's points? '*' columns (a branch for
// everyone) ask whether anybody can.
export function canEarn(row: BalanceRow, owner: string): boolean {
  if (row.earners.has('*')) return true;
  if (owner === '*') return row.earners.size > 0;
  return row.earners.has(owner);
}

// Cycles of the best rule the tree's spending of the line takes; null when
// the line yields nothing.
export function cyclesFor(row: BalanceRow, spent = row.spent): number | null {
  if (row.bestCycle <= 0) return null;
  return Math.ceil(spent / row.bestCycle);
}
