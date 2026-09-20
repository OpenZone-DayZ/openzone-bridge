// Boxes by their position on a square world. A grid of the world's size
// (ADMIN_MAP_SIZE, metres), a map image under it when the bridge has one
// (ADMIN_MAP_IMAGE, served as admin/map.png), a pin per box.

import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useLang } from '../i18n';
import { go } from '../app/router';
import { Loading, Notice } from '../ui/bits';
import { parsePos, type Box, type Health } from './model';

const DEFAULT_SIZE = 15360;

export function MapPage() {
  const { s } = useLang();
  const [boxes, setBoxes] = useState<Box[] | null>(null);
  const [map, setMap] = useState<{ size: number; image: boolean }>({ size: DEFAULT_SIZE, image: false });
  const [why, setWhy] = useState('');
  const [hover, setHover] = useState<Box | null>(null);
  useEffect(() => {
    api<{ boxes: Box[] }>('storage', 'boxes').then((r) => (r.ok ? setBoxes(r.boxes.filter((b) => b.status !== 'removed')) : setWhy(r.why)));
    api<Health>('storage', 'health').then((r) => {
      if (r.ok && r.map) setMap({ size: r.map.size || DEFAULT_SIZE, image: !!r.map.image });
    });
  }, []);
  const pins = (boxes || []).map((b) => ({ b, p: parsePos(b.pos) })).filter((x) => x.p !== null) as { b: Box; p: { x: number; y: number; z: number } }[];
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / map.size) * 100))}%`;
  const lines = [];
  for (let i = 1; i < 8; i++) lines.push((i / 8) * 100);
  return (
    <>
      <h1>{s('nav_map')}</h1>
      <p className="muted small">{s('map_help')} {s('map_size')}: {map.size}.</p>
      {why && <Notice tone="bad">{why}</Notice>}
      {!boxes && !why && <Loading />}
      {boxes && !pins.length && <p className="muted">{s('map_none')}</p>}
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
          {hover && hover.pos && parsePos(hover.pos) && (
            <span className="label" style={{ left: pct(parsePos(hover.pos)!.x), top: pct(map.size - parsePos(hover.pos)!.z) }}>
              {hover.box_id} · {hover.class} · {hover.entities ?? 0}
            </span>
          )}
        </div>
      )}
    </>
  );
}
