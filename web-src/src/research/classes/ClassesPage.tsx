// The class index page: what the bridge holds (how many classes, from
// which mods, since when), the server's own class list from its last boot,
// a live search to try it, and the importer -- the game's folder and the
// mods' folders read in the browser, headers and configs only, the result
// sent to the bridge for everyone.

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { api } from '../../api/client';
import { useLang } from '../../i18n';
import { useToast } from '../../app/toasts';
import { Badge, Confirm, Loading, Notice, Panel } from '../../ui/bits';
import { Table, type Col } from '../../ui/Table';
import { dirFromFileList, importClassIndex, type ImportProgress, type ImportResult } from './classImport.ts';
import type { DirLike } from './classImportCore.ts';
import { searchClasses, type ClassHit } from './classIndex.ts';
import { fetchClassIndex, setClassIndex, useClassIndex } from './useClassIndex';

type SourceDir = { label: string; value: FileSystemDirectoryHandle | DirLike };

export function ClassesPage() {
  const { s, lang } = useLang();
  const toast = useToast();
  const held = useClassIndex();
  const [live, setLive] = useState<{ count: number; at: string } | null>(null);
  const [bridge, setBridge] = useState<{ pboDirs: string[]; classBuild: { running: boolean; at: string; classes: number; mods: number; ms: number; why: string } } | null>(null);
  const [building, setBuilding] = useState(false);
  const [dirs, setDirs] = useState<SourceDir[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const fsAccess = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

  const loadStatus = () => api<{ pboDirs: string[]; classBuild: { running: boolean; at: string; classes: number; mods: number; ms: number; why: string } }>('research', 'status').then((r) => setBridge(r.ok ? { pboDirs: r.pboDirs || [], classBuild: r.classBuild || { running: false, at: '', classes: 0, mods: 0, ms: 0, why: '' } } : null));
  useEffect(() => {
    api<{ count: number; at: string }>('research', 'classes').then((r) => setLive(r.ok ? { count: r.count, at: r.at } : { count: 0, at: '' }));
    loadStatus();
  }, []);

  async function rebuild() {
    setBuilding(true);
    try {
      const r = await api<{ classes: number; mods: number; ms: number }>('research', 'classindexbuild');
      if (!r.ok) return toast(`${s('error')}: ${r.why}`, true);
      toast(s('cl_built', { n: r.classes, m: r.mods, sec: (r.ms / 1000).toFixed(1) }));
      await fetchClassIndex();
      loadStatus();
    } finally {
      setBuilding(false);
    }
  }

  const hits = useMemo<ClassHit[]>(() => (held.index && query.trim() ? searchClasses(held.index, query.trim(), 30, lang) : []), [held.index, query, lang]);

  async function addFolder() {
    setError('');
    try {
      const handle = await showDirectoryPicker({ id: 'oz-classimport', mode: 'read' });
      setDirs((prev) => [...prev, { label: handle.name, value: handle }]);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setError((e as Error).message);
    }
  }

  function addFolderCompat(e: ChangeEvent<HTMLInputElement>) {
    const files = e.target.files ? [...e.target.files] : [];
    e.target.value = '';
    if (!files.length) return;
    const dir = dirFromFileList(files);
    if (!dir) {
      setError(s('cl_no_paths'));
      return;
    }
    setDirs((prev) => [...prev, { label: dir.name, value: dir }]);
  }

  async function start() {
    if (!dirs.length || running) return;
    setError('');
    setResult(null);
    setRunning(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await importClassIndex(dirs.map((d) => d.value), (p) => setProgress(p), ctrl.signal);
      setResult(res);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') toast(s('cl_cancelled'));
      else setError((e as Error).message);
    } finally {
      setRunning(false);
      setProgress(null);
      abortRef.current = null;
    }
  }

  async function save() {
    if (!result) return;
    const r = await api<{ classes: number; mods: number }>('research', 'classindexput', { index: result.raw });
    if (!r.ok) return toast(`${s('error')}: ${r.why}`, true);
    setClassIndex(result.index, new Date().toISOString().slice(0, 19).replace('T', ' '));
    toast(s('cl_saved', { n: r.classes, m: r.mods }));
  }

  const stats = result?.stats;
  const cols: Col<ClassHit>[] = [
    { key: 'name', label: s('cls'), mono: true, render: (h) => h.name },
    { key: 'display', label: s('cl_display'), render: (h) => h.display || <span className="faint">—</span> },
    { key: 'mod', label: s('cl_mod'), render: (h) => h.mod },
    { key: 'root', label: s('cl_root'), mono: true, render: (h) => ['CfgVehicles', 'CfgMagazines', 'CfgNonAIVehicles', 'CfgAmmo', 'cfgWeapons'][h.root] },
  ];

  return (
    <>
      <h1>{s('nav_classes')}</h1>
      <div className="cards">
        <div className="card">
          <span className="label">{s('cl_on_bridge')}</span>
          <span className="value">{held.loading ? '…' : held.index ? held.index.classes.length : '—'}</span>
          <span className="label">{held.index ? `${held.index.mods.length} ${s('cl_mods')} · ${held.index.generated} · ${held.at}` : s('cl_none')}</span>
        </div>
        <div className="card">
          <span className="label">{s('cl_on_server')}</span>
          <span className="value">{live ? live.count || '—' : '…'}</span>
          <span className="label">{live && live.at ? live.at : s('cl_server_none')}</span>
        </div>
      </div>
      {held.error && <Notice tone="bad">{held.error}</Notice>}
      {bridge && bridge.pboDirs.length > 0 && (
        <Panel tight>
          <div className="row">
            <span className="muted small">{s('cl_on_bridge_build', { n: bridge.pboDirs.length })}: <span className="mono">{bridge.pboDirs.join('; ')}</span></span>
            {bridge.classBuild.at && <span className="muted small">· {s('cl_last_build')} {bridge.classBuild.at}, {bridge.classBuild.classes} / {bridge.classBuild.mods}, {(bridge.classBuild.ms / 1000).toFixed(1)} s</span>}
            {bridge.classBuild.why && <span className="bad small">{bridge.classBuild.why}</span>}
            <span className="grow" />
            {building || bridge.classBuild.running ? <span className="muted small">{s('cl_building')}</span> : <Confirm label={s('cl_rebuild')} question={s('cl_c_rebuild')} onConfirm={rebuild} />}
          </div>
        </Panel>
      )}

      <Panel title={s('cl_search')}>
        <div className="toolbar">
          <input className="grow mono" placeholder={s('cl_search_hint')} value={query} onChange={(e) => setQuery(e.target.value)} disabled={!held.index} />
        </div>
        {held.index ? <Table cols={cols} rows={hits} rowKey={(h) => `${h.root}:${h.name}`} empty={query.trim() ? s('nothing') : s('cl_type')} /> : <p className="muted">{s('cl_none')}</p>}
      </Panel>

      <Panel title={s('cl_import')}>
        <p className="muted small">{s('cl_import_help')}</p>
        <div className="toolbar">
          {fsAccess && <button type="button" onClick={() => void addFolder()} disabled={running}>{s('cl_add_folder')}</button>}
          <label className="button">
            {s('cl_add_folder_compat')}
            <input type="file" style={{ display: 'none' }} onChange={addFolderCompat} disabled={running} {...({ webkitdirectory: '' } as Record<string, string>)} />
          </label>
          <button type="button" className="primary" onClick={() => void start()} disabled={running || !dirs.length}>{s('cl_start')}</button>
          {running && <button type="button" className="warn" onClick={() => abortRef.current?.abort()}>{s('cl_cancel')}</button>}
        </div>
        {dirs.length > 0 && (
          <ul className="small">
            {dirs.map((d, i) => (
              <li key={`${d.label}-${i}`} className="row">
                <code>{d.label}</code>
                <button type="button" className="small ghost" onClick={() => setDirs((prev) => prev.filter((_, j) => j !== i))} disabled={running}>×</button>
              </li>
            ))}
          </ul>
        )}
        {running && progress && (
          <div className="row">
            <progress value={progress.total > 0 ? progress.done : undefined} max={progress.total > 0 ? progress.total : undefined} />
            <span className="muted small">
              {progress.phase === 'scan' && s('cl_scanning')}
              {progress.phase === 'parse' && `${progress.done}/${progress.total} PBO — ${progress.label}`}
              {progress.phase === 'finalize' && s('cl_finalizing')}
              {progress.cacheHits > 0 && ` (${s('cl_cached')}: ${progress.cacheHits})`}
            </span>
          </div>
        )}
        {running && !progress && <Loading />}
        {error && <Notice tone="bad">{error}</Notice>}
        {stats && result && (
          <>
            <Notice tone={stats.pboFailed > 0 ? 'alert' : 'ok'}>
              {s('cl_report', { sec: (stats.durationMs / 1000).toFixed(1), classes: stats.classes, mods: stats.mods, ok: stats.pboOk, none: stats.pboNoConfig, failed: stats.pboFailed, cached: stats.cacheHits, total: stats.pboTotal, workers: stats.usedWorkers })}
            </Notice>
            {result.skipped.length > 0 && (
              <details>
                <summary className="muted small">{s('cl_skipped')} ({result.skipped.length})</summary>
                <ul className="small">{result.skipped.map((x, i) => <li key={i}><code>{x.source}</code>: {x.reason}</li>)}</ul>
              </details>
            )}
            {stats.failedDetails.length > 0 && (
              <details>
                <summary className="muted small">{s('cl_failed')} ({stats.failedDetails.length})</summary>
                <ul className="small">{stats.failedDetails.map((x, i) => <li key={i}><code>{x.source}</code>: {x.reason}</li>)}</ul>
              </details>
            )}
            <div className="row">
              <Confirm primary label={s('cl_save')} question={s('cl_c_save', { n: stats.classes })} onConfirm={save} />
              <Badge tone="muted">v{result.raw.v} · {result.raw.generated}</Badge>
            </div>
          </>
        )}
      </Panel>
    </>
  );
}
