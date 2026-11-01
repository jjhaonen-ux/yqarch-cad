/** Phase 3B geometry operations and command-level regression coverage. */
import { describe, expect, it } from 'vitest';
import { CadDocument } from '../src/engine/model/document';
import { registerAll } from '../src/engine/commands';
import { CommandEngine, runScript } from '../src/engine/commands/engine';
import { intersections, offsetEntity, offsetPolyline, pathEdges, pointOnEdge, parameterOnEdge, trimEntityAt, extendEntityAt, filletLines, chamferLines, breakEntityAt, joinCurves, stretchEntity } from '../src/engine/geom/modify';
import type { Entity, PolylineEnt, Pt } from '../src/engine/types';

const cases = Array.from({ length: 60 }, (_, i) => i + 1);
const line = (id: number, a: Pt, b: Pt): Entity => ({ id, type: 'LINE', layer: '0', a, b });

describe('analytic line intersections', () => {
  it.each(cases)('finds finite line crossings in case %i', (n) => {
    const y = n * 0.75, x = n * 1.25;
    const a = line(1, [-2 * x, y], [2 * x, y]);
    const b = line(2, [x, -3 * y], [x, 3 * y]);
    expect(intersections(a, b)).toHaveLength(1);
    expect(intersections(a, b)[0]).toEqual([x, y]);
  });
});

describe('offset line geometry', () => {
  it.each(cases)('keeps the requested signed perpendicular distance in case %i', (n) => {
    const amount = n / 7;
    const source = line(3, [0, 0], [100, 0]);
    const result = offsetEntity(source, amount);
    expect(result?.type).toBe('LINE');
    if (result?.type === 'LINE') {
      expect(result.a[1]).toBeCloseTo(amount, 9);
      expect(result.b[1]).toBeCloseTo(amount, 9);
      expect(result.a[0]).toBe(0);
      expect(result.b[0]).toBe(100);
    }
  });
});

describe('point/parameter round trips', () => {
  it.each(cases)('maps line point parameters consistently in case %i', (n) => {
    const edge = pathEdges(line(4, [0, 0], [n * 2, n * 3]))[0];
    const t = n / 61, p = pointOnEdge(edge, t);
    expect(parameterOnEdge(edge, p)).toBeCloseTo(t, 10);
  });
});

describe('trim and extend', () => {
  it.each(cases)('trims to the picked side of a crossing in case %i', (n) => {
    const target = line(1, [0, 0], [100, 0]);
    const cutter = line(2, [n, -10], [n, 10]);
    const result = trimEntityAt(target, [n / 3, 0], [cutter]);
    expect(result).toHaveLength(1);
    expect(result?.[0].type).toBe('LINE');
    if (result?.[0].type === 'LINE') {
      expect(result[0].a[0]).toBeCloseTo(n, 8);
      expect(result[0].b[0]).toBe(100);
    }
    const extended = extendEntityAt(line(5, [0, 0], [10, 0]), [9, 0], [line(6, [n + 10, -5], [n + 10, 5])]);
    expect(extended?.type).toBe('LINE');
    if (extended?.type === 'LINE') expect(extended.b[0]).toBeCloseTo(n + 10, 8);
  });
});

describe('arc and polyline geometry', () => {
  it('finds two line-circle intersections and limits finite arc intersections', () => {
    const circle: Entity = { id: 1, type: 'CIRCLE', layer: '0', c: [0, 0], r: 10 };
    const horizontal = line(2, [-20, 0], [20, 0]);
    expect(intersections(circle, horizontal)).toHaveLength(2);
    const quarter: Entity = { id: 3, type: 'ARC', layer: '0', c: [0, 0], r: 10, a0: 0, a1: Math.PI / 2 };
    expect(intersections(quarter, horizontal)).toHaveLength(1);
  });

  it('offsets a cornered polyline with a miter and preserves its layer', () => {
    const source: PolylineEnt = { id: 7, type: 'LWPOLYLINE', layer: 'WALL', pts: [[0, 0], [10, 0], [10, 10]], closed: false };
    const result = offsetPolyline(source, 1);
    expect(result?.type).toBe('LWPOLYLINE');
    if (result?.type === 'LWPOLYLINE') {
      expect(result.layer).toBe('WALL');
      expect(result.pts).toHaveLength(3);
      expect(result.pts[0].slice(0, 2)).toEqual([0, 1]);
      expect(result.pts[1].slice(0, 2)).toEqual([9, 1]);
      expect(result.pts[2].slice(0, 2)).toEqual([9, 10]);
    }
  });

  it('offsets a semicircle inward by reducing its radius', () => {
    const source: Entity = { id: 8, type: 'ARC', layer: '0', c: [0, 0], r: 10, a0: 0, a1: Math.PI };
    const result = offsetEntity(source, 2);
    expect(result?.type).toBe('ARC');
    if (result?.type === 'ARC') expect(result.r).toBe(8);
  });

  it('trims a bulge polyline and preserves bulge data on retained fragments', () => {
    const target: Entity = { id: 9, type: 'LWPOLYLINE', layer: '0', pts: [[0, 0, 0.5], [20, 0]], closed: false };
    const cutter = line(10, [10, -20], [10, 20]);
    const result = trimEntityAt(target, [5, 0], [cutter]);
    expect(result?.length).toBe(1);
    expect(result?.[0].type).toBe('LWPOLYLINE');
    if (result?.[0].type === 'LWPOLYLINE') expect(result[0].pts[0][2]).not.toBe(0);
  });
});

describe('corner treatments and splitting', () => {
  const h = { id: 1, type: 'LINE' as const, layer: '0', a: [0, 0] as Pt, b: [10, 0] as Pt };
  const v = { id: 2, type: 'LINE' as const, layer: '0', a: [10, 0] as Pt, b: [10, 10] as Pt };

  it('creates a tangent fillet and trims both source lines', () => {
    const result = filletLines(h, v, 1);
    expect(result).not.toBeNull();
    expect(result?.arc.type).toBe('ARC');
    if (result?.arc.type === 'ARC') {
      expect(result.arc.r).toBe(1);
      expect(result.arc.c[0]).toBeCloseTo(9);
      expect(result.arc.c[1]).toBeCloseTo(1);
    }
    expect(result?.a.type === 'LINE' && result.a.b[0]).toBeCloseTo(9);
    expect(result?.b.type === 'LINE' && result.b.a[1]).toBeCloseTo(1);
  });

  it('chamfers line corners with independent distances', () => {
    const result = chamferLines(h, v, 2, 3);
    expect(result).not.toBeNull();
    expect(result?.line).toMatchObject({ type: 'LINE', a: [8, 0], b: [10, 3] });
  });

  it('breaks an open line into the two surviving intervals', () => {
    const result = breakEntityAt(line(1, [0, 0], [10, 0]), [3, 0], [7, 0]);
    expect(result).toHaveLength(2);
    expect(result?.map((x) => x.type)).toEqual(['LINE', 'LINE']);
  });

  it('joins collinear reversed and forward line segments into one LINE (AutoCAD)', () => {
    const joined = joinCurves([line(1, [0, 0], [5, 0]), line(2, [10, 0], [5, 0])], 1e-6);
    expect(joined).toHaveLength(1);
    expect(joined[0].type).toBe('LINE');
    if (joined[0].type === 'LINE') expect([joined[0].a, joined[0].b]).toEqual([[0, 0], [10, 0]]);
  });
});

describe('stretch control vertices', () => {
  it('moves only endpoints inside the crossing selection rectangle', () => {
    const source = line(1, [0, 0], [10, 0]);
    const result = stretchEntity(source, [-1, -1, 4, 1], [0, 5]);
    expect(result.type).toBe('LINE');
    if (result.type === 'LINE') expect([result.a, result.b]).toEqual([[0, 5], [10, 0]]);
  });
});

describe('registered command integration', () => {
  it('registers every Phase 3B command', () => {
    const c = registerAll(new CommandEngine(new CadDocument(), { pick: () => null, windowSelect: () => [] }));
    for (const name of ['OFFSET', 'TRIM', 'EXTEND', 'FILLET', 'CHAMFER', 'ARRAY', 'STRETCH', 'BREAK', 'JOIN']) {
      expect(c.resolve(name).def?.name).toBe(name);
    }
  });

  it('runs rectangular ARRAY as one undoable command', async () => {
    const doc = new CadDocument(), source = doc.add({ type: 'LINE', layer: '0', a: [0, 0], b: [1, 0] });
    const c = registerAll(new CommandEngine(doc, { pick: () => source.id, windowSelect: () => [source.id] }));
    c.selection.add(source.id);
    await runScript(c, 'ARRAY', ['R', '2', '2', '10', '20']);
    expect(doc.size).toBe(4);
    doc.undo();
    expect(doc.size).toBe(1);
  });

  it('runs OFFSET interactively and records one undo group', async () => {
    const doc = new CadDocument(), source = doc.add({ type: 'LINE', layer: '0', a: [0, 0], b: [10, 0] });
    const c = registerAll(new CommandEngine(doc, { pick: () => source.id, windowSelect: () => [source.id] }));
    await runScript(c, 'OFFSET', ['2', { p: [5, 0] }, { p: [5, 4] }, 'E']);
    expect(doc.size).toBe(2);
    const shifted = [...doc.entities.values()].find((e) => e.id !== source.id);
    expect(shifted?.type).toBe('LINE');
    if (shifted?.type === 'LINE') expect(shifted.a[1]).toBeCloseTo(2);
    doc.undo();
    expect(doc.size).toBe(1);
  });

  it('runs TRIM from a preselected boundary and trims at the picked side', async () => {
    const doc = new CadDocument();
    const target = doc.add({ type: 'LINE', layer: '0', a: [0, 0], b: [10, 0] });
    const cutter = doc.add({ type: 'LINE', layer: '0', a: [5, -2], b: [5, 2] });
    const c = registerAll(new CommandEngine(doc, { pick: () => target.id, windowSelect: () => [target.id, cutter.id] }));
    c.selection.add(cutter.id);
    await runScript(c, 'TRIM', [{ p: [2, 0] }, '']);
    const result = doc.get(target.id);
    expect(result?.type).toBe('LINE');
    if (result?.type === 'LINE') expect(result.a[0]).toBeCloseTo(5);
    doc.undo();
    expect((doc.get(target.id) as Entity & { a: Pt }).a).toEqual([0, 0]);
  });
});