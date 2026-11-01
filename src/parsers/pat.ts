/**
 * AutoCAD hatch pattern (.pat) parser.
 *   *NAME, description
 *   angle, x-origin, y-origin, delta-x, delta-y [, dash-1, dash-2, ...]
 * Dash > 0 = pen down, < 0 = pen up, 0 = dot.
 */
export interface PatLine {
  angle: number;            // degrees
  origin: [number, number];
  delta: [number, number];  // delta-x = shift along the line, delta-y = spacing between parallel lines
  dashes: number[];         // empty = continuous
}

export interface HatchPattern {
  name: string;
  description: string;
  lines: PatLine[];
  units: 'mm' | 'inch' | null;  // from ";%UNITS=" / ";%TYPE=" hints when present
}

export interface PatParseResult { patterns: HatchPattern[]; warnings: string[] }

/** Decode AutoCAD \U+XXXX escapes. */
export const decodeUnicodeEscapes = (s: string) => s.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

export function parsePat(text: string): PatParseResult {
  const patterns: HatchPattern[] = [];
  const warnings: string[] = [];
  let units: HatchPattern['units'] = null;
  let cur: HatchPattern | null = null;
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    if (line.startsWith(';')) {
      const u = line.match(/%UNITS\s*=\s*(\w+)/i);
      if (u) units = /^inch/i.test(u[1]) ? 'inch' : /^mm|metric/i.test(u[1]) ? 'mm' : units;
      return;
    }
    const content = line.split(';')[0].trim();
    if (!content) return;
    if (content.startsWith('*')) {
      const c = content.indexOf(',');
      const name = decodeUnicodeEscapes((c >= 0 ? content.slice(1, c) : content.slice(1)).trim());
      cur = { name, description: c >= 0 ? content.slice(c + 1).trim() : '', lines: [], units };
      patterns.push(cur);
      return;
    }
    if (!cur) { warnings.push(`line ${i + 1}: definition before any *NAME`); return; }
    const nums = content.split(',').map((s) => s.trim()).filter((s) => s !== '').map(Number);
    if (nums.length < 5 || nums.some((n) => !Number.isFinite(n))) {
      warnings.push(`line ${i + 1} (${cur.name}): invalid definition "${content}"`);
      return;
    }
    const [angle, ox, oy, dx, dy, ...dashes] = nums;
    cur.lines.push({ angle, origin: [ox, oy], delta: [dx, dy], dashes });
  });
  for (const p of patterns) if (p.lines.length === 0 && p.name.toUpperCase() !== 'SOLID') warnings.push(`pattern ${p.name} has no lines`);
  return { patterns, warnings };
}
