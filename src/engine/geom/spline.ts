/**
 * NURBS evaluation (de Boor, rational) used to re-tessellate a SPLINE after its control points are edited with grips.
 * Sampling matches the Phase 1 converter: 8 × (number of control points) + 1 points uniformly in the parameter.
 */
import type { Pt, SplineEnt } from '../types';

export function hasNurbs(s: Pick<SplineEnt, 'ctrl' | 'knots' | 'degree'>): boolean {
  const n = s.ctrl?.length ?? 0;
  return n >= 2 && !!s.knots && s.knots.length === n + s.degree + 1 && s.degree >= 1;
}

/** Point of the NURBS curve at parameter u. */
export function nurbsPoint(deg: number, knots: number[], ctrl: number[][], weights: number[] | undefined, u: number): Pt {
  const n = ctrl.length;
  let k = deg;
  while (k < n - 1 && u >= knots[k + 1]) k++;
  const d: number[][] = [];
  for (let j = 0; j <= deg; j++) {
    const c = ctrl[k - deg + j];
    const w = weights?.[k - deg + j] ?? c[2] ?? 1;
    d.push([c[0] * w, c[1] * w, w]);
  }
  for (let r = 1; r <= deg; r++) {
    for (let j = deg; j >= r; j--) {
      const i = k - deg + j;
      const den = knots[i + deg - r + 1] - knots[i];
      const a = den === 0 ? 0 : (u - knots[i]) / den;
      for (let q = 0; q < 3; q++) d[j][q] = (1 - a) * d[j - 1][q] + a * d[j][q];
    }
  }
  const w = d[deg][2] || 1;
  return [d[deg][0] / w, d[deg][1] / w];
}

/** Polyline approximation of a NURBS spline (same sampling as the Phase 1 converter). */
export function evalSpline(s: Pick<SplineEnt, 'ctrl' | 'knots' | 'degree' | 'weights'>, samples?: number): Pt[] {
  if (!hasNurbs(s)) return [];
  const ctrl = s.ctrl!, knots = s.knots!, deg = s.degree;
  const ctrlW = ctrl.map((c) => (c.length > 2 && !s.weights ? c : [c[0], c[1]]));
  const ws = s.weights ?? (ctrl.some((c) => c.length > 2) ? ctrl.map((c) => c[2] ?? 1) : undefined);
  const u0 = knots[deg], u1 = knots[ctrl.length];
  const N = Math.max(2, samples ?? 8 * ctrl.length + 1);
  const out: Pt[] = [];
  for (let i = 0; i < N; i++) out.push(nurbsPoint(deg, knots, ctrlW, ws, u0 + ((u1 - u0) * i) / (N - 1)));
  return out;
}
