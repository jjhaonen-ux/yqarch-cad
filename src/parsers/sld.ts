/**
 * AutoCAD slide (.sld) and slide library (.slb) parser + SVG renderer.
 * YQArch uses slides as thumbnails for its block / hatch / door-window libraries.
 * Format reference: AutoCAD Customization Guide, "Slide File Format" / "Slide Library File Format".
 */
import { aciToHex } from '../util/aci.js';
import { decodeGbk } from '../util/encoding.js';

export interface SlideSegment { color: number; from: [number, number]; to: [number, number] }
export interface SlideFill { color: number; points: [number, number][] }

export interface Slide {
  level: number;
  width: number;   // high X dot
  height: number;  // high Y dot
  aspect: number;  // physical width / height of the original screen
  segments: SlideSegment[];
  fills: SlideFill[];
  warnings: string[];
}

const SLIDE_SIG = 'AutoCAD Slide\r\n\x1a';
const LIB_SIG = 'AutoCAD Slide Library 1.0\r\n\x1a';

const ascii = (b: Uint8Array, start: number, len: number) => String.fromCharCode(...b.subarray(start, start + len));

export function isSlide(bytes: Uint8Array) { return ascii(bytes, 0, SLIDE_SIG.length) === SLIDE_SIG; }
export function isSlideLibrary(bytes: Uint8Array) { return ascii(bytes, 0, LIB_SIG.length) === LIB_SIG; }

export function parseSlide(bytes: Uint8Array): Slide {
  if (!isSlide(bytes)) throw new Error('not an AutoCAD slide');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const level = bytes[18];
  let pos: number;
  let le = true;
  let width: number, height: number, aspect: number;
  if (level >= 2) {
    const test = dv.getUint16(29, true);
    le = test === 0x1234;
    width = dv.getUint16(19, le);
    height = dv.getUint16(21, le);
    aspect = dv.getUint32(23, true) / 1e7;
    pos = 31;
  } else {
    width = dv.getUint16(19, true);
    height = dv.getUint16(21, true);
    aspect = dv.getFloat64(23, true);
    pos = 34;
  }
  if (!(aspect > 0 && aspect < 100)) aspect = width / Math.max(1, height);

  const segments: SlideSegment[] = [];
  const fills: SlideFill[] = [];
  const warnings: string[] = [];
  let color = 7;
  let last: [number, number] = [0, 0];
  let fill: SlideFill | null = null;
  const i8 = (o: number) => dv.getInt8(o);
  const u16 = (o: number) => dv.getUint16(o, le);
  const s16 = (o: number) => dv.getInt16(o, le);

  while (pos + 2 <= bytes.length) {
    const word = u16(pos);
    const hi = word >> 8;
    const lo = word & 0xff;
    if (hi <= 0x7f) {                       // full vector: from-x, from-y, to-x, to-y
      if (pos + 8 > bytes.length) break;
      const from: [number, number] = [word, u16(pos + 2)];
      const to: [number, number] = [u16(pos + 4), u16(pos + 6)];
      segments.push({ color, from, to });
      last = from;
      pos += 8;
    } else if (hi === 0xfb) {               // offset vector (relative to last point)
      if (pos + 5 > bytes.length) break;
      const dfx = (lo << 24) >> 24;
      const from: [number, number] = [last[0] + dfx, last[1] + i8(pos + 2)];
      const to: [number, number] = [last[0] + i8(pos + 3), last[1] + i8(pos + 4)];
      segments.push({ color, from, to });
      last = from;
      pos += 5;
    } else if (hi === 0xfc) {               // end of file
      break;
    } else if (hi === 0xfd) {               // solid fill polygon vertices
      if (pos + 6 > bytes.length) break;
      const x = s16(pos + 2);
      const y = s16(pos + 4);
      pos += 6;
      if (y < 0) {
        if (fill && fill.points.length >= 3) fills.push(fill);
        fill = fill ? null : { color, points: [] };
      } else if (fill) fill.points.push([x, y]);
    } else if (hi === 0xfe) {               // common endpoint vector
      if (pos + 3 > bytes.length) break;
      const dx = (lo << 24) >> 24;
      const to: [number, number] = [last[0] + dx, last[1] + i8(pos + 2)];
      segments.push({ color, from: last, to });
      last = to;
      pos += 3;
    } else if (hi === 0xff) {               // new color
      color = lo;
      pos += 2;
    } else {
      warnings.push(`unknown record 0x${hi.toString(16)} at ${pos}`);
      break;
    }
  }
  return { level, width, height, aspect, segments, fills, warnings };
}

export interface SlideLibraryEntry { name: string; slide: Slide }

export function parseSlideLibrary(bytes: Uint8Array): { entries: SlideLibraryEntry[]; warnings: string[] } {
  if (!isSlideLibrary(bytes)) throw new Error('not an AutoCAD slide library');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dir: { name: string; addr: number }[] = [];
  const warnings: string[] = [];
  let pos = 32;
  while (pos + 36 <= bytes.length && bytes[pos] !== 0) {
    const nameBytes = bytes.subarray(pos, pos + 32);
    const end = nameBytes.indexOf(0);
    const name = decodeGbk(nameBytes.subarray(0, end < 0 ? 32 : end));
    let addr = dv.getUint32(pos + 32, true);
    if (addr >= bytes.length) addr = dv.getUint32(pos + 32, false);
    dir.push({ name, addr });
    pos += 36;
  }
  const entries: SlideLibraryEntry[] = [];
  for (const d of dir) {
    try {
      entries.push({ name: d.name, slide: parseSlide(bytes.subarray(d.addr)) });
    } catch (e) {
      warnings.push(`${d.name}: ${(e as Error).message}`);
    }
  }
  return { entries, warnings };
}

export interface SlideSvgOptions { background?: string | null; whiteAs?: string; strokeWidth?: number }

/** Render a slide to a compact SVG. ACI 7 (white/black) is drawn with `whiteAs` (default currentColor). */
export function slideToSvg(slide: Slide, opts: SlideSvgOptions = {}): string {
  const { background = '#000000', whiteAs = '#ffffff', strokeWidth = 1 } = opts;
  const w = slide.width || 1;
  const hView = w / (slide.aspect || w / Math.max(1, slide.height));
  const sy = hView / Math.max(1, slide.height);
  const X = (x: number) => +x.toFixed(1);
  const Y = (y: number) => +((slide.height - y) * sy).toFixed(1);
  const col = (c: number) => (c === 7 || c === 0 ? whiteAs : aciToHex(c, whiteAs));

  const byColor = new Map<number, string[]>();
  for (const s of slide.segments) {
    const arr = byColor.get(s.color) ?? [];
    const prevEnd = arr.length ? arr[arr.length - 1].match(/L(\S+) (\S+)$/) : null;
    const fx = X(s.from[0]), fy = Y(s.from[1]), tx = X(s.to[0]), ty = Y(s.to[1]);
    if (prevEnd && +prevEnd[1] === fx && +prevEnd[2] === fy) arr[arr.length - 1] += `L${tx} ${ty}`;
    else arr.push(`M${fx} ${fy}L${tx} ${ty}`);
    byColor.set(s.color, arr);
  }
  const paths = [...byColor.entries()].map(([c, d]) => `<path stroke="${col(c)}" d="${d.join('')}"/>`);
  const fills = slide.fills.map((f) => `<polygon fill="${col(f.color)}" points="${f.points.map((p) => `${X(p[0])},${Y(p[1])}`).join(' ')}"/>`);
  const bg = background ? `<rect width="100%" height="100%" fill="${background}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${+hView.toFixed(1)}" fill="none" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke">${bg}${fills.join('')}${paths.join('')}</svg>\n`;
}
