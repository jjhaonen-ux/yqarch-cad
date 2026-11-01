/** Unit test for the DWG normalizer (no DWG file needed — feeds a fake libredwg database). */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';

const modDir = path.resolve(__dirname, '../tools/dwg-convert/node_modules/@mlightcad/libredwg-web');
const installed = existsSync(modDir);

describe.skipIf(!installed)('dwg normalizer', () => {
  it('converts OCS entities with negative extrusion to world coordinates', async () => {
    // @ts-expect-error plain ESM module without types
    const { normalizeDrawing } = await import('../tools/dwg-convert/convert-dwg.mjs');
    const neg = { x: 0, y: 0, z: -1 };
    const db = {
      header: { INSUNITS: 4, INSBASE: { x: 0, y: 0, z: 0 } },
      tables: {
        LAYER: { entries: [{ name: '0', colorIndex: 7, lineType: 'Continuous', lineweight: 29, plotFlag: 1 }] },
        LTYPE: { entries: [] }, STYLE: { entries: [] },
        BLOCK_RECORD: { entries: [{ name: '*Model_Space', entities: [] }, { name: 'B', basePoint: { x: 0, y: 0 }, entities: [] }] },
      },
      entities: [
        { type: 'ARC', layer: '0', colorIndex: 256, center: { x: 10, y: 0 }, radius: 1, startAngle: 0, endAngle: Math.PI / 2, extrusionDirection: neg },
        { type: 'LWPOLYLINE', layer: '0', colorIndex: 1, flag: 512, vertices: [{ x: 1, y: 0, bulge: 0.5 }, { x: 2, y: 0, bulge: 0 }], extrusionDirection: neg },
        { type: 'INSERT', layer: '0', name: 'B', insertionPoint: { x: 5, y: 1 }, xScale: 1, yScale: 1, rotation: 0.3, extrusionDirection: neg, attribs: [] },
        { type: 'LINE', layer: '0', startPoint: { x: 1, y: 1 }, endPoint: { x: 2, y: 2 }, extrusionDirection: neg },
        { type: 'MYSTERY', layer: '0' },
      ],
    };
    const d = normalizeDrawing(db, 'fake.dwg', '2004');
    const [arc, pl, ins, line] = d.entities;
    expect(arc.c).toEqual([-10, 0]);
    expect(arc.a0).toBeCloseTo(Math.PI / 2, 5);   // (π - end, π - start)
    expect(arc.a1).toBeCloseTo(Math.PI, 5);
    expect(pl).toMatchObject({ closed: true, color: 1, pts: [[-1, 0, -0.5], [-2, 0]] });
    expect(ins).toMatchObject({ p: [-5, 1], sx: -1, sy: 1, rot: -0.3 });
    expect(line).toMatchObject({ a: [1, 1], b: [2, 2] });   // LINE is already WCS
    expect(d.stats.unsupported).toEqual({ MYSTERY: 1 });
    expect(Object.keys(d.blocks)).toEqual(['B']);
  });
});
