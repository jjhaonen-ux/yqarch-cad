/**
 * Analytic primitives (segments and circular arcs) used by object snaps, intersections, picking and hatch boundaries.
 * Arcs are always stored CCW from a0 to a1 (a full circle has a1 = a0 + 2π and `full: true`).
 */
import type { Pt } from '../types';
import { EPS, TAU, add, angleOf, angleOnArc, ccwSweep, cross, dist, dot, len, mulS, norm, normAngle, polar, sub } from './vec';

export type Seg = { k: 'seg'; a: Pt; b: Pt };
export type Arc = { k: 'arc'; c: Pt; r: number; a0: number; a1: number; full?: boolean };
export type Prim = Seg | Arc;

export const seg = (a: Pt, b: Pt): Seg => ({ k: 'seg', a, b });
export const arc = (c: Pt, r: number, a0: number, a1: number, full = false): Arc => ({ k: 'arc', c, r, a0, a1, full });

/** Convert a polyline bulge segment into an arc (CCW-normalized) or a segment. */
export function bulgeToPrim(p0: Pt, p1: Pt, bulge: number): Prim {
  if (!bulge || Math.abs(bulge) < 1e-12) return seg(p0, p1);
  const chord = dist(p0, p1);
  if (chord < EPS) return seg(p0, p1);
  const theta = 4 * Math.atan(bulge); // signed included angle
  const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
  const m: Pt = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
  const d = norm(sub(p1, p0));
  // distance from chord midpoint to center (signed so the center is to the left for ccw bulge<1)
  const h = r * Math.cos(Math.abs(theta) / 2);
  const sideSign = bulge > 0 ? 1 : -1; // h is negative for |theta| > π, which moves the center across the chord
  const c: Pt = [m[0] - d[1] * h * sideSign, m[1] + d[0] * h * sideSign];
  const s = angleOf(c, p0), e = angleOf(c, p1);
  return bulge > 0 ? arc(c, r, s, e) : arc(c, r, e, s);
}
/** Bulge of an arc going from p0 to p1 through `through`. */
export function bulgeFrom3(p0: Pt, through: Pt, p1: Pt): number {
  const c = circleFrom3(p0, through, p1);
  if (!c) return 0;
  const a0 = angleOf(c.c, p0), am = angleOf(c.c, through), a1 = angleOf(c.c, p1);
  const ccw = angleOnArc(am, a0, a1);
  const sweep = ccw ? ccwSweep(a0, a1) : -ccwSweep(a1, a0);
  return Math.tan(sweep / 4);
}
/** Bulge for a tangent-continuous arc starting at p0 with direction `dir` and ending at p1. */
export function bulgeTangent(p0: Pt, dir: Pt, p1: Pt): number {
  const ch = sub(p1, p0);
  if (len(ch) < EPS || len(dir) < EPS) return 0;
  const a = Math.atan2(cross(dir, ch), dot(dir, ch)); // angle between tangent and chord
  return Math.tan(a / 2);
}
export function circleFrom3(a: Pt, b: Pt, c: Pt): { c: Pt; r: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, c2 = c[0] ** 2 + c[1] ** 2;
  const ux = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
  const uy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  return { c: [ux, uy], r: dist([ux, uy], a) };
}

export const arcStart = (a: Arc): Pt => polar(a.c, a.a0, a.r);
export const arcEnd = (a: Arc): Pt => polar(a.c, a.a1, a.r);
export const arcMid = (a: Arc): Pt => polar(a.c, a.a0 + ccwSweep(a.a0, a.a1) / 2, a.r);
export const primEnds = (p: Prim): Pt[] => (p.k === 'seg' ? [p.a, p.b] : p.full ? [] : [arcStart(p), arcEnd(p)]);
export const primMid = (p: Prim): Pt | null => (p.k === 'seg' ? [(p.a[0] + p.b[0]) / 2, (p.a[1] + p.b[1]) / 2] : p.full ? null : arcMid(p));
export const primLength = (p: Prim) => (p.k === 'seg' ? dist(p.a, p.b) : p.r * (p.full ? TAU : ccwSweep(p.a0, p.a1)));

export function closestOnSeg(p: Pt, a: Pt, b: Pt): { p: Pt; t: number } {
  const ab = sub(b, a), l2 = dot(ab, ab);
  if (l2 < EPS * EPS) return { p: a, t: 0 };
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  return { p: add(a, mulS(ab, t)), t };
}
export function closestOnArc(p: Pt, a: Arc): Pt {
  const ang = angleOf(a.c, p);
  if (a.full || angleOnArc(ang, a.a0, a.a1)) return polar(a.c, ang, a.r);
  const s = arcStart(a), e = arcEnd(a);
  return dist(p, s) < dist(p, e) ? s : e;
}
export const closestOnPrim = (p: Pt, q: Prim): Pt => (q.k === 'seg' ? closestOnSeg(p, q.a, q.b).p : closestOnArc(p, q));
export const distToPrim = (p: Pt, q: Prim) => dist(p, closestOnPrim(p, q));

/** Perpendicular foot from p onto a primitive (must lie on the finite primitive). */
export function perpendicularFoot(p: Pt, q: Prim): Pt[] {
  if (q.k === 'seg') {
    const ab = sub(q.b, q.a), l2 = dot(ab, ab);
    if (l2 < EPS) return [];
    const t = dot(sub(p, q.a), ab) / l2;
    return t >= -1e-9 && t <= 1 + 1e-9 ? [add(q.a, mulS(ab, t))] : [];
  }
  if (dist(p, q.c) < EPS) return [];
  const ang = angleOf(q.c, p), out: Pt[] = [];
  for (const a of [ang, ang + Math.PI]) if (q.full || angleOnArc(normAngle(a), q.a0, q.a1)) out.push(polar(q.c, a, q.r));
  return out;
}

function onPrim(q: Prim, p: Pt, tol = 1e-7): boolean {
  if (q.k === 'seg') {
    const ab = sub(q.b, q.a), l2 = dot(ab, ab);
    if (l2 < EPS) return dist(p, q.a) < tol;
    const t = dot(sub(p, q.a), ab) / l2;
    return t >= -tol && t <= 1 + tol;
  }
  return q.full || angleOnArc(angleOf(q.c, p), q.a0, q.a1, 1e-7);
}

/** Intersections of two infinite lines (as used by the "apparent" constructions). */
export function lineLine(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const r = sub(b, a), s = sub(d, c), den = cross(r, s);
  if (Math.abs(den) < 1e-12) return null;
  const t = cross(sub(c, a), s) / den;
  return add(a, mulS(r, t));
}
function lineCircle(a: Pt, b: Pt, c: Pt, r: number): Pt[] {
  const d = sub(b, a), f = sub(a, c);
  const A = dot(d, d), B = 2 * dot(f, d), C = dot(f, f) - r * r;
  if (A < EPS) return [];
  let disc = B * B - 4 * A * C;
  if (disc < -1e-9 * Math.max(1, B * B)) return [];
  disc = Math.max(0, disc);
  const sq = Math.sqrt(disc);
  const ts = sq < 1e-12 ? [-B / (2 * A)] : [(-B - sq) / (2 * A), (-B + sq) / (2 * A)];
  return ts.map((t) => add(a, mulS(d, t)));
}
function circleCircle(c1: Pt, r1: number, c2: Pt, r2: number): Pt[] {
  const d = dist(c1, c2);
  if (d < EPS || d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const u = mulS(sub(c2, c1), 1 / d), m = add(c1, mulS(u, a));
  if (h < 1e-12) return [m];
  return [[m[0] - u[1] * h, m[1] + u[0] * h], [m[0] + u[1] * h, m[1] - u[0] * h]];
}
/** Intersections of two finite primitives. */
export function intersect(p: Prim, q: Prim): Pt[] {
  let pts: Pt[];
  if (p.k === 'seg' && q.k === 'seg') {
    const r = sub(p.b, p.a), s = sub(q.b, q.a), den = cross(r, s);
    if (Math.abs(den) < 1e-12 * Math.max(1, len(r) * len(s))) return [];
    const t = cross(sub(q.a, p.a), s) / den, u = cross(sub(q.a, p.a), r) / den;
    const tol = 1e-9;
    return t >= -tol && t <= 1 + tol && u >= -tol && u <= 1 + tol ? [add(p.a, mulS(r, t))] : [];
  }
  if (p.k === 'seg' && q.k === 'arc') pts = lineCircle(p.a, p.b, q.c, q.r);
  else if (p.k === 'arc' && q.k === 'seg') pts = lineCircle(q.a, q.b, p.c, p.r);
  else pts = circleCircle((p as Arc).c, (p as Arc).r, (q as Arc).c, (q as Arc).r);
  return pts.filter((x) => onPrim(p, x) && onPrim(q, x));
}

/** Tessellate a primitive into points (including both ends). */
export function primPoints(q: Prim, segPerCircle = 96): Pt[] {
  if (q.k === 'seg') return [q.a, q.b];
  const sw = q.full ? TAU : ccwSweep(q.a0, q.a1);
  const n = Math.max(2, Math.ceil((sw / TAU) * segPerCircle));
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) out.push(polar(q.c, q.a0 + (sw * i) / n, q.r));
  return out;
}

// ---------- polygons ----------
export function polygonArea(pts: Pt[]): number {
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; s += a[0] * b[1] - b[0] * a[1]; }
  return s / 2;
}
export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
/** Even-odd containment over several loops. */
export function pointInLoops(p: Pt, loops: Pt[][]): boolean {
  let c = 0;
  for (const l of loops) if (pointInPolygon(p, l)) c++;
  return c % 2 === 1;
}
export function segIntersectsRect(a: Pt, b: Pt, r: [number, number, number, number]): boolean {
  const inside = (p: Pt) => p[0] >= r[0] && p[0] <= r[2] && p[1] >= r[1] && p[1] <= r[3];
  if (inside(a) || inside(b)) return true;
  if (Math.max(a[0], b[0]) < r[0] || Math.min(a[0], b[0]) > r[2] || Math.max(a[1], b[1]) < r[1] || Math.min(a[1], b[1]) > r[3]) return false;
  const edges: [Pt, Pt][] = [[[r[0], r[1]], [r[2], r[1]]], [[r[2], r[1]], [r[2], r[3]]], [[r[2], r[3]], [r[0], r[3]]], [[r[0], r[3]], [r[0], r[1]]]];
  return edges.some(([c, d]) => intersect(seg(a, b), seg(c, d)).length > 0);
}
