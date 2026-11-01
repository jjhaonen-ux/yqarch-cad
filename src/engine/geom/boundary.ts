/**
 * Boundary detection for HATCH "pick internal point": builds a planar graph from all visible geometry around the
 * point (lines, arcs, polylines, block contents), splits it at intersections, prunes dangling edges and walks the
 * face that contains the point. Closed objects fully inside the boundary become islands (even-odd fill).
 */
import RBush from 'rbush';
import type { CadDocument } from '../model/document';
import type { BBox, Entity, Pt } from '../types';
import { entitySnapGeom } from '../snap/entgeom';
import { pointInPolygon, polygonArea, primPoints } from './prims';
import { polylinePoints } from './extents';
import { TAU } from './vec';

interface SegItem { minX: number; minY: number; maxX: number; maxY: number; i: number }

const SKIP = new Set(['TEXT', 'MTEXT', 'ATTDEF', 'ATTRIB', 'HATCH', 'DIMENSION', 'POINT', 'WIPEOUT']);

/** Closed outline of an entity as a polygon (or null when the entity is not closed). */
export function closedLoopOf(e: Entity, segPerCircle = 96): Pt[] | null {
  switch (e.type) {
    case 'CIRCLE': return Array.from({ length: segPerCircle }, (_, i) => [e.c[0] + e.r * Math.cos((i / segPerCircle) * TAU), e.c[1] + e.r * Math.sin((i / segPerCircle) * TAU)] as Pt);
    case 'LWPOLYLINE': {
      const first = e.pts[0], last = e.pts[e.pts.length - 1];
      const closed = e.closed || (e.pts.length > 2 && Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-9);
      if (!closed || e.pts.length < 3) return null;
      const pts = polylinePoints(e.pts, true, segPerCircle);
      return pts;
    }
    case 'ELLIPSE': {
      let sw = e.a1 - e.a0; while (sw <= 1e-12) sw += TAU;
      if (Math.abs(sw - TAU) > 1e-6) return null;
      const mn: Pt = [-e.major[1] * e.ratio, e.major[0] * e.ratio];
      return Array.from({ length: segPerCircle }, (_, i) => { const t = (i / segPerCircle) * TAU; return [e.c[0] + e.major[0] * Math.cos(t) + mn[0] * Math.sin(t), e.c[1] + e.major[1] * Math.cos(t) + mn[1] * Math.sin(t)] as Pt; });
    }
    case 'SPLINE': return e.closed && e.pts.length > 2 ? e.pts.slice() : null;
    case 'SOLID': return e.pts.length >= 4 ? [e.pts[0], e.pts[1], e.pts[3], e.pts[2]] : e.pts.length === 3 ? e.pts.slice() : null;
    default: return null;
  }
}

export interface BoundaryResult { outer: Pt[]; islands: Pt[][]; loops: Pt[][] }

export function findBoundary(doc: CadDocument, p: Pt, searchBox: BBox, maxSegs = 40000): BoundaryResult | null {
  const segs: [Pt, Pt][] = [];
  for (const id of doc.query(searchBox)) {
    const e = doc.get(id);
    if (!e || SKIP.has(e.type) || !doc.isVisible(e)) continue;
    for (const q of entitySnapGeom(e, doc).prims) {
      const pts = q.k === 'seg' ? [q.a, q.b] : primPoints(q, 72);
      for (let i = 1; i < pts.length; i++) if (pts[i][0] !== pts[i - 1][0] || pts[i][1] !== pts[i - 1][1]) segs.push([pts[i - 1], pts[i]]);
      if (segs.length > maxSegs) break;
    }
    if (segs.length > maxSegs) break;
  }
  if (segs.length < 2) return null;
  const size = Math.max(searchBox[2] - searchBox[0], searchBox[3] - searchBox[1], 1e-9);
  const tol = size * 1e-9 + 1e-9;
  // split segments at intersections
  const tree = new RBush<SegItem>();
  tree.load(segs.map(([a, b], i) => ({ minX: Math.min(a[0], b[0]) - tol, minY: Math.min(a[1], b[1]) - tol, maxX: Math.max(a[0], b[0]) + tol, maxY: Math.max(a[1], b[1]) + tol, i })));
  const params: number[][] = segs.map(() => [0, 1]);
  for (let i = 0; i < segs.length; i++) {
    const [a, b] = segs[i];
    for (const it of tree.search({ minX: Math.min(a[0], b[0]) - tol, minY: Math.min(a[1], b[1]) - tol, maxX: Math.max(a[0], b[0]) + tol, maxY: Math.max(a[1], b[1]) + tol })) {
      const j = it.i;
      if (j <= i) continue;
      const [c, d] = segs[j];
      const r: Pt = [b[0] - a[0], b[1] - a[1]], s: Pt = [d[0] - c[0], d[1] - c[1]];
      const den = r[0] * s[1] - r[1] * s[0];
      const lr = Math.hypot(r[0], r[1]), ls = Math.hypot(s[0], s[1]);
      if (Math.abs(den) <= 1e-12 * lr * ls) {
        // parallel: handle collinear overlap by splitting at the other segment's endpoints
        const cross = (c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0];
        if (Math.abs(cross) / (lr || 1) > tol * 10) continue;
        const proj = (p: Pt, o: Pt, v: Pt, l2: number) => ((p[0] - o[0]) * v[0] + (p[1] - o[1]) * v[1]) / l2;
        for (const q of [c, d]) { const t = proj(q, a, r, lr * lr); if (t > 0 && t < 1) params[i].push(t); }
        for (const q of [a, b]) { const t = proj(q, c, s, ls * ls); if (t > 0 && t < 1) params[j].push(t); }
        continue;
      }
      const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
      const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
      const et = tol / (lr || 1), eu = tol / (ls || 1);
      if (t < -et || t > 1 + et || u < -eu || u > 1 + eu) continue;
      params[i].push(Math.min(1, Math.max(0, t)));
      params[j].push(Math.min(1, Math.max(0, u)));
    }
  }
  // nodes (merged within tolerance) and edges
  const cell = tol * 100;
  const grid = new Map<string, number>();
  const nodes: Pt[] = [];
  const nodeOf = (q: Pt): number => {
    const gx = Math.round(q[0] / cell), gy = Math.round(q[1] / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const id = grid.get(`${gx + dx},${gy + dy}`);
      if (id !== undefined && Math.abs(nodes[id][0] - q[0]) <= cell && Math.abs(nodes[id][1] - q[1]) <= cell) return id;
    }
    nodes.push(q); grid.set(`${gx},${gy}`, nodes.length - 1);
    return nodes.length - 1;
  };
  const adj = new Map<number, Set<number>>();
  const link = (u: number, v: number) => {
    if (u === v) return;
    (adj.get(u) ?? adj.set(u, new Set()).get(u)!).add(v);
    (adj.get(v) ?? adj.set(v, new Set()).get(v)!).add(u);
  };
  segs.forEach(([a, b], i) => {
    const ts = [...new Set(params[i])].sort((x, y) => x - y);
    let prev = nodeOf(a);
    for (let k = 1; k < ts.length; k++) {
      const t = ts[k];
      const q: Pt = t >= 1 ? b : [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const n = nodeOf(q);
      link(prev, n); prev = n;
    }
  });
  // prune dangling edges
  const stack = [...adj.keys()].filter((n) => adj.get(n)!.size < 2);
  while (stack.length) {
    const n = stack.pop()!;
    const nb = adj.get(n);
    if (!nb) continue;
    for (const m of nb) { const s = adj.get(m)!; s.delete(n); if (s.size < 2) stack.push(m); }
    adj.delete(n);
  }
  if (!adj.size) return null;
  // ray cast to +x to find the nearest edge
  const py = p[1] + tol * 0.37;
  let best: [number, number] | null = null, bestX = Infinity;
  for (const [u, nb] of adj) for (const v of nb) {
    if (v < u) continue;
    const a = nodes[u], b = nodes[v];
    if ((a[1] > py) === (b[1] > py)) continue;
    const x = a[0] + ((py - a[1]) / (b[1] - a[1])) * (b[0] - a[0]);
    if (x > p[0] && x < bestX) { bestX = x; best = [u, v]; }
  }
  if (!best) return null;
  let [u, v] = best;
  { const a = nodes[u], b = nodes[v]; if ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) < 0) [u, v] = [v, u]; }
  const startU = u, startV = v;
  const loopIdx: number[] = [u];
  const limit = nodes.length * 2 + 10;
  for (let steps = 0; steps < limit; steps++) {
    loopIdx.push(v);
    const vb = nodes[v], back = Math.atan2(nodes[u][1] - vb[1], nodes[u][0] - vb[0]);
    let next = -1, bestA = Infinity;
    for (const w of adj.get(v)!) {
      let a = back - Math.atan2(nodes[w][1] - vb[1], nodes[w][0] - vb[0]); // clockwise angle from back direction
      while (a <= 1e-12) a += TAU;
      while (a > TAU + 1e-12) a -= TAU;
      if (w === u) a = TAU + 1;
      if (a < bestA) { bestA = a; next = w; }
    }
    if (next < 0) return null;
    u = v; v = next;
    if (u === startU && v === startV) break;
    if (steps === limit - 1) return null;
  }
  loopIdx.pop();
  const outer = loopIdx.map((i) => nodes[i]);
  if (outer.length < 3 || polygonArea(outer) <= 0 || !pointInPolygon(p, outer)) return null;
  const islands: Pt[][] = [];
  // islands formed by other connected components of the graph (e.g. a column drawn with four lines inside a room)
  const outerSet = new Set(loopIdx);
  const seen = new Set<number>();
  for (const n0 of adj.keys()) {
    if (seen.has(n0)) continue;
    const comp: number[] = []; const st = [n0]; seen.add(n0);
    while (st.length) { const n = st.pop()!; comp.push(n); for (const m of adj.get(n)!) if (!seen.has(m)) { seen.add(m); st.push(m); } }
    if (comp.some((n) => outerSet.has(n))) continue;
    if (!comp.every((n) => pointInPolygon(nodes[n], outer))) continue;
    const ring = outerRing(comp, nodes, adj);
    if (ring && ring.length >= 3 && !pointInPolygon(p, ring)) islands.push(ring);
  }
  return { outer, islands, loops: [outer, ...islands] };
}

/** Outline (unbounded face) of one connected component, walked from its leftmost node. */
function outerRing(comp: number[], nodes: Pt[], adj: Map<number, Set<number>>): Pt[] | null {
  let v = comp[0];
  for (const n of comp) if (nodes[n][0] < nodes[v][0] || (nodes[n][0] === nodes[v][0] && nodes[n][1] < nodes[v][1])) v = n;
  const pick = (from: Pt, at: number, exclude: number) => {
    const vb = nodes[at], back = Math.atan2(from[1] - vb[1], from[0] - vb[0]);
    let next = -1, bestA = Infinity;
    for (const w of adj.get(at)!) {
      let a = back - Math.atan2(nodes[w][1] - vb[1], nodes[w][0] - vb[0]);
      while (a <= 1e-12) a += TAU;
      while (a > TAU + 1e-12) a -= TAU;
      if (w === exclude) a = TAU + 1;
      if (a < bestA) { bestA = a; next = w; }
    }
    return next;
  };
  const start = v;
  let u = v; let w = pick([nodes[v][0] - 1, nodes[v][1]], v, -1);
  if (w < 0) return null;
  const firstW = w;
  const ring: Pt[] = [nodes[start]];
  for (let i = 0; i < comp.length * 2 + 4; i++) {
    if (w === start) {
      const nx = pick(nodes[u], w, u);
      if (nx === firstW) return ring;
    }
    ring.push(nodes[w]);
    const nx = pick(nodes[u], w, u);
    u = w; w = nx;
  }
  return null;
}
