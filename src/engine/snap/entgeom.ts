/** Snap geometry of entities in world coordinates: analytic primitives plus characteristic points. Cached per entity object. */
import type { CadDocument } from '../model/document';
import type { Entity, Pt } from '../types';
import { apply, det, IDENTITY, insertMatrix, isConformal, mmul, scaleOf, type Mat } from '../geom/matrix';
import { arc, arcEnd, arcMid, arcStart, bulgeToPrim, primPoints, seg, type Prim } from '../geom/prims';
import { angleOf, angleOnArc, TAU } from '../geom/vec';
import { dimensionGeometry } from '../model/dimension';

export interface SnapGeom { prims: Prim[]; end: Pt[]; mid: Pt[]; cen: Pt[]; qua: Pt[]; node: Pt[]; ins: Pt[] }
const empty = (): SnapGeom => ({ prims: [], end: [], mid: [], cen: [], qua: [], node: [], ins: [] });

const cache = new WeakMap<Entity, { epoch: number; g: SnapGeom }>();
export function entitySnapGeom(e: Entity, doc: CadDocument): SnapGeom {
  const c = cache.get(e);
  if (c && c.epoch === doc.renderEpoch) return c.g;
  const g = empty();
  collect(e, doc, IDENTITY, g, 0);
  cache.set(e, { epoch: doc.renderEpoch, g });
  return g;
}

function addPrim(q: Prim, m: Mat, g: SnapGeom, withPoints = true) {
  const ident = m === IDENTITY;
  if (q.k === 'seg') {
    const a = ident ? q.a : apply(m, q.a), b = ident ? q.b : apply(m, q.b);
    g.prims.push(seg(a, b));
    if (withPoints) { g.end.push(a, b); g.mid.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]); }
    return;
  }
  if (!ident && !isConformal(m)) { // arcs become ellipses: approximate with segments
    const pts = primPoints(q, 64).map((p) => apply(m, p));
    for (let i = 1; i < pts.length; i++) g.prims.push(seg(pts[i - 1], pts[i]));
    if (withPoints && !q.full) g.end.push(pts[0], pts[pts.length - 1]);
    if (withPoints) g.cen.push(apply(m, q.c));
    return;
  }
  let t = q;
  if (!ident) {
    const c = apply(m, q.c), r = q.r * scaleOf(m);
    if (q.full) t = arc(c, r, 0, TAU, true);
    else {
      const s = apply(m, arcStart(q)), en = apply(m, arcEnd(q));
      t = det(m) > 0 ? arc(c, r, angleOf(c, s), angleOf(c, en)) : arc(c, r, angleOf(c, en), angleOf(c, s));
    }
  }
  g.prims.push(t);
  if (!withPoints) return;
  g.cen.push(t.c);
  if (!t.full) { g.end.push(arcStart(t), arcEnd(t)); g.mid.push(arcMid(t)); }
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    const on = t.full || angleOnArc(a, t.a0, t.a1);
    if (on) g.qua.push([t.c[0] + t.r * Math.cos(a), t.c[1] + t.r * Math.sin(a)]);
  }
}

function collect(e: Entity, doc: CadDocument, m: Mat, g: SnapGeom, depth: number) {
  if (depth > 8) return;
  const P = (p: Pt) => (m === IDENTITY ? p : apply(m, p));
  switch (e.type) {
    case 'LINE': addPrim(seg(e.a, e.b), m, g); break;
    case 'POINT': g.node.push(P(e.p)); break;
    case 'CIRCLE': addPrim(arc(e.c, e.r, 0, TAU, true), m, g); break;
    case 'ARC': addPrim(arc(e.c, e.r, e.a0, e.a1), m, g); break;
    case 'LWPOLYLINE': {
      const v = e.pts, n = v.length;
      for (let i = 0; i < (e.closed ? n : n - 1); i++) {
        const a = v[i], b = v[(i + 1) % n];
        addPrim(bulgeToPrim([a[0], a[1]], [b[0], b[1]], a[2] ?? 0), m, g);
      }
      if (n === 1) g.end.push(P([v[0][0], v[0][1]]));
      break;
    }
    case 'ELLIPSE': {
      let sw = e.a1 - e.a0; while (sw <= 1e-12) sw += TAU;
      const mn: Pt = [-e.major[1] * e.ratio, e.major[0] * e.ratio];
      const at = (t: number): Pt => [e.c[0] + e.major[0] * Math.cos(t) + mn[0] * Math.sin(t), e.c[1] + e.major[1] * Math.cos(t) + mn[1] * Math.sin(t)];
      const n = 64; let prev = at(e.a0);
      for (let i = 1; i <= n; i++) { const p = at(e.a0 + (sw * i) / n); g.prims.push(seg(P(prev), P(p))); prev = p; }
      g.cen.push(P(e.c));
      for (const t of [0, Math.PI / 2, Math.PI, 1.5 * Math.PI]) g.qua.push(P(at(t)));
      if (Math.abs(sw - TAU) > 1e-9) g.end.push(P(at(e.a0)), P(at(e.a1)));
      break;
    }
    case 'SPLINE': for (let i = 1; i < e.pts.length; i++) g.prims.push(seg(P(e.pts[i - 1]), P(e.pts[i]))); if (e.pts.length) g.end.push(P(e.pts[0]), P(e.pts[e.pts.length - 1])); break;
    case 'SOLID': { const q = e.pts.length >= 4 ? [e.pts[0], e.pts[1], e.pts[3], e.pts[2]] : e.pts; for (let i = 0; i < q.length; i++) addPrim(seg(q[i], q[(i + 1) % q.length]), m, g); break; }
    case 'TEXT': case 'ATTRIB': case 'ATTDEF': g.ins.push(P((e.halign || e.valign) && e.p2 ? e.p2 : e.p)); break;
    case 'MTEXT': g.ins.push(P(e.p)); break;
    case 'INSERT': {
      g.ins.push(P(e.p));
      const def = doc.getBlock(e.name);
      if (!def || def.entities.length > 3000) break;
      const im = mmul(m, insertMatrix(e.p, e.sx, e.sy, e.rot, def.base));
      for (const c of def.entities) if (c.type !== 'ATTDEF' && c.type !== 'HATCH') collect(c, doc, im, g, depth + 1);
      break;
    }
    case 'DIMENSION': {
      if (e.p1) g.node.push(P(e.p1));
      if (e.p2) g.node.push(P(e.p2));
      for (const ge of dimensionGeometry(e, doc.settings, doc.units)) if (ge.type === 'LINE') addPrim(seg(ge.a, ge.b), m, g, false);
      break;
    }
    case 'HATCH': case 'WIPEOUT': break;
  }
}
