// The journal across kinds: every admin action the bridge recorded, from
// storage and research alike, merged by time.

import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useLang } from '../i18n';
import { href } from './router';
import { Badge, Loading, Notice } from '../ui/bits';
import { Table, type Col } from '../ui/Table';

type Line = { key: string; at: string; kind: 'storage' | 'research'; admin: string; action: string; about: string; aboutHref: string; note: string };

export function JournalPage() {
  const { s } = useLang();
  const [lines, setLines] = useState<Line[] | null>(null);
  const [why, setWhy] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    Promise.all([
      api<{ events: { id: number; at: string; kind: string; box_id: string; admin: string; note: string }[] }>('storage', 'journal', { limit: 500 }),
      api<{ events: { id: number; at: string; kind: string; name: string; admin: string; note: string; token: string }[] }>('research', 'events', { limit: 500 }),
    ]).then(([st, re]) => {
      const out: Line[] = [];
      if (st.ok) for (const e of st.events) out.push({ key: `s${e.id}`, at: e.at, kind: 'storage', admin: e.admin, action: e.kind.replace(/^admin_/, ''), about: e.box_id, aboutHref: e.box_id ? href('storage', 'box', e.box_id) : '', note: e.note });
      if (re.ok) for (const e of re.events) out.push({ key: `r${e.id}`, at: e.at, kind: 'research', admin: e.admin, action: e.kind.replace(/^admin_/, ''), about: e.name, aboutHref: e.name ? href('research', 'config', e.name) : '', note: e.note });
      if (!st.ok && !re.ok) setWhy(`${st.why}; ${re.why}`);
      setLines(out);
    });
  }, []);
  const rows = (lines || []).filter((l) => !q.trim() || `${l.admin} ${l.action} ${l.about} ${l.note}`.toLowerCase().includes(q.trim().toLowerCase()));
  const cols: Col<Line>[] = [
    { key: 'when', label: s('when'), mono: true, render: (l) => l.at, sort: (l) => l.at },
    { key: 'kind', label: s('kind'), render: (l) => <Badge tone={l.kind === 'storage' ? 'accent' : 'ok'}>{s(l.kind === 'storage' ? 'kind_storage' : 'kind_research')}</Badge>, sort: (l) => l.kind },
    { key: 'admin', label: s('admin'), render: (l) => l.admin, sort: (l) => l.admin },
    { key: 'action', label: s('actions'), render: (l) => l.action, sort: (l) => l.action },
    { key: 'about', label: s('id'), mono: true, render: (l) => (l.aboutHref ? <a href={l.aboutHref}>{l.about}</a> : l.about) },
    { key: 'note', label: s('note'), render: (l) => l.note },
  ];
  return (
    <>
      <h1>{s('nav_journal_all')}</h1>
      <div className="toolbar"><input className="grow" placeholder={s('filter_journal')} value={q} onChange={(e) => setQ(e.target.value)} /></div>
      {why && <Notice tone="bad">{why}</Notice>}
      {!lines && !why && <Loading />}
      {lines && <Table cols={cols} rows={rows} rowKey={(l) => l.key} initialSort={{ key: 'when', desc: true }} />}
    </>
  );
}
