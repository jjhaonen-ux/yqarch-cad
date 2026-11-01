/** Object snaps (END, MID, CEN, INT, PER, QUA, NEA, NODE, INS), ortho, polar tracking and grid snap. */
import type { CadDocument } from '../model/document';
import type { Pt } from '../types';
import type { Viewport } from '../render/view';
import { closestOnPrim, distToPrim, intersect, perpendicularFoot, type Prim } from '../geom/prims';
import { angleOf, deg, dist, polar } from '../geom/vec';
import { entitySnapGeom } from './entgeom';

export type SnapKind = 'end' | 'mid' | 'cen' | 'int' | 'per' | 'qua' | 'nea' | 'node' | 'ins' | 'grid' | 'polar' | 'ortho';
export const OSNAP_KINDS: SnapKind[] = ['end', 'mid', 'cen', 'int', 'per', 'qua', 'nea', 'node', 'ins'];
export const SNAP_LABELS: Record<SnapKind, { en: string; ar: string }> = {
  end: { en: 'Endpoint', ar: 'نقطة طرفية' }, mid: { en: 'Midpoint', ar: 'منتصف' }, cen: { en: 'Center', ar: 'مركز' },
  int: { en: 'Intersection', ar: 'تقاطع' }, per: { en: 'Perpendicular', ar: 'عمودي' }, qua: { en: 'Quadrant', ar: 'ربع دائرة' },
  nea: { en: 'Nearest', ar: 'أقرب نقطة' }, node: { en: 'Node', ar: 'عقدة' }, ins: { en: 'Insertion', ar: 'نقطة إدراج' },
  grid: { en: 'Grid', ar: 'شبكة' }, polar: { en: 'Polar', ar: 'قطبي' }, ortho: { en: 'Ortho', ar: 'متعامد' },
};

export interface SnapSettings {
  osnapOn: boolean; modes: Set<SnapKind>;
  orthoOn: boolean; polarOn: boolean; polarIncDeg: number;
  gridSnapOn: boolean; snapSpacing: number;
  /** Aperture in pixels. */ aperture: number;
}
export const defaultSnapSettings = (): SnapSettings => ({
  osnapOn: true, modes: new Set<SnapKind>(['end', 'mid', 'cen', 'int', 'per', 'qua', 'node', 'ins']),
  orthoOn: false, polarOn: true, polarIncDeg: 45, gridSnapOn: false, snapSpacing: 100, aperture: 12,
});

export interface SnapResult { p: Pt; kind: SnapKind | null; tracking?: { from: Pt; angle: number; dist: number } }
export interface SnapInput { cursor: Pt; base?: Pt | null; extraPrims?: Prim[]; extraPoints?: Pt[]; exclude?: Set<number> }

const BIAS: Partial<Record<SnapKind, number>> = { end: 0, int: 0, node: 0, ins: 0.5, mid: 0.5, cen: 1, qua: 1, per: 1.5 };

export function computeSnap(doc: CadDocument, view: Viewport, s: SnapSettings, inp: SnapInput): SnapResult {
  const cur = inp.cursor;
  if (s.osnapOn && s.modes.size) {
    const r = osnap(doc, view, s, inp);
    if (r) return r;
  }
  const base = inp.base;
  if (base && s.orthoOn) {
    const dx = cur[0] - base[0], dy = cur[1] - base[1];
    const p: Pt = Math.abs(dx) >= Math.abs(dy) ? [cur[0], base[1]] : [base[0], cur[1]];
    return { p: s.gridSnapOn ? alongSnap(base, p, s.snapSpacing) : p, kind: 'ortho', tracking: { from: base, angle: angleOf(base, p), dist: dist(base, p) } };
  }
  if (base && s.polarOn && s.polarIncDeg > 0) {
    const inc = (s.polarIncDeg * Math.PI) / 180;
    const a = angleOf(base, cur), d = dist(base, cur);
    const snapped = Math.round(a / inc) * inc;
    const p = polar(base, snapped, d * Math.cos(a - snapped));
    if (dist(p, cur) * view.scale <= 10 && d * view.scale > 10) {
      const q = s.gridSnapOn ? alongSnap(base, p, s.snapSpacing) : p;
      return { p: q, kind: 'polar', tracking: { from: base, angle: snapped, dist: dist(base, q) } };
    }
  }
  if (s.gridSnapOn && s.snapSpacing > 0) {
    const g = s.snapSpacing;
    return { p: [Math.round(cur[0] / g) * g, Math.round(cur[1] / g) * g], kind: 'grid' };
  }
  return { p: cur, kind: null };
}
const alongSnap = (base: Pt, p: Pt, g: number): Pt => { const d = dist(base, p); if (d < 1e-12 || g <= 0) return p; const a = angleOf(base, p); return polar(base, a, Math.round(d / g) * g); };

function osnap(doc: CadDocument, view: Viewport, s: SnapSettings, inp: SnapInput): SnapResult | null {
  const cur = inp.cursor;
  const ap = view.px(s.aperture);
  const ids = doc.query([cur[0] - ap, cur[1] - ap, cur[0] + ap, cur[1] + ap]).slice(-80);
  let best: { p: Pt; kind: SnapKind; score: number } | null = null;
  const consider = (p: Pt, kind: SnapKind, d = dist(p, cur)) => {
    if (!s.modes.has(kind) || d > ap) return;
    const score = d / ap + (BIAS[kind] ?? 0) * 0.15;
    if (!best || score < best.score) best = { p, kind, score };
  };
  const near: Prim[] = [];
  for (const id of ids) {
    if (inp.exclude?.has(id)) continue;
    const e = doc.get(id);
    if (!e || !doc.isVisible(e)) continue;
    const g = entitySnapGeom(e, doc);
    for (const p of g.end) consider(p, 'end');
    for (const p of g.mid) consider(p, 'mid');
    for (const p of g.node) consider(p, 'node');
    for (const p of g.ins) consider(p, 'ins');
    for (const p of g.qua) consider(p, 'qua');
    let hover = false;
    for (const q of g.prims) {
      const dq = distToPrim(cur, q);
      if (dq <= ap) { near.push(q); hover = true; }
    }
    if (hover || g.prims.length === 0) for (const p of g.cen) {
      // AutoCAD-style: hovering an arc/circle edge offers its center. The edge distance is floored so that this is only
      // a fallback: an endpoint/quadrant/midpoint inside the aperture always wins; the center point itself stays exact.
      const dCenter = dist(p, cur);
      const arcs = g.prims.filter((q) => q.k === 'arc');
      const dq = arcs.length ? Math.min(Math.max(Math.min(...arcs.map((q) => distToPrim(cur, q))), ap * 0.9), dCenter) : dCenter;
      consider(p, 'cen', dq);
    }
  }
  for (const q of inp.extraPrims ?? []) if (distToPrim(cur, q) <= ap) near.push(q);
  for (const p of inp.extraPoints ?? []) consider(p, 'end');
  if (s.modes.has('int') && near.length > 1) {
    const list = near.slice(0, 60);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) for (const p of intersect(list[i], list[j])) consider(p, 'int');
  }
  if (inp.base && s.modes.has('per')) for (const q of near) for (const p of perpendicularFoot(inp.base, q)) consider(p, 'per');
  const b = best as { p: Pt; kind: SnapKind; score: number } | null;
  if (b) return { p: b.p, kind: b.kind };
  if (s.modes.has('nea') && near.length) {
    let bp: Pt | null = null, bd = Infinity;
    for (const q of near) { const p = closestOnPrim(cur, q), d = dist(p, cur); if (d < bd) { bd = d; bp = p; } }
    if (bp) return { p: bp, kind: 'nea' };
  }
  return null;
}
export const formatPolar = (t: { angle: number; dist: number }, prec = 2) => `${t.dist.toFixed(prec)} < ${(((deg(t.angle) % 360) + 360) % 360).toFixed(0)}°`;
