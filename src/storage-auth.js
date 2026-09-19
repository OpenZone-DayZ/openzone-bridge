// Discord sign-in for the admin web (design 2026-09-19, section 15). An
// option: on only when DISCORD_CLIENT_SECRET is set. The browser is sent
// to Discord with a one-time state; Discord sends it back with a code; the
// bridge trades the code for a token, asks Discord who that is and which
// roles they hold in the guild, and admits a holder of one of the admin
// roles for twelve hours. The user's token serves those two calls and is
// forgotten: the bridge keeps a session id, a name and an expiry, nothing
// of Discord's. Sessions live in memory, so a restart signs everyone out.
//
// Everything that reaches Discord goes through the `fetch` given, so the
// tests hand in a fake one and never touch discord.com.

import { randomBytes } from 'node:crypto';

const API = 'https://discord.com/api/v10';
const STATE_TTL = 10 * 60 * 1000;
const SESSION_TTL = 12 * 60 * 60 * 1000;
const COOKIE = 'oz_admin';

export function storageAuth({ clientId, clientSecret, guildId, roleIds, adminUrl, fetch = globalThis.fetch, now = Date.now }) {
  const base = String(adminUrl || '').replace(/\/+$/, '');
  const redirect = `${base}/auth/callback`;
  const secure = /^https:/i.test(base);
  const home = (() => {
    try {
      const p = new URL(base).pathname;
      return p.endsWith('/') ? p : `${p}/`;
    } catch {
      return '/';
    }
  })();
  const roles = new Set((roleIds || []).map(String).filter(Boolean));
  const states = new Map();
  const sessions = new Map();

  const sweep = () => {
    const t = now();
    for (const [k, v] of states) if (v < t) states.delete(k);
    for (const [k, v] of sessions) if (v.until < t) sessions.delete(k);
  };

  async function asUser(path, token) {
    const r = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`discord ${path}: ${r.status}`);
    return r.json();
  }

  function sessionOf(cookieHeader) {
    sweep();
    const m = /(?:^|;\s*)oz_admin=([0-9a-f]{64})(?:;|$)/.exec(String(cookieHeader || ''));
    if (!m) return null;
    return sessions.get(m[1]) || null;
  }

  return {
    redirect,
    home,

    loginUrl() {
      sweep();
      const state = randomBytes(16).toString('hex');
      states.set(state, now() + STATE_TTL);
      const q = new URLSearchParams({
        client_id: String(clientId),
        response_type: 'code',
        redirect_uri: redirect,
        scope: 'identify guilds.members.read',
        state,
      });
      return `https://discord.com/oauth2/authorize?${q}`;
    },

    // The way back from Discord: a session to set as a cookie, or a refusal
    // in words the page may show. Never the token, never the secret.
    async callback(code, state) {
      sweep();
      if (!state || !states.has(state)) return { ok: false, why: 'the sign-in expired; try again' };
      states.delete(state);
      if (!code) return { ok: false, why: 'Discord sent no code' };
      let traded;
      try {
        traded = await fetch(`${API}/oauth2/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: String(clientId),
            client_secret: String(clientSecret),
            grant_type: 'authorization_code',
            code: String(code),
            redirect_uri: redirect,
          }).toString(),
        });
      } catch (e) {
        return { ok: false, why: `Discord did not answer: ${e.message}` };
      }
      if (!traded.ok) return { ok: false, why: `Discord refused the code (${traded.status})` };
      const token = (await traded.json()).access_token;
      if (!token) return { ok: false, why: 'Discord sent no token' };
      let user;
      let member;
      try {
        user = await asUser('/users/@me', token);
        member = await asUser(`/users/@me/guilds/${guildId}/member`, token);
      } catch (e) {
        return { ok: false, why: e.message.includes('/member') ? 'you are not in the guild' : e.message };
      }
      const held = Array.isArray(member.roles) ? member.roles.map(String) : [];
      if (!held.some((r) => roles.has(r))) return { ok: false, why: 'not an admin' };
      const name = String(member.nick || user.global_name || user.username || user.id);
      const id = randomBytes(32).toString('hex');
      sessions.set(id, { id, userId: String(user.id), name, until: now() + SESSION_TTL });
      return { ok: true, session: id, name, userId: String(user.id) };
    },

    sessionOf,

    logout(cookieHeader) {
      const s = sessionOf(cookieHeader);
      if (s) sessions.delete(s.id);
      return !!s;
    },

    cookie(session) {
      return `${COOKIE}=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}${secure ? '; Secure' : ''}`;
    },

    clearCookie() {
      return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
    },

    // What events are signed with: the name and the Discord id, so a renamed
    // admin is still the same person in the history.
    signature(session) {
      return `${session.name} (${session.userId})`;
    },
  };
}
