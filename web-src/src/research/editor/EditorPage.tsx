// The editor of one research config: the rows as a table with a form for
// the chosen row, the tree or the chains on a canvas, the balance, the
// text, the history. A change stays on the page until it is sent as a
// candidate; the game applies it and answers, and the answer lands here.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../../api/client';
import { useLang, type Key } from '../../i18n';
import { useToast } from '../../app/toasts';
import { Badge, Confirm, Loading, Notice, Panel } from '../../ui/bits';
import { Table, type Col } from '../../ui/Table';
import { awaitCommand, type ConfigText, type ConfigVersion } from '../pages';
import { RowForm, type Suggest } from './Fields';
import { balance } from './balance';
import { TreeCanvas } from './TreeCanvas';
import { ChainCanvas } from './ChainCanvas';
import {
  SCHEMA, TREE_BRANCH, RULE_GROUP, blank, idKey, isName, parseText, rowFields, rowsOf, serialize, withRow,
  type ConfigName, type Doc, type Field, type RowRef,
} from './schema';
import { validate, worst, type Problem, type Severity } from './validate';
import { useClassIndex } from '../../core/classes/useClassIndex';

// The other configs an editor reads for its checks and pickers, fetched
// once per page and kept for the session.
const docCache = new Map<string, Promise<Doc | null>>();

function otherDoc(name: ConfigName): Promise<Doc | null> {
  let p = docCache.get(name);
  if (!p) {
    p = api<ConfigText>('research', 'config', { name }).then((r) => (r.ok ? parseText(name, r.text).doc : null));
    docCache.set(name, p);
  }
  return p;
}

const TABLE_COLS: Record<ConfigName, string[]> = {
  ResearchSettings: [],
  ResearchPointTypes: ['Id', 'Name', 'Category', 'Kind', 'Tier', 'SortOrder'],
  ResearchOwners: ['Id', 'TerminalClasses', 'DeviceClasses', 'TreeBackground'],
  ResearchRules: ['Id', 'Enabled', 'Device', 'InputItem', 'Outputs', 'TimeSec', 'RequiredNode'],
  ResearchTree: ['Id', 'Name', 'Tier', 'Parents', 'Cost', 'ResearchTimeSec'],
  ResearchDataItems: ['Id', 'Enabled', 'Name', 'Points'],
  ResearchModules: ['Classname', 'PurityBonus', 'Devices'],
  ResearchSampleTypes: ['Id', 'Enabled', 'Name'],
  ResearchStatics: ['Id', 'ClassName', 'Pos', 'Yaw', 'Note'],
};

const cell = (v: unknown): string => {
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? summarize(x as Doc) : String(x))).join(', ');
  if (v && typeof v === 'object') return summarize(v as Doc);
  if (typeof v === 'boolean') return v ? '✓' : '✗';
  return String(v ?? '');
};
const summarize = (o: Doc): string => {
  const cls = o.Classname ?? o.Type ?? o.Id ?? '';
  const n = o.Quantity ?? o.Amount ?? '';
  const content = o.Content ? ` (${o.Content})` : '';
  return `${cls}${n !== '' && n !== 1 ? ` ×${n}` : ''}${content}`;
};

type Tab = 'table' | 'canvas' | 'balance' | 'text' | 'history';

export function EditorPage({ name }: { name: string }) {
  const { s, lang } = useLang();
  const held = useClassIndex();
  const toast = useToast();
  const [loaded, setLoaded] = useState<{ current: ConfigText; history: ConfigVersion[] } | null>(null);
  const [why, setWhy] = useState('');
  const [doc, setDoc] = useState<Doc | null>(null);
  const [base, setBase] = useState<Doc | null>(null);
  const [shownVersion, setShownVersion] = useState(0);
  const [tab, setTab] = useState<Tab>('table');
  const [selected, setSelected] = useState<number[] | null>(null);
  const [group, setGroup] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [waiting, setWaiting] = useState('');
  const [others, setOthers] = useState<Partial<Record<ConfigName, Doc | null>>>({});
  const [tick, setTick] = useState(0);
  const cfgName = isName(name) ? name : null;

  useEffect(() => {
    if (!cfgName) return;
    let alive = true;
    Promise.all([
      api<ConfigText>('research', 'config', { name: cfgName }),
      api<{ versions: ConfigVersion[] }>('research', 'history', { name: cfgName, limit: 100 }),
    ]).then(([c, h]) => {
      if (!alive) return;
      if (!c.ok) return setWhy(c.why);
      setWhy('');
      setLoaded({ current: c, history: h.ok ? h.versions : [] });
      const parsed = parseText(cfgName, c.text);
      if (parsed.why) toast(s('r_not_json', { why: parsed.why }), true);
      setDoc(parsed.doc);
      setBase(parsed.doc);
      setShownVersion(c.version);
      setText(serialize(cfgName, parsed.doc));
      setSelected(null);
      setGroup(null);
      setTab('table');
    });
    const needed: ConfigName[] = ['ResearchPointTypes', 'ResearchTree', 'ResearchOwners', 'ResearchDataItems', 'ResearchRules'].filter((n) => n !== cfgName) as ConfigName[];
    Promise.all(needed.map((n) => otherDoc(n).then((d) => [n, d] as const))).then((pairs) => {
      if (alive) setOthers(Object.fromEntries(pairs));
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfgName, tick]);

  const reload = () => {
    if (cfgName) docCache.delete(cfgName);
    setTick((t) => t + 1);
  };

  // The context of the checks: this config plus the others.
  const pointTypesDoc = cfgName === 'ResearchPointTypes' ? doc : others.ResearchPointTypes ?? null;
  const treeDoc = cfgName === 'ResearchTree' ? doc : others.ResearchTree ?? null;
  const ownersDoc = cfgName === 'ResearchOwners' ? doc : others.ResearchOwners ?? null;
  // Existence: the server's own classes from its last boot (the index the
  // bridge built out of the dump); null until it arrives.
  const known = useMemo(() => {
    if (!held.index) return null;
    return new Set<string>(held.index.classes.map((row) => row[0]));
  }, [held.index]);
  const ctx = useMemo(() => ({
    classes: known,
    pointTypes: pointTypesDoc ? new Set((pointTypesDoc.PointTypes as Doc[]).map((p) => String(p.Id))) : undefined,
    nodeIds: treeDoc ? new Set((treeDoc.Branches as Doc[]).flatMap((b) => (b.Nodes as Doc[]).map((n) => String(n.Id)))) : undefined,
    owners: ownersDoc ? new Set((ownersDoc.Owners as Doc[]).map((o) => String(o.Id))) : undefined,
  }), [known, pointTypesDoc, treeDoc, ownersDoc]);
  const problems = useMemo(() => (doc && cfgName ? validate(cfgName, doc, ctx) : []), [doc, cfgName, ctx]);
  const suggest = useMemo<Suggest>(() => ({
    classes: known ? [...known] : [],
    pointTypes: ctx.pointTypes ? [...ctx.pointTypes] : [],
    nodeIds: ctx.nodeIds ? [...ctx.nodeIds] : [],
    owners: ctx.owners ? [...ctx.owners] : [],
    devices: ownersDoc ? [...new Set((ownersDoc.Owners as Doc[]).flatMap((o) => [...(o.DeviceClasses as string[]), ...(o.TerminalClasses as string[])]))] : [],
    index: held.index,
    lang,
  }), [ctx, ownersDoc, held.index, lang]);
  const pointNames = useMemo(() => new Map((pointTypesDoc ? (pointTypesDoc.PointTypes as Doc[]) : []).map((p) => [String(p.Id), String(p.Name)])), [pointTypesDoc]);

  const dirty = doc !== null && base !== null && serialize(cfgName || 'ResearchSettings', doc) !== serialize(cfgName || 'ResearchSettings', base);

  const change = useCallback((next: Doc) => {
    setDoc(next);
    if (cfgName) setText(serialize(cfgName, next));
  }, [cfgName]);

  const send = async () => {
    if (!cfgName || !doc) return;
    const sent = await api<{ token: string; version: number; file: string }>('research', 'save', { name: cfgName, json: serialize(cfgName, doc) });
    if (!sent.ok) return toast(`${s('error')}: ${sent.why}`, true);
    setWaiting(s('r_sent', { v: sent.version, token: sent.token }));
    const answer = await awaitCommand(sent.token, 20);
    setWaiting('');
    if (!answer) toast(s('r_answer_wait'), true);
    else if (answer.ok) toast(s('r_answer_ok', { note: answer.answer }));
    else toast(s('r_answer_bad', { why: answer.answer }), true);
    reload();
  };

  if (!cfgName) return <Notice tone="bad">unknown config</Notice>;
  if (why) return <><h1>{name}</h1><Notice tone="bad">{why}</Notice></>;
  if (!loaded || !doc) return <><h1>{name}</h1><Loading /></>;

  const grouped = !!SCHEMA[cfgName].rows.inner;
  const counts = { drop: 0, disable: 0, warn: 0, info: 0 } as Record<Severity, number>;
  for (const p of problems) counts[p.severity]++;
  const problemText = s('e_problem_count', counts);
  const tabs: Tab[] = ['table', ...(cfgName === 'ResearchTree' || cfgName === 'ResearchRules' ? ['canvas' as Tab] : []), ...(cfgName === 'ResearchTree' ? ['balance' as Tab] : []), 'text', 'history'];
  const tabKey: Record<Tab, Key> = { table: 'e_table', canvas: cfgName === 'ResearchRules' ? 'e_chain' : 'e_canvas', balance: 'e_balance', text: 'e_text', history: 'e_history' };

  return (
    <>
      <h1>{name.replace(/^Research/, '')} <span className="muted small">{name}</span></h1>
      <Panel tight>
        <div className="row">
          <span>{s('version')} <b>{shownVersion}</b></span>
          {shownVersion !== loaded.current.version && <Badge tone="alert">{s('e_view_version', { v: shownVersion })}</Badge>}
          {dirty && <Badge tone="alert">{s('e_dirty')}</Badge>}
          <span className={counts.drop ? 'bad' : counts.disable ? 'alert' : counts.warn ? 'muted' : 'ok'}>{problems.length ? problemText : s('e_no_problems')}</span>
          {!known && <span className="muted small">{s('e_loading_classes')}</span>}
          {known && known.size === 0 && <span className="muted small">{s('e_no_classes')}</span>}
          <span className="grow" />
          {dirty && <button type="button" className="ghost" onClick={() => { setDoc(base); setText(serialize(cfgName, base!)); }}>{s('e_discard')}</button>}
          <Confirm primary disabled={!dirty && shownVersion === loaded.current.version} label={s('e_send')}
            question={problems.length ? s('e_c_send', { name: cfgName, problems: problemText }) : s('e_c_send_clean', { name: cfgName })} onConfirm={send} />
        </div>
      </Panel>
      {waiting && <Notice>{waiting}</Notice>}
      <nav className="tabs">
        {tabs.map((t) => <button key={t} type="button" className={`small ${tab === t ? 'primary' : 'ghost'}`} onClick={() => setTab(t)}>{s(tabKey[t])}</button>)}
      </nav>

      {tab === 'table' && (cfgName === 'ResearchSettings'
        ? <SettingsForm doc={doc} onChange={change} suggest={suggest} problems={problems} />
        : <TableTab name={cfgName} doc={doc} onChange={change} suggest={suggest} problems={problems} selected={selected} setSelected={setSelected} group={group} setGroup={setGroup} grouped={grouped} />)}

      {tab === 'canvas' && cfgName === 'ResearchTree' && (
        <TreeTab doc={doc} onChange={change} selected={selected} setSelected={(p) => { setSelected(p); setGroup(p[0]); }} problems={problems} pointNames={pointNames} group={group ?? 0} setGroup={setGroup} />
      )}
      {tab === 'canvas' && cfgName === 'ResearchRules' && (
        <ChainCanvas doc={doc} selected={selected} onSelect={(p) => { setSelected(p); setGroup(p[0]); setTab('table'); }} index={held.index} lang={lang} />
      )}
      {tab === 'balance' && <BalanceTab tree={doc} others={others} pointTypes={pointTypesDoc} />}

      {tab === 'text' && (
        <>
          <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} style={{ width: '100%', minHeight: 420 }} />
          <div className="row" style={{ marginTop: 8 }}>
            <button type="button" onClick={() => {
              const parsed = parseText(cfgName, text);
              if (parsed.why) return toast(s('r_not_json', { why: parsed.why }), true);
              change(parsed.doc);
            }}>{s('e_apply_text')}</button>
          </div>
        </>
      )}

      {tab === 'history' && (
        <HistoryTab name={cfgName} history={loaded.history} shown={shownVersion} onView={async (v) => {
          const c = await api<ConfigText>('research', 'config', { name: cfgName, version: v });
          if (!c.ok) return toast(`${s('error')}: ${c.why}`, true);
          const parsed = parseText(cfgName, c.text);
          setShownVersion(v);
          change(parsed.doc);
          setTab('table');
        }} onRestore={async (v) => {
          const sent = await api<{ token: string; version: number; file: string }>('research', 'restore', { name: cfgName, version: v });
          if (!sent.ok) return toast(`${s('error')}: ${sent.why}`, true);
          setWaiting(s('r_sent', { v: sent.version, token: sent.token }));
          const answer = await awaitCommand(sent.token, 20);
          setWaiting('');
          if (!answer) toast(s('r_answer_wait'), true);
          else if (answer.ok) toast(s('r_answer_ok', { note: answer.answer }));
          else toast(s('r_answer_bad', { why: answer.answer }), true);
          reload();
        }} />
      )}

      <ProblemsPanel problems={problems} onPick={(path) => {
        const m = /\[(\d+)\](?:\.\w+\[(\d+)\])?/.exec(path);
        if (!m) return;
        const p = grouped && m[2] !== undefined ? [Number(m[1]), Number(m[2])] : [Number(m[1])];
        if (grouped) setGroup(p[0]);
        setSelected(p);
        setTab('table');
      }} />
    </>
  );
}

function SettingsForm({ doc, onChange, suggest, problems }: { doc: Doc; onChange: (d: Doc) => void; suggest: Suggest; problems: Problem[] }) {
  const { s } = useLang();
  const fields = SCHEMA.ResearchSettings.fields.filter((f) => f.key !== 'Version');
  return (
    <Panel>
      <RowForm fields={fields} row={doc} onChange={(row) => onChange({ ...doc, ...row })} suggest={suggest} title={s('nav_configs')} />
      {problems.length === 0 && <p className="muted small">{s('e_no_problems')}</p>}
    </Panel>
  );
}

function TableTab({ name, doc, onChange, suggest, problems, selected, setSelected, group, setGroup, grouped }: {
  name: ConfigName; doc: Doc; onChange: (d: Doc) => void; suggest: Suggest; problems: Problem[];
  selected: number[] | null; setSelected: (p: number[] | null) => void; group: number | null; setGroup: (g: number | null) => void; grouped: boolean;
}) {
  const { s } = useLang();
  const schema = SCHEMA[name];
  const fields = rowFields(name);
  const all = rowsOf(name, doc);
  const rows = grouped && group !== null ? all.filter((r) => r.path[0] === group) : all;
  const outer = (doc[schema.rows.key] as Doc[]) || [];
  const problemAt = (path: number[]) => problems.filter((p) => p.path.startsWith(pathPrefix(name, path)));
  const cols: Col<RowRef>[] = [
    ...(grouped && group === null ? [{ key: 'group', label: s(name === 'ResearchTree' ? 'e_branch' : 'e_group'), mono: true, render: (r: RowRef) => String(r.group?.Id ?? ''), sort: (r: RowRef) => String(r.group?.Id ?? '') }] : []),
    ...TABLE_COLS[name].map((key): Col<RowRef> => ({ key, label: key, mono: key === idKey(name) || key === 'Classname' || key === 'ClassName' || key === 'Device', render: (r) => cell(r.row[key]), sort: (r) => cell(r.row[key]) })),
    { key: 'problems', label: '!', render: (r) => { const ps = problemAt(r.path); const w = worst(ps); return w ? <Badge tone={w === 'drop' || w === 'disable' ? 'bad' : w === 'warn' ? 'alert' : 'muted'}>{ps.length}</Badge> : null; } },
  ];
  const selectedRow = selected ? all.find((r) => r.path.join(':') === selected.join(':')) : undefined;
  const addRow = () => {
    const path = grouped ? [group ?? 0, Number.MAX_SAFE_INTEGER] : [Number.MAX_SAFE_INTEGER];
    if (grouped && !outer.length) return;
    const row = blank(fields);
    row[idKey(name)] = `${s('e_new')}_${all.length + 1}`;
    const next = withRow(name, doc, path, row);
    onChange(next);
    const added = rowsOf(name, next);
    setSelected(added[added.length - (grouped ? 1 : 1)].path);
    if (grouped) setSelected(rowsOf(name, next).filter((r) => r.path[0] === (group ?? 0)).at(-1)!.path);
  };
  const outerFields = (schema.fields.find((f) => f.key === schema.rows.key)?.of || []).filter((f) => f.key !== schema.rows.inner);
  const addGroup = () => {
    const g = blank(name === 'ResearchTree' ? TREE_BRANCH : RULE_GROUP);
    g.Id = `${s('e_new')}_${outer.length + 1}`;
    const next = structuredClone(doc);
    (next[schema.rows.key] as Doc[]).push(g);
    onChange(next);
    setGroup(outer.length);
  };
  const setOuter = (idx: number, patch: Doc) => {
    const next = structuredClone(doc);
    (next[schema.rows.key] as Doc[])[idx] = { ...(next[schema.rows.key] as Doc[])[idx], ...patch };
    onChange(next);
  };
  const deleteGroup = (idx: number) => {
    const next = structuredClone(doc);
    (next[schema.rows.key] as Doc[]).splice(idx, 1);
    onChange(next);
    setGroup(null);
    setSelected(null);
  };
  return (
    <div className="editor">
      <div className="editor-main">
        {grouped && (
          <div className="toolbar">
            <button type="button" className={`small ${group === null ? 'primary' : 'ghost'}`} onClick={() => setGroup(null)}>{s('e_all_groups')}</button>
            {outer.map((g, i) => <button key={i} type="button" className={`small ${group === i ? 'primary' : 'ghost'} mono`} onClick={() => setGroup(i)}>{String(g.Id)}</button>)}
            <button type="button" className="small" onClick={addGroup}>+ {s(name === 'ResearchTree' ? 'e_add_branch' : 'e_add_group')}</button>
          </div>
        )}
        {grouped && group !== null && outer[group] && (
          <Panel tight>
            <RowForm fields={outerFields} row={outer[group]} onChange={(row) => setOuter(group, row)} suggest={suggest} title={`${s(name === 'ResearchTree' ? 'e_branch' : 'e_group')} ${String(outer[group].Id)}`}
              onDelete={((outer[group][schema.rows.inner as string] as unknown[]) || []).length === 0 ? () => deleteGroup(group) : undefined} />
          </Panel>
        )}
        <div className="toolbar">
          <span className="muted small">{rows.length} {s('e_row').toLowerCase()}</span>
          <span className="grow" />
          <button type="button" className="small" onClick={addRow} disabled={grouped && group === null}>+ {s('e_add_row')}</button>
        </div>
        <Table cols={cols} rows={rows} rowKey={(r) => r.path.join(':')} pick={(r) => !!selected && r.path.join(':') === selected.join(':')} onRow={(r) => setSelected(r.path)} />
        <p className="muted small">{s('e_pick_row')}</p>
      </div>
      <aside className="editor-side">
        {selectedRow ? (
          <>
            <RowForm fields={fields} row={selectedRow.row} onChange={(row) => onChange(withRow(name, doc, selectedRow.path, row))} suggest={suggest}
              title={<span className="mono">{String(selectedRow.row[idKey(name)])}</span>}
              onDelete={() => { onChange(withRow(name, doc, selectedRow.path, null)); setSelected(null); }} />
            {problemAt(selectedRow.path).map((p, i) => <div key={i} className={`notice ${p.severity === 'drop' || p.severity === 'disable' ? 'bad' : p.severity === 'warn' ? 'alert' : ''}`}>{p.message}</div>)}
          </>
        ) : <p className="muted">{s('e_pick_row')}</p>}
      </aside>
    </div>
  );
}

// The prefix a problem's path starts with for a row: Groups[0].Rules[3] or Owners[2].
function pathPrefix(name: ConfigName, path: number[]): string {
  const { rows } = SCHEMA[name];
  if (!rows.inner) return `${rows.key}[${path[0]}]`;
  return `${rows.key}[${path[0]}].${rows.inner}[${path[1]}]`;
}

// Bring a selected row's table row into view when it changes.
export function useScrollTo(selected: number[] | null) {
  useEffect(() => {
    if (!selected) return;
    document.querySelector('tr.pick')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
}

function TreeTab({ doc, onChange, selected, setSelected, problems, pointNames, group, setGroup }: {
  doc: Doc; onChange: (d: Doc) => void; selected: number[] | null; setSelected: (p: number[]) => void; problems: Problem[];
  pointNames: Map<string, string>; group: number; setGroup: (g: number) => void;
}) {
  const { s } = useLang();
  const toast = useToast();
  const branches = (doc.Branches as Doc[]) || [];
  const problemsOf = useCallback((b: number, n: number) => problems.filter((p) => p.path.startsWith(`Branches[${b}].Nodes[${n}]`) || p.path === `node:${String((branches[b]?.Nodes as Doc[])?.[n]?.Id ?? '')}`).length, [problems, branches]);
  const node = (path: number[]): Doc => (branches[path[0]].Nodes as Doc[])[path[1]];
  const patchNode = (path: number[], patch: Doc) => onChange(withRow('ResearchTree', doc, path, { ...node(path), ...patch }));
  if (!branches.length) return <Notice>{s('e_no_branches')}</Notice>;
  const idx = Math.min(group, branches.length - 1);
  return (
    <>
      <div className="toolbar">
        {branches.map((b, i) => <button key={i} type="button" className={`small ${idx === i ? 'primary' : 'ghost'} mono`} onClick={() => setGroup(i)}>{String(b.Name || b.Id)}</button>)}
        <span className="muted small">{s('e_canvas_help')}</span>
      </div>
      <TreeCanvas
        doc={doc}
        branchIdx={idx}
        selected={selected}
        problemsOf={problemsOf}
        pointNames={pointNames}
        onSelect={setSelected}
        onSetTier={(path, tier) => patchNode(path, { Tier: tier })}
        onAddParent={(path, parentId) => patchNode(path, { Parents: [...(node(path).Parents as string[]), parentId] })}
        onRemoveParent={(path, parentId) => patchNode(path, { Parents: (node(path).Parents as string[]).filter((p) => p !== parentId) })}
        onAddNode={(b, tier) => {
          const fields = rowFields('ResearchTree');
          const row = blank(fields);
          row.Id = `${s('e_new')}_${rowsOf('ResearchTree', doc).length + 1}`;
          row.Name = row.Id;
          row.Tier = tier;
          const next = withRow('ResearchTree', doc, [b, Number.MAX_SAFE_INTEGER], row);
          onChange(next);
          setSelected([b, (next.Branches as Doc[])[b].Nodes ? ((next.Branches as Doc[])[b].Nodes as Doc[]).length - 1 : 0]);
        }}
        onRefuse={(why) => toast(why, true)}
      />
      {selected && branches[selected[0]] && (branches[selected[0]].Nodes as Doc[])[selected[1]] && (
        <Panel tight>
          <RowForm fields={rowFields('ResearchTree')} row={node(selected)} onChange={(row) => onChange(withRow('ResearchTree', doc, selected, row))} suggest={{ classes: [], pointTypes: [...pointNames.keys()], nodeIds: rowsOf('ResearchTree', doc).map((r) => String(r.row.Id)), owners: [], devices: [], index: null, lang: 'uk' }}
            title={<span className="mono">{String(node(selected).Id)}</span>} onDelete={() => onChange(withRow('ResearchTree', doc, selected, null))} />
        </Panel>
      )}
    </>
  );
}

function BalanceTab({ tree, others, pointTypes }: { tree: Doc; others: Partial<Record<ConfigName, Doc | null>>; pointTypes: Doc | null }) {
  const { s } = useLang();
  const rows = useMemo(() => balance(tree, others.ResearchDataItems ?? null, others.ResearchRules ?? null, pointTypes), [tree, others, pointTypes]);
  const owners = [...new Set(rows.flatMap((r) => [...r.spentBy.keys()]))].sort();
  return (
    <Table
      cols={[
        { key: 'type', label: s('r_point_type'), mono: true, render: (r) => r.type, sort: (r) => r.type },
        { key: 'name', label: s('nav_configs'), render: (r) => r.name },
        { key: 'data', label: s('e_from_data'), num: true, render: (r) => r.fromData, sort: (r) => r.fromData },
        { key: 'rules', label: s('e_from_rules'), num: true, render: (r) => r.fromRules, sort: (r) => r.fromRules },
        { key: 'spent', label: s('e_spent'), num: true, render: (r) => <span className={r.spent > r.fromData + r.fromRules ? 'alert' : ''}>{r.spent}</span>, sort: (r) => r.spent },
        { key: 'nodes', label: s('r_node'), num: true, render: (r) => r.nodes },
        ...owners.map((o): Col<ReturnType<typeof balance>[number]> => ({ key: `o:${o}`, label: o === '*' ? s('e_any_owner') : o, num: true, render: (r) => r.spentBy.get(o) || '' })),
      ]}
      rows={rows}
      rowKey={(r) => r.type}
    />
  );
}

function HistoryTab({ name, history, shown, onView, onRestore }: { name: string; history: ConfigVersion[]; shown: number; onView: (v: number) => void; onRestore: (v: number) => void }) {
  const { s } = useLang();
  const tone = (st: string) => (st === 'pending' ? 'alert' : st === 'rejected' ? 'bad' : 'ok');
  const label = (st: string): Key => (st === 'pending' ? 'r_pending' : st === 'rejected' ? 'r_rejected' : 'r_applied');
  return (
    <Table
      cols={[
        { key: 'version', label: s('version'), num: true, render: (v) => v.version, sort: (v) => v.version },
        { key: 'status', label: s('status'), render: (v) => <Badge tone={tone(v.status)}>{s(label(v.status))}</Badge> },
        { key: 'at', label: s('when'), mono: true, render: (v) => v.at, sort: (v) => v.at },
        { key: 'by', label: s('who'), render: (v) => v.by },
        { key: 'source', label: s('source'), render: (v) => v.source },
        { key: 'why', label: s('note'), render: (v) => v.why },
        { key: 'actions', label: s('actions'), render: (v) => (
          <span className="row">
            <button type="button" className="small ghost" onClick={() => onView(v.version)}>{s('r_view')}</button>
            {v.status !== 'pending' && <Confirm small warn label={s('r_restore')} question={s('r_c_restore', { v: v.version, name })} onConfirm={() => onRestore(v.version)} />}
          </span>
        ) },
      ]}
      rows={history}
      rowKey={(v) => String(v.version)}
      initialSort={{ key: 'version', desc: true }}
      pick={(v) => v.version === shown}
    />
  );
}

function ProblemsPanel({ problems, onPick }: { problems: Problem[]; onPick: (path: string) => void }) {
  const { s } = useLang();
  const [open, setOpen] = useState(false);
  if (!problems.length) return null;
  const sevKey: Record<Severity, Key> = { drop: 'e_sev_drop', disable: 'e_sev_disable', warn: 'e_sev_warn', info: 'e_sev_info' };
  const body: ReactNode = open ? (
    <ul className="problems">
      {problems.map((p, i) => (
        <li key={i} className={p.severity === 'drop' || p.severity === 'disable' ? 'bad' : p.severity === 'warn' ? 'alert' : 'muted'}>
          <a href="#" onClick={(e) => { e.preventDefault(); onPick(p.path); }}><code>{p.path}</code></a> <span className="small">{s(sevKey[p.severity])}:</span> {p.message}
        </li>
      ))}
    </ul>
  ) : null;
  return (
    <Panel tight title={`${s('e_problems')} (${problems.length})`} actions={<button type="button" className="small ghost" onClick={() => setOpen((o) => !o)}>{open ? '▴' : '▾'}</button>}>
      {body}
    </Panel>
  );
}

export function fieldLabel(f: Field): string {
  return f.key;
}
