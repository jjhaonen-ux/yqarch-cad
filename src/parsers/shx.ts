/**
 * AutoCAD compiled shape/font (.shx) parser and glyph renderer.
 * Supports: "AutoCAD-86 shapes 1.0/1.1", "AutoCAD-86 unifont 1.0", "AutoCAD-86 bigfont 1.0" (e.g. Chinese HZDX.SHX).
 * Shape-code semantics follow the AutoCAD Customization Guide ("Shape Descriptions" / "Special Codes").
 */
import { bulgePoints, round, type Vec2 } from '../util/geom.js';
import { decodeGbk, gbkCodeToChar } from '../util/encoding.js';

export type ShxKind = 'shapes' | 'unifont' | 'bigfont';

export interface ShxShape { number: number; name: string; codes: Uint8Array }

export interface ShxFont {
  kind: ShxKind;
  signature: string;
  fontName: string;
  above: number;       // cap height in shape units (vector length 1 = 1 unit)
  below: number;       // descender
  mode: number;        // 0 horizontal, 2 dual orientation
  isFont: boolean;     // false = shape library (e.g. symbols for linetypes)
  escapeRanges: [number, number][]; // bigfont lead-byte ranges
  shapes: Map<number, ShxShape>;
  warnings: string[];
}

const ascii = (b: Uint8Array, s: number, n: number) => String.fromCharCode(...b.subarray(s, s + n));

function readCString(b: Uint8Array, start: number): [string, number] {
  let end = start;
  while (end < b.length && b[end] !== 0) end++;
  return [decodeGbk(b.subarray(start, end)), end + 1];
}

export function parseShx(bytes: Uint8Array): ShxFont {
  const sigEnd = bytes.indexOf(0x1a);
  const signature = ascii(bytes, 0, sigEnd).trim();
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const shapes = new Map<number, ShxShape>();
  const warnings: string[] = [];
  const font: ShxFont = { kind: 'shapes', signature, fontName: '', above: 0, below: 0, mode: 0, isFont: false, escapeRanges: [], shapes, warnings };

  if (/shapes 1\.[01]/.test(signature)) {
    let p = sigEnd + 1;
    const first = dv.getUint16(p, true), last = dv.getUint16(p + 2, true), count = dv.getUint16(p + 4, true);
    p += 6;
    const index: [number, number][] = [];
    for (let i = 0; i < count; i++, p += 4) index.push([dv.getUint16(p, true), dv.getUint16(p + 2, true)]);
    if (index.length && (index[0][0] !== first || index[index.length - 1][0] !== last)) warnings.push('index table first/last mismatch');
    for (const [num, len] of index) {
      const rec = bytes.subarray(p, p + len);
      p += len;
      const [name, after] = readCString(rec, 0);
      shapes.set(num, { number: num, name, codes: rec.subarray(after) });
    }
    const def = shapes.get(0);
    if (def) {
      font.isFont = true;
      font.fontName = def.name;
      font.above = def.codes[0] ?? 0;
      font.below = def.codes[1] ?? 0;
      font.mode = def.codes[2] ?? 0;
      shapes.delete(0);
    }
  } else if (/unifont 1\.0/.test(signature)) {
    font.kind = 'unifont';
    let p = sigEnd + 1;
    const count = dv.getUint32(p, true);
    const defLen = dv.getUint16(p + 4, true);
    p += 6;
    const [name, after] = readCString(bytes, p);
    font.fontName = name;
    font.above = bytes[after];
    font.below = bytes[after + 1];
    font.mode = bytes[after + 2];
    font.isFont = true;
    p += defLen;
    for (let i = 0; i < count - 1 && p + 4 <= bytes.length; i++) {
      const num = dv.getUint16(p, true), len = dv.getUint16(p + 2, true);
      p += 4;
      const rec = bytes.subarray(p, p + len);
      p += len;
      const [sname, a] = readCString(rec, 0);
      shapes.set(num, { number: num, name: sname, codes: rec.subarray(a) });
    }
  } else if (/bigfont 1\.0/.test(signature)) {
    font.kind = 'bigfont';
    let p = sigEnd + 1;
    const count = dv.getUint16(p + 2, true);
    const nRanges = dv.getUint16(p + 4, true);
    p += 6;
    for (let i = 0; i < nRanges; i++, p += 4) font.escapeRanges.push([dv.getUint16(p, true), dv.getUint16(p + 2, true)]);
    for (let i = 0; i < count; i++, p += 8) {
      const num = dv.getUint16(p, true), len = dv.getUint16(p + 2, true), off = dv.getUint32(p + 4, true);
      if (len === 0 || off + len > bytes.length) continue;
      const rec = bytes.subarray(off, off + len);
      const [sname, a] = readCString(rec, 0);
      if (num === 0) {
        font.fontName = sname;
        font.above = rec[a] ?? 0;
        font.below = rec[a + 1] ?? 0;
        font.mode = rec[a + 2] ?? 0;
        font.isFont = true;
        continue;
      }
      shapes.set(num, { number: num, name: sname, codes: rec.subarray(a) });
    }
  } else {
    throw new Error(`unsupported SHX signature "${signature}"`);
  }
  return font;
}

// ------------------------------------------------------------------ renderer

const VX = [1, 1, 1, 0.5, 0, -0.5, -1, -1, -1, -1, -1, -0.5, 0, 0.5, 1, 1];
const VY = [0, 0.5, 1, 1, 1, 1, 1, 0.5, 0, -0.5, -1, -1, -1, -1, -1, -0.5];

export interface Glyph {
  paths: number[][];    // polylines as flat [x0,y0,x1,y1,...] in shape units
  advance: Vec2;        // pen position after rendering (advance width / height)
}

interface State { x: number; y: number; scale: number; pen: boolean }

export function renderShape(font: ShxFont, number: number, opts: { vertical?: boolean; segPerCircle?: number } = {}): Glyph | null {
  const shape = font.shapes.get(number);
  if (!shape) return null;
  const paths: number[][] = [];
  let cur: number[] | null = null;
  const st: State = { x: 0, y: 0, scale: 1, pen: true };
  const stack: State[] = [];
  const seg = opts.segPerCircle ?? 32;

  const moveTo = (x: number, y: number) => { st.x = x; st.y = y; cur = null; };
  const lineTo = (x: number, y: number) => {
    if (st.pen) {
      if (!cur) { cur = [st.x, st.y]; paths.push(cur); }
      cur.push(x, y);
    } else cur = null;
    st.x = x; st.y = y;
  };
  const arc = (cx: number, cy: number, r: number, a0: number, a1: number) => {
    const n = Math.max(2, Math.ceil((Math.abs(a1 - a0) / (2 * Math.PI)) * seg));
    for (let i = 1; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
  };

  const run = (codes: Uint8Array, depth: number, sx = 1, sy = 1) => {
    if (depth > 8) { font.warnings.push(`subshape recursion too deep in ${number}`); return; }
    let i = 0;
    let skip = false;
    const u8 = () => codes[i++] ?? 0;
    const i8 = () => { const v = codes[i++] ?? 0; return v > 127 ? v - 256 : v; };
    while (i < codes.length) {
      const c = u8();
      const exec = !skip || !!opts.vertical;
      skip = false;
      if (c === 0) break;
      if (c >= 0x10) {
        if (exec) { const len = (c >> 4) * st.scale, d = c & 0xf; lineTo(st.x + VX[d] * len * sx, st.y + VY[d] * len * sy); }
        continue;
      }
      switch (c) {
        case 1: if (exec) st.pen = true; break;
        case 2: if (exec) { st.pen = false; cur = null; } break;
        case 3: { const f = u8(); if (exec && f) st.scale /= f; break; }
        case 4: { const f = u8(); if (exec) st.scale *= f; break; }
        case 5: if (exec) stack.push({ ...st }); break;
        case 6: if (exec) { const s = stack.pop(); if (s) { st.scale = s.scale; st.pen = s.pen; moveTo(s.x, s.y); } else font.warnings.push(`stack underflow in shape ${number}`); } break;
        case 7: {
          let sub: number; let ox = 0, oy = 0, w = 0, h = 0;
          if (font.kind === 'unifont') sub = (u8() << 8) | u8();
          else if (font.kind === 'bigfont') {
            const b = u8();
            if (b === 0) { sub = (u8() << 8) | u8(); ox = i8(); oy = i8(); w = u8(); h = u8(); }
            else sub = b;
          } else sub = u8();
          if (exec) {
            const s = font.shapes.get(sub);
            if (!s) { font.warnings.push(`missing subshape ${sub} in ${number}`); break; }
            if (w && h && font.above) {
              const pen = st.pen;
              st.pen = false; lineTo(st.x + ox * st.scale, st.y + oy * st.scale); st.pen = pen;
              run(s.codes, depth + 1, (w / font.above) * sx, (h / font.above) * sy);
            } else run(s.codes, depth + 1, sx, sy);
          }
          break;
        }
        case 8: { const dx = i8(), dy = i8(); if (exec) lineTo(st.x + dx * st.scale * sx, st.y + dy * st.scale * sy); break; }
        case 9: {
          for (;;) { const dx = i8(), dy = i8(); if (dx === 0 && dy === 0) break; if (exec) lineTo(st.x + dx * st.scale * sx, st.y + dy * st.scale * sy); }
          break;
        }
        case 10: {
          const r = u8() * st.scale * sx; const o = i8();
          if (exec && r > 0) {
            const ccw = o >= 0; const a = Math.abs(o);
            const so = (a >> 4) & 7; let span = a & 7; if (span === 0) span = 8;
            const a0 = (so * Math.PI) / 4;
            const a1 = a0 + ((ccw ? 1 : -1) * span * Math.PI) / 4;
            const cx = st.x - r * Math.cos(a0), cy = st.y - r * Math.sin(a0);
            arc(cx, cy, r, a0, a1);
          }
          break;
        }
        case 11: {
          const so_ = u8(), eo_ = u8(); const r = ((u8() << 8) | u8()) * st.scale * sx; const o = i8();
          if (exec && r > 0) {
            const ccw = o >= 0; const a = Math.abs(o);
            const so = (a >> 4) & 7; const span = a & 7;
            const eo = eo_ === 0 ? 256 : eo_;
            const bd = 45 / 256;
            let a0: number, a1: number;
            if (ccw) { a0 = so * 45 + so_ * bd; a1 = (so + span - 1) * 45 + eo * bd; }
            else { a0 = so * 45 - so_ * bd; a1 = (so - span + 1) * 45 - eo * bd; }
            a0 = (a0 * Math.PI) / 180; a1 = (a1 * Math.PI) / 180;
            if (ccw && a1 < a0) a1 += 2 * Math.PI;
            if (!ccw && a1 > a0) a1 -= 2 * Math.PI;
            const cx = st.x - r * Math.cos(a0), cy = st.y - r * Math.sin(a0);
            arc(cx, cy, r, a0, a1);
          }
          break;
        }
        case 12: { const dx = i8(), dy = i8(), b = i8(); if (exec) bulgeTo(dx, dy, b); break; }
        case 13: {
          for (;;) { const dx = i8(), dy = i8(); if (dx === 0 && dy === 0) break; const b = i8(); if (exec) bulgeTo(dx, dy, b); }
          break;
        }
        case 14: if (!opts.vertical) skip = true; break;
        default: break; // 15 unused
      }
    }
    function bulgeTo(dx: number, dy: number, b: number) {
      const tx = st.x + dx * st.scale * sx, ty = st.y + dy * st.scale * sy;
      if (b === 0 || !st.pen) { lineTo(tx, ty); return; }
      for (const p of bulgePoints([st.x, st.y], [tx, ty], b / 127, seg)) lineTo(p[0], p[1]);
    }
  };

  run(shape.codes, 0);
  return {
    paths: paths.filter((p) => p.length >= 4).map((p) => p.map((v) => round(v, 2))),
    advance: [round(st.x, 2), round(st.y, 2)],
  };
}

/** Map a shape number to the character it represents (null for pure shape libraries / unmapped codes). */
export function shapeChar(font: ShxFont, number: number): string | null {
  if (!font.isFont) return null;
  if (font.kind === 'bigfont') return gbkCodeToChar(number);
  if (number === 127) return '\u00b0';  // %%d degree
  if (number === 128) return '\u00b1';  // %%p plus/minus
  if (number === 129) return '\u2300';  // %%c diameter
  if (number < 127) return String.fromCharCode(number);
  if (font.kind === 'unifont' || number > 255) return String.fromCodePoint(number);
  return null;
}
