import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useLang } from '../i18n';
import { href } from '../app/router';
import { Badge, Loading, Notice } from '../ui/bits';
import { Table, type Col } from '../ui/Table';
import { SIZES, type Box, type Locker } from './model';

export function StatusBadge({ status }: { status: string }) {
  const { s } = useLang();
  const tone = status === 'open' ? 'ok' : status === 'removed' ? 'bad' : 'muted';
  const key = status === 'open' ? 'st_open' : status === 'removed' ? 'st_removed' : 'st_closed';
  return <Badge tone={tone}>{s(key)}</Badge>;
}

export function BoxLink({ id }: { id: string }) {
  return <a className="mono" href={href('storage', 'box', id)}>{id}</a>;
}

export function LockerLink({ anchor }: { anchor: string }) {
  const { s } = useLang();
  return <a href={href('storage', 'locker', anchor)}>{s('locker')} <span className="mono">{anchor}</span></a>;
}

// A player by name where an event ever named them, the number alone
// otherwise; the number stays in the tooltip, and the click opens the
// player's page.
export function PlayerLink({ uid, name }: { uid: string; name?: string }) {
  if (!uid) return null;
  return <a className={name ? '' : 'mono'} href={href('storage', 'player', uid)} title={uid}>{name || uid}</a>;
}

// One row of the list: a box, or a locker. A personal stash is one
// player's record at a locker, and the list shows the LOCKER -- one row,
// the class "personal stash", no items and no roots because every player
// has their own, the spot, the name (owner, 2026-09-27); the players'
// stashes, and whose they are, are on the locker's page -- the list has no
// "whose" column at all; where that column stood is the admin's note on
// where the thing stands (owner, 2026-09-27).
type Row = { key: string; box?: Box; locker?: Locker };

export function BoxesPage() {
  const { s } = useLang();
  const [boxes, setBoxes] = useState<Box[] | null>(null);
  const [lockers, setLockers] = useState<Locker[]>([]);
  const [why, setWhy] = useState('');
  const [q, setQ] = useState('');
  // Two questions, two filters. They used to be one, and its default was
  // labelled "In the world" while it actually meant "not deleted" -- so the
  // list showed three boxes under that heading, each wearing a "not in the
  // world" badge (owner, 2026-09-22). Status is what SQL holds; presence is
  // what the server reported at its last boot. A box can be closed and
  // absent, or removed and still remembered.
  const [status, setStatus] = useState('live');
  const [world, setWorld] = useState('');
  const [size, setSize] = useState('');
  // Boxes and lockers share the list; this narrows it to one kind or the
  // other when an admin is looking for one in particular.
  const [kind, setKind] = useState('');

  useEffect(() => {
    api<{ boxes: Box[]; lockers?: Locker[] }>('storage', 'boxes').then((r) => {
      if (!r.ok) return setWhy(r.why);
      setBoxes(r.boxes);
      setLockers(r.lockers || []);
    });
  }, []);

  const rows = useMemo<Row[]>(() => {
    if (!boxes) return [];
    const needle = q.trim().toLowerCase();
    const out: Row[] = [];
    for (const b of boxes) {
      if (b.kind === 'stash') continue;
      if (status === 'live' && b.status === 'removed') continue;
      if (status !== 'live' && status !== 'all' && b.status !== status) continue;
      if (world && (b.in_world || 'unknown') !== world) continue;
      if (size && b.class !== size) continue;
      if (kind && kind !== 'box') continue;
      if (needle && !`${b.box_id} ${b.class} ${b.placed_by} ${b.placed_by_name || ''} ${b.pos} ${b.name || ''} ${b.place || ''}`.toLowerCase().includes(needle)) continue;
      out.push({ key: b.box_id, box: b });
    }
    // A locker has no status and no presence of its own: it is listed
    // under "kept" and "any", and under its own kind and size.
    if ((status === 'live' || status === 'all') && !world && (!size || size === 'OZ_PersonalStash') && (!kind || kind === 'stash')) {
      for (const l of lockers) {
        const who = l.stashes.map((x) => `${x.owner} ${x.owner_name}`).join(' ');
        if (needle && !`${l.anchor} ${l.pos} ${l.name} ${l.place} ${who}`.toLowerCase().includes(needle)) continue;
        out.push({ key: `locker:${l.anchor}`, locker: l });
      }
    }
    return out;
  }, [boxes, lockers, q, status, world, size, kind]);

  const sizeName = (cls: string) => (SIZES[cls] ? s(SIZES[cls].key) : cls);
  const cols: Col<Row>[] = [
    { key: 'id', label: s('id'), render: (r) => (r.box ? <BoxLink id={r.box.box_id} /> : <LockerLink anchor={r.locker!.anchor} />), sort: (r) => (r.box ? r.box.box_id : `locker:${r.locker!.anchor}`) },
    { key: 'cls', label: s('cls'), render: (r) => (r.box ? sizeName(r.box.class) : s('size_stash')), sort: (r) => (r.box ? r.box.class : 'OZ_PersonalStash') },
    { key: 'name', label: s('name'), render: (r) => (r.box || r.locker!).name || '', sort: (r) => (r.box || r.locker!).name || '' },
    { key: 'status', label: s('status'), render: (r) => (r.box ? <><StatusBadge status={r.box.status} />{r.box.in_world === 'no' && r.box.status !== 'removed' && <> <Badge tone="bad">{s('st_absent')}</Badge></>}</> : <span className="muted">{s('stashes_n', { n: r.locker!.stashes.length })}</span>), sort: (r) => (r.box ? (r.box.in_world === 'no' && r.box.status !== 'removed' ? `${r.box.status} absent` : r.box.status) : 'locker') },
    { key: 'items', label: s('items'), num: true, render: (r) => (r.box ? r.box.entities ?? 0 : ''), sort: (r) => (r.box ? r.box.entities ?? 0 : -1) },
    { key: 'roots', label: s('roots'), num: true, render: (r) => (r.box ? r.box.roots ?? 0 : ''), sort: (r) => (r.box ? r.box.roots ?? 0 : -1) },
    { key: 'version', label: s('version'), num: true, render: (r) => (r.box ? r.box.current_version : ''), sort: (r) => (r.box ? r.box.current_version : -1) },
    { key: 'pos', label: s('pos'), mono: true, render: (r) => (r.box ? r.box.pos : r.locker!.pos), sort: (r) => (r.box ? r.box.pos : r.locker!.pos) },
    { key: 'place', label: s('place'), render: (r) => (r.box || r.locker!).place || '', sort: (r) => (r.box || r.locker!).place || '' },
    { key: 'placed_by', label: s('placed_by'), render: (r) => (r.box ? <PlayerLink uid={r.box.placed_by} name={r.box.placed_by_name} /> : ''), sort: (r) => (r.box ? r.box.placed_by_name || r.box.placed_by : '') },
    { key: 'last_seen', label: s('last_seen'), mono: true, render: (r) => (r.box ? r.box.last_seen_at : r.locker!.last_seen_at), sort: (r) => (r.box ? r.box.last_seen_at : r.locker!.last_seen_at) },
  ];

  return (
    <>
      <h1>{s('nav_boxes')}</h1>
      <div className="toolbar">
        <input className="grow" placeholder={s('search_boxes')} value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={status} onChange={(e) => setStatus(e.target.value)} title={s('f_status')}>
          <option value="live">{s('f_kept')}</option>
          <option value="open">{s('st_open')}</option>
          <option value="closed">{s('st_closed')}</option>
          <option value="removed">{s('st_removed')}</option>
          <option value="all">{s('f_any_status')}</option>
        </select>
        <select value={world} onChange={(e) => setWorld(e.target.value)} title={s('f_world')}>
          <option value="">{s('f_any_world')}</option>
          <option value="yes">{s('f_world_yes')}</option>
          <option value="no">{s('f_world_no')}</option>
          <option value="unknown">{s('f_world_unknown')}</option>
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value)} title={s('f_kind')}>
          <option value="">{s('f_any_kind')}</option>
          <option value="box">{s('f_kind_box')}</option>
          <option value="stash">{s('f_kind_stash')}</option>
        </select>
        <select value={size} onChange={(e) => setSize(e.target.value)}>
          <option value="">{s('all_sizes')}</option>
          {Object.keys(SIZES).map((cls) => (
            <option key={cls} value={cls}>{s(SIZES[cls].key)}</option>
          ))}
        </select>
        {boxes && <span className="muted small">{s('n_of_m', { n: rows.length, m: boxes.filter((b) => b.kind !== 'stash').length + lockers.length })}</span>}
      </div>
      {why && <Notice tone="bad">{why}</Notice>}
      {!boxes && !why && <Loading />}
      {boxes && <Table cols={cols} rows={rows} rowKey={(r) => r.key} initialSort={{ key: 'last_seen', desc: true }} />}
    </>
  );
}
