// The class index built on the bridge itself, out of the game's PBOs on
// this host (design 2026-09-20, section 7.3; the owner asked for the game's
// names and a live search): the same parser the admin site runs in the
// browser, loaded from its TypeScript straight into Node (24 strips the
// types), fed by the file system instead of a folder picker. CLASS_PBO_DIRS
// names the folders; the index lands in the same place the site's importer
// puts it, so every admin, every check and the CLI see one index.

import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { importClassIndex } from '../web-src/src/research/classes/classImport.ts';

// A file the parser may read by slices, over a descriptor opened for each
// slice: the parser reads a header and two or three entries per PBO, and
// hundreds of PBOs must not hold hundreds of descriptors open at once.
function fileOnDisk(path, name) {
  const st = statSync(path);
  return {
    name,
    size: st.size,
    lastModified: st.mtimeMs,
    async slice(start, end) {
      const fd = openSync(path, 'r');
      try {
        const buf = new Uint8Array(Math.max(0, end - start));
        readSync(fd, buf, 0, buf.length, start);
        return buf;
      } finally {
        closeSync(fd);
      }
    },
  };
}

// A directory as the parser's discovery walks it.
export function dirOnDisk(path, name = basename(path) || path) {
  return {
    name,
    async children() {
      const out = [];
      for (const e of readdirSync(path, { withFileTypes: true })) {
        const full = join(path, e.name);
        if (e.isDirectory() || (e.isSymbolicLink() && safeIsDir(full))) out.push({ kind: 'dir', name: e.name, dir: dirOnDisk(full, e.name) });
        else if (e.isFile() || e.isSymbolicLink()) out.push({ kind: 'file', name: e.name, open: async () => fileOnDisk(full, e.name) });
      }
      return out;
    },
  };
}

function safeIsDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// CLASS_PBO_DIRS as written in .env: paths separated by ';' (a ':' would
// cut a Windows drive letter).
export function splitDirs(value) {
  return String(value || '').split(';').map((s) => s.trim()).filter(Boolean);
}

// The index of every class under those folders: what the site's importer
// answers, plus the timing. Main thread only (no workers here), no cache
// (the bridge reads the folders once per build).
export async function buildClassIndex(dirs, onProgress) {
  const roots = dirs.filter((d) => safeIsDir(d)).map((d) => dirOnDisk(d));
  if (!roots.length) throw new Error('none of the folders exists');
  const t0 = Date.now();
  const result = await importClassIndex(roots, onProgress, undefined, { workers: 0, cache: null });
  return { raw: result.raw, stats: result.stats, skipped: result.skipped, ms: Date.now() - t0 };
}
