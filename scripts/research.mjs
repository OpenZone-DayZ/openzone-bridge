#!/usr/bin/env node
// The research configs from the console (design 2026-09-20, section 6): a
// thin client of the bridge's /v1/research/admin route. Reads .env for the
// address and the shared secret and never prints the secret.
//
//   node scripts/research.mjs configs
//   node scripts/research.mjs get <name> [version] [--out file]   (the text of a version; newest by default)
//   node scripts/research.mjs put <name> <file>                    (a candidate: the game applies it and answers)
//   node scripts/research.mjs history <name> [n]
//   node scripts/research.mjs restore <name> <version>
//   node scripts/research.mjs state                                (the factions: pools, nodes, projects)
//   node scripts/research.mjs classes [--out file]                (the server's class dump; --out writes it as a table)
//   node scripts/research.mjs reset <owner>
//   node scripts/research.mjs grant <owner> <type> <n>
//   node scripts/research.mjs complete <owner> <node>
//   node scripts/research.mjs reload
//   node scripts/research.mjs respawn <id>
//   node scripts/research.mjs result <token>
//   node scripts/research.mjs wait <token> [seconds]
//   node scripts/research.mjs events [n]
//   node scripts/research.mjs status
//
// Exit codes: 0 done, 1 the bridge or the game refused, 2 usage, 3 the
// bridge does not answer, 4 the game did not answer in time.

import { config } from 'dotenv';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
config({ path: join(root, '.env') });

const BASE = `http://${process.env.BRIDGE_HOST || '127.0.0.1'}:${process.env.BRIDGE_PORT || 8787}`;
const SECRET = process.env.OZ_SHARED_SECRET || '';
const ADMIN = process.env.USERNAME || process.env.USER || 'cli';

const argv = process.argv.slice(2);
const outAt = argv.indexOf('--out');
const OUT = outAt > -1 ? argv[outAt + 1] : '';
if (outAt > -1) argv.splice(outAt, 2);
const [cmd, ...args] = argv;

const USAGE = `usage: node scripts/research.mjs <command> [args]
  configs | get <name> [version] [--out file] | put <name> <file> | history <name> [n] | restore <name> <version>
  state | classes [--out file] | events [n] | status
  reset <owner> | grant <owner> <type> <n> | complete <owner> <node> | reload | respawn <id>
  result <token> | wait <token> [seconds]`;

if (!cmd || cmd === 'help' || cmd === '--help') {
  console.log(USAGE);
  process.exit(0);
}
if (!SECRET) {
  console.error('OZ_SHARED_SECRET is not set in .env');
  process.exit(2);
}

// The exit code travels as a throw, never as process.exit() after a fetch:
// Node on Windows aborts (a libuv assertion in async.c) when the process
// exits while undici's socket is still closing. exitCode lets the loop
// drain and the code stand.
class Leave extends Error {
  constructor(code) {
    super('');
    this.code = code;
  }
}

async function call(op, extra, route = '/v1/research/admin') {
  let r;
  try {
    r = await fetch(`${BASE}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ Secret: SECRET, ServerId: 'cli', Json: JSON.stringify({ op, ...extra, admin: ADMIN }) }),
    });
  } catch (e) {
    console.error(`the bridge at ${BASE} does not answer: ${e.message}`);
    throw new Leave(3);
  }
  const body = await r.json();
  if (r.status !== 200) {
    console.error(`${op}: ${r.status} ${JSON.stringify(body)}`);
    throw new Leave(3);
  }
  if (!body.ok) {
    console.error(`${op}: ${body.why}`);
    throw new Leave(1);
  }
  return body;
}

function table(rows, cols) {
  if (!rows.length) {
    console.log('(nothing)');
    return;
  }
  const width = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (vals) => vals.map((v, i) => String(v ?? '').padEnd(width[i])).join('  ');
  console.log(line(cols));
  for (const r of rows) console.log(line(cols.map((c) => r[c])));
}

const need = (n, what) => {
  if (args.length < n) {
    console.error(`${cmd} needs ${what}\n${USAGE}`);
    process.exit(2);
  }
};

// The game's answer to a command, polled once a second.
async function waitFor(token, seconds) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    const { result } = await call('result', { token });
    if (result && result.status === 'answered') {
      if (result.ok) {
        console.log(`answer: ok ${result.answer}`.trim());
        if (result.version) console.log(`${result.version.name}: version ${result.version.version} ${result.version.status}`);
        return 0;
      }
      console.log(`answer: refused: ${result.answer}`);
      if (result.version) console.log(`${result.version.name}: version ${result.version.version} ${result.version.status}`);
      return 1;
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  console.log(`no answer within ${seconds} s (the game polls the bridge every few seconds; ask later with: node scripts/research.mjs result ${token})`);
  return 4;
}

try {
switch (cmd) {
  case 'configs': {
    const { configs } = await call('configs', {});
    table(configs, ['name', 'file', 'exists', 'size', 'version', 'at', 'by', 'source', 'latest', 'latestStatus', 'pending']);
    break;
  }
  case 'get': {
    need(1, 'a config name');
    const r = await call('config', { name: args[0], version: args[1] });
    if (OUT) {
      writeFileSync(OUT, r.text, 'utf8');
      console.log(`${r.name} version ${r.version} (${r.status}, ${r.at}, by ${r.by}) written to ${OUT}`);
    } else {
      console.error(`${r.name} version ${r.version} (${r.status}, ${r.at}, by ${r.by})`);
      console.log(r.text);
    }
    break;
  }
  case 'put': {
    need(2, 'a config name and a file');
    let json;
    try {
      json = readFileSync(args[1], 'utf8');
    } catch (e) {
      console.error(`cannot read ${args[1]}: ${e.message}`);
      throw new Leave(2);
    }
    const r = await call('save', { name: args[0], json });
    console.log(`candidate ${r.file}: version ${r.version} pending, token ${r.token}`);
    process.exitCode = await waitFor(r.token, 30);
    break;
  }
  case 'history': {
    need(1, 'a config name');
    const { versions } = await call('history', { name: args[0], limit: args[1] });
    table(versions, ['version', 'status', 'at', 'by', 'source', 'size', 'why', 'token']);
    break;
  }
  case 'restore': {
    need(2, 'a config name and a version');
    const r = await call('restore', { name: args[0], version: args[1] });
    console.log(`candidate ${r.file}: version ${r.version} pending, token ${r.token}`);
    process.exitCode = await waitFor(r.token, 30);
    break;
  }
  case 'state': {
    const { owners } = await call('state', {});
    for (const o of owners) {
      if (o.error) {
        console.log(`${o.owner}: unreadable (${o.error})`);
        continue;
      }
      const pool = o.points.map((p) => `${p.key}=${p.value}`).join(' ') || '(empty pool)';
      console.log(`${o.owner} (${o.at}): ${pool}`);
      console.log(`  completed: ${o.completed.join(', ') || '(none)'}`);
      for (const p of o.projects) console.log(`  project ${p.node} by ${p.starter} until ${p.endSec}`);
    }
    if (!owners.length) console.log('(no faction has a state file yet)');
    break;
  }
  case 'classes': {
    // The server's classes as the bridge holds them (the core's dump, the
    // kind `core`): a count, or with --out the whole index as a table (root,
    // class, parent, name in the original column, name in the English one).
    if (OUT) {
      const r = await call('classindex', {}, '/v1/core/admin');
      if (!r.index) {
        console.error('no class dump from the game yet');
        throw new Leave(1);
      }
      const roots = ['CfgVehicles', 'CfgMagazines', 'CfgNonAIVehicles', 'CfgAmmo', 'cfgWeapons'];
      const rows = r.index.classes;
      const lines = rows.map((c) => [roots[c[3]] || c[3], c[0], c[1] >= 0 ? rows[c[1]][0] : '', c[4], c[5]].join('\t'));
      writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
      console.log(`${lines.length} class(es) of server ${r.server} as of ${r.at} written to ${OUT}`);
    } else {
      const r = await call('classes', {}, '/v1/core/admin');
      console.log(`${r.count} class(es) of server ${r.server || '(none yet)'} as of ${r.at || 'never'}`);
    }
    break;
  }
  case 'reset':
  case 'respawn': {
    need(1, cmd === 'reset' ? 'an owner' : 'a static id');
    const r = await call(cmd, cmd === 'reset' ? { owner: args[0] } : { id: args[0] });
    console.log(`sent to the game, token ${r.token}`);
    process.exitCode = await waitFor(r.token, 30);
    break;
  }
  case 'grant': {
    need(3, 'an owner, a point type and an amount');
    const r = await call('grant', { owner: args[0], type: args[1], amount: args[2] });
    console.log(`sent to the game, token ${r.token}`);
    process.exitCode = await waitFor(r.token, 30);
    break;
  }
  case 'complete': {
    need(2, 'an owner and a node');
    const r = await call('complete', { owner: args[0], node: args[1] });
    console.log(`sent to the game, token ${r.token}`);
    process.exitCode = await waitFor(r.token, 30);
    break;
  }
  case 'reload': {
    const r = await call('reload', {});
    console.log(`sent to the game, token ${r.token}`);
    process.exitCode = await waitFor(r.token, 30);
    break;
  }
  case 'result': {
    need(1, 'a token');
    const { result } = await call('result', { token: args[0] });
    if (!result) console.log('unknown token');
    else if (result.status !== 'answered') console.log(`${result.op} by ${result.by}: ${result.status}, no answer yet`);
    else console.log(`${result.op} by ${result.by}: ${result.ok ? 'ok' : 'refused'} ${result.answer} (${result.answered_at})`);
    if (result?.version) console.log(`${result.version.name}: version ${result.version.version} ${result.version.status}${result.version.why ? `: ${result.version.why}` : ''}`);
    break;
  }
  case 'wait': {
    need(1, 'a token');
    process.exitCode = await waitFor(args[0], Number(args[1]) || 60);
    break;
  }
  case 'events': {
    const { events } = await call('events', { limit: args[0] });
    table(events, ['at', 'kind', 'name', 'admin', 'token', 'server_id', 'note']);
    break;
  }
  case 'status': {
    const r = await call('status', {});
    console.log(`research: ${r.configured ? `configured, ${r.dir}` : 'not configured'}`);
    if (r.configured) console.log(`exchange directory: ${r.xchg}`);
    console.log(`classes known: ${r.classes}`);
    console.log(`unanswered commands: ${r.unanswered}`);
    for (const b of r.booted || []) console.log(`server ${b.id}: booted ${b.at}, revision ${b.revision}, ${b.classes} classes; ${b.counters}`);
    for (const srv of r.servers || []) console.log(`server ${srv.id}: last poll ${srv.at}`);
    if (r.keep) console.log(`the next clean-up removes ${r.keep.versions} version(s), ${r.keep.events} event(s)`);
    break;
  }
  default:
    console.error(`unknown command ${cmd}\n${USAGE}`);
    process.exitCode = 2;
}
} catch (e) {
  if (e instanceof Leave) process.exitCode = e.code;
  else {
    console.error(e.message);
    process.exitCode = 3;
  }
}
