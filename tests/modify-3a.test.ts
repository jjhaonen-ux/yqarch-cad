/**
 * Phase 3A acceptance tests: MOVE / COPY / ROTATE / SCALE / MIRROR / ERASE / EXPLODE on every entity type (including
 * inserted and mirrored blocks), window / crossing / add / remove selection, noun-verb and verb-noun, grips, undo.
 *
 * Geometric oracle: for a transform T, the drawing of T(entity) must coincide with T applied to the drawing of the
 * entity (symmetric Hausdorff distance on the tessellation, real SHX fonts so texts are compared stroke by stroke).
 */
import { describe, expect, it } from 'vitest';
import { CadDocument } from '../src/engine/model/document';
import { serialize } from '../src/engine/io/native';
import { runScript } from '../src/engine/commands/engine';
import { mirrorM, moveM, rotateAbout, scaleAbout, transformEntity } from '../src/engine/geom/transform';
import { affineEntity } from '../src/engine/geom/affine';
import { apply, insertMatrix, mmul, scaleM, type Mat } from '../src/engine/geom/matrix';
import { entityGrips, stretchGrips } from '../src/engine/edit/grips';
import { evalSpline } from '../src/engine/geom/spline';
import { explodeEntity, xform } from '../src/engine/commands/modify';
import { importLibraryBlock } from '../src/engine/io/library';
import { dimMeasurement, readableAngle } from '../src/engine/model/dimension';
import type { DrawingJson } from '../src/engine/io/native';
import type { ArcEnt, DimEnt, EllipseEnt, Entity, HatchEnt, InsertEnt, NewEntity, PolylineEnt, Pt, TextEnt } from '../src/engine/types';
import { asset, bboxOf, engineWithHost, equip, hausdorff, mapStrokes, strokeLength, strokes } from './helpers-3a';
import { readdirSync } from 'node:fs';

const DEG = Math.PI / 180;

/** A drawing with one entity of every type (blocks with attributes, nested and mirrored inserts, MINSERT, hatches…). */
function fixture(): { doc: CadDocument; ids: Record<string, number> } {
  const doc = equip(new CadDocument());
  doc.ensureLayer('WALL');
  doc.setBlock({ name: 'INNER', base: [0, 0], entities: [
    { id: -1, type: 'LINE', layer: '0', a: [0, 0], b: [4, 0], color: 0 },
    { id: -1, type: 'ARC', layer: '0', c: [2, 0], r: 2, a0: 0, a1: Math.PI },
  ] });
  doc.setBlock({ name: 'DOOR', base: [1, 1], entities: [
    { id: -1, type: 'LINE', layer: '0', a: [0, 0], b: [10, 0] },
    { id: -1, type: 'CIRCLE', layer: '0', c: [5, 5], r: 3 },
    { id: -1, type: 'ARC', layer: 'WALL', c: [0, 0], r: 10, a0: 0, a1: Math.PI / 2 },
    { id: -1, type: 'LWPOLYLINE', layer: '0', pts: [[0, 0, 0.4], [6, 0], [6, 4, -0.7], [0, 4]], closed: true },
    { id: -1, type: 'TEXT', layer: '0', text: 'D-01', p: [1, 6], h: 1.5, rot: 0, style: 'Standard' },
    { id: -1, type: 'INSERT', layer: '0', name: 'INNER', p: [2, 2], sx: 1, sy: 1, rot: 0.6 },
    { id: -1, type: 'ATTDEF', layer: '0', text: 'X', tag: 'TAG', p: [0, -3], h: 1, rot: 0, style: 'Standard' },
  ] });
  const ids: Record<string, number> = {};
  const add = (k: string, n: Record<string, unknown>) => { ids[k] = doc.add(n as unknown as NewEntity).id; };
  add('line', { type: 'LINE', layer: 'WALL', a: [3, 4], b: [17, 9] });
  add('point', { type: 'POINT', layer: '0', p: [5, -5] });
  add('circle', { type: 'CIRCLE', layer: '0', c: [20, 5], r: 4 });
  add('arc', { type: 'ARC', layer: '0', c: [30, 5], r: 5, a0: 0.3, a1: 2.4 });
  add('ellipse', { type: 'ELLIPSE', layer: '0', c: [40, 5], major: [6, 2], ratio: 0.45, a0: 0, a1: Math.PI * 2 });
  add('ellarc', { type: 'ELLIPSE', layer: '0', c: [55, 5], major: [-3, 5], ratio: 0.6, a0: 0.5, a1: 4.0 });
  add('pline', { type: 'LWPOLYLINE', layer: '0', pts: [[0, 20, 0.5], [8, 20], [8, 26, -0.3], [2, 28]], closed: false });
  add('wpline', { type: 'LWPOLYLINE', layer: '0', pts: [[12, 20], [20, 22, 0.6], [24, 28]], closed: true, width: 0.8 });
  add('spline', { type: 'SPLINE', layer: '0', degree: 3, closed: false, pts: [], ctrl: [[30, 20], [33, 26], [37, 18], [41, 25], [45, 21]], knots: [0, 0, 0, 0, 1, 2, 2, 2, 2] });
  (doc.get(ids.spline) as Entity & { pts: Pt[] }).pts = evalSpline(doc.get(ids.spline) as never);
  add('solid', { type: 'SOLID', layer: '0', pts: [[50, 20], [56, 20], [50, 26], [57, 27]] });
  add('wipeout', { type: 'WIPEOUT', layer: '0', loop: [[60, 20], [66, 20], [66, 26], [60, 26]] });
  add('text', { type: 'TEXT', layer: '0', text: 'Plan A-1', p: [0, 40], h: 2.5, rot: 0.2, style: 'Standard' });
  add('textC', { type: 'TEXT', layer: '0', text: 'Center', p: [20, 40], p2: [20, 40], halign: 1, h: 2, rot: 0, style: 'Standard' });
  add('textR', { type: 'TEXT', layer: '0', text: 'Right 9', p: [40, 40], p2: [40, 40], halign: 2, valign: 2, h: 2, rot: -0.4, style: 'Standard' });
  add('textM', { type: 'TEXT', layer: '0', text: 'Mid', p: [50, 40], p2: [50, 40], halign: 4, h: 2, rot: 0, style: 'Standard' });
  add('textT', { type: 'TEXT', layer: '0', text: 'TopL', p: [60, 40], p2: [60, 40], valign: 3, h: 2, rot: 1.1, style: 'Standard', widthFactor: 0.7, oblique: 15 * DEG });
  add('textAl', { type: 'TEXT', layer: '0', text: 'Aligned', p: [0, 50], p2: [14, 53], halign: 3, h: 2, rot: 0, style: 'Standard' });
  add('textFit', { type: 'TEXT', layer: '0', text: 'Fit', p: [20, 50], p2: [30, 50], halign: 5, h: 2, rot: 0, style: 'Standard' });
  add('mtext', { type: 'MTEXT', layer: '0', text: 'First line\\PSecond', p: [40, 55], h: 2, rot: 0.3, attach: 5, style: 'Standard' });
  add('mtextW', { type: 'MTEXT', layer: '0', text: 'one two three four five six', p: [60, 55], h: 1.5, rot: 0, attach: 1, width: 12, style: 'Standard' });
  add('insert', { type: 'INSERT', layer: 'WALL', name: 'DOOR', p: [0, 70], sx: 1, sy: 1, rot: 0.25, attribs: [{ text: 'A1', tag: 'TAG', p: [0, 66], h: 1.2, rot: 0.25, style: 'Standard', layer: 'WALL' }] });
  add('insertMir', { type: 'INSERT', layer: '0', name: 'DOOR', p: [25, 70], sx: -1.5, sy: 1.5, rot: 0.4, color: 3 });
  add('insertNU', { type: 'INSERT', layer: '0', name: 'DOOR', p: [45, 70], sx: 2, sy: 0.7, rot: -0.3 });
  add('minsert', { type: 'INSERT', layer: '0', name: 'INNER', p: [70, 70], sx: 1, sy: 1, rot: 0.2, cols: 3, rows: 2, colSpacing: 6, rowSpacing: 5 });
  add('dimAl', { type: 'DIMENSION', layer: '0', kind: 'aligned', p1: [0, 90], p2: [20, 95], loc: [0, 100] });
  add('dimLin', { type: 'DIMENSION', layer: '0', kind: 'linear', p1: [30, 90], p2: [50, 96], loc: [30, 102], rot: 0 });
  add('dimRad', { type: 'DIMENSION', layer: '0', kind: 'radius', p1: [70, 95], p2: [75, 98] });
  doc.setBlock({ name: '*D1', base: [0, 0], entities: [{ id: -1, type: 'LINE', layer: '0', a: [80, 90], b: [95, 90] }, { id: -1, type: 'TEXT', layer: '0', text: '1500', p: [85, 91], h: 1.5, rot: 0, style: 'Standard' }] });
  add('dimBlk', { type: 'DIMENSION', layer: '0', block: '*D1', textPoint: [87, 91] });
  add('hatch', { type: 'HATCH', layer: '0', pattern: 'ANSI31', solid: false, loops: [[[0, 110], [14, 110], [14, 120], [0, 120]]], scale: 1, angle: 30, origin: [1, 2] });
  add('hatchL', { type: 'HATCH', layer: '0', pattern: '_USER', solid: false, loops: [[[20, 110], [34, 110], [30, 121]]], lines: [{ angle: 0.5, base: [20, 110], offset: [0, 1.3], dashes: [2, -0.6] }] });
  add('hatchS', { type: 'HATCH', layer: '0', pattern: 'SOLID', solid: true, loops: [[[40, 110], [48, 110], [48, 118], [40, 118]]] });
  return { doc, ids };
}

const TRANSFORMS: [string, Mat][] = [
  ['move', moveM([13.5, -7.25])],
  ['rotate', rotateAbout([10, 20], 37 * DEG)],
  ['rotate180', rotateAbout([0, 0], Math.PI)],
  ['scale', scaleAbout([5, 5], 2.5)],
  ['scaleDown', scaleAbout([-3, 8], 0.4)],
  ['mirrorY', mirrorM([30, 0], [30, 10])],
  ['mirrorX', mirrorM([0, 60], [10, 60])],
  ['mirror30', mirrorM([5, 5], [5 + Math.cos(30 * DEG), 5 + Math.sin(30 * DEG)])],
];
const KEYS_NOT_EXACT_UNDER_MIRROR = new Set(['mtext', 'mtextW']); // MTEXT has no backward flag: it stays readable
const isEngineDim = (k: string) => k.startsWith('dim') && k !== 'dimBlk';

describe('transform oracle: every entity type × MOVE/ROTATE/SCALE/MIRROR (MIRRTEXT=1)', () => {
  const { doc, ids } = fixture();
  doc.setSettings({ mirrText: true });
  for (const [tn, m] of TRANSFORMS) {
    it(tn, () => {
      const bad: string[] = [];
      for (const [k, id] of Object.entries(ids)) {
        if (isEngineDim(k)) continue; // regenerated geometry; text placement re-evaluated (tested below)
        if (tn.startsWith('mirror') && KEYS_NOT_EXACT_UNDER_MIRROR.has(k)) continue;
        const e = doc.get(id)!;
        const before = strokes(doc, e);
        const after = strokes(doc, xform(doc, e, m));
        const size = Math.max(...((b) => [b[2] - b[0], b[3] - b[1]])(bboxOf(mapStrokes(before, m))), 1);
        const d = hausdorff(after, mapStrokes(before, m));
        if (!(d <= 2e-3 * size + 1e-9)) bad.push(`${k}: ${d.toExponential(2)} (size ${size.toFixed(1)})`);
      }
      expect(bad).toEqual([]);
    });
  }
  it('engine-made dimensions keep their defining points and measured value', () => {
    for (const [tn, m] of TRANSFORMS) for (const k of ['dimAl', 'dimLin', 'dimRad']) {
      const e = doc.get(ids[k]) as DimEnt;
      const t = xform(doc, e, m) as DimEnt;
      const s = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
      expect(dimMeasurement(t), `${k} ${tn}`).toBeCloseTo(dimMeasurement(e) * s, 6);
      const P = (p: Pt) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
      expect(t.p1).toEqual(P(e.p1!).map((v) => expect.closeTo(v, 9)));
      expect(t.p2).toEqual(P(e.p2!).map((v) => expect.closeTo(v, 9)));
    }
  });
});

describe('MIRROR with MIRRTEXT=0 keeps text readable and in the mirrored place', () => {
  const { doc, ids } = fixture();
  for (const [tn, m] of TRANSFORMS.filter(([n]) => n.startsWith('mirror'))) {
    it(tn, () => {
      for (const k of ['text', 'textC', 'textR', 'textM', 'textAl', 'textFit', 'mtext']) {
        const e = doc.get(ids[k])!;
        const t = xform(doc, e, m) as TextEnt;
        expect(t.mirrored, k).toBeFalsy();
        if (t.halign !== 3 && t.halign !== 5) expect(Math.abs(readableAngle(t.rot) - t.rot), `${k} readable`).toBeLessThan(1e-9);
        const src = e as TextEnt;
        if ((src.halign === 3 || src.halign === 5) && src.p2) {
          // aligned / fit: the baseline points are the mirrored points, and the text runs left to right (readable)
          const mp = [apply(m, src.p), apply(m, src.p2)];
          const same = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9;
          expect((same(t.p, mp[0]) && same(t.p2!, mp[1])) || (same(t.p, mp[1]) && same(t.p2!, mp[0])), `${k} baseline`).toBe(true);
          const dir = Math.atan2(t.p2![1] - t.p[1], t.p2![0] - t.p[0]);
          const dd = readableAngle(dir) - dir;
          expect(Math.abs(Math.atan2(Math.sin(dd), Math.cos(dd))), `${k} readable`).toBeLessThan(1e-9);
          continue;
        }
        const want = bboxOf(mapStrokes(strokes(doc, e), m)), got = bboxOf(strokes(doc, t));
        const h = src.h;
        for (let i = 0; i < 4; i++) expect(Math.abs(got[i] - want[i]), `${k} box`).toBeLessThan(0.75 * h);
      }
      // attributes of a mirrored block stay readable too
      const ins = xform(doc, doc.get(ids.insert)!, m) as InsertEnt;
      expect(ins.attribs![0].mirrored).toBeFalsy();
      expect(ins.sx * ins.sy).toBeLessThan(0);
    });
  }
});

describe('general affine maps (used by EXPLODE of non-uniformly scaled / mirrored blocks)', () => {
  const { doc, ids } = fixture();
  const ctx = { getBlock: (n: string) => doc.getBlock(n), getStyle: (n: string) => doc.getStyle(n), getLayer: (n: string) => doc.getLayer(n), patternLines: doc.patternLines };
  const MATS: [string, Mat][] = [
    ['nonuniform', mmul(rotateAbout([3, 3], 0.7), scaleM(2.2, 0.6))],
    ['nonuniform-mirror', mmul(scaleM(-1.4, 0.8), rotateAbout([0, 0], 0.3))],
    ['shear', [1, 0.2, 0.7, 1.1, 4, -2]],
  ];
  for (const [tn, m] of MATS) {
    it(tn, () => {
      const bad: string[] = [];
      for (const [k, id] of Object.entries(ids)) {
        if (isEngineDim(k) || k.startsWith('mtext') || k === 'textAl' || k === 'textFit' || k === 'textM' || k === 'textR' || k === 'textT' || k === 'textC') continue;
        const e = doc.get(id)!;
        const before = mapStrokes(strokes(doc, e), m);
        const parts = affineEntity(e, m, ctx);
        const after = parts.flatMap((p) => strokes(doc, { ...p, id: -5 } as Entity));
        const b = bboxOf(before);
        const size = Math.max(b[2] - b[0], b[3] - b[1], 1);
        const d = hausdorff(after, before);
        if (!(d <= 3e-3 * size)) bad.push(`${k}: ${d.toExponential(2)} (size ${size.toFixed(1)})`);
      }
      expect(bad).toEqual([]);
    });
  }
});

describe('commands through the command line, with undo / redo', () => {
  type Step = { name: string; cmd: string; tokens: (string | { p: Pt })[]; expectCount?: (before: number, n: number) => number };
  const STEPS: Step[] = [
    { name: 'MOVE', cmd: 'MOVE', tokens: ['10,10', '25,-5'] },
    { name: 'MOVE displacement', cmd: 'MOVE', tokens: ['D', '7,3'] },
    { name: 'COPY multiple + undo', cmd: 'COPY', tokens: ['0,0', '100,0', '200,0', 'U', '300,0', ''], expectCount: (b, n) => b + 2 * n },
    { name: 'ROTATE', cmd: 'ROTATE', tokens: ['10,10', '33'] },
    { name: 'ROTATE copy', cmd: 'ROTATE', tokens: ['10,10', 'C', '90'], expectCount: (b, n) => b + n },
    { name: 'ROTATE reference', cmd: 'ROTATE', tokens: ['0,0', 'R', '30', '75'] },
    { name: 'SCALE', cmd: 'SCALE', tokens: ['5,5', '2'] },
    { name: 'SCALE copy', cmd: 'SCALE', tokens: ['5,5', 'C', '0.5'], expectCount: (b, n) => b + n },
    { name: 'SCALE reference', cmd: 'SCALE', tokens: ['5,5', 'R', '4', '10'] },
    { name: 'MIRROR keep', cmd: 'MIRROR', tokens: ['0,0', '10,10', 'N'], expectCount: (b, n) => b + n },
    { name: 'MIRROR erase source', cmd: 'MIRROR', tokens: ['0,0', '0,10', 'Y'] },
    { name: 'ERASE', cmd: 'ERASE', tokens: [], expectCount: (b, n) => b - n },
  ];
  for (const s of STEPS) {
    it(`${s.name}: noun-verb on all entity types, undo restores, redo re-applies`, async () => {
      const { doc, ids } = fixture();
      const c = engineWithHost(doc);
      const sel = Object.values(ids);
      const before = serialize(doc), n0 = doc.size;
      c.selection = new Set(sel);
      await runScript(c, s.cmd, s.tokens);
      const after = serialize(doc);
      expect(after).not.toBe(before);
      expect(doc.size).toBe(s.expectCount ? s.expectCount(n0, sel.length) : n0);
      expect(doc.undo()).toBe(s.cmd);
      expect(serialize(doc)).toBe(before);
      doc.redo();
      expect(serialize(doc)).toBe(after);
    });
  }
  it('ROTATE / SCALE results equal the matrix transforms', async () => {
    const { doc, ids } = fixture();
    const c = engineWithHost(doc);
    const ref = fixture().doc;
    c.selection = new Set([ids.insertMir, ids.arc, ids.text]);
    await runScript(c, 'ROTATE', ['10,10', '33']);
    for (const k of ['insertMir', 'arc', 'text']) expect(doc.get(ids[k])).toEqual(xform(ref, ref.get(ids[k])!, rotateAbout([10, 10], 33 * DEG)));
    c.selection = new Set([ids.circle]);
    await runScript(c, 'SCALE', ['20,5', 'R', '4', '10']);
    expect((doc.get(ids.circle) as { r: number }).r).toBeCloseTo(10);
  });
  it('verb-noun: selection prompt with window, crossing, remove, add, undo and previous', async () => {
    const { doc, ids } = fixture();
    const c = engineWithHost(doc);
    // window (left→right) only takes fully enclosed objects; crossing (right→left) also takes touched ones
    const run = runScript(c, 'MOVE', [{ p: [-1, 3] }, { p: [18, 10] }, { p: [21, 2] }, { p: [19.5, 2.5] }, 'R', { p: [3.01, 4.005] }, 'U', 'U', 'A', { p: [20, 9] }, '', '0,0', '0,1']);
    await run;
    // line (window) + circle (crossing at its left edge) were moved; the remove and its undo cancel out; U removed the crossing; A + pick re-added circle
    expect((doc.get(ids.line) as { a: Pt }).a).toEqual([3, 5]);
    expect((doc.get(ids.circle) as { c: Pt }).c).toEqual([20, 6]);
    expect((doc.get(ids.point) as { p: Pt }).p).toEqual([5, -5]);
    // Previous
    await runScript(c, 'MOVE', ['P', '', '0,0', '1,0']);
    expect((doc.get(ids.line) as { a: Pt }).a).toEqual([4, 5]);
    expect((doc.get(ids.circle) as { c: Pt }).c).toEqual([21, 6]);
  });
  it('ALL, Last, SELECT command (pick-first), Ctrl+A, OOPS and pruning of erased ids', async () => {
    const { doc, ids } = fixture();
    const c = engineWithHost(doc);
    await runScript(c, 'SELECT', [{ p: [3, 4] }, { p: [5, -5] }, '']);
    expect([...c.selection].sort()).toEqual([ids.line, ids.point].sort());
    await runScript(c, 'ERASE', []);
    expect(doc.get(ids.line)).toBeUndefined();
    await runScript(c, 'OOPS', []);
    expect(doc.size).toBe(Object.keys(ids).length);
    c.selectAll();
    expect(c.selection.size).toBe(doc.size);
    const someId = [...c.selection][0];
    doc.remove(someId);
    c.pruneSelection();
    expect(c.selection.has(someId)).toBe(false);
    c.cancel();
    expect(c.selection.size).toBe(0);
    const newest = Math.max(...doc.entities.keys());
    const n0 = doc.size;
    await runScript(c, 'ERASE', ['L', '']);
    expect(doc.get(newest)).toBeUndefined();
    expect(doc.size).toBe(n0 - 1);
    await runScript(c, 'ERASE', ['ALL', '']);
    expect(doc.size).toBe(0);
    doc.undo();
    expect(doc.size).toBe(Object.keys(ids).length - 2);
  });
});

describe('EXPLODE', () => {
  it('explodes inserts (rotated, mirrored, non-uniform, MINSERT, nested), polylines, dimensions, hatches, MTEXT — drawing unchanged', () => {
    const { doc, ids } = fixture();
    const bad: string[] = [];
    for (const k of ['insert', 'insertMir', 'insertNU', 'minsert', 'pline', 'wpline', 'dimAl', 'dimBlk', 'hatch', 'hatchL', 'mtext']) {
      const e = doc.get(ids[k])!;
      const parts = explodeEntity(doc, e);
      expect(parts, k).not.toBeNull();
      const before = strokes(doc, e);
      const after = parts!.flatMap((p) => strokes(doc, { ...p, id: -7 } as Entity));
      const b = bboxOf(before), size = Math.max(b[2] - b[0], b[3] - b[1]);
      const d = hausdorff(after, before);
      if (!(d <= 3e-3 * size)) bad.push(`${k}: ${d.toExponential(2)} (size ${size.toFixed(1)})`);
      if (k !== 'wpline') { const L0 = strokeLength(before), L1 = strokeLength(after); if (Math.abs(L1 - L0) > 0.01 * L0) bad.push(`${k}: length ${L0.toFixed(2)} → ${L1.toFixed(2)}`); }
    }
    expect(bad).toEqual([]);
  });
  it('keeps the look: layer 0 → insert layer, ByBlock colour → insert colour, attributes → TEXT, ATTDEF dropped', () => {
    const { doc, ids } = fixture();
    const parts = explodeEntity(doc, doc.get(ids.insertMir)!)!;
    expect(parts.every((p) => p.layer === '0' || p.layer === 'WALL')).toBe(true);
    const ins = explodeEntity(doc, doc.get(ids.insert)!)!;
    expect(ins.filter((p) => p.type === 'TEXT').map((p) => (p as TextEnt).text).sort()).toEqual(['A1', 'D-01']);
    expect(ins.some((p) => p.type === 'ATTDEF')).toBe(false);
    expect(ins.filter((p) => p.type === 'LINE')[0].layer).toBe('WALL');
    const inner = ins.find((p) => p.type === 'INSERT') as InsertEnt;
    expect(inner.name).toBe('INNER');
    // nested insert under non-uniform scale with rotation → shear → expanded; ByBlock colour of the nested line resolves
    const nu = explodeEntity(doc, doc.get(ids.insertNU)!)!;
    expect(nu.some((p) => p.type === 'INSERT')).toBe(false);
    expect(nu.some((p) => p.type === 'ELLIPSE')).toBe(true); // circle under non-uniform scale
    const mir = explodeEntity(doc, doc.get(ids.insertMir)!)!;
    expect(mir.filter((p) => p.type === 'LINE' && (p as { color?: number }).color === 0)).toEqual([]);
  });
  it('refuses LINE / CIRCLE / solid hatch like AutoCAD, and EXPLODE is undoable', async () => {
    const { doc, ids } = fixture();
    expect(explodeEntity(doc, doc.get(ids.line)!)).toBeNull();
    expect(explodeEntity(doc, doc.get(ids.hatchS)!)).toBeNull();
    const c = engineWithHost(doc);
    const before = serialize(doc);
    c.selection = new Set(Object.values(ids));
    await runScript(c, 'EXPLODE', []);
    const after = serialize(doc);
    expect(doc.get(ids.insert)).toBeUndefined();
    expect(doc.get(ids.line)).toBeDefined();
    doc.undo(); expect(serialize(doc)).toBe(before);
    doc.redo(); expect(serialize(doc)).toBe(after);
  });
  it('explodes every library block (rotated + non-uniform, and mirrored) without changing the drawing', () => {
    const idx = asset<{ files: { file?: string; path?: string; output?: string }[] }>('blocks/index.json');
    const files = (readdirSync(new URL('../assets/blocks', import.meta.url), { recursive: true }) as string[]).filter((f) => f.endsWith('.json') && f !== 'index.json');
    expect(files.length).toBeGreaterThanOrEqual(idx.files.length > 0 ? 200 : 0);
    const bad: string[] = [];
    let n = 0;
    for (const f of files) {
      const doc = equip(new CadDocument());
      const json = asset<DrawingJson>(`blocks/${f}`);
      let name: string;
      try { name = importLibraryBlock(doc, json, null); } catch { continue; }
      const def = doc.getBlock(name);
      if (!def || !def.entities.length) continue;
      n++;
      for (const [sx, sy, rot] of [[1.7, 0.6, 0.4], [-1.3, 1.3, 1.0]]) {
        const ins = doc.add({ type: 'INSERT', layer: '0', name, p: [100, 50], sx, sy, rot } as NewEntity);
        const before = strokes(doc, ins);
        const parts = explodeEntity(doc, ins) ?? [];
        const after = parts.flatMap((p) => strokes(doc, { ...p, id: -9 } as Entity));
        const b0 = bboxOf(before), b1 = bboxOf(after);
        const size = Math.max(b0[2] - b0[0], b0[3] - b0[1]);
        const L0 = strokeLength(before), L1 = strokeLength(after);
        if (!before.length || !(size > 0)) { doc.remove(ins.id); continue; } // nothing drawn (e.g. only empty attributes)
        const boxErr = Math.max(...b0.map((v, i) => Math.abs(v - b1[i]))) / size;
        if (!(boxErr < 0.01) || !(Math.abs(L1 - L0) <= 0.01 * L0 + 1e-9)) bad.push(`${f} [${sx},${sy}]: box ${(boxErr * 100).toFixed(2)}% length ${L0.toFixed(1)}→${L1.toFixed(1)}`);
        doc.remove(ins.id);
      }
    }
    expect(n).toBeGreaterThanOrEqual(200);
    expect(bad).toEqual([]);
  }, 120000);
});

describe('grips', () => {
  const { doc, ids } = fixture();
  const g = (k: string) => entityGrips(doc.get(ids[k])!, { bbox: (e) => doc.bboxOf(e) });
  it('every entity type has grips; move grips translate', () => {
    for (const [k, id] of Object.entries(ids)) {
      const gr = g(k);
      expect(gr.length, k).toBeGreaterThan(0);
      const mv = gr.find((x) => x.kind === 'move');
      if (mv) expect(stretchGrips(doc.get(id)!, [mv.index], [3, 4])).toEqual(transformEntity(doc.get(id)!, moveM([3, 4])));
    }
  });
  it('LINE endpoint, CIRCLE quadrant, ARC start/mid, polyline arc midpoint, spline control point', () => {
    const line = stretchGrips(doc.get(ids.line)!, [1], [1, 1]) as { a: Pt; b: Pt };
    expect(line.b).toEqual([18, 10]); expect(line.a).toEqual([3, 4]);
    expect((stretchGrips(doc.get(ids.circle)!, [1], [2, 0]) as { r: number }).r).toBeCloseTo(6);
    const arc0 = doc.get(ids.arc) as ArcEnt;
    const gr = g('arc');
    const arc = stretchGrips(arc0, [1], [0.5, 0.2]) as ArcEnt;
    const S = [gr[1].p[0] + 0.5, gr[1].p[1] + 0.2], M = gr[3].p, E = gr[2].p;
    for (const q of [S, M, E]) expect(Math.hypot(q[0] - arc.c[0], q[1] - arc.c[1])).toBeCloseTo(arc.r, 9);
    expect(Math.hypot(Math.cos(arc.a0) * arc.r + arc.c[0] - S[0], Math.sin(arc.a0) * arc.r + arc.c[1] - S[1])).toBeLessThan(1e-9);
    const pl = doc.get(ids.pline) as PolylineEnt;
    const pg = g('pline');
    const midArc = pg[pl.pts.length]; // first segment has a bulge
    const pl2 = stretchGrips(pl, [midArc.index], [0, -1]) as PolylineEnt;
    const g2 = entityGrips(pl2);
    expect(g2[pl.pts.length].p[0]).toBeCloseTo(midArc.p[0], 9); expect(g2[pl.pts.length].p[1]).toBeCloseTo(midArc.p[1] - 1, 9);
    const straight = pg[pl.pts.length + 1]; // straight segment: moves both vertices
    const pl3 = stretchGrips(pl, [straight.index], [2, 0]) as PolylineEnt;
    expect(pl3.pts[1].slice(0, 2)).toEqual([10, 20]); expect(pl3.pts[2].slice(0, 2)).toEqual([10, 26]);
    const sp = stretchGrips(doc.get(ids.spline)!, [0], [-1, -1]) as { pts: Pt[]; ctrl: number[][] };
    expect(sp.ctrl[0]).toEqual([29, 19]); expect(sp.pts[0][0]).toBeCloseTo(29); expect(sp.pts[0][1]).toBeCloseTo(19);
  });
  it('ELLIPSE axis grip changes that axis and swaps axes when the minor becomes the longer one', () => {
    const e0 = doc.get(ids.ellipse) as EllipseEnt;
    const minorLen = Math.hypot(...e0.major) * e0.ratio;
    const e1 = stretchGrips(e0, [3], [-e0.major[1] / Math.hypot(...e0.major) * (12 - minorLen), e0.major[0] / Math.hypot(...e0.major) * (12 - minorLen)]) as EllipseEnt;
    expect(Math.hypot(...e1.major)).toBeCloseTo(12, 9);
    expect(e1.ratio).toBeCloseTo(Math.hypot(...e0.major) / 12, 9);
    const arc0 = doc.get(ids.ellarc) as EllipseEnt;
    const ga = entityGrips(arc0);
    const arc1 = stretchGrips(arc0, [3], [ga[3].p[0] - arc0.c[0], ga[3].p[1] - arc0.c[1]].map((v) => v * 2) as Pt) as EllipseEnt; // minor doubled → longer than major
    const pt = (e: EllipseEnt, t: number) => { const n = [-e.major[1] * e.ratio, e.major[0] * e.ratio]; return [e.c[0] + e.major[0] * Math.cos(t) + n[0] * Math.sin(t), e.c[1] + e.major[1] * Math.cos(t) + n[1] * Math.sin(t)]; };
    // start point of the arc moved consistently with the scaled minor axis
    const s0 = pt(arc0, arc0.a0), mn = [-arc0.major[1] * arc0.ratio, arc0.major[0] * arc0.ratio];
    const want = [arc0.c[0] + arc0.major[0] * Math.cos(arc0.a0) + 3 * mn[0] * Math.sin(arc0.a0), arc0.c[1] + arc0.major[1] * Math.cos(arc0.a0) + 3 * mn[1] * Math.sin(arc0.a0)];
    expect(s0).toBeTruthy();
    const got = pt(arc1, arc1.a0);
    expect(got[0]).toBeCloseTo(want[0], 6); expect(got[1]).toBeCloseTo(want[1], 6);
  });
  it('INSERT attribute grip moves only that attribute; hatch vertex grip reshapes the boundary', () => {
    const ins = stretchGrips(doc.get(ids.insert)!, [1], [0, -2]) as InsertEnt;
    expect(ins.p).toEqual((doc.get(ids.insert) as InsertEnt).p);
    expect(ins.attribs![0].p).toEqual([0, 64]);
    const h = stretchGrips(doc.get(ids.hatch)!, [2], [-1, -1]) as HatchEnt;
    expect(h.loops[0][1]).toEqual([13, 109]);
  });
});

describe('grip editing (GRIPEDIT)', () => {
  const setup = () => {
    const doc = equip(new CadDocument());
    const a = doc.add({ type: 'LINE', layer: '0', a: [0, 0], b: [10, 0] } as NewEntity);
    const b = doc.add({ type: 'LINE', layer: '0', a: [10, 0], b: [10, 10] } as NewEntity);
    const c = engineWithHost(doc);
    c.selection = new Set([a.id, b.id]);
    return { doc, a: a.id, b: b.id, c };
  };
  const feed = async (c: ReturnType<typeof engineWithHost>, tokens: (string | Pt)[]) => {
    for (const t of tokens) { await c.waitInput(); await Promise.resolve(); if (typeof t === 'string') c.text(t); else c.point(t); }
    await c.current;
  };
  it('STRETCH: one click on a shared endpoint makes both grips hot; result is one undo step; selection is kept', async () => {
    const { doc, a, b, c } = setup();
    const before = serialize(doc);
    const g = c.gripAt([10, 0], 0.1)!;
    const p = c.clickGrip({ id: g.id, index: g.index });
    expect(c.hotGrips.length).toBe(2);
    expect(c.lastPoint).toEqual([10, 0]); // the base point, so typed @dx,dy is relative to the grip
    await feed(c, ['@2,3']);
    await p;
    expect((doc.get(a) as { b: Pt }).b).toEqual([12, 3]);
    expect((doc.get(b) as { a: Pt }).a).toEqual([12, 3]);
    expect(c.selection.size).toBe(2);
    expect(c.hotGrips.length).toBe(0);
    doc.undo();
    expect(serialize(doc)).toBe(before);
  });
  it('Enter cycles STRETCH → MOVE → ROTATE → SCALE → MIRROR; MOVE / ROTATE / SCALE / MIRROR act on the whole selection', async () => {
    const run = async (enters: number, tokens: (string | Pt)[]) => {
      const s = setup();
      const g = s.c.gripAt([0, 0], 0.1)!;
      const p = s.c.clickGrip({ id: g.id, index: g.index })!;
      await feed(s.c, [...Array(enters).fill(''), ...tokens]);
      await p;
      return s;
    };
    let s = await run(1, [[5, 5]]); // MOVE
    expect((s.doc.get(s.b) as { b: Pt }).b).toEqual([15, 15]);
    s = await run(2, ['90']); // ROTATE about the grip
    expect((s.doc.get(s.a) as { b: Pt }).b.map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0, 10]);
    s = await run(3, ['2']); // SCALE about the grip
    expect((s.doc.get(s.b) as { b: Pt }).b).toEqual([20, 20]);
    s = await run(4, [[0, 10]]); // MIRROR about the vertical line through the grip
    expect((s.doc.get(s.b) as { b: Pt }).b.map((v) => Math.round(v * 1e9) / 1e9)).toEqual([-10, 10]);
    s = await run(5, [[1, 1]]); // back to STRETCH
    expect((s.doc.get(s.a) as { a: Pt }).a).toEqual([1, 1]);
  });
  it('Copy makes multiple copies, Undo removes the last one, eXit ends; Base point and Reference work', async () => {
    const s = setup();
    const g = s.c.gripAt([0, 0], 0.1)!;
    const p = s.c.clickGrip({ id: g.id, index: g.index })!;
    await feed(s.c, ['', 'C', [0, 20], [0, 40], 'U', [0, 60], 'X']);
    await p;
    expect(s.doc.size).toBe(6);
    s.doc.undo();
    expect(s.doc.size).toBe(2);
    const s2 = setup();
    const g2 = s2.c.gripAt([10, 10], 0.1)!;
    const p2 = s2.c.clickGrip({ id: g2.id, index: g2.index })!;
    await feed(s2.c, ['', '', 'B', '0,0', 'R', '0', '90']); // rotate about 0,0 with reference 0 → 90°
    await p2;
    expect((s2.doc.get(s2.b) as { b: Pt }).b.map((v) => Math.round(v * 1e9) / 1e9)).toEqual([-10, 10]);
    const s3 = setup();
    const g3 = s3.c.gripAt([0, 0], 0.1)!;
    const p3 = s3.c.clickGrip({ id: g3.id, index: g3.index })!;
    await feed(s3.c, ['', '', '', 'R', '10', '20']); // scale reference 10 → 20
    await p3;
    expect((s3.doc.get(s3.b) as { b: Pt }).b).toEqual([20, 20]);
  });
  it('Shift-click adds hot grips without starting an edit; Esc clears selection and grips', () => {
    const s = setup();
    const g0 = s.c.gripAt([0, 0], 0.1)!;
    expect(s.c.clickGrip({ id: g0.id, index: g0.index }, true)).toBeNull();
    expect(s.c.busy).toBe(false);
    expect(s.c.grips().filter((x) => x.hot).length).toBe(1);
    s.c.cancel();
    expect(s.c.selection.size).toBe(0);
    expect(s.c.grips()).toEqual([]);
  });
  it('grips work on mirrored inserts, and grips are not shown past the object limit', () => {
    const { doc, ids } = fixture();
    const c = engineWithHost(doc);
    c.selection = new Set([ids.insertMir]);
    const gr = c.grips();
    expect(gr[0].p).toEqual((doc.get(ids.insertMir) as InsertEnt).p);
    for (let i = 0; i < 120; i++) c.selection.add(doc.add({ type: 'POINT', layer: '0', p: [i, -50] } as NewEntity).id);
    expect(c.grips()).toEqual([]);
  });
});

describe('regressions', () => {
  it('hatch angle is in degrees: rotating a pattern hatch by 90° adds 90 to its angle and the pattern follows', () => {
    const { doc, ids } = fixture();
    const h = xform(doc, doc.get(ids.hatch)!, rotateAbout([0, 0], Math.PI / 2)) as HatchEnt;
    expect(h.angle).toBeCloseTo(120, 9);
    const m = moveM([3.3, 1.1]);
    const moved = xform(doc, doc.get(ids.hatch)!, m) as HatchEnt;
    expect(moved.origin).toEqual([4.3, 3.1]);
    expect(hausdorff(strokes(doc, moved), mapStrokes(strokes(doc, doc.get(ids.hatch)!), m))).toBeLessThan(1e-6);
  });
  it('a mirrored insert stays mirrored-correct after a second mirror (back to the original)', () => {
    const { doc, ids } = fixture();
    const m = mirrorM([0, 0], [1, 2]);
    const e = doc.get(ids.insertMir) as InsertEnt;
    const twice = xform(doc, xform(doc, e, m), m) as InsertEnt;
    const im0 = insertMatrix(e.p, e.sx, e.sy, e.rot, [1, 1]), im1 = insertMatrix(twice.p, twice.sx, twice.sy, twice.rot, [1, 1]);
    im0.forEach((v, i) => expect(im1[i]).toBeCloseTo(v, 9));
  });
  it('performance: MOVE of 20 000 lines and its undo stay fast', async () => {
    const doc = equip(new CadDocument());
    const c = engineWithHost(doc);
    for (let i = 0; i < 20000; i++) doc.add({ type: 'LINE', layer: '0', a: [i, 0], b: [i, 10] } as NewEntity);
    doc.clearHistory();
    c.selectAll();
    const t0 = performance.now();
    await runScript(c, 'MOVE', ['0,0', '5,5']);
    const t1 = performance.now();
    doc.undo();
    const t2 = performance.now();
    expect(t1 - t0).toBeLessThan(3000);
    expect(t2 - t1).toBeLessThan(3000);
  });
});
