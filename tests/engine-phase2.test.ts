import { describe, expect, it } from 'vitest';
import { CadDocument } from '../src/engine/model/document';
import { fromJSON, serialize } from '../src/engine/io/native';
import { Viewport } from '../src/engine/render/view';
import { defaultSnapSettings, computeSnap } from '../src/engine/snap/osnap';
import { windowSelect } from '../src/engine/select/select';
import { CommandEngine } from '../src/engine/commands/engine';
import { registerAll } from '../src/engine/commands';
import { unitConversion } from '../src/engine/model/settings';
import type { Entity } from '../src/engine/types';

const host = {
  pick: () => null,
  windowSelect: () => [],
};

describe('Phase 2 CAD core', () => {
  it('round-trips native drawings with layers, settings and entities', () => {
    const doc = new CadDocument();
    doc.ensureLayer('WALLS');
    doc.setSettings({ currentLayer: 'WALLS', drawingScale: 50 });
    doc.add({ type: 'LINE', layer: 'WALLS', a: [0, 0], b: [100, 50] });
    const loaded = fromJSON(serialize(doc));
    expect(loaded.size).toBe(1);
    expect(loaded.getLayer('walls')?.name).toBe('WALLS');
    expect(loaded.settings.currentLayer).toBe('WALLS');
    expect(loaded.settings.drawingScale).toBe(50);
    expect(loaded.get([...loaded.entities.keys()][0])?.type).toBe('LINE');
  });

  it('supports undo and redo as command-group changes', () => {
    const doc = new CadDocument();
    doc.beginGroup('test line');
    doc.add({ type: 'LINE', layer: '0', a: [0, 0], b: [20, 0] });
    doc.endGroup();
    expect(doc.size).toBe(1);
    expect(doc.undo()).toBe('test line');
    expect(doc.size).toBe(0);
    expect(doc.redo()).toBe('test line');
    expect(doc.size).toBe(1);
  });

  it('maps points through the viewport and keeps zoom anchored', () => {
    const view = new Viewport();
    view.resize(800, 600);
    view.cx = 125; view.cy = -50; view.scale = 2;
    const p: [number, number] = [45, 220];
    const screen = view.toScreen(p);
    expect(view.toWorld(screen[0], screen[1])).toEqual(p);
    const fixed = view.toWorld(250, 200);
    view.zoomAt(250, 200, 2);
    expect(view.toWorld(250, 200)[0]).toBeCloseTo(fixed[0]);
    expect(view.toWorld(250, 200)[1]).toBeCloseTo(fixed[1]);
  });

  it('selects entities fully inside a window and converts unit scales', () => {
    const doc = new CadDocument();
    doc.add({ type: 'LINE', layer: '0', a: [0, 0], b: [20, 0] });
    doc.add({ type: 'CIRCLE', layer: '0', c: [50, 50], r: 5 });
    expect(windowSelect(doc, [-1, -1, 25, 2])).toHaveLength(1);
    expect(unitConversion(4, 6)).toBeCloseTo(0.001);
    expect(unitConversion(6, 4)).toBeCloseTo(1000);
  });

  it('captures endpoint snaps within the screen-space aperture', () => {
    const doc = new CadDocument();
    doc.add({ type: 'LINE', layer: '0', a: [0, 0], b: [10, 0] });
    const view = new Viewport(); view.resize(800, 600); view.scale = 1;
    const settings = defaultSnapSettings();
    const result = computeSnap(doc, view, settings, { cursor: [9, 1] });
    expect(result.kind).toBe('end');
    expect(result.p).toEqual([10, 0]);
  });

  it('runs LINE interactively through the command engine and saves one undo unit', async () => {
    const doc = new CadDocument();
    const commands = registerAll(new CommandEngine(doc, host));
    const run = commands.run('L');
    await commands.waitInput();
    commands.point([0, 0]);
    await commands.waitInput();
    commands.point([100, 0]);
    await commands.waitInput();
    commands.enter();
    await run;
    const entities = [...doc.entities.values()] as Entity[];
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({ type: 'LINE', a: [0, 0], b: [100, 0] });
    expect(doc.undo()).toBe('LINE');
    expect(doc.size).toBe(0);
  });
});
