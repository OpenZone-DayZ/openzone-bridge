// The tree on a canvas: a column per Tier, the file's order down a
// column, a card per node with its cost, a ghost for a parent from
// another branch, orthogonal edges parent to child. A drag between
// columns sets the Tier; a connection from a card's right side to
// another's left adds a parent (refused when it would close a cycle);
// a click selects the node's row.

import { useCallback, useMemo, useState } from 'react';
import { Background, BackgroundVariant, Controls, Handle, Position, ReactFlow, type Connection, type Edge, type EdgeProps, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useLang } from '../../i18n';
import type { Doc } from './schema';
import { CARD_H, CARD_W, GHOST_H, buildTreeCanvas, cyclePath, tierForX, type Card, type Ghost, type Header } from './treeModel';

type CardNode = Node<{ card: Card; pointNames: Map<string, string> }, 'card'>;
type GhostNode = Node<{ ghost: Ghost }, 'ghost'>;
type HeaderNode = Node<{ header: Header; onAdd: (tier: number) => void; label: string }, 'header'>;
type AnyNode = CardNode | GhostNode | HeaderNode;
type TreeFlowEdge = Edge<{ cross: boolean }, 'tree'>;

function CardView({ data, selected }: NodeProps<CardNode>) {
  const { card, pointNames } = data;
  const n = card.node;
  const costText = n.Cost.map((c) => `${pointNames.get(c.Type) || c.Type} ×${c.Amount}`).join(', ');
  const title = `${n.Name || n.Id}\n${n.Id}${costText ? `\n${costText}` : ''}${n.ItemCost.length ? `\n+ ${n.ItemCost.map((c) => `${c.Classname} ×${c.Quantity}`).join(', ')}` : ''}`;
  return (
    <div className={`tcard${card.problems ? ' bad' : ''}${selected ? ' pick' : ''}`} style={{ width: CARD_W, height: CARD_H }} title={title}>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <div className="name">{n.Name || n.Id}</div>
      <code className="id">{n.Id}</code>
      <div className="cost">
        {n.Cost.map((c, i) => <span key={i} className="chip">{c.Type} ×{c.Amount}</span>)}
        {n.ItemCost.length > 0 && <span className="chip">+{n.ItemCost.length}</span>}
        {n.ResearchTimeSec > 0 && <span className="chip accent">{n.ResearchTimeSec}s</span>}
        {n.Cost.length === 0 && n.ItemCost.length === 0 && <span className="chip faint">—</span>}
      </div>
      {card.problems > 0 && <span className="alarm">!{card.problems}</span>}
    </div>
  );
}

function GhostView({ data }: NodeProps<GhostNode>) {
  const g = data.ghost;
  return (
    <div className="tghost" style={{ width: CARD_W, height: GHOST_H }} title={`${g.name || g.id}\n${g.id}`}>
      <Handle type="source" position={Position.Right} />
      <span className="small muted">{g.branchLabel}</span>
      <div className="name">{g.name || g.id}</div>
      <code className="id">{g.id}</code>
    </div>
  );
}

function HeaderView({ data }: NodeProps<HeaderNode>) {
  return (
    <div className="theader">
      <span>{data.label} {data.header.tier}</span>
      <button type="button" className="small ghost" onClick={() => data.onAdd(data.header.tier)}>+</button>
    </div>
  );
}

function TreeEdgeView({ sourceX, sourceY, targetX, targetY, data, selected }: EdgeProps<TreeFlowEdge>) {
  const midX = (sourceX + targetX) / 2;
  const path = `M ${sourceX} ${sourceY} L ${midX} ${sourceY} L ${midX} ${targetY} L ${targetX} ${targetY}`;
  return (
    <>
      <path d={path} className={`tedge${data?.cross ? ' cross' : ''}${selected ? ' pick' : ''}`} fill="none" />
      <path d={path} className="tedge-hit" fill="none" />
    </>
  );
}

const nodeTypes = { card: CardView, ghost: GhostView, header: HeaderView };
const edgeTypes = { tree: TreeEdgeView };

export function TreeCanvas({ doc, branchIdx, selected, problemsOf, pointNames, onSelect, onSetTier, onAddParent, onRemoveParent, onAddNode, onRefuse }: {
  doc: Doc;
  branchIdx: number;
  selected: number[] | null;
  problemsOf: (b: number, n: number) => number;
  pointNames: Map<string, string>;
  onSelect: (path: number[]) => void;
  onSetTier: (path: number[], tier: number) => void;
  onAddParent: (path: number[], parentId: string) => void;
  onRemoveParent: (path: number[], parentId: string) => void;
  onAddNode: (branchIdx: number, tier: number) => void;
  onRefuse: (why: string) => void;
}) {
  const { s } = useLang();
  const model = useMemo(() => buildTreeCanvas(doc, branchIdx, problemsOf), [doc, branchIdx, problemsOf]);
  const [armed, setArmed] = useState<string | null>(null);
  const selectedKey = selected ? `n:${selected[0]}:${selected[1]}` : '';

  const nodes = useMemo<AnyNode[]>(() => [
    ...model.headers.map((h): HeaderNode => ({ id: h.key, type: 'header', position: { x: h.x, y: 0 }, data: { header: h, onAdd: (tier) => onAddNode(branchIdx, tier), label: s('e_tier') }, draggable: false, selectable: false })),
    ...model.cards.map((c): CardNode => ({ id: c.key, type: 'card', position: { x: c.x, y: c.y }, data: { card: c, pointNames }, selected: c.key === selectedKey })),
    ...model.ghosts.map((g): GhostNode => ({ id: g.key, type: 'ghost', position: { x: g.x, y: g.y }, data: { ghost: g }, draggable: false })),
  ], [model, branchIdx, onAddNode, pointNames, selectedKey, s]);
  const edges = useMemo<TreeFlowEdge[]>(() => model.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, type: 'tree', data: { cross: e.cross }, selected: e.id === armed })), [model, armed]);

  const byKey = useMemo(() => new Map(model.cards.map((c) => [c.key, c])), [model]);
  const ghostByKey = useMemo(() => new Map(model.ghosts.map((g) => [g.key, g])), [model]);

  const onNodeDragStop = useCallback((_: unknown, node: Node) => {
    const card = byKey.get(node.id);
    if (!card) return;
    const tier = tierForX(node.position.x, model.tiers);
    onSelect([card.branchIdx, card.nodeIdx]);
    if (tier !== card.tier) onSetTier([card.branchIdx, card.nodeIdx], tier);
  }, [byKey, model.tiers, onSelect, onSetTier]);

  const onConnect = useCallback((c: Connection) => {
    const target = c.target ? byKey.get(c.target) : undefined;
    if (!target) return;
    const parentId = byKey.get(c.source || '')?.node.Id ?? ghostByKey.get(c.source || '')?.id;
    if (!parentId || parentId === target.node.Id) return;
    if (target.node.Parents.includes(parentId)) return;
    const cycle = cyclePath(doc, target.node.Id, parentId);
    if (cycle) {
      onRefuse(s('e_cycle', { path: [...cycle, target.node.Id].join(' → ') }));
      return;
    }
    onAddParent([target.branchIdx, target.nodeIdx], parentId);
  }, [byKey, ghostByKey, doc, onAddParent, onRefuse, s]);

  const onEdgeClick = useCallback((_: unknown, edge: Edge) => {
    if (armed !== edge.id) {
      setArmed(edge.id);
      setTimeout(() => setArmed((a) => (a === edge.id ? null : a)), 4000);
      return;
    }
    setArmed(null);
    const target = byKey.get(edge.target);
    const parentId = byKey.get(edge.source)?.node.Id ?? ghostByKey.get(edge.source)?.id;
    if (target && parentId) onRemoveParent([target.branchIdx, target.nodeIdx], parentId);
  }, [armed, byKey, ghostByKey, onRemoveParent]);

  return (
    <div className="canvas">
      <ReactFlow<AnyNode, TreeFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.08, minZoom: 0.85, maxZoom: 1 }}
        minZoom={0.2}
        deleteKeyCode={null}
        onNodeClick={(_, node) => {
          const card = byKey.get(node.id);
          if (card) onSelect([card.branchIdx, card.nodeIdx]);
        }}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onEdgeClick={onEdgeClick}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
      {armed && <div className="canvas-hint alert">{s('e_edge_armed')}</div>}
    </div>
  );
}
