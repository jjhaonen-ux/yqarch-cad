import { describe, expect, it } from 'vitest';
import { parseShx, renderShape, shapeChar } from '../src/parsers/shx.js';

function shapesFont(): Uint8Array {
  const sig = [...'AutoCAD-86 shapes 1.0\r\n'].map((c) => c.charCodeAt(0)).concat(0x1a);
  const s0 = [...'TEST'].map((c) => c.charCodeAt(0)).concat(0, 10, 2, 0, 0);       // name, above, below, modes, end
  const sA = [0, 0x44, 0x40, 2, 8, 2, 0xfc, 0];                                     // up 4, right 4, pen up, move (2,-4)
  const u16 = (n: number) => [n & 0xff, n >> 8];
  const bytes = [...sig, ...u16(0), ...u16(65), ...u16(2), ...u16(0), ...u16(s0.length), ...u16(65), ...u16(sA.length), ...s0, ...sA];
  return new Uint8Array(bytes);
}

describe('SHX fonts', () => {
  it('parses a shapes 1.0 font header and glyph table', () => {
    const f = parseShx(shapesFont());
    expect(f).toMatchObject({ kind: 'shapes', fontName: 'TEST', above: 10, below: 2, isFont: true });
    expect([...f.shapes.keys()]).toEqual([65]);
    expect(shapeChar(f, 65)).toBe('A');
  });
  it('renders vector codes, pen up and displacement', () => {
    const g = renderShape(parseShx(shapesFont()), 65)!;
    expect(g.paths).toEqual([[0, 0, 0, 4, 4, 4]]);
    expect(g.advance).toEqual([6, 0]);
  });
});
