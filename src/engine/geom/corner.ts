/**
 * FILLET and CHAMFER geometry (AutoCAD behaviour).
 *
 * Line–line corners use the "ray" method: the picked points decide which side of the intersection is kept on each
 * line. Parallel lines get a semicircle. Line/arc/circle combinations use offset-support intersections; the candidate
 * whose tangent points are closest to the picks wins. Circles are never trimmed. The direction of the fillet arc
 * follows from tangent continuity with the kept parts. Polyline segments are supported: two adjacent line segments of
 * one polyline (the arc / chamfer is inserted) or an end line segment of an open polyline with another object (the
 * arc / chamfer is merged into the polyline).
 */
import type { Entity, NewEntity, PolylineEnt, Pt } from '../types';
import { lineLine } from './prims';
import { TAU, add, angleOf, ccwSweep, cross, dist, dot, len, mulS, norm, perp, polar, sub } from './vec';
import { baseProps, clonePt, edgeCircle, edgeClosest, entityPath, isArcEdge, signedAngle, type Edge } from './curve';

export type CornerPick = { ent: Entity; p: Pt };
export type CornerError = 'parallel' | 'radius' | 'distance' | 'unsupported' | 'notAdjacent' | 'notEndSegment' | 'noSolution' | 'sameObject' | 'collinear';
export type CornerResult =
  | { ok: true; updates: { id: number; ent: NewEntity }[]; add: NewEntity[]; corner: NewEntity | null }
  | { ok: false; error: CornerError };
export type CornerOptions = { trim?: boolean };

type LineSup = { kind: 'line'; a: Pt; b: Pt };
type ArcSup = { kind: 'arc'; c: Pt; r: number; a0: number; a1: number };
type CircleSup = { kind: 'circle'; c: Pt; r: number };
type Sup = LineSup | ArcSup | CircleSup;
type Obj = { ent: Entity; p: Pt; sup: Sup; seg?: number };

const fail = (error: CornerError): CornerResult => ({ ok: false, error });

/** Geometry of the picked object (polylines: the picked segment). */
function objOf(pk: CornerPick): Obj | null {
  const e = pk.ent;
  if (e.type === 'LINE') return dist(e.a, e.b) > 1e-12 ? { ent: e, p: pk.p, sup: { kind: 'line', a: e.a, b: e.b } } : null;
  if (e.type === 'ARC') return { ent: e, p: pk.p, sup: { kind: 'arc', c: e.c, r: e.r, a0: e.a0, a1: e.a1 } };
  if (e.type === 'CIRCLE') return { ent: e, p: pk.p, sup: { kind: 'circle', c: e.c, r: e.r } };
  if (e.type === 'LWPOLYLINE') {
    const path = entityPath(e);
    if (!path) return null;
    let best = { i: -1, d: Infinity };
    path.edges.forEach((x, i) => { if (dist(x.a, x.b) < 1e-12) return; const c = edgeClosest(x, pk.p); if (c.d < best.d - 1e-12) best = { i, d: c.d }; });
    if (best.i < 0) return null;
    const x = path.edges[best.i];
    if (isArcEdge(x)) {
      const { c, r } = edgeCircle(x), s = angleOf(c, x.a), t = angleOf(c, x.b);
      return { ent: e, p: pk.p, seg: best.i, sup: x.bulge > 0 ? { kind: 'arc', c, r, a0: s, a1: t } : { kind: 'arc', c, r, a0: t, a1: s } };
    }
    return { ent: e, p: pk.p, seg: best.i, sup: { kind: 'line', a: x.a, b: x.b } };
  }
  return null;
}

/** Layer/properties for the new fillet arc / chamfer line: the source layer if both objects share it, else current. */
function cornerProps(a: Entity, b: Entity) {
  return a.layer === b.layer ? baseProps(a) : { layer: '' };
}

// ------------------------------------------------------------------ trimming a single support at a point
type Trimmed = { geo: Sup; k: Pt; replacedStart: boolean } | null;
/** Trim/extend support `o` so that it ends at T on the pick side. k = direction from T into the kept part. */
function trimSupport(o: Obj, T: Pt): Trimmed {
  const s = o.sup;
  if (s.kind === 'line') {
    const d = norm(sub(s.b, s.a));
    let sg = dot(sub(o.p, T), d);
    if (Math.abs(sg) < 1e-12) sg = dot(sub(s.a, T), d) + dot(sub(s.b, T), d);
    const u = sg >= 0 ? d : mulS(d, -1);
    const da = dot(sub(s.a, T), u), db = dot(sub(s.b, T), u);
    if (Math.max(da, db) <= 1e-9) return null;
    const keepA = da >= db;
    return keepA ? { geo: { kind: 'line', a: s.a, b: T }, k: u, replacedStart: false } : { geo: { kind: 'line', a: T, b: s.b }, k: u, replacedStart: true };
  }
  if (s.kind === 'circle') {
    const t = perp(norm(sub(T, s.c)));
    return { geo: s, k: dot(t, sub(o.p, T)) >= 0 ? t : mulS(t, -1), replacedStart: false };
  }
  const th = angleOf(s.c, T), ph = angleOf(s.c, o.p), sw = ccwSweep(s.a0, s.a1);
  const relT = ((th - s.a0) % TAU + TAU) % TAU, relP = ((ph - s.a0) % TAU + TAU) % TAU;
  const ccwT = perp(norm(sub(T, s.c)));
  const A: ArcSup = { ...s, a0: th }, B: ArcSup = { ...s, a1: th };
  let useA: boolean;
  if (relT <= sw + 1e-9) useA = relP >= relT; // T on the arc: keep the side holding the pick
  else useA = ccwSweep(th, s.a0) <= ccwSweep(s.a1, th); // T beyond the arc: extend the nearer end
  if (ccwSweep(useA ? A.a0 : B.a0, useA ? A.a1 : B.a1) < 1e-9) return null;
  return useA ? { geo: A, k: ccwT, replacedStart: true } : { geo: B, k: mulS(ccwT, -1), replacedStart: false };
}

function supEntity(o: Obj, g: Sup): NewEntity {
  const props = baseProps(o.ent);
  if (g.kind === 'line') return { ...props, type: 'LINE', a: clonePt(g.a), b: clonePt(g.b) };
  if (g.kind === 'arc') return { ...props, type: 'ARC', c: clonePt(g.c), r: g.r, a0: g.a0, a1: g.a1 };
  return { ...props, type: 'CIRCLE', c: clonePt(g.c), r: g.r };
}

/** Fillet arc from T1 to T2 with centre C, oriented by tangent continuity with the kept direction k1 at T1. */
function filletArc(C: Pt, r: number, T1: Pt, T2: Pt, k1: Pt): { a0: number; a1: number; fromT1: boolean } {
  const tc = perp(norm(sub(T1, C)));
  const fromT1 = dot(tc, mulS(k1, -1)) > 0;
  return fromT1 ? { a0: angleOf(C, T1), a1: angleOf(C, T2), fromT1 } : { a0: angleOf(C, T2), a1: angleOf(C, T1), fromT1 };
}

// ------------------------------------------------------------------ candidate construction
type Cand = { C: Pt; T1: Pt; T2: Pt };
function foot(s: Sup, p: Pt): Pt {
  if (s.kind === 'line') { const d = norm(sub(s.b, s.a)); return add(s.a, mulS(d, dot(sub(p, s.a), d))); }
  const v = sub(p, s.c), l = len(v);
  return l < 1e-12 ? polar(s.c, 0, s.r) : add(s.c, mulS(v, s.r / l));
}
type Off = { kind: 'line'; a: Pt; b: Pt } | { kind: 'circle'; c: Pt; r: number };
function offsets(s: Sup, r: number): Off[] {
  if (s.kind === 'line') {
    const n = perp(norm(sub(s.b, s.a)));
    return r === 0 ? [{ kind: 'line', a: s.a, b: s.b }] : [-1, 1].map((g) => ({ kind: 'line' as const, a: add(s.a, mulS(n, g * r)), b: add(s.b, mulS(n, g * r)) }));
  }
  return (r === 0 ? [s.r] : [s.r + r, s.r - r]).filter((x) => x > 1e-12).map((x) => ({ kind: 'circle' as const, c: s.c, r: x }));
}
function lineCircleAll(a: Pt, b: Pt, c: Pt, r: number): Pt[] {
  const d = norm(sub(b, a)), f = sub(a, c), B = dot(f, d), C = dot(f, f) - r * r;
  let disc = B * B - C;
  if (disc < -1e-9 * Math.max(1, r * r)) return [];
  disc = Math.max(0, disc);
  const s = Math.sqrt(disc);
  return s < 1e-12 ? [add(a, mulS(d, -B))] : [add(a, mulS(d, -B - s)), add(a, mulS(d, -B + s))];
}
function circleCircleAll(c1: Pt, r1: number, c2: Pt, r2: number): Pt[] {
  const d = dist(c1, c2);
  if (d < 1e-12 || d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const u = mulS(sub(c2, c1), 1 / d), m = add(c1, mulS(u, a));
  return h < 1e-12 ? [m] : [[m[0] - u[1] * h, m[1] + u[0] * h], [m[0] + u[1] * h, m[1] - u[0] * h]];
}
function offInter(a: Off, b: Off): Pt[] {
  if (a.kind === 'line' && b.kind === 'line') { const x = lineLine(a.a, a.b, b.a, b.b); return x ? [x] : []; }
  if (a.kind === 'line' && b.kind === 'circle') return lineCircleAll(a.a, a.b, b.c, b.r);
  if (a.kind === 'circle' && b.kind === 'line') return lineCircleAll(b.a, b.b, a.c, a.r);
  if (a.kind === 'circle' && b.kind === 'circle') return circleCircleAll(a.c, a.r, b.c, b.r);
  return [];
}
function candidates(o1: Obj, o2: Obj, r: number): Cand[] {
  const out: Cand[] = [];
  for (const f of offsets(o1.sup, r)) for (const g of offsets(o2.sup, r)) for (const C of offInter(f, g)) {
    const T1 = r === 0 ? C : foot(o1.sup, C), T2 = r === 0 ? C : foot(o2.sup, C);
    if (r > 0 && (Math.abs(dist(C, T1) - r) > 1e-6 * Math.max(1, r) || Math.abs(dist(C, T2) - r) > 1e-6 * Math.max(1, r))) continue;
    out.push({ C, T1, T2 });
  }
  return out;
}

// ------------------------------------------------------------------ polyline write-back
const ptsOf = (pl: PolylineEnt) => pl.pts.map((p) => [p[0], p[1], p[2] ?? 0, ...p.slice(3)]);
/** Signed bulge of the corner piece when travelling from P to Q (arc given by centre / CCW angles / which end is a0). */
function cornerBulge(arcInfo: { a0: number; a1: number } | null, fromP: boolean): number {
  if (!arcInfo) return 0;
  const sw = ccwSweep(arcInfo.a0, arcInfo.a1), b = Math.tan(sw / 4);
  return fromP ? b : -b;
}

/** Line–line corner shared by fillet and chamfer (with trims); returns tangent / chamfer points. */
type LineCorner = { X: Pt; u1: Pt; u2: Pt; far1: number; far2: number };
function lineCorner(o1: Obj, o2: Obj): LineCorner | CornerError {
  const s1 = o1.sup as LineSup, s2 = o2.sup as LineSup;
  const X = lineLine(s1.a, s1.b, s2.a, s2.b);
  if (!X) return 'parallel';
  const dir = (s: LineSup, p: Pt) => {
    const d = norm(sub(s.b, s.a));
    let sg = dot(sub(p, X), d);
    if (Math.abs(sg) < 1e-9) sg = dot(sub(s.a, X), d) + dot(sub(s.b, X), d);
    const u = sg >= 0 ? d : mulS(d, -1);
    return { u, far: Math.max(dot(sub(s.a, X), u), dot(sub(s.b, X), u)) };
  };
  const a = dir(s1, o1.p), b = dir(s2, o2.p);
  return { X, u1: a.u, u2: b.u, far1: a.far, far2: b.far };
}

type Plan = { T1: Pt; T2: Pt; arc: { C: Pt; r: number; a0: number; a1: number; fromT1: boolean } | null; g1: Sup; g2: Sup };

function writeBack(o1: Obj, o2: Obj, plan: Plan, trim: boolean, kind: 'fillet' | 'chamfer'): CornerResult {
  const props = cornerProps(o1.ent, o2.ent);
  const zero = dist(plan.T1, plan.T2) < 1e-9;
  const cornerEnt: NewEntity | null = zero ? null : plan.arc
    ? { ...props, type: 'ARC', c: plan.arc.C, r: plan.arc.r, a0: plan.arc.a0, a1: plan.arc.a1 }
    : { ...props, type: 'LINE', a: clonePt(plan.T1), b: clonePt(plan.T2) };
  if (!trim) return { ok: true, updates: [], add: cornerEnt ? [cornerEnt] : [], corner: cornerEnt };
  const arcFromT1 = plan.arc ? plan.arc.fromT1 : true;
  const updates: { id: number; ent: NewEntity }[] = [];
  const add: NewEntity[] = [];
  let merged = false;
  // polylines: merge the corner into the polyline when the picked segment is an end segment
  const polyEnd = (o: Obj, g: Sup, T: Pt, isFirst: boolean): NewEntity | 'bad' | null => {
    if (o.ent.type !== 'LWPOLYLINE') return null;
    const pl = o.ent, n = pl.pts.length, seg = o.seg!;
    if (pl.closed || g.kind !== 'line') return 'bad';
    const pts = ptsOf(pl);
    const lastSeg = n - 2;
    const movesStart = dist(g.a, T) < 1e-9 && seg === 0;
    const movesEnd = dist(g.b, T) < 1e-9 && seg === lastSeg;
    if (!movesStart && !movesEnd) return 'bad';
    const other = isFirst ? plan.T2 : plan.T1;
    // travelling polyline → corner → other object: the corner goes from T (this) to `other`
    const fromThis = isFirst ? arcFromT1 : !arcFromT1;
    if (movesEnd) {
      pts[n - 1] = [T[0], T[1], 0];
      if (!zero && !merged) { pts[n - 1][2] = cornerBulge(plan.arc, fromThis); pts.push([other[0], other[1], 0]); merged = true; }
    } else {
      pts[0] = [T[0], T[1], pts[0][2]];
      if (!zero && !merged) { pts.unshift([other[0], other[1], cornerBulge(plan.arc, !fromThis)]); merged = true; }
    }
    return { ...pl, pts } as NewEntity;
  };
  const p1 = polyEnd(o1, plan.g1, plan.T1, true);
  if (p1 === 'bad') return fail('notEndSegment');
  const p2 = polyEnd(o2, plan.g2, plan.T2, false);
  if (p2 === 'bad') return fail('notEndSegment');
  if (p1) updates.push({ id: o1.ent.id, ent: p1 }); else if (o1.sup.kind !== 'circle') updates.push({ id: o1.ent.id, ent: supEntity(o1, plan.g1) });
  if (p2) updates.push({ id: o2.ent.id, ent: p2 }); else if (o2.sup.kind !== 'circle') updates.push({ id: o2.ent.id, ent: supEntity(o2, plan.g2) });
  if (cornerEnt && !merged) add.push(cornerEnt);
  void kind;
  return { ok: true, updates, add, corner: cornerEnt };
}

/** Same polyline, two adjacent line segments: insert the corner at their common vertex. */
function samePolyline(o1: Obj, o2: Obj, make: (lc: LineCorner) => { T1: Pt; T2: Pt; d1: number; d2: number; arc: Plan['arc'] } | CornerError): CornerResult {
  const pl = o1.ent as PolylineEnt, n = pl.pts.length, segs = pl.closed ? n : n - 1;
  let i = o1.seg!, j = o2.seg!;
  if (i === j) return fail('sameObject');
  let a = i, b = j;
  if ((a + 1) % n === b && (pl.closed || a + 1 < n)) { /* a → b */ } else if ((b + 1) % n === a && (pl.closed || b + 1 < n)) { [a, b] = [b, a]; } else return fail('notAdjacent');
  if (b >= segs) return fail('notAdjacent');
  const first = a === i ? o1 : o2, second = a === i ? o2 : o1;
  if (first.sup.kind !== 'line' || second.sup.kind !== 'line') return fail('unsupported');
  const lc = lineCorner(first, second);
  if (typeof lc === 'string') return fail(lc);
  // the shared vertex must be the one that moves
  const V = (first.sup as LineSup).b;
  if (dot(sub(V, lc.X), lc.u1) > 1e-9 || dot(sub(V, lc.X), lc.u2) > 1e-9) return fail('noSolution');
  const r = make(lc);
  if (typeof r === 'string') return fail(r);
  const pts = ptsOf(pl), v = b; // vertex index of the shared vertex
  const lenA = dist((first.sup as LineSup).a, V) + dist(V, lc.X), lenB = dist((second.sup as LineSup).b, V) + dist(V, lc.X);
  if (r.d1 > lenA + 1e-9 || r.d2 > lenB + 1e-9) return fail(r.arc ? 'radius' : 'distance');
  const orig = pts[v];
  const repl = dist(r.T1, r.T2) < 1e-9 ? [[r.T1[0], r.T1[1], orig[2] ?? 0]] : [[r.T1[0], r.T1[1], r.arc ? cornerBulge(r.arc, r.arc.fromT1) : 0], [r.T2[0], r.T2[1], orig[2] ?? 0]];
  pts.splice(v, 1, ...repl);
  return { ok: true, updates: [{ id: pl.id, ent: { ...pl, pts } as NewEntity }], add: [], corner: null };
}

// ------------------------------------------------------------------ FILLET
export function fillet(k1: CornerPick, k2: CornerPick, radius: number, o: CornerOptions = {}): CornerResult {
  const trim = o.trim !== false;
  const o1 = objOf(k1), o2 = objOf(k2);
  if (!o1 || !o2) return fail('unsupported');
  if (o1.ent.id === o2.ent.id) {
    if (o1.ent.type !== 'LWPOLYLINE') return fail('sameObject');
    return samePolyline(o1, o2, (lc) => {
      const th = Math.acos(Math.max(-1, Math.min(1, dot(lc.u1, lc.u2))));
      if (th < 1e-9 || th > Math.PI - 1e-9) return 'collinear';
      const td = radius / Math.tan(th / 2);
      const T1 = add(lc.X, mulS(lc.u1, td)), T2 = add(lc.X, mulS(lc.u2, td));
      if (radius === 0) return { T1, T2, d1: 0, d2: 0, arc: null };
      const C = add(lc.X, mulS(norm(add(lc.u1, lc.u2)), radius / Math.sin(th / 2)));
      return { T1, T2, d1: td, d2: td, arc: { C, r: radius, ...filletArc(C, radius, T1, T2, lc.u1) } };
    });
  }
  // line – line
  if (o1.sup.kind === 'line' && o2.sup.kind === 'line') {
    const lc = lineCorner(o1, o2);
    if (lc === 'parallel') return parallelFillet(o1, o2, trim);
    if (typeof lc === 'string') return fail(lc);
    const th = Math.acos(Math.max(-1, Math.min(1, dot(lc.u1, lc.u2))));
    if (th < 1e-9 || th > Math.PI - 1e-9) return fail('collinear');
    const td = radius / Math.tan(th / 2);
    if (lc.far1 < td - 1e-9 || lc.far2 < td - 1e-9) return fail('radius');
    const T1 = add(lc.X, mulS(lc.u1, td)), T2 = add(lc.X, mulS(lc.u2, td));
    const g1 = trimSupport({ ...o1, p: add(T1, lc.u1) }, T1)!, g2 = trimSupport({ ...o2, p: add(T2, lc.u2) }, T2)!;
    if (!g1 || !g2) return fail('radius');
    if (radius === 0) return writeBack(o1, o2, { T1, T2, arc: null, g1: g1.geo, g2: g2.geo }, trim, 'fillet');
    const C = add(lc.X, mulS(norm(add(lc.u1, lc.u2)), radius / Math.sin(th / 2)));
    return writeBack(o1, o2, { T1, T2, arc: { C, r: radius, ...filletArc(C, radius, T1, T2, lc.u1) }, g1: g1.geo, g2: g2.geo }, trim, 'fillet');
  }
  // general: line / arc / circle
  const cands = candidates(o1, o2, radius);
  if (!cands.length) return fail(radius > 0 ? 'radius' : 'noSolution');
  let best: { c: Cand; s: number; t1: NonNullable<Trimmed>; t2: NonNullable<Trimmed> } | null = null;
  for (const c of cands) {
    const t1 = trimSupport(o1, c.T1), t2 = trimSupport(o2, c.T2);
    if (!t1 || !t2) continue;
    // the fillet arc must leave each object backwards from its kept direction (tangent continuity)
    if (radius > 0) {
      const a = filletArc(c.C, radius, c.T1, c.T2, t1.k);
      const tc2 = perp(norm(sub(c.T2, c.C)));
      const arrive = a.fromT1 ? tc2 : mulS(tc2, -1); // direction of travel at T2 going T1 → T2
      if (dot(arrive, t2.k) < 1 - 1e-6) continue;
      if (ccwSweep(a.a0, a.a1) > Math.PI + 1e-9 && o1.sup.kind !== 'circle' && o2.sup.kind !== 'circle') continue;
    }
    const s = dist(c.T1, o1.p) + dist(c.T2, o2.p);
    if (!best || s < best.s - 1e-9) best = { c, s, t1, t2 };
  }
  if (!best) return fail(radius > 0 ? 'radius' : 'noSolution');
  const { c, t1, t2 } = best;
  const arcInfo = radius > 0 ? { C: c.C, r: radius, ...filletArc(c.C, radius, c.T1, c.T2, t1.k) } : null;
  return writeBack(o1, o2, { T1: c.T1, T2: c.T2, arc: arcInfo, g1: t1.geo, g2: t2.geo }, trim, 'fillet');
}

/** Parallel lines: a semicircle at the end of the first line nearest its pick; the second line is trimmed/extended to it. */
function parallelFillet(o1: Obj, o2: Obj, trim: boolean): CornerResult {
  const s1 = o1.sup as LineSup, s2 = o2.sup as LineSup;
  const d = norm(sub(s1.b, s1.a)), n = perp(d);
  const gap = dot(sub(s2.a, s1.a), n);
  if (Math.abs(gap) < 1e-9) return fail('collinear');
  const r = Math.abs(gap) / 2;
  const tp = dot(sub(o1.p, s1.a), d), L = dist(s1.a, s1.b);
  const endIsB = tp >= L / 2;
  const E1 = endIsB ? s1.b : s1.a, u: Pt = endIsB ? d : mulS(d, -1); // outward direction
  const F = add(E1, mulS(n, gap));
  const C: Pt = [(E1[0] + F[0]) / 2, (E1[1] + F[1]) / 2];
  // second line: keep the end farthest opposite to u
  const da = dot(sub(s2.a, F), u), db = dot(sub(s2.b, F), u);
  const g2: LineSup = da <= db ? { kind: 'line', a: s2.a, b: F } : { kind: 'line', a: F, b: s2.b };
  if (Math.min(da, db) > -1e-9) return fail('noSolution');
  const midCCW = angleOf(C, E1) + Math.PI / 2;
  const fromT1 = dot([Math.cos(midCCW), Math.sin(midCCW)], u) > 0;
  const arc = { C, r, a0: fromT1 ? angleOf(C, E1) : angleOf(C, F), a1: fromT1 ? angleOf(C, F) : angleOf(C, E1), fromT1 };
  return writeBack(o1, o2, { T1: E1, T2: F, arc, g1: s1, g2 }, trim, 'fillet');
}

// ------------------------------------------------------------------ CHAMFER
export type ChamferSpec = { method: 'distance'; d1: number; d2: number } | { method: 'angle'; length: number; angle: number };
function chamferDistances(lc: LineCorner, spec: ChamferSpec): { d1: number; d2: number } | CornerError {
  if (spec.method === 'distance') return { d1: spec.d1, d2: spec.d2 };
  const th = Math.acos(Math.max(-1, Math.min(1, dot(lc.u1, lc.u2))));
  const rest = Math.PI - th - spec.angle;
  if (rest <= 1e-9) return 'distance';
  return { d1: spec.length, d2: (spec.length * Math.sin(spec.angle)) / Math.sin(rest) };
}

export function chamfer(k1: CornerPick, k2: CornerPick, spec: ChamferSpec, o: CornerOptions = {}): CornerResult {
  const trim = o.trim !== false;
  const o1 = objOf(k1), o2 = objOf(k2);
  if (!o1 || !o2) return fail('unsupported');
  if (o1.sup.kind !== 'line' || o2.sup.kind !== 'line') return fail('unsupported');
  if (o1.ent.id === o2.ent.id) {
    if (o1.ent.type !== 'LWPOLYLINE') return fail('sameObject');
    return samePolyline(o1, o2, (lc) => {
      const d = chamferDistances(lc, spec);
      if (typeof d === 'string') return d;
      return { T1: add(lc.X, mulS(lc.u1, d.d1)), T2: add(lc.X, mulS(lc.u2, d.d2)), d1: d.d1, d2: d.d2, arc: null };
    });
  }
  const lc = lineCorner(o1, o2);
  if (typeof lc === 'string') return fail(lc);
  const d = chamferDistances(lc, spec);
  if (typeof d === 'string') return fail(d);
  if (lc.far1 < d.d1 - 1e-9 || lc.far2 < d.d2 - 1e-9) return fail('distance');
  const T1 = add(lc.X, mulS(lc.u1, d.d1)), T2 = add(lc.X, mulS(lc.u2, d.d2));
  const g1 = trimSupport({ ...o1, p: add(T1, lc.u1) }, T1), g2 = trimSupport({ ...o2, p: add(T2, lc.u2) }, T2);
  if (!g1 || !g2) return fail('distance');
  return writeBack(o1, o2, { T1, T2, arc: null, g1: g1.geo, g2: g2.geo }, trim, 'chamfer');
}

// ------------------------------------------------------------------ whole polyline (P option)
type VertexOp = (dirIn: Pt, dirOut: Pt, V: Pt) => { tIn: number; tOut: number; bulge: number } | null;
function cornerPolyline(pl: PolylineEnt, op: VertexOp): { ent: NewEntity; count: number; tooShort: number } {
  const pts = ptsOf(pl), n = pts.length;
  const segs = pl.closed ? n : n - 1;
  const segLen = (k: number) => dist([pts[k][0], pts[k][1]], [pts[(k + 1) % n][0], pts[(k + 1) % n][1]]);
  const isLine = (k: number) => Math.abs(pts[k][2] ?? 0) < 1e-12;
  const usedStart = new Array(segs).fill(0), usedEnd = new Array(segs).fill(0);
  const done: ({ T1: Pt; T2: Pt; bulge: number } | null)[] = new Array(n).fill(null);
  let count = 0, tooShort = 0;
  const order = pl.closed ? [...Array.from({ length: n - 1 }, (_, i) => i + 1), 0] : Array.from({ length: n - 2 }, (_, i) => i + 1);
  for (const v of order) {
    const sin = (v - 1 + n) % n, sout = v;
    if (sin >= segs || sout >= segs || !isLine(sin) || !isLine(sout)) continue;
    const V: Pt = [pts[v][0], pts[v][1]], P: Pt = [pts[sin][0], pts[sin][1]], Q: Pt = [pts[(v + 1) % n][0], pts[(v + 1) % n][1]];
    const Lin = segLen(sin), Lout = segLen(sout);
    if (Lin < 1e-12 || Lout < 1e-12) continue;
    const dIn = norm(sub(V, P)), dOut = norm(sub(Q, V));
    if (Math.abs(cross(dIn, dOut)) < 1e-12) continue;
    const r = op(dIn, dOut, V);
    if (!r) continue;
    if (r.tIn > Lin - usedStart[sin] + 1e-9 || r.tOut > Lout - usedEnd[sout] + 1e-9) { tooShort++; continue; }
    usedEnd[sin] = r.tIn; usedStart[sout] = r.tOut;
    done[v] = { T1: add(V, mulS(dIn, -r.tIn)), T2: add(V, mulS(dOut, r.tOut)), bulge: r.bulge };
    count++;
  }
  const out: number[][] = [];
  pts.forEach((p, i) => {
    const d = done[i];
    if (!d) { out.push(p); return; }
    out.push([d.T1[0], d.T1[1], d.bulge]);
    out.push([d.T2[0], d.T2[1], p[2] ?? 0, ...p.slice(3)]);
  });
  return { ent: { ...pl, pts: out } as NewEntity, count, tooShort };
}
/** FILLET → Polyline: round every line–line vertex. */
export function filletPolyline(pl: PolylineEnt, radius: number) {
  return cornerPolyline(pl, (dIn, dOut) => {
    if (radius <= 0) return null;
    const turn = signedAngle(dIn, dOut), th = Math.PI - Math.abs(turn);
    const td = radius / Math.tan(th / 2);
    return { tIn: td, tOut: td, bulge: Math.tan(turn / 4) };
  });
}
/** CHAMFER → Polyline: bevel every line–line vertex. */
export function chamferPolyline(pl: PolylineEnt, spec: ChamferSpec) {
  return cornerPolyline(pl, (dIn, dOut) => {
    if (spec.method === 'distance') return spec.d1 <= 0 && spec.d2 <= 0 ? null : { tIn: spec.d1, tOut: spec.d2, bulge: 0 };
    const th = Math.PI - Math.abs(signedAngle(dIn, dOut)), rest = Math.PI - th - spec.angle;
    if (rest <= 1e-9) return null;
    return { tIn: spec.length, tOut: (spec.length * Math.sin(spec.angle)) / Math.sin(rest), bulge: 0 };
  });
}

// ------------------------------------------------------------------ legacy helpers (midpoint picks)
const mid = (e: Extract<Entity, { type: 'LINE' }>): Pt => [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2];
export function filletLines(a: Extract<Entity, { type: 'LINE' }>, b: Extract<Entity, { type: 'LINE' }>, radius: number): { a: NewEntity; b: NewEntity; arc: NewEntity } | null {
  const r = fillet({ ent: a, p: mid(a) }, { ent: b, p: mid(b) }, radius);
  if (!r.ok || !r.corner) return null;
  const ua = r.updates.find((u) => u.id === a.id)?.ent, ub = r.updates.find((u) => u.id === b.id)?.ent;
  return ua && ub ? { a: ua, b: ub, arc: r.corner } : null;
}
export function chamferLines(a: Extract<Entity, { type: 'LINE' }>, b: Extract<Entity, { type: 'LINE' }>, d1: number, d2: number): { a: NewEntity; b: NewEntity; line: NewEntity } | null {
  const r = chamfer({ ent: a, p: mid(a) }, { ent: b, p: mid(b) }, { method: 'distance', d1, d2 });
  if (!r.ok || !r.corner) return null;
  const ua = r.updates.find((u) => u.id === a.id)?.ent, ub = r.updates.find((u) => u.id === b.id)?.ent;
  return ua && ub ? { a: ua, b: ub, line: r.corner } : null;
}
export type { Edge };
