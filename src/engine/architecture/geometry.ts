import type { CadDocument } from '../model/document';
import { defaultLayer } from '../model/document';
import type { ArchOpening, ArchEntityData, BlockDef, Entity, NewEntity, Pt } from '../types';

const DATA_LAYER = 'ARCH-DATA';
const WALL_LAYER = 'A-WALL';
const COLUMN_LAYER = 'A-COLUMN';
const EPS = 1e-8;

type WallPath = Entity & { type: 'LINE'; arch: Extract<ArchEntityData, { role: 'wall-path' }> };
type WallStrip = { id: number; a: Pt; b: Pt; u: Pt; n: Pt; length: number; half: number; polygon: Pt[]; startExtension: number; endExtension: number };
type Interval = [number, number];

const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const mul = (a: Pt, s: number): Pt => [a[0] * s, a[1] * s];
const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];
const cross = (a: Pt, b: Pt) => a[0] * b[1] - a[1] * b[0];
const length = (a: Pt) => Math.hypot(a[0], a[1]);
const unit = (a: Pt): Pt => { const d = length(a); return d > EPS ? [a[0] / d, a[1] / d] : [1, 0]; };
const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const finite = (p: Pt) => Number.isFinite(p[0]) && Number.isFinite(p[1]);

export function ensureArchitecturalLayers(doc: CadDocument) {
  const data = doc.getLayer(DATA_LAYER);
  if (!data) doc.setLayer({ ...defaultLayer(DATA_LAYER, 8), off: true, frozen: true, locked: true, plot: false, description: 'Internal architectural relationships' });
  const wall = doc.getLayer(WALL_LAYER);
  if (!wall) doc.setLayer({ ...defaultLayer(WALL_LAYER, 7), lineweight: 35, description: 'Architectural walls' });
  const axis = doc.getLayer('A-AXIS');
  if (!axis) doc.setLayer({ ...defaultLayer('A-AXIS', 4), lineweight: 13, description: 'Architectural grids and axes' });
  const column = doc.getLayer(COLUMN_LAYER);
  if (!column) doc.setLayer({ ...defaultLayer(COLUMN_LAYER, 2), lineweight: 25, description: 'Architectural columns' });
  const openings = doc.getLayer('A-OPENING');
  if (!openings) doc.setLayer({ ...defaultLayer('A-OPENING', 3), lineweight: 18, description: 'Doors and windows' });
}

export function addWallPath(doc: CadDocument, a: Pt, b: Pt, thickness: number): Entity | null {
  if (!finite(a) || !finite(b) || !(thickness > 0) || length(sub(b, a)) <= EPS) return null;
  ensureArchitecturalLayers(doc);
  const path = doc.add({
    type: 'LINE', layer: DATA_LAYER, a: [...a], b: [...b],
    arch: { role: 'wall-path', thickness, openings: [] },
  });
  rebuildWalls(doc);
  return path;
}

export function wallPath(doc: CadDocument, id: number): WallPath | undefined {
  const e = doc.get(id);
  return e?.type === 'LINE' && e.arch?.role === 'wall-path' ? e as WallPath : undefined;
}

export function wallPaths(doc: CadDocument): WallPath[] {
  return [...doc.entities.values()].filter((e): e is WallPath => e.type === 'LINE' && e.arch?.role === 'wall-path');
}

export function projectToWall(wall: WallPath, p: Pt): { point: Pt; station: number; length: number } {
  const d = sub(wall.b, wall.a), len = length(d), u = unit(d);
  const station = dot(sub(p, wall.a), u);
  return { point: add(wall.a, mul(u, station)), station, length: len };
}

function wallUnit(w: WallPath) { return unit(sub(w.b, w.a)); }
function rectFor(a: Pt, b: Pt, thickness: number): Pt[] {
  const u = unit(sub(b, a)), n: Pt = [-u[1], u[0]], h = thickness / 2;
  return [add(a, mul(n, h)), add(b, mul(n, h)), add(b, mul(n, -h)), add(a, mul(n, -h))];
}

function stripRayInterval(p: Pt, d: Pt, wall: WallPath): Interval | null {
  const u = wallUnit(wall), n: Pt = [-u[1], u[0]], L = length(sub(wall.b, wall.a)), h = wall.arch.thickness / 2;
  const q = sub(p, wall.a);
  let lo = -Infinity, hi = Infinity;
  for (const [origin, velocity, min, max] of [
    [dot(q, u), dot(d, u), 0, L],
    [dot(q, n), dot(d, n), -h, h],
  ] as [number, number, number, number][]) {
    if (Math.abs(velocity) < EPS) { if (origin < min - EPS || origin > max + EPS) return null; continue; }
    let t0 = (min - origin) / velocity, t1 = (max - origin) / velocity;
    if (t0 > t1) [t0, t1] = [t1, t0];
    lo = Math.max(lo, t0); hi = Math.min(hi, t1);
    if (lo > hi + EPS) return null;
  }
  if (hi < -EPS) return null;
  return [Math.max(0, lo), Math.max(0, hi)];
}

/** Extend a wall endpoint through a host wall when it ends at the host centerline. */
function extendEndpoint(p: Pt, dir: Pt, obstacles: WallPath[]): number {
  const intervals = obstacles.map((w) => stripRayInterval(p, dir, w)).filter((v): v is Interval => !!v && v[1] > EPS).sort((a, b) => a[0] - b[0]);
  let end = 0;
  let changed = true;
  while (changed) {
    changed = false;
    for (const [a, b] of intervals) if (a <= end + EPS && b > end + EPS) { end = b; changed = true; }
  }
  return end;
}

function pointOnSegment(p: Pt, a: Pt, b: Pt, eps = 1e-7) {
  const ab = sub(b, a), ap = sub(p, a), l2 = dot(ab, ab);
  if (l2 <= eps * eps) return length(ap) <= eps;
  const t = dot(ap, ab) / l2;
  return t >= -eps && t <= 1 + eps && Math.abs(cross(ab, ap)) <= eps * Math.sqrt(l2);
}

/** Strict interior test: coincident outlines are retained and deduplicated rather than both clipped. */
function insidePolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i];
    if (pointOnSegment(p, a, b, 1e-8)) return false;
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function segmentIntersectionT(a: Pt, b: Pt, c: Pt, d: Pt): number | null {
  const r = sub(b, a), s = sub(d, c), den = cross(r, s), q = sub(c, a);
  if (Math.abs(den) < EPS) return null;
  const t = cross(q, s) / den, u = cross(q, r) / den;
  return t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS ? Math.max(0, Math.min(1, t)) : null;
}

function insideIntervals(a: Pt, b: Pt, polygon: Pt[]): Interval[] {
  const ts = [0, 1];
  for (let i = 0; i < polygon.length; i++) {
    const t = segmentIntersectionT(a, b, polygon[i], polygon[(i + 1) % polygon.length]);
    if (t !== null) ts.push(t);
  }
  ts.sort((x, y) => x - y);
  const unique = ts.filter((t, i) => i === 0 || t - ts[i - 1] > 1e-7);
  const out: Interval[] = [];
  for (let i = 0; i < unique.length - 1; i++) {
    const lo = unique[i], hi = unique[i + 1];
    if (hi - lo > 1e-8 && insidePolygon(lerp(a, b, (lo + hi) / 2), polygon)) out.push([lo, hi]);
  }
  return out;
}

function mergeIntervals(xs: Interval[]): Interval[] {
  const sorted = xs.map(([a, b]) => [Math.max(0, Math.min(a, b)), Math.min(1, Math.max(a, b))] as Interval)
    .filter(([a, b]) => b - a > 1e-8).sort((a, b) => a[0] - b[0]);
  const out: Interval[] = [];
  for (const x of sorted) {
    const last = out[out.length - 1];
    if (last && x[0] <= last[1] + 1e-8) last[1] = Math.max(last[1], x[1]);
    else out.push([...x]);
  }
  return out;
}

function subtractIntervals(a: Pt, b: Pt, cuts: Interval[]): Pt[][] {
  const merged = mergeIntervals(cuts), out: Pt[][] = [];
  let t = 0;
  for (const [lo, hi] of merged) {
    if (lo - t > 1e-7) out.push([lerp(a, b, t), lerp(a, b, lo)]);
    t = Math.max(t, hi);
  }
  if (1 - t > 1e-7) out.push([lerp(a, b, t), b]);
  return out;
}

function entityPolygon(e: Entity): Pt[] | null {
  if (e.type === 'LWPOLYLINE' && e.closed && e.pts.length >= 3) return e.pts.map((p) => [p[0], p[1]]);
  if (e.type === 'CIRCLE' && e.r > 0) return Array.from({ length: 48 }, (_, i) => {
    const a = (Math.PI * 2 * i) / 48;
    return [e.c[0] + e.r * Math.cos(a), e.c[1] + e.r * Math.sin(a)];
  });
  return null;
}

function lineKey(a: Pt, b: Pt) {
  const fmt = (p: Pt) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
  const x = fmt(a), y = fmt(b);
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

/**
 * Rebuild every generated wall outline from hidden centerline records. This clips
 * intersections (including oblique intersections), opening gaps and column footprints.
 */
export function rebuildWalls(doc: CadDocument) {
  ensureArchitecturalLayers(doc);
  for (const e of [...doc.entities.values()]) if (e.arch?.role === 'wall-edge' || e.arch?.role === 'wall-jamb') doc.remove(e.id);
  const walls = wallPaths(doc).filter((w) => w.arch.thickness > 0 && length(sub(w.b, w.a)) > EPS);
  if (!walls.length) return;
  const columns = [...doc.entities.values()].filter((e) => e.arch?.role === 'column').map(entityPolygon).filter((p): p is Pt[] => !!p && p.length >= 3);
  const strips: WallStrip[] = walls.map((w) => {
    const u = unit(sub(w.b, w.a)), n: Pt = [-u[1], u[0]];
    const otherWalls = walls.filter((x) => x.id !== w.id);
    const startExtension = extendEndpoint(w.a, mul(u, -1), otherWalls);
    const endExtension = extendEndpoint(w.b, u, otherWalls);
    const a = add(w.a, mul(u, -startExtension)), b = add(w.b, mul(u, endExtension));
    return { id: w.id, a, b, u, n, length: length(sub(b, a)), half: w.arch.thickness / 2, polygon: rectFor(a, b, w.arch.thickness), startExtension, endExtension };
  });
  const wallById = new Map(walls.map((w) => [w.id, w]));
  const stripById = new Map(strips.map((w) => [w.id, w]));
  const seen = new Set<string>();
  const addLine = (a: Pt, b: Pt, wallId: number, role: 'wall-edge' | 'wall-jamb') => {
    if (!finite(a) || !finite(b) || length(sub(b, a)) <= 1e-7) return;
    const key = lineKey(a, b);
    if (seen.has(key)) return;
    seen.add(key);
    doc.add({ type: 'LINE', layer: WALL_LAYER, a, b, arch: { role, wallId } });
  };
  const makeSegments = (a: Pt, b: Pt, source: WallStrip, role: 'wall-edge' | 'wall-jamb', openingCuts: Interval[] = []) => {
    const obstacles = [
      ...strips.filter((s) => s.id !== source.id).map((s) => s.polygon),
      ...columns,
    ];
    const cuts = [...openingCuts, ...obstacles.flatMap((p) => insideIntervals(a, b, p))];
    for (const [p, q] of subtractIntervals(a, b, cuts)) addLine(p, q, source.id, role);
  };

  for (const s of strips) {
    const w = wallById.get(s.id)!;
    const n = s.n, h = s.half, a = s.a, b = s.b;
    const openCuts = (): Interval[] => w.arch.openings.map((o) => {
      const lo = (s.startExtension + o.station - o.width / 2) / s.length;
      const hi = (s.startExtension + o.station + o.width / 2) / s.length;
      return [lo, hi];
    });
    makeSegments(add(a, mul(n, h)), add(b, mul(n, h)), s, 'wall-edge', openCuts());
    makeSegments(add(a, mul(n, -h)), add(b, mul(n, -h)), s, 'wall-edge', openCuts());
    makeSegments(add(a, mul(n, h)), add(a, mul(n, -h)), s, 'wall-edge');
    makeSegments(add(b, mul(n, h)), add(b, mul(n, -h)), s, 'wall-edge');
    const u = s.u;
    for (const o of w.arch.openings) {
      for (const station of [o.station - o.width / 2, o.station + o.width / 2]) {
        const center = add(w.a, mul(u, station));
        makeSegments(add(center, mul(n, h)), add(center, mul(n, -h)), s, 'wall-jamb');
      }
    }
  }
}

export function openingBlockName(kind: 'door' | 'window', width: number, thickness: number, side: 1 | -1) {
  const key = (n: number) => Math.max(1, Math.round(n * 100));
  return `*ARCH_${kind.toUpperCase()}_${key(width)}_${key(thickness)}_${side > 0 ? 'L' : 'R'}`;
}

export function makeOpeningBlock(kind: 'door' | 'window', width: number, thickness: number, side: 1 | -1, name = openingBlockName(kind, width, thickness, side)): BlockDef {
  const half = width / 2;
  const local: NewEntity[] = kind === 'door'
    ? [
      { type: 'LINE', layer: '0', a: [-half, 0], b: [-half, side * width] },
      { type: 'ARC', layer: '0', c: [-half, 0], r: width, a0: side > 0 ? 0 : Math.PI * 1.5, a1: side > 0 ? Math.PI / 2 : Math.PI * 2 },
    ]
    : [
      { type: 'LINE', layer: '0', a: [-half, -thickness * 0.22], b: [half, -thickness * 0.22] },
      { type: 'LINE', layer: '0', a: [-half, thickness * 0.22], b: [half, thickness * 0.22] },
      { type: 'LINE', layer: '0', a: [0, -thickness * 0.22], b: [0, thickness * 0.22] },
    ];
  return { name, base: [0, 0], units: 4, entities: local.map((e, i) => ({ ...e, id: i + 1 } as Entity)) };
}

export function ensureOpeningBlock(doc: CadDocument, kind: 'door' | 'window', width: number, thickness: number, side: 1 | -1) {
  const name = openingBlockName(kind, width, thickness, side);
  if (!doc.getBlock(name)) doc.setBlock(makeOpeningBlock(kind, width, thickness, side, name));
  return name;
}

export function openingEntityFor(doc: CadDocument, e: Entity): e is Entity & { type: 'INSERT'; arch: Extract<ArchEntityData, { role: 'opening-symbol' }> } {
  return e.type === 'INSERT' && e.arch?.role === 'opening-symbol';
}

export function setWallOpening(doc: CadDocument, id: number, opening: ArchOpening) {
  const w = wallPath(doc, id);
  if (!w) return false;
  const openings = w.arch.openings.filter((o) => o.id !== opening.id);
  openings.push({ ...opening });
  openings.sort((a, b) => a.station - b.station);
  doc.update(w.id, { arch: { ...w.arch, openings } });
  rebuildWalls(doc);
  return true;
}

export function removeWallOpening(doc: CadDocument, wallId: number, openingId: number) {
  const w = wallPath(doc, wallId);
  if (!w) return false;
  doc.update(w.id, { arch: { ...w.arch, openings: w.arch.openings.filter((o) => o.id !== openingId) } });
  rebuildWalls(doc);
  return true;
}

export function openingRecord(w: WallPath, id: number) { return w.arch.openings.find((o) => o.id === id); }

export function nearestOpeningStation(w: WallPath, station: number, openingId: number, width: number) {
  const min = width / 2, max = length(sub(w.b, w.a)) - width / 2;
  if (max < min) return null;
  const others = w.arch.openings.filter((o) => o.id !== openingId).sort((a, b) => a.station - b.station);
  let lo = min, hi = max;
  for (const o of others) {
    const left = o.station - o.width / 2;
    const right = o.station + o.width / 2;
    if (right <= station) lo = Math.max(lo, right + Math.min(25, width * 0.02));
    else if (left >= station) hi = Math.min(hi, left - Math.min(25, width * 0.02));
  }
  if (lo > hi) return null;
  return Math.max(lo, Math.min(hi, station));
}

/** Keep hosted window frames in sync when the wall thickness changes. */
export function refreshWallOpeningBlocks(doc: CadDocument, wallId: number) {
  const w = wallPath(doc, wallId);
  if (!w) return;
  for (const o of w.arch.openings) {
    const e = doc.get(o.id);
    if (!e || !openingEntityFor(doc, e)) continue;
    const name = ensureOpeningBlock(doc, o.kind, o.width, w.arch.thickness, o.side);
    if (e.name !== name) doc.update(e.id, { name });
  }
}

/** Moving a wall outline moves its hidden centerline and hosted symbols as one unit. */
export function expandArchitectureTransformTargets(doc: CadDocument, ids: number[]) {
  const out = new Set(ids);
  const wallIds = new Set<number>();
  for (const id of ids) {
    const e = doc.get(id);
    if ((e?.arch?.role === 'wall-edge' || e?.arch?.role === 'wall-jamb')) wallIds.add(e.arch.wallId);
  }
  for (const wallId of wallIds) {
    out.add(wallId);
    for (const e of doc.entities.values()) if (e.arch?.role === 'opening-symbol' && e.arch.wallId === wallId) out.add(e.id);
  }
  return [...out];
}

/** Repair dependent geometry after MOVE/GRIPEDIT and after a column is moved. */
export function synchronizeArchitecture(doc: CadDocument, ids: number[]) {
  const touched = new Set<number>();
  let rebuild = false;
  for (const id of ids) {
    const e = doc.get(id);
    if (!e) continue;
    if (e.arch?.role === 'wall-path') { touched.add(e.id); rebuild = true; continue; }
    if (e.arch?.role === 'column') { rebuild = true; continue; }
    const arch = e.arch;
    if (!arch || arch.role !== 'opening-symbol' || e.type !== 'INSERT') continue;
    const w = wallPath(doc, arch.wallId);
    if (!w) continue;
    const projected = projectToWall(w, e.p);
    const station = nearestOpeningStation(w, projected.station, arch.openingId, arch.width) ?? arch.station;
    const center = add(w.a, mul(wallUnit(w), station));
    const wallAngle = Math.atan2(w.b[1] - w.a[1], w.b[0] - w.a[0]);
    const nextArch = { ...arch, station };
    if (Math.abs(station - arch.station) > 1e-7 || length(sub(center, e.p)) > 1e-7 || Math.abs(e.rot - wallAngle) > 1e-7) doc.update(e.id, { p: center, rot: wallAngle, arch: nextArch });
    const record = openingRecord(w, arch.openingId);
    if (record && Math.abs(record.station - station) > 1e-7) {
      const openings = w.arch.openings.map((o) => o.id === arch.openingId ? { ...o, station } : o);
      doc.update(w.id, { arch: { ...w.arch, openings } });
    }
    touched.add(w.id); rebuild = true;
  }
  if (rebuild) rebuildWalls(doc);
  return touched;
}

/** A copy of a wall outline is plain linework; it must not share a parametric wall record. */
export function detachArchitecturalCopy(e: NewEntity): NewEntity {
  const copy = structuredClone(e) as NewEntity;
  if (copy.arch?.role === 'wall-path' || copy.arch?.role === 'wall-edge' || copy.arch?.role === 'wall-jamb' || copy.arch?.role === 'opening-symbol') delete copy.arch;
  return copy;
}

export function deleteArchitecturalWall(doc: CadDocument, wallId: number) {
  const wall = wallPath(doc, wallId);
  if (!wall) return false;
  for (const e of [...doc.entities.values()]) if (e.arch?.role === 'opening-symbol' && e.arch.wallId === wallId) doc.remove(e.id);
  doc.remove(wallId);
  rebuildWalls(doc);
  return true;
}

export function eraseArchitecturalSelection(doc: CadDocument, ids: number[]) {
  const handled = new Set<number>();
  const gone = new Map<number, Entity>();
  const wallIds = new Set<number>();
  const openingIds = new Set<number>();
  const columnIds = new Set<number>();
  for (const id of ids) {
    const e = doc.get(id);
    if (!e?.arch) continue;
    if (e.arch.role === 'wall-edge' || e.arch.role === 'wall-jamb') wallIds.add(e.arch.wallId);
    else if (e.arch.role === 'wall-path') wallIds.add(e.id);
    else if (e.arch.role === 'opening-symbol') openingIds.add(e.id);
    else if (e.arch.role === 'column') columnIds.add(e.id);
  }
  let rebuild = false;
  for (const wallId of wallIds) {
    const w = wallPath(doc, wallId);
    if (!w) continue;
    gone.set(w.id, structuredClone(w)); handled.add(w.id);
    for (const e of [...doc.entities.values()]) {
      if (e.arch?.role === 'wall-edge' || e.arch?.role === 'wall-jamb') {
        if (e.arch.wallId === wallId) handled.add(e.id);
      } else if (e.arch?.role === 'opening-symbol' && e.arch.wallId === wallId) {
        gone.set(e.id, structuredClone(e)); handled.add(e.id); doc.remove(e.id);
      }
    }
    for (const id of ids) {
      const e = doc.get(id);
      if (e?.arch?.role === 'wall-edge' || e?.arch?.role === 'wall-jamb') if (e.arch.wallId === wallId) handled.add(id);
    }
    doc.remove(w.id);
    openingIds.forEach((id) => { const e = doc.get(id); if (e?.arch?.role === 'opening-symbol' && e.arch.wallId === wallId) openingIds.delete(id); });
    rebuild = true;
  }
  for (const id of openingIds) {
    const e = doc.get(id);
    if (!e || !openingEntityFor(doc, e)) continue;
    const w = wallPath(doc, e.arch.wallId);
    if (w) doc.update(w.id, { arch: { ...w.arch, openings: w.arch.openings.filter((o) => o.id !== e.arch.openingId) } });
    gone.set(e.id, structuredClone(e)); handled.add(e.id); doc.remove(e.id); rebuild = true;
  }
  for (const id of columnIds) {
    const e = doc.get(id);
    if (!e || e.arch?.role !== 'column') continue;
    gone.set(e.id, structuredClone(e)); handled.add(e.id); doc.remove(e.id); rebuild = true;
  }
  if (rebuild) rebuildWalls(doc);
  return { handled, gone: [...gone.values()] };
}

/** Recreate erased architectural objects with fresh entity IDs and relink their openings. */
export function restoreErasedEntities(doc: CadDocument, erased: Entity[]) {
  const added: number[] = [];
  const walls = erased.filter((e): e is WallPath => e.type === 'LINE' && e.arch?.role === 'wall-path');
  const openings = erased.filter((e) => e.arch?.role === 'opening-symbol' && e.type === 'INSERT');
  const columns = erased.filter((e) => e.arch?.role === 'column');
  const generated = erased.filter((e) => e.arch?.role === 'wall-edge' || e.arch?.role === 'wall-jamb');
  const special = new Set([...walls, ...openings, ...columns, ...generated]);
  const stripId = (e: Entity): NewEntity => { const { id: _id, ...rest } = structuredClone(e); return rest as NewEntity; };
  const wallMap = new Map<number, number>();
  const restoredOpenings = new Map<number, ArchOpening[]>();
  for (const e of erased) {
    if (special.has(e)) continue;
    added.push(doc.add(stripId(e)).id);
  }
  for (const w of walls) {
    const copy = stripId(w);
    if (copy.arch?.role === 'wall-path') copy.arch = { ...copy.arch, openings: [] };
    const created = doc.add(copy);
    wallMap.set(w.id, created.id); added.push(created.id);
    restoredOpenings.set(created.id, []);
  }
  for (const e of columns) added.push(doc.add(stripId(e)).id);
  for (const e of openings) {
    if (e.type !== 'INSERT' || e.arch?.role !== 'opening-symbol') continue;
    const wallId = wallMap.get(e.arch.wallId) ?? (wallPath(doc, e.arch.wallId) ? e.arch.wallId : -1);
    if (wallId < 0) continue;
    const copy = stripId(e);
    if (copy.type !== 'INSERT' || copy.arch?.role !== 'opening-symbol') continue;
    copy.arch = { ...copy.arch, wallId, openingId: -1 };
    const created = doc.add(copy);
    doc.update(created.id, { arch: { ...copy.arch, openingId: created.id } });
    const list = restoredOpenings.get(wallId) ?? wallPath(doc, wallId)?.arch.openings ?? [];
    list.push({ id: created.id, station: copy.arch.station, width: copy.arch.width, kind: copy.arch.kind, side: copy.arch.side });
    restoredOpenings.set(wallId, list);
    added.push(created.id);
  }
  for (const [wallId, list] of restoredOpenings) {
    const w = wallPath(doc, wallId);
    if (w) doc.update(w.id, { arch: { ...w.arch, openings: [...list].sort((a, b) => a.station - b.station) } });
  }
  if (walls.length || openings.length || columns.length || generated.length) rebuildWalls(doc);
  return added;
}

export function changeOpening(doc: CadDocument, entityId: number, kind: 'door' | 'window', side?: 1 | -1) {
  const e = doc.get(entityId);
  if (!e || !openingEntityFor(doc, e)) return false;
  const w = wallPath(doc, e.arch.wallId);
  if (!w) return false;
  const nextSide = side ?? e.arch.side;
  const name = ensureOpeningBlock(doc, kind, e.arch.width, w.arch.thickness, nextSide);
  doc.update(entityId, { name, arch: { ...e.arch, kind, side: nextSide } });
  const openings = w.arch.openings.map((o) => o.id === e.arch.openingId ? { ...o, kind, side: nextSide } : o);
  doc.update(w.id, { arch: { ...w.arch, openings } });
  rebuildWalls(doc);
  return true;
}

