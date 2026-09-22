// The admin web listener (design 2026-09-19, sections 8 and 15; 2026-09-20,
// section 7): the built site from a directory, one door per kind, the
// guards that stand even without sign-in, and the sign-in routes over a
// fake auth. Real sockets on 127.0.0.1, throwaway directories.

import { request } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adminWeb, fileUnder } from '../src/admin-web.js';

let pass = 0;
let fail = 0;
function ok(what, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass++;
    console.log(`  ok   ${what}`);
    return;
  }
  fail++;
  console.log(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
}

// A request with any headers at all, including Host, which fetch would not let us set.
function raw(port, method, path, headers = {}, body = '') {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const api = (port, kind, op, body = {}, headers = {}) => raw(port, 'POST', `/admin/v1/${kind}/${op}`, { 'content-type': 'application/json', 'x-oz-admin': '1', ...headers }, JSON.stringify(body));
const parse = (r) => JSON.parse(r.body);

const dir = mkdtempSync(join(tmpdir(), 'oz-admin-web-'));
mkdirSync(join(dir, 'assets'));
writeFileSync(join(dir, 'index.html'), '<!doctype html><title>t</title>');
writeFileSync(join(dir, 'assets', 'app-abc123.js'), '// js');
writeFileSync(join(dir, 'assets', 'app-abc123.css'), '/* css */');
writeFileSync(join(dir, 'map.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
const empty = mkdtempSync(join(tmpdir(), 'oz-admin-web-empty-'));

const seen = [];
const kinds = {
  storage: {
    boxes: (arg) => { seen.push(arg); return { ok: true, boxes: [] }; },
    boom: () => { throw new Error('kaboom'); },
    slow: async () => ({ ok: true, waited: true }),
  },
  research: {
    configs: (arg) => { seen.push({ research: arg }); return { ok: true, configs: [] }; },
  },
};

console.log('web: where a path lands');
ok('the root is the page', fileUnder(dir, '/'), join(dir, 'index.html'));
ok('a file under assets', fileUnder(dir, '/assets/app-abc123.js'), join(dir, 'assets', 'app-abc123.js'));
ok('a dotted path is refused', [fileUnder(dir, '/../package.json'), fileUnder(dir, '/assets/../../package.json'), fileUnder(dir, '/assets/..%2F..%2Fpackage.json')], [null, null, null]);
ok('a path that does not start at the root is refused', fileUnder(dir, 'assets/app.js'), null);
ok('a nul byte is refused', fileUnder(dir, '/a%00.js'), null);
ok('a bad escape is refused, not thrown', fileUnder(dir, '/%E0%A4%A'), null);

console.log('web: the built site');
const web = adminWeb({ kinds, dir, allowedHosts: ['admin.example'], mapImage: join(dir, 'map.png'), maxBody: 1 << 20 });
const port = await web.listen(0);
const home = await raw(port, 'GET', '/');
ok('the page is served', [home.status, home.headers['content-type'], home.body], [200, 'text/html; charset=utf-8', '<!doctype html><title>t</title>']);
ok('the page is served under its name too', (await raw(port, 'GET', '/index.html')).status, 200);
ok('the page is never cached stale', home.headers['cache-control'], 'no-cache');
const asset = await raw(port, 'GET', '/assets/app-abc123.js');
ok('a hashed asset is served with its type and kept for good', [asset.status, asset.headers['content-type'], asset.headers['cache-control']], [200, 'text/javascript; charset=utf-8', 'public, max-age=31536000, immutable']);
ok('a stylesheet too', (await raw(port, 'GET', '/assets/app-abc123.css')).headers['content-type'], 'text/css; charset=utf-8');
ok('the page cannot be framed, sniffed or re-based', [home.headers['x-frame-options'], home.headers['content-security-policy'].includes("frame-ancestors 'none'"), home.headers['x-content-type-options']], ['DENY', true, 'nosniff']);
ok('nothing outside the directory is served', [(await raw(port, 'GET', '/../package.json')).status, (await raw(port, 'GET', '/assets/../../package.json')).status, (await raw(port, 'GET', '/nope.js')).status], [404, 404, 404]);
ok('a directory is no page', (await raw(port, 'GET', '/assets')).status, 404);
ok('a query string does not change the file', (await raw(port, 'GET', '/index.html?v=1')).status, 200);
ok('a GET on the api is no page', (await raw(port, 'GET', '/admin/v1/storage/boxes')).status, 404);
const map = await raw(port, 'GET', '/admin/map.png');
ok('the map image is served when configured', [map.status, map.headers['content-type']], [200, 'image/png']);
ok('HEAD answers without a body', (await raw(port, 'HEAD', '/')).body, '');

console.log('web: the api without sign-in');
const r1 = await api(port, 'storage', 'boxes', { id: 'x' });
ok('an op answers what the op answers, as json, uncached', [r1.status, parse(r1), r1.headers['cache-control']], [200, { ok: true, boxes: [] }, 'no-store']);
ok('the op saw the body and the admin the page named itself', seen.at(-1), { id: 'x', admin: 'web' });
ok('the other kind has its own door', [parse(await api(port, 'research', 'configs', { a: 1 })).ok, seen.at(-1).research.a], [true, 1]);
await api(port, 'storage', 'boxes', { admin: 'Owner' });
ok('a name given is used', seen.at(-1).admin, 'Owner');
await api(port, 'storage', 'boxes', { admin: 'x'.repeat(100) });
ok('and clipped to 64', seen.at(-1).admin.length, 64);
ok('an async op is awaited', parse(await api(port, 'storage', 'slow')), { ok: true, waited: true });
ok('an unknown op is a 404 in words', [(await api(port, 'storage', 'nope')).status, parse(await api(port, 'storage', 'nope')).why], [404, 'unknown op: nope']);
ok('an unknown kind is a 404 in words', [(await api(port, 'chat', 'boxes')).status, parse(await api(port, 'chat', 'boxes')).why], [404, 'unknown kind: chat']);
ok('the old door without a kind is gone', (await raw(port, 'POST', '/admin/v1/boxes', { 'content-type': 'application/json', 'x-oz-admin': '1' }, '{}')).status, 404);
ok('an op off the prototype is unknown too', (await api(port, 'storage', 'toString')).status, 404);
const dotted = await raw(port, 'POST', '/admin/v1/storage/../x', { 'content-type': 'application/json', 'x-oz-admin': '1' }, '{}');
ok('a malformed op is refused before its name is reflected', [dotted.status, parse(dotted).why], [404, 'unknown op']);
ok('an op that throws is refused in words', parse(await api(port, 'storage', 'boom')), { ok: false, why: 'boom failed: kaboom' });
ok('whoami without sign-in says so and names the kinds', parse(await raw(port, 'POST', '/admin/v1/whoami', { 'content-type': 'application/json', 'x-oz-admin': '1' }, '{}')), { ok: true, auth: false, name: '', userId: '', kinds: ['storage', 'research'] });
ok('a body that is not json is a 400', (await raw(port, 'POST', '/admin/v1/storage/boxes', { 'content-type': 'application/json', 'x-oz-admin': '1' }, '{oops')).status, 400);
ok('a body that is not an object is a 400', (await raw(port, 'POST', '/admin/v1/storage/boxes', { 'content-type': 'application/json', 'x-oz-admin': '1' }, '[1]')).status, 400);
const bigBody = '{"a":"' + 'x'.repeat(1 << 20) + '"}';
const overflow = await raw(port, 'POST', '/admin/v1/storage/boxes', { 'content-type': 'application/json', 'x-oz-admin': '1' }, bigBody);
ok('a body past the cap is refused, and the listener still answers after', [overflow.status, parse(overflow).why, (await api(port, 'storage', 'boxes')).status], [400, 'body too large', 200]);
ok('a POST off the api is post only', (await raw(port, 'POST', '/index.html', { 'content-type': 'application/json', 'x-oz-admin': '1' }, '{}')).status, 405);

console.log('web: the guards');
ok('without the custom header the call is refused', (await raw(port, 'POST', '/admin/v1/storage/boxes', { 'content-type': 'application/json' }, '{}')).status, 403);
ok('without json the call is refused', (await raw(port, 'POST', '/admin/v1/storage/boxes', { 'content-type': 'text/plain', 'x-oz-admin': '1' }, '{}')).status, 403);
ok('a cross-site call is refused', (await api(port, 'storage', 'boxes', {}, { 'sec-fetch-site': 'cross-site' })).status, 403);
ok('a same-site call from another subdomain is refused', (await api(port, 'storage', 'boxes', {}, { 'sec-fetch-site': 'same-site' })).status, 403);
ok('a same-origin call passes', (await api(port, 'storage', 'boxes', {}, { 'sec-fetch-site': 'same-origin' })).status, 200);
ok('a call typed in by hand passes', (await api(port, 'storage', 'boxes', {}, { 'sec-fetch-site': 'none' })).status, 200);
ok('a wrong host is refused before anything else', [(await api(port, 'storage', 'boxes', {}, { host: 'evil.example' })).status, (await raw(port, 'GET', '/', { host: 'evil.example' })).status], [421, 421]);
ok('the loopback names with the port pass', [(await raw(port, 'GET', '/', { host: `localhost:${port}` })).status, (await raw(port, 'GET', '/', { host: `[::1]:${port}` })).status], [200, 200]);
ok('the loopback name without the port does not', (await raw(port, 'GET', '/', { host: '127.0.0.1' })).status, 421);
ok('the host of the admin url passes, whatever its case', [(await raw(port, 'GET', '/', { host: 'admin.example' })).status, (await raw(port, 'GET', '/', { host: 'Admin.Example' })).status], [200, 200]);
ok('a sign-in route without sign-in is no page', (await raw(port, 'GET', '/auth/login')).status, 404);
ok('a forwarded request is refused while sign-in is off', [(await raw(port, 'GET', '/', { 'x-forwarded-for': '1.2.3.4' })).status, (await raw(port, 'GET', '/', { 'x-forwarded-host': 'evil.example' })).status, (await raw(port, 'GET', '/', { 'x-forwarded-proto': 'https' })).status, (await raw(port, 'GET', '/', { forwarded: 'for=1.2.3.4' })).status], [421, 421, 421, 421]);
await web.close();

console.log('web: no build yet');
{
  const stub = adminWeb({ kinds, dir: empty, allowedHosts: [] });
  const p = await stub.listen(0);
  const page = await raw(p, 'GET', '/');
  ok('the page says how to build the site', [page.status, page.body.includes('npm run build')], [200, true]);
  ok('the api still works', parse(await api(p, 'storage', 'boxes')).ok, true);
  ok('no map without an image', (await raw(p, 'GET', '/admin/map.png')).status, 404);
  await stub.close();
}

console.log('web: with sign-in');
const good = { id: 'g'.repeat(64), name: 'Stalker', userId: '42', until: 0 };
const fakeAuth = {
  home: '/storage/',
  loginUrl: () => 'https://discord.example/authorize?state=s1',
  callback: async (code, state) => (code === 'ok' && state === 's1' ? { ok: true, session: good.id, name: good.name, userId: good.userId } : { ok: false, why: 'not an admin' }),
  sessionOf: (cookie) => (String(cookie || '').includes(`oz_admin=${good.id}`) ? good : null),
  logout: (cookie) => String(cookie || '').includes(`oz_admin=${good.id}`),
  cookie: (s) => `oz_admin=${s}; HttpOnly; SameSite=Lax; Path=/`,
  clearCookie: () => 'oz_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
  signature: (s) => `${s.name} (${s.userId})`,
};
const web2 = adminWeb({ kinds, dir, allowedHosts: [], auth: fakeAuth });
const port2 = await web2.listen(0);
const cookie = { cookie: `oz_admin=${good.id}` };
ok('the page itself is served to a stranger', (await raw(port2, 'GET', '/')).status, 200);
ok('a forwarded request passes once sign-in is on', (await raw(port2, 'GET', '/', { 'x-forwarded-for': '1.2.3.4' })).status, 200);
ok('whoami tells the page sign-in is on and nobody is in', parse(await raw(port2, 'POST', '/admin/v1/whoami', { 'content-type': 'application/json', 'x-oz-admin': '1' }, '{}')).name, '');
ok('an op without a session is a 401 in words', [(await api(port2, 'storage', 'boxes')).status, parse(await api(port2, 'storage', 'boxes')).why], [401, 'sign in first']);
const login = await raw(port2, 'GET', '/auth/login');
ok('login sends the browser to Discord', [login.status, login.headers.location], [302, 'https://discord.example/authorize?state=s1']);
const refused = await raw(port2, 'GET', '/auth/callback?code=bad&state=s1');
ok('a refused callback says why, as text', [refused.status, refused.body], [403, 'Sign-in refused: not an admin']);
const cb = await raw(port2, 'GET', '/auth/callback?code=ok&state=s1');
ok('a good callback sets the cookie and goes home', [cb.status, cb.headers.location, cb.headers['set-cookie']], [302, '/storage/', [`oz_admin=${good.id}; HttpOnly; SameSite=Lax; Path=/`]]);
const signed = await api(port2, 'storage', 'boxes', { admin: 'liar' }, cookie);
ok('with the cookie the op runs, signed by Discord whatever the body says', [signed.status, seen.at(-1).admin], [200, 'Stalker (42)']);
ok('whoami names the admin', parse(await raw(port2, 'POST', '/admin/v1/whoami', { 'content-type': 'application/json', 'x-oz-admin': '1', ...cookie }, '{}')).name, 'Stalker');
ok('the guards stand with a session too', (await api(port2, 'storage', 'boxes', {}, { ...cookie, 'sec-fetch-site': 'cross-site' })).status, 403);
const out = await raw(port2, 'POST', '/auth/logout', { ...cookie, 'x-oz-admin': '1' });
ok('logout clears the cookie', [out.status, out.headers['set-cookie']], [200, ['oz_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0']]);
ok('logout from elsewhere is refused', (await raw(port2, 'POST', '/auth/logout', { ...cookie, 'x-oz-admin': '1', 'sec-fetch-site': 'cross-site' })).status, 403);
ok('an unknown sign-in page is a 404', (await raw(port2, 'GET', '/auth/nope')).status, 404);
await web2.close();

console.log('web: a taken port');
{
  const first = adminWeb({ kinds, dir, allowedHosts: [] });
  const taken = await first.listen(0);
  const second = adminWeb({ kinds, dir, allowedHosts: [] });
  let code = '';
  try {
    await second.listen(taken);
  } catch (e) {
    code = e.code;
  }
  ok('listen on a taken port rejects with the socket error, so the bridge can catch it', code, 'EADDRINUSE');
  await first.close();
}

console.log('every op a kind exposes is reachable through the web');

{
  // The web checks an op's NAME before it looks it up, against a pattern of
  // one lowercase word. An op named any other way is answered 'unknown op'
  // and nothing says which -- the console reaches it, the site never can.
  // That is how a working archive op shipped with a dead button on it
  // (owner, 2026-09-22). Every kind's surface is checked here, so the next
  // one cannot get out the same way.
  const { storageAdmin } = await import('../src/storage-admin.js');
  const stub = new Proxy({}, { get: () => () => ({ ok: true }) });
  const surfaces = {
    storage: storageAdmin({ store: stub, xchg: null, push: () => {}, health: () => ({ servers: [] }) }),
  };
  const web = /^[a-z]{1,32}$/;
  for (const [kind, ops] of Object.entries(surfaces)) {
    ok(`${kind}: every op is named the way the web accepts`, Object.keys(ops).filter((op) => !web.test(op)), []);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(dir, { recursive: true, force: true });
rmSync(empty, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
