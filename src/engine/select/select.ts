/** Picking and window / crossing selection against the tessellated geometry. */
import type { CadDocument } from '../model/document';
import type { BBox, Entity, Pt } from '../types';
import { boxInside } from '../types';
import { closestOnSeg, pointInLoops, pointInPolygon, segIntersectsRect } from '../geom/prims';
import { apply } from '../geom/matrix';
import type { DrawItem } from '../render/tessellate';

export interface ItemSource { itemsFor(e: Entity): DrawItem[] }
export interface SelectOptions { includeLocked?: boolean; filter?: (e: Entity) => boolean }

const selectable = (doc: CadDocument, e: Entity, o: SelectOptions) => doc.isVisible(e) && (o.includeLocked || !doc.isLocked(e)) && (!o.filter || o.filter(e));
const isTextual = (e: Entity) => e.type === 'TEXT' || e.type === 'MTEXT' || e.type === 'ATTDEF';

/** Distance from p to the entity's drawn geometry (Infinity if not hit-testable). */
export function distanceToEntity(e: Entity, p: Pt, src: ItemSource, doc: CadDocument): number {
  if (isTextual(e)) { const b = doc.cachedBox(e.id) ?? doc.bboxOf(e); return p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3] ? 0 : Infinity; }
  let best = Infinity;
  for (const it of src.itemsFor(e)) {
    if (it.kind === 'stroke') {
      for (let pi = 0; pi < it.paths.length; pi++) {
        const f = it.paths[pi];
        const n = f.length;
        const closed = it.closed?.[pi];
        for (let i = 2; i <= n - 2 + (closed ? 2 : 0); i += 2) {
          const a: Pt = [f[i - 2], f[i - 1]], b: Pt = i < n ? [f[i], f[i + 1]] : [f[0], f[1]];
          const d = Math.hypot(...(sub2(closestOnSeg(p, a, b).p, p)));
          if (d < best) best = d;
        }
        if (n === 2 || n === 4 && f[0] === f[2] && f[1] === f[3]) best = Math.min(best, Math.hypot(f[0] - p[0], f[1] - p[1]));
        if (it.width) best = Math.max(0, best - it.width / 2);
      }
    } else if (it.kind === 'fill') {
      const loops = it.loops.map((l) => { const q: Pt[] = []; for (let i = 0; i < l.length; i += 2) q.push([l[i], l[i + 1]]); return q; });
      if (pointInLoops(p, loops)) return 0;
    } else if (it.kind === 'text') {
      const w = [...it.text].length * it.h * 0.8;
      const inv = invertAffine(it.m); const q = apply(inv, p);
      if (q[0] >= 0 && q[0] <= w && q[1] >= -0.3 * it.h && q[1] <= it.h) return 0;
    }
  }
  return best;
}
const sub2 = (a: Pt, b: Pt): [number, number] => [a[0] - b[0], a[1] - b[1]];
function invertAffine(m: number[]): [number, number, number, number, number, number] {
  const d = m[0] * m[3] - m[1] * m[2] || 1e-12;
  const a = m[3] / d, b = -m[1] / d, c = -m[2] / d, dd = m[0] / d;
  return [a, b, c, dd, -(a * m[4] + c * m[5]), -(b * m[4] + dd * m[5])];
}

/** Topmost entity within `tol` world units of p. */
export function pick(doc: CadDocument, src: ItemSource, p: Pt, tol: number, o: SelectOptions = {}): number | null {
  const ids = doc.query([p[0] - tol, p[1] - tol, p[0] + tol, p[1] + tol]);
  const order = new Map<number, number>();
  let i = 0;
  if (ids.length > 1) for (const k of doc.entities.keys()) order.set(k, i++);
  let best: number | null = null, bestD = Infinity, bestOrder = -1;
  for (const id of ids) {
    const e = doc.get(id);
    if (!e || !selectable(doc, e, o)) continue;
    const d = distanceToEntity(e, p, src, doc);
    if (d > tol) continue;
    const ord = order.get(id) ?? 0;
    // prefer the closest; on ties prefer the one drawn last (on top)
    if (d < bestD - tol * 0.1 || (Math.abs(d - bestD) <= tol * 0.1 && ord > bestOrder)) { best = id; bestD = d; bestOrder = ord; }
  }
  return best;
}

/** Window selection: entities entirely inside the box. */
export function windowSelect(doc: CadDocument, box: BBox, o: SelectOptions = {}): number[] {
  return doc.query(box).filter((id) => {
    const e = doc.get(id); const b = doc.cachedBox(id);
    return !!e && !!b && selectable(doc, e, o) && boxInside(b, box);
  });
}

/** Crossing selection: entities inside or crossing the box. */
export function crossingSelect(doc: CadDocument, src: ItemSource, box: BBox, o: SelectOptions = {}): number[] {
  const out: number[] = [];
  for (const id of doc.query(box)) {
    const e = doc.get(id); const b = doc.cachedBox(id);
    if (!e || !b || !selectable(doc, e, o)) continue;
    if (boxInside(b, box) || isTextual(e) || crosses(e, src, box)) out.push(id);
  }
  return out;
}
function crosses(e: Entity, src: ItemSource, r: BBox): boolean {
  const corner: Pt = [r[0], r[1]];
  for (const it of src.itemsFor(e)) {
    if (it.kind === 'stroke') {
      for (const f of it.paths) {
        if (f.length === 2 || f.length === 4 && f[0] === f[2] && f[1] === f[3]) { if (f[0] >= r[0] && f[0] <= r[2] && f[1] >= r[1] && f[1] <= r[3]) return true; continue; }
        for (let i = 2; i < f.length; i += 2) if (segIntersectsRect([f[i - 2], f[i - 1]], [f[i], f[i + 1]], r)) return true;
      }
    } else if (it.kind === 'fill') {
      const loops = it.loops.map((l) => { const q: Pt[] = []; for (let i = 0; i < l.length; i += 2) q.push([l[i], l[i + 1]]); return q; });
      if (pointInLoops(corner, loops)) return true;
      for (const l of loops) for (let i = 0; i < l.length; i++) if (segIntersectsRect(l[i], l[(i + 1) % l.length], r)) return true;
    } else if (it.kind === 'text') return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------------
// Fence and polygon selection (Phase 3A+): FENCE, WPOLYGON (entities entirely inside), CPOLYGON (inside or crossing).
// ---------------------------------------------------------------------------------------------------------------------

export type PathMode = 'F' | 'WP' | 'CP';

const orient = (a: Pt, b: Pt, c: Pt) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const onSegment = (a: Pt, b: Pt, p: Pt, eps = 1e-9) =>
  p[0] >= Math.min(a[0], b[0]) - eps && p[0] <= Math.max(a[0], b[0]) + eps && p[1] >= Math.min(a[1], b[1]) - eps && p[1] <= Math.max(a[1], b[1]) + eps;
/** Scale-aware "is this cross product zero" test. */
const isZero = (o: number, a: Pt, b: Pt, c: Pt) => Math.abs(o) <= 1e-12 * (Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]) + 1e-300) * (Math.abs(c[0] - a[0]) + Math.abs(c[1] - a[1]) + 1e-300);

/** Do the closed segments ab and cd share at least one point (touching and collinear overlap included)? */
export function segmentsMeet(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  if (Math.max(a[0], b[0]) < Math.min(c[0], d[0]) || Math.max(c[0], d[0]) < Math.min(a[0], b[0])) return false;
  if (Math.max(a[1], b[1]) < Math.min(c[1], d[1]) || Math.max(c[1], d[1]) < Math.min(a[1], b[1])) return false;
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  if (isZero(o1, a, b, c) && onSegment(a, b, c)) return true;
  if (isZero(o2, a, b, d) && onSegment(a, b, d)) return true;
  if (isZero(o3, c, d, a) && onSegment(c, d, a)) return true;
  if (isZero(o4, c, d, b) && onSegment(c, d, b)) return true;
  return false;
}
/** Segments that cross each other at a single interior point of both (no touching, no overlap). */
function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0)) && !isZero(o1, a, b, c) && !isZero(o2, a, b, d);
}
const polyEdges = (poly: Pt[]): [Pt, Pt][] => poly.map((p, i) => [p, poly[(i + 1) % poly.length]] as [Pt, Pt]);
const polyBox = (pts: Pt[]): BBox => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  return [x0, y0, x1, y1];
};
const boxPoly = (b: BBox): Pt[] => [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
const boxesOverlap = (a: BBox, b: BBox) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
/** Inside the polygon or on its boundary. */
function inOrOn(p: Pt, poly: Pt[], edges: [Pt, Pt][]): boolean {
  if (pointInPolygon(p, poly)) return true;
  for (const [a, b] of edges) { const q = closestOnSeg(p, a, b).p; if (Math.hypot(q[0] - p[0], q[1] - p[1]) <= 1e-9 * (1 + Math.abs(p[0]) + Math.abs(p[1]))) return true; }
  return false;
}
/** Quadrilateral covered by a drawn text item (same footprint distanceToEntity uses for hit tests). */
function textQuad(it: Extract<DrawItem, { kind: 'text' }>): Pt[] {
  const w = [...it.text].length * it.h * 0.8;
  return ([[0, -0.3 * it.h], [w, -0.3 * it.h], [w, it.h], [0, it.h]] as Pt[]).map((q) => apply(it.m, q));
}

interface Shape { pts: Pt[]; closed: boolean }
/** Every polyline an entity is drawn with (stroke paths, fill outlines, text footprints); textual entities use their box. */
function shapesOf(e: Entity, src: ItemSource, doc: CadDocument): { shapes: Shape[]; fills: Pt[][] } {
  const shapes: Shape[] = [], fills: Pt[][] = [];
  if (isTextual(e)) { const b = doc.cachedBox(e.id) ?? doc.bboxOf(e); shapes.push({ pts: boxPoly(b), closed: true }); return { shapes, fills }; }
  for (const it of src.itemsFor(e)) {
    if (it.kind === 'stroke') {
      for (let pi = 0; pi < it.paths.length; pi++) {
        const f = it.paths[pi], pts: Pt[] = [];
        for (let i = 0; i + 1 < f.length; i += 2) pts.push([f[i], f[i + 1]]);
        if (pts.length) shapes.push({ pts, closed: !!it.closed?.[pi] });
      }
    } else if (it.kind === 'fill') {
      for (const l of it.loops) { const q: Pt[] = []; for (let i = 0; i + 1 < l.length; i += 2) q.push([l[i], l[i + 1]]); if (q.length) { shapes.push({ pts: q, closed: true }); fills.push(q); } }
    } else if (it.kind === 'text') shapes.push({ pts: textQuad(it), closed: true });
  }
  return { shapes, fills };
}
function shapeSegments(s: Shape, fn: (a: Pt, b: Pt) => boolean): boolean {
  const n = s.pts.length;
  if (n === 1) return fn(s.pts[0], s.pts[0]);
  if (n === 2 && s.pts[0][0] === s.pts[1][0] && s.pts[0][1] === s.pts[1][1]) return fn(s.pts[0], s.pts[1]); // degenerate = point
  const last = s.closed ? n : n - 1;
  for (let i = 0; i < last; i++) if (fn(s.pts[i], s.pts[(i + 1) % n])) return true;
  return false;
}

/** FENCE: entities touched by an open polyline (no area involved). */
export function fenceSelect(doc: CadDocument, src: ItemSource, fence: Pt[], o: SelectOptions = {}): number[] {
  if (fence.length < 2) return [];
  const segs: [Pt, Pt][] = []; for (let i = 1; i < fence.length; i++) segs.push([fence[i - 1], fence[i]]);
  const out: number[] = [];
  for (const id of doc.query(polyBox(fence))) {
    const e = doc.get(id), b = doc.cachedBox(id);
    if (!e || !b || !selectable(doc, e, o)) continue;
    const pad = 1e-6 * (1 + Math.abs(b[0]) + Math.abs(b[1])); // points and axis-aligned lines have a degenerate box
    const eb: BBox = [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
    const near = segs.filter(([a, c]) => segIntersectsRect(a, c, eb));
    if (!near.length) continue;
    const { shapes } = shapesOf(e, src, doc);
    const hit = shapes.some((s) => shapeSegments(s, (p, q) => {
      if (p === q || (p[0] === q[0] && p[1] === q[1])) return near.some(([a, c]) => { const r = closestOnSeg(p, a, c).p; return Math.hypot(r[0] - p[0], r[1] - p[1]) <= 1e-6; });
      return near.some(([a, c]) => segmentsMeet(p, q, a, c));
    }));
    // a fence endpoint lying inside a drawn text footprint also selects it
    if (hit || (isTextual(e) && near.length)) out.push(id);
  }
  return out;
}

/** WPOLYGON (entities entirely inside the polygon) and CPOLYGON (inside or crossing it). The polygon may be concave. */
export function polygonSelect(doc: CadDocument, src: ItemSource, poly: Pt[], crossing: boolean, o: SelectOptions = {}): number[] {
  if (poly.length < 3) return [];
  const edges = polyEdges(poly), pb = polyBox(poly);
  const out: number[] = [];
  for (const id of doc.query(pb)) {
    const e = doc.get(id), b = doc.cachedBox(id);
    if (!e || !b || !selectable(doc, e, o)) continue;
    // entirely inside: all four corners of the extents inside and no polygon edge cutting through the extents
    const corners = boxPoly(b);
    const entirely = boxInside(b, pb) && corners.every((c) => inOrOn(c, poly, edges)) &&
      !edges.some(([p, q]) => polyEdges(corners).some(([c, d]) => segmentsCross(p, q, c, d)));
    if (entirely) { out.push(id); continue; }
    if (!crossing) continue;
    const { shapes, fills } = shapesOf(e, src, doc);
    const hit = shapes.some((s) => s.pts.some((p) => inOrOn(p, poly, edges)) || shapeSegments(s, (p, q) => edges.some(([a, c]) => segmentsMeet(p, q, a, c))))
      || fills.length > 0 && pointInLoops(poly[0], fills)
      || (isTextual(e) && poly.some((p) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3]));
    if (hit) out.push(id);
  }
  return out;
}
