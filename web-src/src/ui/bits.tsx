// Small pieces every page uses: a panel with a head, a badge, a health
// bar, a labelled field, a notice, an empty line, a confirmation that
// happens IN PLACE on a second press -- never a window.confirm.

import { useEffect, useState, type ReactNode } from 'react';
import { useLang } from '../i18n';

export function Panel({ title, actions, tight, children }: { title?: ReactNode; actions?: ReactNode; tight?: boolean; children: ReactNode }) {
  return (
    <section className={`panel${tight ? ' tight' : ''}`}>
      {(title || actions) && (
        <div className="head">
          {title && <h2>{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export type Tone = 'ok' | 'bad' | 'alert' | 'accent' | 'muted';

export function Badge({ tone = 'muted', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

// Health as the game keeps it: 0..100 for most items, -1 for "the class
// default" (a gift the game has not placed yet).
export function HealthBar({ value }: { value: number }) {
  if (value < 0) return <span className="faint small">—</span>;
  const pct = Math.max(0, Math.min(100, value));
  const cls = pct <= 0 ? 'dead' : pct < 35 ? 'low' : '';
  return (
    <span className={`bar ${cls}`} title={String(Math.round(value * 100) / 100)}>
      <i style={{ width: `${pct}%` }} />
    </span>
  );
}

export function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Notice({ tone = 'accent', children }: { tone?: Tone | 'accent'; children: ReactNode }) {
  return <div className={`notice ${tone === 'accent' ? '' : tone}`}>{children}</div>;
}

export function Empty({ children }: { children?: ReactNode }) {
  const { s } = useLang();
  return <div className="empty">{children ?? s('nothing')}</div>;
}

export function Loading() {
  const { s } = useLang();
  return <div className="empty">{s('loading')}</div>;
}

// The second press is the confirmation: the first turns the button into
// the question with a yes and a no beside it. Nothing modal, nothing that
// steals the page. `busy` while the action runs.
export function Confirm({
  label, question, onConfirm, danger, warn, small, disabled, primary,
}: {
  label: ReactNode;
  question: ReactNode;
  onConfirm: () => Promise<unknown> | unknown;
  danger?: boolean;
  warn?: boolean;
  small?: boolean;
  disabled?: boolean;
  primary?: boolean;
}) {
  const { s } = useLang();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!asking) return;
    const t = setTimeout(() => setAsking(false), 15000);
    return () => clearTimeout(t);
  }, [asking]);
  const cls = `${danger ? 'danger' : warn ? 'warn' : primary ? 'primary' : ''}${small ? ' small' : ''}`;
  if (!asking) {
    return (
      <button type="button" className={cls} disabled={disabled || busy} onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  }
  return (
    <span className="confirm">
      <span className="q">{question}</span>
      <button
        type="button"
        className={`${danger ? 'danger' : 'primary'}${small ? ' small' : ''}`}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onConfirm();
          } finally {
            setBusy(false);
            setAsking(false);
          }
        }}
      >
        {s('yes')}
      </button>
      <button type="button" className={`ghost${small ? ' small' : ''}`} disabled={busy} onClick={() => setAsking(false)}>
        {s('no')}
      </button>
    </span>
  );
}
