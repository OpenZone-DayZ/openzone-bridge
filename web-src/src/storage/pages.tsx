// The smaller storage pages: the shelf, find a class, a player's takings,
// the health of the bridge, the journal of admin actions.

import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { useLang } from '../i18n';
import { go, href } from '../app/router';
import { useToast } from '../app/toasts';
import { Badge, Confirm, Loading, Notice, Panel } from '../ui/bits';
import { Table, type Col } from '../ui/Table';
import { BoxLink, PlayerLink, StatusBadge } from './BoxesPage';
import { LabelForm } from './BoxPage';
import { SIZES, cellOf, eventCell, named, num, type Event, type Found, type Health, type Locker, type Parked, type Sibling } from './model';

function useAnswer<T>(kind: 'storage' | 'research', op: string, body: Record<string, unknown>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [why, setWhy] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setData(null);
    api<T>(kind, op, body).then((r) => {
      if (!alive) return;
      if (r.ok) {
        setData(r as T);
        setWhy('');
      } else setWhy(r.why);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, why, reload: () => setTick((t) => t + 1) };
}

export function ShelfPage() {
  const { s } = useLang();
  const toast = useToast();
  const { data, why, reload } = useAnswer<{ parked: Parked[] }>('storage', 'parked', {}, []);
  const classes = (p: Parked) => {
    try {
      return (JSON.parse(p.types) as string[]).join(', ');
    } catch {
      return p.types;
    }
  };
  const after = (r: { ok: true; version?: number } | { ok: false; why: string }, what: string) => {
    if (!r.ok) return toast(`${s('error')}: ${r.why}`, true);
    reload();
    toast(`${s('done')} ${what}`.trim());
  };
  const cols: Col<Parked>[] = [
    { key: 'id', label: s('id'), num: true, render: (p) => p.id, sort: (p) => p.id },
    { key: 'box', label: s('box'), render: (p) => <BoxLink id={p.box_id} />, sort: (p) => p.box_id },
    { key: 'parked_at', label: s('parked_at'), mono: true, render: (p) => p.parked_at, sort: (p) => p.parked_at },
    { key: 'reason', label: s('reason'), render: (p) => <Badge tone={p.reason === 'admin' ? 'accent' : 'alert'}>{p.reason}</Badge>, sort: (p) => p.reason },
    { key: 'cls', label: s('cls'), mono: true, render: (p) => p.type, sort: (p) => p.type },
    { key: 'classes', label: s('classes'), mono: true, render: (p) => classes(p) },
    { key: 'from', label: s('from_version'), num: true, render: (p) => p.from_version },
    { key: 'actions', label: s('actions'), render: (p) => (
      <span className="row">
        <Confirm small label={s('shelf_return')} question={s('c_return', { type: p.type, id: p.box_id })}
          onConfirm={async () => after(await api<{ version: number }>('storage', 'unpark', { parked: p.id }), s('takes_effect'))} />
        <Confirm small danger label={s('shelf_discard')} question={s('c_discard', { type: p.type })}
          onConfirm={async () => after(await api('storage', 'discard', { parked: p.id }), '')} />
      </span>
    ) },
  ];
  return (
    <>
      <h1>{s('nav_shelf')}</h1>
      {why && <Notice tone="bad">{why}</Notice>}
      {!data && !why && <Loading />}
      {data && <Table cols={cols} rows={data.parked} rowKey={(p) => String(p.id)} initialSort={{ key: 'parked_at', desc: true }} />}
    </>
  );
}

function SearchForm({ value, placeholder, onSubmit }: { value: string; placeholder: string; onSubmit: (v: string) => void }) {
  const { s } = useLang();
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(v.trim());
  };
  return (
    <form className="toolbar" onSubmit={submit}>
      <input className="grow mono" placeholder={placeholder} value={v} onChange={(e) => setV(e.target.value)} />
      <button type="submit" className="primary">{s('search')}</button>
    </form>
  );
}

export function FindPage({ type }: { type: string }) {
  const { s } = useLang();
  const { data, why } = useAnswer<{ items: Found[]; last: Event | null }>('storage', 'find', { type }, [type]);
  const cols: Col<Found>[] = [
    { key: 'box', label: s('box'), render: (i) => <BoxLink id={i.box_id} />, sort: (i) => i.box_id },
    { key: 'status', label: s('status'), render: (i) => <StatusBadge status={i.status} /> },
    { key: 'cls', label: s('cls'), render: (i) => (SIZES[i.box_class] ? s(SIZES[i.box_class].key) : i.box_class) },
    { key: 'pos', label: s('pos'), mono: true, render: (i) => i.pos },
    { key: 'cell', label: s('cell'), mono: true, render: (i) => cellOf(i, s('slot')) },
    { key: 'qty', label: s('qty'), num: true, render: (i) => num(i.quantity) },
    { key: 'health', label: s('health'), num: true, render: (i) => num(i.health) },
  ];
  return (
    <>
      <h1>{s('nav_find')}</h1>
      <SearchForm value={type} placeholder={s('cls')} onSubmit={(v) => go('storage', 'find', v)} />
      {type && why && <Notice tone="bad">{why}</Notice>}
      {type && !data && !why && <Loading />}
      {data && (
        <>
          {data.last
            ? <p>{s('last_taken')}: <PlayerLink uid={data.last.uid} name={data.last.name} /> · <span className="mono">{data.last.at}</span> · <BoxLink id={data.last.box_id} /></p>
            : <p className="muted">{s('nobody_took')}</p>}
          <Table cols={cols} rows={data.items} rowKey={(i) => `${i.box_id}/${i.root_idx}/${i.node_idx}`} />
        </>
      )}
    </>
  );
}

export function PlayerPage({ uid }: { uid: string }) {
  const { s } = useLang();
  const { data, why } = useAnswer<{ events: Event[]; name?: string }>('storage', 'player', { uid, limit: 500 }, [uid]);
  const boxes = data ? [...new Set(data.events.map((e) => e.box_id).filter(Boolean))] : [];
  const cols: Col<Event>[] = [
    { key: 'when', label: s('when'), mono: true, render: (e) => e.at, sort: (e) => e.at },
    { key: 'kind', label: s('kind'), render: (e) => e.kind, sort: (e) => e.kind },
    { key: 'box', label: s('box'), render: (e) => (e.box_id ? <BoxLink id={e.box_id} /> : ''), sort: (e) => e.box_id },
    { key: 'cls', label: s('cls'), mono: true, render: (e) => e.type },
    { key: 'qty', label: s('qty'), num: true, render: (e) => e.qty || '' },
    { key: 'cell', label: s('cell'), mono: true, render: (e) => eventCell(e) },
    { key: 'note', label: s('note'), render: (e) => e.note },
  ];
  return (
    <>
      <h1>{s('nav_player')}{uid && data ? <span className="muted"> · {named(uid, data.name)}</span> : null}</h1>
      <SearchForm value={uid} placeholder={s('uid')} onSubmit={(v) => go('storage', 'player', v)} />
      {uid && why && <Notice tone="bad">{why}</Notice>}
      {uid && !data && !why && <Loading />}
      {data && (
        <>
          {boxes.length > 0 && <p className="row">{s('player_boxes')}: {boxes.map((b) => <BoxLink key={b} id={b} />)}</p>}
          <Table cols={cols} rows={data.events} rowKey={(e) => String(e.id)} initialSort={{ key: 'when', desc: true }} />
        </>
      )}
    </>
  );
}

// One locker: where it stands, the admin's label for it, and every
// player's stash there by name -- the pick of whose stash to show (owner,
// 2026-09-27).
export function LockerPage({ anchor }: { anchor: string }) {
  const { s } = useLang();
  const { data, why, reload } = useAnswer<{ locker: Locker }>('storage', 'locker', { anchor }, [anchor]);
  const cols: Col<Sibling>[] = [
    { key: 'who', label: s('owner'), render: (x) => <a href={href('storage', 'box', x.box_id)} title={x.owner}>{named(x.owner, x.owner_name)}</a>, sort: (x) => x.owner_name || x.owner },
    { key: 'status', label: s('status'), render: (x) => <><StatusBadge status={x.status} />{x.in_world === 'no' && x.status !== 'removed' && <> <Badge tone="bad">{s('st_absent')}</Badge></>}</>, sort: (x) => x.status },
    { key: 'items', label: s('items'), num: true, render: (x) => x.entities ?? 0, sort: (x) => x.entities ?? 0 },
    { key: 'roots', label: s('roots'), num: true, render: (x) => x.roots ?? 0, sort: (x) => x.roots ?? 0 },
    { key: 'last_seen', label: s('last_seen'), mono: true, render: (x) => x.last_seen_at || '', sort: (x) => x.last_seen_at || '' },
    { key: 'id', label: s('id'), render: (x) => <BoxLink id={x.box_id} /> },
  ];
  return (
    <>
      <h1>{s('locker')} <span className="mono">{anchor}</span>{data && data.locker.name ? <span className="muted"> · {data.locker.name}</span> : null}</h1>
      {why && <Notice tone="bad">{why}</Notice>}
      {!data && !why && <Loading />}
      {data && (
        <>
          <Panel>
            <div className="facts">
              <span className="k">{s('cls')}</span><span>{s('size_stash')}</span>
              <span className="k">{s('pos')}</span><span className="mono">{data.locker.pos || '—'}</span>
              {data.locker.place ? <><span className="k">{s('place')}</span><span>{data.locker.place}</span></> : null}
              <span className="k">{s('f_kind_stash')}</span><span>{data.locker.stashes.length}</span>
              <span className="k">{s('last_seen')}</span><span className="mono">{data.locker.last_seen_at || '—'}</span>
            </div>
          </Panel>
          <LabelForm id={`locker:${anchor}`} name={data.locker.name} place={data.locker.place} onSaved={async () => reload()} />
          <p className="muted small">{s('locker_help')}</p>
          <Table cols={cols} rows={data.locker.stashes} rowKey={(x) => x.box_id} initialSort={{ key: 'last_seen', desc: true }} />
        </>
      )}
    </>
  );
}

export function HealthPage() {
  const { s } = useLang();
  const { data, why } = useAnswer<Health>('storage', 'health', {}, []);
  const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
  return (
    <>
      <h1>{s('nav_health')}</h1>
      {why && <Notice tone="bad">{why}</Notice>}
      {!data && !why && <Loading />}
      {data && (
        <>
          <div className="cards">
            <div className="card"><span className="label">{s('xchg')}</span><span className={`value ${data.xchg ? 'ok' : 'bad'}`}>{data.xchg ? s('configured') : s('not_configured')}</span></div>
            <div className="card"><span className="label">{s('auth')}</span><span className="value">{data.auth ? s('auth_discord') : s('auth_none')}</span></div>
            <div className="card"><span className="label">{s('db_size')}</span><span className="value">{mb(data.dbBytes || 0)}</span></div>
            <div className="card"><span className="label">{s('keep')}</span><span className="value">{data.keep ? data.keep.versions : 0} / {data.keep ? data.keep.events : 0}</span><span className="label">{s('keep_versions')} / {s('keep_events')}</span></div>
          </div>
          <Panel title={s('servers')}>
            {data.servers.length
              ? <ul>{data.servers.map((x) => <li key={x.id} className="mono">{x.id}: {s('last_poll')} {x.at}</li>)}</ul>
              : <p className="muted">{s('no_servers')}</p>}
          </Panel>
          <Panel title={s('open_boxes')}>
            <Table cols={[
              { key: 'id', label: s('id'), render: (b) => <BoxLink id={b.box_id} /> },
              { key: 'cls', label: s('cls'), render: (b) => (SIZES[b.class] ? s(SIZES[b.class].key) : b.class) },
              { key: 'last_seen', label: s('last_seen'), mono: true, render: (b) => b.last_seen_at },
            ] as Col<Health['open'][number]>[]} rows={data.open || []} rowKey={(b) => b.box_id} />
          </Panel>
        </>
      )}
    </>
  );
}

export function StorageJournalPage() {
  const { s } = useLang();
  const { data, why } = useAnswer<{ events: Event[] }>('storage', 'journal', { limit: 500 }, []);
  const [q, setQ] = useState('');
  const rows = data ? data.events.filter((e) => !q.trim() || `${e.admin} ${e.kind} ${e.note} ${e.box_id}`.toLowerCase().includes(q.trim().toLowerCase())) : [];
  const cols: Col<Event>[] = [
    { key: 'when', label: s('when'), mono: true, render: (e) => e.at, sort: (e) => e.at },
    { key: 'admin', label: s('admin'), render: (e) => e.admin, sort: (e) => e.admin },
    { key: 'kind', label: s('kind'), render: (e) => e.kind.replace(/^admin_/, ''), sort: (e) => e.kind },
    { key: 'box', label: s('box'), render: (e) => (e.box_id ? <BoxLink id={e.box_id} /> : ''), sort: (e) => e.box_id },
    { key: 'note', label: s('note'), render: (e) => e.note },
  ];
  return (
    <>
      <h1>{s('nav_journal')}</h1>
      <div className="toolbar"><input className="grow" placeholder={s('filter_journal')} value={q} onChange={(e) => setQ(e.target.value)} /></div>
      {why && <Notice tone="bad">{why}</Notice>}
      {!data && !why && <Loading />}
      {data && <Table cols={cols} rows={rows} rowKey={(e) => String(e.id)} initialSort={{ key: 'when', desc: true }} />}
    </>
  );
}

export { useAnswer };
