/** Command-line coordinate and value parsing (AutoCAD conventions). Arabic-Indic digits are accepted. */
import type { Pt } from '../types';
import { angleOf, dist, polar, rad } from '../geom/vec';

/** Normalise Arabic-Indic / Persian digits and Arabic separators to ASCII. */
export function normalizeInput(s: string): string {
  return s
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\u066B/g, '.') // Arabic decimal separator
    .replace(/[\u060C\u066C]/g, ',') // Arabic comma, thousands separator
    .replace(/\uFF0C/g, ',').replace(/\uFF1C/g, '<') // full-width comma / less-than (Chinese IME)
    .trim();
}

const NUM = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?';
const reNum = new RegExp(`^${NUM}$`);
const reXY = new RegExp(`^(${NUM})\\s*,\\s*(${NUM})(?:\\s*,\\s*${NUM})?$`);
const rePolar = new RegExp(`^(${NUM})\\s*<\\s*(${NUM})$`);

export function parseNumber(s: string): number | null {
  const t = normalizeInput(s);
  if (!reNum.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

export interface CoordContext {
  /** Last point (for @ relative input). */ last: Pt | null;
  /** Base point of the current prompt (rubber band origin), used for direct distance entry. */ base: Pt | null;
  /** Current cursor (world) giving the direction for direct distance entry. */ cursor: Pt | null;
}

/**
 * Parse a point typed on the command line:
 *   x,y  absolute · #x,y absolute · @dx,dy relative · @d<a relative polar · d<a absolute polar · d  direct distance
 */
export function parsePoint(input: string, ctx: CoordContext): Pt | null {
  let s = normalizeInput(input).replace(/\s+/g, '');
  if (!s) return null;
  let rel = false;
  if (s.startsWith('@')) { rel = true; s = s.slice(1); if (!s) return ctx.last ? [...ctx.last] as Pt : null; }
  else if (s.startsWith('#')) s = s.slice(1);
  const origin: Pt = rel ? ctx.last ?? [0, 0] : [0, 0];
  let m = reXY.exec(s);
  if (m) return [origin[0] + Number(m[1]), origin[1] + Number(m[2])];
  m = rePolar.exec(s);
  if (m) return polar(origin, rad(Number(m[2])), Number(m[1]));
  if (!rel && reNum.test(s)) {
    const d = Number(s);
    const from = ctx.base ?? ctx.last;
    if (!from) return null;
    const cur = ctx.cursor;
    const a = cur && dist(cur, from) > 1e-12 ? angleOf(from, cur) : 0;
    return polar(from, a, d);
  }
  return null;
}

/** Parse an angle in degrees (optionally prefixed with '<'); returns radians. */
export function parseAngle(input: string): number | null {
  const s = normalizeInput(input).replace(/^</, '').replace(/[°d]$/i, '');
  const v = parseNumber(s);
  return v === null ? null : rad(v);
}
