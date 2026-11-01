import type { Pt } from '../types';

/** 2D affine matrix [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. */
export type Mat = [number, number, number, number, number, number];
export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];
export const mmul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
export const apply = (m: Mat, p: Pt): Pt => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
export const translate = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];
export const scaleM = (sx: number, sy = sx): Mat => [sx, 0, 0, sy, 0, 0];
export const rotateM = (a: number): Mat => [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
export const isIdentity = (m: Mat) => m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
export const det = (m: Mat) => m[0] * m[3] - m[1] * m[2];
/** Uniform scale factor (geometric mean of axis scales). */
export const scaleOf = (m: Mat) => Math.sqrt(Math.abs(det(m)));
export function invert(m: Mat): Mat {
  const d = det(m);
  if (Math.abs(d) < 1e-15) return IDENTITY;
  const a = m[3] / d, b = -m[1] / d, c = -m[2] / d, dd = m[0] / d;
  return [a, b, c, dd, -(a * m[4] + c * m[5]), -(b * m[4] + dd * m[5])];
}
/** Does the matrix map circles to circles (uniform scale, optionally mirrored)? */
export function isConformal(m: Mat, tol = 1e-9) {
  const sx = Math.hypot(m[0], m[1]), sy = Math.hypot(m[2], m[3]);
  return Math.abs(sx - sy) <= tol * Math.max(1, sx) && Math.abs(m[0] * m[2] + m[1] * m[3]) <= tol * Math.max(1, sx * sy);
}
/** Matrix of a block insert (without array offset). */
export function insertMatrix(p: Pt, sx: number, sy: number, rot: number, base: Pt, colOff = 0, rowOff = 0): Mat {
  return mmul(translate(p[0], p[1]), mmul(rotateM(rot), mmul(translate(colOff, rowOff), mmul(scaleM(sx, sy), translate(-base[0], -base[1])))));
}
