// What gives points and what takes them, per point type and per owner: a
// tree that costs more than the world can ever grant is the mistake the
// admin cannot see one config at a time.

import type { Doc } from './schema';
import { isCarrierClass, parseCarrierState } from './validate';

export type BalanceRow = {
  type: string;
  name: string;
  fromData: number;
  fromRules: number;
  spent: number;
  spentBy: Map<string, number>;
  nodes: number;
};

const arr = (v: unknown): Doc[] => (Array.isArray(v) ? (v as Doc[]) : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function balance(tree: Doc, dataItems: Doc | null, rules: Doc | null, pointTypes: Doc | null): BalanceRow[] {
  const rows = new Map<string, BalanceRow>();
  const names = new Map<string, string>();
  for (const pt of arr(pointTypes?.PointTypes)) names.set(str(pt.Id), str(pt.Name));
  const row = (type: string): BalanceRow => {
    let r = rows.get(type);
    if (!r) {
      r = { type, name: names.get(type) || type, fromData: 0, fromRules: 0, spent: 0, spentBy: new Map(), nodes: 0 };
      rows.set(type, r);
    }
    return r;
  };
  for (const [id] of names) row(id);
  for (const d of arr(dataItems?.Items)) {
    if (d.Enabled === false) continue;
    for (const p of arr(d.Points)) if (str(p.Type)) row(str(p.Type)).fromData += num(p.Amount);
  }
  for (const g of arr(rules?.Groups)) {
    for (const r of arr(g.Rules)) {
      if (r.Enabled === false) continue;
      for (const o of arr(r.Outputs)) {
        if (!isCarrierClass(str(o.Classname))) continue;
        const st = parseCarrierState(str(o.Content));
        if (st) row(st.type).fromRules += st.amount * Math.max(1, num(o.Quantity));
      }
    }
  }
  for (const br of arr(tree.Branches)) {
    const owners = arr(br.Owners).map(String);
    for (const n of arr(br.Nodes)) {
      const who = arr(n.RequiredFactions).length ? arr(n.RequiredFactions).map(String) : owners.length ? owners : ['*'];
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
