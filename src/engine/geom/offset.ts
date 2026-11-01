/**
 * OFFSET for lines, arcs, circles and bulge polylines.
 *
 * Polylines use the classic "raw offset + clean-up" method:
 *  1. every edge is offset on its own (arcs change radius; an arc whose radius would vanish collapses to a chord),
 *  2. neighbouring offset edges are joined the way AutoCAD does with OFFSETGAPTYPE = 0: on the outside of a corner the
 *     two edges are extended until they meet (a mitre for lines, the circle intersection for arcs; a round join only
 *     when the extensions never meet), on the inside they are cut at their intersection,
 *  3. the raw curve is split at its self-intersections (and, for open curves, where it crosses the end-cap circles),
 *  4. every piece closer than |d| to the source curve is discarded, overlapping duplicates are dropped, and the
 *     surviving pieces are stitched back together (closed sources may give several closed results).
 * Positive distances offset to the left of the travel direction.
 */
import type { Entity, NewEntity, Pt } from '../types';
import {
  baseProps, clonePt, edgeArea, edgeBox, edgeCircle, edgeClosest, edgeIntersections, edgeLength, edgeParamRaw, edgePoint,
  edgeSweep, edgeTangent, isArcEdge, pathArea, polylineFrom, signedAngle, type Edge,
} from './curve';
import { TAU, angleOf, cross, dist, dot, norm, perp, polar, sub } from './vec';

type RawEdge = Edge & { c?: Pt; r?: number; dir?: number; join?: boolean };
const EPS = 1e-9;

function setArcEnds(e: RawEdge, a: Pt, b: Pt) {
  e.a = a; e.b = b;
  if (e.c && e.r !== undefined && e.dir) {
    let sw = angleOf(e.c, b) - angleOf(e.c, a);
    if (e.dir > 0) { sw = ((sw % TAU) + TAU) % TAU; if (sw < 1e-12) sw = TAU - 1e-9; }
    else { sw = -((((-sw) % TAU) + TAU) % TAU); if (sw > -1e-12) sw = -(TAU - 1e-9); }
    e.bulge = Math.tan(sw / 4);
  }
}

/** Intersections of the supporting line / circle of two raw edges. */
function supportMeet(e: RawEdge, f: RawEdge): Pt[] {
  const lineOf = (x: RawEdge) => ({ p: x.a, d: norm(sub(x.b, x.a)) });
  const circleOf = (x: RawEdge) => (x.c && x.r !== undefined ? { c: x.c, r: x.r } : isArcEdge(x) ? edgeCircle(x) : null);
  const ce = isArcEdge(e) ? circleOf(e) : null, cf = isArcEdge(f) ? circleOf(f) : null;
  if (!ce && !cf) {
    const l1 = lineOf(e), l2 = lineOf(f), den = cross(l1.d, l2.d);
    if (Math.abs(den) < 1e-12) return [];
    const t = cross(sub(l2.p, l1.p), l2.d) / den;
    return [[l1.p[0] + l1.d[0] * t, l1.p[1] + l1.d[1] * t]];
  }
  if (ce && cf) {
    const d = dist(ce.c, cf.c);
    if (d < EPS || d > ce.r + cf.r + 1e-9 || d < Math.abs(ce.r - cf.r) - 1e-9) return [];
    const x = (ce.r * ce.r - cf.r * cf.r + d * d) / (2 * d), h = Math.sqrt(Math.max(0, ce.r * ce.r - x * x));
    const u = norm(sub(cf.c, ce.c)), m: Pt = [ce.c[0] + u[0] * x, ce.c[1] + u[1] * x];
    return h < 1e-12 ? [m] : [[m[0] - u[1] * h, m[1] + u[0] * h], [m[0] + u[1] * h, m[1] - u[0] * h]];
  }
  const circ = (ce ?? cf)!, l = lineOf(ce ? f : e);
  const fpt = sub(l.p, circ.c), B = 2 * dot(fpt, l.d), C = dot(fpt, fpt) - circ.r * circ.r, disc = B * B - 4 * C;
  if (disc < -1e-9) return [];
  const s = Math.sqrt(Math.max(0, disc));
  return (s < 1e-12 ? [-B / 2] : [(-B - s) / 2, (-B + s) / 2]).map((t) => [l.p[0] + l.d[0] * t, l.p[1] + l.d[1] * t] as Pt);
}

/** Offset one edge. */
function offsetEdge(e: Edge, d: number): RawEdge {
  if (!isArcEdge(e)) {
    const n = perp(norm(sub(e.b, e.a)));
    return { a: [e.a[0] + n[0] * d, e.a[1] + n[1] * d], b: [e.b[0] + n[0] * d, e.b[1] + n[1] * d], bulge: 0 };
  }
  const { c, r } = edgeCircle(e), sw = edgeSweep(e), r2 = r - Math.sign(sw) * d;
  if (r2 > 1e-9 * Math.max(1, r)) {
    const a = polar(c, angleOf(c, e.a), r2), b = polar(c, angleOf(c, e.b), r2);
    return { a, b, bulge: e.bulge, c, r: r2, dir: Math.sign(sw) };
  }
  // collapsed arc: keep the two offset end points joined by a chord (removed by the clean-up)
  const na = perp(edgeTangent(e, 0)), nb = perp(edgeTangent(e, 1));
  return { a: [e.a[0] + na[0] * d, e.a[1] + na[1] * d], b: [e.b[0] + nb[0] * d, e.b[1] + nb[1] * d], bulge: 0 };
}

/** Raw (uncleaned) offset curve of a polyline edge chain. */
export function rawOffset(src: Edge[], closed: boolean, d: number): RawEdge[] {
  const off = src.map((e) => offsetEdge(e, d));
  const out: RawEdge[][] = off.map((e) => [e]);
  const joins = closed ? src.length : src.length - 1;
  for (let i = 0; i < joins; i++) {
    const j = (i + 1) % src.length, L = off[i], R = off[j], V = src[i].b;
    if (dist(L.b, R.a) < 1e-9 * Math.max(1, Math.abs(d))) { const m: Pt = [(L.b[0] + R.a[0]) / 2, (L.b[1] + R.a[1]) / 2]; setArcEnds(L, L.a, m); setArcEnds(R, m, R.b); continue; }
    const tIn = edgeTangent(src[i], 1), tOut = edgeTangent(src[j], 0), turn = cross(tIn, tOut);
    const convex = d * turn < 0 || (Math.abs(turn) < 1e-12 && dot(tIn, tOut) < 0);
    if (convex) {
      // extend both raw edges to meet: the meeting point must lie ahead of L's end and behind R's start
      const lt = edgeTangent(L, 1), rt = edgeTangent(R, 0);
      const cand = supportMeet(L, R).filter((x) => {
        const okL = isArcEdge(L) ? true : dot(sub(x, L.a), lt) > -1e-9;
        const okR = isArcEdge(R) ? true : dot(sub(R.b, x), rt) > -1e-9;
        return okL && okR;
      }).sort((x, y) => dist(x, V) - dist(y, V));
      const X = cand[0];
      if (X && (!isArcEdge(L) || arcExtensionOk(L, X, 'end')) && (!isArcEdge(R) || arcExtensionOk(R, X, 'start'))) {
        setArcEnds(L, L.a, X); setArcEnds(R, X, R.b);
      } else {
        const sw = signedAngle(sub(L.b, V), sub(R.a, V));
        out[i].push({ a: clonePt(L.b), b: clonePt(R.a), bulge: Math.tan(sw / 4), c: V, r: Math.abs(d), dir: Math.sign(sw), join: true });
      }
    } else {
      const xs = edgeIntersections(L, R).sort((x, y) => dist(x.p, V) - dist(y.p, V));
      if (xs.length) { const X = xs[0].p; setArcEnds(L, L.a, X); setArcEnds(R, X, R.b); }
      else out[i].push({ a: clonePt(L.b), b: clonePt(R.a), bulge: 0, join: true });
    }
  }
  return out.flat().filter((e) => dist(e.a, e.b) > 1e-12);
}

/** An arc may be extended along its circle only by less than the gap it closes (no wrap-around). */
function arcExtensionOk(e: RawEdge, X: Pt, which: 'start' | 'end'): boolean {
  const probe = which === 'end' ? edgeParamRaw(e, X) : edgeParamRaw({ a: e.b, b: e.a, bulge: -e.bulge }, X);
  const full = TAU / Math.max(1e-12, Math.abs(edgeSweep(e)));
  return probe > 0 && probe < 1 + (full - 1) / 2;
}

/** Distance from a point to a source edge chain. */
function distToEdges(edges: Edge[], p: Pt): number {
  let d = Infinity;
  for (const e of edges) d = Math.min(d, edgeClosest(e, p).d);
  return d;
}

type Slice = { edges: Edge[]; start: Pt; end: Pt; i0: number; i1: number; splitStart: boolean; splitEnd: boolean };

/** Cleaned offset of an edge chain. */
export function offsetEdges(src: Edge[], closed: boolean, d: number): { edges: Edge[]; closed: boolean }[] {
  src = src.filter((e) => dist(e.a, e.b) > 1e-12);
  if (!src.length || Math.abs(d) < EPS) return [];
  const raw = rawOffset(src, closed, d), n = raw.length, ad = Math.abs(d);
  const scale = Math.max(ad, ...src.map((e) => Math.max(Math.abs(e.a[0]), Math.abs(e.a[1]), edgeLength(e))));
  const tol = Math.max(1e-9, 1e-9 * scale);
  const vertexSplits = new Set<number>();
  // split parameters per raw edge
  const splits: number[][] = raw.map(() => []);
  const boxes = raw.map(edgeBox);
  const addSplit = (i: number, t: number) => { if (t > 1e-9 && t < 1 - 1e-9 && edgeLength(raw[i]) * Math.min(t, 1 - t) > tol && !splits[i].some((x) => Math.abs(x - t) < 1e-9)) splits[i].push(t); };
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const bi = boxes[i], bj = boxes[j];
    if (bi[0] > bj[2] + tol || bj[0] > bi[2] + tol || bi[1] > bj[3] + tol || bj[1] > bi[3] + tol) continue;
    const adjacent = j === i + 1 || (closed && i === 0 && j === n - 1);
    for (const x of edgeIntersections(raw[i], raw[j])) {
      if (adjacent) {
        const shared = j === i + 1 ? raw[i].b : raw[i].a;
        if (dist(x.p, shared) < Math.max(tol * 10, 1e-7 * scale)) continue;
      }
      addSplit(i, x.t); addSplit(j, x.u);
      // an intersection exactly at a vertex of one edge splits the chain there as well (handled as slice boundary)
      if (x.t <= 1e-9 || x.t >= 1 - 1e-9 || x.u <= 1e-9 || x.u >= 1 - 1e-9) {
        if (x.t <= 1e-9) vertexSplits.add(i); if (x.t >= 1 - 1e-9) vertexSplits.add((i + 1) % (n + (closed ? 0 : 1)));
        if (x.u <= 1e-9) vertexSplits.add(j); if (x.u >= 1 - 1e-9) vertexSplits.add((j + 1) % (n + (closed ? 0 : 1)));
      }
    }
  }
  if (!closed) {
    // end caps
    for (const centre of [src[0].a, src[src.length - 1].b]) {
      const cap: Edge[] = [{ a: [centre[0] + ad, centre[1]], b: [centre[0] - ad, centre[1]], bulge: 1 }, { a: [centre[0] - ad, centre[1]], b: [centre[0] + ad, centre[1]], bulge: 1 }];
      raw.forEach((e, i) => { for (const c of cap) for (const x of edgeIntersections(e, c)) addSplit(i, x.t); });
    }
  }
  // pieces of every raw edge, in order
  type Piece = { e: Edge; splitStart: boolean; splitEnd: boolean; edgeIndex: number };
  const pieces: Piece[] = [];
  raw.forEach((e, i) => {
    const ts = [0, ...splits[i].sort((a, b) => a - b), 1];
    for (let k = 0; k < ts.length - 1; k++) {
      const a = edgePoint(e, ts[k]), b = edgePoint(e, ts[k + 1]);
      const piece: Edge = { a, b, bulge: isArcEdge(e) ? Math.tan(edgeSweep(e) * (ts[k + 1] - ts[k]) / 4) : 0 };
      if (dist(a, b) < tol && ts.length > 2) {
        // negligible sliver: fold it into the neighbouring piece but keep the split flag
        if (k > 0 && pieces.length) { const prev = pieces[pieces.length - 1]; prev.e = { ...prev.e, b }; prev.splitEnd = true; }
        continue;
      }
      pieces.push({ e: piece, splitStart: k > 0 || vertexSplits.has(i), splitEnd: k < ts.length - 2 || vertexSplits.has((i + 1) % (n + (closed ? 0 : 1))), edgeIndex: i });
    }
  });
  // group pieces into slices between split points
  const slices: Slice[] = [];
  let cur: Piece[] = [];
  const flush = () => { if (cur.length) { slices.push({ edges: cur.map((p) => p.e), start: cur[0].e.a, end: cur[cur.length - 1].e.b, i0: cur[0].edgeIndex, i1: cur[cur.length - 1].edgeIndex, splitStart: cur[0].splitStart, splitEnd: cur[cur.length - 1].splitEnd }); cur = []; } };
  for (const p of pieces) { if (p.splitStart && cur.length) flush(); cur.push(p); if (p.splitEnd) flush(); }
  flush();
  if (closed && slices.length > 1 && !slices[0].splitStart && !slices[slices.length - 1].splitEnd) {
    const last = slices.pop()!; slices[0] = { ...slices[0], edges: [...last.edges, ...slices[0].edges], start: last.start, i0: last.i0, splitStart: last.splitStart };
  }
  const anySplit = slices.some((s) => s.splitStart || s.splitEnd);
  // validity: every sampled interior point must be at least |d| from the source
  const valid = slices.filter((s) => {
    for (const e of s.edges) for (const t of [0.5, 0.25, 0.75, 0.1, 0.9]) {
      if (distToEdges(src, edgePoint(e, t)) < ad - Math.max(tol * 100, ad * 1e-7)) return false;
    }
    return true;
  });
  // drop overlapping duplicates (collinear overlaps of the raw curve)
  const unique: Slice[] = [];
  for (const s of valid) {
    const mid = edgePoint(s.edges[0], 0.5);
    const dup = unique.some((u) => u.edges.length === s.edges.length && ((dist(u.start, s.start) < tol * 10 && dist(u.end, s.end) < tol * 10) || (dist(u.start, s.end) < tol * 10 && dist(u.end, s.start) < tol * 10)) && u.edges.some((e) => edgeClosest(e, mid).d < tol * 10));
    if (!dup) unique.push(s);
  }
  if (closed && !anySplit) {
    if (!unique.length) return [];
    const loop = unique[0].edges;
    if (Math.sign(pathArea(loop)) !== Math.sign(pathArea(src))) return [];
    return [{ edges: mergeAtSplits(loop, new Set()), closed: true }];
  }
  // stitch
  const used = new Set<number>(), results: { edges: Edge[]; closed: boolean }[] = [];
  const near = (a: Pt, b: Pt) => dist(a, b) < Math.max(tol * 1e3, 1e-7);
  for (let k = 0; k < unique.length; k++) {
    if (used.has(k)) continue;
    used.add(k);
    const chain: Slice[] = [unique[k]];
    let lastIndex = k;
    for (;;) {
      const end = chain[chain.length - 1].end;
      if (closed && chain.length && near(end, chain[0].start) && (chain.length > 1 || chain[0].splitStart)) break;
      let next = -1;
      for (let q = 1; q <= unique.length; q++) { const m = (lastIndex + q) % unique.length; if (!used.has(m) && near(unique[m].start, end)) { next = m; break; } }
      if (next < 0) break;
      used.add(next); chain.push(unique[next]); lastIndex = next;
    }
    // open sources: prepend chains that end where this one starts
    if (!closed) {
      for (;;) {
        let prev = -1;
        for (let m = 0; m < unique.length; m++) if (!used.has(m) && near(unique[m].end, chain[0].start)) { prev = m; break; }
        if (prev < 0) break;
        used.add(prev); chain.unshift(unique[prev]);
      }
    }
    const edges: Edge[] = [], joints = new Set<number>();
    for (const s of chain) { if (edges.length) joints.add(edges.length); edges.push(...s.edges.map((e) => ({ ...e }))); }
    const isClosed = closed && near(edges[edges.length - 1].b, edges[0].a);
    if (isClosed) { joints.add(0); edges[edges.length - 1].b = clonePt(edges[0].a); }
    if (closed && !isClosed) continue; // dangling piece of a closed offset: not a valid result
    if (isClosed && Math.sign(pathArea(edges)) !== Math.sign(pathArea(src))) continue;
    if (isClosed && Math.abs(pathArea(edges)) < tol) continue;
    results.push({ edges: mergeAtSplits(edges, joints, isClosed), closed: isClosed });
  }
  return results.filter((r) => r.edges.length && r.edges.reduce((s, e) => s + edgeLength(e), 0) > tol);
}
/** Merge collinear segments / co-circular arcs that meet at split points (vertices created by the clean-up). */
function mergeAtSplits(edges: Edge[], joints: Set<number>, closed = false): Edge[] {
  const out: Edge[] = [];
  edges.forEach((e, i) => {
    const prev = out[out.length - 1];
    if (prev && joints.has(i) && canMerge(prev, e)) { out[out.length - 1] = merge(prev, e); return; }
    out.push({ ...e });
  });
  if (closed && out.length > 2 && joints.has(0) && canMerge(out[out.length - 1], out[0])) {
    const m = merge(out[out.length - 1], out[0]); out.pop(); out[0] = m;
  }
  return out;
}
function canMerge(a: Edge, b: Edge): boolean {
  if (dist(a.b, b.a) > 1e-7) return false;
  if (!isArcEdge(a) && !isArcEdge(b)) {
    const u = norm(sub(a.b, a.a)), v = norm(sub(b.b, b.a));
    return Math.abs(cross(u, v)) < 1e-9 && dot(u, v) > 0;
  }
  if (isArcEdge(a) && isArcEdge(b)) {
    const ca = edgeCircle(a), cb = edgeCircle(b);
    return Math.sign(a.bulge) === Math.sign(b.bulge) && dist(ca.c, cb.c) < 1e-7 && Math.abs(ca.r - cb.r) < 1e-7 && Math.abs(edgeSweep(a) + edgeSweep(b)) < TAU - 1e-6;
  }
  return false;
}
function merge(a: Edge, b: Edge): Edge {
  return { a: clonePt(a.a), b: clonePt(b.b), bulge: isArcEdge(a) ? Math.tan((edgeSweep(a) + edgeSweep(b)) / 4) : 0 };
}

/** Offset any supported curve entity; positive = left of the travel direction (outside for circles). */
export function offsetCurve(e: Entity, d: number): NewEntity[] {
  if (Math.abs(d) < EPS) return [];
  const props = baseProps(e);
  if (e.type === 'LINE') {
    const n = perp(norm(sub(e.b, e.a)));
    if (!n[0] && !n[1]) return [];
    return [{ ...props, type: 'LINE', a: [e.a[0] + n[0] * d, e.a[1] + n[1] * d], b: [e.b[0] + n[0] * d, e.b[1] + n[1] * d] }];
  }
  if (e.type === 'CIRCLE') return e.r + d > EPS ? [{ ...props, type: 'CIRCLE', c: clonePt(e.c), r: e.r + d }] : [];
  if (e.type === 'ARC') return e.r - d > EPS ? [{ ...props, type: 'ARC', c: clonePt(e.c), r: e.r - d, a0: e.a0, a1: e.a1 }] : [];
  if (e.type === 'LWPOLYLINE') {
    const n = e.pts.length;
    if (n < 2) return [];
    const edges: Edge[] = [];
    for (let i = 0; i < (e.closed ? n : n - 1); i++) { const p = e.pts[i], q = e.pts[(i + 1) % n]; edges.push({ a: [p[0], p[1]], b: [q[0], q[1]], bulge: p[2] ?? 0 }); }
    return offsetEdges(edges, !!e.closed, d).map((r) => polylineFrom(props, r.edges, r.closed, { width: e.width, source: e.source }));
  }
  return [];
}

/**
 * Signed offset distance that puts the result on the side of `side` (AutoCAD's "point on side to offset").
 * Returns +|d| or -|d| for offsetCurve.
 */
export function offsetSideSign(e: Entity, side: Pt): number {
  if (e.type === 'CIRCLE') return dist(e.c, side) >= e.r ? 1 : -1;
  if (e.type === 'ARC') return dist(e.c, side) >= e.r ? -1 : 1;
  if (e.type === 'LINE') return cross(sub(e.b, e.a), sub(side, e.a)) >= 0 ? 1 : -1;
  if (e.type === 'LWPOLYLINE') {
    const n = e.pts.length, edges: Edge[] = [];
    for (let i = 0; i < (e.closed ? n : n - 1); i++) { const p = e.pts[i], q = e.pts[(i + 1) % n]; if (dist([p[0], p[1]], [q[0], q[1]]) > 1e-12) edges.push({ a: [p[0], p[1]], b: [q[0], q[1]], bulge: p[2] ?? 0 }); }
    if (!edges.length) return 1;
    if (e.closed) {
      // inside / outside decides, independent of where the closest point is
      const inside = pointInEdges(edges, side), ccw = edges.reduce((s, x) => s + edgeArea(x), 0) > 0;
      return inside === ccw ? 1 : -1;
    }
    let best = { i: 0, t: 0, d: Infinity };
    edges.forEach((x, i) => { const c = edgeClosest(x, side); if (c.d < best.d - 1e-12) best = { i, t: c.t, d: c.d }; });
    const e0 = edges[best.i], p = edgePoint(e0, best.t);
    const atStart = best.t < 1e-9 && best.i > 0, atEnd = best.t > 1 - 1e-9 && best.i < edges.length - 1;
    if (atStart || atEnd) {
      const a = atStart ? edges[best.i - 1] : e0, b = atStart ? e0 : edges[best.i + 1];
      const tIn = edgeTangent(a, 1), tOut = edgeTangent(b, 0), v = sub(side, p);
      const s1 = cross(tIn, v), s2 = cross(tOut, v);
      if (s1 * s2 > 0) return s1 > 0 ? 1 : -1;
      return cross(tIn, tOut) > 0 ? -1 : 1; // in the corner's outer wedge
    }
    return cross(edgeTangent(e0, best.t), sub(side, p)) >= 0 ? 1 : -1;
  }
  return 1;
}

/** Even-odd point in polygon for a closed bulge chain (arcs tessellated finely). */
export function pointInEdges(edges: Edge[], p: Pt): boolean {
  const pts: Pt[] = [];
  for (const e of edges) {
    const n = isArcEdge(e) ? Math.max(4, Math.ceil(Math.abs(edgeSweep(e)) / (TAU / 256))) : 1;
    for (let k = 0; k < n; k++) pts.push(edgePoint(e, k / n));
  }
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Distance from a point to a curve entity (used by OFFSET Through). */
export function distanceToCurve(e: Entity, p: Pt): number {
  if (e.type === 'LINE') return edgeClosest({ a: e.a, b: e.b, bulge: 0 }, p).d;
  if (e.type === 'CIRCLE') return Math.abs(dist(e.c, p) - e.r);
  if (e.type === 'ARC') {
    const ang = angleOf(e.c, p), sw = ((e.a1 - e.a0) % TAU + TAU) % TAU, rel = ((ang - e.a0) % TAU + TAU) % TAU;
    if (rel <= sw) return Math.abs(dist(e.c, p) - e.r);
    return Math.min(dist(p, polar(e.c, e.a0, e.r)), dist(p, polar(e.c, e.a1, e.r)));
  }
  if (e.type === 'LWPOLYLINE') {
    const n = e.pts.length; let d = Infinity;
    for (let i = 0; i < (e.closed ? n : n - 1); i++) { const a = e.pts[i], b = e.pts[(i + 1) % n]; d = Math.min(d, edgeClosest({ a: [a[0], a[1]], b: [b[0], b[1]], bulge: a[2] ?? 0 }, p).d); }
    return d;
  }
  return Infinity;
}
