// The two dictionaries of the admin site hold the same keys and no empty
// words. Read as text, without a build: each file is a plain object with
// one `key: '...'` per line.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'web-src', 'src', 'i18n');

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

function keysOf(file) {
  const text = readFileSync(join(dir, file), 'utf8');
  const keys = new Map();
  const dupes = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s{2}([A-Za-z_][A-Za-z0-9_]*):\s*'((?:[^'\\]|\\.)*)',\s*$/.exec(line);
    if (!m) continue;
    if (keys.has(m[1])) dupes.push(m[1]);
    keys.set(m[1], m[2]);
  }
  return { keys, dupes };
}

const en = keysOf('en.ts');
const uk = keysOf('uk.ts');
ok('the English dictionary is not empty', en.keys.size > 50, true);
ok('no key is declared twice', [en.dupes, uk.dupes], [[], []]);
ok('every English key exists in Ukrainian', [...en.keys.keys()].filter((k) => !uk.keys.has(k)), []);
ok('every Ukrainian key exists in English', [...uk.keys.keys()].filter((k) => !en.keys.has(k)), []);
ok('no word is empty', [...en.keys.entries(), ...uk.keys.entries()].filter(([, v]) => v.trim() === '').map(([k]) => k), []);
// A placeholder used in one language must be used in the other: a {v}
// that only English fills would print a bare number in Ukrainian.
const holes = (v) => (v.match(/\{[a-z]+\}/g) || []).sort().join(' ');
ok('placeholders match in both languages', [...en.keys.keys()].filter((k) => uk.keys.has(k) && holes(en.keys.get(k)) !== holes(uk.keys.get(k))), []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
