// One box: its facts, the grid, the contents as an expandable tree with
// the actions on each row, the versions as a timeline with a diff between
// any two and a rollback, the live commands the game answers.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, awaitResult, type Answer } from '../api/client';
import { useLang } from '../i18n';
import { go } from '../app/router';
import { useToast } from '../app/toasts';
import { Badge, Confirm, Field, HealthBar, Loading, Notice, Panel } from '../ui/bits';
import { Table, type Col } from '../ui/Table';
import { StatusBadge } from './BoxesPage';
import { SuggestInput } from '../ui/SuggestInput';
import { useClassIndex } from '../core/classes/useClassIndex';
import { sizeOf, type ClassIndex } from '../core/classes/classIndex';
import {
  COLS, SIZES, cellOf, eventCell, groupRoots, isOk, num, rowsOf, shortType, stripRef,
  type Box, type Diff, type Event, type Item, type LiveResult, type Version,
} from './model';

type Loaded = { box: Box; items: Item[]; versions: Version[]; events: Event[] };

// What a change of the box answers: a new version, or two for a move.
type Changing = Promise<Answer<{ version?: number; fromVersion?: number; toVersion?: number }>>;
type OnDone = (p: Changing) => Promise<boolean>;

export function BoxPage({ id }: { id: string }) {
  const { s } = useLang();
  const toast = useToast();
  const held = useClassIndex();
  const [data, setData] = useState<Loaded | null>(null);
  const [why, setWhy] = useState('');
  const [filter, setFilter] = useState('');
  const [form, setForm] = useState<ReactNode>(null);

  const load = useCallback(async () => {
    const [b, h] = await Promise.all([
      api<{ box: Box; items: Item[]; versions: Version[] }>('storage', 'box', { id }),
      api<{ events: Event[]; versions: Version[] }>('storage', 'history', { id, limit: 200 }),
    ]);
    if (!b.ok) return setWhy(b.why);
    setData({ box: b.box, items: b.items, versions: h.ok ? h.versions : b.versions, events: h.ok ? h.events : [] });
    setWhy('');
  }, [id]);
  useEffect(() => {
    setData(null);
    setForm(null);
    load();
  }, [load]);

  // A change answered by the store: reload, tell the admin, close the form.
  const changed = async (p: Changing) => {
    const r = await p;
    if (!r.ok) {
      toast(`${s('error')}: ${r.why}`, true);
      return false;
    }
    setForm(null);
    await load();
    const v = 'version' in r && r.version !== undefined ? s('new_version', { v: r.version })
      : 'fromVersion' in r ? s('two_versions', { a: r.fromVersion ?? 0, b: r.toVersion ?? 0 }) : '';
    toast(`${s('done')} ${v} ${s('takes_effect')}`.replace(/\s+/g, ' '));
    return true;
  };

  if (why) return <><h1>{s('box')} <span className="mono">{id}</span></h1><Notice tone="bad">{why}</Notice></>;
  if (!data) return <><h1>{s('box')} <span className="mono">{id}</span></h1><Loading /></>;

  const { box, items, versions, events } = data;
  const closed = box.status === 'closed';
  const roots = groupRoots(items);
  const needle = filter.trim().toLowerCase();
  const hit = (it: Item) => needle !== '' && it.type.toLowerCase().includes(needle);
  const sizeName = SIZES[box.class] ? s(SIZES[box.class].key) : box.class;

  return (
    <>
      <h1>{s('box')} <span className="mono">{id}</span> <StatusBadge status={box.status} /></h1>
      <Panel>
        <div className="facts">
          <span className="k">{s('cls')}</span><span>{box.class} ({sizeName})</span>
          <span className="k">{s('version')}</span><span>{box.current_version}</span>
          <span className="k">{s('items')}</span><span>{items.length} ({s('roots').toLowerCase()}: {roots.filter(Boolean).length})</span>
          <span className="k">{s('cells')}</span><span>{box.cells ? `${box.cells.used} / ${box.cells.max}${box.cells.unknown ? ` (${box.cells.unknown} ${s('cells_unknown')})` : ''}` : '—'}</span>
          <span className="k">{s('pos')}</span><span className="mono">{box.pos || '—'}</span>
          <span className="k">{s('placed_by')}</span><span>{box.placed_by || '—'} <span className="muted mono">{box.placed_at}</span></span>
          <span className="k">{s('last_seen')}</span><span className="mono">{box.last_seen_at || '—'}</span>
        </div>
      </Panel>

      <div className="toolbar">
        <input placeholder={s('filter')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button type="button" disabled={!closed} onClick={() => setForm(<GiveForm id={id} onDone={changed} onClose={() => setForm(null)} />)}>{s('give')}</button>
        <Confirm danger disabled={!closed} label={s('empty')} question={s('c_empty', { id })} onConfirm={() => changed(api('storage', 'empty', { id }))} />
        {!closed && <span className="muted small">{s('closed_only')}</span>}
      </div>
      {form}

      {box.status === 'removed'
        ? <Panel tight title={s('archived_title')}><Notice tone="alert">{s('archived_text', { when: box.removed_at || '' })}</Notice></Panel>
        : box.in_world === 'no'
          ? <Panel tight title={s('live_title')}><Notice tone="alert">{s('absent_text', { since: box.world_boot || '' })}</Notice></Panel>
          : <LivePanel box={box} onChanged={load} />}

      <h2>{s('grid')}</h2>
      <Grid box={box} items={items} roots={roots} hit={hit} index={held.index} />

      <h2>{s('tree')}</h2>
      <div className="tree">
        <ul>
          {roots.map((nodes, idx) => (nodes ? (
            <RootNode key={idx} id={id} nodes={nodes} closed={closed} hit={hit}
              onEdit={(n) => setForm(<EditForm id={id} rootIdx={idx} node={n} onDone={changed} onClose={() => setForm(null)} />)}
              onMove={(n) => setForm(<MoveForm id={id} rootIdx={idx} node={n} onDone={changed} onClose={() => setForm(null)} />)}
              onShelve={() => changed(api('storage', 'shelve', { id, root: idx }))}
            />
          ) : null))}
        </ul>
      </div>

      <h2>{s('versions')}</h2>
      <Versions id={id} box={box} versions={versions} closed={closed} onChanged={changed} />

      <h2>{s('events')}</h2>
      <Events events={events} />
    </>
  );
}

// The cargo as the game lays it out: a backdrop of empty cells, and every
// root drawn as ONE block over the cells its item covers -- turned on its
// side (flip) width and height swap -- when the server's class index knows
// the size, one cell when it does not.
const STEP = 34; // a 32 px cell plus the 2 px gap (app.css, .cells)
function Grid({ box, items, roots, hit, index }: { box: Box; items: Item[]; roots: Item[][]; hit: (i: Item) => boolean; index: ClassIndex | null }) {
  const { s } = useLang();
  const blocks: ReactNode[] = [];
  const unplaced: Item[][] = [];
  const slots: Item[][] = [];
  for (const nodes of roots) {
    if (!nodes) continue;
    const top = nodes[0];
    if (top.loc_type === 2) {
      slots.push(nodes);
      continue;
    }
    if (top.row < 0) {
      unplaced.push(nodes);
      continue;
    }
    const size = index ? sizeOf(index, top.type) : null;
    const w = size ? (top.flip ? size[1] : size[0]) : 1;
    const h = size ? (top.flip ? size[0] : size[1]) : 1;
    blocks.push(
      <div key={`b${top.root_idx}`} className={`block${nodes.some(hit) ? ' hit' : ''}`} style={{ left: top.col * STEP, top: top.row * STEP, width: w * STEP - 2, height: h * STEP - 2 }} title={`${top.type} (${nodes.length})${size ? `, ${w}×${h}` : ''}`}>{shortType(top.type)}</div>,
    );
  }
  const cells: ReactNode[] = [];
  const rows = rowsOf(box, items);
  for (let i = 0; i < rows * COLS; i++) cells.push(<div key={i} className="cell" />);
  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <div className="cells">{cells}{blocks}</div>
      <div className="stack small">
        {unplaced.length > 0 && <div><div className="muted">{s('unplaced')}</div>{unplaced.map((n, i) => <div key={i} className="mono">{n[0].type} ({n.length})</div>)}</div>}
        {slots.length > 0 && <div><div className="muted">{s('in_slots')}</div>{slots.map((n, i) => <div key={i} className="mono">{n[0].slot}: {n[0].type} ({n.length})</div>)}</div>}
      </div>
    </div>
  );
}

// Every node is drawn at most once: a parent index that points at itself,
// forward, or in a circle cannot recurse, and whatever no chain from the
// root reaches is listed under it as it is.
function RootNode({ id, nodes, closed, hit, onEdit, onMove, onShelve }: {
  id: string; nodes: Item[]; closed: boolean; hit: (i: Item) => boolean;
  onEdit: (n: Item) => void; onMove: (n: Item) => void; onShelve: () => Promise<unknown>;
}) {
  const { s } = useLang();
  const [open, setOpen] = useState<Set<number>>(() => new Set([0]));
  const seen = new Set<number>();
  const kids = (parent: number) => nodes.map((n, i) => [n, i] as const).filter(([n, i]) => n.parent === parent && !seen.has(i));
  const toggle = (i: number) => setOpen((o) => {
    const next = new Set(o);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    return next;
  });
  const line = (n: Item, i: number): ReactNode => {
    seen.add(i);
    const below = kids(i);
    const isOpen = open.has(i);
    return (
      <li key={i}>
        <div className={`node${hit(n) ? ' hit' : ''}${isOpen ? ' open' : ''}`}>
          <span className={`twist${below.length ? '' : ' leaf'}`} onClick={below.length ? () => toggle(i) : undefined}>{below.length ? (isOpen ? '▾' : '▸') : '·'}</span>
          <span className="type">{n.type}</span>
          {n.quantity > 0 && <span className="muted">×{num(n.quantity)}</span>}
          <HealthBar value={n.health} />
          {i === 0 && <span className="muted small">{cellOf(n, s('slot'))}</span>}
          {n.has_blob ? <span className="muted" title={s('has_state')}>◆</span> : null}
          {below.length > 0 && <span className="faint small">{below.length}</span>}
          {closed && (
            <span className="acts">
              <button type="button" className="small ghost" onClick={() => onEdit(n)}>{s('edit')}</button>
              {i === 0 && <Confirm small label={s('shelve')} question={s('c_shelve', { type: n.type, id })} onConfirm={() => onShelve()} />}
              {i === 0 && <button type="button" className="small ghost" onClick={() => onMove(n)}>{s('move')}</button>}
            </span>
          )}
        </div>
        {below.length > 0 && isOpen && <ul>{below.map(([k, ki]) => line(k, ki))}</ul>}
      </li>
    );
  };
  const top = line(nodes[0], 0);
  const stray = nodes.map((n, i) => (seen.has(i) ? null : line(n, i))).filter(Boolean);
  return (
    <>
      {top}
      {stray.length > 0 && <li><ul>{stray}</ul></li>}
    </>
  );
}

// The class comes with suggestions out of the server's own class list
// (the core's dump): by class name or by game name, in either language.
function GiveForm({ id, onDone, onClose }: { id: string; onDone: OnDone; onClose: () => void }) {
  const { s, lang } = useLang();
  const held = useClassIndex();
  const [type, setType] = useState('');
  const [qty, setQty] = useState('0');
  return (
    <Panel tight>
      <div className="row">
        <Field label={s('give_class')}><SuggestInput value={type} onChange={setType} options={[]} size={28} index={held.index} lang={lang} /></Field>
        <Field label={s('give_qty')}><input value={qty} onChange={(e) => setQty(e.target.value)} size={8} /></Field>
        <Confirm primary disabled={!type.trim()} label={s('give')} question={s('c_give', { type: type.trim(), qty: Number(qty) || 0, id })}
          onConfirm={() => onDone(api('storage', 'give', { id, type: type.trim(), qty: Number(qty) || 0 }))} />
        <button type="button" className="ghost" onClick={onClose}>{s('close')}</button>
      </div>
    </Panel>
  );
}

function EditForm({ id, rootIdx, node, onDone, onClose }: { id: string; rootIdx: number; node: Item; onDone: OnDone; onClose: () => void }) {
  const { s } = useLang();
  const [qty, setQty] = useState('');
  const [hp, setHp] = useState('');
  const [reset, setReset] = useState(false);
  const submit = () => {
    const body: Record<string, unknown> = { id, root: rootIdx, node: node.node_idx };
    if (qty.trim() !== '') body.quantity = qty.trim();
    if (hp.trim() !== '') body.health = hp.trim();
    if (reset) body.reset = true;
    return onDone(api('storage', 'edit', body));
  };
  return (
    <Panel tight>
      <div className="row">
        <span className="mono">{node.type}</span>
        <span className="muted small">×{num(node.quantity)}, {s('health')} {num(node.health)}</span>
        <Field label={s('edit_qty')}><input value={qty} onChange={(e) => setQty(e.target.value)} size={10} /></Field>
        <Field label={s('edit_health')}><input value={hp} onChange={(e) => setHp(e.target.value)} size={10} /></Field>
        {node.has_blob ? <label className="check small"><input type="checkbox" checked={reset} onChange={(e) => setReset(e.target.checked)} />{s('reset_state')}</label> : null}
        <Confirm primary disabled={qty.trim() === '' && hp.trim() === ''} label={s('edit')} question={s(reset ? 'c_edit_reset' : 'c_edit', { type: node.type, id })} onConfirm={submit} />
        <button type="button" className="ghost" onClick={onClose}>{s('close')}</button>
      </div>
    </Panel>
  );
}

function MoveForm({ id, rootIdx, node, onDone, onClose }: { id: string; rootIdx: number; node: Item; onDone: OnDone; onClose: () => void }) {
  const { s } = useLang();
  const [to, setTo] = useState('');
  return (
    <Panel tight>
      <div className="row">
        <span className="mono">{node.type}</span>
        <Field label={s('move_to')}><input value={to} onChange={(e) => setTo(e.target.value)} className="mono" size={44} /></Field>
        <Confirm primary disabled={!to.trim()} label={s('move')} question={s('c_move', { type: node.type, id, to: to.trim() })}
          onConfirm={() => onDone(api('storage', 'move', { from: id, root: rootIdx, to: to.trim() }))} />
        <button type="button" className="ghost" onClick={onClose}>{s('close')}</button>
      </div>
    </Panel>
  );
}

// The versions as a timeline. Two picks make a diff (what goes, what
// comes from A to B); any version but the current one can be rolled back
// to, while the box is closed.
function Versions({ id, box, versions, closed, onChanged }: { id: string; box: Box; versions: Version[]; closed: boolean; onChanged: OnDone }) {
  const { s } = useLang();
  const [a, setA] = useState<number>(box.current_version);
  const [b, setB] = useState<number | null>(null);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [diffWhy, setDiffWhy] = useState('');
  useEffect(() => {
    setA(box.current_version);
    setB(null);
    setDiff(null);
  }, [box.current_version]);
  useEffect(() => {
    if (b === null) return setDiff(null);
    api<Diff>('storage', 'diff', { a, b }).then((r) => (r.ok ? (setDiff(r), setDiffWhy('')) : setDiffWhy(r.why)));
  }, [a, b]);
  const pick = (v: number) => {
    if (b === null || (a !== v && b !== v)) setB(v === a ? null : v);
    else if (b === v) setB(null);
    else setA(v);
  };
  return (
    <>
      <p className="muted small">{s('versions_help')}</p>
      <ul className="timeline">
        {versions.map((v) => (
          <li key={v.id}>
            <span className={`dot${v.id === box.current_version ? ' now' : ''}${v.id === b ? ' pick' : ''}`} />
            <div className="line">
              <b className={v.id === b ? 'alert' : v.id === a ? 'accent' : ''}>{s('version')} {v.id}</b>
              {v.id === box.current_version && <Badge tone="accent">{s('current')}</Badge>}
              <span className="mono muted">{v.stamp}</span>
              <span className="muted">{v.source}</span>
              <span className="muted">{v.roots} {s('roots').toLowerCase()}, {v.entities} {s('items').toLowerCase()}</span>
              {v.note && <span>{v.note}</span>}
              <button type="button" className={`small ${v.id === a || v.id === b ? '' : 'ghost'}`} onClick={() => pick(v.id)}>
                {v.id === a ? 'A' : v.id === b ? 'B' : s('compare')}
              </button>
              {v.id !== box.current_version && (
                <Confirm small warn disabled={!closed} label={s('rollback')} question={s('c_rollback', { id, v: v.id })}
                  onConfirm={() => onChanged(api('storage', 'rollback', { id, version: v.id }))} />
              )}
            </div>
          </li>
        ))}
      </ul>
      {b !== null && (
        <Panel tight title={s('diff_title', { a, b })}>
          {diffWhy && <Notice tone="bad">{diffWhy}</Notice>}
          {diff && (
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <div>
                <div className="muted small">{s('gone')}</div>
                {diff.gone.length ? diff.gone.map((x) => <div key={x.type} className="mono bad">− {x.type} ×{x.n}</div>) : <div className="faint">—</div>}
              </div>
              <div>
                <div className="muted small">{s('came')}</div>
                {diff.came.length ? diff.came.map((x) => <div key={x.type} className="mono ok">+ {x.type} ×{x.n}</div>) : <div className="faint">—</div>}
              </div>
              {!diff.gone.length && !diff.came.length && <span className="muted">{s('same')}</span>}
            </div>
          )}
        </Panel>
      )}
      {!closed && <p className="muted small">{s('closed_only')}</p>}
    </>
  );
}

function Events({ events }: { events: Event[] }) {
  const { s } = useLang();
  const cols: Col<Event>[] = [
    { key: 'when', label: s('when'), mono: true, render: (e) => e.at, sort: (e) => e.at },
    { key: 'kind', label: s('kind'), render: (e) => e.kind, sort: (e) => e.kind },
    { key: 'who', label: s('who'), render: (e) => e.name || e.uid, sort: (e) => e.name || e.uid },
    { key: 'cls', label: s('cls'), mono: true, render: (e) => e.type },
    { key: 'qty', label: s('qty'), num: true, render: (e) => e.qty || '' },
    { key: 'cell', label: s('cell'), mono: true, render: (e) => eventCell(e) },
    { key: 'note', label: s('note'), render: (e) => e.note },
    { key: 'admin', label: s('admin'), render: (e) => e.admin },
  ];
  return <Table cols={cols} rows={events} rowKey={(e) => String(e.id)} initialSort={{ key: 'when', desc: true }} />;
}

// The live commands: the engine answers through the bridge, and the answer
// lands here as it comes, without leaving the page.
function LivePanel({ box, onChanged }: { box: Box; onChanged: () => Promise<void> }) {
  const { s } = useLang();
  const toast = useToast();
  const [lines, setLines] = useState<{ id: number; text: string; tone: 'ok' | 'bad' | 'wait' }[]>([]);
  const [busy, setBusy] = useState(false);
  const id = box.box_id;
  const say = (text: string, tone: 'ok' | 'bad' | 'wait') => {
    const key = Date.now() + Math.random();
    setLines((xs) => [...xs.filter((x) => x.tone !== 'wait'), { id: key, text, tone }].slice(-6));
  };
  const run = async (op: 'report' | 'close' | 'remove') => {
    setBusy(true);
    try {
      const sent = await api<{ ref: string }>('storage', op, { id });
      if (!sent.ok) {
        say(`${op}: ${sent.why}`, 'bad');
        return;
      }
      say(`${op}: ${s('live_sent')}`, 'wait');
      const answer = await awaitResult<LiveResult>(() => api<{ result: LiveResult | null }>('storage', 'result', { ref: sent.ref }), 12, (n) => say(`${op}: ${s('live_sent')} ${n}s`, 'wait'));
      if (!answer) {
        say(`${op}: ${s('live_silent')}`, 'bad');
        return;
      }
      const note = stripRef(answer.note);
      say(`${op}: ${note}`, isOk(note) ? 'ok' : 'bad');
      if (op === 'remove' && isOk(note)) {
        toast(`${s('live_answer')} ${note}`);
        go('storage', 'boxes');
        return;
      }
      if (op === 'close' && isOk(note)) {
        await new Promise((r) => setTimeout(r, 1500));
        await onChanged();
      }
    } finally {
      setBusy(false);
    }
  };
  const cols = useMemo(() => lines, [lines]);
  return (
    <Panel tight title={s('live_title')}>
      <div className="live">
        <div className="row">
          <button type="button" disabled={busy} onClick={() => run('report')}>{s('live_report')}</button>
          {box.status === 'open' && <Confirm warn disabled={busy} label={s('live_close')} question={s('c_close', { id })} onConfirm={() => run('close')} />}
          {box.status === 'closed' && <Confirm danger disabled={busy} label={s('live_remove')} question={s('c_remove', { id })} onConfirm={() => run('remove')} />}
          <span className="muted small">{s('live_help')}</span>
        </div>
        {cols.map((l) => <div key={l.id} className={`answer ${l.tone === 'ok' ? '' : l.tone}`}>{l.text}</div>)}
      </div>
    </Panel>
  );
}

