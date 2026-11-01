/**
 * Entity -> draw items (world coordinates). This is the single geometry pipeline shared by the canvas renderer,
 * picking, crossing selection, SVG export and thumbnails. Handles ByLayer/ByBlock colours and linetypes, layer-0
 * inheritance inside blocks, linetype dashes (incl. text/shape elements), hatch patterns, SHX text, MTEXT,
 * dimensions and nested inserts with arbitrary (non-uniform / mirrored) transforms.
 */
import type { CadDocument } from '../model/document';
import type { Entity, Layer, Pt, TextEnt, MTextEnt, TextProps } from '../types';
import { apply, insertMatrix, IDENTITY, mmul, rotateM, scaleM, scaleOf, translate, type Mat } from '../geom/matrix';
import { TAU } from '../geom/vec';
import { polylinePoints } from '../geom/extents';
import { aciToHex } from '../../util/aci';
import { applyLinetype, type GlyphPlacement, type LinetypeLibrary } from './linetypes';
import { hatchSegments, patternToLines, type PatternLibrary } from './hatch';
import type { FontProvider } from './fonts';
import { layoutLine, layoutMText, mtextLineOrigins, resolveFonts, textMatrix } from './text';
import { dimensionGeometry } from '../model/dimension';

export interface StrokeItem { kind: 'stroke'; color: string; paths: number[][]; closed?: boolean[]; /** world line width (polyline width) */ width?: number; lw?: number }
export interface FillItem { kind: 'fill'; color: string; loops: number[][]; wipeout?: boolean }
export interface TextItem { kind: 'text'; color: string; text: string; m: Mat; h: number; family: string }
export type DrawItem = StrokeItem | FillItem | TextItem;

export interface TessContext {
  doc: CadDocument;
  fonts?: FontProvider;
  linetypes?: LinetypeLibrary;
  patterns?: PatternLibrary;
  /** Colour used for ACI 7 / white (theme foreground). */
  fg: string;
  bg: string;
  /** Segments per full circle. */
  circleSegs?: number;
  /** Draw ATTDEF tags (true when viewing a block definition / model space ATTDEFs). */
  showAttdefs?: boolean;
}

interface Inherit { color: string; linetype?: string; layer0?: Layer; lw?: number }

export function tessellate(e: Entity, tc: TessContext): DrawItem[] {
  const out: DrawItem[] = [];
  tess(e, IDENTITY, { color: tc.fg }, tc, out, 0, true);
  return out;
}

function layerFor(e: { layer: string }, inh: Inherit, tc: TessContext): Layer | undefined {
  if (inh.layer0 && (e.layer === '0' || e.layer === '')) return inh.layer0;
  return tc.doc.getLayer(e.layer);
}
function aci(c: number, tc: TessContext) { const a = Math.abs(c); return a === 7 ? tc.fg : aciToHex(a, tc.fg); }
export function resolveColor(e: { layer: string; color?: number; trueColor?: string }, inh: Inherit, tc: TessContext): string {
  if (e.trueColor) return e.trueColor;
  const c = e.color ?? 256;
  if (c === 0) return inh.color;
  if (c === 256) {
    const l = layerFor(e, inh, tc);
    if (!l) return tc.fg;
    if (l.trueColor) return l.trueColor;
    return aci(l.color, tc);
  }
  return aci(c, tc);
}
function resolveLinetypeName(e: { layer: string; linetype?: string }, inh: Inherit, tc: TessContext): string | undefined {
  const n = e.linetype;
  if (!n || /^bylayer$/i.test(n)) return layerFor(e, inh, tc)?.linetype;
  if (/^byblock$/i.test(n)) return inh.linetype;
  return n;
}

function segsFor(sweep: number, tc: TessContext) { return Math.max(4, Math.ceil((sweep / TAU) * (tc.circleSegs ?? 96))); }
function transformFlat(m: Mat, flat: number[]): number[] {
  const out = new Array<number>(flat.length);
  for (let i = 0; i < flat.length; i += 2) { const x = flat[i], y = flat[i + 1]; out[i] = m[0] * x + m[2] * y + m[4]; out[i + 1] = m[1] * x + m[3] * y + m[5]; }
  return out;
}
const flatOf = (pts: Pt[]) => { const f: number[] = []; for (const p of pts) f.push(p[0], p[1]); return f; };

function tess(e: Entity, m: Mat, inh: Inherit, tc: TessContext, out: DrawItem[], depth: number, top = false) {
  if (depth > 16) return;
  const layer = layerFor(e, inh, tc);
  if (layer && (layer.off || layer.frozen) && !top) return;
  const color = resolveColor(e, inh, tc);
  const lw = e.lineweight !== undefined && e.lineweight >= 0 ? e.lineweight : e.lineweight === -2 ? inh.lw : layer && layer.lineweight >= 0 ? layer.lineweight : undefined;

  const stroke = (flat: number[], closed = false, width?: number) => {
    if (flat.length < 2) return;
    const ltName = resolveLinetypeName(e, inh, tc);
    const lt = ltName && tc.linetypes ? tc.linetypes.resolve(ltName, tc.doc.getLinetype(ltName)) : null;
    if (lt) {
      const scale = (tc.doc.settings.ltscale || 1) * (e.ltScale ?? 1);
      const glyphs: GlyphPlacement[] = [];
      const dashes = applyLinetype(flat, closed, lt, scale, glyphs);
      if (dashes) {
        out.push({ kind: 'stroke', color, paths: dashes.map((d) => transformFlat(m, d)), width: width ? width * scaleOf(m) : undefined, lw });
        for (const g of glyphs) glyphStrokes(g, m, color, tc, out);
        return;
      }
    }
    out.push({ kind: 'stroke', color, paths: [transformFlat(m, flat)], closed: [closed], width: width ? width * scaleOf(m) : undefined, lw });
  };

  switch (e.type) {
    case 'LINE': stroke([e.a[0], e.a[1], e.b[0], e.b[1]]); break;
    case 'POINT': out.push({ kind: 'stroke', color, paths: [transformFlat(m, [e.p[0], e.p[1], e.p[0], e.p[1]])] }); break;
    case 'CIRCLE': {
      const n = segsFor(TAU, tc), f: number[] = [];
      for (let i = 0; i < n; i++) { const a = (i / n) * TAU; f.push(e.c[0] + e.r * Math.cos(a), e.c[1] + e.r * Math.sin(a)); }
      stroke(f, true);
      break;
    }
    case 'ARC': {
      let sw = e.a1 - e.a0; while (sw <= 0) sw += TAU;
      const n = segsFor(sw, tc), f: number[] = [];
      for (let i = 0; i <= n; i++) { const a = e.a0 + (sw * i) / n; f.push(e.c[0] + e.r * Math.cos(a), e.c[1] + e.r * Math.sin(a)); }
      stroke(f);
      break;
    }
    case 'ELLIPSE': {
      let sw = e.a1 - e.a0; while (sw <= 1e-12) sw += TAU;
      const full = Math.abs(sw - TAU) < 1e-9;
      const n = segsFor(sw, tc), f: number[] = [];
      const mn: Pt = [-e.major[1] * e.ratio, e.major[0] * e.ratio];
      for (let i = 0; i < (full ? n : n + 1); i++) { const t = e.a0 + (sw * i) / n; f.push(e.c[0] + e.major[0] * Math.cos(t) + mn[0] * Math.sin(t), e.c[1] + e.major[1] * Math.cos(t) + mn[1] * Math.sin(t)); }
      stroke(f, full);
      break;
    }
    case 'LWPOLYLINE': {
      const pts = polylinePoints(e.pts, e.closed, tc.circleSegs ?? 96);
      if (e.closed && pts.length > 1) pts.pop(); // closing vertex is implied by closed=true
      stroke(flatOf(pts), e.closed, e.width && e.width > 0 ? e.width : undefined);
      break;
    }
    case 'SPLINE': stroke(flatOf(e.pts), e.closed); break;
    case 'SOLID': {
      const p = e.pts;
      const quad = p.length >= 4 ? [p[0], p[1], p[3], p[2]] : p;
      out.push({ kind: 'fill', color, loops: [transformFlat(m, flatOf(quad))] });
      break;
    }
    case 'ATTDEF': if (!tc.showAttdefs && !top) break; // fallthrough when shown
    // eslint-disable-next-line no-fallthrough
    case 'TEXT': case 'ATTRIB': textItems(e, m, color, tc, out); break;
    case 'MTEXT': mtextItems(e, m, color, tc, out); break;
    case 'INSERT': {
      const def = tc.doc.getBlock(e.name);
      if (def) {
        const child: Inherit = { color, linetype: resolveLinetypeName(e, inh, tc), layer0: layer, lw };
        const cols = e.cols ?? 1, rows = e.rows ?? 1;
        for (let ci = 0; ci < cols; ci++) for (let ri = 0; ri < rows; ri++) {
          const im = mmul(m, insertMatrix(e.p, e.sx, e.sy, e.rot, def.base, ci * (e.colSpacing ?? 0), ri * (e.rowSpacing ?? 0)));
          for (const c of def.entities) if (c.type !== 'ATTDEF') tess(c, im, child, tc, out, depth + 1);
        }
      }
      for (const a of e.attribs ?? []) {
        if (a.invisible || !a.text) continue;
        const ae = { ...a, type: 'ATTRIB', layer: a.layer ?? e.layer, id: -1 } as TextEnt;
        tess(ae, m, { ...inh, color }, tc, out, depth + 1);
      }
      break;
    }
    case 'DIMENSION': {
      const child: Inherit = { color, linetype: resolveLinetypeName(e, inh, tc), layer0: layer, lw };
      const def = e.block ? tc.doc.getBlock(e.block) : undefined;
      if (def) { const dm = e.xform ? mmul(m, e.xform) : m; for (const c of def.entities) tess(c, dm, child, tc, out, depth + 1); }
      else for (const g of dimensionGeometry(e, tc.doc.settings, tc.doc.units)) tess({ ...g, id: -1 } as Entity, m, child, tc, out, depth + 1);
      break;
    }
    case 'HATCH': {
      const loops = e.loops.filter((l) => l.length >= 2);
      if (e.solid || /^solid$/i.test(e.pattern)) { out.push({ kind: 'fill', color, loops: loops.map((l) => transformFlat(m, flatOf(l))) }); break; }
      let lines = e.lines;
      if (!lines?.length && tc.patterns) {
        const p = tc.patterns.find(e.pattern);
        if (p) lines = patternToLines(p, e.scale ?? 1, ((e.angle ?? 0) * Math.PI) / 180, e.origin);
      }
      if (!lines?.length) { out.push({ kind: 'stroke', color, paths: loops.map((l) => transformFlat(m, flatOf(l))), closed: loops.map(() => true) }); break; }
      const { segs } = hatchSegments(loops, lines);
      out.push({ kind: 'stroke', color, paths: segs.map((s) => transformFlat(m, s)) });
      break;
    }
    case 'WIPEOUT': out.push({ kind: 'fill', color: tc.bg, loops: [transformFlat(m, flatOf(e.loop))], wipeout: true }); break;
  }
}

function textItems(t: TextProps & { layer: string }, m: Mat, color: string, tc: TessContext, out: DrawItem[]) {
  if (t.invisible || !t.text) return;
  const style = tc.doc.getStyle(t.style);
  const f = resolveFonts(style, tc.fonts);
  if (t.widthFactor) f.widthFactor = t.widthFactor;
  if (t.oblique !== undefined) f.oblique = t.oblique;
  const lay = layoutLine(t.text, t.h, f);
  const { m: tm } = textMatrix(t, lay.width, f, f.main);
  const full = mmul(m, tm);
  if (lay.missing) { out.push({ kind: 'text', color, text: lay.text, m: mmul(full, scaleM(f.widthFactor, 1)), h: t.h, family: f.trueType ?? 'sans-serif' }); return; }
  out.push({ kind: 'stroke', color, paths: lay.strokes.map((s) => transformFlat(full, s)) });
}
function mtextItems(t: MTextEnt, m: Mat, color: string, tc: TessContext, out: DrawItem[]) {
  if (!t.text) return;
  const style = tc.doc.getStyle(t.style);
  const f = resolveFonts(style, tc.fonts);
  const lay = layoutMText(t.text, t.h, f, t.width ?? 0, t.lineSpacing);
  const origins = mtextLineOrigins(lay, t.attach || 1, t.h, t.width);
  const base = mmul(m, mmul(translate(t.p[0], t.p[1]), rotateM(t.rot)));
  lay.lines.forEach((l, i) => {
    const lm = mmul(base, translate(origins[i][0], origins[i][1]));
    if (l.missing) out.push({ kind: 'text', color, text: l.text, m: mmul(lm, scaleM(f.widthFactor, 1)), h: t.h, family: f.trueType ?? 'sans-serif' });
    else if (l.strokes.length) out.push({ kind: 'stroke', color, paths: l.strokes.map((s) => transformFlat(lm, s)) });
  });
}
function glyphStrokes(g: GlyphPlacement, m: Mat, color: string, tc: TessContext, out: DrawItem[]) {
  if (!tc.fonts) return;
  const gm = mmul(m, mmul(translate(g.at[0], g.at[1]), rotateM(g.angle)));
  if (g.kind === 'text') {
    const f = resolveFonts(tc.doc.getStyle(g.style ?? 'STANDARD'), tc.fonts);
    const lay = layoutLine(g.value, g.size, f);
    if (!lay.missing) out.push({ kind: 'stroke', color, paths: lay.strokes.map((s) => transformFlat(gm, s)) });
    return;
  }
  const file = (g.file ?? 'yqshape').replace(/\.shx$/i, '').toUpperCase();
  const font = tc.fonts.get(file) ?? tc.fonts.get('YQSHAPE');
  const glyph = font?.glyphs[g.value] ?? font?.glyphs[g.value.toUpperCase()];
  if (!glyph) return;
  const k = g.size; // shapes are defined in shape units; S scales them directly
  const sm = mmul(gm, scaleM(k, k));
  out.push({ kind: 'stroke', color, paths: glyph.p.map((p) => transformFlat(sm, p)) });
}

/** Exact text bbox using the layout engine (installed as CadDocument.textBox). */
export function textBBox(e: TextEnt | MTextEnt, tc: TessContext): [number, number, number, number] | null {
  const items: DrawItem[] = [];
  if (e.type === 'MTEXT') mtextItems(e, IDENTITY, '#000', tc, items); else textItems({ ...e, invisible: false }, IDENTITY, '#000', tc, items);
  const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  const add = (x: number, y: number) => { if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y; };
  for (const it of items) {
    if (it.kind === 'stroke') for (const p of it.paths) for (let i = 0; i < p.length; i += 2) add(p[i], p[i + 1]);
    else if (it.kind === 'text') {
      const w = [...it.text].length * it.h * 0.8;
      for (const c of [[0, -0.25 * it.h], [w, -0.25 * it.h], [0, it.h], [w, it.h]] as Pt[]) { const q = apply(it.m, c); add(q[0], q[1]); }
    }
  }
  return b[0] <= b[2] ? b : null;
}
