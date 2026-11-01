/** Test helpers for Phase 3A: real SHX fonts and hatch patterns from assets/, a geometric oracle, a real pick host. */
import { readFileSync } from 'node:fs';
import { CadDocument } from '../src/engine/model/document';
import { CommandEngine, type EngineHost } from '../src/engine/commands/engine';
import { registerAll } from '../src/engine/commands';
import { tessellate, type TessContext } from '../src/engine/render/tessellate';
import { PatternLibrary, patternToLines, type PatternDef } from '../src/engine/render/hatch';
import type { FontJson, FontProvider } from '../src/engine/render/fonts';
import { crossingSelect, fenceSelect, pick, polygonSelect, windowSelect } from '../src/engine/select/select';
import { apply, type Mat } from '../src/engine/geom/matrix';
import type { Entity, Pt } from '../src/engine/types';

export const asset = <T = unknown>(p: string): T => JSON.parse(readFileSync(new URL(`../assets/${p}`, import.meta.url), 'utf8')) as T;

class NodeFonts implements FontProvider {
  private files = new Map<string, string>();
  private cache = new Map<string, FontJson>();
  constructor() { for (const f of asset<{ name: string; file: string }[]>('fonts/index.json')) this.files.set(f.name.toUpperCase(), f.file); }
  get(name: string) {
    const k = name.toUpperCase().replace(/\.(SHX|TTF|TTC|OTF)$/i, '');
    if (!this.cache.has(k)) { const f = this.files.get(k); if (!f) return undefined; this.cache.set(k, asset<FontJson>(f)); }
    return this.cache.get(k);
  }
  available() { return [...this.files.keys()]; }
}
export const fonts = new NodeFonts();
export const patterns = new PatternLibrary();
patterns.load(asset<{ patterns: PatternDef[] }>('patterns.json').patterns);

/** Install the asset lookups the app installs (patterns for MIRROR/EXPLODE, fonts for MTEXT explode). */
export function equip(doc: CadDocument): CadDocument {
  doc.patternLines = (name, scale, angleDeg, origin) => { const p = patterns.find(name); return p ? patternToLines(p, scale, (angleDeg * Math.PI) / 180, origin) : undefined; };
  doc.fonts = fonts;
  return doc;
}
export const tc = (doc: CadDocument): TessContext => ({ doc, fg: '#ffffff', bg: '#000000', fonts, patterns });

/** All drawn polylines of an entity (strokes and fill outlines), as flat arrays. */
export function strokes(doc: CadDocument, e: Entity): number[][] {
  const out: number[][] = [];
  for (const it of tessellate(e, tc(doc))) {
    if (it.kind === 'stroke') for (let i = 0; i < it.paths.length; i++) { const p = it.paths[i]; out.push(it.closed?.[i] && p.length >= 4 ? [...p, p[0], p[1]] : p); }
    else if (it.kind === 'fill') for (const l of it.loops) out.push(l.length >= 4 ? [...l, l[0], l[1]] : l);
    else { const m = it.m; const w = it.text.length * it.h; const q = (x: number, y: number) => apply(m, [x, y]); out.push([...q(0, 0), ...q(w, 0), ...q(w, it.h), ...q(0, it.h), ...q(0, 0)]); }
  }
  return out;
}
export const mapStrokes = (s: number[][], m: Mat) => s.map((p) => { const o: number[] = []; for (let i = 0; i < p.length; i += 2) o.push(...apply(m, [p[i], p[i + 1]])); return o; });

export function bboxOf(s: number[][]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of s) for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]); }
  return [x0, y0, x1, y1];
}
export const strokeLength = (s: number[][]) => { let L = 0; for (const p of s) for (let i = 2; i < p.length; i += 2) L += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]); return L; };

/** Directed Hausdorff distance from the vertices (densified) of `a` to the segments of `b`, using a grid. */
function directed(a: number[][], b: number[][], step: number): number {
  const segs: number[] = [];
  for (const p of b) { if (p.length === 2) segs.push(p[0], p[1], p[0], p[1]); for (let i = 2; i < p.length; i += 2) segs.push(p[i - 2], p[i - 1], p[i], p[i + 1]); }
  if (!segs.length) return a.some((p) => p.length) ? Infinity : 0;
  const cell = Math.max(step * 4, 1e-9);
  const grid = new Map<string, number[]>();
  const key = (i: number, j: number) => i + ',' + j;
  for (let s = 0; s < segs.length; s += 4) {
    const i0 = Math.floor(Math.min(segs[s], segs[s + 2]) / cell), i1 = Math.floor(Math.max(segs[s], segs[s + 2]) / cell);
    const j0 = Math.floor(Math.min(segs[s + 1], segs[s + 3]) / cell), j1 = Math.floor(Math.max(segs[s + 1], segs[s + 3]) / cell);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 4000) { const k = 'big'; (grid.get(k) ?? grid.set(k, []).get(k)!).push(s); continue; }
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const k = key(i, j); (grid.get(k) ?? grid.set(k, []).get(k)!).push(s); }
  }
  const segDist = (x: number, y: number, s: number) => {
    const ax = segs[s], ay = segs[s + 1], bx = segs[s + 2], by = segs[s + 3];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
    return Math.hypot(x - ax - t * dx, y - ay - t * dy);
  };
  const near = (x: number, y: number) => {
    const ci = Math.floor(x / cell), cj = Math.floor(y / cell);
    let best = Infinity;
    for (let r = 0; r < 3 && best > (r - 1) * cell; r++) {
      for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r) continue;
        for (const s of grid.get(key(i, j)) ?? []) best = Math.min(best, segDist(x, y, s));
      }
    }
    for (const s of grid.get('big') ?? []) best = Math.min(best, segDist(x, y, s));
    if (best === Infinity) for (let s = 0; s < segs.length; s += 4) best = Math.min(best, segDist(x, y, s));
    return best;
  };
  let worst = 0;
  for (const p of a) for (let i = 0; i < p.length; i += 2) {
    worst = Math.max(worst, near(p[i], p[i + 1]));
    if (i >= 2) { // densify long segments
      const L = Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
      const n = Math.min(50, Math.floor(L / step));
      for (let k = 1; k < n; k++) worst = Math.max(worst, near(p[i - 2] + ((p[i] - p[i - 2]) * k) / n, p[i - 1] + ((p[i + 1] - p[i - 1]) * k) / n));
    }
  }
  return worst;
}
/** Symmetric Hausdorff distance between two stroke sets. */
export function hausdorff(a: number[][], b: number[][]): number {
  const bb = bboxOf([...a, ...b]);
  const step = Math.max(bb[2] - bb[0], bb[3] - bb[1]) / 200 || 1;
  return Math.max(directed(a, b, step), directed(b, a, step));
}

/** Engine with a real pick / window host (pick box `tol` world units). */
export function engineWithHost(doc: CadDocument, tol = 0.5): CommandEngine {
  const items = { itemsFor: (e: Entity) => tessellate(e, tc(doc)) };
  const host: EngineHost = {
    pick: (p: Pt, filter, includeLocked) => pick(doc, items, p, tol, { filter, includeLocked }),
    windowSelect: (a: Pt, b: Pt, crossing, filter, includeLocked) => {
      const box: [number, number, number, number] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
      return crossing ? crossingSelect(doc, items, box, { filter, includeLocked }) : windowSelect(doc, box, { filter, includeLocked });
    },
    pathSelect: (pts: Pt[], mode, filter, includeLocked) => mode === 'F' ? fenceSelect(doc, items, pts, { filter, includeLocked }) : polygonSelect(doc, items, pts, mode === 'CP', { filter, includeLocked }),
  };
  return registerAll(new CommandEngine(doc, host));
}
