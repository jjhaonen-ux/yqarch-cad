/**
 * Phase 2 acceptance tests: one group per item of the Phase 2 checklist (document model, layers/units,
 * selection, object snaps, command line + shortcuts, undo/redo) plus regressions found while auditing.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CadDocument, MAX_UNDO } from '../src/engine/model/document';
import { fromJSON, serialize } from '../src/engine/io/native';
import { Viewport } from '../src/engine/render/view';
import { computeSnap, defaultSnapSettings, type SnapKind } from '../src/engine/snap/osnap';
import { crossingSelect, pick, windowSelect } from '../src/engine/select/select';
import { CommandEngine, runScript } from '../src/engine/commands/engine';
import { registerAll } from '../src/engine/commands';
import { AliasResolver } from '../src/engine/commands/aliases';
import { unitConversion } from '../src/engine/model/settings';
import { tessellate } from '../src/engine/render/tessellate';
import type { ArcEnt, CircleEnt, Entity } from '../src/engine/types';

const asset = (p: string) => JSON.parse(readFileSync(new URL(`../assets/${p}`, import.meta.url), 'utf8'));
const host = { pick: () => null, windowSelect: () => [] as number[] };
const engineFor = (doc = new CadDocument()) => registerAll(new CommandEngine(doc, host));
const view = () => { const v = new Viewport(); v.resize(800, 600); v.scale = 1; return v; };
const items = (doc: CadDocument) => ({ itemsFor: (e: Entity) => tessellate(e, { doc, fg: '#fff', bg: '#000' }) });
const only = (...k: SnapKind[]) => { const s = defaultSnapSettings(); s.modes = new Set(k); return s; };

describe('document model & file round trip', () => {
  it('keeps blocks, inserts, hatches, dimensions and bulge polylines through .yqd save/open', () => {
    const d = new CadDocument();
    d.setBlock({ name: 'B1', base: [0, 0], entities: [{ id: 1, type: 'LINE', layer: '0', a: [0, 0], b: [10, 0] }] });
    d.add({ type: 'INSERT', layer: '0', name: 'B1', p: [5, 5], sx: 2, sy: 2, rot: 0.5 });
    d.add({ type: 'HATCH', layer: '0', pattern: 'ANSI31', solid: false, loops: [[[0, 0], [10, 0], [10, 10], [0, 10]]], scale: 2, angle: 0 });
    d.add({ type: 'DIMENSION', layer: '0', kind: 'aligned', p1: [0, 0], p2: [100, 0], loc: [0, 20] });
    d.add({ type: 'LWPOLYLINE', layer: '0', pts: [[0, 0, 0.5], [10, 0, 0], [10, 10]], closed: true });
    const loaded = fromJSON(serialize(d));
    expect(loaded.size).toBe(4);
    expect(loaded.blocks.size).toBe(1);
    expect(serialize(loaded)).toBe(serialize(d));
  });

  it('supports mm, cm, m and inch drawing units', () => {
    expect(unitConversion(1, 4)).toBeCloseTo(25.4);
    expect(unitConversion(4, 5)).toBeCloseTo(0.1);
    expect(unitConversion(6, 1)).toBeCloseTo(39.37007874, 4);
  });
});

describe('history (undo / redo)', () => {
  it('marks the drawing as modified after undo and redo', () => {
    const d = new CadDocument();
    d.add({ type: 'LINE', layer: '0', a: [0, 0], b: [1, 1] });
    d.dirty = false; d.undo();
    expect(d.dirty).toBe(true);
    d.dirty = false; d.redo();
    expect(d.dirty).toBe(true);
  });

  it('keeps the undo stack bounded even for edits made outside a command group', () => {
    const d = new CadDocument();
    for (let i = 0; i < MAX_UNDO + 200; i++) d.add({ type: 'POINT', layer: '0', p: [i, 0] });
    let n = 0; while (d.undo()) n++;
    expect(n).toBe(MAX_UNDO);
  });

  it('restores draw order when undoing an erase', () => {
    const d = new CadDocument();
    const a = d.add({ type: 'POINT', layer: '0', p: [0, 0] }), b = d.add({ type: 'POINT', layer: '0', p: [1, 0] }), c = d.add({ type: 'POINT', layer: '0', p: [2, 0] });
    d.remove(b.id); d.undo();
    expect([...d.entities.keys()]).toEqual([a.id, b.id, c.id]);
  });
});

describe('object snaps, ortho and polar', () => {
  const cross = () => { const d = new CadDocument(); d.add({ type: 'LINE', layer: '0', a: [0, 0], b: [100, 0] }); d.add({ type: 'LINE', layer: '0', a: [50, -50], b: [50, 50] }); return d; };

  it('snaps to the intersection of two lines', () => {
    const r = computeSnap(cross(), view(), defaultSnapSettings(), { cursor: [52, 2] });
    expect(r.kind).toBe('int'); expect(r.p).toEqual([50, 0]);
  });
  it('snaps to a midpoint', () => {
    const d = new CadDocument(); d.add({ type: 'LINE', layer: '0', a: [0, 0], b: [100, 0] });
    const r = computeSnap(d, view(), defaultSnapSettings(), { cursor: [52, 3] });
    expect(r.kind).toBe('mid'); expect(r.p).toEqual([50, 0]);
  });
  it('snaps to the perpendicular foot from the base point', () => {
    const d = new CadDocument(); d.add({ type: 'LINE', layer: '0', a: [0, 0], b: [100, 0] });
    const r = computeSnap(d, view(), only('per'), { cursor: [30, 4], base: [30, 80] });
    expect(r.kind).toBe('per'); expect(r.p[0]).toBeCloseTo(30); expect(r.p[1]).toBeCloseTo(0);
  });
  it('snaps to a quadrant, and to the center when hovering the circle edge', () => {
    const d = new CadDocument(); d.add({ type: 'CIRCLE', layer: '0', c: [300, 300], r: 40 });
    expect(computeSnap(d, view(), defaultSnapSettings(), { cursor: [340, 302] }).kind).toBe('qua');
    const edge = computeSnap(d, view(), defaultSnapSettings(), { cursor: [328.3, 328.3] });
    expect(edge.kind).toBe('cen'); expect(edge.p).toEqual([300, 300]);
  });
  it('prefers an arc endpoint over its center when the cursor is on the endpoint', () => {
    const d = new CadDocument(); d.add({ type: 'ARC', layer: '0', c: [0, 0], r: 50, a0: 0, a1: Math.PI / 2 });
    const r = computeSnap(d, view(), defaultSnapSettings(), { cursor: [50.5, 1] });
    expect(r.kind).toBe('end'); expect(r.p[0]).toBeCloseTo(50);
  });
  it('snaps to the midpoint and edge points of bulge polyline segments', () => {
    const d = new CadDocument(); d.add({ type: 'LWPOLYLINE', layer: '0', pts: [[0, 0, 1], [100, 0]], closed: false });
    const r = computeSnap(d, view(), defaultSnapSettings(), { cursor: [50, -49] });
    expect(r.kind).toBe('mid'); expect(r.p[0]).toBeCloseTo(50); expect(r.p[1]).toBeCloseTo(-50);
  });
  it('applies ortho and polar tracking from the base point', () => {
    const d = new CadDocument();
    const o = defaultSnapSettings(); o.orthoOn = true;
    const ortho = computeSnap(d, view(), o, { cursor: [100, 12], base: [0, 0] });
    expect(ortho.kind).toBe('ortho'); expect(ortho.p).toEqual([100, 0]);
    const polar = computeSnap(d, view(), defaultSnapSettings(), { cursor: [100, 98], base: [0, 0] });
    expect(polar.kind).toBe('polar'); expect(polar.tracking?.angle).toBeCloseTo(Math.PI / 4);
  });
});

describe('selection', () => {
  const scene = () => {
    const d = new CadDocument();
    d.add({ type: 'LINE', layer: '0', a: [0, 0], b: [100, 0] });
    d.add({ type: 'CIRCLE', layer: '0', c: [200, 0], r: 20 });
    d.add({ type: 'LWPOLYLINE', layer: '0', pts: [[0, 100], [100, 100], [100, 200]], closed: false });
    return d;
  };
  it('window selects only entities fully inside; crossing also takes those it touches', () => {
    const d = scene();
    expect(windowSelect(d, [-10, -10, 110, 10])).toHaveLength(1);
    expect(windowSelect(d, [50, -10, 190, 10])).toHaveLength(0);
    expect(crossingSelect(d, items(d), [50, -10, 190, 10])).toHaveLength(2);
    expect(crossingSelect(d, items(d), [50, -10, 60, 150])).toHaveLength(2);
  });
  it('picks the nearest entity and ignores locked or hidden layers', () => {
    const d = new CadDocument();
    d.add({ type: 'LINE', layer: '0', a: [0, 0], b: [100, 0] });
    d.ensureLayer('X');
    const top = d.add({ type: 'LINE', layer: 'X', a: [0, 5], b: [100, 5] });
    expect(pick(d, items(d), [50, 4], 3)).toBe(top.id);
    d.updateLayer('X', { locked: true });
    expect(pick(d, items(d), [50, 4], 3)).not.toBe(top.id);
    d.updateLayer('X', { locked: false, off: true });
    expect(pick(d, items(d), [50, 4], 3)).not.toBe(top.id);
  });
});

describe('viewport', () => {
  it('fits extents inside the screen and pans by screen pixels', () => {
    const v = view(); v.fit([0, 0, 1000, 500]);
    const a = v.toScreen([0, 0]), b = v.toScreen([1000, 500]);
    expect(a[0]).toBeGreaterThan(0); expect(b[0]).toBeLessThan(800); expect(a[1]).toBeLessThan(600); expect(b[1]).toBeGreaterThan(0);
    const w = v.toWorld(400, 300); v.pan(50, -20);
    const w2 = v.toWorld(450, 280);
    expect(w2[0]).toBeCloseTo(w[0]); expect(w2[1]).toBeCloseTo(w[1]);
  });
});

describe('command line & shortcuts', () => {
  it('resolves YQArch / acad.pgp shortcuts from the shipped assets', () => {
    const catalog = asset('commands.json'), pgp = asset('profiles/user1/pgp-aliases.json');
    const c = engineFor();
    c.setResolver(new AliasResolver(() => c.registry.keys(), { yqCommands: catalog.commands, pgp: pgp.data.aliases }));
    const names: Record<string, string> = { L: 'LINE', PL: 'PLINE', C: 'CIRCLE', REC: 'RECTANG', M: 'MOVE', CO: 'COPY', RO: 'ROTATE', E: 'ERASE' };
    for (const [alias, name] of Object.entries(names)) expect([alias, c.resolve(alias).def?.name]).toEqual([alias, name]);
  });

  it('draws and edits through scripted commands, one undo unit per command', async () => {
    const d = new CadDocument(); const c = engineFor(d);
    await runScript(c, 'CIRCLE', [{ p: [0, 0] }, '25']);
    const id = [...d.entities.keys()][0];
    expect((d.get(id) as CircleEnt).r).toBe(25);

    c.selection.add(id);
    await runScript(c, 'MOVE', [{ p: [0, 0] }, { p: [10, 5] }]);
    expect((d.get(id) as CircleEnt).c).toEqual([10, 5]);
    d.undo(); expect((d.get(id) as CircleEnt).c).toEqual([0, 0]);

    c.selection.add(id);
    await runScript(c, 'SCALE', [{ p: [0, 0] }, '2']);
    expect((d.get(id) as CircleEnt).r).toBe(50);

    c.selection.add(id);
    await runScript(c, 'COPY', [{ p: [0, 0] }, { p: [100, 0] }, '']);
    expect(d.size).toBe(2);

    c.selection.add(id);
    await runScript(c, 'ERASE', []);
    expect(d.size).toBe(1);
  });

  it('radial dimensions refuse entities that are not arcs or circles', async () => {
    const d = new CadDocument();
    const line = d.add({ type: 'LINE', layer: '0', a: [0, 0], b: [10, 0] });
    // a host that ignores the filter must not crash the command
    const c = registerAll(new CommandEngine(d, { pick: () => line.id, windowSelect: () => [] }));
    await runScript(c, 'DIMRADIUS', [{ p: [5, 0] }]);
    expect(c.log.some((l) => l.kind === 'error' && !l.text.includes('Cannot read'))).toBe(true);
    expect(d.size).toBe(1);
  });

  it('keeps an ARC created by three points on the requested circle', async () => {
    const d = new CadDocument(); const c = engineFor(d);
    await runScript(c, 'ARC', [{ p: [0, 0] }, { p: [10, 10] }, { p: [20, 0] }]);
    const arc = [...d.entities.values()].find((e) => e.type === 'ARC') as ArcEnt | undefined;
    expect(arc).toBeTruthy();
    expect(arc!.r).toBeCloseTo(10);
  });
});
