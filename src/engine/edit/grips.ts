/**
 * Grips: the editable points shown on selected entities, and the STRETCH edit of hot grips.
 * Kind 'move' grips (centres, text anchors, insertion points, line midpoints) translate the entity; 'stretch' grips
 * change its shape.
 */
import type { BBox, Entity, Pt } from '../types';
import { add, angleOf, angleOnArc, ccwSweep, dist, mid, norm, polar, sub, TAU } from '../geom/vec';
import { bulgeFrom3, bulgeToPrim, circleFrom3 } from '../geom/prims';
import { moveM, transformEntity } from '../geom/transform';
import { ellipseFromConjugate } from '../geom/affine';
import { evalSpline, hasNurbs } from '../geom/spline';

export type GripKind = 'move' | 'stretch';
export interface Grip { index: number; p: Pt; kind: GripKind }
export interface GripContext { bbox?(e: Entity): BBox | null }

/** Hatches with more boundary vertices than this only show their centre grip. */
export const MAX_HATCH_VERTEX_GRIPS = 200;
/** Grips are only displayed when at most this many entities are selected (AutoCAD GRIPOBJLIMIT). */
export const GRIP_OBJECT_LIMIT = 100;

const textAnchor = (t: { p: Pt; p2?: Pt; halign?: number; valign?: number }): Pt => ((t.halign || t.valign) && t.p2 ? t.p2 : t.p);
const isAlignedFit = (t: { halign?: number }) => t.halign === 3 || t.halign === 5;
const bboxCenter = (b: BBox | null | undefined): Pt | null => (b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : null);
function loopsCenter(loops: Pt[][]): Pt {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of loops) for (const p of l) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  return x0 <= x1 ? [(x0 + x1) / 2, (y0 + y1) / 2] : [0, 0];
}
const ellipseMinor = (e: { major: Pt; ratio: number }): Pt => [-e.major[1] * e.ratio, e.major[0] * e.ratio];

/** Grips of an entity, in a stable order (indices are positions in this list). */
export function entityGrips(e: Entity, ctx: GripContext = {}): Grip[] {
  const g: Grip[] = [];
  const push = (p: Pt, kind: GripKind = 'stretch') => g.push({ index: g.length, p: [p[0], p[1]], kind });
  switch (e.type) {
    case 'LINE': push(e.a); push(e.b); push(mid(e.a, e.b), 'move'); break;
    case 'POINT': push(e.p, 'move'); break;
    case 'CIRCLE': push(e.c, 'move'); for (let k = 0; k < 4; k++) push(polar(e.c, (k * Math.PI) / 2, e.r)); break;
    case 'ARC': push(e.c, 'move'); push(polar(e.c, e.a0, e.r)); push(polar(e.c, e.a1, e.r)); push(polar(e.c, e.a0 + ccwSweep(e.a0, e.a1) / 2, e.r)); break;
    case 'ELLIPSE': { const n = ellipseMinor(e); push(e.c, 'move'); push(add(e.c, e.major)); push(sub(e.c, e.major)); push(add(e.c, n)); push(sub(e.c, n)); break; }
    case 'LWPOLYLINE': {
      const n = e.pts.length;
      for (const v of e.pts) push([v[0], v[1]]);
      for (let i = 0; i < (e.closed ? n : n - 1); i++) {
        const a = e.pts[i], b = e.pts[(i + 1) % n];
        const q = bulgeToPrim([a[0], a[1]], [b[0], b[1]], a[2] ?? 0);
        push(q.k === 'seg' ? mid(q.a, q.b) : polar(q.c, q.a0 + ccwSweep(q.a0, q.a1) / 2, q.r));
      }
      break;
    }
    case 'SPLINE': for (const c of hasNurbs(e) ? e.ctrl! : e.pts) push([c[0], c[1]]); break;
    case 'SOLID': for (const p of e.pts) push(p); break;
    case 'WIPEOUT': for (const p of e.loop) push(p); break;
    case 'TEXT': case 'ATTDEF': case 'ATTRIB':
      if (isAlignedFit(e)) { push(e.p); push(e.p2 ?? e.p); } else push(textAnchor(e), 'move');
      break;
    case 'MTEXT': push(e.p, 'move'); break;
    case 'INSERT': push(e.p, 'move'); for (const a of e.attribs ?? []) push(textAnchor(a)); break;
    case 'DIMENSION':
      if (!e.block && e.kind && e.p1 && e.p2) {
        if (e.kind === 'radius' || e.kind === 'diameter') { push(e.p1, 'move'); push(e.p2); }
        else { push(e.p1); push(e.p2); push(e.loc ?? mid(e.p1, e.p2)); }
      } else push(e.textPoint ?? bboxCenter(ctx.bbox?.(e)) ?? [0, 0], 'move');
      break;
    case 'HATCH': {
      push(bboxCenter(ctx.bbox?.(e)) ?? loopsCenter(e.loops), 'move');
      const total = e.loops.reduce((s, l) => s + l.length, 0);
      if (total <= MAX_HATCH_VERTEX_GRIPS) for (const l of e.loops) for (const p of l) push(p);
      break;
    }
  }
  return g;
}

/** Arc through start s, middle m, end e (keeps the curve passing through the three points), or null when collinear. */
function arc3(s: Pt, m: Pt, en: Pt): { c: Pt; r: number; a0: number; a1: number } | null {
  const c = circleFrom3(s, m, en);
  if (!c) return null;
  const as = angleOf(c.c, s), am = angleOf(c.c, m), ae = angleOf(c.c, en);
  return angleOnArc(am, as, ae) ? { c: c.c, r: c.r, a0: as, a1: ae } : { c: c.c, r: c.r, a0: ae, a1: as };
}

/**
 * Apply a STRETCH to the hot grips `hot` (indices from entityGrips) of `e`, moving them by `delta`.
 * A hot 'move' grip translates the whole entity. Returns the new entity (same id) or null when nothing changes.
 */
export function stretchGrips<E extends Entity>(e: E, hot: number[], delta: Pt, ctx: GripContext = {}): E | null {
  if (!hot.length || (delta[0] === 0 && delta[1] === 0)) return null;
  const grips = entityGrips(e, ctx);
  const hs = new Set(hot.filter((i) => i >= 0 && i < grips.length));
  if (!hs.size) return null;
  if ([...hs].some((i) => grips[i].kind === 'move')) return transformEntity(e, moveM(delta));
  const at = (i: number): Pt => add(grips[i].p, delta);
  const x = structuredClone(e) as Entity;
  switch (x.type) {
    case 'LINE': if (hs.has(0)) x.a = at(0); if (hs.has(1)) x.b = at(1); break;
    case 'CIRCLE': { const k = [...hs].pop()!; x.r = Math.max(1e-9, dist(x.c, at(k))); break; }
    case 'ARC': {
      const s = hs.has(1) ? at(1) : grips[1].p, en = hs.has(2) ? at(2) : grips[2].p, m = hs.has(3) ? at(3) : grips[3].p;
      const a = arc3(s, m, en);
      if (!a) return null;
      x.c = a.c; x.r = a.r; x.a0 = a.a0; x.a1 = a.a1;
      break;
    }
    case 'ELLIPSE': {
      let M = x.major, N = ellipseMinor(x);
      const dm = norm(M), dn = norm(N);
      if (hs.has(1) || hs.has(2)) { const L = dist(x.c, at(hs.has(1) ? 1 : 2)); M = [dm[0] * L, dm[1] * L]; }
      if (hs.has(3) || hs.has(4)) { const L = dist(x.c, at(hs.has(3) ? 3 : 4)); N = [dn[0] * L, dn[1] * L]; }
      let sw = x.a1 - x.a0; while (sw <= 1e-12) sw += TAU;
      const full = Math.abs(sw - TAU) < 1e-9;
      const r = ellipseFromConjugate(x as unknown as Record<string, unknown>, x.c, M, N, x.a0, x.a0 + sw, full) as unknown as Entity;
      (r as { id: number }).id = e.id;
      return r as E;
    }
    case 'LWPOLYLINE': {
      const n = x.pts.length, segs = x.closed ? n : n - 1;
      const orig = e.type === 'LWPOLYLINE' ? e.pts : [];
      const moveV = new Set<number>();
      for (const i of hs) {
        if (i < n) moveV.add(i);
        else { const k = i - n; if (!(orig[k][2])) { moveV.add(k); moveV.add((k + 1) % n); } }
      }
      for (const v of moveV) { x.pts[v][0] = orig[v][0] + delta[0]; x.pts[v][1] = orig[v][1] + delta[1]; }
      for (const i of hs) {
        if (i < n) continue;
        const k = i - n; if (k >= segs || !orig[k][2]) continue;
        const a = x.pts[k], b = x.pts[(k + 1) % n];
        x.pts[k][2] = bulgeFrom3([a[0], a[1]], at(i), [b[0], b[1]]);
        if (!x.pts[k][2]) x.pts[k].length = 2;
      }
      break;
    }
    case 'SPLINE':
      if (hasNurbs(x)) {
        for (const i of hs) { x.ctrl![i][0] += delta[0]; x.ctrl![i][1] += delta[1]; }
        x.pts = evalSpline(x, Math.max(e.type === 'SPLINE' ? e.pts.length : 0, 8 * x.ctrl!.length + 1));
        delete x.fit;
      } else for (const i of hs) x.pts[i] = at(i);
      break;
    case 'SOLID': for (const i of hs) x.pts[i] = at(i); break;
    case 'WIPEOUT': for (const i of hs) x.loop[i] = at(i); break;
    case 'TEXT': case 'ATTDEF': case 'ATTRIB':
      if (hs.has(0)) x.p = at(0);
      if (hs.has(1)) x.p2 = at(1);
      break;
    case 'INSERT':
      for (const i of hs) {
        const a = x.attribs?.[i - 1]; if (!a) continue;
        a.p = add(a.p, delta); if (a.p2) a.p2 = add(a.p2, delta);
      }
      break;
    case 'DIMENSION':
      if (x.kind === 'radius' || x.kind === 'diameter') { if (hs.has(1)) x.p2 = at(1); }
      else { if (hs.has(0)) x.p1 = at(0); if (hs.has(1)) x.p2 = at(1); if (hs.has(2)) x.loc = at(2); }
      break;
    case 'HATCH': {
      let k = 1;
      for (const l of x.loops) for (let j = 0; j < l.length; j++, k++) if (hs.has(k)) l[j] = at(k);
      break;
    }
    default: return null;
  }
  return x as E;
}
