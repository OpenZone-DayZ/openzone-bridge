// A table with columns that know how to render and how to sort. Sorting
// is the page's state, not the server's: the lists are small.

import { useMemo, useState, type ReactNode } from 'react';
import { Empty } from './bits';

export type Col<T> = {
  key: string;
  label: ReactNode;
  render: (row: T) => ReactNode;
  sort?: (row: T) => string | number;
  mono?: boolean;
  num?: boolean;
  title?: string;
};

export function Table<T>({ cols, rows, rowKey, initialSort, pick, empty, onRow }: {
  cols: Col<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  initialSort?: { key: string; desc?: boolean };
  pick?: (row: T) => boolean;
  empty?: ReactNode;
  // A row that answers a click (the table then shows a pointer on it).
  onRow?: (row: T) => void;
}) {
  const [sort, setSort] = useState<{ key: string; desc: boolean } | null>(initialSort ? { key: initialSort.key, desc: !!initialSort.desc } : null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = cols.find((c) => c.key === sort.key);
    if (!col || !col.sort) return rows;
    const by = col.sort;
    const out = [...rows].sort((a, b) => {
      const x = by(a);
      const y = by(b);
      if (typeof x === 'number' && typeof y === 'number') return x - y;
      return String(x).localeCompare(String(y), undefined, { numeric: true });
    });
    return sort.desc ? out.reverse() : out;
  }, [rows, sort, cols]);
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <table className="grid">
      <thead>
        <tr>
          {cols.map((c) => (
            <th
              key={c.key}
              title={c.title}
              className={`${c.sort ? 'sortable' : ''}${c.num ? ' num' : ''}`}
              onClick={c.sort ? () => setSort((s) => (s && s.key === c.key ? { key: c.key, desc: !s.desc } : { key: c.key, desc: false })) : undefined}
            >
              {c.label}
              {sort && sort.key === c.key && <span className="dir">{sort.desc ? '▼' : '▲'}</span>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map((r) => (
          <tr key={rowKey(r)} className={`${pick && pick(r) ? 'pick' : ''}${onRow ? ' clickable' : ''}`} onClick={onRow ? () => onRow(r) : undefined}>
            {cols.map((c) => (
              <td key={c.key} className={`${c.mono ? 'mono' : ''}${c.num ? ' num' : ''}`}>{c.render(r)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
