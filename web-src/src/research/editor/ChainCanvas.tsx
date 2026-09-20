// The rules on a canvas: a card per rule (device, input, outputs), an
// edge wherever an output feeds another rule's input, laid out by ELK as
// layers left to right. A rule whose sample nobody takes, or whose
// sample input nobody makes, is marked. A click selects the rule's row.

import { useEffect, useMemo, useState } from 'react';
import { Background, BackgroundVariant, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js';
import { useLang } from '../../i18n';
import type { Doc } from './schema';
import { buildChain, type ChainGraph, type RuleRef } from './chain';

const W = 240;
const H = 96;
const elk = new ELK();

type RuleNode = Node<{ ref: RuleRef; breaks: number }, 'rule'>;

function RuleView({ data, selected }: NodeProps<RuleNode>) {
  const r = data.ref.rule;
  const input = (r.InputItem || {}) as Doc;
  const outputs = (Array.isArray(r.Outputs) ? r.Outputs : []) as Doc[];
  const off = r.Enabled === false;
  return (
    <div className={`ccard${off ? ' off' : ''}${data.breaks ? ' bad' : ''}${selected ? ' pick' : ''}`} style={{ width: W, minHeight: H }} title={String(r.Id)}>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <div className="name">{String(r.Id)}</div>
      <div className="small muted mono">{String(r.Device)} · {String(r.TimeSec)}s</div>
      <div className="small mono">← {String(input.Classname)}{input.Content ? ` (${String(input.Content)})` : ''}</div>
      {outputs.map((o, i) => <div key={i} className="small mono">→ {String(o.Classname)}{o.Content ? ` (${String(o.Content)})` : ''}</div>)}
      {data.breaks > 0 && <span className="alarm">!{data.breaks}</span>}
    </div>
  );
}

const nodeTypes = { rule: RuleView };

async function layout(graph: ChainGraph): Promise<Map<string, { x: number; y: number }>> {
  const g: ElkNode = {
    id: 'root',
    layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.spacing.nodeNode': '40', 'elk.layered.spacing.nodeNodeBetweenLayers': '90' },
    children: graph.nodes.map((n) => ({ id: n.key, width: W, height: H })),
    edges: graph.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };
  const out = await elk.layout(g);
  const pos = new Map<string, { x: number; y: number }>();
  for (const c of out.children || []) pos.set(c.id, { x: c.x || 0, y: c.y || 0 });
  return pos;
}

export function ChainCanvas({ doc, selected, onSelect }: { doc: Doc; selected: number[] | null; onSelect: (path: number[]) => void }) {
  const { s } = useLang();
  const graph = useMemo(() => buildChain(doc), [doc]);
  const [pos, setPos] = useState<Map<string, { x: number; y: number }>>(new Map());
  useEffect(() => {
    let alive = true;
    layout(graph).then((p) => {
      if (alive) setPos(p);
    });
    return () => {
      alive = false;
    };
  }, [graph]);
  const breaksOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of graph.breaks) m.set(b.key, (m.get(b.key) || 0) + 1);
    return m;
  }, [graph]);
  const selectedKey = selected ? `r:${selected.join(':')}` : '';
  const nodes = useMemo<RuleNode[]>(() => graph.nodes.map((n, i) => ({
    id: n.key, type: 'rule', position: pos.get(n.key) || { x: (i % 4) * (W + 40), y: Math.floor(i / 4) * (H + 40) }, data: { ref: n, breaks: breaksOf.get(n.key) || 0 }, selected: n.key === selectedKey,
  })), [graph, pos, breaksOf, selectedKey]);
  const edges = useMemo<Edge[]>(() => graph.edges.map((e) => ({
    id: e.id, source: e.source, target: e.target, label: e.content ? `${e.classname} (${e.content})` : e.classname, type: 'smoothstep',
    markerEnd: { type: MarkerType.ArrowClosed }, className: 'cedge', labelBgPadding: [4, 2], labelClassName: 'cedge-label',
  })), [graph]);
  const byKey = useMemo(() => new Map(graph.nodes.map((n) => [n.key, n])), [graph]);
  return (
    <div className="canvas">
      <ReactFlow<RuleNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.1}
        deleteKeyCode={null}
        nodesConnectable={false}
        onNodeClick={(_, node) => {
          const ref = byKey.get(node.id);
          if (ref) onSelect(ref.path);
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
      {graph.breaks.length > 0 && (
        <div className="canvas-hint">
          <b className="alert">{s('e_breaks')}: {graph.breaks.length}</b>
          {graph.breaks.slice(0, 6).map((b, i) => <div key={i} className="small">{b.message}</div>)}
        </div>
      )}
    </div>
  );
}
