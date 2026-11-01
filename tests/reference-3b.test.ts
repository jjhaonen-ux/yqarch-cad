/**
 * AutoCAD reference cases for OFFSET and TRIM (Phase 3B acceptance: 10 + 10).
 *
 * The expected values were derived by hand from AutoCAD's documented behaviour (OFFSETGAPTYPE = 0: outside corners of
 * polylines are extended to sharp corners, inside corners are cut, collapsed loops disappear; TRIM removes the picked
 * piece between the nearest cutting edges, a circle needs two intersections and becomes an arc, a closed polyline
 * becomes an open polyline, EDGEMODE = 1 uses the implied extension of the cutting edges). They were NOT produced by
 * running AutoCAD; see PHASE3B-STATUS.md.
 */
import { describe, expect, it } from 'vitest';
import { offsetCurve, offsetSideSign, distanceToCurve, trimByPicks, trimByPredicate } from '../src/engine/geom/modify';
import { edgeIntersections, type Edge } from '../src/engine/geom/curve';
import type { Entity, NewEntity, Pt } from '../src/engine/types';

const L = (id: number, a: Pt, b: Pt): Entity => ({ id, type: 'LINE', layer: '0', a, b });
const PL = (id: number, pts: number[][], closed: boolean): Entity => ({ id, type: 'LWPOLYLINE', layer: '0', pts, closed });
const C = (id: number, c: Pt, r: number): Entity => ({ id, type: 'CIRCLE', layer: '0', c, r });
const A = (id: number, c: Pt, r: number, d0: number, d1: number): Entity => ({ id, type: 'ARC', layer: '0', c, r, a0: (d0 * Math.PI) / 180, a1: (d1 * Math.PI) / 180 });
const r4 = (v: number) => Math.round(v * 1e4) / 1e4 + 0;
const pts = (e: NewEntity) => (e.type === 'LWPOLYLINE' ? e.pts.map((p) => [r4(p[0]), r4(p[1]), r4(p[2] ?? 0)]) : []);
/** Same closed vertex cycle, independent of the starting vertex. */
function sameCycle(actual: number[][], expected: number[][]) {
  expect(actual.length).toBe(expected.length);
  const k = actual.findIndex((p) => p[0] === expected[0][0] && p[1] === expected[0][1]);
  expect(k).toBeGreaterThanOrEqual(0);
  const rot = [...actual.slice(k), ...actual.slice(0, k)];
  expect(rot).toEqual(expected);
}
const offsetAt = (e: Entity, d: number, side: Pt) => offsetCurve(e, offsetSideSign(e, side) * d);
const deg = (r: number) => r4((((r * 180) / Math.PI) % 360 + 360) % 360);

describe('AutoCAD reference: OFFSET', () => {
  it('O1 line, distance 10 to the left side', () => {
    const [r] = offsetAt(L(1, [0, 0], [100, 0]), 10, [50, 5]);
    expect(r).toMatchObject({ type: 'LINE', a: [0, 10], b: [100, 10] });
  });
  it('O2 circle outside and inside', () => {
    expect(offsetAt(C(1, [0, 0], 50), 10, [70, 0])[0]).toMatchObject({ type: 'CIRCLE', r: 60 });
    expect(offsetAt(C(1, [0, 0], 50), 10, [10, 0])[0]).toMatchObject({ type: 'CIRCLE', r: 40 });
    expect(offsetAt(C(1, [0, 0], 5), 10, [1, 0])).toEqual([]); // "Cannot offset that object"
  });
  it('O3 arc keeps its angles, radius changes', () => {
    const [r] = offsetAt(A(1, [0, 0], 50, 0, 90), 10, [60, 60]);
    expect(r.type).toBe('ARC');
    if (r.type === 'ARC') { expect(r.r).toBeCloseTo(60); expect(deg(r.a0)).toBe(0); expect(deg(r.a1)).toBe(90); }
  });
  it('O4 closed rectangle inward', () => {
    const r = offsetAt(PL(1, [[0, 0], [100, 0], [100, 50], [0, 50]], true), 10, [50, 25]);
    expect(r).toHaveLength(1);
    sameCycle(pts(r[0]), [[10, 10, 0], [90, 10, 0], [90, 40, 0], [10, 40, 0]]);
  });
  it('O5 closed rectangle outward has sharp (extended) corners', () => {
    const r = offsetAt(PL(1, [[0, 0], [100, 0], [100, 50], [0, 50]], true), 10, [50, -30]);
    sameCycle(pts(r[0]), [[-10, -10, 0], [110, -10, 0], [110, 60, 0], [-10, 60, 0]]);
  });
  it('O6 inward offset larger than half the width collapses (no object)', () => {
    expect(offsetAt(PL(1, [[0, 0], [100, 0], [100, 50], [0, 50]], true), 25, [50, 25])).toEqual([]);
    expect(offsetAt(PL(1, [[0, 0], [100, 0], [100, 50], [0, 50]], true), 30, [50, 25])).toEqual([]);
  });
  it('O7 open L-shaped polyline towards the inside corner', () => {
    const r = offsetAt(PL(1, [[0, 0], [100, 0], [100, 100]], false), 10, [50, 50]);
    expect(pts(r[0])).toEqual([[0, 10, 0], [90, 10, 0], [90, 100, 0]]);
    expect((r[0] as { closed: boolean }).closed).toBe(false);
  });
  it('O8 slot (lines + half circles) outward and inward', () => {
    const slot = PL(1, [[0, 0, 0], [100, 0, 1], [100, 40, 0], [0, 40, 1]], true);
    sameCycle(pts(offsetAt(slot, 10, [50, -30])[0]), [[0, -10, 0], [100, -10, 1], [100, 50, 0], [0, 50, 1]]);
    sameCycle(pts(offsetAt(slot, 10, [50, 20])[0]), [[0, 10, 0], [100, 10, 1], [100, 30, 0], [0, 30, 1]]);
    expect(offsetAt(slot, 20, [50, 20])).toEqual([]);
  });
  it('O9 line followed by a tangent arc keeps tangency and bulge', () => {
    const b = Math.tan(Math.PI / 8);
    const r = offsetAt(PL(1, [[0, 0, 0], [50, 0, b], [100, 50, 0]], false), 10, [40, 20]);
    expect(pts(r[0])).toEqual([[0, 10, 0], [50, 10, r4(b)], [90, 50, 0]]);
  });
  it('O10 a narrow notch is closed by an outward offset wider than half the notch', () => {
    const notch = PL(1, [[0, 0], [100, 0], [100, 100], [55, 100], [55, 60], [45, 60], [45, 100], [0, 100]], true);
    sameCycle(pts(offsetAt(notch, 6, [50, 200])[0]), [[-6, -6, 0], [106, -6, 0], [106, 106, 0], [-6, 106, 0]]);
    sameCycle(pts(offsetAt(notch, 4, [50, 200])[0]), [[-4, -4, 0], [104, -4, 0], [104, 104, 0], [51, 104, 0], [51, 64, 0], [49, 64, 0], [49, 104, 0], [-4, 104, 0]]);
  });
  it('O11 Through: the distance is the distance to the picked point', () => {
    const line = L(1, [0, 0], [100, 0]);
    expect(distanceToCurve(line, [30, -7])).toBeCloseTo(7);
    expect(offsetAt(line, distanceToCurve(line, [30, -7]), [30, -7])[0]).toMatchObject({ a: [0, -7], b: [100, -7] });
  });
  it('O12 a dumbbell splits into two closed loops when the neck vanishes', () => {
    const db = PL(1, [[0, 0], [40, 0], [40, 18], [60, 18], [60, 0], [100, 0], [100, 40], [60, 40], [60, 22], [40, 22], [40, 40], [0, 40]], true);
    const r = offsetAt(db, 5, [20, 20]);
    expect(r).toHaveLength(2);
    expect(r.every((e) => e.type === 'LWPOLYLINE' && e.closed && e.pts.length === 4)).toBe(true);
  });
});

describe('AutoCAD reference: TRIM', () => {
  const cutX5 = L(9, [5, -5], [5, 5]);
  it('T1 pick left of the cutting edge removes the left piece', () => {
    expect(trimByPicks(L(1, [0, 0], [10, 0]), [[2, 0]], [cutX5])).toEqual([{ type: 'LINE', layer: '0', a: [5, 0], b: [10, 0] }]);
  });
  it('T2 pick right of the cutting edge removes the right piece', () => {
    expect(trimByPicks(L(1, [0, 0], [10, 0]), [[8, 0]], [cutX5])).toEqual([{ type: 'LINE', layer: '0', a: [0, 0], b: [5, 0] }]);
  });
  it('T3 the middle piece between two edges is removed and the line splits in two', () => {
    const r = trimByPicks(L(1, [0, 0], [10, 0]), [[5, 0]], [L(8, [3, -1], [3, 1]), L(9, [7, -1], [7, 1])])!;
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ a: [0, 0], b: [3, 0] });
    expect(r[1]).toMatchObject({ a: [7, 0], b: [10, 0] });
  });
  it('T4 a circle cut by a line becomes the arc on the other side of the pick', () => {
    const [r] = trimByPicks(C(1, [0, 0], 10), [[-10, 0]], [L(9, [0, -20], [0, 20])])!;
    expect(r.type).toBe('ARC');
    if (r.type === 'ARC') { expect(deg(r.a0)).toBe(270); expect(deg(r.a1)).toBe(90); expect(r.r).toBe(10); }
  });
  it('T5 a circle with only one intersection cannot be trimmed', () => {
    expect(trimByPicks(C(1, [0, 0], 10), [[-10, 0]], [L(9, [0, 0], [20, 0])])).toBeNull();
  });
  it('T6 a closed polyline becomes an open polyline (wrap-around)', () => {
    const [r] = trimByPicks(PL(1, [[0, 0], [10, 0], [10, 10], [0, 10]], true), [[2, 0]], [L(9, [5, -5], [5, 15])])!;
    expect(r.type).toBe('LWPOLYLINE');
    if (r.type === 'LWPOLYLINE') { expect(r.closed).toBe(false); expect(pts(r)).toEqual([[5, 0, 0], [10, 0, 0], [10, 10, 0], [5, 10, 0]]); }
  });
  it('T7 Edge mode Extend uses the implied extension of the cutting edge', () => {
    const short = L(9, [5, 5], [5, 8]);
    expect(trimByPicks(L(1, [0, 0], [10, 0]), [[2, 0]], [short])).toBeNull();
    expect(trimByPicks(L(1, [0, 0], [10, 0]), [[2, 0]], [short], { extendEdges: true })).toEqual([{ type: 'LINE', layer: '0', a: [5, 0], b: [10, 0] }]);
  });
  it('T8 an arc keeps the part away from the pick and stays an arc', () => {
    const [r] = trimByPicks(A(1, [0, 0], 10, 0, 180), [[Math.SQRT1_2 * 10, Math.SQRT1_2 * 10]], [L(9, [0, -20], [0, 20])])!;
    expect(r.type).toBe('ARC');
    if (r.type === 'ARC') { expect(deg(r.a0)).toBe(90); expect(deg(r.a1)).toBe(180); }
  });
  it('T9 Quick mode deletes an object that no edge crosses; Standard reports nothing to trim', () => {
    expect(trimByPicks(L(1, [0, 0], [10, 0]), [[2, 0]], [L(9, [20, -1], [20, 1])], { quick: true })).toEqual([]);
    expect(trimByPicks(L(1, [0, 0], [10, 0]), [[2, 0]], [L(9, [20, -1], [20, 1])])).toBeNull();
  });
  it('T10 Fence trims the crossed piece of every object', () => {
    const fence: Edge = { a: [8, -1], b: [8, 3], bulge: 0 };
    const hit = (edges: Edge[]) => edges.some((e) => edgeIntersections(e, fence).length > 0);
    const cut = L(9, [5, -5], [5, 5]);
    expect(trimByPredicate(L(1, [0, 0], [10, 0]), [cut], hit)).toEqual([{ type: 'LINE', layer: '0', a: [0, 0], b: [5, 0] }]);
    expect(trimByPredicate(L(2, [0, 2], [10, 2]), [cut], hit)).toEqual([{ type: 'LINE', layer: '0', a: [0, 2], b: [5, 2] }]);
  });
  it('T11 an open polyline is trimmed on its picked segment', () => {
    const [r] = trimByPicks(PL(1, [[0, 0], [10, 0], [10, 10]], false), [[10, 8]], [L(9, [5, 5], [15, 5])])!;
    expect(pts(r)).toEqual([[0, 0, 0], [10, 0, 0], [10, 5, 0]]);
  });
  it('T12 a bulged polyline segment is cut on the arc and keeps a partial bulge', () => {
    // half circle from (0,0) to (20,0) through (10,-10) (bulge 1, clockwise below → CCW from left to right)
    const [r] = trimByPicks(PL(1, [[0, 0, 1], [20, 0, 0]], false), [[17.07, -7.07]], [L(9, [10, -20], [10, 5])])!;
    const p = pts(r);
    expect(p[0].slice(0, 2)).toEqual([0, 0]);
    expect(p[1].slice(0, 2)).toEqual([10, -10]);
    expect(p[0][2]).toBeCloseTo(Math.tan(Math.PI / 8), 4);
  });
});
