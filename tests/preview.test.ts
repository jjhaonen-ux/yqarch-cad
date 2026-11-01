import { describe, expect, it } from 'vitest';
import { drawingToSvg } from '../src/preview/drawing-svg.js';
import type { Drawing } from '../src/preview/types.js';

const drawing: Drawing = {
  format: 'yqweb-drawing@1', source: 'test.dwg', version: '2004', units: 4, base: [0, 0], bbox: [0, 0, 10, 10],
  layers: [{ name: '0', color: 7, linetype: 'Continuous', lineweight: -3, off: false, frozen: false, locked: false, plot: true },
           { name: 'HIDDEN', color: 1, linetype: 'Continuous', lineweight: -3, off: true, frozen: false, locked: false, plot: true }],
  styles: [],
  blocks: { BOX: { base: [0, 0], entities: [{ type: 'LWPOLYLINE', layer: '0', color: 0, pts: [[0, 0], [1, 0], [1, 1], [0, 1]], closed: true }] } },
  entities: [
    { type: 'LINE', layer: '0', a: [0, 0], b: [10, 10] },
    { type: 'LINE', layer: 'HIDDEN', a: [0, 0], b: [99, 99] },
    { type: 'INSERT', layer: '0', color: 3, name: 'BOX', p: [5, 5], sx: 2, sy: 2, rot: 0 },
  ],
};

describe('drawing preview', () => {
  it('renders visible entities, resolves BYBLOCK color and skips layers that are off', () => {
    const svg = drawingToSvg(drawing, { background: '#000' });
    expect(svg).toContain('<svg');
    expect(svg).toContain('stroke="#00ff00"');       // BYBLOCK inherits ACI 3 from the INSERT
    expect(svg).not.toContain('99.000');             // off layer not drawn
    expect(svg).toContain('M5.000 -5.000L7.000 -5.000L7.000 -7.000L5.000 -7.000L5.000 -5.000Z');
  });
});
