#!/usr/bin/env node
// The storage boxes from the console (design 2026-09-19, section 4.5): a
// thin client of the bridge's /v1/storage/admin route. Reads .env for the
// address and the shared secret and never prints the secret.
//
//   node scripts/storage.mjs boxes
//   node scripts/storage.mjs box <id>
//   node scripts/storage.mjs history <id> [n]
//   node scripts/storage.mjs player <steam64> [n]
//   node scripts/storage.mjs find <class>
//   node scripts/storage.mjs parked
//   node scripts/storage.mjs version <n>
//   node scripts/storage.mjs rollback <id> <version>
//   node scripts/storage.mjs unpark <parkedId>
//   node scripts/storage.mjs discard <parkedId>
//   node scripts/storage.mjs give <id> <class> [qty]
//   node scripts/storage.mjs empty <id>
//   node scripts/storage.mjs shelve <id> <root>            (a root of a closed box onto the shelf)
//   node scripts/storage.mjs move <from> <root> <to>       (a root into another closed box, unplaced; the source may be deleted)
//   node scripts/storage.mjs restore <deleted> <to>        (everything a deleted box held, into a closed box)
//   node scripts/storage.mjs edit <id> <root> <node> [qty=N] [health=N] [reset]
//   node scripts/storage.mjs diff <a> <b>                  (classes that go and come from version a to b)
//   node scripts/storage.mjs health
//   node scripts/storage.mjs close <id>       (live: the engine closes it now)
//   node scripts/storage.mjs remove <id>      (live: the engine deletes a closed box)
//   node scripts/storage.mjs report <id>      (live: where and how it is)
//   node scripts/storage.mjs result <ref>     (the engine's answer to a live command)

import { config } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
config({ path: join(root, '.env') });

const BASE = `http://${process.env.BRIDGE_HOST || '127.0.0.1'}:${process.env.BRIDGE_PORT || 8787}`;
const SECRET = process.env.OZ_SHARED_SECRET || '';
const ADMIN = process.env.USERNAME || process.env.USER || 'cli';

const [cmd, ...args] = process.argv.slice(2);

const USAGE = `usage: node scripts/storage.mjs <command> [args]
  boxes | box <id> | history <id> [n] | player <steam64> [n] | find <class> | parked | version <n> | diff <a> <b> | health
  rollback <id> <version> | unpark <parkedId> | discard <parkedId> | give <id> <class> [qty] | empty <id>
  shelve <id> <root> | move <from> <root> <to> | restore <deleted> <to> | edit <id> <root> <node> [qty=N] [health=N] [reset]
  close <id> | remove <id> | report <id> | result <ref>`;

if (!cmd || cmd === 'help' || cmd === '--help') {
  console.log(USAGE);
  process.exit(0);
}
if (!SECRET) {
  console.error('OZ_SHARED_SECRET is not set in .env');
  process.exit(2);
}

async function call(op, extra) {
  let r;
  try {
    r = await fetch(`${BASE}/v1/storage/admin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ Secret: SECRET, ServerId: 'cli', Json: JSON.stringify({ op, ...extra, admin: ADMIN }) }),
    });
  } catch (e) {
    console.error(`the bridge at ${BASE} does not answer: ${e.message}`);
    process.exit(3);
  }
  const body = await r.json();
  if (r.status !== 200) {
    console.error(`${op}: ${r.status} ${JSON.stringify(body)}`);
    process.exit(3);
  }
  if (!body.ok) {
    console.error(`${op}: ${body.why}`);
    process.exit(1);
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

switch (cmd) {
  case 'boxes': {
    const { boxes } = await call('boxes', {});
    table(boxes, ['box_id', 'class', 'status', 'roots', 'current_version', 'pos', 'placed_by', 'last_seen_at']);
    break;
  }
  case 'box': {
    need(1, 'an id');
    const { box, items, versions } = await call('box', { id: args[0] });
    table([box], ['box_id', 'class', 'status', 'current_version', 'pos', 'placed_at', 'placed_by', 'cache_stamp']);
    console.log('\nitems of the current version:');
    table(items, ['root_idx', 'node_idx', 'parent', 'type', 'loc_type', 'slot', 'row', 'col', 'health', 'quantity', 'ammo', 'has_blob']);
    console.log('\nversions:');
    table(versions, ['id', 'source', 'roots', 'entities', 'stamp', 'note']);
    break;
  }
  case 'history': {
    need(1, 'an id');
    const { events, versions } = await call('history', { id: args[0], limit: args[1] });
    console.log('events:');
    table(events, ['at', 'kind', 'uid', 'name', 'type', 'qty', 'row', 'col', 'slot', 'note', 'admin']);
    console.log('\nversions:');
    table(versions, ['id', 'source', 'roots', 'entities', 'stamp', 'note']);
    break;
  }
  case 'player': {
    need(1, 'a Steam id');
    const { events } = await call('player', { uid: args[0], limit: args[1] });
    table(events, ['at', 'kind', 'box_id', 'type', 'qty', 'row', 'col', 'slot', 'note']);
    break;
  }
  case 'find': {
    need(1, 'a class');
    const { items, last } = await call('find', { type: args[0] });
    table(items, ['box_id', 'status', 'box_class', 'pos', 'root_idx', 'node_idx', 'row', 'col', 'quantity', 'health']);
    if (last) console.log(`\nlast taken by ${last.name || last.uid} at ${last.at} from box ${last.box_id}`);
    break;
  }
  case 'parked': {
    const { parked } = await call('parked', {});
    table(parked, ['id', 'box_id', 'parked_at', 'reason', 'type', 'types', 'from_version']);
    break;
  }
  case 'version': {
    need(1, 'a version id');
    const { roots } = await call('version', { version: args[0] });
    for (const r of roots) console.log(`root ${r.rootIdx}: ${r.nodes.map((n) => `${n.type}@${n.row},${n.col}`).join(' > ')}`);
    if (!roots.length) console.log('(no roots)');
    break;
  }
  case 'rollback': {
    need(2, 'an id and a version');
    const r = await call('rollback', { id: args[0], version: args[1] });
    console.log(`rolled back: version ${r.version} is current now; it takes effect at the next open`);
    break;
  }
  case 'unpark': {
    need(1, 'a parked id');
    const r = await call('unpark', { parked: args[0] });
    console.log(`${r.type} is back in box ${r.boxId}, version ${r.version}`);
    break;
  }
  case 'discard': {
    need(1, 'a parked id');
    const r = await call('discard', { parked: args[0] });
    console.log(`${r.type} of box ${r.boxId} thrown away`);
    break;
  }
  case 'give': {
    need(2, 'an id and a class');
    const r = await call('give', { id: args[0], type: args[1], qty: args[2] });
    console.log(`given: version ${r.version}; the item appears at the next open`);
    break;
  }
  case 'empty': {
    need(1, 'an id');
    const r = await call('empty', { id: args[0] });
    console.log(`emptied: version ${r.version}`);
    break;
  }
  case 'shelve': {
    need(2, 'an id and a root index');
    const r = await call('shelve', { id: args[0], root: args[1] });
    console.log(`${r.type} is on the shelf as parked ${r.parked}; the box is at version ${r.version}`);
    break;
  }
  case 'restore': {
    need(2, 'the id of the deleted box and the id of a closed box to pour it into');
    const r = await call('restore', { id: args[0], to: args[1] });
    console.log(`${r.roots} root(s) restored: ${args[0]} is at version ${r.fromVersion} and now holds nothing, ${args[1]} at version ${r.toVersion}; the cargo appears at its next open`);
    break;
  }
  case 'move': {
    need(3, 'a source id, a root index and a target id');
    const r = await call('move', { from: args[0], root: args[1], to: args[2] });
    console.log(`${r.type} moved: ${args[0]} is at version ${r.fromVersion}, ${args[2]} at version ${r.toVersion}; it takes a free cell at the next open`);
    break;
  }
  case 'edit': {
    need(3, 'an id, a root index and a node index');
    const extra = {};
    for (const a of args.slice(3)) {
      if (a === 'reset') extra.reset = true;
      else if (a.startsWith('qty=')) extra.quantity = a.slice(4);
      else if (a.startsWith('health=')) extra.health = a.slice(7);
      else {
        console.error(`edit: unknown argument ${a}\n${USAGE}`);
        process.exit(2);
      }
    }
    const r = await call('edit', { id: args[0], root: args[1], node: args[2], ...extra });
    console.log(`${r.type} edited${r.reset ? ', mod state reset' : ''}: version ${r.version}; it takes effect at the next open`);
    break;
  }
  case 'diff': {
    need(2, 'two version ids');
    const r = await call('diff', { a: args[0], b: args[1] });
    console.log(`from version ${r.a} to version ${r.b}:`);
    for (const g of r.gone) console.log(`  - ${g.type} x${g.n}`);
    for (const c of r.came) console.log(`  + ${c.type} x${c.n}`);
    if (!r.gone.length && !r.came.length) console.log('  (the same classes)');
    break;
  }
  case 'health': {
    const r = await call('health', {});
    console.log(`exchange directory: ${r.xchg ? 'ready' : 'not configured'}`);
    console.log(`sign-in on the admin page: ${r.auth ? 'Discord' : 'none, loopback only'}`);
    console.log(`database: ${r.dbBytes} bytes`);
    console.log(`the next clean-up removes ${r.keep ? r.keep.versions : 0} version(s), ${r.keep ? r.keep.events : 0} event(s)`);
    for (const srv of r.servers || []) console.log(`server ${srv.id}: last poll ${srv.at}`);
    console.log('\nboxes SQL believes open:');
    table(r.open, ['box_id', 'class', 'last_seen_at']);
    break;
  }
  case 'close':
  case 'remove':
  case 'report': {
    need(1, 'an id');
    const r = await call(cmd, { id: args[0] });
    console.log(`sent to the engine, ref ${r.ref}; ask for the answer with: node scripts/storage.mjs result ${r.ref}`);
    // No process.exit() after a fetch: Node on Windows aborts (a libuv
    // assertion in async.c) when the process exits with undici's socket
    // still closing -- measured 2026-09-20 on the research CLI.
    let answered = false;
    for (let i = 0; i < 10 && !answered; i++) {
      await new Promise((res) => setTimeout(res, 1000));
      const { result } = await call('result', { ref: r.ref });
      if (result) {
        console.log(`answer: ${result.note}`);
        answered = true;
      }
    }
    if (!answered) console.log('no answer within 10 s (the engine polls the bridge every few seconds; try result later)');
    break;
  }
  case 'result': {
    need(1, 'a ref');
    const { result } = await call('result', { ref: args[0] });
    console.log(result ? `answer: ${result.note} (${result.at})` : 'no answer yet');
    break;
  }
  default:
    console.error(`unknown command ${cmd}\n${USAGE}`);
    process.exit(2);
}
