import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useLang } from '../i18n';
import { href } from '../app/router';
import { Badge, Loading, Notice } from '../ui/bits';
import { Table, type Col } from '../ui/Table';
import { SIZES, type Box } from './model';

export function StatusBadge({ status }: { status: string }) {
  const { s } = useLang();
  const tone = status === 'open' ? 'ok' : status === 'removed' ? 'bad' : 'muted';
  const key = status === 'open' ? 'st_open' : status === 'removed' ? 'st_removed' : 'st_closed';
  return <Badge tone={tone}>{s(key)}</Badge>;
}

export function BoxLink({ id }: { id: string }) {
  return <a className="mono" href={href('storage', 'box', id)}>{id}</a>;
}

export function BoxesPage() {
  const { s } = useLang();
  const [boxes, setBoxes] = useState<Box[] | null>(null);
  const [why, setWhy] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('live');
  const [size, setSize] = useState('');

  useEffect(() => {
    api<{ boxes: Box[] }>('storage', 'boxes').then((r) => (r.ok ? setBoxes(r.boxes) : setWhy(r.why)));
  }, []);

  const rows = useMemo(() => {
    if (!boxes) return [];
    const needle = q.trim().toLowerCase();
    return boxes.filter((b) => {
      if (status === 'live' && b.status === 'removed') return false;
      if (status !== 'live' && status !== 'all' && b.status !== status) return false;
      if (size && b.class !== size) return false;
      if (needle && !`${b.box_id} ${b.class} ${b.placed_by} ${b.pos}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [boxes, q, status, size]);

  const sizeName = (cls: string) => (SIZES[cls] ? s(SIZES[cls].key) : cls);
  const cols: Col<Box>[] = [
    { key: 'id', label: s('id'), mono: true, render: (b) => <BoxLink id={b.box_id} />, sort: (b) => b.box_id },
    { key: 'cls', label: s('cls'), render: (b) => sizeName(b.class), sort: (b) => b.class },
    { key: 'status', label: s('status'), render: (b) => <StatusBadge status={b.status} />, sort: (b) => b.status },
    { key: 'items', label: s('items'), num: true, render: (b) => b.entities ?? 0, sort: (b) => b.entities ?? 0 },
    { key: 'roots', label: s('roots'), num: true, render: (b) => b.roots ?? 0, sort: (b) => b.roots ?? 0 },
    { key: 'version', label: s('version'), num: true, render: (b) => b.current_version, sort: (b) => b.current_version },
    { key: 'pos', label: s('pos'), mono: true, render: (b) => b.pos, sort: (b) => b.pos },
    { key: 'placed_by', label: s('placed_by'), render: (b) => b.placed_by, sort: (b) => b.placed_by },
    { key: 'last_seen', label: s('last_seen'), mono: true, render: (b) => b.last_seen_at, sort: (b) => b.last_seen_at },
  ];

  return (
    <>
      <h1>{s('nav_boxes')}</h1>
      <div className="toolbar">
        <input className="grow" placeholder={s('search_boxes')} value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="live">{s('f_live')}</option>
          <option value="open">{s('st_open')}</option>
          <option value="closed">{s('st_closed')}</option>
          <option value="removed">{s('st_removed')}</option>
          <option value="all">{s('all')}</option>
        </select>
        <select value={size} onChange={(e) => setSize(e.target.value)}>
          <option value="">{s('all_sizes')}</option>
          {Object.keys(SIZES).map((cls) => (
            <option key={cls} value={cls}>{s(SIZES[cls].key)}</option>
          ))}
        </select>
        {boxes && <span className="muted small">{s('n_of_m', { n: rows.length, m: boxes.length })}</span>}
      </div>
      {why && <Notice tone="bad">{why}</Notice>}
      {!boxes && !why && <Loading />}
      {boxes && <Table cols={cols} rows={rows} rowKey={(b) => b.box_id} initialSort={{ key: 'last_seen', desc: true }} />}
    </>
  );
}
