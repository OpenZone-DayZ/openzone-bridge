// The admin web (design 2026-09-19, sections 8 and 15): its own listener,
// static files without a build step, and a JSON api that is the very same
// operations the console uses. Loopback always; with Discord sign-in when
// ADMIN_URL gives the page an outside address. Without sign-in nothing but
// the loopback stands between a browser on this machine and the boxes,
// which is why the three guards below are not optional even then:
//
//  - the Host header must name this listener (a page on evil.example whose
//    name resolves to 127.0.0.1 -- DNS rebinding -- arrives with its own
//    name and is refused on that alone);
//  - the api needs a custom header and a JSON body, which any other
//    origin's browser may only send after a preflight nobody answers;
//  - fetch metadata must say same-origin (or nothing, for a hand-typed
//    request); a cross-site or same-site fetch is refused outright.

import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BODY = 1 << 20;
const API = '/admin/v1/';
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/strings.js': ['strings.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
};

// The page has no inline script, no inline style and no outside
// resource, so the strictest policy costs nothing -- and framing is the
// one attack the three request guards do not see: the clicks come from
// the page itself. So the page may not be framed, nor sniffed, nor
// re-based.
const HEADERS = {
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  'referrer-policy': 'no-referrer',
};

export function storageWeb({ ops, dir, allowedHosts = [], auth = null }) {
  const hosts = new Set(allowedHosts.map((h) => String(h).toLowerCase()));
  const server = createServer((req, res) => {
    route(req, res).catch((e) => {
      console.error(`[admin] ${req.url.split('?')[0]}: ${e.stack || e.message}`);
      if (!res.headersSent) json(res, 500, { ok: false, why: 'the bridge failed' });
      else res.end();
    });
  });

  function json(res, code, obj, headers = {}) {
    const s = JSON.stringify(obj);
    res.writeHead(code, {
      ...HEADERS,
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(s),
      'cache-control': 'no-store',
      ...headers,
    });
    res.end(s);
  }

  function redirect(res, to, headers = {}) {
    res.writeHead(302, { ...HEADERS, location: to, 'cache-control': 'no-store', ...headers });
    res.end();
  }

  function text(res, code, s) {
    res.writeHead(code, { ...HEADERS, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(s);
  }

  async function readJson(req) {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) {
        // Past the cap the body is refused either way, so there is nothing
        // left to keep it in memory for -- but the socket is the caller's,
        // not ours to sever: destroying it here raced the 400 answer below
        // against the client seeing a reset connection instead. Draining
        // the rest of the stream costs nothing next to a body this size.
        tooLarge = true;
        continue;
      }
      chunks.push(c);
    }
    if (tooLarge) throw new Error('body too large');
    const raw = Buffer.concat(chunks).toString('utf8');
    let body;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error('body is not json');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('body is not an object');
    return body;
  }

  function guarded(req) {
    const site = String(req.headers['sec-fetch-site'] || 'none');
    const ctype = String(req.headers['content-type'] || '');
    return !!req.headers['x-oz-admin'] && ctype.startsWith('application/json') && (site === 'same-origin' || site === 'none');
  }

  async function route(req, res) {
    const host = String(req.headers.host || '').toLowerCase();
    if (!hosts.has(host)) return json(res, 421, { ok: false, why: 'wrong host' });

    // A reverse proxy in front of a page that has no sign-in would hand
    // every box to the internet with every guard satisfied (the proxy's
    // origin IS the page's origin, and it rewrites Host to ours). A proxy
    // announces itself in these headers; without sign-in that is refused.
    if (!auth && (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers['x-forwarded-proto'] || req.headers.forwarded)) {
      return json(res, 421, { ok: false, why: 'behind a proxy without sign-in: set ADMIN_URL and the Discord sign-in, or reach the page on this machine' });
    }

    const path = req.url.split('?')[0];
    const session = auth ? auth.sessionOf(req.headers.cookie) : null;

    if (auth && path.startsWith('/auth/')) return authRoute(req, res, path);

    if (req.method === 'GET' || req.method === 'HEAD') {
      const file = FILES[path];
      if (!file) return json(res, 404, { ok: false, why: 'no such page' });
      const bytes = readFileSync(join(dir, file[0]));
      res.writeHead(200, { ...HEADERS, 'content-type': file[1], 'content-length': bytes.length, 'cache-control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : bytes);
      return;
    }

    if (req.method !== 'POST' || !path.startsWith(API)) return json(res, 405, { ok: false, why: 'post only' });
    if (!guarded(req)) return json(res, 403, { ok: false, why: 'refused' });

    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      return json(res, 400, { ok: false, why: e.message });
    }

    const op = path.slice(API.length);
    if (!/^[a-z]{1,32}$/.test(op)) return json(res, 404, { ok: false, why: 'unknown op' });
    if (op === 'whoami') {
      return json(res, 200, { ok: true, auth: !!auth, name: session ? session.name : '', userId: session ? session.userId : '' });
    }
    if (auth && !session) return json(res, 401, { ok: false, why: 'sign in first' });

    const fn = Object.prototype.hasOwnProperty.call(ops, op) ? ops[op] : null;
    if (typeof fn !== 'function') return json(res, 404, { ok: false, why: `unknown op: ${op}` });
    // Who signs the event: Discord when there is a sign-in, the page's own
    // word for itself when there is not -- a name for the log, not a proof.
    const admin = auth ? auth.signature(session) : (String(body.admin || '').slice(0, 64) || 'web');
    try {
      return json(res, 200, await fn({ ...body, admin }));
    } catch (e) {
      console.warn(`[admin] ${op}: ${e.message}`);
      return json(res, 200, { ok: false, why: `${op} failed: ${e.message}` });
    }
  }

  async function authRoute(req, res, path) {
    if (path === '/auth/login' && req.method === 'GET') return redirect(res, auth.loginUrl());
    if (path === '/auth/callback' && req.method === 'GET') {
      const q = new URL(req.url, 'http://localhost').searchParams;
      const r = await auth.callback(q.get('code'), q.get('state'));
      if (!r.ok) return text(res, 403, `Sign-in refused: ${r.why}`);
      return redirect(res, auth.home, { 'set-cookie': auth.cookie(r.session) });
    }
    if (path === '/auth/logout' && req.method === 'POST') {
      const site = String(req.headers['sec-fetch-site'] || 'none');
      if (!req.headers['x-oz-admin'] || (site !== 'same-origin' && site !== 'none')) return json(res, 403, { ok: false, why: 'refused' });
      auth.logout(req.headers.cookie);
      return json(res, 200, { ok: true }, { 'set-cookie': auth.clearCookie() });
    }
    return json(res, 404, { ok: false, why: 'no such page' });
  }

  return {
    server,
    // The loopback names with the port actually bound are allowed from here
    // on -- the port is known only now (0 in the tests).
    async listen(port, host = '127.0.0.1') {
      server.listen(port, host);
      await once(server, 'listening');
      const bound = server.address().port;
      for (const h of ['127.0.0.1', 'localhost', '[::1]']) hosts.add(`${h}:${bound}`);
      console.log(`[admin] web on ${host}:${bound}${auth ? ', Discord sign-in' : ', no sign-in: loopback only'}`);
      return bound;
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
