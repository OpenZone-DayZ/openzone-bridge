// What the storage api answers, and the few facts the pages share about
// boxes: sizes, cells, how items group into roots.

export type Box = {
  box_id: string;
  class: string;
  pos: string;
  placed_at: string;
  placed_by: string;
  removed_at: string;
  status: 'closed' | 'open' | 'removed' | string;
  current_version: number;
  last_seen_at: string;
  // Whether the chosen server had the box in the world at its last boot
  // (storage-admin.js), and when that boot was.
  in_world?: 'yes' | 'no' | 'unknown';
  world_boot?: string;
  // The cargo in cells, counted by the bridge out of the server's class
  // sizes (the box page only): used, the box's own, and how many items the
  // dump could not size (counted as one cell each).
  cells?: { used: number; max: number; unknown: number };
  cache_stamp: string;
  cache_size: number;
  roots?: number;
  entities?: number;
};

export type Item = {
  box_id: string;
  root_idx: number;
  node_idx: number;
  parent: number;
  type: string;
  loc_type: number;
  slot: number;
  row: number;
  col: number;
  flip: number;
  health: number;
  quantity: number;
  liquid: number;
  ammo: number;
  has_blob: number;
};

export type Version = {
  id: number;
  box_id: string;
  stamp: string;
  created_at: string;
  source: string;
  save_version: number;
  roots: number;
  entities: number;
  note: string;
};

export type Event = {
  id: number;
  at: string;
  kind: string;
  box_id: string;
  uid: string;
  name: string;
  type: string;
  qty: number;
  row: number;
  col: number;
  slot: string;
  note: string;
  server_id: string;
  admin: string;
};

export type Parked = {
  id: number;
  box_id: string;
  parked_at: string;
  reason: string;
  type: string;
  types: string;
  hash: string;
  from_version: number;
  restored_at: string;
};

export type Found = Item & { status: string; box_class: string; pos: string };

export type Diff = { a: number; b: number; gone: { type: string; n: number }[]; came: { type: string; n: number }[] };

export type Health = {
  xchg: boolean;
  auth: boolean;
  dbBytes: number;
  servers: { id: string; at: string }[];
  keep: { versions: number; events: number } | null;
  open: { box_id: string; class: string; last_seen_at: string }[];
  map?: { size: number; image: boolean };
};

export type LiveResult = { at: string; kind: string; note: string };

export const COLS = 10;
export const SIZES: Record<string, { rows: number; key: 'size_small' | 'size_medium' | 'size_large' }> = {
  OZ_StorageBox_Small: { rows: 25, key: 'size_small' },
  OZ_StorageBox_Medium: { rows: 50, key: 'size_medium' },
  OZ_StorageBox_Large: { rows: 100, key: 'size_large' },
};

export const num = (v: number): number => Math.round(v * 100) / 100;

export function cellOf(i: { loc_type: number; slot: number; row: number; col: number }, slotWord: string): string {
  if (i.loc_type === 2) return `${slotWord} ${i.slot}`;
  return i.row >= 0 ? `${i.row},${i.col}` : '—';
}

export function eventCell(e: Event): string {
  return e.slot || (e.row >= 0 ? `${e.row},${e.col}` : '');
}

export function groupRoots(items: Item[]): Item[][] {
  const roots: Item[][] = [];
  for (const it of items) {
    if (!roots[it.root_idx]) roots[it.root_idx] = [];
    roots[it.root_idx].push(it);
  }
  return roots;
}

export function rowsOf(box: Box, items: Item[]): number {
  const size = SIZES[box.class];
  if (size) return size.rows;
  let rows = 5;
  for (const i of items) if (i.row + 1 > rows) rows = i.row + 1;
  return Math.min(rows, 30);
}

export const shortType = (type: string): string => type.replace(/^OZ_/, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 6);

export const isOk = (note: string): boolean => /^ok\b/.test(note);

export const stripRef = (note: string): string => String(note || '').replace(/^[0-9a-f]{12}: /, '');

// "x y z" as the game writes a position, to numbers; null when it is not one.
export function parsePos(pos: string): { x: number; y: number; z: number } | null {
  const m = String(pos || '').trim().split(/\s+/).map(Number);
  if (m.length !== 3 || m.some((v) => !Number.isFinite(v))) return null;
  return { x: m[0], y: m[1], z: m[2] };
}
