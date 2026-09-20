// A hash router: #/<kind>/<page>/<arg>. The hash is the whole state of
// the page, so a reload and a shared link land where the admin was.

import { useEffect, useState } from 'react';
import type { Kind } from '../api/client';

export type Route = { kind: Kind | 'all'; page: string; arg: string };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/');
  const first = parts[0] || 'storage';
  if (first === 'journal') return { kind: 'all', page: 'journal', arg: '' };
  const kind: Kind = first === 'research' ? 'research' : first === 'core' ? 'core' : 'storage';
  const page = parts[1] || (kind === 'storage' ? 'boxes' : kind === 'core' ? 'classes' : 'configs');
  let arg = parts.slice(2).join('/');
  try {
    arg = decodeURIComponent(arg);
  } catch {
    // a hand-typed address with a stray percent sign is used as typed
  }
  return { kind, page, arg };
}

export function href(kind: Kind | 'all', page: string, arg = ''): string {
  if (kind === 'all') return `#/${page}`;
  return arg === '' ? `#/${kind}/${page}` : `#/${kind}/${page}/${encodeURIComponent(arg)}`;
}

export function go(kind: Kind | 'all', page: string, arg = ''): void {
  location.hash = href(kind, page, arg);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
