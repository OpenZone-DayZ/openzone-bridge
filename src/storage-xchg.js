// The exchange directory (design 2026-09-19, sections 1 and 3). The game
// writes a close file here under a unique name and tells the bridge; the
// bridge reads it, keeps it as the box's cache, and rewrites that cache only
// for a closed box after an admin changed its version. One owner per file
// at any moment, handover by message, never by watching the directory.

import {
  closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseHeader, WireError } from './storage-wire.js';

// Four signed integers, the engine's persistent id as "b1-b2-b3-b4".
const BOX_ID = /^-?\d{1,11}(--?\d{1,11}){3}$/;
// <boxId>-<YYYYMMDD-HHMMSS>.bin, and nothing that could be a path.
const CLOSE_NAME = /^(-?\d{1,11}(?:--?\d{1,11}){3})-(\d{8}-\d{6})\.bin$/;
const STALE_MS = 5 * 60 * 1000;
// The header is under two hundred bytes; this is how much of a cache is
// read to validate it.
const HEADER_PEEK = 4096;

export class Xchg {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  static isBoxId(id) {
    return BOX_ID.test(String(id ?? ''));
  }

  static closeName(name, boxId) {
    const m = CLOSE_NAME.exec(String(name ?? ''));
    return !!m && m[1] === String(boxId);
  }

  cacheName(boxId) {
    return `${boxId}.bin`;
  }

  cachePath(boxId) {
    return join(this.dir, this.cacheName(boxId));
  }

  readClose(name, boxId) {
    if (!Xchg.closeName(name, boxId)) throw new WireError('not a close file name of this box');
    return readFileSync(join(this.dir, name));
  }

  discard(name) {
    if (!CLOSE_NAME.test(String(name ?? ''))) return;
    try { unlinkSync(join(this.dir, name)); } catch { /* already gone */ }
  }

  promote(name, boxId) {
    if (!Xchg.closeName(name, boxId)) throw new WireError('not a close file name of this box');
    const to = this.cachePath(boxId);
    renameSync(join(this.dir, name), to);
    return statSync(to).size;
  }

  cacheInfo(boxId) {
    const p = this.cachePath(boxId);
    if (!existsSync(p)) return null;
    try {
      const size = statSync(p).size;
      const fd = openSync(p, 'r');
      const head = Buffer.alloc(Math.min(HEADER_PEEK, size));
      try {
        readSync(fd, head, 0, head.length, 0);
      } finally {
        closeSync(fd);
      }
      return { size, stamp: parseHeader(head).stamp };
    } catch {
      return null;
    }
  }

  writeCache(boxId, buf) {
    const p = this.cachePath(boxId);
    writeFileSync(`${p}.part`, buf);
    renameSync(`${p}.part`, p);
    return buf.length;
  }

  dropCache(boxId) {
    try { unlinkSync(this.cachePath(boxId)); } catch { /* no cache to drop */ }
  }

  sweep(knownIds, now = Date.now()) {
    const known = new Set(knownIds);
    const removed = [];
    for (const name of readdirSync(this.dir)) {
      const p = join(this.dir, name);
      let drop = false;
      if (name.endsWith('.part')) {
        drop = true;
      } else if (CLOSE_NAME.test(name)) {
        drop = now - statSync(p).mtimeMs > STALE_MS;
      } else if (name.endsWith('.bin')) {
        drop = !known.has(name.slice(0, -4));
      }
      if (!drop) continue;
      try {
        unlinkSync(p);
        removed.push(name);
      } catch { /* a file in use is swept next time */ }
    }
    return removed;
  }
}
