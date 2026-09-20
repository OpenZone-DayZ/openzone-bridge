// The class index as the site holds it: the chosen server's dump from its
// last boot, fetched from the bridge once per server and shared by every
// page that shows a class (the pickers, the checks, the canvases).

import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useServers } from '../../app/servers';
import { parseClassIndexJson, type ClassIndex } from './classIndex.ts';

export type IndexState = { index: ClassIndex | null; server: string; at: string; loading: boolean; error: string };

let state: IndexState = { index: null, server: '', at: '', loading: false, error: '' };
let fetchedFor: string | null = null;
const listeners = new Set<(s: IndexState) => void>();

function publish(next: IndexState) {
  state = next;
  for (const l of listeners) l(state);
}

// The request carries the chosen server (api/client.ts); the bridge answers
// with that server's index, or the last server's to boot when none is
// chosen yet.
export async function fetchClassIndex(): Promise<IndexState> {
  publish({ ...state, loading: true, error: '' });
  const r = await api<{ index: unknown; server: string; at: string }>('research', 'classindex');
  if (!r.ok) {
    publish({ ...state, loading: false, error: r.why });
    return state;
  }
  if (!r.index) {
    publish({ index: null, server: r.server, at: '', loading: false, error: '' });
    return state;
  }
  try {
    publish({ index: parseClassIndexJson(r.index), server: r.server, at: r.at, loading: false, error: '' });
  } catch (e) {
    publish({ index: null, server: r.server, at: r.at, loading: false, error: (e as Error).message });
  }
  return state;
}

export function useClassIndex(): IndexState {
  const { current } = useServers();
  const [s, setS] = useState(state);
  useEffect(() => {
    listeners.add(setS);
    if (fetchedFor !== current) {
      fetchedFor = current;
      fetchClassIndex();
    }
    return () => {
      listeners.delete(setS);
    };
  }, [current]);
  return s;
}
