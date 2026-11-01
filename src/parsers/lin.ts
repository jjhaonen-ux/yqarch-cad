/**
 * AutoCAD linetype (.lin) parser, including complex linetypes:
 *   *NAME, description
 *   A, 12.7, -6.35, ["TEXT",STYLE,S=2.54,R=0.0,X=0,Y=-1.27], -2
 *   A, 1, -1, [SHAPENAME,shapes.shx,S=1]
 */
import { decodeUnicodeEscapes } from './pat.js';

export type LinElement =
  | { kind: 'dash'; length: number }  // >0 dash, <0 gap, 0 dot
  | { kind: 'text'; text: string; style: string; params: Record<string, number | string> }
  | { kind: 'shape'; shape: string; file: string; params: Record<string, number | string> };

export interface Linetype {
  name: string;
  description: string;
  alignment: string;     // always "A" in modern files
  elements: LinElement[];
  patternLength: number; // sum of |dash| lengths
}

export function parseLin(text: string): { linetypes: Linetype[]; warnings: string[] } {
  const linetypes: Linetype[] = [];
  const warnings: string[] = [];
  let pending: { name: string; description: string } | null = null;
  // join continuation lines: a definition line ending with ',' continues on the next line
  const joined: { line: string; no: number }[] = [];
  text.split('\n').forEach((raw, i) => {
    const t = raw.trim();
    const prev = joined[joined.length - 1];
    if (prev && prev.line.endsWith(',') && !prev.line.startsWith('*') && t && !t.startsWith(';') && !t.startsWith('*')) prev.line += t;
    else joined.push({ line: t, no: i });
  });
  joined.forEach(({ line, no: i }) => {
    if (!line || line.startsWith(';')) return;
    if (line.startsWith('*')) {
      const c = line.indexOf(',');
      pending = {
        name: decodeUnicodeEscapes((c >= 0 ? line.slice(1, c) : line.slice(1)).trim()),
        description: c >= 0 ? decodeUnicodeEscapes(line.slice(c + 1).trim()) : '',
      };
      return;
    }
    if (!pending) { warnings.push(`line ${i + 1}: definition without header`); return; }
    const tokens = tokenize(line);
    const alignment = tokens.shift() ?? 'A';
    const elements: LinElement[] = [];
    for (const t of tokens) {
      if (t.startsWith('[')) {
        const el = parseComplex(t.slice(1, -1));
        if (el) elements.push(el); else warnings.push(`line ${i + 1} (${pending.name}): bad complex element ${t}`);
      } else if (t !== '') {
        const n = Number(t);
        if (Number.isFinite(n)) elements.push({ kind: 'dash', length: n });
        else warnings.push(`line ${i + 1} (${pending.name}): bad dash "${t}"`);
      }
    }
    const patternLength = elements.reduce((s, e) => s + (e.kind === 'dash' ? Math.abs(e.length) : 0), 0);
    linetypes.push({ ...pending, alignment, elements, patternLength });
    pending = null;
  });
  return { linetypes, warnings };
}

function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let inQuote = false;
  for (const ch of line) {
    if (ch === '"') inQuote = !inQuote;
    if (!inQuote && ch === '[') depth++;
    if (!inQuote && ch === ']') depth--;
    if (ch === ',' && depth === 0 && !inQuote) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function parseComplex(body: string): LinElement | null {
  const parts: string[] = [];
  let cur = '';
  let inQuote = false;
  for (const ch of body) {
    if (ch === '"') { inQuote = !inQuote; cur += ch; continue; }
    if (ch === ',' && !inQuote) { parts.push(cur.trim()); cur = ''; } else cur += ch;
  }
  parts.push(cur.trim());
  if (parts.length < 2) return null;
  const params: Record<string, number | string> = {};
  for (const p of parts.slice(2)) {
    const m = p.match(/^([A-Za-z])\s*=\s*(.+)$/);
    if (m) { const n = Number(m[2]); params[m[1].toUpperCase()] = Number.isFinite(n) ? n : m[2]; }
  }
  if (parts[0].startsWith('"')) {
    return { kind: 'text', text: decodeUnicodeEscapes(parts[0].replace(/^"|"$/g, '')), style: parts[1], params };
  }
  return { kind: 'shape', shape: parts[0], file: parts[1], params };
}
