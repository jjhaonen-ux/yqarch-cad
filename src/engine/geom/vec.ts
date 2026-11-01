import type { Pt } from '../types';

export const EPS = 1e-9;
export const TAU = Math.PI * 2;
export const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
export const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
export const mulS = (a: Pt, s: number): Pt => [a[0] * s, a[1] * s];
export const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];
export const cross = (a: Pt, b: Pt) => a[0] * b[1] - a[1] * b[0];
export const len = (a: Pt) => Math.hypot(a[0], a[1]);
export const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
export const angleOf = (a: Pt, b: Pt) => Math.atan2(b[1] - a[1], b[0] - a[0]);
export const polar = (p: Pt, ang: number, d: number): Pt => [p[0] + Math.cos(ang) * d, p[1] + Math.sin(ang) * d];
export const rotate = (p: Pt, ang: number, c: Pt = [0, 0]): Pt => {
  const s = Math.sin(ang), co = Math.cos(ang), x = p[0] - c[0], y = p[1] - c[1];
  return [c[0] + x * co - y * s, c[1] + x * s + y * co];
};
export const norm = (a: Pt): Pt => { const l = len(a); return l < EPS ? [0, 0] : [a[0] / l, a[1] / l]; };
export const perp = (a: Pt): Pt => [-a[1], a[0]];
export const eq = (a: Pt, b: Pt, tol = 1e-7) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;
/** Normalize an angle into [0, 2π). */
export const normAngle = (a: number) => { const r = a % TAU; return r < 0 ? r + TAU : r; };
/** CCW sweep from a0 to a1 in (0, 2π]. */
export const ccwSweep = (a0: number, a1: number) => { const s = normAngle(a1 - a0); return s < EPS ? TAU : s; };
/** Is angle `a` on the CCW arc from a0 to a1? */
export const angleOnArc = (a: number, a0: number, a1: number, tol = 1e-9) => normAngle(a - a0) <= ccwSweep(a0, a1) + tol || normAngle(a - a0) >= TAU - tol;
export const deg = (r: number) => (r * 180) / Math.PI;
export const rad = (d: number) => (d * Math.PI) / 180;
