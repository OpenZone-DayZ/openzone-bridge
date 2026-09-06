// `npm run check` -- does every file in the repository still parse?
//
// The script it replaces named five of thirteen sources by hand, so a file
// added after it was written was never checked. This walks the directories
// instead, which cannot go stale.

import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

let bad = 0;
let seen = 0;

for (const dir of ['src', 'test', 'scripts']) {
  for (const name of readdirSync(dir)) {
    if (!/\.m?js$/.test(name)) continue;
    seen++;
    try {
      execFileSync(process.execPath, ['--check', `${dir}/${name}`], { stdio: 'pipe' });
    } catch (err) {
      bad++;
      console.error(String(err.stderr || err.message));
    }
  }
}

console.log(bad ? `${bad} of ${seen} file(s) did not parse` : `${seen} files parse`);
process.exit(bad ? 1 : 0);
