// `npm test` names its offline suites by hand now, on purpose -- see
// README's Tests section for why (the bare `node --test` used to pick up
// `test/roundtrip.mjs` and its live secret and database along with them).
//
// The cost of a hand-written list is that a new file in `test/` never runs
// on its own; this makes that failure loud instead of silent, by reading
// the list back out of package.json rather than keeping a second copy of
// it anywhere.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const listed = new Set(pkg.scripts.test.match(/test\/[\w.-]+\.mjs/g) || []);
const onDisk = new Set(
  readdirSync(join(root, 'test'))
    .filter((name) => name.endsWith('.mjs') && name !== 'roundtrip.mjs')
    .map((name) => `test/${name}`),
);

const missing = [...onDisk].filter((f) => !listed.has(f)).sort();
const stale = [...listed].filter((f) => !onDisk.has(f)).sort();

for (const f of missing) console.error(`${f} exists but "test" in package.json does not run it`);
for (const f of stale) console.error(`"test" in package.json runs ${f}, which no longer exists`);

process.exit(missing.length || stale.length ? 1 : 0);
