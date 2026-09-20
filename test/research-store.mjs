// The research tables (design 2026-09-20, section 6), offline against a
// throwaway SQLite file: versions deduplicated by a canonical hash, a
// candidate promoted by the game's rewrite of it, commands from queued to
// answered, the journal, retention.

import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { ResearchStore, canonical, hashOfText } from '../src/research-store.js';

const path = join(tmpdir(), `oz-research-store-${process.pid}.sqlite`);
for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) unlinkSync(f);

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

const base = new Store(path);
const s = new ResearchStore(base);

console.log('the canonical hash');

ok('key order and formatting do not matter', hashOfText('{"Version": 1, "Owners": [{"Id": "loner", "Name": "x"}]}'), hashOfText('{"Owners":[{"Name":"x","Id":"loner"}],"Version":1.0}'));
ok('a value does', hashOfText('{"Version":1}') === hashOfText('{"Version":2}'), false);
ok('canonical sorts keys at every depth', canonical({ b: [{ z: 1, a: 2 }], a: null }), '{"a":null,"b":[{"a":2,"z":1}]}');
ok('text that is not json is still hashed', hashOfText('{oops').length, 64);

console.log('versions');

const v1 = s.snapshot({ name: 'ResearchOwners', text: '{"Version":1,"Owners":[]}', by: 'game', at: '2026-09-20 10:00:00' });
ok('the first applied text is version 1', [v1.version, v1.fresh, v1.promoted], [1, true, false]);
const again = s.snapshot({ name: 'ResearchOwners', text: '{"Owners": [], "Version": 1}', by: 'game', at: '2026-09-20 10:00:05' });
ok('the same text again is not a new version', [again.version, again.fresh], [1, false]);
const v2 = s.snapshot({ name: 'ResearchOwners', text: '{"Version":1,"Owners":[{"Id":"loner"}]}', by: 'vpp', at: '2026-09-20 10:01:00' });
ok('a different text is version 2', [v2.version, v2.fresh], [2, true]);
ok('current is the newest applied one', [s.current('ResearchOwners').version, s.current('ResearchOwners').by], [2, 'vpp']);
ok('the text of a version is kept whole', s.text(s.version('ResearchOwners', 1).hash), '{"Version":1,"Owners":[]}');
ok('versions of another name start at 1', s.snapshot({ name: 'ResearchTree', text: '{"Version":1,"Branches":[]}' }).version, 1);
ok('an unknown version is null', s.version('ResearchOwners', 9), null);

console.log('a candidate and its promotion');

const cand = s.snapshot({ name: 'ResearchOwners', text: '{"Version":1,"Owners":[{"Id":"loner"},{"Id":"bandit"}]}', by: 'covalschi', source: 'admin', status: 'pending', token: 'abcdef012345', at: '2026-09-20 10:02:00' });
ok('a pending text is always a new version', [cand.version, cand.fresh], [3, true]);
ok('current stays the applied one', s.current('ResearchOwners').version, 2);
ok('latest is the pending one', [s.latest('ResearchOwners').version, s.latest('ResearchOwners').status, s.latest('ResearchOwners').token], [3, 'pending', 'abcdef012345']);
ok('pendingCount counts it', s.pendingCount('ResearchOwners'), 1);
const rewrite = s.snapshot({ name: 'ResearchOwners', text: '{\n    "Version": 1,\n    "Owners": [\n        { "Id": "loner" },\n        { "Id": "bandit" }\n    ]\n}', by: 'bridge:covalschi', at: '2026-09-20 10:02:03' });
ok('the game\'s rewrite of the candidate promotes it, not a fourth version', [rewrite.version, rewrite.fresh, rewrite.promoted], [3, false, true]);
ok('and it is applied now, by the admin who wrote it', [s.version('ResearchOwners', 3).status, s.version('ResearchOwners', 3).by, s.version('ResearchOwners', 3).source], ['applied', 'covalschi', 'admin']);
ok('applied by token is idempotent', s.applied('abcdef012345').status, 'applied');
const cand2 = s.snapshot({ name: 'ResearchOwners', text: '{"Version":99,"Owners":[]}', by: 'covalschi', source: 'admin', status: 'pending', token: 'fedcba543210', at: '2026-09-20 10:03:00' });
ok('a second candidate is version 4', cand2.version, 4);
ok('rejected by token keeps the reason', [s.rejected('fedcba543210', 'version 99 is newer than this build knows').status, s.version('ResearchOwners', 4).why], ['rejected', 'version 99 is newer than this build knows']);
ok('rejected of an unknown token is null', s.rejected('000000000000', 'x'), null);
ok('the same text applied later by the game is a new version, not the rejected one', s.snapshot({ name: 'ResearchOwners', text: '{"Version":99,"Owners":[]}', by: 'game', at: '2026-09-20 10:04:00' }).version, 5);
ok('versions lists newest first', s.versions('ResearchOwners', 2).map((v) => v.version), [5, 4]);
let threw = '';
try {
  s.snapshot({ name: 'ResearchOwners', text: '{}', status: 'weird' });
} catch (e) {
  threw = e.message;
}
ok('a bad status is refused', threw, 'bad status: weird');

console.log('commands');

const c = s.queue({ token: '111111111111', op: 'grant', args: { owner: 'loner', type: 'bio_field_t1', amount: '3' }, by: 'covalschi', serverId: 'stand', at: '2026-09-20 10:05:00' });
ok('queue answers the command with its args parsed', [c.token, c.op, c.status, c.args.amount, c.by], ['111111111111', 'grant', 'queued', '3', 'covalschi']);
s.queue({ token: '222222222222', op: 'reload', args: {}, by: 'covalschi', at: '2026-09-20 10:05:01' });
ok('unanswered lists both in order', s.unanswered().map((x) => x.token), ['111111111111', '222222222222']);
s.sent(['111111111111']);
ok('sent changes the status', s.command('111111111111').status, 'sent');
ok('and the command is still unanswered', s.unanswered().length, 2);
const a = s.answer('111111111111', true, '', 'points=bio_field_t1:15', '2026-09-20 10:05:10');
ok('answer stores the note', [a.status, a.ok, a.answer, a.already], ['answered', true, 'points=bio_field_t1:15', false]);
ok('a second answer says already', s.answer('111111111111', false, 'late', '').already, true);
ok('and keeps the first one', s.command('111111111111').answer, 'points=bio_field_t1:15');
ok('a refusal stores the why', s.answer('222222222222', false, 'unknown op', '').answer, 'unknown op');
ok('an unknown token is null', s.answer('333333333333', true, '', ''), null);
ok('nothing is unanswered now', s.unanswered().length, 0);
ok('keepTokens names the refused one, not the answered one', s.keepTokens(), ['222222222222']);
ok('commands lists newest first', s.commands(5).map((x) => x.token), ['222222222222', '111111111111']);

console.log('journal and retention');

s.record({ kind: 'boot', note: 'revision 3', serverId: 'stand', at: '2026-09-20 10:06:00' });
s.record({ kind: 'admin_grant', note: 'loner bio_field_t1 3', admin: 'covalschi', token: '111111111111', at: '2026-09-20 10:06:01' });
ok('events newest first', s.events(10).map((e) => e.kind), ['admin_grant', 'boot']);
ok('events of one server keep the bridge’s own', s.events(10, 'other').map((e) => e.kind), ['admin_grant']);
ok('and the server’s', s.events(10, 'stand').map((e) => e.kind), ['admin_grant', 'boot']);
// Four: Owners 1..4 (the rejected one too); never a config's current version, never a pending one.
ok('keepPreview counts old versions but never the current or the pending', s.keepPreview({ versionsDays: 0, eventsDays: 0, now: new Date('2030-01-01T00:00:00Z') }), { versions: 4, events: 2 });
const kept = s.keep({ versionsDays: 0, eventsDays: 0, now: new Date('2030-01-01T00:00:00Z') });
// Three blobs, not four: the rejected version 4 shares its text with the current version 5.
ok('keep removes them, their blobs, the events and the answered commands', kept, { versions: 4, blobs: 3, events: 2, commands: 2 });
ok('the current version survives', [s.current('ResearchOwners').version, s.text(s.current('ResearchOwners').hash) !== null], [5, true]);
ok('a far cut-off removes nothing', s.keep({ versionsDays: 36500, eventsDays: 36500 }), { versions: 0, blobs: 0, events: 0, commands: 0 });

console.log(`\n${pass} passed, ${fail} failed`);
base.close();
for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) unlinkSync(f);
process.exit(fail ? 1 : 0);
