// The research pages: the nine configs and their versions, the factions
// with their pools, the statics, the journal. A change is a candidate the
// game applies and answers; the answer lands on the page as it comes.

import { useState } from 'react';
import { api } from '../api/client';
import { useLang, type Key } from '../i18n';
import { href } from '../app/router';
import { useToast } from '../app/toasts';
import { Badge, Confirm, Field, Loading, Notice, Panel } from '../ui/bits';
import { Table, type Col } from '../ui/Table';
import { useAnswer } from '../storage/pages';
import { unzipSync, strFromU8 } from 'fflate';
import { isName, parseText, serialize } from './editor/schema';

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
          <ZipUpload onDone={reload} />
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

// A starter pack: a zip holding the nine OZ_Research_*.json files (any
// folder inside), each sent to the game as a candidate.
function ZipUpload({ onDone }: { onDone: () => void }) {
  const { s } = useLang();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
      let sent = 0;
      for (const [path, bytes] of Object.entries(entries)) {
        const m = /OZ_Research_([A-Za-z]+)\.json$/.exec(path);
        if (!m) continue;
        const name = `Research${m[1]}`;
        if (!isName(name)) continue;
        const parsed = parseText(name, strFromU8(bytes));
        if (parsed.why) {
          toast(`${name}: ${s('r_not_json', { why: parsed.why })}`, true);
          continue;
        }
        const r = await api<{ token: string }>('research', 'save', { name, json: serialize(name, parsed.doc) });
        if (!r.ok) toast(`${name}: ${r.why}`, true);
        else sent++;
      }
      toast(sent ? s('e_zip_sent', { n: sent }) : s('e_zip_none'), !sent);
      onDone();
    } catch (e) {
      toast(`${s('error')}: ${(e as Error).message}`, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <label className="button small" title={s('e_zip')}>
      {busy ? s('loading') : s('e_zip')}
      <input type="file" accept=".zip" style={{ display: 'none' }} disabled={busy} onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
    </label>
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

