// The JSON client of the bridge's admin api: POST admin/v1/<kind>/<op>
// with the custom header the listener demands, relative to the page so a
// reverse proxy may serve it under any prefix. Every refusal comes back as
// { ok: false, why }; nothing here throws.

export type Kind = 'storage' | 'research' | 'core';

export type Refusal = { ok: false; why: string };
export type Answer<T> = ({ ok: true } & T) | Refusal;

export type Whoami = { auth: boolean; name: string; userId: string; kinds: Kind[] };

const remembered = (key: string, dflt: string): string => {
  try {
    return localStorage.getItem(key) || dflt;
  } catch {
    return dflt;
  }
};

export const remember = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // a page without storage still works
  }
};

let adminName = remembered('oz_name', 'web');
let serverId = remembered('oz_server', '');

export function myName(): string {
  return adminName;
}

export function setMyName(name: string): void {
  adminName = name.trim().slice(0, 64) || 'web';
  remember('oz_name', adminName);
}

export function currentServer(): string {
  return serverId;
}

export function setCurrentServer(id: string): void {
  serverId = id;
  remember('oz_server', id);
}

export const SIGN_IN_FIRST = 'sign in first';

async function post<T>(path: string, body: Record<string, unknown>): Promise<Answer<T>> {
  let r: Response;
  try {
    r = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-oz-admin': '1' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, why: (e as Error).message };
  }
  let out: Answer<T>;
  try {
    out = (await r.json()) as Answer<T>;
  } catch {
    out = { ok: false, why: `${r.status}` };
  }
  if (r.status === 401) out = { ok: false, why: SIGN_IN_FIRST };
  return out;
}

export function api<T>(kind: Kind, op: string, body: Record<string, unknown> = {}): Promise<Answer<T>> {
  return post<T>(`admin/v1/${kind}/${op}`, { ...body, admin: adminName, server: serverId });
}

export function whoami(): Promise<Answer<Whoami>> {
  return post<Whoami>('admin/v1/whoami', {});
}

export async function logout(): Promise<void> {
  try {
    await fetch('auth/logout', { method: 'POST', headers: { 'x-oz-admin': '1' } });
  } finally {
    location.reload();
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The game's answer to a live command: asked once a second until it is
// there or the patience runs out. `tick` hears every attempt, so a page
// can show that it is still waiting.
export async function awaitResult<T>(
  ask: () => Promise<Answer<{ result: T | null }>>,
  seconds = 12,
  tick?: (n: number) => void,
): Promise<T | null> {
  for (let i = 0; i < seconds; i++) {
    await pause(1000);
    tick?.(i + 1);
    const r = await ask();
    if (r.ok && r.result) return r.result;
  }
  return null;
}
