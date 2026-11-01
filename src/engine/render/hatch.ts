/** Hatch pattern expansion (PAT definitions -> world lines) and even-odd clipping of pattern lines against boundary loops. */
import type { HatchLine, Pt } from '../types';
import { rotate } from '../geom/vec';

export interface PatternLine { angle: number; origin: Pt; delta: Pt; dashes: number[] }
export interface PatternDef { key: string; name: string; description?: string; source?: string; units?: string | null; lines: PatternLine[] }

export class PatternLibrary {
  private byKey = new Map<string, PatternDef>();
  private byName = new Map<string, PatternDef[]>();
  load(list: PatternDef[]) {
    for (const p of list) {
      this.byKey.set(p.key.toUpperCase(), p);
      const n = p.name.toUpperCase();
      this.byName.set(n, [...(this.byName.get(n) ?? []), p]);
    }
  }
  get size() { return this.byKey.size; }
  list(): PatternDef[] { return [...this.byKey.values()]; }
  /** Find a pattern by key or name; ISO (mm) definitions are preferred when `preferIso`. */
  find(name: string, preferIso = true): PatternDef | undefined {
    const up = name.toUpperCase();
    const cands = this.byName.get(up);
    if (cands?.length) {
      if (preferIso) { const iso = cands.find((c) => /iso/i.test(c.source ?? '')); if (iso) return iso; }
      return cands.find((c) => !/iso/i.test(c.source ?? '')) ?? cands[0];
    }
    return this.byKey.get(up);
  }
}

/** Expand a pattern at the given scale and rotation into hatch definition lines (world vectors, radians). */
export function patternToLines(p: PatternDef, scale: number, angleRad: number, origin: Pt = [0, 0]): HatchLine[] {
  return p.lines.map((l) => {
    const a = (l.angle * Math.PI) / 180 + angleRad;
    const base = rotate([l.origin[0] * scale, l.origin[1] * scale], angleRad);
    const off = rotate([l.delta[0] * scale, l.delta[1] * scale], a);
    return { angle: a, base: [base[0] + origin[0], base[1] + origin[1]], offset: off, dashes: l.dashes.map((d) => d * scale) };
  });
}

/**
 * Clip hatch lines to the loops (even-odd) and apply dash patterns.
 * Returns flat segments [x0,y0,x1,y1] and whether the line budget was exceeded.
 */
export function hatchSegments(loops: Pt[][], lines: HatchLine[], maxSegs = 150000): { segs: number[][]; truncated: boolean } {
  const segs: number[][] = [];
  let truncated = false;
  const edges = loops.filter((l) => l.length >= 3);
  if (!edges.length) return { segs, truncated };
  outer: for (const hl of lines) {
    const dx = Math.cos(hl.angle), dy = Math.sin(hl.angle), nx = -dy, ny = dx;
    const spacing = hl.offset[0] * nx + hl.offset[1] * ny;
    const shift = hl.offset[0] * dx + hl.offset[1] * dy;
    if (Math.abs(spacing) < 1e-9) continue;
    // loop vertices in the family frame (x along the line, y across)
    const frame = edges.map((l) => l.map((p) => [(p[0] - hl.base[0]) * dx + (p[1] - hl.base[1]) * dy, (p[0] - hl.base[0]) * nx + (p[1] - hl.base[1]) * ny]));
    let ymin = Infinity, ymax = -Infinity;
    for (const l of frame) for (const q of l) { if (q[1] < ymin) ymin = q[1]; if (q[1] > ymax) ymax = q[1]; }
    // tolerance: a hatch line lying on a boundary edge is classified the same way whatever the rounding noise
    // (vertices within eps of the line count as above it), so transformed copies clip identically
    const eps = 1e-9 * (Math.abs(ymin) + Math.abs(ymax) + Math.abs(spacing));
    let k0 = Math.ceil((ymin - eps) / spacing), k1 = Math.floor((ymax + eps) / spacing);
    if (spacing < 0) { k0 = Math.ceil((ymax + eps) / spacing); k1 = Math.floor((ymin - eps) / spacing); }
    if (k0 > k1) [k0, k1] = [k1, k0];
    if ((k1 - k0) * Math.max(1, hl.dashes.length) > maxSegs * 2) { truncated = true; continue; }
    const L = hl.dashes.reduce((a, b) => a + Math.abs(b), 0);
    for (let k = k0; k <= k1; k++) {
      const yk = k * spacing, yc = yk - eps;
      const xs: number[] = [];
      for (const l of frame) {
        for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
          const a = l[j], b = l[i];
          if ((a[1] > yc) !== (b[1] > yc)) xs.push(a[0] + ((yk - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((p, q) => p - q);
      const toW = (x: number): Pt => [hl.base[0] + dx * x + nx * yk, hl.base[1] + dy * x + ny * yk];
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const xa = xs[i], xb = xs[i + 1];
        if (!hl.dashes.length || L < 1e-12) { const p = toW(xa), q = toW(xb); segs.push([p[0], p[1], q[0], q[1]]); }
        else {
          const phase = k * shift;
          let t = Math.floor((xa - phase) / L) * L + phase;
          let guard = 0;
          while (t < xb && guard++ < 100000) {
            for (const d of hl.dashes) {
              const len = Math.abs(d);
              const s = Math.max(t, xa), e = Math.min(t + len, xb);
              if (d > 0 && e > s) { const p = toW(s), q = toW(e); segs.push([p[0], p[1], q[0], q[1]]); }
              else if (d === 0 && t >= xa && t <= xb) { const p = toW(t); segs.push([p[0], p[1], p[0], p[1]]); }
              t += len;
              if (t >= xb) break;
            }
          }
        }
        if (segs.length > maxSegs) { truncated = true; break outer; }
      }
    }
  }
  return { segs, truncated };
}
