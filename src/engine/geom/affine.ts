/**
 * General affine transformation of entities (non-uniform scale, shear, reflection), plus the exact text-frame maths
 * shared with MIRROR. Used by EXPLODE of non-uniformly scaled or mirrored blocks so the exploded geometry is identical
 * to what the renderer draws for the insert:
 * - circles and arcs become ellipses / elliptical arcs, ellipses are re-axed;
 * - bulge polylines split into lines and elliptical arcs;
 * - texts get a new height, width factor, oblique angle and backward flag;
 * - nested inserts stay inserts when the composite matrix has no shear and are expanded otherwise;
 * - pattern hatches transform their pattern lines exactly.
 */
import type { BlockDef, Entity, HatchLine, InsertEnt, Layer, MTextEnt, NewEntity, Pt, TextProps, TextStyle } from '../types';
import { IDENTITY, apply, det, insertMatrix, isConformal, mmul, type Mat } from './matrix';
import { bulgeToPrim } from './prims';
import { TAU, ccwSweep, normAngle } from './vec';
import { readableAngle } from '../model/dimension';

export interface AffineContext {
  getBlock?(name: string): BlockDef | undefined;
  getStyle?(name: string): TextStyle | undefined;
  getLayer?(name: string): Layer | undefined;
  /** Pattern lines of a named hatch pattern (scale, angle in degrees, origin) so pattern hatches transform exactly. */
  patternLines?(name: string, scale: number, angleDeg: number, origin: Pt): HatchLine[] | undefined;
  /**
   * MTEXT as one TEXT per laid-out line. When given, MTEXT under a non-conformal or reflecting map becomes TEXT
   * lines (which can be stretched, obliqued and written backwards) so the result looks exactly like the mapped MTEXT.
   */
  mtextLines?(t: Omit<MTextEnt, 'id'> & { id?: number }): NewEntity[];
}

export const lin = (m: Mat, v: Pt): Pt => [m[0] * v[0] + m[2] * v[1], m[1] * v[0] + m[3] * v[1]];
const ang = (v: Pt) => Math.atan2(v[1], v[0]);
const crs = (a: Pt, b: Pt) => a[0] * b[1] - a[1] * b[0];
const dt = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];
const hyp = (v: Pt) => Math.hypot(v[0], v[1]);
const comb = (u: Pt, cu: number, v: Pt, cv: number): Pt => [u[0] * cu + v[0] * cv, u[1] * cu + v[1] * cv];
const DEG = 180 / Math.PI;
const deg360 = (d: number) => { const r = d % 360; return r < 0 ? r + 360 : r; };
const strip = <T extends { id?: number }>(e: T): T => { const o = { ...e }; delete o.id; return o; };

// ---------------------------------------------------------------- text frames
export interface TextFrame { rot: number; mirrored: boolean; hScale: number; wfScale: number; tanOblique: number }
/**
 * Exact image of a text frame under the linear part of `m`. The frame maps glyph x to R(rot)·[mir, 0] and glyph y to
 * R(rot)·[mir·tan(oblique), 1] (see render/text.ts textMatrix). Returns the new rotation, backward flag, height and
 * width-factor multipliers and the new tan(oblique).
 */
export function textFrameImage(rot: number, mirrored: boolean, tanObl: number, m: Mat): TextFrame {
  const mir = mirrored ? -1 : 1;
  const c = Math.cos(rot), s = Math.sin(rot);
  const a = lin(m, [c * mir, s * mir]);
  const b = lin(m, [c * mir * tanObl - s, s * mir * tanObl + c]);
  const la = hyp(a) || 1e-300;
  const ua: Pt = [a[0] / la, a[1] / la];
  const cr = crs(a, b);
  const back = cr < 0;
  const hy = Math.abs(cr) / la || 1e-300;
  return { rot: normAngle(ang(back ? [-ua[0], -ua[1]] : ua)), mirrored: back, hScale: hy, wfScale: la / hy, tanOblique: dt(b, ua) / hy };
}

const effWidth = (t: TextProps, st?: TextStyle) => t.widthFactor || st?.widthFactor || 1;
const effOblique = (t: TextProps, st?: TextStyle) => t.oblique ?? st?.oblique ?? 0;

/** Exact affine image of a single-line text (TEXT / ATTDEF / ATTRIB, or an attribute of an insert). */
export function affineText<T extends TextProps>(t: T, m: Mat, ctx: AffineContext = {}): T {
  const st = ctx.getStyle?.(t.style);
  const wf = effWidth(t, st), obl = effOblique(t, st);
  const f = textFrameImage(t.rot, !!t.mirrored, Math.tan(obl), m);
  const o = { ...t, p: apply(m, t.p), h: t.h * f.hScale, rot: f.rot } as T;
  if (t.p2) o.p2 = apply(m, t.p2);
  if ((t.halign === 3 || t.halign === 5) && t.p2 && f.mirrored !== !!t.mirrored) { const q = o.p; o.p = o.p2!; o.p2 = q; }
  if (f.mirrored) o.mirrored = true; else delete o.mirrored;
  const nwf = wf * f.wfScale;
  if (t.widthFactor || Math.abs(nwf - wf) > 1e-9 * wf) o.widthFactor = nwf;
  const nob = Math.atan(f.tanOblique);
  if (t.oblique !== undefined || Math.abs(nob - obl) > 1e-9) o.oblique = nob;
  return o;
}

const H_FLIP: Record<number, number> = { 0: 2, 2: 0 };
const V_FLIP: Record<number, number> = { 0: 3, 1: 3, 3: 0 };
/**
 * Image of a text under a reflection with MIRRTEXT = 0: the text keeps reading forwards and upright. Its box lands where
 * the mirrored box would be, by flipping the horizontal justification (left ↔ right) when the baseline is reversed, or
 * the vertical one (baseline/bottom ↔ top) when the text would otherwise be upside down.
 */
export function mirrorTextReadable<T extends TextProps>(t: T, m: Mat): T {
  const f = textFrameImage(t.rot, !!t.mirrored, 0, m);
  const s = f.hScale;
  const ha = t.halign ?? 0, va = t.valign ?? 0;
  // keep baseline (flip "up") → rotation f.rot + π ; reverse baseline (keep "up") → f.rot
  const keepBaseline = normAngle(f.rot + Math.PI), reverse = f.rot;
  const useReverse = Math.abs(readableAngle(reverse) - reverse) < 1e-9 || Math.abs(readableAngle(keepBaseline) - keepBaseline) > 1e-9;
  const o = { ...t, h: t.h * s, rot: normAngle(useReverse ? reverse : keepBaseline) } as T;
  if (ha === 3 || ha === 5) { // aligned / fit: defined by the baseline points
    const p = apply(m, t.p), p2 = t.p2 ? apply(m, t.p2) : p;
    if (useReverse) { o.p = p2; o.p2 = p; } else { o.p = p; o.p2 = p2; }
    return o;
  }
  const anchor = apply(m, ha || va ? t.p2 ?? t.p : t.p);
  let nha = ha, nva = va;
  if (useReverse) nha = H_FLIP[ha] ?? ha; else if (ha !== 4) nva = V_FLIP[va] ?? va;
  if (nha) o.halign = nha; else delete o.halign;
  if (nva) o.valign = nva; else delete o.valign;
  o.p = anchor;
  if (nha || nva || t.p2) o.p2 = anchor;
  return o;
}

/** MTEXT under a linear map: MTEXT has no backward flag, so a reflection keeps it readable (attachment flipped). */
export function affineMText(t: MTextEnt | DistMText, m: Mat): typeof t {
  const f = textFrameImage(t.rot, false, 0, m);
  const o = { ...t, p: apply(m, t.p), h: t.h * f.hScale };
  const la = f.hScale * f.wfScale;
  if (t.width) o.width = t.width * la;
  if (!f.mirrored) { o.rot = f.rot; return o; }
  const keepBaseline = normAngle(f.rot + Math.PI), reverse = f.rot;
  const useReverse = Math.abs(readableAngle(reverse) - reverse) < 1e-9;
  const at = (t.attach || 1) - 1;
  let row = Math.floor(at / 3), col = at % 3;
  if (useReverse) col = 2 - col; else row = 2 - row;
  o.attach = row * 3 + col + 1;
  o.rot = useReverse ? reverse : keepBaseline;
  return o;
}
type DistMText = Omit<MTextEnt, 'id'> & { id?: number };

// ---------------------------------------------------------------- ellipses
type Props = Record<string, unknown>;
/** Elliptical arc traced by c + u·cos t + v·sin t, t from t0 to t1 counter-clockwise in t (full when `full`). */
export function ellipseFromConjugate(props: Props, c: Pt, u: Pt, v: Pt, t0: number, t1: number, full: boolean): NewEntity {
  const uu = dt(u, u), vv = dt(v, v), uv = dt(u, v);
  const th = Math.abs(2 * uv) < 1e-15 * (uu + vv) && Math.abs(uu - vv) < 1e-15 * (uu + vv) ? 0 : 0.5 * Math.atan2(2 * uv, uu - vv);
  let M = comb(u, Math.cos(th), v, Math.sin(th));
  let N = comb(u, -Math.sin(th), v, Math.cos(th));
  let shift = th;
  if (hyp(N) > hyp(M) * (1 + 1e-12)) { const M2 = N; N = [-M[0], -M[1]]; M = M2; shift = th + Math.PI / 2; }
  const sigma = crs(M, N) >= 0 ? 1 : -1;
  const ratio = Math.min(1, hyp(N) / (hyp(M) || 1e-300));
  let a0 = 0, a1 = TAU;
  if (!full) {
    if (sigma > 0) { a0 = normAngle(t0 - shift); a1 = normAngle(t1 - shift); }
    else { a0 = normAngle(-(t1 - shift)); a1 = normAngle(-(t0 - shift)); }
  }
  const o = { ...props, type: 'ELLIPSE', c, major: M, ratio, a0, a1 } as Props;
  delete o.r; delete o.id;
  return o as unknown as NewEntity;
}

// ---------------------------------------------------------------- inserts
/** Insert parameters of `m · insertMatrix(ins)`, or null when the composite matrix has a shear (not representable). */
export function composeInsert(ins: Pick<InsertEnt, 'p' | 'sx' | 'sy' | 'rot' | 'name'>, m: Mat, base: Pt): { p: Pt; sx: number; sy: number; rot: number } | null {
  const im = mmul(m, insertMatrix(ins.p, ins.sx, ins.sy, ins.rot, base));
  const sx = Math.hypot(im[0], im[1]);
  if (sx < 1e-300) return null;
  const th = Math.atan2(im[1], im[0]);
  const c = Math.cos(th), s = Math.sin(th);
  const k = c * im[2] + s * im[3], sy = -s * im[2] + c * im[3];
  if (Math.abs(k) > 1e-9 * Math.max(sx, Math.abs(sy))) return null;
  return { p: apply(m, ins.p), sx, sy, rot: normAngle(th) };
}

/** Inherit layer-0 / ByBlock properties of the parent insert (keeps the exploded look identical to the block). */
export function inheritFrom<T extends Props>(child: T, parent: { layer: string; color?: number; trueColor?: string; linetype?: string; lineweight?: number }, ctx: AffineContext = {}): T {
  const o = child as Props;
  const pl = parent.layer || '0';
  if (!o.layer || o.layer === '0') o.layer = pl;
  const layerColor = () => ctx.getLayer?.(pl)?.color;
  if (o.color === 0) {
    if (parent.color === undefined || parent.color === 256) { if (o.layer === pl) delete o.color; else { const lc = layerColor(); if (lc !== undefined) o.color = Math.abs(lc); else delete o.color; } }
    else o.color = parent.color;
    if (parent.trueColor) o.trueColor = parent.trueColor;
  }
  if (typeof o.linetype === 'string' && o.linetype.toUpperCase() === 'BYBLOCK') {
    if (parent.linetype && parent.linetype.toUpperCase() !== 'BYLAYER') o.linetype = parent.linetype;
    else if (o.layer === pl) delete o.linetype;
    else { const lt = ctx.getLayer?.(pl)?.linetype; if (lt) o.linetype = lt; else delete o.linetype; }
  }
  if (o.lineweight === -2) { if (parent.lineweight !== undefined && parent.lineweight !== -1) o.lineweight = parent.lineweight; else if (o.layer === pl) delete o.lineweight; else { const lw = ctx.getLayer?.(pl)?.lineweight; if (lw !== undefined) o.lineweight = lw; else delete o.lineweight; } }
  return child;
}

/** Fully expand an insert (all array copies, recursively for sheared nested inserts) under `m`. */
export function expandInsert(ins: Omit<InsertEnt, 'id'> & { id?: number }, m: Mat, ctx: AffineContext, depth = 0): NewEntity[] {
  const def = ctx.getBlock?.(ins.name);
  const out: NewEntity[] = [];
  if (def && depth < 24) {
    const cols = Math.max(1, ins.cols ?? 1), rows = Math.max(1, ins.rows ?? 1);
    for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
      const im = mmul(m, insertMatrix(ins.p, ins.sx, ins.sy, ins.rot, def.base, i * (ins.colSpacing ?? 0), j * (ins.rowSpacing ?? 0)));
      for (const ch of def.entities) {
        if (ch.type === 'ATTDEF') continue;
        for (const part of affineEntity(ch, im, ctx, depth + 1)) out.push(inheritFrom(part as unknown as Props, ins, ctx) as unknown as NewEntity);
      }
    }
  }
  for (const a of ins.attribs ?? []) {
    if (a.invisible || !a.text) continue;
    const t = affineText({ ...a, layer: a.layer ?? ins.layer } as TextProps & { layer: string }, m, ctx);
    out.push(inheritFrom({ ...t, type: 'TEXT' } as unknown as Props, ins, ctx) as unknown as NewEntity);
  }
  return out;
}

/**
 * Image of a hatch line family. Under a reflection the line direction is reversed (and the dash sequence with it) so
 * the family's normal keeps pointing to the same side of the mapped boundary: lines lying exactly on a boundary edge
 * are then clipped the same way as in the original.
 */
export function mapHatchLine(l: HatchLine, m: Mat): HatchLine {
  let nd = lin(m, [Math.cos(l.angle), Math.sin(l.angle)]);
  const k = hyp(nd);
  const flip = m[0] * m[3] - m[1] * m[2] < 0;
  if (flip) nd = [-nd[0], -nd[1]];
  const dashes = l.dashes.map((d) => d * k);
  if (flip) dashes.reverse();
  return { angle: normAngle(ang(nd)), base: apply(m, l.base), offset: lin(m, l.offset), dashes };
}

// ---------------------------------------------------------------- entities
/**
 * Affine image of an entity. Returns one entity in general; a bulge polyline under a non-conformal map returns its
 * pieces, and a nested insert whose composite matrix has a shear returns its expanded content.
 */
export function affineEntity(e: Entity | NewEntity, m: Mat, ctx: AffineContext = {}, depth = 0): NewEntity[] {
  const P = (p: Pt) => apply(m, p);
  const x = strip(structuredClone(e) as NewEntity & { id?: number }) as NewEntity;
  const conformal = isConformal(m);
  const sDet = Math.sqrt(Math.abs(det(m)));
  switch (x.type) {
    case 'LINE': x.a = P(x.a); x.b = P(x.b); return [x];
    case 'POINT': x.p = P(x.p); return [x];
    case 'CIRCLE':
      if (conformal) { x.c = P(x.c); x.r *= sDet; return [x]; }
      return [ellipseFromConjugate(x as unknown as Props, P(x.c), lin(m, [x.r, 0]), lin(m, [0, x.r]), 0, TAU, true)];
    case 'ARC': {
      const sw = ccwSweep(x.a0, x.a1);
      if (conformal && det(m) > 0) { const a = Math.atan2(m[1], m[0]); x.c = P(x.c); x.r *= sDet; x.a0 = normAngle(x.a0 + a); x.a1 = normAngle(x.a1 + a); return [x]; }
      if (conformal) { // reflection: arc stays an arc, direction reverses
        const s0 = ang(lin(m, [Math.cos(x.a0), Math.sin(x.a0)])), s1 = ang(lin(m, [Math.cos(x.a1), Math.sin(x.a1)]));
        x.c = P(x.c); x.r *= sDet; x.a0 = normAngle(s1); x.a1 = normAngle(s0); return [x];
      }
      return [ellipseFromConjugate(x as unknown as Props, P(x.c), lin(m, [x.r, 0]), lin(m, [0, x.r]), x.a0, x.a0 + sw, false)];
    }
    case 'ELLIPSE': {
      let sw = x.a1 - x.a0; while (sw <= 1e-12) sw += TAU;
      const full = Math.abs(sw - TAU) < 1e-9 || sw > TAU;
      const minor: Pt = [-x.major[1] * x.ratio, x.major[0] * x.ratio];
      return [ellipseFromConjugate(x as unknown as Props, P(x.c), lin(m, x.major), lin(m, minor), x.a0, x.a0 + sw, full)];
    }
    case 'LWPOLYLINE': {
      const flip = det(m) < 0;
      const hasBulge = x.pts.some((v) => v[2]);
      if (conformal || !hasBulge) {
        x.pts = x.pts.map((v) => { const q = P([v[0], v[1]]); const o = [q[0], q[1]]; if (v[2]) o[2] = flip ? -v[2] : v[2]; return o; });
        if (x.width) x.width *= sDet;
        return [x];
      }
      const out: NewEntity[] = [];
      const base: Props = { layer: x.layer };
      for (const k of ['color', 'trueColor', 'linetype', 'ltScale', 'lineweight'] as const) if (x[k] !== undefined) base[k] = x[k];
      const n = x.pts.length;
      for (let i = 0; i < (x.closed ? n : n - 1); i++) {
        const a = x.pts[i], b = x.pts[(i + 1) % n];
        const q = bulgeToPrim([a[0], a[1]], [b[0], b[1]], a[2] ?? 0);
        if (q.k === 'seg') out.push({ ...base, type: 'LINE', a: P(q.a), b: P(q.b) } as unknown as NewEntity);
        else out.push(...affineEntity({ ...base, type: 'ARC', c: q.c, r: q.r, a0: q.a0, a1: q.a1 } as unknown as NewEntity, m, ctx, depth));
      }
      return out;
    }
    case 'SPLINE':
      x.pts = x.pts.map(P);
      if (x.ctrl) x.ctrl = x.ctrl.map((c) => [...P([c[0], c[1]]), ...c.slice(2)]);
      if (x.fit) x.fit = x.fit.map((c) => P([c[0], c[1]]));
      return [x];
    case 'SOLID': x.pts = x.pts.map(P); return [x];
    case 'WIPEOUT': x.loop = x.loop.map(P); return [x];
    case 'TEXT': case 'ATTDEF': case 'ATTRIB': return [affineText(x, m, ctx)];
    case 'MTEXT': {
      if (ctx.mtextLines && (!conformal || m[0] * m[3] - m[1] * m[2] < 0)) {
        const lines = ctx.mtextLines(x);
        if (lines.length) return lines.map((l) => affineText(l as unknown as TextProps & NewEntity, m, ctx) as unknown as NewEntity);
      }
      return [affineMText(x, m) as NewEntity];
    }
    case 'INSERT': {
      const def = ctx.getBlock?.(x.name);
      const r = composeInsert(x, m, def?.base ?? [0, 0]);
      if (!r) return def ? expandInsert(x, m, ctx, depth) : [];
      const fx = r.sx / (x.sx || 1), fy = r.sy / (x.sy || 1);
      x.p = r.p; x.sx = r.sx; x.sy = r.sy; x.rot = r.rot;
      if (x.colSpacing) x.colSpacing *= fx;
      if (x.rowSpacing) x.rowSpacing *= fy;
      if (x.attribs) x.attribs = x.attribs.map((a) => affineText(a, m, ctx));
      return [x];
    }
    case 'DIMENSION': {
      if (x.block) x.xform = mmul(m, x.xform ?? IDENTITY);
      if (x.p1) x.p1 = P(x.p1);
      if (x.p2) x.p2 = P(x.p2);
      if (x.loc) x.loc = P(x.loc);
      if (x.textPoint) x.textPoint = P(x.textPoint);
      if (x.rot !== undefined) x.rot = normAngle(ang(lin(m, [Math.cos(x.rot), Math.sin(x.rot)])));
      return [x];
    }
    case 'HATCH': {
      x.loops = x.loops.map((l) => l.map(P));
      if (x.solid || /^solid$/i.test(x.pattern)) return [x];
      const lines = x.lines?.length ? x.lines : ctx.patternLines?.(x.pattern, x.scale ?? 1, x.angle ?? 0, x.origin ?? [0, 0]);
      if (lines?.length) {
        x.lines = lines.map((l) => mapHatchLine(l, m));
        return [x];
      }
      // pattern unknown here: approximate with uniform scale and the rotated pattern direction
      x.origin = P(x.origin ?? [0, 0]);
      if (x.scale !== undefined || sDet !== 1) x.scale = (x.scale ?? 1) * sDet;
      const a = ((x.angle ?? 0) / DEG);
      x.angle = deg360(ang(lin(m, [Math.cos(a), Math.sin(a)])) * DEG);
      return [x];
    }
  }
  return [x];
}
