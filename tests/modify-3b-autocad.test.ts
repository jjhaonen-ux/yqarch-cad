/** Phase 3B — AutoCAD behaviour of EXTEND, FILLET, CHAMFER, BREAK, JOIN, STRETCH, ARRAY and the interactive commands. */
import { describe, expect, it } from 'vitest';
import { CadDocument } from '../src/engine/model/document';
import { runScript } from '../src/engine/commands/engine';
import { BUILTIN_ALIASES } from '../src/engine/commands/aliases';
import { breakEntity, extendByPick, joinEntities, stretchEntity } from '../src/engine/geom/modify';
import { chamfer, chamferPolyline, fillet, filletPolyline } from '../src/engine/geom/corner';
import { polarAngles, referencePoint } from '../src/engine/commands/modify3b';
import { engineWithHost } from './helpers-3a';
import type { Entity, NewEntity, PolylineEnt, Pt } from '../src/engine/types';

const L = (id: number, a: Pt, b: Pt, layer = '0'): Entity => ({ id, type: 'LINE', layer, a, b });
const PL = (id: number, pts: number[][], closed: boolean): PolylineEnt => ({ id, type: 'LWPOLYLINE', layer: '0', pts, closed });
const C = (id: number, c: Pt, r: number): Entity => ({ id, type: 'CIRCLE', layer: '0', c, r });
const A = (id: number, c: Pt, r: number, d0: number, d1: number): Entity => ({ id, type: 'ARC', layer: '0', c, r, a0: (d0 * Math.PI) / 180, a1: (d1 * Math.PI) / 180 });
const r4 = (v: number) => Math.round(v * 1e4) / 1e4 + 0;
const P = (p: Pt) => [r4(p[0]), r4(p[1])];
const deg = (r: number) => r4((((r * 180) / Math.PI) % 360 + 360) % 360);
const pts = (e: NewEntity | Entity) => (e.type === 'LWPOLYLINE' ? e.pts.map((p) => [r4(p[0]), r4(p[1]), r4(p[2] ?? 0)]) : []);
const lineOf = (e: NewEntity | undefined) => (e && e.type === 'LINE' ? [P(e.a), P(e.b)] : null);

describe('EXTEND', () => {
  const wall = L(9, [10, -5], [10, 5]);
  it('extends the end nearest the pick to the boundary', () => expect(lineOf(extendByPick(L(1, [0, 0], [5, 0]), [4, 0], [wall])!)).toEqual([[0, 0], [10, 0]]));
  it('extends the start when the pick is nearer the start', () => expect(lineOf(extendByPick(L(1, [0, 0], [5, 0]), [1, 0], [L(9, [-3, -5], [-3, 5])])!)).toEqual([[-3, 0], [5, 0]]));
  it('stops at the nearest of several boundaries', () => expect(lineOf(extendByPick(L(1, [0, 0], [5, 0]), [4, 0], [L(8, [12, -5], [12, 5]), L(9, [8, -5], [8, 5])])!)).toEqual([[0, 0], [8, 0]]));
  it('returns null when nothing is in the way', () => expect(extendByPick(L(1, [0, 0], [5, 0]), [4, 0], [L(9, [-3, -5], [-3, 5])])).toBeNull());
  it('ignores boundaries behind the extended end', () => expect(extendByPick(L(1, [0, 0], [5, 0]), [4, 0], [L(9, [2, -5], [2, 5])])).toBeNull());
  it('uses the implied extension of the boundary in Edge=Extend mode', () => {
    const short = L(9, [10, 2], [10, 5]);
    expect(extendByPick(L(1, [0, 0], [5, 0]), [4, 0], [short])).toBeNull();
    expect(lineOf(extendByPick(L(1, [0, 0], [5, 0]), [4, 0], [short], { extendEdges: true })!)).toEqual([[0, 0], [10, 0]]);
  });
  it('extends an arc along its circle (start end, clockwise)', () => {
    const r = extendByPick(A(1, [0, 0], 10, 0, 90), polar(10, 10), [L(9, [0, -5], [20, -5])])!;
    expect(r.type).toBe('ARC');
    if (r.type === 'ARC') { expect(deg(r.a0)).toBe(330); expect(deg(r.a1)).toBe(90); }
  });
  it('extends an arc end counter-clockwise to a line', () => {
    const r = extendByPick(A(1, [0, 0], 10, 0, 90), polar(10, 80), [L(9, [-20, 5], [0, 5])])!;
    if (r.type === 'ARC') { expect(deg(r.a0)).toBe(0); expect(deg(r.a1)).toBe(150); }
  });
  it('extends the last segment of an open polyline', () => {
    const r = extendByPick(PL(1, [[0, 0], [10, 0], [10, 5]], false), [10, 4], [L(9, [0, 20], [20, 20])])!;
    expect(pts(r)).toEqual([[0, 0, 0], [10, 0, 0], [10, 20, 0]]);
  });
  it('extends the first segment of an open polyline', () => {
    const r = extendByPick(PL(1, [[0, 0], [10, 0], [10, 5]], false), [1, 0], [L(9, [-4, -5], [-4, 5])])!;
    expect(pts(r)).toEqual([[-4, 0, 0], [10, 0, 0], [10, 5, 0]]);
  });
  it('extends a line to a circle', () => expect(lineOf(extendByPick(L(1, [0, 0], [5, 0]), [4, 0], [C(9, [20, 0], 5)])!)).toEqual([[0, 0], [15, 0]]));
  it('does not extend closed polylines or circles', () => {
    expect(extendByPick(C(1, [0, 0], 5), [5, 0], [wall])).toBeNull();
    expect(extendByPick(PL(1, [[0, 0], [5, 0], [5, 5]], true), [5, 1], [wall])).toBeNull();
  });
});
function polar(r: number, d: number): Pt { return [r * Math.cos((d * Math.PI) / 180), r * Math.sin((d * Math.PI) / 180)]; }

describe('FILLET', () => {
  const h = L(1, [0, 0], [12, 0]), v = L(2, [10, -2], [10, 10]);
  const get = (r: ReturnType<typeof fillet>, id: number) => (r.ok ? r.updates.find((u) => u.id === id)?.ent : undefined);
  it('keeps the picked sides of two crossing lines', () => {
    const r = fillet({ ent: h, p: [2, 0] }, { ent: v, p: [10, 8] }, 2);
    expect(r.ok).toBe(true);
    expect(lineOf(get(r, 1))).toEqual([[0, 0], [8, 0]]);
    expect(lineOf(get(r, 2))).toEqual([[10, 2], [10, 10]]);
    if (r.ok && r.corner?.type === 'ARC') { expect(P(r.corner.c)).toEqual([8, 2]); expect(deg(r.corner.a0)).toBe(270); expect(deg(r.corner.a1)).toBe(0); }
  });
  it('picking the other sides fillets the opposite quadrant', () => {
    const r = fillet({ ent: h, p: [11.5, 0] }, { ent: v, p: [10, -1.5] }, 0.5);
    expect(lineOf(get(r, 1))).toEqual([[10.5, 0], [12, 0]]);
    expect(lineOf(get(r, 2))).toEqual([[10, -2], [10, -0.5]]);
    if (r.ok && r.corner?.type === 'ARC') expect(P(r.corner.c)).toEqual([10.5, -0.5]);
  });
  it('radius 0 extends both lines to a sharp corner', () => {
    const r = fillet({ ent: L(1, [0, 0], [5, 0]), p: [1, 0] }, { ent: L(2, [10, 2], [10, 10]), p: [10, 8] }, 0);
    expect(r.ok && r.corner).toBe(null);
    expect(lineOf(get(r, 1))).toEqual([[0, 0], [10, 0]]);
    expect(lineOf(get(r, 2))).toEqual([[10, 0], [10, 10]]);
  });
  it('parallel lines get a semicircle and the second line is extended', () => {
    const r = fillet({ ent: L(1, [0, 0], [10, 0]), p: [9, 0] }, { ent: L(2, [0, 4], [8, 4]), p: [7, 4] }, 99);
    expect(r.ok).toBe(true);
    expect(lineOf(get(r, 2))).toEqual([[0, 4], [10, 4]]);
    if (r.ok && r.corner?.type === 'ARC') { expect(P(r.corner.c)).toEqual([10, 2]); expect(r.corner.r).toBeCloseTo(2); expect(deg(r.corner.a0)).toBe(270); expect(deg(r.corner.a1)).toBe(90); }
  });
  it('reports a radius that is too large', () => {
    const r = fillet({ ent: L(1, [0, 0], [3, 0]), p: [1, 0] }, { ent: L(2, [3, 0], [3, 3]), p: [3, 2] }, 10);
    expect(r).toEqual({ ok: false, error: 'radius' });
  });
  it('fillets a line and a circle without trimming the circle', () => {
    const r = fillet({ ent: L(1, [-20, 0], [20, 0]), p: [-15, 0] }, { ent: C(2, [0, 6], 5), p: [-5, 6] }, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.updates.map((u) => u.id)).toEqual([1]);
    const arc = r.corner!;
    expect(arc.type).toBe('ARC');
    if (arc.type === 'ARC') { expect(arc.r).toBe(1); expect(arc.c[1]).toBeCloseTo(1); expect(Math.hypot(arc.c[0], arc.c[1] - 6)).toBeCloseTo(6); expect(arc.c[0]).toBeLessThan(0); }
    const l = get(r, 1);
    if (l?.type === 'LINE') { expect(l.a).toEqual([-20, 0]); expect(l.b[0]).toBeCloseTo(-Math.sqrt(11)); }
  });
  it('fillets a line and an arc and trims the arc', () => {
    const r = fillet({ ent: L(1, [-20, 0], [20, 0]), p: [15, 0] }, { ent: A(2, [0, 0], 10, 30, 150), p: polar(10, 60) }, 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const arc = get(r, 2), f = r.corner!;
    if (f.type === 'ARC') { expect(f.c[1]).toBeCloseTo(2); expect(Math.hypot(f.c[0], f.c[1])).toBeCloseTo(12); expect(f.c[0]).toBeGreaterThan(0); }
    if (arc?.type === 'ARC') { expect(deg(arc.a1)).toBe(150); expect(deg(arc.a0)).toBeCloseTo(deg(Math.atan2(2, Math.sqrt(140))), 3); }
  });
  it('the fillet arc is tangent-continuous with both kept parts', () => {
    const r = fillet({ ent: L(1, [0, 0], [10, 0]), p: [2, 0] }, { ent: L(2, [0, 0], [10, 10]), p: [8, 8] }, 3);
    if (!r.ok || r.corner?.type !== 'ARC') throw new Error('no arc');
    const a = r.corner, sweep = ((a.a1 - a.a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    expect(sweep).toBeCloseTo((135 * Math.PI) / 180);
  });
  it('Trim=No trim leaves the objects and only adds the arc', () => {
    const r = fillet({ ent: h, p: [2, 0] }, { ent: v, p: [10, 8] }, 2, { trim: false });
    expect(r.ok && r.updates.length).toBe(0);
    expect(r.ok && r.add.length).toBe(1);
  });
  it('the arc keeps the shared layer, otherwise goes to the current layer', () => {
    const same = fillet({ ent: L(1, [0, 0], [12, 0], 'W'), p: [2, 0] }, { ent: L(2, [10, -2], [10, 10], 'W'), p: [10, 8] }, 2);
    const diff = fillet({ ent: L(1, [0, 0], [12, 0], 'W'), p: [2, 0] }, { ent: L(2, [10, -2], [10, 10], 'X'), p: [10, 8] }, 2);
    expect(same.ok && same.corner?.layer).toBe('W');
    expect(diff.ok && diff.corner?.layer).toBe('');
  });
  it('fillets two adjacent segments of the same polyline', () => {
    const pl = PL(1, [[0, 0], [10, 0], [10, 10]], false);
    const r = fillet({ ent: pl, p: [5, 0] }, { ent: pl, p: [10, 5] }, 2);
    expect(r.ok).toBe(true);
    if (r.ok) expect(pts(r.updates[0].ent)).toEqual([[0, 0, 0], [8, 0, r4(Math.tan(Math.PI / 8))], [10, 2, 0], [10, 10, 0]]);
  });
  it('merges the arc into an open polyline when its end segment is filleted with a line', () => {
    const pl = PL(1, [[0, 0], [10, 0]], false);
    const r = fillet({ ent: pl, p: [5, 0] }, { ent: L(2, [12, 2], [12, 10]), p: [12, 8] }, 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.add).toEqual([]);
    expect(pts(r.updates.find((u) => u.id === 1)!.ent)).toEqual([[0, 0, 0], [10, 0, r4(Math.tan(Math.PI / 8))], [12, 2, 0]]);
    expect(lineOf(get(r, 2))).toEqual([[12, 2], [12, 10]]);
  });
  it('rejects a middle segment of a polyline with another object', () => {
    const pl = PL(1, [[0, 0], [10, 0], [10, 10], [20, 10]], false);
    expect(fillet({ ent: pl, p: [10, 5] }, { ent: L(2, [0, 5], [5, 5]), p: [2, 5] }, 1)).toEqual({ ok: false, error: 'notEndSegment' });
  });
  it('Polyline option rounds every line-line vertex of a rectangle', () => {
    const r = filletPolyline(PL(1, [[0, 0], [10, 0], [10, 10], [0, 10]], true), 2);
    expect(r.count).toBe(4);
    const b = r4(Math.tan(Math.PI / 8));
    expect(pts(r.ent)).toEqual([[0, 2, b], [2, 0, 0], [8, 0, b], [10, 2, 0], [10, 8, b], [8, 10, 0], [2, 10, b], [0, 8, 0]]);
  });
  it('Polyline option skips corners whose segments are too short', () => {
    const r = filletPolyline(PL(1, [[0, 0], [3, 0], [3, 3], [10, 3]], false), 2);
    expect(r.count).toBe(1);
    expect(r.tooShort).toBe(1);
  });
});

describe('CHAMFER', () => {
  const h = L(1, [0, 0], [10, 0]), v = L(2, [10, 0], [10, 10]);
  it('Distance method trims both lines and adds the bevel', () => {
    const r = chamfer({ ent: h, p: [5, 0] }, { ent: v, p: [10, 5] }, { method: 'distance', d1: 2, d2: 3 });
    expect(r.ok && lineOf(r.corner!)).toEqual([[8, 0], [10, 3]]);
  });
  it('Angle method: length on the first line and angle from it', () => {
    const r = chamfer({ ent: h, p: [5, 0] }, { ent: v, p: [10, 5] }, { method: 'angle', length: 2, angle: Math.PI / 4 });
    expect(r.ok && lineOf(r.corner!)).toEqual([[8, 0], [10, 2]]);
  });
  it('zero distances give a sharp corner', () => {
    const r = chamfer({ ent: L(1, [0, 0], [5, 0]), p: [1, 0] }, { ent: L(2, [10, 2], [10, 10]), p: [10, 8] }, { method: 'distance', d1: 0, d2: 0 });
    expect(r.ok && r.corner).toBe(null);
  });
  it('parallel lines cannot be chamfered', () => expect(chamfer({ ent: h, p: [5, 0] }, { ent: L(2, [0, 5], [10, 5]), p: [5, 5] }, { method: 'distance', d1: 1, d2: 1 })).toEqual({ ok: false, error: 'parallel' }));
  it('rejects arcs', () => expect(chamfer({ ent: h, p: [5, 0] }, { ent: A(2, [0, 0], 5, 0, 90), p: [0, 5] }, { method: 'distance', d1: 1, d2: 1 }).ok).toBe(false));
  it('Polyline option bevels every vertex', () => {
    const r = chamferPolyline(PL(1, [[0, 0], [10, 0], [10, 10], [0, 10]], true), { method: 'distance', d1: 1, d2: 1 });
    expect(r.count).toBe(4);
    expect(pts(r.ent)).toEqual([[0, 1, 0], [1, 0, 0], [9, 0, 0], [10, 1, 0], [10, 9, 0], [9, 10, 0], [1, 10, 0], [0, 9, 0]]);
  });
  it('adjacent segments of the same polyline', () => {
    const pl = PL(1, [[0, 0], [10, 0], [10, 10]], false);
    const r = chamfer({ ent: pl, p: [5, 0] }, { ent: pl, p: [10, 5] }, { method: 'distance', d1: 2, d2: 3 });
    expect(r.ok && pts(r.updates[0].ent)).toEqual([[0, 0, 0], [8, 0, 0], [10, 3, 0], [10, 10, 0]]);
  });
});

describe('BREAK', () => {
  it('splits a line between two points', () => {
    const r = breakEntity(L(1, [0, 0], [10, 0]), [3, 0], [7, 0])!;
    expect(r.map(lineOf)).toEqual([[[0, 0], [3, 0]], [[7, 0], [10, 0]]]);
  });
  it('projects the points onto the object', () => expect(breakEntity(L(1, [0, 0], [10, 0]), [3, 2], [7, -1])!.map(lineOf)).toEqual([[[0, 0], [3, 0]], [[7, 0], [10, 0]]]));
  it('removes the counter-clockwise part of a circle from the first to the second point', () => {
    const [r] = breakEntity(C(1, [0, 0], 10), [10, 0], [0, 10])!;
    expect(r.type).toBe('ARC');
    if (r.type === 'ARC') { expect(deg(r.a0)).toBe(90); expect(deg(r.a1)).toBe(0); }
    const [s] = breakEntity(C(1, [0, 0], 10), [0, 10], [10, 0])!;
    if (s.type === 'ARC') { expect(deg(s.a0)).toBe(0); expect(deg(s.a1)).toBe(90); }
  });
  it('a circle cannot be broken at a single point', () => expect(breakEntity(C(1, [0, 0], 10), [10, 0], [10, 0])).toBeNull());
  it('removes the part of a closed polyline in vertex direction', () => {
    const [r] = breakEntity(PL(1, [[0, 0], [10, 0], [10, 10], [0, 10]], true), [5, 0], [10, 5])!;
    expect(pts(r)).toEqual([[10, 5, 0], [10, 10, 0], [0, 10, 0], [0, 0, 0], [5, 0, 0]]);
    expect((r as PolylineEnt).closed).toBe(false);
  });
  it('a single point opens a closed polyline there', () => {
    const [r] = breakEntity(PL(1, [[0, 0], [10, 0], [10, 10], [0, 10]], true), [5, 0], [5, 0])!;
    expect(pts(r)).toEqual([[5, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 0], [5, 0, 0]]);
  });
  it('a single point splits an open curve in two', () => expect(breakEntity(L(1, [0, 0], [10, 0]), [4, 0], [4, 0])!.map(lineOf)).toEqual([[[0, 0], [4, 0]], [[4, 0], [10, 0]]]));
  it('a break past the end shortens the object', () => expect(breakEntity(L(1, [0, 0], [10, 0]), [6, 0], [15, 0])!.map(lineOf)).toEqual([[[0, 0], [6, 0]]]));
  it('breaks an arc into two arcs', () => {
    const r = breakEntity(A(1, [0, 0], 10, 0, 180), polar(10, 60), polar(10, 120))!;
    expect(r.map((e) => (e.type === 'ARC' ? [deg(e.a0), deg(e.a1)] : null))).toEqual([[0, 60], [120, 180]]);
  });
});

describe('JOIN', () => {
  it('collinear lines with a gap become one LINE', () => {
    const r = joinEntities([L(1, [0, 0], [4, 0]), L(2, [6, 0], [10, 0])]);
    expect(r.remove).toEqual([1, 2]);
    expect(r.add.map(lineOf)).toEqual([[[0, 0], [10, 0]]]);
  });
  it('arcs on the same circle become one arc counter-clockwise from the source', () => {
    const r = joinEntities([A(1, [0, 0], 5, 0, 90), A(2, [0, 0], 5, 120, 200)]);
    expect(r.add).toHaveLength(1);
    const a = r.add[0];
    if (a.type === 'ARC') { expect(deg(a.a0)).toBe(0); expect(deg(a.a1)).toBe(200); }
  });
  it('arcs completing the circle become a CIRCLE', () => {
    const r = joinEntities([A(1, [0, 0], 5, 0, 180), A(2, [0, 0], 5, 180, 360)]);
    expect(r.add).toEqual([{ type: 'CIRCLE', layer: '0', c: [0, 0], r: 5 }]);
  });
  it('connected line + arc + line become a polyline', () => {
    const r = joinEntities([L(1, [0, 0], [10, 0]), A(2, [10, 5], 5, 270, 90), L(3, [10, 10], [0, 10])]);
    expect(r.add).toHaveLength(1);
    expect(r.add[0].type).toBe('LWPOLYLINE');
    expect(pts(r.add[0])).toEqual([[0, 0, 0], [10, 0, 1], [10, 10, 0], [0, 10, 0]]);
  });
  it('four lines forming a square become a closed polyline', () => {
    const r = joinEntities([L(1, [0, 0], [10, 0]), L(2, [10, 10], [10, 0]), L(3, [10, 10], [0, 10]), L(4, [0, 0], [0, 10])]);
    expect(r.add).toHaveLength(1);
    expect((r.add[0] as PolylineEnt).closed).toBe(true);
    expect(pts(r.add[0])).toHaveLength(4);
  });
  it('objects that touch nothing stay untouched', () => {
    const r = joinEntities([L(1, [0, 0], [10, 0]), L(2, [50, 50], [60, 70])]);
    expect(r.add).toEqual([]);
    expect(r.remove).toEqual([]);
  });
  it('a polyline absorbs a touching line', () => {
    const r = joinEntities([PL(1, [[0, 0], [10, 0], [10, 10]], false), L(2, [10, 10], [0, 10])]);
    expect(pts(r.add[0])).toEqual([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]]);
  });
});

describe('STRETCH', () => {
  const box: [number, number, number, number] = [5, -5, 15, 5];
  it('moves only the endpoints inside the window', () => expect(lineOf(stretchEntity(L(1, [0, 0], [10, 0]), box, [3, 0]) as NewEntity)).toEqual([[0, 0], [13, 0]]));
  it('keeps polyline bulges', () => expect(pts(stretchEntity(PL(1, [[0, 0, 0.5], [10, 0, 0], [10, 20, 0]], false), box, [2, 0]))).toEqual([[0, 0, 0.5], [12, 0, 0], [10, 20, 0]]));
  it('an arc with one endpoint inside keeps its chord height', () => {
    const arc = A(1, [5, 0], 5, 0, 180) as Extract<Entity, { type: 'ARC' }>; // chord (10,0)-(0,0), height 5
    const s = stretchEntity(arc, [8, -1, 12, 1], [10, 0]) as Extract<Entity, { type: 'ARC' }>;
    const a = polar2(s, s.a0), b = polar2(s, s.a1), mid = (s.a0 + ((s.a1 - s.a0 + 2 * Math.PI) % (2 * Math.PI)) / 2);
    expect(P(a)).toEqual([20, 0]); expect(P(b)).toEqual([0, 0]);
    expect(r4(polar2(s, mid)[1])).toBe(5);
  });
  it('an arc with both endpoints inside moves as a whole', () => {
    const s = stretchEntity(A(1, [0, 0], 2, 0, 180), [-3, -1, 3, 1], [5, 5]) as Extract<Entity, { type: 'ARC' }>;
    expect(s.c).toEqual([5, 5]); expect(s.r).toBe(2);
  });
  it('text moves as a unit only when its insertion point is inside', () => {
    const t = { id: 1, type: 'TEXT', layer: '0', p: [6, 0], p2: [20, 0], h: 2, rot: 0, text: 'A', style: 'STANDARD' } as unknown as Entity;
    expect((stretchEntity(t, box, [1, 1]) as unknown as { p2: Pt }).p2).toEqual([21, 1]);
    const out = { ...t, p: [0, 0] } as Entity;
    expect(stretchEntity(out, box, [1, 1])).toBe(out);
  });
  it('dimensions move only the definition points inside', () => {
    const d = { id: 1, type: 'DIMENSION', layer: '0', kind: 'linear', p1: [0, 0], p2: [10, 0], loc: [5, 20] } as unknown as Entity;
    const s = stretchEntity(d, box, [5, 0]) as unknown as { p1: Pt; p2: Pt; loc: Pt };
    expect([s.p1, s.p2, s.loc]).toEqual([[0, 0], [15, 0], [5, 20]]);
  });
  it('accepts a polygon test (crossing polygon)', () => expect(lineOf(stretchEntity(L(1, [0, 0], [10, 0]), (p) => p[0] < 1, [0, 4]) as NewEntity)).toEqual([[0, 4], [10, 0]]));
});
function polar2(a: { c: Pt; r: number }, t: number): Pt { return [a.c[0] + a.r * Math.cos(t), a.c[1] + a.r * Math.sin(t)]; }

describe('ARRAY helpers', () => {
  const d = (xs: number[]) => xs.map((x) => r4((x * 180) / Math.PI));
  it('a full circle spaces items 360/n apart', () => expect(d(polarAngles(4, 2 * Math.PI))).toEqual([90, 180, 270]));
  it('a partial fill spaces items fill/(n-1) apart', () => expect(d(polarAngles(4, Math.PI))).toEqual([60, 120, 180]));
  it('negative fill goes clockwise', () => expect(d(polarAngles(3, -Math.PI / 2))).toEqual([-45, -90]));
  it('reference points', () => {
    expect(referencePoint(L(1, [1, 2], [3, 4]))).toEqual([1, 2]);
    expect(referencePoint(C(1, [5, 5], 1))).toEqual([5, 5]);
  });
});

describe('interactive commands', () => {
  const lines = (doc: CadDocument) => [...doc.entities.values()].filter((e) => e.type === 'LINE') as Extract<Entity, { type: 'LINE' }>[];
  it('aliases follow acad.pgp', () => {
    expect(BUILTIN_ALIASES).toMatchObject({ O: 'OFFSET', TR: 'TRIM', EX: 'EXTEND', F: 'FILLET', CHA: 'CHAMFER', AR: 'ARRAY', S: 'STRETCH', BR: 'BREAK', J: 'JOIN' });
  });
  it('OFFSET Through is the default the first time', async () => {
    const doc = new CadDocument(); doc.add({ type: 'LINE', layer: '0', a: [0, 0], b: [10, 0] });
    const c = engineWithHost(doc);
    await runScript(c, 'OFFSET', ['', { p: [5, 0] }, { p: [3, 6] }, '']);
    expect(lines(doc).map((l) => l.a[1]).sort()).toEqual([0, 6]);
  });
  it('OFFSET Erase removes the source, Layer=Current uses the current layer, one undo group', async () => {
    const doc = new CadDocument(); doc.add({ type: 'LINE', layer: 'WALL', a: [0, 0], b: [10, 0] });
    const c = engineWithHost(doc);
    await runScript(c, 'OFFSET', ['E', 'Y', 'L', 'C', '2', { p: [5, 0] }, { p: [5, -3] }, '']);
    const l = lines(doc);
    expect(l).toHaveLength(1);
    expect(l[0].a[1]).toBe(-2); expect(l[0].layer).toBe(doc.settings.currentLayer);
    doc.undo();
    expect(lines(doc).map((x) => x.a[1])).toEqual([0]);
  });
  it('OFFSET Multiple offsets repeatedly from the last result', async () => {
    const doc = new CadDocument(); doc.add({ type: 'LINE', layer: '0', a: [0, 0], b: [10, 0] });
    const c = engineWithHost(doc);
    await runScript(c, 'OFFSET', ['2', { p: [5, 0] }, 'M', { p: [5, 1] }, { p: [5, 3] }, { p: [5, 5] }, '', '']);
    expect(lines(doc).map((l) => l.a[1]).sort((a, b) => a - b)).toEqual([0, 2, 4, 6]);
  });
  it('TRIM: Shift+pick extends instead', async () => {
    const doc = new CadDocument();
    const t = doc.add({ type: 'LINE', layer: '0', a: [0, 0], b: [4, 0] });
    doc.add({ type: 'LINE', layer: '0', a: [10, -5], b: [10, 5] });
    const c = engineWithHost(doc);
    await runScript(c, 'TRIM', ['', { p: [3, 0], shift: true }, '']);
    expect((doc.get(t.id) as Extract<Entity, { type: 'LINE' }>).b).toEqual([10, 0]);
  });
  it('TRIM with all edges, U undoes the last trim', async () => {
    const doc = new CadDocument();
    const t = doc.add({ type: 'LINE', layer: '0', a: [0, 0], b: [10, 0] });
    doc.add({ type: 'LINE', layer: '0', a: [5, -5], b: [5, 5] });
    const c = engineWithHost(doc);
    await runScript(c, 'TRIM', ['', { p: [2, 0] }, 'U', { p: [8, 0] }, '']);
    expect((doc.get(t.id) as Extract<Entity, { type: 'LINE' }>).b).toEqual([5, 0]);
    expect((doc.get(t.id) as Extract<Entity, { type: 'LINE' }>).a).toEqual([0, 0]);
  });
  it('TRIM Fence trims several objects at once', async () => {
    const doc = new CadDocument();
    doc.add({ type: 'LINE', layer: '0', a: [0, 0], b: [10, 0] });
    doc.add({ type: 'LINE', layer: '0', a: [0, 2], b: [10, 2] });
    doc.add({ type: 'LINE', layer: '0', a: [5, -5], b: [5, 5] });
    const c = engineWithHost(doc);
    await runScript(c, 'TRIM', ['', 'O', 'Q', 'F', { p: [8, -1] }, { p: [8, 3] }, '', '']);
    expect(lines(doc).filter((l) => l.a[1] === l.b[1]).map((l) => l.b[0])).toEqual([5, 5]);
  });
  it('EXTEND to a boundary from the command', async () => {
    const doc = new CadDocument();
    const t = doc.add({ type: 'LINE', layer: '0', a: [0, 0], b: [4, 0] });
    doc.add({ type: 'LINE', layer: '0', a: [10, -5], b: [10, 5] });
    const c = engineWithHost(doc);
    await runScript(c, 'EXTEND', ['O', 'S', '', { p: [3, 0] }, '']);
    expect((doc.get(t.id) as Extract<Entity, { type: 'LINE' }>).b).toEqual([10, 0]);
  });
  it('FILLET with radius, then shift-select gives a sharp corner', async () => {
    const doc = new CadDocument();
    const a = doc.add({ type: 'LINE', layer: '0', a: [0, 0], b: [12, 0] });
    const b = doc.add({ type: 'LINE', layer: '0', a: [10, -2], b: [10, 10] });
    const c = engineWithHost(doc);
    await runScript(c, 'FILLET', ['R', '2', { p: [2, 0] }, { p: [10, 8] }]);
    expect(doc.size).toBe(3);
    expect((doc.get(a.id) as Extract<Entity, { type: 'LINE' }>).b).toEqual([8, 0]);
    doc.undo();
    expect(doc.size).toBe(2);
    await runScript(c, 'FILLET', [{ p: [2, 0] }, { p: [10, 8], shift: true }]);
    expect(doc.size).toBe(2);
    expect((doc.get(b.id) as Extract<Entity, { type: 'LINE' }>).a).toEqual([10, 0]);
  });
  it('CHAMFER Distance from the command', async () => {
    const doc = new CadDocument();
    doc.add({ type: 'LINE', layer: '0', a: [0, 0], b: [10, 0] });
    doc.add({ type: 'LINE', layer: '0', a: [10, 0], b: [10, 10] });
    const c = engineWithHost(doc);
    await runScript(c, 'CHAMFER', ['D', '2', '3', { p: [5, 0] }, { p: [10, 5] }]);
    expect(lines(doc).some((l) => P(l.a).join() === '8,0' && P(l.b).join() === '10,3')).toBe(true);
  });
  it('BREAK with @ breaks at a single point', async () => {
    const doc = new CadDocument(); doc.add({ type: 'LINE', layer: '0', a: [0, 0], b: [10, 0] });
    const c = engineWithHost(doc);
    await runScript(c, 'BREAK', [{ p: [4, 0] }, '@']);
    expect(lines(doc).map((l) => [l.a[0], l.b[0]])).toEqual([[0, 4], [4, 10]]);
  });
  it('BREAK with First point', async () => {
    const doc = new CadDocument(); doc.add({ type: 'LINE', layer: '0', a: [0, 0], b: [10, 0] });
    const c = engineWithHost(doc);
    await runScript(c, 'BREAK', [{ p: [9, 0] }, 'F', '2,0', '6,0']);
    expect(lines(doc).map((l) => [l.a[0], l.b[0]])).toEqual([[0, 2], [6, 10]]);
  });
  it('BREAKATPOINT splits a line', async () => {
    const doc = new CadDocument(); doc.add({ type: 'LINE', layer: '0', a: [0, 0], b: [10, 0] });
    const c = engineWithHost(doc);
    await runScript(c, 'BREAKATPOINT', [{ p: [1, 0] }, '7,0']);
    expect(lines(doc).map((l) => [l.a[0], l.b[0]])).toEqual([[0, 7], [7, 10]]);
  });
  it('JOIN collinear lines from the command, undo restores both', async () => {
    const doc = new CadDocument();
    doc.add({ type: 'LINE', layer: '0', a: [0, 0], b: [4, 0] });
    doc.add({ type: 'LINE', layer: '0', a: [4, 0], b: [10, 0] });
    const c = engineWithHost(doc);
    await runScript(c, 'JOIN', ['ALL', '']);
    expect(lines(doc).map((l) => [l.a[0], l.b[0]])).toEqual([[0, 10]]);
    doc.undo();
    expect(lines(doc)).toHaveLength(2);
  });
  it('JOIN a single arc with cLose makes a circle', async () => {
    const doc = new CadDocument(); doc.add({ type: 'ARC', layer: '0', c: [0, 0], r: 5, a0: 0, a1: Math.PI });
    const c = engineWithHost(doc);
    await runScript(c, 'JOIN', [{ p: [0, 5] }, '', 'L']);
    expect([...doc.entities.values()][0].type).toBe('CIRCLE');
  });
  it('STRETCH by crossing window moves only the inside endpoints', async () => {
    const doc = new CadDocument(); const l = doc.add({ type: 'LINE', layer: '0', a: [0, 0], b: [10, 0] });
    const c = engineWithHost(doc);
    await runScript(c, 'STRETCH', [{ p: [12, 2] }, { p: [8, -2] }, '', { p: [0, 0] }, { p: [5, 0] }]);
    expect((doc.get(l.id) as Extract<Entity, { type: 'LINE' }>).b).toEqual([15, 0]);
    expect((doc.get(l.id) as Extract<Entity, { type: 'LINE' }>).a).toEqual([0, 0]);
  });
  it('STRETCH by crossing polygon (CP)', async () => {
    const doc = new CadDocument(); const l = doc.add({ type: 'LINE', layer: '0', a: [0, 0], b: [10, 0] });
    const c = engineWithHost(doc);
    await runScript(c, 'STRETCH', ['CP', '8,-2', '12,-2', '12,2', '8,2', '', '', '0,0', '0,4']);
    expect((doc.get(l.id) as Extract<Entity, { type: 'LINE' }>).b).toEqual([10, 4]);
  });
  it('polar ARRAY over 180° with 3 items, not rotated', async () => {
    const doc = new CadDocument(); doc.add({ type: 'CIRCLE', layer: '0', c: [10, 0], r: 1 });
    const c = engineWithHost(doc);
    await runScript(c, 'ARRAY', ['P', 'ALL', '', '0,0', '3', '180', 'N']);
    const cs = [...doc.entities.values()].map((e) => (e.type === 'CIRCLE' ? P(e.c) : null));
    expect(cs).toEqual([[10, 0], [0, 10], [-10, 0]]);
  });
  it('polar ARRAY full circle with 4 items', async () => {
    const doc = new CadDocument(); doc.add({ type: 'LINE', layer: '0', a: [5, 0], b: [10, 0] });
    const c = engineWithHost(doc);
    await runScript(c, 'ARRAY', ['P', 'ALL', '', '0,0', '4', '360', 'Y']);
    expect(lines(doc).map((l) => P(l.b))).toEqual([[10, 0], [0, 10], [-10, 0], [0, -10]]);
  });
});
