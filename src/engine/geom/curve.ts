/**
 * Curve paths for the Phase 3B modify commands.
 *
 * A path is a chain of edges; each edge is a straight segment (bulge 0) or a circular arc given by its polyline bulge
 * (tan(sweep/4), positive = counter-clockwise). LINE, ARC, CIRCLE and LWPOLYLINE entities map to paths; a CIRCLE becomes
 * a closed path of two half-circle edges starting at angle 0, so every closed curve is handled the same way.
 *
 * Path parameters follow AutoCAD's curve parameter convention: s = edgeIndex + t, t ∈ [0, 1] along that edge.
 */
import type { Entity, EntBase, NewEntity, Pt } from '../types';
import { arc, intersect, type Arc, type Prim } from './prims';
import { TAU, angleOf, cross, dist, dot, len, norm, perp, polar, sub } from './vec';

export const GEPS = 1e-9;
export type Edge = { a: Pt; b: Pt; bulge: number };
export type CurveKind = 'LINE' | 'ARC' | 'CIRCLE' | 'LWPOLYLINE';
export type Path = { edges: Edge[]; closed: boolean; kind: CurveKind; src?: Entity };
export type CurveEnt = Extract<Entity, { type: CurveKind }>;

export const clonePt = (p: Pt): Pt => [p[0], p[1]];
export const isCurve = (e: Entity | undefined | null): e is CurveEnt =>
  !!e && (e.type === 'LINE' || e.type === 'ARC' || e.type === 'CIRCLE' || e.type === 'LWPOLYLINE');

/** Signed angle (radians) in (-π, π] from u to v. */
export const signedAngle = (u: Pt, v: Pt) => Math.atan2(cross(u, v), dot(u, v));

// ---------------------------------------------------------------- edges
export const edgeSweep = (e: Edge) => 4 * Math.atan(e.bulge);
export const isArcEdge = (e: Edge) => Math.abs(e.bulge) > 1e-12 && dist(e.a, e.b) > GEPS;

/** Centre and radius of an arc edge. */
export function edgeCircle(e: Edge): { c: Pt; r: number } {
  const sw = edgeSweep(e), chord = dist(e.a, e.b);
  const r = chord / (2 * Math.sin(Math.abs(sw) / 2));
  const m: Pt = [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2], d = norm(sub(e.b, e.a));
  const h = r * Math.cos(Math.abs(sw) / 2) * Math.sign(e.bulge);
  return { c: [m[0] - d[1] * h, m[1] + d[0] * h], r };
}

export function edgeLength(e: Edge): number {
  if (!isArcEdge(e)) return dist(e.a, e.b);
  return edgeCircle(e).r * Math.abs(edgeSweep(e));
}

export function edgePoint(e: Edge, t: number): Pt {
  if (t <= 0) return clonePt(e.a);
  if (t >= 1) return clonePt(e.b);
  if (!isArcEdge(e)) return [e.a[0] + (e.b[0] - e.a[0]) * t, e.a[1] + (e.b[1] - e.a[1]) * t];
  const { c, r } = edgeCircle(e);
  return polar(c, angleOf(c, e.a) + edgeSweep(e) * t, r);
}

/** Unit tangent in the travel direction at parameter t. */
export function edgeTangent(e: Edge, t: number): Pt {
  if (!isArcEdge(e)) return norm(sub(e.b, e.a));
  const { c } = edgeCircle(e), p = edgePoint(e, t), rad = norm(sub(p, c));
  return e.bulge > 0 ? perp(rad) : [rad[1], -rad[0]];
}

/** Parameter (unclamped for lines; for arcs measured along the sweep direction, in [0, 2π/|sweep|)) of a point. */
export function edgeParamRaw(e: Edge, p: Pt): number {
  if (!isArcEdge(e)) {
    const d = sub(e.b, e.a), l2 = dot(d, d);
    return l2 < GEPS * GEPS ? 0 : dot(sub(p, e.a), d) / l2;
  }
  const { c } = edgeCircle(e), sw = edgeSweep(e);
  let da = angleOf(c, p) - angleOf(c, e.a);
  if (sw > 0) { da = ((da % TAU) + TAU) % TAU; } else { da = -((((-da) % TAU) + TAU) % TAU); }
  return da / sw;
}

/** Closest parameter on the finite edge. */
export function edgeParam(e: Edge, p: Pt): number {
  const t = edgeParamRaw(e, p);
  if (!isArcEdge(e)) return Math.max(0, Math.min(1, t));
  if (t <= 1) return Math.max(0, t);
  // beyond the end: snap to the angularly closer end
  const full = TAU / Math.abs(edgeSweep(e));
  return (t - 1) < (full - t) ? 1 : 0;
}

export function edgeClosest(e: Edge, p: Pt): { t: number; p: Pt; d: number } {
  const t = edgeParam(e, p), q = edgePoint(e, t);
  return { t, p: q, d: dist(p, q) };
}

/** Sub-edge between parameters t0 < t1 (or t0 > t1 for a reversed piece). */
export function subEdge(e: Edge, t0: number, t1: number): Edge {
  const a = edgePoint(e, t0), b = edgePoint(e, t1);
  return { a, b, bulge: isArcEdge(e) ? Math.tan(edgeSweep(e) * (t1 - t0) / 4) : 0 };
}
export const reverseEdge = (e: Edge): Edge => ({ a: clonePt(e.b), b: clonePt(e.a), bulge: -e.bulge });

/** Analytic primitive (prims.ts form: arcs CCW). */
export function edgePrim(e: Edge): Prim {
  if (!isArcEdge(e)) return { k: 'seg', a: e.a, b: e.b };
  const { c, r } = edgeCircle(e), s = angleOf(c, e.a), t = angleOf(c, e.b);
  return e.bulge > 0 ? arc(c, r, s, t) : arc(c, r, t, s);
}

export function edgeBox(e: Edge): [number, number, number, number] {
  if (!isArcEdge(e)) return [Math.min(e.a[0], e.b[0]), Math.min(e.a[1], e.b[1]), Math.max(e.a[0], e.b[0]), Math.max(e.a[1], e.b[1])];
  const { c, r } = edgeCircle(e);
  const b: [number, number, number, number] = [Math.min(e.a[0], e.b[0]), Math.min(e.a[1], e.b[1]), Math.max(e.a[0], e.b[0]), Math.max(e.a[1], e.b[1])];
  const sw = edgeSweep(e), a0 = angleOf(c, e.a);
  for (let k = -4; k <= 8; k++) {
    const ang = k * Math.PI / 2, t = (sw > 0 ? (((ang - a0) % TAU) + TAU) % TAU : -((((a0 - ang) % TAU) + TAU) % TAU)) / sw;
    if (t > 0 && t < 1) { const p = polar(c, ang, r); b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]); }
  }
  return b;
}
const boxesMeet = (a: number[], b: number[], tol: number) => a[0] <= b[2] + tol && b[0] <= a[2] + tol && a[1] <= b[3] + tol && b[1] <= a[3] + tol;

/** Finite intersections of two edges with their parameters. */
export function edgeIntersections(e: Edge, f: Edge): { p: Pt; t: number; u: number }[] {
  if (!boxesMeet(edgeBox(e), edgeBox(f), 1e-7)) return [];
  const out: { p: Pt; t: number; u: number }[] = [];
  for (const p of intersect(edgePrim(e), edgePrim(f))) {
    if (out.some((q) => dist(q.p, p) < 1e-9)) continue;
    out.push({ p, t: edgeParam(e, p), u: edgeParam(f, p) });
  }
  return out;
}

/** Signed area contribution of an edge (shoelace + circular segment). */
export function edgeArea(e: Edge): number {
  let a = (e.a[0] * e.b[1] - e.b[0] * e.a[1]) / 2;
  if (isArcEdge(e)) { const { r } = edgeCircle(e), sw = edgeSweep(e); a += (r * r / 2) * (sw - Math.sin(sw)); }
  return a;
}
export const pathArea = (edges: Edge[]) => edges.reduce((s, e) => s + edgeArea(e), 0);

// ---------------------------------------------------------------- entity ↔ path
export function entityPath(e: Entity): Path | null {
  if (e.type === 'LINE') return { kind: 'LINE', closed: false, edges: [{ a: clonePt(e.a), b: clonePt(e.b), bulge: 0 }], src: e };
  if (e.type === 'ARC') {
    let sw = ((e.a1 - e.a0) % TAU + TAU) % TAU; if (sw < 1e-12) sw = TAU;
    const a = polar(e.c, e.a0, e.r), b = polar(e.c, e.a1, e.r);
    if (sw > TAU - 1e-9) {
      const m = polar(e.c, e.a0 + Math.PI, e.r);
      return { kind: 'ARC', closed: false, edges: [{ a, b: m, bulge: 1 }, { a: m, b, bulge: 1 }], src: e };
    }
    return { kind: 'ARC', closed: false, edges: [{ a, b, bulge: Math.tan(sw / 4) }], src: e };
  }
  if (e.type === 'CIRCLE') {
    const a = polar(e.c, 0, e.r), m = polar(e.c, Math.PI, e.r);
    return { kind: 'CIRCLE', closed: true, edges: [{ a, b: m, bulge: 1 }, { a: m, b: clonePt(a), bulge: 1 }], src: e };
  }
  if (e.type === 'LWPOLYLINE') {
    const n = e.pts.length;
    if (n < 2) return null;
    const count = e.closed ? n : n - 1, edges: Edge[] = [];
    for (let i = 0; i < count; i++) {
      const p = e.pts[i], q = e.pts[(i + 1) % n];
      edges.push({ a: [p[0], p[1]], b: [q[0], q[1]], bulge: p[2] ?? 0 });
    }
    return { kind: 'LWPOLYLINE', closed: !!e.closed, edges, src: e };
  }
  return null;
}

export const pathEnd = (p: Path) => p.edges.length;
export function pathPoint(path: Path, s: number): Pt {
  const n = path.edges.length;
  if (path.closed) s = ((s % n) + n) % n;
  const i = Math.min(n - 1, Math.max(0, Math.floor(s)));
  return edgePoint(path.edges[i], Math.max(0, Math.min(1, s - i)));
}
export function pathTangent(path: Path, s: number): Pt {
  const n = path.edges.length;
  if (path.closed) s = ((s % n) + n) % n;
  const i = Math.min(n - 1, Math.max(0, Math.floor(s)));
  return edgeTangent(path.edges[i], Math.max(0, Math.min(1, s - i)));
}
export function pathClosest(path: Path, p: Pt): { s: number; p: Pt; d: number; i: number } {
  let best = { s: 0, p: path.edges[0].a, d: Infinity, i: 0 };
  path.edges.forEach((e, i) => {
    const c = edgeClosest(e, p);
    if (c.d < best.d - 1e-12) best = { s: i + c.t, p: c.p, d: c.d, i };
  });
  return best;
}
export const pathLength = (path: Path) => path.edges.reduce((s, e) => s + edgeLength(e), 0);

/** Edges between s0 and s1 (s0 < s1; on a closed path s1 may exceed the end to wrap around). */
export function pathSlice(path: Path, s0: number, s1: number): Edge[] {
  const n = path.edges.length, out: Edge[] = [];
  if (s1 - s0 < 1e-12) return out;
  for (let k = Math.floor(s0); k < Math.ceil(s1 - 1e-12); k++) {
    const i = ((k % n) + n) % n;
    if (!path.closed && (k < 0 || k >= n)) continue;
    const t0 = Math.max(0, s0 - k), t1 = Math.min(1, s1 - k);
    if (t1 - t0 < 1e-12) continue;
    const e = path.edges[i];
    out.push(t0 <= 0 && t1 >= 1 ? { a: clonePt(e.a), b: clonePt(e.b), bulge: e.bulge } : subEdge(e, t0, t1));
  }
  return out.filter((e) => dist(e.a, e.b) > 1e-12 || out.length === 1);
}

// ---------------------------------------------------------------- entity properties
export function baseProps(e: Entity | NewEntity): Pick<EntBase, 'layer' | 'color' | 'trueColor' | 'linetype' | 'ltScale' | 'lineweight'> {
  const b = e as EntBase;
  return {
    layer: b.layer,
    ...(b.color !== undefined ? { color: b.color } : {}),
    ...(b.trueColor !== undefined ? { trueColor: b.trueColor } : {}),
    ...(b.linetype !== undefined ? { linetype: b.linetype } : {}),
    ...(b.ltScale !== undefined ? { ltScale: b.ltScale } : {}),
    ...(b.lineweight !== undefined ? { lineweight: b.lineweight } : {}),
  };
}

/** Polyline vertex list from an edge chain. */
export function edgesToPts(edges: Edge[], closed: boolean): number[][] {
  const pts = edges.map((e) => [e.a[0], e.a[1], e.bulge]);
  if (!closed && edges.length) { const l = edges[edges.length - 1]; pts.push([l.b[0], l.b[1], 0]); }
  return pts;
}

/**
 * Entity for a piece of a source curve: a LINE stays a LINE, a piece of an ARC/CIRCLE becomes an ARC (always CCW),
 * a polyline piece stays an LWPOLYLINE (with its width/source tags).
 */
export function entityFromEdges(src: Entity, edges: Edge[], closed = false): NewEntity | null {
  if (!edges.length) return null;
  const props = baseProps(src);
  if (src.type === 'LINE') return { ...props, type: 'LINE', a: clonePt(edges[0].a), b: clonePt(edges[edges.length - 1].b) };
  if (src.type === 'ARC' || src.type === 'CIRCLE') {
    const sweep = edges.reduce((s, e) => s + edgeSweep(e), 0);
    if (closed || Math.abs(sweep) >= TAU - 1e-9) return { ...props, type: 'CIRCLE', c: clonePt(src.c), r: src.r };
    const s = angleOf(src.c, edges[0].a), t = angleOf(src.c, edges[edges.length - 1].b);
    return sweep > 0 ? { ...props, type: 'ARC', c: clonePt(src.c), r: src.r, a0: s, a1: t } : { ...props, type: 'ARC', c: clonePt(src.c), r: src.r, a0: t, a1: s };
  }
  if (src.type === 'LWPOLYLINE') {
    return { ...props, type: 'LWPOLYLINE', pts: edgesToPts(edges, closed), closed, ...(src.width !== undefined ? { width: src.width } : {}), ...(src.source !== undefined ? { source: src.source } : {}) };
  }
  return null;
}

/** Polyline entity from edges with explicit properties. */
export function polylineFrom(props: ReturnType<typeof baseProps>, edges: Edge[], closed: boolean, extra: { width?: number; source?: string } = {}): NewEntity {
  return { ...props, type: 'LWPOLYLINE', pts: edgesToPts(edges, closed), closed, ...(extra.width !== undefined ? { width: extra.width } : {}), ...(extra.source !== undefined ? { source: extra.source } : {}) };
}

// ---------------------------------------------------------------- cutting / boundary edges
/** Large length used to model infinite (extended) cutting edges. */
export const FAR = 1e8;

/**
 * Edges usable as cutting/boundary edges. Lines, arcs, circles and polylines are exact; ellipses and splines are
 * approximated by chords. With `extend` (EDGEMODE=1) lines become infinite and arcs full circles.
 */
export function boundaryEdges(e: Entity, extend = false, splinePoints?: (e: Entity) => Pt[] | null): Edge[] {
  const path = entityPath(e);
  if (path) {
    if (!extend) return path.edges;
    if (e.type === 'LINE') {
      const d = norm(sub(e.b, e.a));
      return len(d) ? [{ a: [e.a[0] - d[0] * FAR, e.a[1] - d[1] * FAR], b: [e.a[0] + d[0] * FAR, e.a[1] + d[1] * FAR], bulge: 0 }] : [];
    }
    if (e.type === 'ARC') return entityPath({ ...e, type: 'CIRCLE' } as Entity)!.edges;
    return path.edges;
  }
  if (e.type === 'ELLIPSE') {
    const n = 128, r = Math.hypot(e.major[0], e.major[1]), rot = Math.atan2(e.major[1], e.major[0]);
    let sw = e.a1 - e.a0; while (sw <= 0) sw += TAU; if (sw > TAU) sw = TAU;
    const pts: Pt[] = [];
    const steps = Math.max(8, Math.ceil(n * sw / TAU));
    for (let i = 0; i <= steps; i++) {
      const t = e.a0 + sw * i / steps, x = r * Math.cos(t), y = r * e.ratio * Math.sin(t);
      pts.push([e.c[0] + x * Math.cos(rot) - y * Math.sin(rot), e.c[1] + x * Math.sin(rot) + y * Math.cos(rot)]);
    }
    return pts.slice(1).map((p, i) => ({ a: pts[i], b: p, bulge: 0 }));
  }
  if (e.type === 'SPLINE') {
    const pts = splinePoints?.(e) ?? e.pts;
    if (!pts || pts.length < 2) return [];
    const out = pts.slice(1).map((p, i) => ({ a: pts[i], b: p, bulge: 0 }));
    if (e.closed) out.push({ a: pts[pts.length - 1], b: pts[0], bulge: 0 });
    return out;
  }
  return [];
}

/** Path parameters where `path` meets any of the edges (sorted, de-duplicated). */
export function pathBreaks(path: Path, cutters: Edge[]): number[] {
  const out: number[] = [];
  path.edges.forEach((e, i) => {
    for (const f of cutters) for (const x of edgeIntersections(e, f)) {
      let s = i + x.t;
      if (path.closed && s >= path.edges.length - 1e-12) s = 0;
      if (!out.some((y) => Math.abs(y - s) < 1e-9 || dist(pathPoint(path, y), x.p) < 1e-9)) out.push(s);
    }
  });
  return out.sort((a, b) => a - b);
}

export type ArcLike = Arc;
