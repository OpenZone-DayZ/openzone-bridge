// The research routes end to end (design 2026-09-20, section 4): the REAL
// entry point in a child process with no Discord bot, a throwaway database
// and a throwaway profile directory, driven over the socket the way the game
// drives it -- boot, a candidate through the poll, the game's rewrite and its
// answer, a refusal, the re-send after the bridge restarts. Plus what the
// routes answer when RESEARCH_DIR is not set at all.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { ResearchStore } from '../src/research-store.js';
import { researchRoutes } from '../src/research-routes.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = join(tmpdir(), `oz-research-routes-${process.pid}.sqlite`);
const dir = mkdtempSync(join(tmpdir(), 'oz-research-profile-'));
const xdir = join(dir, 'research', 'xchg');
const SECRET = 'research-routes-test-secret';

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

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const NAMES = ['ResearchSettings', 'ResearchPointTypes', 'ResearchOwners', 'ResearchRules', 'ResearchTree', 'ResearchDataItems', 'ResearchModules', 'ResearchSampleTypes', 'ResearchStatics'];
const OWNERS = { Version: 1, Owners: [{ Id: 'loner', DeviceClasses: ['OZL_Microscope'], TerminalClasses: ['OZL_LabComputer'] }] };
const gameWrite = (name, value) => writeFileSync(join(dir, `OZ_Research_${name.slice(8)}.json`), JSON.stringify(value, null, 4), 'utf8');
gameWrite('ResearchOwners', OWNERS);
gameWrite('ResearchSettings', { Version: 1, DefaultOwner: 'loner', ResearchPost: '', BasePost: 'research', TreeVisibilityDepth: 1 });
mkdirSync(xdir, { recursive: true });
writeFileSync(join(dir, 'research', 'loner.json'), JSON.stringify({ Version: 1, Points: [{ Key: 'bio_field_t1', Value: 12 }], CompletedNodes: ['pb_osnovy'], ActiveProjects: [] }), 'utf8');
writeFileSync(join(xdir, 'classes.tsv'), '0\tInventory_Base\tStatic\t\t\n0\tOZL_Sample_Base\tInventory_Base\tЗразок\tSample\n0\tOZL_Microscope\tOZL_Sample_Base\t$STR_OZL_missing\t$STR_OZL_missing\n', 'utf8');
const candidates = () => readdirSync(xdir).filter((f) => f.endsWith('.json'));

console.log('without RESEARCH_DIR');

{
  const base = new Store(join(tmpdir(), `oz-research-routes-off-${process.pid}.sqlite`));
  const side = researchRoutes({ store: new ResearchStore(base), xchg: null });
  ok('every route refuses in words', await side.routes['/v1/research/boot']({ Json: { Names: NAMES }, ServerId: 't' }), { ok: false, why: 'research not configured' });
  ok('changed too', (await side.routes['/v1/research/changed']({ Json: { Name: 'ResearchOwners' }, ServerId: 't' })).ok, false);
  ok('and the poll carries nothing', side.poll('t', false), []);
  base.close();
}

console.log('the bridge with a profile directory');

const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  DISCORD_BOT_TOKEN: '',
  DISCORD_CLIENT_ID: '',
  DISCORD_GUILD_ID: '',
  DISCORD_PARENT_CHANNEL_ID: '',
  OZ_SHARED_SECRET: SECRET,
  BRIDGE_PORT: String(port),
  BRIDGE_DB: db,
  POLL_HOLD_SECONDS: '1',
  RESEARCH_DIR: dir,
};
let child;
let log = '';

function start() {
  log = '';
  child = spawn(process.execPath, ['src/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (b) => { log += b.toString(); });
  child.stderr.on('data', (b) => { log += b.toString(); });
}

async function ready(ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`the bridge exited with ${child.exitCode}\n${log}`);
    if (log.includes('[bridge] ready')) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the bridge never said it was ready\n${log}`);
}

async function stop() {
  child.kill();
  await new Promise((r) => child.once('exit', r));
}

async function call(path, json) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ Secret: SECRET, ServerId: 'research-test', Json: JSON.stringify(json) }),
  });
  const body = await r.json();
  if (r.status !== 200) throw new Error(`${path} -> ${r.status} ${JSON.stringify(body)}`);
  return body;
}

const admin = (op, extra = {}) => call('/v1/research/admin', { op, admin: 'tester', ...extra });

// The game's poll, filtered to the research items, parsed.
async function poll(fresh) {
  const r = await fetch(`${BASE}/v1/poll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ Secret: SECRET, ServerId: 'research-test', Cursor: 0, Fresh: fresh, Uids: [], Mirrors: [] }),
  }).then((x) => x.json());
  return (r.Items || []).filter((i) => i.Kind === 'research').map((i) => ({ len: i.Json.length, ...JSON.parse(i.Json) }));
}

start();
try {
  await ready();
  ok('the bridge said the directory is ready', log.includes(`[research] ${dir} ready`), true);

  ok('a fresh game gets no research mail on its first poll', await poll(true), []);
  const boot = await call('/v1/research/boot', { Revision: 1, Counters: 'owners=1', Names: NAMES, Classes: 'classes.tsv', ClassCount: 3 });
  ok('boot reads the files that exist and the classes', boot, { ok: true, configs: 2, versions: 2, classes: 3 });
  ok('booting again with the same files makes no versions', (await call('/v1/research/boot', { Revision: 1, Counters: 'owners=1', Names: NAMES })).versions, 0);
  ok('the log says so', log.includes('[research] boot from research-test: 2 configs (2 new versions), 3 classes, revision 1'), true);

  const cfgs = (await admin('configs')).configs;
  ok('configs lists the nine, two on disk at version 1', [cfgs.length, cfgs.filter((c) => c.exists).map((c) => [c.name, c.version, c.by]), cfgs.find((c) => c.name === 'ResearchRules').version], [9, [['ResearchSettings', 1, 'game'], ['ResearchOwners', 1, 'game']], 0]);
  const one = await admin('config', { name: 'ResearchOwners' });
  ok('config gives the text of the newest version', [one.version, one.status, JSON.parse(one.text).Owners.length], [1, 'applied', 1]);
  ok('an unknown op is refused', await admin('nope'), { ok: false, why: 'unknown op: nope' });

  // An edit: the candidate goes through the poll, the game rewrites the
  // file in its own formatting, deletes the candidate, and answers.
  const edited = { ...OWNERS, Owners: [{ ...OWNERS.Owners[0], DeviceClasses: ['OZL_Microscope', 'OZL_Centrifuge'] }] };
  const saved = await admin('save', { name: 'ResearchOwners', json: JSON.stringify(edited) });
  ok('save answers a token and version 2', [saved.ok, saved.version, candidates()], [true, 2, [saved.file]]);
  const mail = await poll(false);
  ok('the poll carries the command, short, and no hello for a booted server', mail.map((m) => [m.op, m.name, m.file, m.by, m.token === saved.token, m.len < 800]), [['cfg_apply', 'ResearchOwners', saved.file, 'tester', true, true]]);
  ok('the version waits for the game', (await admin('result', { token: saved.token })).result.version.status, 'pending');
  const candidate = JSON.parse(readFileSync(join(xdir, saved.file), 'utf8'));
  gameWrite('ResearchOwners', { Owners: candidate.Owners, Version: candidate.Version });
  unlinkSync(join(xdir, saved.file));
  ok('changed promotes the candidate', await call('/v1/research/changed', { Name: 'ResearchOwners', Revision: 2, By: 'bridge:tester' }), { ok: true, version: 2 });
  ok('result marks the command answered', await call('/v1/research/result', { Token: saved.token, Ok: true, Why: '', Note: 'warnings=0 problems=0', Counters: 'owners=1' }), { ok: true });
  const done = (await admin('result', { token: saved.token })).result;
  ok('the command is answered ok and the version applied by the admin', [done.status, done.ok, done.answer, done.version.status, (await admin('config', { name: 'ResearchOwners' })).by], ['answered', true, 'warnings=0 problems=0', 'applied', 'tester']);
  ok('a second result says already', await call('/v1/research/result', { Token: saved.token, Ok: true, Note: 'again' }), { ok: true, already: true });
  ok('history is two versions', (await admin('history', { name: 'ResearchOwners' })).versions.map((v) => [v.version, v.status, v.source]), [[2, 'applied', 'admin'], [1, 'applied', 'game']]);

  // A VPP edit the bridge did not make: a new version of the game's own.
  gameWrite('ResearchOwners', { ...edited, Owners: [...edited.Owners, { Id: 'bandit', DeviceClasses: [], TerminalClasses: [] }] });
  ok('changed with unknown text is a new version', await call('/v1/research/changed', { Name: 'ResearchOwners', Revision: 3, By: 'vpp' }), { ok: true, version: 3 });
  ok('by the one the game names', (await admin('config', { name: 'ResearchOwners' })).by, 'vpp');
  ok('changed of a missing file is refused', await call('/v1/research/changed', { Name: 'ResearchRules', Revision: 3, By: 'vpp' }), { ok: false, why: 'no such file' });
  ok('changed of an unknown name is refused', await call('/v1/research/changed', { Name: 'Rules', Revision: 3, By: 'vpp' }), { ok: false, why: 'unknown config' });

  // A refusal: the game says no, the version is rejected, the file stays.
  ok('save refuses text that is not json', (await admin('save', { name: 'ResearchOwners', json: '{oops' })).ok, false);
  ok('and left no file', candidates(), []);
  const newer = await admin('save', { name: 'ResearchOwners', json: JSON.stringify({ ...OWNERS, Version: 99 }) });
  await poll(false);
  ok('the game refuses it', await call('/v1/research/result', { Token: newer.token, Ok: false, Why: 'version 99 is newer than this build knows', Note: '' }), { ok: true });
  const refused = (await admin('result', { token: newer.token })).result;
  ok('the version is rejected with the reason and the file stays', [refused.ok, refused.answer, refused.version.status, refused.version.why, candidates()], [false, 'version 99 is newer than this build knows', 'rejected', 'version 99 is newer than this build knows', [newer.file]]);
  ok('result for an unknown token is refused', await call('/v1/research/result', { Token: '000000000000', Ok: true }), { ok: false, why: 'unknown token' });

  // Restore, and the live commands.
  const back = await admin('restore', { name: 'ResearchOwners', version: 1 });
  ok('restore is a candidate of the old text', [back.ok, back.version, (await poll(false)).map((m) => m.op)], [true, 5, ['cfg_apply']]);
  await call('/v1/research/result', { Token: back.token, Ok: true, Note: 'warnings=0' });
  const grant = await admin('grant', { owner: 'loner', type: 'bio_field_t1', amount: 3 });
  ok('grant rides the poll with its arguments', (await poll(false)).map((m) => [m.op, m.owner, m.type, m.amount, m.token === grant.token]), [['grant', 'loner', 'bio_field_t1', '3', true]]);
  await call('/v1/research/result', { Token: grant.token, Ok: true, Note: 'points=bio_field_t1:15' });
  ok('and is answered', (await admin('result', { token: grant.token })).result.answer, 'points=bio_field_t1:15');
  ok('state reads the owners', (await admin('state')).owners.map((o) => [o.owner, o.completed]), [['loner', ['pb_osnovy']]]);
  ok('classes reads the dump', (await admin('classes')).count, 3);
  const cidx = await admin('classindex');
  ok('classindex is the server dump with parents and names, a bare key no name', [cidx.server, cidx.index.mods, cidx.index.classes], ['research-test', ['research-test'], [['Inventory_Base', -1, 0, 0, '', ''], ['OZL_Sample_Base', 0, 0, 0, 'Зразок', 'Sample'], ['OZL_Microscope', 1, 0, 0, '', '']]]);
  ok('another server has no dump', [(await admin('classindex', { server: 'nope' })).index, (await admin('classes', { server: 'nope' })).count], [null, 0]);
  ok('status knows the booted server', (await admin('status')).booted.map((b) => [b.id, b.revision, b.classes]), [['research-test', 1, 3]]);

  // A command the game never answered, then the bridge restarts: the
  // command is re-sent on the first poll, and the boot is asked for.
  const reload = await admin('reload');
  ok('reload is queued', (await poll(false)).map((m) => m.op), ['reload']);
  await stop();
  start();
  await ready();
  ok('after the restart the first poll re-sends it and asks for boot', (await poll(false)).map((m) => [m.op, m.token === reload.token]), [['reload', true], ['hello', false]]);
  ok('the next poll carries nothing', await poll(false), []);
  ok('the restart kept the versions', (await admin('history', { name: 'ResearchOwners' })).versions.length, 5);
  await call('/v1/research/boot', { Revision: 5, Counters: 'owners=1', Names: NAMES });
  ok('a boot after the restart is answered and the swept refused candidate stays', [(await admin('status')).booted.length, candidates()], [1, [newer.file]]);
  // The kinds a server runs, kept across the bridge's restart: research
  // booted since the server's start, storage never.
  const srv = (await admin('servers')).servers.find((x) => x.id === 'research-test');
  ok('the server list says which kinds booted since the start', [srv.since !== '', Object.keys(srv.kinds)], [true, ['research']]);
  await call('/v1/research/result', { Token: reload.token, Ok: true, Note: '' });
  ok('a fresh game gets the unanswered mail again, no hello', (await poll(true)), []);
  ok('a fresh poll forgets the kinds until they boot again', Object.keys((await admin('servers')).servers.find((x) => x.id === 'research-test').kinds), []);
  const events = (await admin('events', { limit: 100 })).events.map((e) => e.kind);
  ok('the journal saw it all', ['boot', 'admin_save', 'changed', 'result', 'admin_grant', 'admin_reload'].every((k) => events.includes(k)), true);
} catch (e) {
  fail++;
  console.log(`  FAIL ${e.message}\n${log}`);
} finally {
  await stop();
  for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
  rmSync(dir, { recursive: true, force: true });
  if (existsSync(join(tmpdir(), `oz-research-routes-off-${process.pid}.sqlite`))) rmSync(join(tmpdir(), `oz-research-routes-off-${process.pid}.sqlite`), { force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
