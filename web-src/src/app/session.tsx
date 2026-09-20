// Who the admin is: Discord when the bridge has sign-in on, a typed name
// for the log when it does not. Asked once at start; the answer also says
// which kinds the bridge serves.

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { myName, setMyName, whoami, type Kind } from '../api/client';

export type Session = {
  ready: boolean;
  auth: boolean;
  name: string;
  userId: string;
  kinds: Kind[];
  typedName: string;
  setTypedName: (name: string) => void;
};

const SessionContext = createContext<Session>({
  ready: false, auth: false, name: '', userId: '', kinds: [], typedName: 'web', setTypedName: () => {},
});

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState({ ready: false, auth: false, name: '', userId: '', kinds: [] as Kind[] });
  const [typedName, setTyped] = useState(myName());
  useEffect(() => {
    let alive = true;
    whoami().then((w) => {
      if (!alive) return;
      if (w.ok) setState({ ready: true, auth: w.auth, name: w.name || '', userId: w.userId || '', kinds: w.kinds || ['storage', 'research'] });
      else setState({ ready: true, auth: false, name: '', userId: '', kinds: ['storage', 'research'] });
    });
    return () => {
      alive = false;
    };
  }, []);
  const setTypedName = (name: string) => {
    setMyName(name);
    setTyped(myName());
  };
  return <SessionContext.Provider value={{ ...state, typedName, setTypedName }}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  return useContext(SessionContext);
}
