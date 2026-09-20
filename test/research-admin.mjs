// The admin side of research (design 2026-09-20, section 6): candidates
// into a throwaway exchange directory, commands into a captured push, the
// shape check, the reads of the game's own files. Offline.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { ResearchStore } from '../src/research-store.js';
import { ResearchXchg, NAMES } from '../src/research-xchg.js';
import { researchAdmin } from '../src/research-admin.js';

const path = join(tmpdir(), `oz-research-admin-${process.pid}.sqlite`);
for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) unlinkSync(f);
const dir = mkdtempSync(join(tmpdir(), 'oz-research-dir-'));

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

const OWNERS = { Version: 1, Owners: [{ Id: 'loner', DeviceClasses: ['OZL_Microscope'], TerminalClasses: ['OZL_LabComputer'] }] };
writeFileSync(join(dir, 'OZ_Research_Owners.json'), '﻿' + JSON.stringify(OWNERS, null, 4), 'utf8');
writeFileSync(join(dir, 'OZ_Research_Settings.json'), JSON.stringify({ Version: 1, DefaultOwner: 'loner', ResearchPost: '', BasePost: 'research', TreeVisibilityDepth: 1 }, null, 4), 'utf8');
mkdirSync(join(dir, 'research', 'xchg'), { recursive: true });
writeFileSync(join(dir, 'research', 'loner.json'), JSON.stringify({ Version: 1, Points: [{ Key: 'bio_field_t1', Value: 12 }], CompletedNodes: ['pb_osnovy'], ActiveProjects: [{ NodeId: 'pb_bio', StarterUid: '7656', EndSec: 100 }] }), 'utf8');
writeFileSync(join(dir, 'research', 'broken.json'), '{oops', 'utf8');
writeFileSync(join(dir, 'research', 'xchg', 'classes.txt'), 'access\r\nAll\r\nOZL_Microscope\r\n\r\n', 'utf8');

console.log('the exchange directory');

let threw = '';
try {
  new ResearchXchg(join(dir, 'nope'));
} catch (e) {
  threw = e.message.startsWith('no such directory') ? 'refused' : e.message;
}
ok('a missing directory is refused at construction', threw, 'refused');
const x = new ResearchXchg(dir);
ok('the exchange directory is research/xchg under it', x.xchgDir, join(dir, 'research', 'xchg'));
ok('a tag names its file', ResearchXchg.fileOf('ResearchPointTypes'), 'OZ_Research_PointTypes.json');
ok('the nine names are known, nothing else', [NAMES.length, ResearchXchg.isName('ResearchOwners'), ResearchXchg.isName('Owners')], [9, true, false]);
const owners = await x.readConfig('ResearchOwners');
ok('a config is read without its BOM', owners.text.charCodeAt(0), '{'.charCodeAt(0));
ok('a missing config is null', await x.readConfig('ResearchRules'), null);
writeFileSync(join(dir, 'OZ_Research_Tree.json'), '{"Version":1,"Branches":[', 'utf8');
threw = '';
try {
  await x.readConfig('ResearchTree');
} catch (e) {
  threw = e.message.split(':')[0];
}
ok('a file that is not json is reported by name after a retry', threw, 'OZ_Research_Tree.json is not json');
unlinkSync(join(dir, 'OZ_Research_Tree.json'));
ok('states are read, a broken one in place', x.readStates().map((s) => [s.owner, s.points.length, s.completed, s.projects.length, !!s.error]), [['broken', 0, [], 0, true], ['loner', 1, ['pb_osnovy'], 1, false]]);
ok('classes are read one per line, blanks dropped', x.readClasses().names, ['access', 'All', 'OZL_Microscope']);
ok('a candidate name carries the config and the token', ResearchXchg.candidateName('ResearchOwners', 'abcdef012345'), 'ResearchOwners.abcdef012345.json');
ok('and parses back', ResearchXchg.parseCandidate('ResearchOwners.abcdef012345.json'), { name: 'ResearchOwners', token: 'abcdef012345' });
ok('a path is not a candidate name', ResearchXchg.parseCandidate('../ResearchOwners.abcdef012345.json'), null);
const file = x.writeCandidate('ResearchOwners', 'abcdef012345', '{"Version":1}');
ok('writeCandidate leaves the file and no part', [existsSync(join(x.xchgDir, file)), readdirSync(x.xchgDir).some((f) => f.endsWith('.part'))], [true, false]);
writeFileSync(join(x.xchgDir, 'ResearchOwners.000000000000.json.part'), 'half', 'utf8');
writeFileSync(join(x.xchgDir, 'ResearchOwners.111111111111.json'), '{}', 'utf8');
ok('sweep drops parts and candidates of finished commands, keeps the named ones and classes.txt', x.sweep(['abcdef012345']).sort(), ['ResearchOwners.000000000000.json.part', 'ResearchOwners.111111111111.json']);
ok('the kept candidate is still there', x.hasCandidate(file), true);
ok('discard removes it', [x.discard(file), x.hasCandidate(file)], [true, false]);

console.log('admin ops');

const base = new Store(path);
const s = new ResearchStore(base);
const pushed = [];
const admin = researchAdmin({ store: s, xchg: x, push: (o) => pushed.push(o), status: () => ({ booted: [], classes: 3 }) });

const cfgs = admin.configs().configs;
ok('configs lists the nine, with what is on disk', [cfgs.length, cfgs.find((c) => c.name === 'ResearchOwners').exists, cfgs.find((c) => c.name === 'ResearchRules').exists], [9, true, false]);
const got = await admin.config({ name: 'ResearchOwners' });
ok('config with no version yet reads the file and makes version 1', [got.ok, got.version, got.status, got.source, JSON.parse(got.text).Owners[0].Id], [true, 1, 'applied', 'game', 'loner']);
ok('config of an unknown name is refused', await admin.config({ name: 'Owners' }), { ok: false, why: 'unknown config' });
ok('config of a missing file is refused', await admin.config({ name: 'ResearchRules' }), { ok: false, why: 'no such file' });
ok('config of an unknown version is refused', await admin.config({ name: 'ResearchOwners', version: 7 }), { ok: false, why: 'no such version' });

ok('save refuses text that is not json, without a file or a command', [await admin.save({ name: 'ResearchOwners', json: '{oops', admin: 'tester' }), readdirSync(x.xchgDir).length, pushed.length],
  [{ ok: false, why: 'not json: Expected property name or \'}\' in JSON at position 1 (line 1 column 2)' }, 1, 0]);
ok('save refuses a missing Version', (await admin.save({ name: 'ResearchOwners', json: '{"Owners":[]}', admin: 'tester' })).why, 'Version must be a positive integer');
ok('save refuses the wrong shape', (await admin.save({ name: 'ResearchOwners', json: '{"Version":1,"Owners":{}}', admin: 'tester' })).why, 'Owners must be an array');
ok('save refuses an array', (await admin.save({ name: 'ResearchOwners', json: '[]', admin: 'tester' })).why, 'not an object');
ok('save refuses an unknown config', (await admin.save({ name: 'Nope', json: '{}', admin: 'tester' })).why, 'unknown config');

const edited = { ...OWNERS, Owners: [{ ...OWNERS.Owners[0], DeviceClasses: ['OZL_Microscope', 'OZL_Centrifuge'] }] };
const saved = await admin.save({ name: 'ResearchOwners', json: JSON.stringify(edited), admin: 'tester' });
ok('save answers a token, the version and the file', [saved.ok, saved.token.length, saved.version, saved.file], [true, 12, 2, `ResearchOwners.${saved.token}.json`]);
ok('the candidate is in the exchange directory, pretty-printed', readFileSync(join(x.xchgDir, saved.file), 'utf8').startsWith('{\n    "Version": 1,'), true);
ok('the command went to the game, short', [pushed.length, pushed[0].op, pushed[0].name, pushed[0].file, pushed[0].by, pushed[0].token === saved.token, JSON.stringify(pushed[0]).length < 800], [1, 'cfg_apply', 'ResearchOwners', saved.file, 'tester', true, true]);
ok('the version is pending with the token', [s.latest('ResearchOwners').status, s.latest('ResearchOwners').token === saved.token, s.latest('ResearchOwners').by], ['pending', true, 'tester']);
ok('the command is sent, not answered', s.command(saved.token).status, 'sent');
ok('result before the answer shows the pending version', admin.result({ token: saved.token }).result.version, { name: 'ResearchOwners', version: 2, status: 'pending', why: '' });
ok('result of an unknown token is null', admin.result({ token: '000000000000' }), { ok: true, result: null });
ok('result of a bad token is refused', admin.result({ token: 'x' }), { ok: false, why: 'bad token' });
ok('history lists both versions newest first', admin.history({ name: 'ResearchOwners' }).versions.map((v) => [v.version, v.status]), [[2, 'pending'], [1, 'applied']]);

const restored = await admin.restore({ name: 'ResearchOwners', version: 1, admin: 'tester' });
ok('restore makes a candidate out of an old version', [restored.ok, restored.version, pushed.length, pushed[1].op], [true, 3, 2, 'cfg_apply']);
ok('restore of an unknown version is refused', await admin.restore({ name: 'ResearchOwners', version: 9, admin: 'tester' }), { ok: false, why: 'no such version' });
ok('saving the current text again is still a candidate', (await admin.save({ name: 'ResearchOwners', json: JSON.stringify(OWNERS), admin: 'tester' })).version, 4);

const g = admin.grant({ owner: 'loner', type: 'bio_field_t1', amount: '3', admin: 'tester' });
ok('grant is a command with its arguments', [g.ok, pushed.at(-1).op, pushed.at(-1).owner, pushed.at(-1).type, pushed.at(-1).amount, pushed.at(-1).token === g.token], [true, 'grant', 'loner', 'bio_field_t1', '3', true]);
ok('grant refuses a bad owner, type or amount', [admin.grant({ owner: 'a b', type: 't', amount: 1 }).why, admin.grant({ owner: 'a', type: '', amount: 1 }).why, admin.grant({ owner: 'a', type: 't', amount: 'x' }).why], ['bad owner', 'bad point type', 'bad amount']);
ok('reset, complete, reload, respawn are commands too', [admin.reset({ owner: 'loner', admin: 'tester' }).ok, admin.complete({ owner: 'loner', node: 'pb_osnovy', admin: 'tester' }).ok, admin.reload({ admin: 'tester' }).ok, admin.respawn({ id: 'lab_1', admin: 'tester' }).ok, pushed.slice(-4).map((p) => p.op)],
  [true, true, true, true, ['reset', 'complete', 'reload', 'respawn']]);
ok('a long admin name is cut, not refused', pushed.at(-1).by.length <= 40, true);
ok('commands are all unanswered', s.unanswered().length, 8);
ok('state reads the owners', admin.state().owners.map((o) => o.owner), ['broken', 'loner']);
ok('classes reads the dump', admin.classes().count, 3);
ok('events name the admin', admin.events({ limit: 3 }).events.map((e) => [e.kind, e.admin]), [['admin_respawn', 'tester'], ['admin_reload', 'tester'], ['admin_complete', 'tester']]);
ok('status carries the kind\'s facts', [admin.status().configured, admin.status().classes, admin.status().unanswered], [true, 3, 8]);

console.log('the class index');

ok('no index yet', admin.classindex(), { ok: true, index: null, at: '' });
ok('a broken index is refused', [admin.classindexput({ index: { v: 3 }, admin: 'tester' }).why, admin.classindexput({ index: { v: 3, mods: [], classes: [['x']] }, admin: 'tester' }).why], ['not a class index', 'a broken class row']);
const idx = { v: 3, generated: '2026-09-20', mods: ['vanilla'], classes: [['Apple', -1, 0, 0, 'Apple', 'Apple']] };
ok('an index is stored and counted', admin.classindexput({ index: idx, admin: 'tester' }), { ok: true, classes: 1, mods: 1 });
ok('and answered whole, with when', [admin.classindex().index.classes.length, admin.classindex().at !== ''], [1, true]);
ok('as text too', admin.classindexput({ index: JSON.stringify(idx), admin: 'tester' }).ok, true);
ok('the journal names it', admin.events({ limit: 1 }).events[0].kind, 'admin_classindex');

console.log('admin ops without a directory');

const offAdmin = researchAdmin({ store: s, xchg: null, push: (o) => pushed.push(o) });
ok('every op refuses in words', [offAdmin.configs(), await offAdmin.save({ name: 'ResearchOwners', json: '{}' }), offAdmin.grant({ owner: 'a', type: 'b', amount: 1 })], [{ ok: false, why: 'research not configured' }, { ok: false, why: 'research not configured' }, { ok: false, why: 'research not configured' }]);
ok('status says so', offAdmin.status().configured, false);

console.log(`\n${pass} passed, ${fail} failed`);
base.close();
for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) unlinkSync(f);
rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
