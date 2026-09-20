// Form controls driven by the schema: a field knows its kind, the control
// follows. Class names get suggestions from the server's class list;
// point types, node ids and owners from the other configs.

import { useMemo, useState, type ReactNode } from 'react';
import { useLang } from '../../i18n';
import { Confirm } from '../../ui/bits';
import { blank, type Doc, type Field } from './schema';
import { searchClasses, type ClassIndex, type Lang } from '../classes/classIndex';

export type Suggest = {
  classes: string[];
  pointTypes: string[];
  nodeIds: string[];
  owners: string[];
  devices: string[];
  // The class index, when the bridge holds one: live search with game names.
  index: ClassIndex | null;
  lang: Lang;
};

const CLASS_KEYS = new Set(['Classname', 'ClassName', 'Device', 'TerminalClasses', 'DeviceClasses', 'RequiredWorn', 'RequiredTools', 'Devices']);
const TYPE_KEYS = new Set(['Type']);
const NODE_KEYS = new Set(['RequiredNode', 'Parents']);
const OWNER_KEYS = new Set(['Owners', 'RequiredFactions', 'DefaultOwner']);

const isClassKey = (key: string): boolean => CLASS_KEYS.has(key);

function suggestionsFor(key: string, suggest: Suggest): string[] {
  if (CLASS_KEYS.has(key)) return key === 'Device' || key === 'Devices' || key === 'DeviceClasses' ? [...new Set([...suggest.devices, ...suggest.classes])] : suggest.classes;
  if (TYPE_KEYS.has(key)) return suggest.pointTypes;
  if (NODE_KEYS.has(key)) return suggest.nodeIds;
  if (OWNER_KEYS.has(key)) return suggest.owners;
  return [];
}

// An input with a short list of matches under it: the class list holds
// eleven thousand names, so a datalist would be a wall.
type Match = { value: string; note: string };

export function SuggestInput({ value, onChange, options, mono = true, size, index, lang }: { value: string; onChange: (v: string) => void; options: string[]; mono?: boolean; size?: number; index?: ClassIndex | null; lang?: Lang }) {
  const [open, setOpen] = useState(false);
  const needle = value.trim().toLowerCase();
  const matches = useMemo<Match[]>(() => {
    if (!open) return [];
    // The class index answers by class name and by game name, live; a plain
    // list answers by prefix, then by substring.
    if (index) {
      const bare = needle.replace(/\|.*$/, '');
      if (bare === '') return [];
      return searchClasses(index, bare, 14, lang || 'uk').filter((h) => h.name !== value).map((h) => ({ value: h.name, note: h.display && h.display !== h.name ? h.display : '' }));
    }
    if (!options.length) return [];
    const starts = options.filter((o) => o.toLowerCase().startsWith(needle));
    const holds = needle.length >= 2 ? options.filter((o) => !o.toLowerCase().startsWith(needle) && o.toLowerCase().includes(needle)) : [];
    return [...starts, ...holds].filter((o) => o !== value).slice(0, 12).map((o) => ({ value: o, note: '' }));
  }, [open, options, needle, value, index, lang]);
  return (
    <span className="suggest">
      <input className={mono ? 'mono' : ''} value={value} size={size} onChange={(e) => onChange(e.target.value)} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} />
      {matches.length > 0 && (
        <span className="suggest-list">
          {matches.map((m) => (
            <span key={m.value} className="suggest-item" onMouseDown={(e) => { e.preventDefault(); onChange(m.value); setOpen(false); }}>
              <span className="mono">{m.value}</span>{m.note && <span className="muted"> · {m.note}</span>}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

export function FieldEditor({ field, value, onChange, suggest, label }: { field: Field; value: unknown; onChange: (v: unknown) => void; suggest: Suggest; label?: ReactNode }) {
  const { s } = useLang();
  const options = suggestionsFor(field.key, suggest);
  const head = <span className="k">{label ?? field.key}</span>;
  switch (field.kind) {
    case 'string':
      if (field.options) {
        return (
          <label className="field">{head}
            <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
              {field.options.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </label>
        );
      }
      if (field.long) return <label className="field wide">{head}<textarea value={String(value ?? '')} rows={3} onChange={(e) => onChange(e.target.value)} /></label>;
      return <label className="field">{head}<SuggestInput value={String(value ?? '')} onChange={onChange} options={options} mono={options.length > 0 || field.key === 'Id'} index={isClassKey(field.key) ? suggest.index : null} lang={suggest.lang} /></label>;
    case 'int':
      return <label className="field">{head}<input type="number" step={1} value={Number(value ?? 0)} onChange={(e) => onChange(e.target.value === '' ? 0 : Math.trunc(Number(e.target.value)))} /></label>;
    case 'float':
      return <label className="field">{head}<input type="number" step="any" value={Number(value ?? 0)} onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))} /></label>;
    case 'bool':
      return <label className="field check-field">{head}<input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} /></label>;
    case 'strings':
      return <StringsEditor head={head} values={Array.isArray(value) ? (value as string[]) : []} onChange={onChange} options={options} addLabel={s('e_add')} index={isClassKey(field.key) ? suggest.index : null} lang={suggest.lang} />;
    case 'numbers':
      return (
        <label className="field">{head}
          <input className="mono" value={(Array.isArray(value) ? (value as number[]) : []).join(' ')} onChange={(e) => onChange(e.target.value.split(/[\s,;]+/).filter(Boolean).map(Number).filter((n) => Number.isFinite(n)))} />
        </label>
      );
    case 'object':
      return (
        <fieldset className="sub">
          <legend>{field.key}</legend>
          <div className="fields">
            {(field.of || []).map((f) => (
              <FieldEditor key={f.key} field={f} value={(value as Doc | undefined)?.[f.key]} onChange={(v) => onChange({ ...(value as Doc), [f.key]: v })} suggest={suggest} />
            ))}
          </div>
        </fieldset>
      );
    case 'list':
      return <SubTable field={field} rows={Array.isArray(value) ? (value as Doc[]) : []} onChange={onChange} suggest={suggest} />;
  }
}

function StringsEditor({ head, values, onChange, options, addLabel, index, lang }: { head: ReactNode; values: string[]; onChange: (v: string[]) => void; options: string[]; addLabel: string; index: ClassIndex | null; lang: Lang }) {
  const set = (i: number, v: string) => onChange(values.map((x, j) => (j === i ? v : x)));
  return (
    <div className="field wide">
      {head}
      <div className="strings">
        {values.map((v, i) => (
          <span key={i} className="row">
            <SuggestInput value={v} onChange={(x) => set(i, x)} options={options} size={28} index={index} lang={lang} />
            <button type="button" className="small ghost" onClick={() => onChange(values.filter((_, j) => j !== i))}>×</button>
          </span>
        ))}
        <button type="button" className="small" onClick={() => onChange([...values, ''])}>+ {addLabel}</button>
      </div>
    </div>
  );
}

function SubTable({ field, rows, onChange, suggest }: { field: Field; rows: Doc[]; onChange: (v: Doc[]) => void; suggest: Suggest }) {
  const { s } = useLang();
  const cols = field.of || [];
  const set = (i: number, key: string, v: unknown) => onChange(rows.map((r, j) => (j === i ? { ...r, [key]: v } : r)));
  return (
    <div className="field wide">
      <span className="k">{field.key}</span>
      <table className="grid sub">
        {rows.length > 0 && (
          <thead><tr>{cols.map((c) => <th key={c.key}>{c.key}</th>)}<th /></tr></thead>
        )}
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c.key}>
                  {c.kind === 'bool' ? <input type="checkbox" checked={!!r[c.key]} onChange={(e) => set(i, c.key, e.target.checked)} />
                    : c.kind === 'int' || c.kind === 'float' ? <input type="number" step={c.kind === 'int' ? 1 : 'any'} value={Number(r[c.key] ?? 0)} size={6} onChange={(e) => set(i, c.key, e.target.value === '' ? 0 : c.kind === 'int' ? Math.trunc(Number(e.target.value)) : Number(e.target.value))} />
                      : <SuggestInput value={String(r[c.key] ?? '')} onChange={(v) => set(i, c.key, v)} options={suggestionsFor(c.key, suggest)} size={16} index={isClassKey(c.key) ? suggest.index : null} lang={suggest.lang} />}
                </td>
              ))}
              <td><button type="button" className="small ghost" onClick={() => onChange(rows.filter((_, j) => j !== i))}>×</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="small" onClick={() => onChange([...rows, blank(cols)])}>+ {s('e_add')}</button>
    </div>
  );
}

// The whole form of one row: every field of the row's schema, in order.
export function RowForm({ fields, row, onChange, suggest, onDelete, title }: { fields: Field[]; row: Doc; onChange: (row: Doc) => void; suggest: Suggest; onDelete?: () => void; title: ReactNode }) {
  const { s } = useLang();
  return (
    <div className="rowform">
      <div className="head">
        <h2>{title}</h2>
        {onDelete && <Confirm small danger label={s('e_delete_row')} question={s('e_c_delete')} onConfirm={onDelete} />}
      </div>
      <div className="fields">
        {fields.map((f) => <FieldEditor key={f.key} field={f} value={row[f.key]} onChange={(v) => onChange({ ...row, [f.key]: v })} suggest={suggest} />)}
      </div>
    </div>
  );
}
