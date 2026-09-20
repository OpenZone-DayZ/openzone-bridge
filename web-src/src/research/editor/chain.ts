// The chains of the rules as a graph: a node per rule, an edge wherever an
// output of one rule satisfies the input of another by the same test the
// game runs on the station (OZL_RuleEngine.MatchInput over
// OZL_Match.MatchClass): the class matches exactly with a "|1" suffix, by
// family without it; the content matches when the input asks for one.
//
// The bridge has no class hierarchy, only the server's flat list, so
// "family" is approximated: the mod's own bases (OZL_Sample_Base and the
// like) match their prefixes, the vanilla item bases match anything, and
// every other bare class matches itself. A false edge from that
// approximation is possible only for a vanilla family name, which a rule
// input rarely uses; a false break is the more likely error, and a break
// is a warning, never a refusal.

import type { Doc } from './schema';
import { stripExact, isSampleClass, isCarrierClass } from './validate';

export type RuleRef = { path: number[]; group: string; rule: Doc; key: string };
export type ChainEdge = { id: string; source: string; target: string; classname: string; content: string };
export type ChainBreak = { key: string; kind: 'dead-output' | 'unfed-input'; classname: string; content: string; message: string };
export type ChainGraph = { nodes: RuleRef[]; edges: ChainEdge[]; breaks: ChainBreak[] };

const FAMILIES: Record<string, (cls: string) => boolean> = {
  OZL_Sample_Base: (c) => c.startsWith('OZL_Sample_'),
  OZL_Carrier_Base: (c) => c.startsWith('OZL_Carrier_'),
  OZL_Data_Base: (c) => c.startsWith('OZL_Data_'),
  Inventory_Base: () => true,
  ItemBase: () => true,
};

export type KindOf = (actual: string, base: string) => boolean;

export function matchClass(actual: string, configured: string, kindOf?: KindOf): boolean {
  if (configured === '') return false;
  const at = configured.indexOf('|');
  if (at > -1) return actual.toLowerCase() === configured.slice(0, at).toLowerCase();
  // With the class index the family is the real one; without it, the approximation.
  if (kindOf) return kindOf(actual, configured);
  const family = FAMILIES[configured];
  if (family) return family(actual);
  return actual.toLowerCase() === configured.toLowerCase();
}

export function matchInput(actualType: string, actualContent: string, cfgClass: string, cfgContent: string, kindOf?: KindOf): boolean {
  if (!matchClass(actualType, cfgClass, kindOf)) return false;
  if (cfgContent === '') return true;
  return actualContent === cfgContent;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const arr = (v: unknown): Doc[] => (Array.isArray(v) ? (v as Doc[]) : []);
const rec = (v: unknown): Doc => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Doc) : {});

export function ruleKey(path: number[]): string {
  return `r:${path.join(':')}`;
}

export function buildChain(doc: Doc, kindOf?: KindOf): ChainGraph {
  const nodes: RuleRef[] = [];
  arr(doc.Groups).forEach((g, gi) => {
    arr(g.Rules).forEach((rule, ri) => nodes.push({ path: [gi, ri], group: str(g.Id), rule, key: ruleKey([gi, ri]) }));
  });
  const live = nodes.filter((n) => n.rule.Enabled !== false);
  const edges: ChainEdge[] = [];
  const seen = new Set<string>();
  const fed = new Set<string>();
  const used = new Set<string>();
  for (const from of live) {
    for (const out of arr(from.rule.Outputs)) {
      const cls = stripExact(str(out.Classname));
      const content = str(out.Content);
      for (const to of live) {
        if (to === from) continue;
        const input = rec(to.rule.InputItem);
        if (!matchInput(cls, content, str(input.Classname), str(input.Content), kindOf)) continue;
        const id = `${from.key}>${to.key}:${cls}:${content}`;
        if (seen.has(id)) continue;
        seen.add(id);
        edges.push({ id, source: from.key, target: to.key, classname: cls, content });
        fed.add(to.key);
        used.add(`${from.key}:${cls}:${content}`);
      }
    }
  }
  // A sample that no rule takes is a dead end: samples exist to be
  // processed. A carrier is not: it goes to the terminal. A sample input
  // nothing produces can still come from the world, so it is a note.
  const breaks: ChainBreak[] = [];
  for (const n of live) {
    for (const out of arr(n.rule.Outputs)) {
      const cls = stripExact(str(out.Classname));
      const content = str(out.Content);
      if (isSampleClass(cls) && !used.has(`${n.key}:${cls}:${content}`)) {
        breaks.push({ key: n.key, kind: 'dead-output', classname: cls, content, message: `rule '${str(n.rule.Id)}' makes ${cls}${content ? ` (${content})` : ''}, which no enabled rule takes` });
      }
    }
    const input = rec(n.rule.InputItem);
    const icls = str(input.Classname);
    if ((isSampleClass(icls) || isCarrierClass(icls)) && !fed.has(n.key)) {
      breaks.push({ key: n.key, kind: 'unfed-input', classname: stripExact(icls), content: str(input.Content), message: `rule '${str(n.rule.Id)}' takes ${stripExact(icls)}${str(input.Content) ? ` (${str(input.Content)})` : ''}, which no enabled rule makes` });
    }
  }
  return { nodes, edges, breaks };
}
