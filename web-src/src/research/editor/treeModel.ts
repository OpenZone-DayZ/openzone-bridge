// The tree as the canvas draws it: a column per Tier (the same coordinate
// the game's tree screen uses), the file's order within a column, edges
// from parent to child, ghosts for parents that live in another branch.
// Pure: no React, no React Flow.

import type { Doc } from './schema';

export const CARD_W = 220;
export const CARD_H = 92;
export const GHOST_H = 60;
export const COL_STEP = 290;
export const ROW_STEP = 120;
export const TOP = 48;
export const MAX_COLS = 60;

export type TreeNodeDoc = {
  Id: string; Name: string; Description: string; Icon: string; Tier: number; Parents: string[]; ParentsMode: string;
  Cost: { Type: string; Amount: number }[]; ItemCost: { Classname: string; Quantity: number; Content: string }[];
  ResearchTimeSec: number; RequiredFactions: string[];
};
export type TreeBranchDoc = { Id: string; Name: string; Icon: string; SortOrder: number; Owners: string[]; Nodes: TreeNodeDoc[] };

export type Card = { key: string; branchIdx: number; nodeIdx: number; node: TreeNodeDoc; tier: number; x: number; y: number; problems: number };
export type Ghost = { key: string; id: string; name: string; branchLabel: string; tier: number; x: number; y: number };
export type Header = { key: string; tier: number; x: number };
export type TreeEdge = { id: string; source: string; target: string; cross: boolean };
export type TreeCanvasModel = { headers: Header[]; cards: Card[]; ghosts: Ghost[]; edges: TreeEdge[]; tiers: number[] };

// Which columns exist: a solid range from min(1, lowest tier) to the
// highest tier plus one empty column to grow into; a hand-typed absurd
// tier falls back to the occupied tiers only.
export function columnTiers(tiers: number[]): number[] {
  if (tiers.length === 0) return [1];
  const lo = Math.min(1, ...tiers);
  const hi = Math.max(...tiers) + 1;
  if (hi - lo + 1 > MAX_COLS) {
    const set = new Set<number>(tiers);
    set.add(1);
    set.add(hi);
    return [...set].sort((a, b) => a - b);
  }
  const out: number[] = [];
  for (let t = lo; t <= hi; t++) out.push(t);
  return out;
}

export function tierForX(x: number, tiers: number[]): number {
  if (tiers.length === 0) return 1;
  const idx = Math.min(tiers.length - 1, Math.max(0, Math.round(x / COL_STEP)));
  return tiers[idx];
}

export function cardKey(branchIdx: number, nodeIdx: number): string {
  return `n:${branchIdx}:${nodeIdx}`;
}

export function buildTreeCanvas(doc: Doc, branchIdx: number, problemsOf: (branchIdx: number, nodeIdx: number) => number = () => 0): TreeCanvasModel {
  const branches = (Array.isArray(doc.Branches) ? doc.Branches : []) as TreeBranchDoc[];
  const branch = branches[branchIdx];
  if (!branch) return { headers: [], cards: [], ghosts: [], edges: [], tiers: [] };

  const cards: Card[] = branch.Nodes.map((node, nodeIdx) => ({
    key: cardKey(branchIdx, nodeIdx), branchIdx, nodeIdx, node, tier: Math.round(node.Tier), x: 0, y: 0, problems: problemsOf(branchIdx, nodeIdx),
  }));
  // The first node of an Id in this branch is the edge's target: the
  // game's FindNode is first-wins too.
  const local = new Map<string, Card>();
  for (const c of cards) if (!local.has(c.node.Id)) local.set(c.node.Id, c);
  // A parent in another branch: first-wins across the file.
  const elsewhere = new Map<string, { node: TreeNodeDoc; branch: TreeBranchDoc }>();
  branches.forEach((br, bi) => {
    if (bi === branchIdx) return;
    for (const n of br.Nodes) if (!elsewhere.has(n.Id)) elsewhere.set(n.Id, { node: n, branch: br });
  });

  const ghosts = new Map<string, Ghost>();
  const edges: TreeEdge[] = [];
  const seenEdge = new Set<string>();
  const addEdge = (source: string, target: string, cross: boolean) => {
    const id = `e:${source}>${target}`;
    if (seenEdge.has(id)) return;
    seenEdge.add(id);
    edges.push({ id, source, target, cross });
  };
  for (const c of cards) {
    for (const p of c.node.Parents) {
      const here = local.get(p);
      if (here) {
        addEdge(here.key, c.key, false);
        continue;
      }
      const far = elsewhere.get(p);
      if (!far) continue; // a missing parent is a problem on the node, not an edge
      let g = ghosts.get(p);
      if (!g) {
        g = { key: `g:${p}`, id: p, name: far.node.Name, branchLabel: far.branch.Name || far.branch.Id, tier: Math.round(far.node.Tier), x: 0, y: 0 };
        ghosts.set(p, g);
      }
      addEdge(g.key, c.key, true);
    }
  }
  const ghostList = [...ghosts.values()];
  const tiers = columnTiers([...cards.map((c) => c.tier), ...ghostList.map((g) => g.tier)]);
  const colOf = new Map(tiers.map((t, idx) => [t, idx]));
  const headers: Header[] = tiers.map((tier) => ({ key: `h:${tier}`, tier, x: (colOf.get(tier) ?? 0) * COL_STEP }));
  const ordinal = new Map<number, number>();
  const place = (tier: number) => {
    const n = ordinal.get(tier) ?? 0;
    ordinal.set(tier, n + 1);
    return { x: (colOf.get(tier) ?? 0) * COL_STEP, y: TOP + n * ROW_STEP };
  };
  for (const c of cards) Object.assign(c, place(c.tier));
  for (const g of ghostList) Object.assign(g, place(g.tier));
  return { headers, cards, ghosts: ghostList, edges, tiers };
}

// Reachability as the game computes it (OZL_TreeConfig.Unreachable): a
// node without parents is reachable; with parents, by ParentsMode.
export function unreachable(doc: Doc): string[] {
  const branches = (Array.isArray(doc.Branches) ? doc.Branches : []) as TreeBranchDoc[];
  const all: TreeNodeDoc[] = [];
  for (const br of branches) for (const n of br.Nodes) all.push(n);
  const reachable = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of all) {
      if (reachable.has(n.Id)) continue;
      const okCount = n.Parents.filter((p) => reachable.has(p)).length;
      const ok = n.Parents.length === 0 || (String(n.ParentsMode).toLowerCase() === 'any' ? okCount > 0 : okCount === n.Parents.length);
      if (ok) {
        reachable.add(n.Id);
        changed = true;
      }
    }
  }
  return all.filter((n) => !reachable.has(n.Id)).map((n) => n.Id);
}

// Would making `parentId` a parent of `childId` close a cycle? The path
// is returned for the message.
export function cyclePath(doc: Doc, childId: string, parentId: string): string[] | null {
  const branches = (Array.isArray(doc.Branches) ? doc.Branches : []) as TreeBranchDoc[];
  const parentsOf = new Map<string, string[]>();
  for (const br of branches) for (const n of br.Nodes) if (!parentsOf.has(n.Id)) parentsOf.set(n.Id, n.Parents);
  // Walk up from the would-be parent; reaching the child closes the loop.
  const seen = new Set<string>();
  const walk = (id: string, path: string[]): string[] | null => {
    if (id === childId) return [...path, id];
    if (seen.has(id)) return null;
    seen.add(id);
    for (const p of parentsOf.get(id) || []) {
      const r = walk(p, [...path, id]);
      if (r) return r;
    }
    return null;
  };
  return walk(parentId, []);
}
