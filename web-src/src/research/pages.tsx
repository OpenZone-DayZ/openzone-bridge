// The research pages: the nine configs and their versions, the factions
// with their pools, the statics, the journal. A change is a candidate the
// game applies and answers; the answer lands on the page as it comes.

import { useEffect, useState } from 'react';
import { api, type Answer } from '../api/client';
import { useLang, type Key } from '../i18n';
import { href } from '../app/router';
import { useToast } from '../app/toasts';
import { Badge, Confirm, Field, Loading, Notice, Panel } from '../ui/bits';
import { Table, type Col } from '../ui/Table';
import { useAnswer } from '../storage/pages';

export type ConfigSummary = {
  name: string; file: string; exists: boolean; size: number; version: number; at: string; by: string; source: string;
  latest: number; latestStatus: string; pending: number;
};
export type ConfigVersion = { name: string; version: number; hash: string; at: string; by: string; source: string; status: string; why: string; token: string; size: number };
export type ConfigText = ConfigVersion & { text: string };
export type Command = {
  token: string; op: string; args: Record<string, string>; by: string; at: string; status: string; ok: boolean; answer: string; answered_at: string;
  version: { name: string; version: number; status: string; why: string } | null;
};
export type Owner = { owner: string; points: { key: string; value: number }[]; completed: string[]; projects: { node: string; starter: string; endSec: number }[]; at: string; error?: string };
export type StaticEntry = { id: string; className: string; pos: number[]; yaw: number; spawned: boolean };
export type ResearchEvent = { id: number; at: string; kind: string; note: string; server_id: string; admin: string; name: string; token: string };
export type Status = { configured: boolean; dir: string; xchg: string; booted: { id: string; revision: number; counters: string; at: string; classes: number }[]; classes: number; unanswered: number };

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The game's answer to a research command, asked once a second.
export async function awaitCommand(token: string, seconds = 20, tick?: (n: number) => void): Promise<Command | null> {
  for (let i = 0; i < seconds; i++) {
    await pause(1000);
    tick?.(i + 1);
    const r = await api<{ result: Command | null }>('research', 'result', { token });
    if (r.ok && r.result && r.result.status === 'answered') return r.result;
  }
  return null;
}

function StatusBadge({ status }: { status: string }) {
  const { s } = useLang();
  const key: Key = status === 'pending' ? 'r_pending' : status === 'rejected' ? 'r_rejected' : 'r_applied';
  return <Badge tone={status === 'pending' ? 'alert' : status === 'rejected' ? 'bad' : 'ok'}>{s(key)}</Badge>;
}

// A live command from a page: sent, awaited, told. Returns the answer.
function useCommand() {
  const { s } = useLang();
  const toast = useToast();
  const [waiting, setWaiting] = useState('');
  const run = async (op: string, body: Record<string, unknown>): Promise<Command | null> => {
    const sent = await api<{ token: string }>('research', op, body);
    if (!sent.ok) {
      toast(`${s('error')}: ${sent.why}`, true);
      return null;
    }
    setWaiting(`${op}: ${s('live_sent')}`);
    const answer = await awaitCommand(sent.token, 20, (n) => setWaiting(`${op}: ${s('live_sent')} ${n}s`));
    setWaiting('');
    if (!answer) {
      toast(s('r_answer_wait'), true);
      return null;
    }
    if (answer.ok) toast(s('r_answer_ok', { note: answer.answer || op }));
    else toast(s('r_answer_bad', { why: answer.answer }), true);
    return answer;
  };
  return { run, waiting };
}

export function ConfigsPage() {
  const { s } = useLang();
  const { data, why, reload } = useAnswer<{ configs: ConfigSummary[] }>('research', 'configs', {}, []);
  const status = useAnswer<Status>('research', 'status', {}, []);
  const { run, waiting } = useCommand();
  return (
    <>
      <h1>{s('nav_configs')}</h1>
      {why && <Notice tone="bad">{why === 'research not configured' ? s('r_not_configured') : why}</Notice>}
      {status.data && (
        <div className="toolbar">
          {status.data.booted.map((b) => (
            <span key={b.id} className="muted small">{s('r_booted')} <b className="mono">{b.id}</b> {b.at}, {s('r_revision')} {b.revision}, {b.classes} {s('r_classes_known')}</span>
          ))}
          {status.data.unanswered > 0 && <Badge tone="alert">{s('r_unanswered')}: {status.data.unanswered}</Badge>}
          <span className="grow" />
          <Confirm warn label={s('r_reload')} question={s('r_c_reload')} onConfirm={async () => { await run('reload', {}); reload(); }} />
        </div>
      )}
      {waiting && <Notice>{waiting}</Notice>}
      {!data && !why && <Loading />}
      {data && (
        <div className="cards">
          {data.configs.map((c) => (
            <div key={c.name} className="card">
              <div className="row">
                <b>{c.name.replace(/^Research/, '')}</b>
                <span className="grow" />
                {c.exists ? <Badge tone="ok">{s('r_on_disk')}</Badge> : <Badge tone="bad">{s('r_missing')}</Badge>}
              </div>
              <div className="mono small muted">{c.file}{c.exists ? ` · ${c.size} B` : ''}</div>
              <div className="row small">
                <span>{s('version')} <b>{c.version || '—'}</b></span>
                {c.version > 0 && <span className="muted">{s('r_by')} {c.by} · <span className="mono">{c.at}</span></span>}
              </div>
              <div className="row small">
                {c.latest > c.version && <span>{s('r_latest')} {c.latest} <StatusBadge status={c.latestStatus} /></span>}
                {c.pending > 0 && <Badge tone="alert">{s('r_pending')}: {c.pending}</Badge>}
              </div>
              <div className="row">
                <a className="button small" href={href('research', 'config', c.name)}>{s('r_edit')}</a>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function ConfigPage({ name }: { name: string }) {
  const { s } = useLang();
  const toast = useToast();
  const [current, setCurrent] = useState<ConfigText | null>(null);
  const [shown, setShown] = useState<ConfigText | null>(null);
  const [text, setText] = useState('');
  const [history, setHistory] = useState<ConfigVersion[]>([]);
  const [why, setWhy] = useState('');
  const [waiting, setWaiting] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    Promise.all([
      api<ConfigText>('research', 'config', { name }),
      api<{ versions: ConfigVersion[] }>('research', 'history', { name, limit: 100 }),
    ]).then(([c, h]) => {
      if (!alive) return;
      if (!c.ok) return setWhy(c.why);
      setWhy('');
      setCurrent(c);
      setShown(c);
      setText(c.text);
      setHistory(h.ok ? h.versions : []);
    });
    return () => {
      alive = false;
    };
  }, [name, tick]);
  const reload = () => setTick((t) => t + 1);

  const view = async (v: ConfigVersion) => {
    const c = await api<ConfigText>('research', 'config', { name, version: v.version });
    if (!c.ok) return toast(`${s('error')}: ${c.why}`, true);
    setShown(c);
    setText(c.text);
  };

  const follow = async (sent: Answer<{ token: string; version: number; file: string }>) => {
    if (!sent.ok) {
      toast(`${s('error')}: ${sent.why}`, true);
      return;
    }
    setWaiting(s('r_sent', { v: sent.version, token: sent.token }));
    const answer = await awaitCommand(sent.token, 20);
    setWaiting('');
    if (!answer) toast(s('r_answer_wait'), true);
    else if (answer.ok) toast(s('r_answer_ok', { note: answer.answer }));
    else toast(s('r_answer_bad', { why: answer.answer }), true);
    reload();
  };

  const save = async () => {
    try {
      JSON.parse(text);
    } catch (e) {
      toast(s('r_not_json', { why: (e as Error).message }), true);
      return;
    }
    await follow(await api<{ token: string; version: number; file: string }>('research', 'save', { name, json: text }));
  };

  const cols: Col<ConfigVersion>[] = [
    { key: 'version', label: s('version'), num: true, render: (v) => v.version, sort: (v) => v.version },
    { key: 'status', label: s('status'), render: (v) => <StatusBadge status={v.status} /> },
    { key: 'at', label: s('when'), mono: true, render: (v) => v.at, sort: (v) => v.at },
    { key: 'by', label: s('who'), render: (v) => v.by },
    { key: 'source', label: s('source'), render: (v) => v.source },
    { key: 'size', label: s('r_size'), num: true, render: (v) => v.size },
    { key: 'why', label: s('note'), render: (v) => v.why },
    { key: 'actions', label: s('actions'), render: (v) => (
      <span className="row">
        <button type="button" className="small ghost" onClick={() => view(v)}>{s('r_view')}</button>
        {v.status !== 'pending' && (
          <Confirm small warn label={s('r_restore')} question={s('r_c_restore', { v: v.version, name })}
            onConfirm={async () => follow(await api<{ token: string; version: number; file: string }>('research', 'restore', { name, version: v.version }))} />
        )}
      </span>
    ) },
  ];

  const dirty = shown !== null && text !== shown.text;
  return (
    <>
      <h1>{name.replace(/^Research/, '')} <span className="muted small">{name}</span></h1>
      {why && <Notice tone="bad">{why}</Notice>}
      {!current && !why && <Loading />}
      {current && shown && (
        <>
          <Panel tight>
            <div className="row">
              <span>{s('version')} <b>{shown.version}</b></span>
              <StatusBadge status={shown.status} />
              <span className="muted">{s('r_by')} {shown.by} · <span className="mono">{shown.at}</span></span>
              {shown.version !== current.version && <span className="alert small">{s('r_latest')}: {current.version}</span>}
              <span className="grow" />
              <Confirm primary disabled={!dirty} label={s('r_save')} question={s('r_c_save', { name })} onConfirm={save} />
              {dirty && <button type="button" className="ghost" onClick={() => setText(shown.text)}>{s('close')}</button>}
            </div>
          </Panel>
          {waiting && <Notice>{waiting}</Notice>}
          <p className="muted small">{s('r_editor_soon')}</p>
          <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} style={{ width: '100%', minHeight: 360 }} />
          <h2>{s('r_history')}</h2>
          <Table cols={cols} rows={history} rowKey={(v) => String(v.version)} initialSort={{ key: 'version', desc: true }} pick={(v) => v.version === shown.version} />
        </>
      )}
    </>
  );
}

export function FactionsPage() {
  const { s } = useLang();
  const { data, why, reload } = useAnswer<{ owners: Owner[] }>('research', 'state', {}, []);
  const { run, waiting } = useCommand();
  const [grantOf, setGrantOf] = useState<string | null>(null);
  const [type, setType] = useState('');
  const [amount, setAmount] = useState('1');
  const [node, setNode] = useState('');
  const after = async (op: string, body: Record<string, unknown>) => {
    const a = await run(op, body);
    if (a && a.ok) {
      setGrantOf(null);
      reload();
    }
  };
  const cols: Col<Owner>[] = [
    { key: 'owner', label: s('r_owner'), mono: true, render: (o) => o.owner, sort: (o) => o.owner },
    { key: 'pool', label: s('r_pool'), render: (o) => (o.error ? <span className="bad">{s('r_unreadable')}: {o.error}</span> : o.points.length ? o.points.map((p) => <span key={p.key} className="badge">{p.key} {p.value}</span>) : <span className="faint">—</span>) },
    { key: 'completed', label: s('r_completed'), render: (o) => (o.completed.length ? <span className="mono small">{o.completed.join(', ')}</span> : <span className="faint">—</span>), sort: (o) => o.completed.length },
    { key: 'projects', label: s('r_projects'), render: (o) => (o.projects.length ? o.projects.map((p) => <div key={p.node} className="mono small">{p.node} · {p.starter}</div>) : <span className="faint">—</span>), sort: (o) => o.projects.length },
    { key: 'at', label: s('r_updated'), mono: true, render: (o) => o.at, sort: (o) => o.at },
    { key: 'actions', label: s('actions'), render: (o) => (
      <span className="row">
        <button type="button" className="small" onClick={() => setGrantOf(grantOf === o.owner ? null : o.owner)}>{s('r_grant')} / {s('r_complete')}</button>
        <Confirm small danger label={s('r_reset')} question={s('r_c_reset', { owner: o.owner })} onConfirm={() => after('reset', { owner: o.owner })} />
      </span>
    ) },
  ];
  return (
    <>
      <h1>{s('nav_factions')}</h1>
      {why && <Notice tone="bad">{why === 'research not configured' ? s('r_not_configured') : why}</Notice>}
      {waiting && <Notice>{waiting}</Notice>}
      {grantOf && (
        <Panel tight title={grantOf}>
          <div className="row">
            <Field label={s('r_point_type')}><input className="mono" value={type} onChange={(e) => setType(e.target.value)} size={20} /></Field>
            <Field label={s('r_amount')}><input value={amount} onChange={(e) => setAmount(e.target.value)} size={6} /></Field>
            <Confirm primary disabled={!type.trim() || !Number(amount)} label={s('r_grant')} question={s('r_c_grant', { amount: Number(amount) || 0, type: type.trim(), owner: grantOf })}
              onConfirm={() => after('grant', { owner: grantOf, type: type.trim(), amount: Number(amount) || 0 })} />
            <Field label={s('r_node')}><input className="mono" value={node} onChange={(e) => setNode(e.target.value)} size={20} /></Field>
            <Confirm primary disabled={!node.trim()} label={s('r_complete')} question={s('r_c_complete', { node: node.trim(), owner: grantOf })}
              onConfirm={() => after('complete', { owner: grantOf, node: node.trim() })} />
            <button type="button" className="ghost" onClick={() => setGrantOf(null)}>{s('close')}</button>
          </div>
        </Panel>
      )}
      {!data && !why && <Loading />}
      {data && <Table cols={cols} rows={data.owners} rowKey={(o) => o.owner} empty={s('r_no_state')} />}
    </>
  );
}

export function StaticsPage() {
  const { s } = useLang();
  const { data, why, reload } = useAnswer<{ entries: StaticEntry[] }>('research', 'statics', {}, []);
  const { run, waiting } = useCommand();
  const cols: Col<StaticEntry>[] = [
    { key: 'id', label: s('id'), mono: true, render: (e) => e.id, sort: (e) => e.id },
    { key: 'cls', label: s('r_class'), mono: true, render: (e) => e.className, sort: (e) => e.className },
    { key: 'pos', label: s('pos'), mono: true, render: (e) => e.pos.join(' '), sort: (e) => e.pos.join(' ') },
    { key: 'spawned', label: s('status'), render: (e) => (e.spawned ? <Badge tone="ok">{s('r_spawned')}</Badge> : <Badge tone="alert">{s('r_pending_spawn')}</Badge>), sort: (e) => (e.spawned ? 1 : 0) },
    { key: 'actions', label: s('actions'), render: (e) => (
      <Confirm small warn label={s('r_respawn')} question={s('r_c_respawn', { id: e.id })} onConfirm={async () => { await run('respawn', { id: e.id }); reload(); }} />
    ) },
  ];
  return (
    <>
      <h1>{s('nav_statics')}</h1>
      {why && <Notice tone="bad">{why === 'research not configured' ? s('r_not_configured') : why}</Notice>}
      {waiting && <Notice>{waiting}</Notice>}
      {!data && !why && <Loading />}
      {data && <Table cols={cols} rows={data.entries} rowKey={(e) => e.id} initialSort={{ key: 'id' }} />}
    </>
  );
}

export function ResearchJournalPage() {
  const { s } = useLang();
  const { data, why } = useAnswer<{ events: ResearchEvent[] }>('research', 'events', { limit: 500 }, []);
  const [q, setQ] = useState('');
  const rows = data ? data.events.filter((e) => !q.trim() || `${e.admin} ${e.kind} ${e.note} ${e.name}`.toLowerCase().includes(q.trim().toLowerCase())) : [];
  const cols: Col<ResearchEvent>[] = [
    { key: 'when', label: s('when'), mono: true, render: (e) => e.at, sort: (e) => e.at },
    { key: 'kind', label: s('kind'), render: (e) => e.kind.replace(/^admin_/, ''), sort: (e) => e.kind },
    { key: 'admin', label: s('admin'), render: (e) => e.admin, sort: (e) => e.admin },
    { key: 'name', label: s('r_config'), render: (e) => (e.name ? <a href={href('research', 'config', e.name)}>{e.name}</a> : ''), sort: (e) => e.name },
    { key: 'token', label: s('r_token'), mono: true, render: (e) => e.token },
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

