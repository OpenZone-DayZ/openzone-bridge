// The single executable (Node SEA): one bundle of src/ and its
// dependencies, a SEA blob, node.exe with the blob injected, and a release
// folder beside it with everything the exe reads at runtime. Build time
// only -- the host never compiles anything.
//
//   npm run build:sea      -> dist/openzone-bridge-<version>-win-x64/ and .zip

import { build } from 'esbuild';
import { inject } from 'postject';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const name = `openzone-bridge-${pkg.version}-${process.platform}-${process.arch}`;

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// 1. One CommonJS file. The optional native accelerators of ws and
// discord.js stay external: the exe's require() reaches built-ins only,
// and both libraries fall back on their own when a require throws.
await build({
  entryPoints: [join(root, 'src', 'index.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  outfile: join(dist, 'bridge.cjs'),
  external: ['bufferutil', 'utf-8-validate', 'zlib-sync', 'erlpack', '@discordjs/opus'],
  logLevel: 'warning',
  banner: { js: `// openzone-bridge ${pkg.version}, one file, built by scripts/build-sea.mjs` },
});

// 2. The SEA blob, from the bundle.
writeFileSync(join(dist, 'sea-config.json'), JSON.stringify({
  main: 'bridge.cjs',
  output: 'sea-prep.blob',
  disableExperimentalSEAWarning: true,
}, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', 'sea-config.json'], { cwd: dist, stdio: 'inherit' });

// 3. node.exe with the blob inside.
const exeName = process.platform === 'win32' ? 'openzone-bridge.exe' : 'openzone-bridge';
const exe = join(dist, exeName);
copyFileSync(process.execPath, exe);
await inject(exe, 'NODE_SEA_BLOB', readFileSync(join(dist, 'sea-prep.blob')), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
});

// 4. The release folder: what the exe reads beside itself.
const out = join(dist, name);
mkdirSync(out);
copyFileSync(exe, join(out, exeName));
// The admin site as built by `npm run build`: the exe serves web/dist beside
// itself, and a release without it would serve the stub page to every admin.
const site = join(root, 'web', 'dist');
if (!existsSync(join(site, 'index.html'))) {
  console.error('web/dist/index.html is missing: run `npm run build` before `npm run build:sea`');
  process.exit(1);
}
cpSync(site, join(out, 'web', 'dist'), { recursive: true });
for (const f of ['.env.example', 'README.md', 'SETUP.md', 'LICENSE']) copyFileSync(join(root, f), join(out, f));

// 5. The zip, with the platform's own tool.
if (process.platform === 'win32') {
  execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${out}\\*' -DestinationPath '${out}.zip' -Force`], { stdio: 'inherit' });
} else {
  execFileSync('zip', ['-qr', `${out}.zip`, name], { cwd: dist, stdio: 'inherit' });
}
console.log(`built ${out} and ${out}.zip`);
