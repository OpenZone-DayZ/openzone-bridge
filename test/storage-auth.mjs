// Discord sign-in for the admin web (design 2026-09-19, section 15), offline:
// Discord is a fake fetch, the clock is a number.

import { storageAuth } from '../src/storage-auth.js';

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

const calls = [];
const answer = (status, body) => ({ ok: status === 200, status, json: async () => body });
let member = { roles: ['111', '222'], nick: '' };
const fakeFetch = async (url, init = {}) => {
  calls.push({ url, init });
  if (url.endsWith('/oauth2/token')) {
    const p = new URLSearchParams(init.body);
    if (p.get('code') !== 'good') return answer(400, { error: 'invalid_grant' });
    return answer(200, { access_token: 'tok' });
  }
  if (url.endsWith('/users/@me')) return answer(200, { id: '42', username: 'stalker', global_name: 'Stalker' });
  if (url.includes('/guilds/G/member')) return member ? answer(200, member) : answer(404, {});
  return answer(404, {});
};
let clock = 1_000_000;
const auth = storageAuth({ clientId: 'C', clientSecret: 'S', guildId: 'G', roleIds: ['222', '333'], adminUrl: 'https://admin.example/storage/', fetch: fakeFetch, now: () => clock });
const freshState = () => new URL(auth.loginUrl()).searchParams.get('state');

console.log('auth: the way to Discord');
ok('the redirect is the admin url plus /auth/callback, one slash', auth.redirect, 'https://admin.example/storage/auth/callback');
ok('home is the path of the admin url with a trailing slash', auth.home, '/storage/');
const url = new URL(auth.loginUrl());
ok('the login url goes to Discord with the client id, the redirect, the scopes and a state', [url.origin + url.pathname, url.searchParams.get('client_id'), url.searchParams.get('redirect_uri'), url.searchParams.get('scope'), url.searchParams.get('response_type'), url.searchParams.get('state').length], ['https://discord.com/oauth2/authorize', 'C', 'https://admin.example/storage/auth/callback', 'identify guilds.members.read', 'code', 32]);

console.log('auth: the way back');
const state = url.searchParams.get('state');
ok('an unknown state is refused', await auth.callback('good', 'nope'), { ok: false, why: 'the sign-in expired; try again' });
ok('no state is refused', await auth.callback('good', ''), { ok: false, why: 'the sign-in expired; try again' });
const r = await auth.callback('good', state);
ok('a member with an admin role gets a session named after them', [r.ok, r.name, r.userId, r.session.length], [true, 'Stalker', '42', 64]);
ok('the code was traded with the secret in the body, never in the url', (() => {
  const c = calls.find((x) => x.url.endsWith('/oauth2/token'));
  const p = new URLSearchParams(c.init.body);
  return [p.get('client_secret'), p.get('grant_type'), p.get('redirect_uri'), c.url.includes('S')];
})(), ['S', 'authorization_code', 'https://admin.example/storage/auth/callback', false]);
ok('the user token went to Discord as a bearer and nowhere else', calls.filter((c) => c.init.headers?.authorization === 'Bearer tok').length, 2);
ok('the state is spent', await auth.callback('good', state), { ok: false, why: 'the sign-in expired; try again' });
ok('no code is refused', await auth.callback('', freshState()), { ok: false, why: 'Discord sent no code' });
ok('a bad code is refused', await auth.callback('bad', freshState()), { ok: false, why: 'Discord refused the code (400)' });
member = { roles: ['111'] };
ok('a member without an admin role is refused', await auth.callback('good', freshState()), { ok: false, why: 'not an admin' });
member = null;
ok('a stranger to the guild is refused', await auth.callback('good', freshState()), { ok: false, why: 'you are not in the guild' });
member = { roles: ['333'], nick: 'Sidorovich' };
const r2 = await auth.callback('good', freshState());
ok('the guild nick wins over the global name', r2.name, 'Sidorovich');

console.log('auth: sessions');
const cookie = auth.cookie(r.session);
ok('the cookie is http-only, same-site, secure under https, twelve hours', cookie, `oz_admin=${r.session}; HttpOnly; SameSite=Lax; Path=/storage/; Max-Age=43200; Secure`);
ok('the session is found behind its cookie among others', auth.sessionOf(`theme=dark; ${cookie.split(';')[0]}`).name, 'Stalker');
ok('a signature carries the name and the Discord id', auth.signature(auth.sessionOf(cookie)), 'Stalker (42)');
ok('no cookie, no session', [auth.sessionOf(''), auth.sessionOf(undefined)], [null, null]);
ok('a forged id is nobody', auth.sessionOf(`oz_admin=${'0'.repeat(64)}`), null);
clock += 12 * 60 * 60 * 1000 + 1;
ok('a session expires after twelve hours', auth.sessionOf(cookie), null);
ok('a state expires after ten minutes', await (async () => {
  const st = freshState();
  clock += 10 * 60 * 1000 + 1;
  return auth.callback('good', st);
})(), { ok: false, why: 'the sign-in expired; try again' });
const r3 = await auth.callback('good', freshState());
ok('logout forgets the session', [auth.logout(auth.cookie(r3.session)), auth.sessionOf(auth.cookie(r3.session)), auth.logout('')], [true, null, false]);
ok('the clearing cookie is empty and expired', auth.clearCookie(), 'oz_admin=; HttpOnly; SameSite=Lax; Path=/storage/; Max-Age=0; Secure');
const plain = storageAuth({ clientId: 'C', clientSecret: 'S', guildId: 'G', roleIds: ['1'], adminUrl: 'http://localhost:8788', fetch: fakeFetch });
ok('under http the cookie is not marked Secure and home is the root', [plain.cookie('x').includes('Secure'), plain.home, plain.redirect], [false, '/', 'http://localhost:8788/auth/callback']);
ok('the plain instance still roots its cookie at /', plain.cookie('x').includes('Path=/;'), true);
const dead = storageAuth({ clientId: 'C', clientSecret: 'S', guildId: 'G', roleIds: ['1'], adminUrl: 'https://admin.example', fetch: async () => { throw new Error('ENOTFOUND'); } });
ok('Discord unreachable is a refusal in words', await dead.callback('good', new URL(dead.loginUrl()).searchParams.get('state')), { ok: false, why: 'Discord did not answer: ENOTFOUND' });
const badJson = storageAuth({
  clientId: 'C', clientSecret: 'S', guildId: 'G', roleIds: ['1'], adminUrl: 'https://admin.example',
  fetch: async (url) => (url.endsWith('/oauth2/token') ? { ok: true, status: 200, json: async () => { throw new Error('bad json'); } } : answer(404, {})),
});
ok('a token answer that is not json is refused in words', await badJson.callback('good', new URL(badJson.loginUrl()).searchParams.get('state')), { ok: false, why: 'Discord sent no token' });

let failOn = '';
const flaky = async (url, init = {}) => {
  if (failOn && url.includes(failOn)) throw new Error('ETIMEDOUT');
  if (url.endsWith('/users/@me') && failOn === 'status') return answer(500, {});
  return fakeFetch(url, init);
};
const shaky = storageAuth({ clientId: 'C', clientSecret: 'S', guildId: 'G', roleIds: ['333'], adminUrl: 'https://admin.example', fetch: flaky });
const shakyState = () => new URL(shaky.loginUrl()).searchParams.get('state');
failOn = '/users/@me/guilds';
ok('Discord unreachable on the member call is the same refusal', await shaky.callback('good', shakyState()), { ok: false, why: 'Discord did not answer: ETIMEDOUT' });
failOn = 'users/@me';
ok('and on the identity call too', await shaky.callback('good', shakyState()), { ok: false, why: 'Discord did not answer: ETIMEDOUT' });
failOn = 'status';
ok('a refused identity names the status and nothing internal', await shaky.callback('good', shakyState()), { ok: false, why: 'Discord refused the identity (500)' });
failOn = '';
ok('and with Discord back the same sign-in goes through', (await shaky.callback('good', shakyState())).ok, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
