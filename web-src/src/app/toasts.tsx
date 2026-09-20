// Toasts: a short line at the bottom of the screen that goes away on its
// own. A refusal stays a little longer and is coloured as one.

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export type Toast = { id: number; text: string; bad: boolean };
type Push = (text: string, bad?: boolean) => void;

const ToastContext = createContext<Push>(() => {});

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback<Push>((text, bad = false) => {
    const id = nextId++;
    setToasts((xs) => [...xs, { id, text, bad }]);
    setTimeout(() => setToasts((xs) => xs.filter((t) => t.id !== id)), bad ? 12000 : 7000);
  }, []);
  const value = useMemo(() => push, [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.bad ? ' bad' : ''}`} onClick={() => setToasts((xs) => xs.filter((x) => x.id !== t.id))}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): Push {
  return useContext(ToastContext);
}
