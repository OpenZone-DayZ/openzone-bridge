// Boxes by their position on a square world. A grid of the world's size
// (ADMIN_MAP_SIZE, metres), a map image under it when the bridge has one
// (ADMIN_MAP_IMAGE, served as admin/map.png), a pin per box.

import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useLang } from '../i18n';
import { go } from '../app/router';
import { Loading, Notice } from '../ui/bits';
import { parsePos, type Box, type Health, type Locker } from './model';

const DEFAULT_SIZE = 15360;

export function MapPage() {
  const { s } = useLang();
  const [boxes, setBoxes] = useState<Box[] | null>(null);
  const [lockers, setLockers] = useState<Locker[]>([]);
  const [map, setMap] = useState<{ size: number; image: boolean }>({ size: DEFAULT_SIZE, image: false });
  const [why, setWhy] = useState('');
  const [hover, setHover] = useState<Box | null>(null);
  useEffect(() => {
    api<{ boxes: Box[]; lockers?: Locker[] }>('storage', 'boxes').then((r) => {
      if (!r.ok) return setWhy(r.why);
      setBoxes(r.boxes.filter((b) => b.status !== 'removed' && b.kind !== 'stash'));
      setLockers(r.lockers || []);
    });
    api<Health>('storage', 'health').then((r) => {
      if (r.ok && r.map) setMap({ size: r.map.size || DEFAULT_SIZE, image: !!r.map.image });
    });
  }, []);
  const pins = (boxes || []).map((b) => ({ b, p: parsePos(b.pos) })).filter((x) => x.p !== null) as { b: Box; p: { x: number; y: number; z: number } }[];
  // A LOCKER IS A PIN TOO (owner, 2026-09-27): the bridge lists one per
  // anchor with its spot, and the click opens the locker's page, where the
  // players' stashes are one pick away.
  const lockerPins = lockers.map((l) => ({ l, p: parsePos(l.pos) })).filter((x) => x.p !== null) as { l: Locker; p: { x: number; y: number; z: number } }[];
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / map.size) * 100))}%`;
  const lines = [];
  for (let i = 1; i < 8; i++) lines.push((i / 8) * 100);
  return (
    <>
      <h1>{s('nav_map')}</h1>
      <p className="muted small">{s('map_help')} {s('map_size')}: {map.size}.</p>
      {why && <Notice tone="bad">{why}</Notice>}
      {!boxes && !why && <Loading />}
      {boxes && !pins.length && !lockerPins.length && <p className="muted">{s('map_none')}</p>}
      {boxes && (
        <div className="map" onMouseLeave={() => setHover(null)}>
          {map.image && <img src="admin/map.png" alt="" />}
          {lines.map((l) => <span key={`h${l}`} className="gridline" style={{ left: 0, right: 0, top: `${l}%`, height: 1 }} />)}
          {lines.map((l) => <span key={`v${l}`} className="gridline" style={{ top: 0, bottom: 0, left: `${l}%`, width: 1 }} />)}
          {pins.map(({ b, p }) => (
            <span
              key={b.box_id}
              className={`pin${b.status === 'open' ? ' open' : ''}`}
              style={{ left: pct(p.x), top: pct(map.size - p.z) }}
              onMouseEnter={() => setHover(b)}
              onClick={() => go('storage', 'box', b.box_id)}
            />
          ))}
          {lockerPins.map(({ l, p }) => (
            <span
              key={`l${l.anchor}`}
              className="pin locker"
              style={{ left: pct(p.x), top: pct(map.size - p.z) }}
              title={`${l.name ? `${l.name} · ` : ''}${s('locker')} ${l.anchor} · ${s('stashes_n', { n: l.stashes.length })}`}
              onMouseEnter={() => setHover(null)}
              onClick={() => go('storage', 'locker', l.anchor)}
            />
          ))}
          {hover && hover.pos && parsePos(hover.pos) && (
            <span className="label" style={{ left: pct(parsePos(hover.pos)!.x), top: pct(map.size - parsePos(hover.pos)!.z) }}>
              {hover.name ? `${hover.name} · ` : ''}{hover.box_id} · {hover.class} · {hover.entities ?? 0}
            </span>
          )}
        </div>
      )}
    </>
  );
}
