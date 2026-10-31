// The chains of the rules as a graph, the way the lines run them: raw
// input -> packer -> sample -> analyzer -> carrier -> a terminal pays the
// carrier's line into the faction's pool. A node per rule and a node per
// pool (a line); an edge wherever an output of one rule satisfies the input
// of another by the same test the station runs (OZL_RuleEngine.MatchInput
// over OZL_Match.MatchClass: exactly with a "|1" suffix, by family without
// it), and from every analysis to the pool of its carrier's line.
//
// The family test is the real IsKindOf when the bridge holds the server's
// class index, the mod's naming otherwise (lines.ts). A false break is the
// likelier error of the second; a break is a warning, never a refusal.

import type { Doc } from './schema';
import { classFacts, stripExact, type ClassFacts } from './lines';

export type RuleRef = { path: number[]; group: string; rule: Doc; key: string };
export type ChainEdge = { id: string; source: string; target: string; classname: string };
// A pool: where the carriers of a line end; `known` -- the point types
// have the line, so a terminal pays it.
export type ChainPool = { key: string; line: string; known: boolean };
export type ChainBreak = { key: string; kind: 'dead-output' | 'unfed-input' | 'no-pool'; classname: string; message: string };
export type ChainGraph = { nodes: RuleRef[]; pools: ChainPool[]; edges: ChainEdge[]; breaks: ChainBreak[] };

export type KindOf = (actual: string, base: string) => boolean;

const NAMING = classFacts(null);

// OZL_Match.MatchClass: "X|1" is exactly X (any case), a bare name is X or
// anything descending from it.
export function matchClass(actual: string, configured: string, kindOf: KindOf = NAMING.kindOf): boolean {
  if (configured === '') return false;
  const at = configured.indexOf('|');
  if (at > -1) return actual.toLowerCase() === configured.slice(0, at).toLowerCase();
  return kindOf(actual, configured);
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const arr = (v: unknown): Doc[] => (Array.isArray(v) ? (v as Doc[]) : []);
const rec = (v: unknown): Doc => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Doc) : {});

export function ruleKey(path: number[]): string {
  return `r:${path.join(':')}`;
}

export function poolKey(line: string): string {
  return `p:${line}`;
}

// `pointTypes`: the ids of the point types, when known; without them every
// pool counts as paid.
export function buildChain(doc: Doc, facts: ClassFacts = NAMING, pointTypes: Set<string> | null = null): ChainGraph {
  const nodes: RuleRef[] = [];
  arr(doc.Groups).forEach((g, gi) => {
    arr(g.Rules).forEach((rule, ri) => nodes.push({ path: [gi, ri], group: str(g.Id), rule, key: ruleKey([gi, ri]) }));
  });
  const live = nodes.filter((n) => n.rule.Enabled !== false);
  const edges: ChainEdge[] = [];
  const pools = new Map<string, ChainPool>();
  const seen = new Set<string>();
  const fed = new Set<string>();
  const used = new Set<string>();
  const breaks: ChainBreak[] = [];
  for (const from of live) {
    for (const out of arr(from.rule.Outputs)) {
      const cls = stripExact(str(out.Classname));
      if (!cls) continue;
      for (const to of live) {
        if (to === from) continue;
        if (!matchClass(cls, str(rec(to.rule.InputItem).Classname), facts.kindOf)) continue;
        const id = `${from.key}>${to.key}:${cls}`;
        if (seen.has(id)) continue;
        seen.add(id);
        edges.push({ id, source: from.key, target: to.key, classname: cls });
        fed.add(to.key);
        used.add(`${from.key}:${cls}`);
      }
      if (facts.role(cls) !== 'carrier') continue;
      const line = facts.line(cls) || '';
      if (!line) continue;
      const key = poolKey(line);
      if (!pools.has(key)) pools.set(key, { key, line, known: !pointTypes || pointTypes.has(line) });
      const id = `${from.key}>${key}`;
      if (!seen.has(id)) {
        seen.add(id);
        edges.push({ id, source: from.key, target: key, classname: cls });
      }
      if (!pools.get(key)!.known) breaks.push({ key: from.key, kind: 'no-pool', classname: cls, message: `rule '${str(from.rule.Id)}' makes ${cls}, whose line '${line}' has no point type: no terminal pays it` });
    }
  }
  // A sample that no rule takes is a dead end: samples exist to be
  // analysed. A sample or carrier input that no rule makes cannot come
  // from the world either: a sample without the payload a packer writes
  // is refused by the analyzer.
  for (const n of live) {
    for (const out of arr(n.rule.Outputs)) {
      const cls = stripExact(str(out.Classname));
      if (facts.role(cls) === 'sample' && !used.has(`${n.key}:${cls}`)) {
        breaks.push({ key: n.key, kind: 'dead-output', classname: cls, message: `rule '${str(n.rule.Id)}' makes ${cls}, which no enabled rule takes` });
      }
    }
    const icls = stripExact(str(rec(n.rule.InputItem).Classname));
    const role = facts.role(icls);
    if ((role === 'sample' || role === 'carrier') && !fed.has(n.key)) {
      breaks.push({ key: n.key, kind: 'unfed-input', classname: icls, message: `rule '${str(n.rule.Id)}' takes ${icls}, which no enabled rule makes` });
    }
  }
  return { nodes, pools: [...pools.values()].sort((a, b) => a.line.localeCompare(b.line)), edges, breaks };
}
