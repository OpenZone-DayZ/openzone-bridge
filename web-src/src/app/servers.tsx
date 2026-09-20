// The game servers the bridge has heard from, and the one the admin is
// looking at. One bridge may serve several stands; the switch shows only
// when it has seen more than one. The choice rides in every request as
// `server` and survives a reload.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, currentServer, setCurrentServer } from '../api/client';

export type ServerInfo = { id: string; at: string };
type Servers = { servers: ServerInfo[]; current: string; choose: (id: string) => void; refresh: () => void };

const ServersContext = createContext<Servers>({ servers: [], current: '', choose: () => {}, refresh: () => {} });

export function ServersProvider({ children }: { children: ReactNode }) {
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [current, setCurrent] = useState(currentServer());
  const refresh = useCallback(() => {
    Promise.all([
      api<{ servers: ServerInfo[] }>('storage', 'servers'),
      api<{ servers: ServerInfo[] }>('research', 'servers'),
    ]).then((answers) => {
      const seen = new Map<string, ServerInfo>();
      for (const a of answers) {
        if (!a.ok) continue;
        for (const s of a.servers) {
          const was = seen.get(s.id);
          if (!was || was.at < s.at) seen.set(s.id, s);
        }
      }
      const list = [...seen.values()].sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));
      setServers(list);
      // Nothing chosen yet, or the choice is gone: the one heard from last.
      if (list.length && !list.some((s) => s.id === currentServer())) {
        setCurrentServer(list[0].id);
        setCurrent(list[0].id);
      }
    });
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  const choose = useCallback((id: string) => {
    setCurrentServer(id);
    setCurrent(id);
  }, []);
  const value = useMemo(() => ({ servers, current, choose, refresh }), [servers, current, choose, refresh]);
  return <ServersContext.Provider value={value}>{children}</ServersContext.Provider>;
}

export function useServers(): Servers {
  return useContext(ServersContext);
}
