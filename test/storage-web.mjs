// The admin web listener (design 2026-09-19, sections 8 and 15): static
// files, the JSON api over fake ops, the guards that stand even without
// sign-in, and the sign-in routes over a fake auth. Real sockets on
// 127.0.0.1, a throwaway web directory.

import { request } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storageWeb } from '../src/storage-web.js';

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
const api = (port, op, body = {}, headers = {}) => raw(port, 'POST', `/admin/v1/${op}`, { 'content-type': 'application/json', 'x-oz-admin': '1', ...headers }, JSON.stringify(body));
const parse = (r) => JSON.parse(r.body);

const dir = mkdtempSync(join(tmpdir(), 'oz-admin-web-'));
writeFileSync(join(dir, 'index.html'), '<!doctype html><title>t</title>');
writeFileSync(join(dir, 'app.js'), '// js');
writeFileSync(join(dir, 'strings.js'), '// strings');
writeFileSync(join(dir, 'app.css'), '/* css */');

const seen = [];
const ops = {
  boxes: (arg) => { seen.push(arg); return { ok: true, boxes: [] }; },
  boom: () => { throw new Error('kaboom'); },
  slow: async () => ({ ok: true, waited: true }),
};

console.log('web: static files');
const web = storageWeb({ ops, dir, allowedHosts: ['admin.example'] });
const port = await web.listen(0);
const home = await raw(port, 'GET', '/');
ok('the page is served', [home.status, home.headers['content-type'], home.body], [200, 'text/html; charset=utf-8', '<!doctype html><title>t</title>']);
ok('the page is served under its name too', (await raw(port, 'GET', '/index.html')).status, 200);
ok('the scripts and the stylesheet are served with their types', (await Promise.all([raw(port, 'GET', '/app.js'), raw(port, 'GET', '/strings.js'), raw(port, 'GET', '/app.css')])).map((r) => [r.status, r.headers['content-type']]), [[200, 'text/javascript; charset=utf-8'], [200, 'text/javascript; charset=utf-8'], [200, 'text/css; charset=utf-8']]);
ok('the page is never cached stale', home.headers['cache-control'], 'no-cache');
ok('nothing else is served', [(await raw(port, 'GET', '/package.json')).status, (await raw(port, 'GET', '/../package.json')).status, (await raw(port, 'GET', '/web/app.js')).status], [404, 404, 404]);
ok('a query string does not change the file', (await raw(port, 'GET', '/app.css?v=1')).status, 200);

console.log('web: the api without sign-in');
const r1 = await api(port, 'boxes', { id: 'x' });
ok('an op answers what the op answers, as json, uncached', [r1.status, parse(r1), r1.headers['cache-control']], [200, { ok: true, boxes: [] }, 'no-store']);
ok('the op saw the body and the admin the page named itself', seen.at(-1), { id: 'x', admin: 'web' });
await api(port, 'boxes', { admin: 'Owner' });
ok('a name given is used', seen.at(-1).admin, 'Owner');
await api(port, 'boxes', { admin: 'x'.repeat(100) });
ok('and clipped to 64', seen.at(-1).admin.length, 64);
await api(port, 'boxes', { admin: '' });
ok('an empty name is web', seen.at(-1).admin, 'web');
ok('an async op is awaited', parse(await api(port, 'slow')), { ok: true, waited: true });
ok('an unknown op is a 404 in words', [(await api(port, 'nope')).status, parse(await api(port, 'nope')).why], [404, 'unknown op: nope']);
ok('an op off the prototype is unknown too', (await api(port, 'toString')).status, 404);
ok('an op that throws is refused in words', parse(await api(port, 'boom')), { ok: false, why: 'boom failed: kaboom' });
ok('whoami without sign-in says so', parse(await api(port, 'whoami')), { ok: true, auth: false, name: '', userId: '' });
ok('a body that is not json is a 400', (await raw(port, 'POST', '/admin/v1/boxes', { 'content-type': 'application/json', 'x-oz-admin': '1' }, '{oops')).status, 400);
ok('a body that is not an object is a 400', (await raw(port, 'POST', '/admin/v1/boxes', { 'content-type': 'application/json', 'x-oz-admin': '1' }, '[1]')).status, 400);
ok('an empty body is an empty object', parse(await raw(port, 'POST', '/admin/v1/boxes', { 'content-type': 'application/json', 'x-oz-admin': '1' }, '')).ok, true);
ok('a GET on the api is no page', (await raw(port, 'GET', '/admin/v1/boxes')).status, 404);
ok('a POST off the api is post only', (await raw(port, 'POST', '/app.js', { 'content-type': 'application/json', 'x-oz-admin': '1' }, '{}')).status, 405);

console.log('web: the guards');
ok('without the custom header the call is refused', (await raw(port, 'POST', '/admin/v1/boxes', { 'content-type': 'application/json' }, '{}')).status, 403);
ok('without json the call is refused', (await raw(port, 'POST', '/admin/v1/boxes', { 'content-type': 'text/plain', 'x-oz-admin': '1' }, '{}')).status, 403);
ok('a cross-site call is refused', (await api(port, 'boxes', {}, { 'sec-fetch-site': 'cross-site' })).status, 403);
ok('a same-site call from another subdomain is refused', (await api(port, 'boxes', {}, { 'sec-fetch-site': 'same-site' })).status, 403);
ok('a same-origin call passes', (await api(port, 'boxes', {}, { 'sec-fetch-site': 'same-origin' })).status, 200);
ok('a call typed in by hand passes', (await api(port, 'boxes', {}, { 'sec-fetch-site': 'none' })).status, 200);
ok('a wrong host is refused before anything else', [(await api(port, 'boxes', {}, { host: 'evil.example' })).status, (await raw(port, 'GET', '/', { host: 'evil.example' })).status], [421, 421]);
ok('the loopback names with the port pass', [(await raw(port, 'GET', '/', { host: `localhost:${port}` })).status, (await raw(port, 'GET', '/', { host: `[::1]:${port}` })).status], [200, 200]);
ok('the loopback name without the port does not', (await raw(port, 'GET', '/', { host: '127.0.0.1' })).status, 421);
ok('the host of the admin url passes, whatever its case', [(await raw(port, 'GET', '/', { host: 'admin.example' })).status, (await raw(port, 'GET', '/', { host: 'Admin.Example' })).status], [200, 200]);
ok('a sign-in route without sign-in is no page', (await raw(port, 'GET', '/auth/login')).status, 404);
await web.close();

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
const web2 = storageWeb({ ops, dir, allowedHosts: [], auth: fakeAuth });
const port2 = await web2.listen(0);
const cookie = { cookie: `oz_admin=${good.id}` };
ok('the page itself is served to a stranger', (await raw(port2, 'GET', '/')).status, 200);
ok('whoami tells the page sign-in is on and nobody is in', parse(await api(port2, 'whoami')), { ok: true, auth: true, name: '', userId: '' });
ok('an op without a session is a 401 in words', [(await api(port2, 'boxes')).status, parse(await api(port2, 'boxes')).why], [401, 'sign in first']);
const login = await raw(port2, 'GET', '/auth/login');
ok('login sends the browser to Discord', [login.status, login.headers.location], [302, 'https://discord.example/authorize?state=s1']);
const refused = await raw(port2, 'GET', '/auth/callback?code=bad&state=s1');
ok('a refused callback says why, as text', [refused.status, refused.body], [403, 'Sign-in refused: not an admin']);
const cb = await raw(port2, 'GET', '/auth/callback?code=ok&state=s1');
ok('a good callback sets the cookie and goes home', [cb.status, cb.headers.location, cb.headers['set-cookie']], [302, '/storage/', [`oz_admin=${good.id}; HttpOnly; SameSite=Lax; Path=/`]]);
const signed = await api(port2, 'boxes', { admin: 'liar' }, cookie);
ok('with the cookie the op runs, signed by Discord whatever the body says', [signed.status, seen.at(-1).admin], [200, 'Stalker (42)']);
ok('whoami names the admin', parse(await api(port2, 'whoami', {}, cookie)), { ok: true, auth: true, name: 'Stalker', userId: '42' });
ok('the guards stand with a session too', (await api(port2, 'boxes', {}, { ...cookie, 'sec-fetch-site': 'cross-site' })).status, 403);
const out = await raw(port2, 'POST', '/auth/logout', { ...cookie, 'x-oz-admin': '1' });
ok('logout clears the cookie', [out.status, out.headers['set-cookie']], [200, ['oz_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0']]);
ok('logout from elsewhere is refused', (await raw(port2, 'POST', '/auth/logout', { ...cookie, 'x-oz-admin': '1', 'sec-fetch-site': 'cross-site' })).status, 403);
ok('an unknown sign-in page is a 404', (await raw(port2, 'GET', '/auth/nope')).status, 404);
await web2.close();

console.log('web: a taken port');
{
  const first = storageWeb({ ops, dir, allowedHosts: [] });
  const taken = await first.listen(0);
  const second = storageWeb({ ops, dir, allowedHosts: [] });
  let code = '';
  try {
    await second.listen(taken);
  } catch (e) {
    code = e.code;
  }
  ok('listen on a taken port rejects with the socket error, so the bridge can catch it', code, 'EADDRINUSE');
  await first.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
