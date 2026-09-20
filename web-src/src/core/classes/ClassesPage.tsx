// The class page of the server itself: what the core dumped at its last
// start -- every class of the five roots with the parent and the game name
// in both languages, read on the server -- and a live search to try it.
// Nothing to import: a start brings the list, a restart with other mods
// brings another.

import { useMemo, useState } from 'react';
import { useLang } from '../../i18n';
import { Notice, Panel } from '../../ui/bits';
import { Table, type Col } from '../../ui/Table';
import { ROOT_NAMES, searchClasses, type ClassHit } from './classIndex.ts';
import { useClassIndex } from './useClassIndex';

export function ClassesPage() {
  const { s, lang } = useLang();
  const held = useClassIndex();
  const [query, setQuery] = useState('');

  const hits = useMemo<ClassHit[]>(() => (held.index && query.trim() ? searchClasses(held.index, query.trim(), 30, lang) : []), [held.index, query, lang]);

  const cols: Col<ClassHit>[] = [
    { key: 'name', label: s('cls'), mono: true, render: (h) => h.name },
    { key: 'display', label: s('cl_display'), render: (h) => h.display || <span className="faint">—</span> },
    { key: 'root', label: s('cl_root'), mono: true, render: (h) => ROOT_NAMES[h.root] },
  ];

  return (
    <>
      <h1>{s('nav_classes')}</h1>
      <div className="cards">
        <div className="card">
          <span className="label">{s('cl_on_server')}</span>
          <span className="value">{held.loading ? '…' : held.index ? held.index.classes.length : '—'}</span>
          <span className="label">{held.index ? `${held.server} · ${held.at}` : s('cl_server_none')}</span>
        </div>
      </div>
      <p className="muted small">{s('cl_about')}</p>
      {held.error && <Notice tone="bad">{held.error}</Notice>}

      <Panel title={s('cl_search')}>
        <div className="toolbar">
          <input className="grow mono" placeholder={s('cl_search_hint')} value={query} onChange={(e) => setQuery(e.target.value)} disabled={!held.index} />
        </div>
        {held.index ? <Table cols={cols} rows={hits} rowKey={(h) => `${h.root}:${h.name}`} empty={query.trim() ? s('nothing') : s('cl_type')} /> : <p className="muted">{s('cl_server_none')}</p>}
      </Panel>
    </>
  );
}
