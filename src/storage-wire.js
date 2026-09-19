// The storage wire, version 3 (design 2026-09-19, section 2): the byte
// stream the game writes when a box closes and reads when it opens.
//
// The engine's FileSerializer is a flat stream of raw little-endian values
// -- int32, float32, and strings as int32 length + UTF-8 bytes -- with no
// header of its own (measured on the stand, 2026-09-19). That is what lets
// this module parse every field whose layout it knows and carve the bodies
// it does not: after each root the engine writes the file's random marker,
// and a root's OnStoreSave bodies are whatever sits between the descriptor
// and that marker. Nothing here touches the file system or SQL.

import { randomBytes } from 'node:crypto';

export const VERSION = 3;
export const BIN_END = 20260916;
export const MARKER_BYTES = 16;

// A refusal of bytes, as opposed to a bug: callers turn it into an answer.
export class WireError extends Error {}

export function randomMarker() {
  return randomBytes(MARKER_BYTES);
}

// The engine's stamp format, UTC.
export function stampNow(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

export class Reader {
  constructor(buf, offset = 0) {
    this.buf = buf;
    this.off = offset;
  }

  #need(n) {
    if (this.off + n > this.buf.length) throw new WireError(`truncated at byte ${this.off}`);
  }

  int() {
    this.#need(4);
    const v = this.buf.readInt32LE(this.off);
    this.off += 4;
    return v;
  }

  float() {
    this.#need(4);
    const v = this.buf.readFloatLE(this.off);
    this.off += 4;
    return v;
  }

  str() {
    const n = this.int();
    // A class name or a stamp; anything longer is not a string of ours.
    if (n < 0 || n > 65536) throw new WireError(`string length ${n} at byte ${this.off - 4}`);
    this.#need(n);
    const s = this.buf.toString('utf8', this.off, this.off + n);
    this.off += n;
    return s;
  }

  bytes(n) {
    this.#need(n);
    const b = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return b;
  }
}

export class Writer {
  constructor() {
    this.parts = [];
  }

  int(v) {
    const b = Buffer.alloc(4);
    b.writeInt32LE(v | 0);
    this.parts.push(b);
    return this;
  }

  float(v) {
    const b = Buffer.alloc(4);
    b.writeFloatLE(Number(v) || 0);
    this.parts.push(b);
    return this;
  }

  str(s) {
    const bytes = Buffer.from(String(s ?? ''), 'utf8');
    this.int(bytes.length);
    this.parts.push(bytes);
    return this;
  }

  bytes(b) {
    this.parts.push(Buffer.from(b));
    return this;
  }

  toBuffer() {
    return Buffer.concat(this.parts);
  }
}

export function parseHeader(buf) {
  const r = new Reader(buf);
  const version = r.int();
  if (version !== VERSION) throw new WireError(`format version ${version} is not ${VERSION}`);
  const h = {
    version,
    saveVer: r.int(),
    stamp: r.str(),
    boxClass: r.str(),
    boxId: r.str(),
    roots: r.int(),
    entities: r.int(),
  };
  if (h.roots < 0 || h.entities < 0) throw new WireError('negative counts in the header');
  h.marker = Buffer.from(r.bytes(MARKER_BYTES));
  h.length = r.off;
  return h;
}

// The descriptor of one root's subtree, nodes in depth-first order; the
// body (the engine's own bytes) begins at bodyOffset and is never parsed.
export function parseChunk(chunk) {
  const r = new Reader(chunk);
  const count = r.int();
  if (count < 1 || count > 100000) throw new WireError(`node count ${count}`);
  const nodes = [];
  for (let i = 0; i < count; i++) {
    const n = {
      parent: r.int(),
      type: r.str(),
      locType: r.int(),
      slot: r.int(),
      row: r.int(),
      col: r.int(),
      flip: r.int(),
      health: r.float(),
      quantity: r.float(),
      liquid: r.int(),
      ammo: r.int(),
      hasBlob: r.int(),
    };
    const badParent = i === 0 ? n.parent !== -1 : (n.parent < 0 || n.parent >= i);
    if (badParent) throw new WireError(`node ${i} has parent ${n.parent}`);
    if (!n.type) throw new WireError(`node ${i} has no type`);
    nodes.push(n);
  }
  return { nodes, bodyOffset: r.off };
}

export function buildChunk(nodes, body = Buffer.alloc(0)) {
  const w = new Writer();
  w.int(nodes.length);
  for (const n of nodes) {
    w.int(n.parent).str(n.type).int(n.locType).int(n.slot).int(n.row).int(n.col).int(n.flip)
      .float(n.health).float(n.quantity).int(n.liquid).int(n.ammo).int(n.hasBlob ? 1 : 0);
  }
  w.bytes(body);
  return w.toBuffer();
}

// The same root with its cell forgotten: the engine finds a free one when
// it reads a root at -1/-1 (a parked root coming back, an admin's gift).
export function unplace(chunk) {
  const { nodes, bodyOffset } = parseChunk(chunk);
  const moved = nodes.map((n, i) => (i === 0 ? { ...n, row: -1, col: -1 } : n));
  return buildChunk(moved, chunk.subarray(bodyOffset));
}

export function typesOf(nodes) {
  return [...new Set(nodes.map((n) => n.type))].sort();
}

export function buildFile(header, chunks) {
  const marker = randomMarker();
  let entities = 0;
  for (const c of chunks) entities += parseChunk(c).nodes.length;
  const w = new Writer();
  w.int(VERSION).int(header.saveVer | 0).str(header.stamp).str(header.boxClass).str(header.boxId)
    .int(chunks.length).int(entities).bytes(marker);
  for (const c of chunks) w.bytes(c).bytes(marker);
  w.int(BIN_END);
  return w.toBuffer();
}

export function parseFile(buf) {
  const header = parseHeader(buf);
  const chunks = [];
  let at = header.length;
  for (let i = 0; i < header.roots; i++) {
    const end = buf.indexOf(header.marker, at);
    if (end < 0) throw new WireError(`root ${i} of ${header.roots} has no marker after it`);
    chunks.push(buf.subarray(at, end));
    at = end + MARKER_BYTES;
  }
  if (buf.length !== at + 4) throw new WireError(`${buf.length - at} byte(s) after the last root, 4 expected`);
  if (buf.readInt32LE(at) !== BIN_END) throw new WireError('the trailer is not BIN_END');
  const roots = chunks.map((bytes, i) => {
    try {
      return { bytes, nodes: parseChunk(bytes).nodes };
    } catch (e) {
      throw new WireError(`root ${i}: ${e.message}`);
    }
  });
  let entities = 0;
  for (const r of roots) entities += r.nodes.length;
  if (entities !== header.entities) throw new WireError(`header says ${header.entities} entities, the roots hold ${entities}`);
  return { header, roots };
}
