/**
 * Text layout with SHX stroke fonts: TEXT alignment semantics (DXF 72/73), %% control codes, and MTEXT parsing/wrapping.
 * Output is stroke polylines in a local frame plus a local->world matrix, so the same data serves rendering, picking,
 * extents and exports. Characters missing from every bundled font are reported so the renderer can fall back to a
 * browser font for the whole string (e.g. Arabic text).
 */
import type { Pt, TextProps, TextStyle } from '../types';
import type { Mat } from '../geom/matrix';
import { mmul, rotateM, scaleM, translate } from '../geom/matrix';
import { angleOf, dist } from '../geom/vec';
import { DEFAULT_MAIN, isTrueTypeFont, resolveBigFont, resolveMainFont, type FontJson, type FontProvider } from './fonts';

export interface ResolvedFonts { main?: FontJson; big?: FontJson; extra?: FontJson; trueType?: string; widthFactor: number; oblique: number }

export function resolveFonts(style: TextStyle | undefined, fonts: FontProvider | undefined): ResolvedFonts {
  const wf = style?.widthFactor || 1, ob = style?.oblique || 0;
  if (!fonts) return { widthFactor: wf, oblique: ob };
  const av = fonts.available();
  const fontFile = style?.font ?? 'txt';
  if (isTrueTypeFont(fontFile)) return { trueType: fontFile.replace(/\.(ttf|ttc|otf)$/i, ''), widthFactor: wf, oblique: ob };
  const mainKey = resolveMainFont(fontFile, av) ?? DEFAULT_MAIN;
  const bigKey = resolveBigFont(style?.bigFont ?? '', av);
  return { main: fonts.get(mainKey), big: fonts.get(bigKey), extra: mainKey === DEFAULT_MAIN ? undefined : fonts.get(DEFAULT_MAIN), widthFactor: wf, oblique: ob };
}

/** Replace %% control codes. */
export function decodeControlCodes(s: string): string {
  return s
    .replace(/%%(\d{3})/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±').replace(/%%[cC]/g, '⌀')
    .replace(/%%[uUoOkK]/g, '').replace(/%%%/g, '%');
}

export interface LineLayout { strokes: number[][]; width: number; missing: boolean; text: string }

/** Lay out one line of text at height h with baseline at y=0, starting at x=0 (local units). */
export function layoutLine(raw: string, h: number, f: ResolvedFonts): LineLayout {
  const text = decodeControlCodes(raw);
  const strokes: number[][] = [];
  let x = 0, missing = false;
  const wf = f.widthFactor;
  if (f.trueType || (!f.main && !f.big)) {
    // no SHX available (TrueType style or fonts not loaded yet): estimate width only
    for (const ch of text) x += (ch.charCodeAt(0) < 128 ? 0.7 : 1) * h * wf;
    return { strokes, width: x, missing: true, text };
  }
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const order = code < 128 ? [f.main, f.big, f.extra] : [f.big, f.main, f.extra];
    let font: FontJson | undefined, g;
    for (const cand of order) { if (cand && (g = cand.glyphs[ch])) { font = cand; break; } }
    if (!g || !font) {
      if (ch === ' ') { x += 0.6 * h * wf; continue; }
      missing = true; x += (code < 128 ? 0.7 : 1) * h * wf; continue;
    }
    const s = h / (font.above || 1);
    const sx = s * wf;
    for (const p of g.p) {
      const out = new Array<number>(p.length);
      for (let i = 0; i < p.length; i += 2) { out[i] = x + p[i] * sx; out[i + 1] = p[i + 1] * s; }
      strokes.push(out);
    }
    x += g.w * sx;
  }
  return { strokes, width: x, missing, text };
}

/** Local->world matrix for a TEXT entity given its laid-out width. */
export function textMatrix(t: TextProps, width: number, f: ResolvedFonts, font?: FontJson): { m: Mat; h: number } {
  const ha = t.halign ?? 0, va = t.valign ?? 0;
  let h = t.h, rot = t.rot, anchor: Pt = t.p, sx = 1;
  if ((ha === 3 || ha === 5) && t.p2 && dist(t.p, t.p2) > 1e-9 && width > 0) {
    rot = angleOf(t.p, t.p2);
    const k = dist(t.p, t.p2) / width;
    if (ha === 3) h = t.h * k; // aligned: uniform
    sx = ha === 5 ? k : 1;
    const scale = ha === 3 ? k : 1;
    // backwards aligned/fit text runs from p2 back to p, glyphs mirrored (exact image of a reflected text)
    const anchorA = t.mirrored ? t.p2 : t.p, mx = t.mirrored ? -1 : 1;
    const m = mmul(translate(anchorA[0], anchorA[1]), mmul(rotateM(rot), mmul(scaleM(mx * sx * (ha === 3 ? scale : 1), ha === 3 ? scale : 1), shear(f.oblique))));
    return { m, h };
  }
  if (ha || va) anchor = t.p2 ?? t.p;
  let ox = 0, oy = 0;
  if (ha === 1 || ha === 4) ox = -width / 2; else if (ha === 2) ox = -width;
  const below = font ? (font.below / (font.above || 1)) * h : 0.2 * h;
  if (ha === 4) oy = -h / 2;
  else if (va === 1) oy = below; else if (va === 2) oy = -h / 2; else if (va === 3) oy = -h;
  const mir = t.mirrored ? -1 : 1;
  const m = mmul(translate(anchor[0], anchor[1]), mmul(rotateM(rot), mmul(scaleM(mir, 1), mmul(translate(ox, oy), shear(f.oblique)))));
  return { m, h };
}
const shear = (obliqueRad: number): Mat => (obliqueRad ? [1, 0, Math.tan(obliqueRad), 1, 0, 0] : [1, 0, 0, 1, 0, 0]);

// ---------------- MTEXT ----------------
/** Convert raw MTEXT (with formatting codes) to plain paragraphs. */
export function mtextToPlain(raw: string): string[] {
  let s = raw;
  s = s.replace(/\\\\/g, '\u0001').replace(/\\\{/g, '\u0002').replace(/\\\}/g, '\u0003');
  s = s.replace(/\\S([^;]*?)[#^/]([^;]*?);/g, '$1/$2');
  s = s.replace(/\\[ACcFfHhQqTtWwp][^;\\]*;/g, '');
  s = s.replace(/\\[LlOoKkNn]/g, '');
  s = s.replace(/\\~/g, '\u00a0');
  s = s.replace(/[{}]/g, '');
  s = s.replace(/\\P|\n/g, '\u0004');
  s = s.replace(/\u0001/g, '\\').replace(/\u0002/g, '{').replace(/\u0003/g, '}');
  return s.split('\u0004');
}
export interface MTextLayout { lines: LineLayout[]; width: number; height: number; lineHeight: number }
/** Lay out paragraphs with optional word wrap at `wrapWidth` (local units). */
export function layoutMText(raw: string, h: number, f: ResolvedFonts, wrapWidth = 0, lineSpacing = 1): MTextLayout {
  const paras = mtextToPlain(raw);
  const lines: LineLayout[] = [];
  for (const para of paras) {
    if (!(wrapWidth > 0)) { lines.push(layoutLine(para, h, f)); continue; }
    // wrap by spaces; CJK text (no spaces) wraps per character
    const tokens = /\s/.test(para) ? para.split(/(\s+)/) : [...para];
    let cur = '';
    for (const tok of tokens) {
      const trial = cur + tok;
      if (cur && layoutLine(trial.trimEnd(), h, f).width > wrapWidth) { lines.push(layoutLine(cur.trimEnd(), h, f)); cur = tok.trimStart(); }
      else cur = trial;
    }
    lines.push(layoutLine(cur.trimEnd(), h, f));
  }
  const lineHeight = h * (5 / 3) * (lineSpacing || 1);
  const width = Math.max(0, ...lines.map((l) => l.width));
  return { lines, width, height: h + lineHeight * Math.max(0, lines.length - 1), lineHeight };
}
/** Offsets (local) of each MTEXT line's baseline for attachment point 1..9. */
export function mtextLineOrigins(lay: MTextLayout, attach: number, h: number, boxWidth?: number): Pt[] {
  const col = (attach - 1) % 3, row = Math.floor((attach - 1) / 3);
  const W = boxWidth && boxWidth > 0 ? boxWidth : lay.width;
  const top = row === 0 ? 0 : row === 1 ? lay.height / 2 : lay.height;
  return lay.lines.map((l, i) => {
    const y = top - h - i * lay.lineHeight;
    const xBox = col === 0 ? 0 : col === 1 ? -W / 2 : -W;
    const x = xBox + (col === 0 ? 0 : col === 1 ? (W - l.width) / 2 : W - l.width);
    return [x, y];
  });
}
