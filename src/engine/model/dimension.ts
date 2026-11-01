/**
 * Geometry generation for engine-created dimensions (linear, aligned, radius, diameter).
 * Sizes come from the drawing's dimension style (paper mm) multiplied by the drawing scale and unit factor,
 * matching how YQArch sizes annotation by "drawing scale" (sd command).
 */
import type { DimEnt, NewEntity, Pt } from '../types';
import { add, angleOf, dist, dot, len, mulS, norm, perp, polar, sub, TAU } from '../geom/vec';
import { unitsPerMm, type DocSettings } from './settings';

export const formatNumber = (v: number, precision: number) => {
  const s = v.toFixed(Math.max(0, Math.min(8, precision)));
  return s === '-0' ? '0' : s;
};
/** Readable text angle: keep text upright (angles in (90°, 270°] are flipped). */
export function readableAngle(a: number): number {
  let r = a % TAU; if (r < 0) r += TAU;
  return r > Math.PI / 2 + 1e-9 && r <= (3 * Math.PI) / 2 + 1e-9 ? r - Math.PI : r;
}
export function dimMeasurement(d: DimEnt): number {
  if (d.measurement !== undefined && !d.kind) return d.measurement;
  const p1 = d.p1 ?? [0, 0], p2 = d.p2 ?? [0, 0];
  switch (d.kind) {
    case 'aligned': return dist(p1, p2);
    case 'linear': { const r = d.rot ?? 0; return Math.abs(dot(sub(p2, p1), [Math.cos(r), Math.sin(r)])); }
    case 'radius': return dist(p1, p2);
    case 'diameter': return 2 * dist(p1, p2);
    default: return d.measurement ?? 0;
  }
}
export function dimText(d: DimEnt, precision: number): string {
  const v = formatNumber(dimMeasurement(d), precision);
  const prefix = d.kind === 'radius' ? 'R' : d.kind === 'diameter' ? '%%c' : '';
  const t = d.text ?? '';
  return t === '' ? prefix + v : t.replace('<>', prefix + v);
}

type G = NewEntity;
export function dimensionGeometry(d: DimEnt, s: DocSettings, units: number): G[] {
  if (!d.kind || !d.p1 || !d.p2) return [];
  const k = (d.dimScale ?? s.drawingScale) * unitsPerMm(units);
  const st = s.dim;
  const th = st.textHeight * k, as = st.arrowSize * k, exo = st.extOffset * k, exe = st.extBeyond * k, gap = st.textGap * k;
  const base = { layer: d.layer, color: 0 } as const;
  const out: G[] = [];
  const line = (a: Pt, b: Pt) => out.push({ ...base, type: 'LINE', a, b } as G);
  const arrow = (tip: Pt, toward: Pt) => {
    const u = norm(sub(toward, tip));
    if (st.arrow === 'tick') {
      const t = norm(add(u, perp(u)));
      line(add(tip, mulS(t, -as / 2)), add(tip, mulS(t, as / 2)));
    } else if (st.arrow === 'dot') {
      const r = as / 4, pts: Pt[] = [];
      for (let i = 0; i < 16; i++) pts.push(polar(tip, (i / 16) * TAU, r));
      out.push({ ...base, type: 'HATCH', pattern: 'SOLID', solid: true, loops: [pts] } as G);
    } else {
      const b = add(tip, mulS(u, as)), w = perp(u);
      out.push({ ...base, type: 'SOLID', pts: [tip, add(b, mulS(w, as / 6)), add(b, mulS(w, -as / 6)), add(b, mulS(w, -as / 6))] } as G);
    }
  };
  const text = (p: Pt, ang: number, str: string) =>
    out.push({ ...base, type: 'TEXT', text: str, p, p2: p, h: th, rot: readableAngle(ang), style: st.textStyle, halign: 1, valign: 1 } as G);
  const str = dimText(d, st.precision);

  if (d.kind === 'linear' || d.kind === 'aligned') {
    const p1 = d.p1, p2 = d.p2, loc = d.loc ?? d.p2;
    const ang = d.kind === 'aligned' ? angleOf(p1, p2) : d.rot ?? 0;
    const dir: Pt = [Math.cos(ang), Math.sin(ang)], n = perp(dir);
    const d1 = add(p1, mulS(n, dot(sub(loc, p1), n))), d2 = add(p2, mulS(n, dot(sub(loc, p2), n)));
    for (const [p, q] of [[p1, d1], [p2, d2]] as [Pt, Pt][]) {
      const v = sub(q, p), L = len(v);
      const u = L > 1e-9 ? mulS(v, 1 / L) : n;
      if (L > exo) line(add(p, mulS(u, exo)), add(q, mulS(u, exe)));
      else line(q, add(q, mulS(u, exe)));
    }
    line(d1, d2);
    if (dist(d1, d2) > 1e-9) { arrow(d1, d2); arrow(d2, d1); }
    const ta = readableAngle(ang), up = perp([Math.cos(ta), Math.sin(ta)]);
    const tp = d.textPoint ?? add([(d1[0] + d2[0]) / 2, (d1[1] + d2[1]) / 2], mulS(up, gap));
    text(tp, ang, str);
  } else {
    const c = d.p1, p = d.p2, r = dist(c, p);
    const u = r > 1e-9 ? norm(sub(p, c)) : [1, 0] as Pt;
    const ang = Math.atan2(u[1], u[0]);
    if (d.kind === 'radius') { line(c, p); if (st.arrow === 'tick') arrow(p, c); else arrow(p, c); }
    else { const q = sub(c, mulS(u, r)); line(q, p); arrow(p, q); arrow(q, p); }
    const ta = readableAngle(ang), up = perp([Math.cos(ta), Math.sin(ta)]);
    const midR = d.kind === 'radius' ? add(c, mulS(u, r / 2)) : c;
    text(d.textPoint ?? add(midR, mulS(up, gap)), ang, str);
  }
  return out;
}
