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
const PLAIN_ID = String.raw`-?\d{1,11}(?:--?\d{1,11}){3}`;
// A PERSONAL STASH is keyed by a pair, not by one id: `s_<anchor>_<uid>`,
// where the anchor is where its locker stands in whole metres and the uid is
// a SteamID64. The game spells it in OZS_Const.StashId and this is the mirror
// of that one line. `-` is not used as a separator on purpose: a persistent
// id is full of them.
const STASH_ID = String.raw`s_\d{1,6}x\d{1,6}_\d{5,20}`;
const BOX_ID = new RegExp(String.raw`^(?:${PLAIN_ID}|${STASH_ID})$`);
// <boxId>-<YYYYMMDD-HHMMSS>.bin, and nothing that could be a path.
// String.raw on the OUTER template too: a plain one would eat the backslashes
// of \d and \. and quietly match far more than it should.
const CLOSE_NAME = new RegExp(String.raw`^((?:${PLAIN_ID}|${STASH_ID}))-(\d{8}-\d{6})\.bin$`);
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

  // What a box id IS, for anyone who has to show it to a person. A plain box
  // has neither an anchor nor an owner; a stash has both, and the three parts
  // are split at the LAST underscore so an anchor key may grow one of its own
  // later. Never throws: an id it does not recognise is simply a box.
  static splitId(id) {
    const s = String(id ?? '');
    if (!s.startsWith('s_')) return { kind: 'box', anchor: '', owner: '' };
    const cut = s.lastIndexOf('_');
    if (cut <= 1) return { kind: 'box', anchor: '', owner: '' };
    return { kind: 'stash', anchor: s.slice(2, cut), owner: s.slice(cut + 1) };
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
