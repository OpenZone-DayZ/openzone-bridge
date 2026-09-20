// The class index as the site holds it: fetched from the bridge once per
// session, replaced when an import lands, and shared by every page that
// shows a class (the pickers, the checks, the canvases).

import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { parseClassIndexJson, type ClassIndex } from './classIndex.ts';

export type IndexState = { index: ClassIndex | null; at: string; loading: boolean; error: string };

let state: IndexState = { index: null, at: '', loading: false, error: '' };
let started = false;
const listeners = new Set<(s: IndexState) => void>();

function publish(next: IndexState) {
  state = next;
  for (const l of listeners) l(state);
}

export async function fetchClassIndex(): Promise<IndexState> {
  publish({ ...state, loading: true, error: '' });
  const r = await api<{ index: unknown; at: string }>('research', 'classindex');
  if (!r.ok) {
    publish({ ...state, loading: false, error: r.why });
    return state;
  }
  if (!r.index) {
    publish({ index: null, at: '', loading: false, error: '' });
    return state;
  }
  try {
    publish({ index: parseClassIndexJson(r.index), at: r.at, loading: false, error: '' });
  } catch (e) {
    publish({ index: null, at: r.at, loading: false, error: (e as Error).message });
  }
  return state;
}

export function setClassIndex(index: ClassIndex, at: string) {
  publish({ index, at, loading: false, error: '' });
}

export function useClassIndex(): IndexState {
  const [s, setS] = useState(state);
  useEffect(() => {
    listeners.add(setS);
    if (!started) {
      started = true;
      fetchClassIndex();
    }
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return s;
}
