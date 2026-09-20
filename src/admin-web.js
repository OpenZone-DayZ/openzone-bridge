// The admin web (design 2026-09-19, sections 8 and 15; 2026-09-20, section
// 7): its own listener, the built site from web/dist, and a JSON api that
// is the very same operations the console uses, one door per kind:
// POST /admin/v1/<kind>/<op>. Loopback always; with Discord sign-in when
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
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, posix, resolve, sep } from 'node:path';

const MAX_BODY = 1 << 20;
const API = '/admin/v1/';
const KIND = /^[a-z]{1,16}$/;
const OP = /^[a-z]{1,32}$/;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

// The page has no inline script, no inline style and no outside
// resource, so the strictest policy costs nothing -- and framing is the
// one attack the three request guards do not see: the clicks come from
// the page itself. So the page may not be framed, nor sniffed, nor
// re-based. Vite's build emits styles as a stylesheet and scripts as
// modules, so 'self' covers them; the map image is served from here too.
const HEADERS = {
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  'referrer-policy': 'no-referrer',
};

const STUB = `<!doctype html><html><head><meta charset="utf-8"><title>OpenZone Admin</title>
<style>body{margin:0;background:#0e1318;color:#e6edf2;font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;height:100vh}
main{max-width:36em;padding:2em;background:#1a222b;border:1px solid #384d61;border-radius:6px}code{color:#4fb5e8}</style></head>
<body><main><h1>The admin site is not built</h1><p>The bridge is running, but <code>web/dist</code> is missing.
Run <code>npm run build</code> in the bridge directory and reload this page. During development,
<code>npm run dev</code> serves the site from source with a proxy to this bridge.</p></main></body></html>`;

// Where the request's path lands inside the site directory, or null when
// it points outside it (or at nothing). Decoded, then normalised as a
// POSIX path, then resolved against the directory and checked to still be
// under it; a lone '..' anywhere is refused before any of that.
export function fileUnder(dir, urlPath) {
  let p;
  try {
    p = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (p.includes('\0') || p.split('/').includes('..')) return null;
  p = posix.normalize(p);
  if (!p.startsWith('/')) return null;
  if (p === '/') p = '/index.html';
  const root = resolve(dir);
  const full = resolve(root, `.${p}`);
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

export function adminWeb({ kinds, dir, allowedHosts = [], auth = null, mapImage = '' }) {
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

  function text(res, code, s, type = 'text/plain; charset=utf-8') {
    res.writeHead(code, { ...HEADERS, 'content-type': type, 'cache-control': 'no-store' });
    res.end(s);
  }

  function file(req, res, full, cache) {
    let bytes;
    try {
      if (!statSync(full).isFile()) return json(res, 404, { ok: false, why: 'no such page' });
      bytes = readFileSync(full);
    } catch {
      return json(res, 404, { ok: false, why: 'no such page' });
    }
    const ext = full.slice(full.lastIndexOf('.')).toLowerCase();
    const type = TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { ...HEADERS, 'content-type': type, 'content-length': bytes.length, 'cache-control': cache });
    res.end(req.method === 'HEAD' ? undefined : bytes);
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
      if (path === '/admin/map.png') {
        if (!mapImage || !existsSync(mapImage)) return json(res, 404, { ok: false, why: 'no map image' });
        return file(req, res, mapImage, 'no-cache');
      }
      if (path.startsWith(API)) return json(res, 404, { ok: false, why: 'no such page' });
      const full = fileUnder(dir, path);
      if (!full) return json(res, 404, { ok: false, why: 'no such page' });
      if (full === join(resolve(dir), 'index.html') && !existsSync(full)) return text(res, 200, STUB, 'text/html; charset=utf-8');
      // The build names its assets by content hash, so they may be kept
      // for good; the page itself must be asked for every time.
      const cache = path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
      return file(req, res, full, cache);
    }

    if (req.method !== 'POST' || !path.startsWith(API)) return json(res, 405, { ok: false, why: 'post only' });
    if (!guarded(req)) return json(res, 403, { ok: false, why: 'refused' });

    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      return json(res, 400, { ok: false, why: e.message });
    }

    const parts = path.slice(API.length).split('/');
    if (parts.length === 1 && parts[0] === 'whoami') {
      return json(res, 200, { ok: true, auth: !!auth, name: session ? session.name : '', userId: session ? session.userId : '', kinds: Object.keys(kinds) });
    }
    if (parts.length !== 2 || !KIND.test(parts[0]) || !OP.test(parts[1])) return json(res, 404, { ok: false, why: 'unknown op' });
    const [kind, op] = parts;
    if (auth && !session) return json(res, 401, { ok: false, why: 'sign in first' });

    const ops = Object.prototype.hasOwnProperty.call(kinds, kind) ? kinds[kind] : null;
    if (!ops) return json(res, 404, { ok: false, why: `unknown kind: ${kind}` });
    const fn = Object.prototype.hasOwnProperty.call(ops, op) ? ops[op] : null;
    if (typeof fn !== 'function') return json(res, 404, { ok: false, why: `unknown op: ${op}` });
    // Who signs the event: Discord when there is a sign-in, the page's own
    // word for itself when there is not -- a name for the log, not a proof.
    const admin = auth ? auth.signature(session) : (String(body.admin || '').slice(0, 64) || 'web');
    try {
      return json(res, 200, await fn({ ...body, admin }));
    } catch (e) {
      console.warn(`[admin] ${kind}/${op}: ${e.message}`);
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
      const built = existsSync(join(dir, 'index.html')) ? '' : ', site not built (npm run build)';
      console.log(`[admin] web on ${host}:${bound}${auth ? ', Discord sign-in' : ', no sign-in: loopback only'}${built}`);
      return bound;
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
