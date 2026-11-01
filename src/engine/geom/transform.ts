/**
 * Conformal transformation of entities (MOVE / COPY / ROTATE / SCALE / MIRROR, grips, block insertion with unit
 * conversion). Matrices are rotations, uniform scales, reflections and translations; see affine.ts for the general case.
 */
import type { Entity, HatchEnt, Pt, TextProps } from '../types';
import { apply, det, mmul, rotateM, scaleM, translate, type Mat } from './matrix';
import { angleOf, normAngle } from './vec';
import { readableAngle } from '../model/dimension';
import { affineText, lin, mapHatchLine, mirrorTextReadable, type AffineContext } from './affine';

export const moveM = (d: Pt): Mat => translate(d[0], d[1]);
export const rotateAbout = (c: Pt, a: number): Mat => mmul(translate(c[0], c[1]), mmul(rotateM(a), translate(-c[0], -c[1])));
export const scaleAbout = (c: Pt, s: number): Mat => mmul(translate(c[0], c[1]), mmul(scaleM(s), translate(-c[0], -c[1])));
/** Reflection across the line through a and b. */
export function mirrorM(a: Pt, b: Pt): Mat {
  const t = angleOf(a, b), c = Math.cos(2 * t), s = Math.sin(2 * t);
  return mmul(translate(a[0], a[1]), mmul([c, s, s, -c, 0, 0], translate(-a[0], -a[1])));
}

export interface TransformOptions {
  /**
   * MIRRTEXT: when false (default, like AutoCAD's MIRRTEXT = 0) reflected texts and attributes stay readable and keep
   * their mirrored position by flipping the justification; when true they are reflected exactly (backwards text).
   */
  mirrText?: boolean;
  /** Style / pattern lookups (exact width factors and pattern hatches). */
  ctx?: AffineContext;
}

/** Rotation angle and uniform scale of the linear part of a (conformal) matrix. */
function decompose(m: Mat) { const s = Math.hypot(m[0], m[1]); return { s, alpha: Math.atan2(m[1], m[0]), mirror: det(m) < 0 }; }

function xText<T extends TextProps>(t: T, m: Mat, o: TransformOptions): T {
  const { s, alpha, mirror } = decompose(m);
  if (mirror) return o.mirrText ? affineText(t, m, o.ctx) : mirrorTextReadable(t, m);
  const r: T = { ...t, p: apply(m, t.p), h: t.h * s, rot: normAngle(t.rot + alpha) };
  if (t.p2) r.p2 = apply(m, t.p2);
  return r;
}

const DEG = 180 / Math.PI;
const deg360 = (d: number) => { const r = d % 360; return r < 0 ? r + 360 : r; };

function xHatch(x: HatchEnt, m: Mat, o: TransformOptions) {
  const { s, alpha, mirror } = decompose(m);
  const P = (p: Pt) => apply(m, p);
  x.loops = x.loops.map((l) => l.map(P));
  if (x.solid || /^solid$/i.test(x.pattern)) return;
  // a reflected pattern cannot be described by name/scale/angle: use explicit pattern lines when the pattern is known
  if (!x.lines?.length && mirror) {
    const l = o.ctx?.patternLines?.(x.pattern, x.scale ?? 1, x.angle ?? 0, x.origin ?? [0, 0]);
    if (l?.length) x.lines = l;
  }
  if (x.lines?.length) {
    x.lines = x.lines.map((l) => mapHatchLine(l, m));
    return;
  }
  // named pattern: angle is in degrees, the pattern origin travels with the hatch
  x.origin = P(x.origin ?? [0, 0]);
  if (s !== 1) x.scale = (x.scale ?? 1) * s;
  x.angle = deg360(mirror ? alpha * DEG - (x.angle ?? 0) : (x.angle ?? 0) + alpha * DEG);
}

/** Return a transformed copy of `e` (same id). Assumes `m` is conformal (rotation, uniform scale, reflection, translation). */
export function transformEntity<E extends Entity>(e: E, m: Mat, o: TransformOptions = {}): E {
  const P = (p: Pt) => apply(m, p);
  const { s, alpha, mirror } = decompose(m);
  const x = structuredClone(e) as Entity;
  switch (x.type) {
    case 'LINE': x.a = P(x.a); x.b = P(x.b); break;
    case 'POINT': x.p = P(x.p); break;
    case 'CIRCLE': x.c = P(x.c); x.r *= s; break;
    case 'ARC': {
      x.c = P(x.c); x.r *= s;
      if (!mirror) { x.a0 = normAngle(x.a0 + alpha); x.a1 = normAngle(x.a1 + alpha); }
      else {
        const sa = angleOf([0, 0], lin(m, [Math.cos(x.a0), Math.sin(x.a0)])), ea = angleOf([0, 0], lin(m, [Math.cos(x.a1), Math.sin(x.a1)]));
        x.a0 = normAngle(ea); x.a1 = normAngle(sa);
      }
      break;
    }
    case 'ELLIPSE': {
      x.c = P(x.c); x.major = lin(m, x.major);
      if (mirror) { const a0 = x.a0, a1 = x.a1; x.a0 = normAngle(-a1); x.a1 = normAngle(-a0); }
      break;
    }
    case 'LWPOLYLINE':
      x.pts = x.pts.map((v) => { const q = P([v[0], v[1]]); const r = [q[0], q[1]]; if (v[2]) r[2] = mirror ? -v[2] : v[2]; return r; });
      if (x.width) x.width *= s;
      break;
    case 'SPLINE':
      x.pts = x.pts.map(P);
      if (x.ctrl) x.ctrl = x.ctrl.map((c) => [...P([c[0], c[1]]), ...c.slice(2)]);
      if (x.fit) x.fit = x.fit.map((c) => P([c[0], c[1]]));
      break;
    case 'SOLID': x.pts = x.pts.map(P); break;
    case 'WIPEOUT': x.loop = x.loop.map(P); break;
    case 'HATCH': xHatch(x, m, o); break;
    case 'TEXT': case 'ATTDEF': case 'ATTRIB': return xText(x, m, o) as unknown as E;
    case 'MTEXT': {
      x.p = P(x.p); x.h *= s; if (x.width) x.width *= s;
      if (!mirror) x.rot = normAngle(x.rot + alpha);
      else {
        // MTEXT cannot be written backwards: keep it readable and flip the attachment point
        const r = angleOf([0, 0], lin(m, [Math.cos(x.rot), Math.sin(x.rot)]));
        const reverse = normAngle(r + Math.PI), keep = normAngle(r);
        const useReverse = Math.abs(readableAngle(reverse) - reverse) < 1e-9;
        const at = (x.attach || 1) - 1; let row = Math.floor(at / 3), col = at % 3;
        if (useReverse) col = 2 - col; else row = 2 - row;
        x.attach = row * 3 + col + 1;
        x.rot = useReverse ? reverse : keep;
      }
      break;
    }
    case 'INSERT': {
      x.p = P(x.p);
      if (!mirror) { x.rot = normAngle(x.rot + alpha); x.sx *= s; x.sy *= s; }
      else { x.rot = normAngle(alpha - x.rot); x.sx *= s; x.sy *= -s; }
      if (x.colSpacing) x.colSpacing *= s;
      if (x.rowSpacing) x.rowSpacing *= mirror ? -s : s;
      if (x.attribs) x.attribs = x.attribs.map((a) => xText(a, m, o));
      break;
    }
    case 'DIMENSION': {
      if (x.block) { x.xform = x.xform ? mmul(m, x.xform) : [...m]; }
      if (x.p1) x.p1 = P(x.p1);
      if (x.p2) x.p2 = P(x.p2);
      if (x.loc) x.loc = P(x.loc);
      if (x.textPoint) x.textPoint = P(x.textPoint);
      if (x.rot !== undefined) x.rot = mirror ? normAngle(angleOf([0, 0], lin(m, [Math.cos(x.rot), Math.sin(x.rot)]))) : normAngle(x.rot + alpha);
      break;
    }
  }
  return x as E;
}
