import { describe, expect, it } from 'vitest';
import { addWallPath, changeOpening, deleteArchitecturalWall, ensureOpeningBlock, expandArchitectureTransformTargets, projectToWall, rebuildWalls, setWallOpening, synchronizeArchitecture, wallPath, wallPaths } from '../src/engine/architecture/geometry';
import { fromJSON, serialize } from '../src/engine/io/native';
import { CadDocument } from '../src/engine/model/document';
import type { Entity, Pt } from '../src/engine/types';
import { CommandEngine } from '../src/engine/commands/engine';
import { registerAll } from '../src/engine/commands';

const edges = (doc: CadDocument, wallId?: number) => [...doc.entities.values()].filter((e) =>
  e.type === 'LINE' && (e.arch?.role === 'wall-edge' || e.arch?.role === 'wall-jamb') && (wallId === undefined || e.arch.wallId === wallId),
);
const cross = (a: Pt, b: Pt) => a[0] * b[1] - a[1] * b[0];
const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
function inside(p: Pt, poly: Pt[]) {
  let result = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i], ab = sub(b, a), ap = sub(p, a);
    if (Math.abs(cross(ab, ap)) < 1e-6 && p[0] >= Math.min(a[0], b[0]) - 1e-6 && p[0] <= Math.max(a[0], b[0]) + 1e-6 && p[1] >= Math.min(a[1], b[1]) - 1e-6 && p[1] <= Math.max(a[1], b[1]) + 1e-6) return false;
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}
function mid(e: Entity): Pt {
  if (e.type !== 'LINE') throw new Error('Expected generated wall line.');
  return [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2];
}
function wallStrip(a: Pt, b: Pt, t: number): Pt[] {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy), nx = -dy / l * t / 2, ny = dx / l * t / 2;
  return [[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]];
}

describe('Phase 4A architectural geometry', () => {
  it.each([
    ['T', [[0, 0], [10000, 0], [5000, -5000], [5000, 0]] as Pt[]],
    ['L', [[0, 0], [10000, 0], [0, 0], [0, 5000]] as Pt[]],
    ['+', [[0, 0], [10000, 0], [5000, -5000], [5000, 5000]] as Pt[]],
    ['oblique', [[0, 0], [10000, 1000], [0, 5000], [10000, -2500]] as Pt[]],
  ])('clips %s intersections without leaving outline segments inside a crossing wall', (_kind, pts) => {
    const doc = new CadDocument();
    const a = addWallPath(doc, pts[0], pts[1], 200)!;
    const b = addWallPath(doc, pts[2], pts[3], 200)!;
    const outlines = edges(doc);
    expect(outlines.length).toBeGreaterThan(4);
    const strips = [wallStrip(pts[0], pts[1], 200), wallStrip(pts[2], pts[3], 200)];
    for (const line of outlines) for (const strip of strips) {
      if (line.arch?.role === 'wall-edge' && line.arch.wallId === a.id && strip === strips[0]) continue;
      if (line.arch?.role === 'wall-edge' && line.arch.wallId === b.id && strip === strips[1]) continue;
      expect(inside(mid(line), strip)).toBe(false);
    }
    expect(doc.getLayer('ARCH-DATA')).toMatchObject({ off: true, frozen: true, plot: false });
  });

  it('creates doors and windows as editable block inserts and cuts both wall faces', () => {
    const doc = new CadDocument();
    const wall = addWallPath(doc, [0, 0], [10000, 0], 200)!;
    const name = ensureOpeningBlock(doc, 'door', 900, 200, 1);
    const insert = doc.add({
      type: 'INSERT', layer: 'A-OPENING', name, p: [5000, 0], sx: 1, sy: 1, rot: 0,
      arch: { role: 'opening-symbol', wallId: wall.id, openingId: -1, station: 5000, width: 900, kind: 'door', side: 1 },
    });
    doc.update(insert.id, { arch: { role: 'opening-symbol', wallId: wall.id, openingId: insert.id, station: 5000, width: 900, kind: 'door', side: 1 } });
    setWallOpening(doc, wall.id, { id: insert.id, station: 5000, width: 900, kind: 'door', side: 1 });
    const sides = edges(doc, wall.id).filter((e) => e.type === 'LINE' && Math.abs(e.a[1] - 100) < 1e-6 && Math.abs(e.b[1] - 100) < 1e-6);
    expect(sides.some((e) => e.type === 'LINE' && e.a[0] <= 5000 && e.b[0] >= 5000)).toBe(false);
    expect(edges(doc, wall.id).filter((e) => e.arch?.role === 'wall-jamb')).toHaveLength(2);
    expect(doc.getBlock(name)?.entities).toHaveLength(2);
  });

  it('moving a door updates its host opening and rebuilds the gap', () => {
    const doc = new CadDocument();
    const wall = addWallPath(doc, [0, 0], [10000, 0], 200)!;
    const name = ensureOpeningBlock(doc, 'door', 900, 200, 1);
    const insert = doc.add({ type: 'INSERT', layer: 'A-OPENING', name, p: [5000, 0], sx: 1, sy: 1, rot: 0, arch: { role: 'opening-symbol', wallId: wall.id, openingId: -1, station: 5000, width: 900, kind: 'door', side: 1 } });
    doc.update(insert.id, { arch: { role: 'opening-symbol', wallId: wall.id, openingId: insert.id, station: 5000, width: 900, kind: 'door', side: 1 } });
    setWallOpening(doc, wall.id, { id: insert.id, station: 5000, width: 900, kind: 'door', side: 1 });
    const targets = expandArchitectureTransformTargets(doc, [insert.id]);
    expect(targets).toEqual([insert.id]);
    doc.update(insert.id, { p: [7000, 50] });
    synchronizeArchitecture(doc, [insert.id]);
    expect(wallPath(doc, wall.id)?.arch.openings[0].station).toBeCloseTo(7000);
    expect(doc.get(insert.id)).toMatchObject({ p: [7000, 0], arch: { station: 7000 } });
    const sideSegments = edges(doc, wall.id).filter((e) => e.type === 'LINE' && e.arch?.role === 'wall-edge' && Math.abs(e.a[1] - 100) < 1e-6 && Math.abs(e.b[1] - 100) < 1e-6);
    const covers = (x: number) => sideSegments.some((e) => e.type === 'LINE' && x >= Math.min(e.a[0], e.b[0]) - 1e-6 && x <= Math.max(e.a[0], e.b[0]) + 1e-6);
    expect(covers(5000)).toBe(true);
    expect(covers(7000)).toBe(false);
  });

  it('MOVE command keeps a selected door hosted in the wall and regenerates its opening', async () => {
    const doc = new CadDocument();
    const wall = addWallPath(doc, [0, 0], [10000, 0], 200)!;
    const name = ensureOpeningBlock(doc, 'door', 900, 200, 1);
    const insert = doc.add({ type: 'INSERT', layer: 'A-OPENING', name, p: [4000, 0], sx: 1, sy: 1, rot: 0, arch: { role: 'opening-symbol', wallId: wall.id, openingId: -1, station: 4000, width: 900, kind: 'door', side: 1 } });
    doc.update(insert.id, { arch: { role: 'opening-symbol', wallId: wall.id, openingId: insert.id, station: 4000, width: 900, kind: 'door', side: 1 } });
    setWallOpening(doc, wall.id, { id: insert.id, station: 4000, width: 900, kind: 'door', side: 1 });
    const engine = registerAll(new CommandEngine(doc, { pick: () => null, windowSelect: () => [] }));
    engine.selection.add(insert.id);
    const run = engine.run('MOVE');
    await engine.waitInput(); engine.point([0, 0]);
    await engine.waitInput(); engine.point([2000, 0]);
    await run;
    expect(wallPath(doc, wall.id)?.arch.openings[0].station).toBeCloseTo(6000);
    expect(doc.get(insert.id)).toMatchObject({ p: [6000, 0], arch: { station: 6000 } });
  });

  it('persists wall associations and opening metadata through native save/load', () => {
    const doc = new CadDocument();
    const wall = addWallPath(doc, [0, 0], [8000, 0], 180)!;
    const name = ensureOpeningBlock(doc, 'window', 1200, 180, 1);
    const insert = doc.add({ type: 'INSERT', layer: 'A-OPENING', name, p: [4000, 0], sx: 1, sy: 1, rot: 0, arch: { role: 'opening-symbol', wallId: wall.id, openingId: -1, station: 4000, width: 1200, kind: 'window', side: 1 } });
    doc.update(insert.id, { arch: { role: 'opening-symbol', wallId: wall.id, openingId: insert.id, station: 4000, width: 1200, kind: 'window', side: 1 } });
    setWallOpening(doc, wall.id, { id: insert.id, station: 4000, width: 1200, kind: 'window', side: 1 });
    const loaded = fromJSON(serialize(doc));
    const loadedWall = [...loaded.entities.values()].find((e) => e.arch?.role === 'wall-path');
    const loadedOpening = [...loaded.entities.values()].find((e) => e.arch?.role === 'opening-symbol');
    expect(loadedWall?.arch).toMatchObject({ role: 'wall-path', thickness: 180, openings: [{ station: 4000, width: 1200, kind: 'window' }] });
    expect(loadedOpening?.arch).toMatchObject({ role: 'opening-symbol', station: 4000, width: 1200, kind: 'window' });
    expect(loaded.getLayer('ARCH-DATA')?.off).toBe(true);
  });

  it('clips wall outlines at column footprints and restores them when the column is deleted', () => {
    const doc = new CadDocument();
    const wall = addWallPath(doc, [0, 0], [10000, 0], 200)!;
    doc.add({ type: 'LWPOLYLINE', layer: 'A-COLUMN', pts: [[4700, -300], [5300, -300], [5300, 300], [4700, 300]], closed: true, arch: { role: 'column', shape: 'square' } });
    rebuildWalls(doc);
    const sideSegments = edges(doc, wall.id).filter((e) => e.type === 'LINE' && e.arch?.role === 'wall-edge' && Math.abs(e.a[1] - 100) < 1e-6 && Math.abs(e.b[1] - 100) < 1e-6);
    expect(sideSegments.some((e) => e.type === 'LINE' && e.a[0] <= 5000 && e.b[0] >= 5000)).toBe(false);
    const column = [...doc.entities.values()].find((e) => e.arch?.role === 'column')!;
    doc.remove(column.id);
    rebuildWalls(doc);
    const restored = edges(doc, wall.id).filter((e) => e.type === 'LINE' && e.arch?.role === 'wall-edge' && Math.abs(e.a[1] - 100) < 1e-6 && Math.abs(e.b[1] - 100) < 1e-6);
    expect(restored.some((e) => e.type === 'LINE' && e.a[0] <= 5000 && e.b[0] >= 5000)).toBe(true);
  });

  it('deletes a host wall and repairs the remaining crossing wall', () => {
    const doc = new CadDocument();
    const first = addWallPath(doc, [0, 0], [10000, 0], 200)!;
    const second = addWallPath(doc, [5000, -5000], [5000, 5000], 200)!;
    expect(wallPaths(doc)).toHaveLength(2);
    expect(deleteArchitecturalWall(doc, second.id)).toBe(true);
    expect(wallPaths(doc)).toHaveLength(1);
    const horizontal = edges(doc, first.id).filter((e) => e.type === 'LINE' && e.arch?.role === 'wall-edge' && Math.abs(e.a[1] - 100) < 1e-6 && Math.abs(e.b[1] - 100) < 1e-6);
    expect(horizontal.some((e) => e.type === 'LINE' && e.a[0] <= 5000 && e.b[0] >= 5000)).toBe(true);
  });

  it('ERASE removes a selected wall as a whole, repairs its junction, and OOPS restores it', async () => {
    const doc = new CadDocument();
    const first = addWallPath(doc, [0, 0], [10000, 0], 200)!;
    const second = addWallPath(doc, [5000, -5000], [5000, 5000], 200)!;
    const name = ensureOpeningBlock(doc, 'door', 900, 200, 1);
    const door = doc.add({ type: 'INSERT', layer: 'A-OPENING', name, p: [5000, 1000], sx: 1, sy: 1, rot: Math.PI / 2, arch: { role: 'opening-symbol', wallId: second.id, openingId: -1, station: 6000, width: 900, kind: 'door', side: 1 } });
    doc.update(door.id, { arch: { role: 'opening-symbol', wallId: second.id, openingId: door.id, station: 6000, width: 900, kind: 'door', side: 1 } });
    setWallOpening(doc, second.id, { id: door.id, station: 6000, width: 900, kind: 'door', side: 1 });
    const edge = edges(doc, second.id)[0];
    const engine = registerAll(new CommandEngine(doc, { pick: () => null, windowSelect: () => [] }));
    engine.selection.add(edge.id);
    await engine.run('ERASE');
    expect(wallPaths(doc)).toHaveLength(1);
    expect([...doc.entities.values()].some((e) => e.arch?.role === 'opening-symbol')).toBe(false);
    expect(edges(doc, first.id).some((e) => e.type === 'LINE' && e.a[0] <= 5000 && e.b[0] >= 5000 && Math.abs(e.a[1] - 100) < 1e-6 && Math.abs(e.b[1] - 100) < 1e-6)).toBe(true);
    await engine.run('OOPS');
    expect(wallPaths(doc)).toHaveLength(2);
    const restored = wallPaths(doc).find((e) => e.id !== first.id);
    expect(restored).toBeDefined();
    expect(restored?.arch.openings).toHaveLength(1);
    const restoredOpening = [...doc.entities.values()].find((e) => e.arch?.role === 'opening-symbol');
    expect(restoredOpening?.arch).toMatchObject({ wallId: restored?.id, openingId: restoredOpening?.id, station: 6000 });
  });

  it('ERASE/OOPS rebuild wall openings and column clearances', async () => {
    const doc = new CadDocument();
    const wall = addWallPath(doc, [0, 0], [10000, 0], 200)!;
    const name = ensureOpeningBlock(doc, 'window', 900, 200, 1);
    const insert = doc.add({ type: 'INSERT', layer: 'A-OPENING', name, p: [5000, 0], sx: 1, sy: 1, rot: 0, arch: { role: 'opening-symbol', wallId: wall.id, openingId: -1, station: 5000, width: 900, kind: 'window', side: 1 } });
    doc.update(insert.id, { arch: { role: 'opening-symbol', wallId: wall.id, openingId: insert.id, station: 5000, width: 900, kind: 'window', side: 1 } });
    setWallOpening(doc, wall.id, { id: insert.id, station: 5000, width: 900, kind: 'window', side: 1 });
    const engine = registerAll(new CommandEngine(doc, { pick: () => null, windowSelect: () => [] }));
    engine.selection.add(insert.id);
    await engine.run('ERASE');
    expect(wallPath(doc, wall.id)?.arch.openings).toHaveLength(0);
    await engine.run('OOPS');
    expect(wallPath(doc, wall.id)?.arch.openings).toHaveLength(1);
  });

  it('replaces windows with doors and flips door swings without losing host association', () => {
    const doc = new CadDocument();
    const wall = addWallPath(doc, [0, 0], [10000, 0], 200)!;
    const name = ensureOpeningBlock(doc, 'window', 900, 200, 1);
    const insert = doc.add({ type: 'INSERT', layer: 'A-OPENING', name, p: [5000, 0], sx: 1, sy: 1, rot: 0, arch: { role: 'opening-symbol', wallId: wall.id, openingId: -1, station: 5000, width: 900, kind: 'window', side: 1 } });
    doc.update(insert.id, { arch: { role: 'opening-symbol', wallId: wall.id, openingId: insert.id, station: 5000, width: 900, kind: 'window', side: 1 } });
    setWallOpening(doc, wall.id, { id: insert.id, station: 5000, width: 900, kind: 'window', side: 1 });
    expect(changeOpening(doc, insert.id, 'door')).toBe(true);
    expect(doc.get(insert.id)?.arch).toMatchObject({ kind: 'door', side: 1 });
    expect(changeOpening(doc, insert.id, 'door', -1)).toBe(true);
    expect(doc.get(insert.id)?.arch).toMatchObject({ kind: 'door', side: -1 });
    expect(wallPath(doc, wall.id)?.arch.openings[0]).toMatchObject({ kind: 'door', side: -1 });
  });

  it('AXISGRID command produces numbered and lettered grid lines and bubbles', async () => {
    const doc = new CadDocument();
    const engine = registerAll(new CommandEngine(doc, { pick: () => null, windowSelect: () => [] }));
    const run = engine.run('AXISGRID');
    await engine.waitInput(); engine.point([0, 0]);
    await engine.waitInput(); engine.point([10000, 8000]);
    await engine.waitInput(); engine.text('3');
    await engine.waitInput(); engine.text('2');
    await run;
    expect([...doc.entities.values()].filter((e) => e.layer === 'A-AXIS' && e.type === 'LINE')).toHaveLength(5);
    expect([...doc.entities.values()].filter((e) => e.layer === 'A-AXIS' && e.type === 'CIRCLE')).toHaveLength(5);
    expect([...doc.entities.values()].filter((e) => e.layer === 'A-AXIS' && e.type === 'TEXT')).toHaveLength(5);
    expect(engine.registry.has('WALL')).toBe(true);
    expect(engine.registry.has('COLUMN')).toBe(true);
    expect(engine.registry.has('DOOR')).toBe(true);
    expect(engine.registry.has('WINDOW')).toBe(true);
  });

  it('WALL, WALLFROM, WALLTHICK, and COLUMN commands make architectural edits', async () => {
    const doc = new CadDocument();
    const engine = registerAll(new CommandEngine(doc, { pick: () => null, windowSelect: () => [] }));
    const drawWall = engine.run('WALL');
    await engine.waitInput(); engine.point([0, 0]);
    await engine.waitInput(); engine.point([10000, 0]);
    await engine.waitInput(); engine.text('200');
    await drawWall;
    const wall = wallPaths(doc)[0];
    expect(wall.arch.thickness).toBe(200);

    const source = doc.add({ type: 'LINE', layer: '0', a: [0, 1000], b: [6000, 1000] });
    engine.selection.add(source.id);
    const convert = engine.run('WALLFROM');
    await engine.waitInput(); engine.text('180');
    await convert;
    expect(doc.get(source.id)).toBeUndefined();
    expect(wallPaths(doc)).toHaveLength(2);

    const edge = edges(doc, wall.id)[0];
    const pickHost = new CommandEngine(doc, { pick: (_p, filter) => filter?.(edge) ? edge.id : null, windowSelect: () => [] });
    const commands = registerAll(pickHost);
    const thicken = commands.run('WALLTHICK');
    await commands.waitInput(); commands.point([5000, 100]);
    await commands.waitInput(); commands.text('300');
    await thicken;
    expect(wallPath(doc, wall.id)?.arch.thickness).toBe(300);

    const column = commands.run('COLUMN');
    await commands.waitInput(); commands.text('S');
    await commands.waitInput(); commands.point([5000, 0]);
    await commands.waitInput(); commands.text('600');
    await column;
    expect([...doc.entities.values()].some((e) => e.arch?.role === 'column')).toBe(true);
  });

  it('DOOR, REPLACEOPENING, and FLIPDOOR commands preserve the host-wall relationship', async () => {
    const doc = new CadDocument();
    const wall = addWallPath(doc, [0, 0], [10000, 0], 200)!;
    let pickId = edges(doc, wall.id)[0].id;
    const engine = registerAll(new CommandEngine(doc, { pick: (_p, filter) => filter?.(doc.get(pickId)!) ? pickId : null, windowSelect: () => [] }));
    const door = engine.run('DOOR');
    await engine.waitInput(); engine.point([5000, 100]);
    await engine.waitInput(); engine.text('900');
    await engine.waitInput(); engine.text('R');
    await door;
    let opening = [...doc.entities.values()].find((e) => e.arch?.role === 'opening-symbol');
    expect(opening?.arch).toMatchObject({ kind: 'door', side: -1, station: 5000 });
    if (!opening) throw new Error('Door command did not create an opening insert.');
    pickId = opening.id;
    const replace = engine.run('REPLACEOPENING');
    await engine.waitInput(); engine.point([5000, 0]);
    await engine.waitInput(); engine.text('W');
    await replace;
    opening = doc.get(opening.id);
    expect(opening?.arch).toMatchObject({ kind: 'window', side: -1 });
    pickId = opening!.id;
    const replaceBack = engine.run('REPLACEOPENING');
    await engine.waitInput(); engine.point([5000, 0]);
    await engine.waitInput(); engine.text('D');
    await replaceBack;
    opening = doc.get(opening!.id);
    expect(opening?.arch).toMatchObject({ kind: 'door', side: -1 });
    pickId = opening!.id;
    const flip = engine.run('FLIPDOOR');
    await engine.waitInput(); engine.point([5000, 0]);
    await flip;
    expect(doc.get(opening!.id)?.arch).toMatchObject({ kind: 'door', side: 1 });
  });
});