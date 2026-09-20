// The game servers the bridge has heard from, and the one the admin is
// looking at. One bridge may serve several stands; the switch shows only
// when it has seen more than one. The choice rides in every request as
// `server` and survives a reload.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, currentServer, setCurrentServer } from '../api/client';

// `since`: when the server last started (its Fresh poll); `kinds`: when each
// kind booted on it since then. A kind missing here is a mod the server
// does not run, and the site blocks its section.
export type ServerInfo = { id: string; at: string; since?: string; kinds?: Record<string, string> };
type Servers = { servers: ServerInfo[]; current: string; choose: (id: string) => void; refresh: () => void; blocked: (kind: string) => ServerInfo | null };

const ServersContext = createContext<Servers>({ servers: [], current: '', choose: () => {}, refresh: () => {}, blocked: () => null });

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
  // A kind is blocked when the chosen server started (the bridge saw its
  // Fresh poll), that kind never booted since, and the server had half a
  // minute to do so: a mod that is not loaded never boots.
  const blocked = useCallback((kind: string): ServerInfo | null => {
    const srv = servers.find((s) => s.id === current);
    if (!srv || !srv.since) return null;
    if (srv.kinds && srv.kinds[kind]) return null;
    if (Date.now() - Date.parse(srv.since) < 30000) return null;
    return srv;
  }, [servers, current]);
  useEffect(() => {
    const t = setInterval(refresh, 30000);
    return () => clearInterval(t);
  }, [refresh]);
  const value = useMemo(() => ({ servers, current, choose, refresh, blocked }), [servers, current, choose, refresh, blocked]);
  return <ServersContext.Provider value={value}>{children}</ServersContext.Provider>;
}

export function useServers(): Servers {
  return useContext(ServersContext);
}
