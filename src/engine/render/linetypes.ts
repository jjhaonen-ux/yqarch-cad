/**
 * Linetypes: built-in ISO set (acadiso.lin values, mm), simple linetypes stored in drawings, and the complex
 * YQArch linetypes from assets/linetypes.json (with embedded text / shapes). `applyLinetype` turns a polyline into
 * dashes (and glyph placements) in the polyline's own coordinate frame.
 */
import type { LinetypeDef, Pt } from '../types';

export type LtElement =
  | { kind: 'dash'; length: number }
  | { kind: 'text'; text: string; style?: string; params: Record<string, number> }
  | { kind: 'shape'; shape: string; file?: string; params: Record<string, number> };
export interface ResolvedLinetype { name: string; elements: LtElement[]; length: number }
export interface ComplexLinetypeJson { name: string; description?: string; elements: LtElement[]; patternLength: number }

const iso = (name: string, description: string, pattern: number[]): LinetypeDef => ({ name, description, pattern, length: pattern.reduce((a, b) => a + Math.abs(b), 0) });
export const BUILTIN_LINETYPES: LinetypeDef[] = [
  iso('CENTER', 'Center ____ _ ____ _ ____', [31.75, -6.35, 6.35, -6.35]),
  iso('CENTER2', 'Center (.5x) ___ _ ___ _ ___', [19.05, -3.175, 3.175, -3.175]),
  iso('CENTERX2', 'Center (2x) ________  __  ________', [63.5, -12.7, 12.7, -12.7]),
  iso('DASHED', 'Dashed __ __ __ __', [12.7, -6.35]),
  iso('DASHED2', 'Dashed (.5x) _ _ _ _ _', [6.35, -3.175]),
  iso('DASHEDX2', 'Dashed (2x) ____  ____  ____', [25.4, -12.7]),
  iso('HIDDEN', 'Hidden __ __ __ __', [6.35, -3.175]),
  iso('HIDDEN2', 'Hidden (.5x) _ _ _ _', [3.175, -1.5875]),
  iso('DASHDOT', 'Dash dot __ . __ . __', [12.7, -6.35, 0, -6.35]),
  iso('PHANTOM', 'Phantom ______  __  __  ______', [31.75, -6.35, 6.35, -6.35, 6.35, -6.35]),
  iso('DOT', 'Dot . . . . . . .', [0, -6.35]),
  iso('DIVIDE', 'Divide ____ . . ____ . .', [12.7, -6.35, 0, -6.35, 0, -6.35]),
  iso('BORDER', 'Border __ __ . __ __ .', [12.7, -6.35, 12.7, -6.35, 0, -6.35]),
  iso('ACAD_ISO02W100', 'ISO dash __ __ __', [12, -3]),
  iso('ACAD_ISO03W100', 'ISO dash space __    __', [12, -18]),
  iso('ACAD_ISO04W100', 'ISO long-dash dot ____ .', [24, -3, 0, -3]),
  iso('ACAD_ISO05W100', 'ISO long-dash double-dot ____ ..', [24, -3, 0, -3, 0, -3]),
  iso('ACAD_ISO07W100', 'ISO dot . . . .', [0, -3]),
  iso('ACAD_ISO10W100', 'ISO dash dot __ . __ .', [12, -3, 0, -3]),
];
const BUILTIN = new Map(BUILTIN_LINETYPES.map((l) => [l.name.toUpperCase(), l]));

export const isContinuous = (n: string | undefined) => !n || /^(CONTINUOUS|BYLAYER|BYBLOCK)$/i.test(n) || n === '';

export class LinetypeLibrary {
  private complex = new Map<string, ComplexLinetypeJson>();
  load(list: ComplexLinetypeJson[]) { for (const l of list) this.complex.set(l.name.toUpperCase(), l); }
  names(): string[] { return [...BUILTIN.keys(), ...this.complex.keys()]; }
  list(): { name: string; description: string }[] {
    return [...BUILTIN_LINETYPES.map((l) => ({ name: l.name, description: l.description ?? '' })), ...[...this.complex.values()].map((l) => ({ name: l.name, description: l.description ?? '' }))];
  }
  /** Resolve by name: drawing-defined first, then YQArch library, then built-in ISO. */
  resolve(name: string, docLt?: LinetypeDef): ResolvedLinetype | null {
    if (isContinuous(name)) return null;
    const up = name.toUpperCase();
    if (docLt && docLt.pattern.length) return fromSimple(docLt);
    const c = this.complex.get(up);
    if (c && c.elements.length) {
      const length = c.patternLength || c.elements.reduce((a, e) => a + (e.kind === 'dash' ? Math.abs(e.length) : 0), 0);
      if (length > 1e-12) return { name: c.name, elements: c.elements, length };
    }
    const b = BUILTIN.get(up);
    return b ? fromSimple(b) : null;
  }
}
function fromSimple(l: LinetypeDef): ResolvedLinetype | null {
  if (!l.pattern.length) return null;
  const length = l.pattern.reduce((a, b) => a + Math.abs(b), 0);
  if (length < 1e-12) return null;
  return { name: l.name, elements: l.pattern.map((x) => ({ kind: 'dash', length: x })), length };
}

export interface GlyphPlacement { kind: 'text' | 'shape'; value: string; style?: string; file?: string; at: Pt; angle: number; size: number }
/**
 * Apply a linetype to a polyline given as a flat [x0,y0,x1,y1,...] array.
 * Returns dash polylines (flat arrays); zero-length dashes become 2-point dots. Glyph placements are appended to `glyphs`.
 * Returns null when the pattern would be too dense (caller draws the line continuous, like AutoCAD).
 */
export function applyLinetype(flat: number[], closed: boolean, lt: ResolvedLinetype, scale: number, glyphs?: GlyphPlacement[], maxDashes = 20000): number[][] | null {
  const L = lt.length * scale;
  if (!(L > 1e-12)) return null;
  const pts = closed && flat.length >= 4 ? [...flat, flat[0], flat[1]] : flat;
  let total = 0;
  for (let i = 2; i < pts.length; i += 2) total += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
  if (total / L > maxDashes) return null;
  const out: number[][] = [];
  const els = lt.elements;
  let ei = 0, remain = elLen(els[0], scale), drawing = isDraw(els[0]);
  let cur: number[] | null = drawing ? [pts[0], pts[1]] : null;
  // emit glyphs that sit at the very start
  const emitGlyph = (e: LtElement, x: number, y: number, dirx: number, diry: number) => {
    if (!glyphs || e.kind === 'dash') return;
    const p = e.params ?? {};
    const ang = Math.atan2(diry, dirx);
    const S = (p.S ?? 1) * scale, X = (p.X ?? 0) * scale, Y = (p.Y ?? 0) * scale;
    const rot = p.A !== undefined ? (p.A * Math.PI) / 180 : ang + ((p.R ?? 0) * Math.PI) / 180;
    const at: Pt = [x + Math.cos(ang) * X - Math.sin(ang) * Y, y + Math.sin(ang) * X + Math.cos(ang) * Y];
    glyphs.push(e.kind === 'text' ? { kind: 'text', value: e.text, style: e.style, at, angle: rot, size: S } : { kind: 'shape', value: e.shape, file: e.file, at, angle: rot, size: S });
  };
  let guard = 0;
  for (let i = 2; i < pts.length; i += 2) {
    let x0 = pts[i - 2], y0 = pts[i - 1];
    const x1 = pts[i], y1 = pts[i + 1];
    let segLen = Math.hypot(x1 - x0, y1 - y0);
    if (segLen < 1e-12) continue;
    const dx = (x1 - x0) / segLen, dy = (y1 - y0) / segLen;
    while (segLen > 1e-12 && guard++ < maxDashes * 8) {
      if (remain > segLen) {
        remain -= segLen;
        if (cur) cur.push(x1, y1);
        segLen = 0;
      } else {
        x0 += dx * remain; y0 += dy * remain; segLen -= remain;
        if (cur) { cur.push(x0, y0); out.push(cur); cur = null; }
        // advance to next element(s)
        let hops = 0;
        do {
          ei = (ei + 1) % els.length;
          const e = els[ei];
          if (e.kind !== 'dash') emitGlyph(e, x0, y0, dx, dy);
          remain = elLen(e, scale); drawing = isDraw(e);
          if (e.kind === 'dash' && e.length === 0) out.push([x0, y0, x0, y0]);
        } while (remain === 0 && ++hops < els.length * 2);
        if (drawing) cur = [x0, y0];
      }
    }
  }
  if (cur && cur.length >= 4) out.push(cur);
  return out;
}
const elLen = (e: LtElement | undefined, scale: number) => (e && e.kind === 'dash' ? Math.abs(e.length) * scale : 0);
const isDraw = (e: LtElement | undefined) => !!e && e.kind === 'dash' && e.length > 0;
