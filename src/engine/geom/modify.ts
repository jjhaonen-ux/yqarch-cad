/**
 * Analytic geometry for the Phase 3B modify commands: TRIM, EXTEND, BREAK, JOIN, STRETCH (+ re-exported OFFSET).
 * FILLET / CHAMFER live in ./corner.ts. Curves are handled as bulge-edge paths (see ./curve.ts).
 */
import type { Entity, NewEntity, Pt } from '../types';
import { arc, bulgeToPrim, intersect, lineLine, type Arc, type Prim } from './prims';
import { angleOf, ccwSweep, cross, dist, dot, len, norm, perp, polar, sub, TAU } from './vec';
import {
  baseProps, boundaryEdges, clonePt, edgeCircle, edgeIntersections, edgeLength, edgeSweep, entityFromEdges, entityPath, FAR,
  isArcEdge, isCurve, pathBreaks, pathClosest, pathLength, pathPoint, pathSlice, polylineFrom, reverseEdge, subEdge,
  type Edge, type Path,
} from './curve';
import { offsetCurve } from './offset';

export { offsetCurve, offsetSideSign, distanceToCurve, offsetEdges } from './offset';
export { filletLines, chamferLines } from './corner';

export type PathEdge = { a: Pt; b: Pt; bulge: number; prim: Prim; length: number; index: number; fullCircle?: boolean };
const EPS = 1e-8;
const isPath = (e: Entity): e is Extract<Entity, { type: 'LINE' | 'ARC' | 'CIRCLE' | 'LWPOLYLINE' }> =>
  e.type === 'LINE' || e.type === 'ARC' || e.type === 'CIRCLE' || e.type === 'LWPOLYLINE';

export function pathEdges(e: Entity): PathEdge[] {
  if (e.type === 'LINE') return [{ a: e.a, b: e.b, bulge: 0, prim: { k: 'seg', a: e.a, b: e.b }, length: dist(e.a, e.b), index: 0 }];
  if (e.type === 'ARC') {
    const a = polar(e.c, e.a0, e.r), b = polar(e.c, e.a1, e.r), sweep = ccwSweep(e.a0, e.a1);
    return [{ a, b, bulge: Math.tan(sweep / 4), prim: arc(e.c, e.r, e.a0, e.a1), length: e.r * sweep, index: 0 }];
  }
  if (e.type === 'CIRCLE') return [{ a: polar(e.c, 0, e.r), b: polar(e.c, 0, e.r), bulge: 0, prim: arc(e.c, e.r, 0, TAU, true), length: TAU * e.r, index: 0, fullCircle: true }];
  if (e.type === 'LWPOLYLINE') {
    const n = e.pts.length, count = e.closed ? n : n - 1, out: PathEdge[] = [];
    for (let i = 0; i < count; i++) {
      const p = e.pts[i], q = e.pts[(i + 1) % n], a: Pt = [p[0], p[1]], b: Pt = [q[0], q[1]], bulge = p[2] ?? 0;
      const prim = bulgeToPrim(a, b, bulge);
      const length = prim.k === 'seg' ? dist(a, b) : prim.r * (4 * Math.abs(Math.atan(bulge)));
      out.push({ a, b, bulge, prim, length, index: i });
    }
    return out;
  }
  return [];
}

export function pointOnEdge(edge: PathEdge, t: number): Pt {
  const u = Math.max(0, Math.min(1, t));
  if (edge.fullCircle) {
    const p = edge.prim as Arc;
    return polar(p.c, TAU * u, p.r);
  }
  if (Math.abs(edge.bulge) < EPS) return [edge.a[0] + (edge.b[0] - edge.a[0]) * u, edge.a[1] + (edge.b[1] - edge.a[1]) * u];
  const p = edge.prim as Arc;
  const start = angleOf(p.c, edge.a);
  return polar(p.c, start + 4 * Math.atan(edge.bulge) * u, p.r);
}

export function parameterOnEdge(edge: PathEdge, p: Pt): number {
  if (edge.fullCircle) {
    const c = (edge.prim as Arc).c, a = angleOf(c, p);
    return ((a % TAU) + TAU) % TAU / TAU;
  }
  if (Math.abs(edge.bulge) < EPS) {
    const d = sub(edge.b, edge.a), l2 = dot(d, d);
    return l2 < EPS ? 0 : Math.max(0, Math.min(1, dot(sub(p, edge.a), d) / l2));
  }
  const c = (edge.prim as Arc).c, start = angleOf(c, edge.a), a = angleOf(c, p), sweep = 4 * Math.atan(edge.bulge);
  let d = sweep > 0 ? ((a - start) % TAU + TAU) % TAU : -(((start - a) % TAU + TAU) % TAU);
  return Math.max(0, Math.min(1, d / sweep));
}

export function closestPathParameter(e: Entity, p: Pt): number {
  const edges = pathEdges(e), total = edges.reduce((s, x) => s + x.length, 0);
  if (!edges.length || total < EPS) return 0;
  let best = 0, bestD = Infinity, offset = 0;
  for (const edge of edges) {
    const t = parameterOnEdge(edge, p), d = dist(pointOnEdge(edge, t), p);
    if (d < bestD) { bestD = d; best = (offset + t * edge.length) / total; }
    offset += edge.length;
  }
  return best;
}

function lineCircle(a: Pt, b: Pt, c: Pt, r: number, finite: boolean): { p: Pt; t: number }[] {
  const d = sub(b, a), f = sub(a, c), A = dot(d, d);
  if (A < EPS) return [];
  const B = 2 * dot(f, d), C = dot(f, f) - r * r, disc = B * B - 4 * A * C;
  if (disc < -EPS) return [];
  const s = Math.sqrt(Math.max(0, disc)), ts = s < EPS ? [-B / (2 * A)] : [(-B - s) / (2 * A), (-B + s) / (2 * A)];
  return ts.filter((t) => !finite || (t >= -EPS && t <= 1 + EPS)).map((t) => ({ p: [a[0] + d[0] * t, a[1] + d[1] * t] as Pt, t }));
}

/** Intersections of supporting lines/circles. Line segments are considered infinite here. */
export function supportIntersections(p: Prim, q: Prim): Pt[] {
  if (p.k === 'seg' && q.k === 'seg') {
    const x = lineLine(p.a, p.b, q.a, q.b); return x ? [x] : [];
  }
  if (p.k === 'seg' && q.k === 'arc') return lineCircle(p.a, p.b, q.c, q.r, false).map((x) => x.p);
  if (p.k === 'arc' && q.k === 'seg') return lineCircle(q.a, q.b, p.c, p.r, false).map((x) => x.p);
  const a = p as Arc, b = q as Arc, d = dist(a.c, b.c);
  if (d < EPS || d > a.r + b.r + EPS || d < Math.abs(a.r - b.r) - EPS) return [];
  const x = (a.r * a.r - b.r * b.r + d * d) / (2 * d), h2 = a.r * a.r - x * x;
  if (h2 < -EPS) return [];
  const u = norm(sub(b.c, a.c)), m: Pt = [a.c[0] + u[0] * x, a.c[1] + u[1] * x], h = Math.sqrt(Math.max(0, h2));
  return h < EPS ? [m] : [[m[0] - u[1] * h, m[1] + u[0] * h], [m[0] + u[1] * h, m[1] - u[0] * h]];
}

/** Exact finite intersections for lines, arcs, circles, and bulged polylines. */
export function intersections(a: Entity, b: Entity): Pt[] {
  const aa = pathEdges(a), bb = pathEdges(b), out: Pt[] = [];
  for (const x of aa) for (const y of bb) for (const p of intersect(x.prim, y.prim)) {
    if (!out.some((q) => dist(q, p) < 1e-7)) out.push(p);
  }
  return out;
}


// ------------------------------------------------------------------ OFFSET (legacy single-result API)
/** First offset result (positive = left of the travel direction / outside of circles). */
export function offsetEntity(e: Entity, amount: number): NewEntity | null { return offsetCurve(e, amount)[0] ?? null; }
export function offsetPolyline(e: Extract<Entity, { type: 'LWPOLYLINE' }>, amount: number): NewEntity | null { return offsetCurve(e, amount)[0] ?? null; }

// ------------------------------------------------------------------ TRIM
export type EdgeOptions = { extendEdges?: boolean; splinePoints?: (e: Entity) => Pt[] | null };

/** Cutting / boundary edges of a set of entities (optionally excluding one id). */
export function cuttingEdges(entities: Entity[], o: EdgeOptions = {}, exclude?: number): Edge[] {
  return entities.filter((e) => e.id !== exclude).flatMap((e) => boundaryEdges(e, !!o.extendEdges, o.splinePoints));
}

type Interval = { s0: number; s1: number };
/** Intervals of a path between consecutive break parameters (closed paths wrap: the last interval ends past N). */
function intervals(path: Path, breaks: number[]): Interval[] {
  const N = path.edges.length;
  if (path.closed) {
    if (breaks.length < 2) return [];
    const out: Interval[] = [];
    for (let i = 0; i < breaks.length; i++) out.push({ s0: breaks[i], s1: i + 1 < breaks.length ? breaks[i + 1] : breaks[0] + N });
    return out;
  }
  const b = breaks.filter((s) => s > 1e-9 && s < N - 1e-9), out: Interval[] = [];
  let prev = 0;
  for (const s of b) { out.push({ s0: prev, s1: s }); prev = s; }
  out.push({ s0: prev, s1: N });
  return out;
}
function intervalOf(path: Path, ivs: Interval[], s: number): number {
  const N = path.edges.length;
  for (let i = 0; i < ivs.length; i++) {
    const { s0, s1 } = ivs[i];
    if (s >= s0 - 1e-12 && s <= s1 + 1e-12) return i;
    if (path.closed && s + N >= s0 - 1e-12 && s + N <= s1 + 1e-12) return i;
  }
  return -1;
}
/** Rebuild the kept intervals as entities (consecutive kept intervals merge; closed curves wrap around). */
function keepIntervals(src: Entity, path: Path, ivs: Interval[], removed: Set<number>): NewEntity[] {
  const ranges: Interval[] = [];
  const n = ivs.length;
  if (path.closed) {
    // start right after a removed interval so wrapping ranges stay contiguous
    const start = [...removed][0];
    let cur: Interval | null = null;
    for (let k = 1; k <= n; k++) {
      const i = (start + k) % n;
      if (removed.has(i)) { if (cur) { ranges.push(cur); cur = null; } continue; }
      let { s0, s1 } = ivs[i];
      if (cur) { while (s0 < cur.s1 - 1e-9) { s0 += path.edges.length; s1 += path.edges.length; } cur.s1 = s1; } else cur = { s0, s1 };
    }
    if (cur) ranges.push(cur);
  } else {
    let cur: Interval | null = null;
    ivs.forEach((iv, i) => {
      if (removed.has(i)) { if (cur) { ranges.push(cur); cur = null; } return; }
      if (cur) cur.s1 = iv.s1; else cur = { ...iv };
    });
    if (cur) ranges.push(cur);
  }
  const out: NewEntity[] = [];
  for (const r of ranges) {
    const edges = pathSlice(path, r.s0, r.s1).filter((e) => dist(e.a, e.b) > 1e-12);
    if (!edges.length) continue;
    if (edges.reduce((s, e) => s + edgeLength(e), 0) < 1e-9) continue;
    const ent = entityFromEdges(src, edges, false);
    if (ent) out.push(ent);
  }
  return out;
}

/**
 * Trim `target` at the picked points: the piece(s) between cutting-edge intersections that contain a pick are removed.
 * Returns the replacement entities ([] = the whole object is removed), or null when nothing can be trimmed.
 * A closed curve needs at least two intersections; trimmed circles become arcs, closed polylines open polylines.
 * With `quick` an object that no edge crosses is deleted (AutoCAD Quick mode).
 */
export function trimByPicks(target: Entity, picks: Pt[], cutters: Entity[], o: EdgeOptions & { quick?: boolean } = {}): NewEntity[] | null {
  const path = entityPath(target);
  if (!path) return null;
  const breaks = pathBreaks(path, cuttingEdges(cutters, o, target.id));
  const ivs = intervals(path, breaks);
  if (ivs.length < 2) return o.quick && breaks.length === 0 ? [] : null;
  const removed = new Set<number>();
  for (const p of picks) { const i = intervalOf(path, ivs, pathClosest(path, p).s); if (i >= 0) removed.add(i); }
  if (!removed.size) return null;
  if (removed.size === ivs.length) return [];
  return keepIntervals(target, path, ivs, removed);
}

/** Trim the pieces of `target` for which `hit(pieceEdges)` is true (fence / crossing selection). */
export function trimByPredicate(target: Entity, cutters: Entity[], hit: (edges: Edge[]) => boolean, o: EdgeOptions & { quick?: boolean } = {}): NewEntity[] | null {
  const path = entityPath(target);
  if (!path) return null;
  const breaks = pathBreaks(path, cuttingEdges(cutters, o, target.id));
  const ivs = intervals(path, breaks);
  if (ivs.length < 2) {
    if (o.quick && breaks.length === 0 && hit(path.edges)) return [];
    return null;
  }
  const removed = new Set<number>();
  ivs.forEach((iv, i) => { if (hit(pathSlice(path, iv.s0, iv.s1))) removed.add(i); });
  if (!removed.size) return null;
  if (removed.size === ivs.length) return [];
  return keepIntervals(target, path, ivs, removed);
}

/** Legacy API: trim at one pick. */
export function trimEntityAt(target: Entity, pick: Pt, cutters: Entity[]): NewEntity[] | null { return trimByPicks(target, [pick], cutters); }

// ------------------------------------------------------------------ EXTEND
/** Position of a pick along the curve, as a fraction of its length (decides which end is extended). */
function lengthFraction(path: Path, s: number): number {
  const total = pathLength(path);
  if (total < 1e-12) return 0;
  let acc = 0;
  path.edges.forEach((e, i) => { if (i + 1 <= s) acc += edgeLength(e); else if (i < s) acc += edgeLength(subEdge(e, 0, s - i)); });
  return acc / total;
}

/** Extend the end edge `e` (travelling towards e.b) until it meets a boundary; returns the new edge or null. */
function extendEdge(e: Edge, bounds: Edge[]): Edge | null {
  const tol = 1e-9 * Math.max(1, Math.abs(e.b[0]), Math.abs(e.b[1]));
  if (!isArcEdge(e)) {
    const d = norm(sub(e.b, e.a));
    if (!len(d)) return null;
    const ray: Edge = { a: clonePt(e.b), b: [e.b[0] + d[0] * FAR, e.b[1] + d[1] * FAR], bulge: 0 };
    let best = Infinity, hit: Pt | null = null;
    for (const f of bounds) for (const x of edgeIntersections(ray, f)) {
      const t = dot(sub(x.p, e.b), d);
      if (t > tol * 10 && t < best) { best = t; hit = x.p; }
    }
    return hit ? { a: clonePt(e.a), b: hit, bulge: 0 } : null;
  }
  const { c, r } = edgeCircle(e), sw = edgeSweep(e), dir = sw > 0 ? 1 : -1;
  const full: Edge[] = [{ a: polar(c, 0, r), b: polar(c, Math.PI, r), bulge: 1 }, { a: polar(c, Math.PI, r), b: polar(c, 0, r), bulge: 1 }];
  const ab = angleOf(c, e.b), room = TAU - Math.abs(sw);
  let best = Infinity, hit: Pt | null = null;
  for (const half of full) for (const f of bounds) for (const x of edgeIntersections(half, f)) {
    let da = (angleOf(c, x.p) - ab) * dir;
    da = ((da % TAU) + TAU) % TAU;
    if (da * r > tol * 10 && da < room - 1e-9 && da < best) { best = da; hit = x.p; }
  }
  if (!hit) return null;
  return { a: clonePt(e.a), b: hit, bulge: Math.tan((sw + dir * best) / 4) };
}

/**
 * EXTEND the end of a LINE, ARC or open LWPOLYLINE nearest (along the curve) to `pick` to the nearest boundary.
 * Lines run along their ray, arcs along their circle. Returns the replacement entity or null.
 */
export function extendByPick(target: Entity, pick: Pt, boundaries: Entity[], o: EdgeOptions = {}): NewEntity | null {
  if (!(target.type === 'LINE' || target.type === 'ARC' || (target.type === 'LWPOLYLINE' && !target.closed))) return null;
  const path = entityPath(target);
  if (!path) return null;
  const bounds = cuttingEdges(boundaries, o, target.id);
  const atStart = lengthFraction(path, pathClosest(path, pick).s) < 0.5;
  const edges = path.edges.map((e) => ({ ...e, a: clonePt(e.a), b: clonePt(e.b) }));
  if (atStart) {
    const ext = extendEdge(reverseEdge(edges[0]), bounds);
    if (!ext) return null;
    edges[0] = reverseEdge(ext);
  } else {
    const k = edges.length - 1, ext = extendEdge(edges[k], bounds);
    if (!ext) return null;
    edges[k] = ext;
  }
  return entityFromEdges(target, edges, false);
}
/** Legacy API. */
export function extendEntityAt(target: Entity, pick: Pt, boundaries: Entity[]): NewEntity | null { return extendByPick(target, pick, boundaries); }

// ------------------------------------------------------------------ BREAK
/**
 * BREAK like AutoCAD: removes the part between p1 and p2 (projected onto the curve).
 *  - CIRCLE: the part counter-clockwise from p1 to p2 is removed (→ ARC). A circle cannot be broken at one point.
 *  - closed polyline: the part from p1 to p2 in vertex direction is removed; a single point opens it there.
 *  - open curves: p1 == p2 splits the curve in two.
 * Returns the replacement entities or null when the break is not possible.
 */
export function breakEntity(target: Entity, p1: Pt, p2: Pt): NewEntity[] | null {
  const path = entityPath(target);
  if (!path) return null;
  const N = path.edges.length, a = pathClosest(path, p1), b = pathClosest(path, p2);
  const same = dist(a.p, b.p) < 1e-9;
  if (target.type === 'CIRCLE') {
    if (same) return null;
    const a0 = angleOf(target.c, a.p), a1 = angleOf(target.c, b.p);
    return [{ ...baseProps(target), type: 'ARC', c: clonePt(target.c), r: target.r, a0: a1, a1: a0 }];
  }
  if (path.closed) {
    if (same) return [entityFromEdges(target, pathSlice(path, a.s, a.s + N), false)!];
    // the part from p1 to p2 (vertex direction) is removed: keep p2 → p1, wrapping round the closing vertex
    const e0 = b.s;
    let e1 = a.s;
    while (e1 <= e0 + 1e-12) e1 += N;
    const edges = pathSlice(path, e0, e1);
    return edges.length ? [entityFromEdges(target, edges, false)!] : [];
  }
  const lo = Math.min(a.s, b.s), hi = Math.max(a.s, b.s), out: NewEntity[] = [];
  if (same && (lo < 1e-9 || lo > N - 1e-9)) return null;
  for (const [s0, s1] of [[0, lo], [hi, N]]) {
    if (s1 - s0 < 1e-12) continue;
    const edges = pathSlice(path, s0, s1);
    if (edges.length && edges.reduce((s, e) => s + edgeLength(e), 0) > 1e-9) { const e = entityFromEdges(target, edges, false); if (e) out.push(e); }
  }
  return out;
}
/** Legacy API (same as breakEntity). */
export function breakEntityAt(target: Entity, p1: Pt, p2: Pt): NewEntity[] | null {
  const r = breakEntity(target, p1, p2);
  return r && r.length ? r : null;
}

// ------------------------------------------------------------------ JOIN
export type JoinResult = { remove: number[]; add: NewEntity[]; joined: number };
const sameCircle = (a: { c: Pt; r: number }, b: { c: Pt; r: number }, tol: number) => dist(a.c, b.c) <= tol && Math.abs(a.r - b.r) <= tol;

/**
 * JOIN like AutoCAD (multiple-selection form):
 *  1. collinear LINEs (gaps allowed) become one LINE,
 *  2. ARCs on the same circle become one ARC counter-clockwise from the first selected arc (a CIRCLE when complete),
 *  3. remaining lines/arcs/open polylines whose endpoints meet are chained into LWPOLYLINEs (closed when the chain closes).
 * Objects that take part in no join are left alone.
 */
export function joinEntities(entities: Entity[], tol = 1e-6): JoinResult {
  type Item = { ids: number[]; ent: Entity | NewEntity; changed: boolean };
  const items: Item[] = entities.filter((e) => isCurve(e) && e.type !== 'CIRCLE' && !(e.type === 'LWPOLYLINE' && e.closed))
    .map((e) => ({ ids: [e.id], ent: e, changed: false }));
  // 1. collinear lines
  for (let i = 0; i < items.length; i++) {
    const a = items[i].ent;
    if (a.type !== 'LINE') continue;
    const d = norm(sub(a.b, a.a));
    if (!len(d)) continue;
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j].ent;
      if (b.type !== 'LINE') continue;
      const off1 = Math.abs(cross(d, sub(b.a, a.a))), off2 = Math.abs(cross(d, sub(b.b, a.a)));
      if (off1 > tol || off2 > tol) continue;
      const ts = [0, dot(sub(a.b, a.a), d), dot(sub(b.a, a.a), d), dot(sub(b.b, a.a), d)];
      const lo = Math.min(...ts), hi = Math.max(...ts);
      items[i] = { ids: [...items[i].ids, ...items[j].ids], ent: { ...a, a: [a.a[0] + d[0] * lo, a.a[1] + d[1] * lo], b: [a.a[0] + d[0] * hi, a.a[1] + d[1] * hi] }, changed: true };
      items.splice(j, 1); j = i;
    }
  }
  // 2. arcs on the same circle
  for (let i = 0; i < items.length; i++) {
    const a = items[i].ent;
    if (a.type !== 'ARC') continue;
    let reach = ccwSweep(a.a0, a.a1);
    const group = [i];
    for (let j = i + 1; j < items.length; j++) { const b = items[j].ent; if (b.type === 'ARC' && sameCircle(a, b, tol)) group.push(j); }
    if (group.length < 2) continue;
    for (const j of group.slice(1)) { const b = items[j].ent as Extract<Entity, { type: 'ARC' }>; const st = ((b.a0 - a.a0) % TAU + TAU) % TAU; reach = Math.max(reach, st + ccwSweep(b.a0, b.a1)); }
    const ids = group.flatMap((j) => items[j].ids);
    const ent: NewEntity = reach >= TAU - 1e-9 ? { ...baseProps(a), type: 'CIRCLE', c: clonePt(a.c), r: a.r } : { ...(a as Entity), a1: a.a0 + reach } as NewEntity;
    for (const j of group.slice(1).reverse()) items.splice(j, 1);
    items[i] = { ids, ent, changed: true };
  }
  // 3. chains
  type Chain = { ids: number[]; edges: Edge[]; ent: Entity | NewEntity; changed: boolean };
  const pool: Chain[] = items.filter((it) => it.ent.type !== 'CIRCLE').map((it) => ({ ids: it.ids, edges: entityPath(it.ent as Entity)?.edges ?? [], ent: it.ent, changed: it.changed }));
  const circles = items.filter((it) => it.ent.type === 'CIRCLE');
  const done: Chain[] = [];
  while (pool.length) {
    const ch = pool.shift()!;
    let grew = true, n = 1;
    while (grew) {
      grew = false;
      const first = ch.edges[0].a, last = ch.edges[ch.edges.length - 1].b;
      if (ch.edges.length > 1 && dist(first, last) <= tol && n > 1) break;
      for (let i = 0; i < pool.length; i++) {
        const x = pool[i], xa = x.edges[0].a, xb = x.edges[x.edges.length - 1].b;
        const rev = () => x.edges.slice().reverse().map(reverseEdge);
        let add: Edge[] | null = null, front = false;
        if (dist(last, xa) <= tol) add = x.edges; else if (dist(last, xb) <= tol) add = rev();
        else if (dist(first, xb) <= tol) { add = x.edges; front = true; } else if (dist(first, xa) <= tol) { add = rev(); front = true; }
        if (!add) continue;
        ch.edges = front ? [...add, ...ch.edges] : [...ch.edges, ...add];
        ch.ids.push(...x.ids); ch.changed = true; n++;
        pool.splice(i, 1); grew = true; break;
      }
    }
    done.push(ch);
  }
  const res: JoinResult = { remove: [], add: [], joined: 0 };
  for (const it of circles) { res.remove.push(...it.ids); res.add.push(it.ent as NewEntity); res.joined += it.ids.length; }
  for (const ch of done) {
    if (!ch.changed) continue;
    res.remove.push(...ch.ids); res.joined += ch.ids.length;
    if (ch.ids.length === 1 || (ch.ent.type !== 'LWPOLYLINE' && chainIsSingle(ch))) { res.add.push(ch.ent as NewEntity); continue; }
    const src = entities.find((e) => e.id === ch.ids[0])!;
    const closed = ch.edges.length > 1 && dist(ch.edges[0].a, ch.edges[ch.edges.length - 1].b) <= tol;
    const edges = ch.edges.map((e) => ({ a: clonePt(e.a), b: clonePt(e.b), bulge: e.bulge }));
    for (let i = 1; i < edges.length; i++) edges[i].a = clonePt(edges[i - 1].b);
    if (closed) edges[edges.length - 1].b = clonePt(edges[0].a);
    res.add.push(polylineFrom(baseProps(src), edges, closed, src.type === 'LWPOLYLINE' ? { width: src.width } : {}));
  }
  return res;
  function chainIsSingle(ch: Chain) { return ch.ent.type !== 'LWPOLYLINE' && ch.edges.length === (entityPath(ch.ent as Entity)?.edges.length ?? -1); }
}

/** Close a single arc into a circle (JOIN → "Close"). */
export function arcToCircle(a: Extract<Entity, { type: 'ARC' }>): NewEntity { return { ...baseProps(a), type: 'CIRCLE', c: clonePt(a.c), r: a.r }; }

/** Legacy API: the joined entities only. */
export function joinCurves(entities: Entity[], tolerance = 1e-4): NewEntity[] { return joinEntities(entities, tolerance).add; }

// ------------------------------------------------------------------ STRETCH
export type Region = [number, number, number, number] | ((p: Pt) => boolean);
const regionTest = (r: Region) => typeof r === 'function' ? r : (p: Pt) => p[0] >= r[0] - 1e-9 && p[0] <= r[2] + 1e-9 && p[1] >= r[1] - 1e-9 && p[1] <= r[3] + 1e-9;

/** ARC with one endpoint moved, keeping its chord height (sagitta). */
function stretchArc(e: Extract<Entity, { type: 'ARC' }>, moveStart: boolean, delta: Pt): Entity {
  const a = polar(e.c, e.a0, e.r), b = polar(e.c, e.a1, e.r), sw = ccwSweep(e.a0, e.a1);
  const chord = dist(a, b), h = (Math.tan(sw / 4) * chord) / 2;
  const na: Pt = moveStart ? [a[0] + delta[0], a[1] + delta[1]] : a, nb: Pt = moveStart ? b : [b[0] + delta[0], b[1] + delta[1]];
  const nc = dist(na, nb);
  if (nc < 1e-12) return e;
  const bulge = (2 * h) / nc;
  const prim = bulgeToPrim(na, nb, bulge);
  if (prim.k !== 'arc') return e;
  return { ...e, c: prim.c, r: prim.r, a0: angleOf(prim.c, na), a1: angleOf(prim.c, nb) };
}

/**
 * STRETCH one entity: points inside `region` (crossing window box or polygon test) move by `delta`.
 * Lines/polylines move their inside vertices (bulges are kept); an ARC with both ends inside moves, with one end inside it
 * keeps its chord height; circles/ellipses move when their centre is inside; TEXT/MTEXT/INSERT (with attributes) move as a
 * unit when the insertion point is inside; dimensions move only their inside definition points.
 */
export function stretchEntity(e: Entity, region: Region, delta: Pt): Entity {
  const inside = regionTest(region);
  const mv = (p: Pt): Pt => [p[0] + delta[0], p[1] + delta[1]];
  const move = (p: Pt): Pt => inside(p) ? mv(p) : p;
  switch (e.type) {
    case 'LINE': return { ...e, a: move(e.a), b: move(e.b) };
    case 'LWPOLYLINE': return { ...e, pts: e.pts.map((p) => { const q = move([p[0], p[1]]); return p.length > 2 ? [q[0], q[1], ...p.slice(2)] : [q[0], q[1]]; }) };
    case 'SPLINE': return { ...e, pts: e.pts.map(move), ctrl: e.ctrl?.map((p) => { const q = move([p[0], p[1]]); return [q[0], q[1], ...p.slice(2)]; }), fit: e.fit?.map((p) => move([p[0], p[1]])) };
    case 'POINT': return { ...e, p: move(e.p) };
    case 'TEXT': case 'ATTDEF': case 'ATTRIB': return inside(e.p) ? { ...e, p: mv(e.p), p2: e.p2 ? mv(e.p2) : undefined } : e;
    case 'MTEXT': return inside(e.p) ? { ...e, p: mv(e.p) } : e;
    case 'INSERT': return inside(e.p) ? { ...e, p: mv(e.p), attribs: e.attribs?.map((a) => ({ ...a, p: mv(a.p), p2: a.p2 ? mv(a.p2) : undefined })) } : e;
    case 'SOLID': return { ...e, pts: e.pts.map(move) };
    case 'HATCH': {
      const all = e.loops.every((l) => l.every(inside));
      return { ...e, loops: e.loops.map((l) => l.map(move)), lines: all ? e.lines?.map((l) => ({ ...l, base: mv(l.base) })) : e.lines };
    }
    case 'WIPEOUT': return { ...e, loop: e.loop.map(move) };
    case 'CIRCLE': case 'ELLIPSE': return inside(e.c) ? { ...e, c: mv(e.c) } : e;
    case 'ARC': {
      const sIn = inside(polar(e.c, e.a0, e.r)), eIn = inside(polar(e.c, e.a1, e.r));
      if (sIn && eIn) return { ...e, c: mv(e.c) };
      if (sIn || eIn) return stretchArc(e, sIn, delta);
      return e;
    }
    case 'DIMENSION': return { ...e, p1: e.p1 ? move(e.p1) : undefined, p2: e.p2 ? move(e.p2) : undefined, loc: e.loc ? move(e.loc) : undefined, textPoint: e.textPoint ? move(e.textPoint) : undefined };
    default: return e;
  }
}

export function isModifiableCurve(e: Entity): boolean { return isPath(e); }
export { lineLine };
