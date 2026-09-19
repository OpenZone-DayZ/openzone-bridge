// Where the bridge lives: the repository root when run from the sources,
// the executable's own folder when run as a single executable (Node SEA).
// Everything the bridge reads or writes beside itself -- .env, state/,
// web/ -- hangs off this, so the exe works from any current directory.

import { isSea } from 'node:sea';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOME = isSea() ? dirname(process.execPath) : join(dirname(fileURLToPath(import.meta.url)), '..');
