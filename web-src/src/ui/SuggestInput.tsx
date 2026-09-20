// A text input with suggestions under it: from the class index of the
// chosen server (by class name and by game name, live) when one is given,
// else from a plain list by prefix, then by substring. Shared by every
// form of the site that takes a class name.

import { useMemo, useState } from 'react';
import { searchClasses, type ClassIndex, type Lang } from '../core/classes/classIndex';

type Match = { value: string; note: string };

export function SuggestInput({ value, onChange, options, mono = true, size, index, lang }: { value: string; onChange: (v: string) => void; options: string[]; mono?: boolean; size?: number; index?: ClassIndex | null; lang?: Lang }) {
  const [open, setOpen] = useState(false);
  const needle = value.trim().toLowerCase();
  const matches = useMemo<Match[]>(() => {
    if (!open) return [];
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
