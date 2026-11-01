/**
 * Fence / WPolygon / CPolygon selection (Phase 3A completion): geometric rules, concave polygons, locked layers,
 * and the interactive flow inside the object-selection prompt (keywords F / WP / CP, Enter, Undo, Remove, typed points).
 */
import { describe, expect, it } from 'vitest';
import { CadDocument } from '../src/engine/model/document';
import { runScript } from '../src/engine/commands/engine';
import { fenceSelect, polygonSelect, segmentsMeet } from '../src/engine/select/select';
import { tessellate } from '../src/engine/render/tessellate';
import type { NewEntity, Pt } from '../src/engine/types';
import { engineWithHost, equip, tc } from './helpers-3a';

function scene() {
  const doc = equip(new CadDocument());
  doc.ensureLayer('LOCKED');
  const ids: Record<string, number> = {};
  const add = (k: string, n: Record<string, unknown>) => { ids[k] = doc.add(n as unknown as NewEntity).id; };
  add('A', { type: 'LINE', layer: '0', a: [0, 0], b: [10, 0] });
  add('B', { type: 'LINE', layer: '0', a: [20, 0], b: [30, 0] });
  add('C', { type: 'CIRCLE', layer: '0', c: [50, 0], r: 5 });
  add('D', { type: 'LINE', layer: '0', a: [0, 20], b: [10, 20] });
  add('P', { type: 'POINT', layer: '0', p: [70, 0] });
  add('T', { type: 'TEXT', layer: '0', text: 'AB', p: [90, 0], h: 4, rot: 0, style: 'Standard' });
  add('L', { type: 'LINE', layer: 'LOCKED', a: [0, -5], b: [10, -5] });
  doc.updateLayer('LOCKED', { locked: true });
  return { doc, ids, items: { itemsFor: (e: Parameters<typeof tessellate>[0]) => tessellate(e, tc(doc)) } };
}
const sorted = (a: number[]) => [...a].sort((x, y) => x - y);
const ofKeys = (ids: Record<string, number>, ...k: string[]) => sorted(k.map((x) => ids[x]));
const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

describe('segmentsMeet', () => {
  it('crossing, touching, collinear overlap and disjoint', () => {
    expect(segmentsMeet([0, 0], [10, 10], [0, 10], [10, 0])).toBe(true);
    expect(segmentsMeet([0, 0], [10, 0], [10, 0], [10, 5])).toBe(true);
    expect(segmentsMeet([0, 0], [10, 0], [5, 0], [15, 0])).toBe(true);
    expect(segmentsMeet([0, 0], [10, 0], [11, 0], [15, 0])).toBe(false);
    expect(segmentsMeet([0, 0], [10, 0], [0, 1], [10, 1])).toBe(false);
  });
});

describe('FENCE', () => {
  it('selects what the fence crosses and nothing else', () => {
    const { doc, ids, items } = scene();
    expect(sorted(fenceSelect(doc, items, [[5, -3], [5, 3], [25, 3], [25, -3]]))).toEqual(ofKeys(ids, 'A', 'B'));
    expect(sorted(fenceSelect(doc, items, [[50, -10], [50, 10]]))).toEqual(ofKeys(ids, 'C'));
  });
  it('a fence wholly inside a circle does not touch its outline', () => {
    const { doc, items } = scene();
    expect(fenceSelect(doc, items, [[48, -1], [52, 1]])).toEqual([]);
  });
  it('collinear overlap, point entities and text', () => {
    const { doc, ids, items } = scene();
    expect(fenceSelect(doc, items, [[2, 0], [8, 0]])).toEqual([ids.A]);
    expect(fenceSelect(doc, items, [[70, -5], [70, 5]])).toEqual([ids.P]);
    expect(fenceSelect(doc, items, [[69, -5], [69, 5]])).toEqual([]);
    expect(fenceSelect(doc, items, [[88, 2], [100, 2]])).toEqual([ids.T]);
  });
  it('skips locked layers (unless asked) and applies the filter', () => {
    const { doc, ids, items } = scene();
    expect(fenceSelect(doc, items, [[5, -10], [5, 5]])).toEqual([ids.A]);
    expect(sorted(fenceSelect(doc, items, [[5, -10], [5, 5]], { includeLocked: true }))).toEqual(ofKeys(ids, 'A', 'L'));
    expect(fenceSelect(doc, items, [[5, -10], [5, 5]], { filter: (e) => e.type === 'CIRCLE' })).toEqual([]);
  });
  it('needs two points', () => {
    const { doc, items } = scene();
    expect(fenceSelect(doc, items, [[5, 0]])).toEqual([]);
  });
});

describe('WPOLYGON / CPOLYGON', () => {
  it('window takes only what is entirely inside, crossing also what the outline cuts', () => {
    const { doc, ids, items } = scene();
    const poly = rect(-1, -1, 25, 1);
    expect(polygonSelect(doc, items, poly, false)).toEqual([ids.A]);
    expect(sorted(polygonSelect(doc, items, poly, true))).toEqual(ofKeys(ids, 'A', 'B'));
  });
  it('a polygon fully inside a circle selects nothing, even crossing', () => {
    const { doc, items } = scene();
    expect(polygonSelect(doc, items, rect(48, -1, 52, 1), true)).toEqual([]);
  });
  it('accepts a polygon that exactly frames an entity (boundary counts as inside)', () => {
    const { doc, ids, items } = scene();
    expect(polygonSelect(doc, items, rect(0, 0, 10, 0.001), false)).toEqual([ids.A]);
    expect(polygonSelect(doc, items, rect(45, -5, 55, 5), false)).toEqual([ids.C]);
  });
  it('concave polygon: the notch is outside even though it lies in the bounding box', () => {
    const doc = equip(new CadDocument());
    const arm = doc.add({ type: 'LINE', layer: '0', a: [2, 30], b: [8, 35] } as unknown as NewEntity).id;
    const notch = doc.add({ type: 'LINE', layer: '0', a: [25, 25], b: [30, 30] } as unknown as NewEntity).id;
    const leave = doc.add({ type: 'LINE', layer: '0', a: [5, 20], b: [20, 38] } as unknown as NewEntity).id; // arm → notch
    const items = { itemsFor: (e: Parameters<typeof tessellate>[0]) => tessellate(e, tc(doc)) };
    const L: Pt[] = [[0, 0], [40, 0], [40, 10], [10, 10], [10, 40], [0, 40]];
    expect(polygonSelect(doc, items, L, false)).toEqual([arm]);
    expect(sorted(polygonSelect(doc, items, L, true))).toEqual(sorted([arm, leave]));
    expect(polygonSelect(doc, items, L, true)).not.toContain(notch);
  });
  it('text: window needs the whole text, crossing any overlap', () => {
    const { doc, ids, items } = scene();
    expect(polygonSelect(doc, items, rect(89, -2, 91.5, 6), false)).toEqual([]);
    expect(polygonSelect(doc, items, rect(89, -2, 91.5, 6), true)).toEqual([ids.T]);
    expect(polygonSelect(doc, items, rect(80, -5, 120, 10), false)).toEqual([ids.T]);
  });
  it('triangle (non axis-aligned) and locked layers', () => {
    const { doc, ids, items } = scene();
    const tri: Pt[] = [[-5, -10], [15, -10], [5, 10]];
    expect(sorted(polygonSelect(doc, items, tri, true))).toEqual(ofKeys(ids, 'A'));
    expect(sorted(polygonSelect(doc, items, tri, true, { includeLocked: true }))).toEqual(ofKeys(ids, 'A', 'L'));
    expect(polygonSelect(doc, items, tri.slice(0, 2), true)).toEqual([]);
  });
});

describe('interactive flow in the selection prompt', () => {
  const setup = () => { const s = scene(); return { ...s, c: engineWithHost(s.doc) }; };

  it('ERASE + F + Enter erases what the fence crosses as one undo step', async () => {
    const { doc, ids, c } = setup();
    const n0 = doc.entities.size;
    await runScript(c, 'ERASE', ['F', { p: [5, -3] }, { p: [5, 3] }, { p: [25, 3] }, { p: [25, -3] }, '', '']);
    expect(doc.get(ids.A)).toBeUndefined();
    expect(doc.get(ids.B)).toBeUndefined();
    expect(doc.entities.size).toBe(n0 - 2);
    doc.undo();
    expect(doc.entities.size).toBe(n0);
  });

  it('WP with typed coordinates, then CP, accumulate in one selection', async () => {
    const { doc, ids, c } = setup();
    await runScript(c, 'ERASE', ['WP', '-1,-1', '12,-1', '12,1', '-1,1', '', 'CP', '18,-1', '22,-1', '22,1', '18,1', '', '']);
    expect(doc.get(ids.A)).toBeUndefined();
    expect(doc.get(ids.B)).toBeUndefined();
    expect(doc.get(ids.C)).toBeDefined();
  });

  it('Undo removes the last vertex, and Undo with no vertices leaves the mode', async () => {
    const { doc, ids, c } = setup();
    // vertex 3 is a wrong point far away; U drops it, then the real third vertex closes the triangle around A
    await runScript(c, 'ERASE', ['WP', '-1,-1', '12,-1', '500,500', 'U', '12,2', '-1,2', '', '']);
    expect(doc.get(ids.A)).toBeUndefined();
    const second = setup();
    await runScript(second.c, 'ERASE', ['F', 'U', 'U', 'ESC']);
    expect(second.doc.entities.size).toBe(7);
  });

  it('R then F removes from the pending selection', async () => {
    const { doc, ids, c } = setup();
    await runScript(c, 'ERASE', ['ALL', 'R', 'F', { p: [5, -3] }, { p: [5, 3] }, '', '']);
    expect(doc.get(ids.A)).toBeDefined();
    expect(doc.get(ids.B)).toBeUndefined();
    expect(doc.get(ids.L)).toBeDefined(); // locked layers are never selected, so they are never erased
  });

  it('too few points selects nothing and returns to the object prompt', async () => {
    const { doc, c } = setup();
    const n = doc.entities.size;
    await runScript(c, 'ERASE', ['WP', '0,0', '5,5', '', 'ESC']);
    expect(doc.entities.size).toBe(n);
  });

  it('engine state while drawing: path rubber band, no pick box, prompt text', async () => {
    const { c } = setup();
    c.lang = 'en';
    const done = c.run('ERASE');
    await c.waitInput();
    c.text('CP');
    expect(c.pathMode).toBe(true);
    expect(c.wantsPickbox()).toBe(false);
    expect(c.promptText()).toContain('first');
    c.point([0, 0]); c.point([10, 0]);
    const r = c.rubberAt([10, 10]);
    expect(r?.path?.pts).toEqual([[0, 0], [10, 0], [10, 10]]);
    expect(r?.path?.closed).toBe(true);
    expect(r?.path?.crossing).toBe(true);
    c.text('F');
    expect(c.pathMode).toBe(true); // other path keywords are refused while one is open
    c.cancel(); await done;
    expect(c.pathMode).toBe(false);
  });

  it('SELECT with a fence leaves a pick-first selection', async () => {
    const { ids, c } = setup();
    await runScript(c, 'SELECT', ['F', { p: [5, -3] }, { p: [5, 3] }, '', '']);
    expect([...c.selection]).toEqual([ids.A]);
  });
});
