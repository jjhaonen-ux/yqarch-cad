import type { Entity, NewEntity, Pt } from '../types';
import { unitsPerMm } from '../model/settings';
import { ensureArchitecturalLayers, addWallPath, changeOpening, deleteArchitecturalWall, ensureOpeningBlock, openingEntityFor, projectToWall, rebuildWalls, refreshWallOpeningBlocks, setWallOpening, wallPath } from '../architecture/geometry';
import { kw, type CommandDef, type CommandEngine } from './engine';

const ARCH_EDGE = (e: Entity) => e.arch?.role === 'wall-edge' || e.arch?.role === 'wall-jamb';
const OPENING = (e: Entity) => e.arch?.role === 'opening-symbol';
const WALL_MM = (c: CommandEngine, mm: number) => mm * unitsPerMm(c.doc.units);
const textHeight = (c: CommandEngine) => c.paper(2.5);
const length = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const unit = (a: Pt, b: Pt): Pt => { const d = length(a, b) || 1; return [(b[0] - a[0]) / d, (b[1] - a[1]) / d]; };
const normal = (u: Pt): Pt => [-u[1], u[0]];
const plus = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
const times = (a: Pt, n: number): Pt => [a[0] * n, a[1] * n];

function wallPreview(a: Pt, b: Pt, thickness: number, layer = 'A-WALL'): NewEntity[] {
  const u = unit(a, b), n = times(normal(u), thickness / 2);
  return [
    { type: 'LINE', layer, a: plus(a, n), b: plus(b, n) },
    { type: 'LINE', layer, a: plus(a, times(n, -1)), b: plus(b, times(n, -1)) },
    { type: 'LINE', layer, a: plus(a, n), b: plus(a, times(n, -1)) },
    { type: 'LINE', layer, a: plus(b, n), b: plus(b, times(n, -1)) },
  ];
}

function addAxisBubble(c: CommandEngine, p: Pt, label: string, radius: number, layer = 'A-AXIS') {
  c.doc.add({ type: 'CIRCLE', layer, c: p, r: radius });
  c.doc.add({
    type: 'TEXT', layer, text: label, p, p2: p, h: Math.max(textHeight(c), radius * 0.85), rot: 0,
    style: 'STANDARD', halign: 1, valign: 2,
  });
}

function gridLabel(index: number): string {
  let n = index + 1, out = '';
  while (n > 0) { const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = Math.floor((n - 1) / 26); }
  return out;
}

function parsePositiveCount(s: string | null, fallback: number): number | null {
  if (s === null || !s.trim()) return fallback;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n >= 2 && n <= 50 ? n : null;
}

function wallData(c: CommandEngine, id: number) {
  const e = c.doc.get(id);
  return e?.type === 'LINE' && e.arch?.role === 'wall-path' ? e : undefined;
}

function openingInsert(c: CommandEngine, id: number) {
  const e = c.doc.get(id);
  return e && openingEntityFor(c.doc, e) ? e : undefined;
}

const WALL: CommandDef = {
  name: 'WALL', names: ['WA'], title: ['Architectural wall', 'جدار معماري'], group: 'draw',
  async run(c) {
    ensureArchitecturalLayers(c.doc);
    const a = await c.requirePoint(['Specify wall start point', 'حدد بداية الجدار']);
    const defaultThickness = WALL_MM(c, 200);
    for (;;) {
      const b = await c.getPoint(['Specify wall end point', 'حدد نهاية الجدار'], {
        base: a,
        preview: (p) => length(a, p) > 1e-8 ? wallPreview(a, p, defaultThickness) : [],
      });
      if (!Array.isArray(b)) return;
      if (length(a, b) <= 1e-8) { c.error(['Wall length must be greater than zero.', 'يجب أن يكون طول الجدار أكبر من صفر.']); continue; }
      const v = await c.getDistance(['Wall thickness', 'سماكة الجدار'], { defaultText: c.fmt(defaultThickness) });
      const thickness = typeof v === 'number' ? v : defaultThickness;
      if (!(thickness > 0)) { c.error(['Wall thickness must be positive.', 'يجب أن تكون سماكة الجدار موجبة.']); continue; }
      addWallPath(c.doc, a, b, thickness);
      c.print(['Wall created and intersections rebuilt.', 'تم إنشاء الجدار وإعادة بناء التقاطعات.']);
      return;
    }
  },
};

const WALLFROM: CommandDef = {
  name: 'WALLFROM', names: ['WFROM'], title: ['Convert lines to walls', 'تحويل خطوط إلى جدران'], group: 'draw',
  async run(c) {
    const ids = await c.getSelection(['Select centerline(s) to convert', 'اختر خطوط المحور لتحويلها'], { filter: (e) => e.type === 'LINE' && !e.arch });
    if (!ids.length) return;
    const fallback = WALL_MM(c, 200);
    const v = await c.getDistance(['Wall thickness', 'سماكة الجدار'], { defaultText: c.fmt(fallback) });
    const thickness = typeof v === 'number' ? v : fallback;
    if (!(thickness > 0)) { c.error(['Wall thickness must be positive.', 'يجب أن تكون سماكة الجدار موجبة.']); return; }
    const selected = ids.map((id) => c.doc.get(id)).filter((e): e is Extract<Entity, { type: 'LINE' }> => e?.type === 'LINE');
    for (const e of selected) { addWallPath(c.doc, e.a, e.b, thickness); c.doc.remove(e.id); }
    rebuildWalls(c.doc);
    c.print([`${selected.length} line(s) converted to architectural walls.`, `تم تحويل ${selected.length} خط إلى جدران معمارية.`]);
  },
};

const WALLTHICK: CommandDef = {
  name: 'WALLTHICK', names: ['WTHICK'], title: ['Change wall thickness', 'تغيير سماكة الجدار'], group: 'modify',
  async run(c) {
    const picked = await c.getEntity(['Select a wall edge', 'اختر حافة جدار'], { filter: ARCH_EDGE });
    if (!picked || typeof picked === 'string') return;
    const edge = c.doc.get(picked.id);
    const wallId = edge?.arch && (edge.arch.role === 'wall-edge' || edge.arch.role === 'wall-jamb') ? edge.arch.wallId : -1;
    const wall = wallData(c, wallId);
    if (!wall || wall.arch?.role !== 'wall-path') { c.error(['The selected edge is not connected to a wall record.', 'الحافة المختارة غير مرتبطة بسجل جدار.']); return; }
    const v = await c.getDistance(['New wall thickness', 'سماكة الجدار الجديدة'], { defaultText: c.fmt(wall.arch.thickness) });
    if (typeof v !== 'number' || !(v > 0)) { c.error(['Wall thickness must be positive.', 'يجب أن تكون سماكة الجدار موجبة.']); return; }
    c.doc.update(wall.id, { arch: { ...wall.arch, thickness: v } });
    refreshWallOpeningBlocks(c.doc, wall.id);
    rebuildWalls(c.doc);
    c.print(['Wall thickness updated; intersections repaired.', 'تم تحديث سماكة الجدار وإصلاح التقاطعات.']);
  },
};

const WALLDELETE: CommandDef = {
  name: 'WALLDELETE', names: ['WDEL'], title: ['Delete wall and repair junctions', 'حذف جدار وإصلاح التقاطعات'], group: 'modify',
  async run(c) {
    const picked = await c.getEntity(['Select an edge of the wall to delete', 'اختر حافة الجدار المطلوب حذفه'], { filter: ARCH_EDGE });
    if (!picked || typeof picked === 'string') return;
    const edge = c.doc.get(picked.id);
    const wallId = edge?.arch && (edge.arch.role === 'wall-edge' || edge.arch.role === 'wall-jamb') ? edge.arch.wallId : -1;
    if (!deleteArchitecturalWall(c.doc, wallId)) { c.error(['The selected wall could not be found.', 'تعذر العثور على الجدار المحدد.']); return; }
    c.print(['Wall deleted; adjacent walls were rebuilt.', 'تم حذف الجدار وإعادة بناء الجدران المجاورة.']);
  },
};

const AXIS: CommandDef = {
  name: 'AXIS', names: ['AX'], title: ['Architectural axis', 'محور معماري'], group: 'draw',
  async run(c) {
    ensureArchitecturalLayers(c.doc);
    const a = await c.requirePoint(['Specify axis start point', 'حدد بداية المحور']);
    const b = await c.requirePoint(['Specify axis end point', 'حدد نهاية المحور'], { base: a });
    if (length(a, b) <= 1e-8) { c.error(['Axis length must be greater than zero.', 'يجب أن يكون طول المحور أكبر من صفر.']); return; }
    const label = await c.getString(['Axis label', 'اسم المحور'], { defaultText: 'A' });
    if (!label) return;
    const u = unit(a, b), ext = textHeight(c) * 2.4, radius = textHeight(c) * 1.6;
    const start = plus(a, times(u, -ext)), end = plus(b, times(u, ext));
    c.doc.add({ type: 'LINE', layer: 'A-AXIS', a: plus(start, times(u, radius)), b: plus(end, times(u, -radius)) });
    addAxisBubble(c, start, label, radius);
    addAxisBubble(c, end, label, radius);
  },
};

const AXISGRID: CommandDef = {
  name: 'AXISGRID', names: ['AG'], title: ['Architectural axis grid', 'شبكة محاور معمارية'], group: 'draw',
  async run(c) {
    ensureArchitecturalLayers(c.doc);
    const p1 = await c.requirePoint(['Specify first grid corner', 'حدد الركن الأول للشبكة']);
    const p2 = await c.requirePoint(['Specify opposite grid corner', 'حدد الركن المقابل للشبكة'], { base: p1 });
    const x0 = Math.min(p1[0], p2[0]), x1 = Math.max(p1[0], p2[0]);
    const y0 = Math.min(p1[1], p2[1]), y1 = Math.max(p1[1], p2[1]);
    if (x1 - x0 <= 1e-8 || y1 - y0 <= 1e-8) { c.error(['Grid corners must define a non-zero rectangle.', 'يجب أن يحدّد الركنان مستطيلاً غير صفري.']); return; }
    const columns = parsePositiveCount(await c.getString(['Number of vertical axes (2–50)', 'عدد المحاور الرأسية (2–50)'], { defaultText: '5' }), 5);
    const rows = parsePositiveCount(await c.getString(['Number of horizontal axes (2–50)', 'عدد المحاور الأفقية (2–50)'], { defaultText: '4' }), 4);
    if (!columns || !rows) { c.error(['Grid counts must be integers from 2 to 50.', 'يجب أن تكون أعداد الشبكة أعداداً صحيحة من 2 إلى 50.']); return; }
    const bubble = textHeight(c) * 1.6, extension = bubble * 2.4;
    for (let i = 0; i < columns; i++) {
      const x = x0 + (x1 - x0) * i / (columns - 1);
      const labelAt: Pt = [x, y1 + extension];
      c.doc.add({ type: 'LINE', layer: 'A-AXIS', a: [x, y0], b: [x, labelAt[1] - bubble] });
      addAxisBubble(c, labelAt, String(i + 1), bubble);
    }
    for (let i = 0; i < rows; i++) {
      const y = y0 + (y1 - y0) * i / (rows - 1);
      const labelAt: Pt = [x0 - extension, y];
      c.doc.add({ type: 'LINE', layer: 'A-AXIS', a: [labelAt[0] + bubble, y], b: [x1, y] });
      addAxisBubble(c, labelAt, gridLabel(i), bubble);
    }
    c.print([`${columns} vertical and ${rows} horizontal axes created.`, `تم إنشاء ${columns} محور رأسي و${rows} محور أفقي.`]);
  },
};

function columnOutline(shape: 'square' | 'circle' | 'L' | 'T' | 'cross', center: Pt, width: number, depth: number): NewEntity {
  const x = width / 2, y = depth / 2, t = Math.min(width, depth) / 3;
  if (shape === 'circle') return { type: 'CIRCLE', layer: 'A-COLUMN', c: center, r: width / 2, arch: { role: 'column', shape } };
  let rel: Pt[];
  if (shape === 'L') rel = [[-x, -y], [x - t, -y], [x - t, -y + t], [-x + t, -y + t], [-x + t, y], [-x, y]];
  else if (shape === 'T') rel = [[-x, y], [x, y], [x, y - t], [t / 2, y - t], [t / 2, -y], [-t / 2, -y], [-t / 2, y - t], [-x, y - t]];
  else if (shape === 'cross') rel = [[-t / 2, y], [t / 2, y], [t / 2, t / 2], [x, t / 2], [x, -t / 2], [t / 2, -t / 2], [t / 2, -y], [-t / 2, -y], [-t / 2, -t / 2], [-x, -t / 2], [-x, t / 2], [-t / 2, t / 2]];
  else rel = [[-x, -y], [x, -y], [x, y], [-x, y]];
  return { type: 'LWPOLYLINE', layer: 'A-COLUMN', pts: rel.map(([dx, dy]) => [center[0] + dx, center[1] + dy]), closed: true, arch: { role: 'column', shape } };
}

const COLUMN: CommandDef = {
  name: 'COLUMN', names: ['COLN'], title: ['Architectural column', 'عمود معماري'], group: 'draw',
  async run(c) {
    ensureArchitecturalLayers(c.doc);
    const shape = await c.getKeyword(['Column shape [Square/Circle/L/T/Cross]', 'شكل العمود [مربع/دائري/L/T/صليب]'],
      [kw('S', 'Square', 'مربع'), kw('C', 'Circle', 'دائري'), kw('L', 'L-shaped', 'L'), kw('T', 'T-shaped', 'T'), kw('X', 'Cross', 'صليب')], { defaultText: 'S' });
    if (!shape) return;
    const center = await c.requirePoint(['Specify column center', 'حدد مركز العمود']);
    const defaultSize = WALL_MM(c, 400);
    const w = await c.getDistance(['Column width or diameter', 'عرض العمود أو قطره'], { defaultText: c.fmt(defaultSize) });
    const width = typeof w === 'number' ? w : defaultSize;
    if (!(width > 0)) { c.error(['Column size must be positive.', 'يجب أن يكون مقاس العمود موجباً.']); return; }
    let depth = width;
    if (shape !== 'C' && shape !== 'S') {
      const d = await c.getDistance(['Column depth', 'عمق العمود'], { defaultText: c.fmt(width) });
      depth = typeof d === 'number' ? d : width;
    }
    if (!(depth > 0)) { c.error(['Column depth must be positive.', 'يجب أن يكون عمق العمود موجباً.']); return; }
    const kind = ({ S: 'square', C: 'circle', L: 'L', T: 'T', X: 'cross' } as const)[shape as 'S' | 'C' | 'L' | 'T' | 'X'];
    c.doc.add(columnOutline(kind, center, width, depth));
    rebuildWalls(c.doc);
    c.print(['Column inserted; wall geometry updated around it.', 'تم إدراج العمود وتحديث هندسة الجدران حوله.']);
  },
};

async function placeOpening(c: CommandEngine, kind: 'door' | 'window') {
  ensureArchitecturalLayers(c.doc);
  const picked = await c.getEntity([`Select a wall edge for the ${kind}`, `اختر حافة جدار لإضافة ${kind === 'door' ? 'باب' : 'نافذة'}`], { filter: ARCH_EDGE });
  if (!picked || typeof picked === 'string') return;
  const edge = c.doc.get(picked.id);
  if (!edge?.arch || (edge.arch.role !== 'wall-edge' && edge.arch.role !== 'wall-jamb')) return;
  const wall = wallPath(c.doc, edge.arch.wallId);
  if (!wall) { c.error(['Wall record not found.', 'لم يتم العثور على سجل الجدار.']); return; }
  const projection = projectToWall(wall, picked.p);
  const defaultWidth = WALL_MM(c, kind === 'door' ? 900 : 1200);
  const v = await c.getDistance([`${kind === 'door' ? 'Door' : 'Window'} width`, `عرض ${kind === 'door' ? 'الباب' : 'النافذة'}`], { defaultText: c.fmt(defaultWidth) });
  const width = typeof v === 'number' ? v : defaultWidth;
  if (!(width > 0) || width > projection.length) { c.error(['Opening width must fit within the selected wall.', 'يجب أن يلائم عرض الفتحة طول الجدار المحدد.']); return; }
  const sideAnswer = kind === 'door' ? await c.getKeyword(['Door swing side [Left/Right]', 'جهة فتح الباب [يسار/يمين]'], [kw('L', 'Left', 'يسار'), kw('R', 'Right', 'يمين')], { defaultText: 'L' }) : 'L';
  if (!sideAnswer) return;
  const side: 1 | -1 = sideAnswer === 'R' ? -1 : 1;
  const station = Math.max(width / 2, Math.min(projection.length - width / 2, projection.station));
  const current = wall.arch.openings;
  const openId = -1;
  const left = station - width / 2, right = station + width / 2;
  if (current.some((o) => left < o.station + o.width / 2 && right > o.station - o.width / 2)) {
    c.error(['This opening overlaps an existing opening.', 'تتداخل هذه الفتحة مع فتحة موجودة.']); return;
  }
  const block = ensureOpeningBlock(c.doc, kind, width, wall.arch.thickness, side);
  const angle = Math.atan2(wall.b[1] - wall.a[1], wall.b[0] - wall.a[0]);
  const center: Pt = [wall.a[0] + (wall.b[0] - wall.a[0]) * station / projection.length, wall.a[1] + (wall.b[1] - wall.a[1]) * station / projection.length];
  const insert = c.doc.add({
    type: 'INSERT', layer: 'A-OPENING', name: block, p: center, sx: 1, sy: 1, rot: angle,
    arch: { role: 'opening-symbol', wallId: wall.id, openingId: openId, station, width, kind, side },
  });
  c.doc.update(insert.id, { arch: { role: 'opening-symbol', wallId: wall.id, openingId: insert.id, station, width, kind, side } });
  setWallOpening(c.doc, wall.id, { id: insert.id, station, width, kind, side });
  c.print([`${kind === 'door' ? 'Door' : 'Window'} opening created.`, `تم إنشاء فتحة ${kind === 'door' ? 'الباب' : 'النافذة'}.`]);
}

const DOOR: CommandDef = { name: 'DOOR', names: ['DR'], title: ['Insert door opening', 'إدراج باب وفتحة'], group: 'draw', run: (c) => placeOpening(c, 'door') };
const WINDOW: CommandDef = { name: 'WINDOW', names: ['WN'], title: ['Insert window opening', 'إدراج نافذة وفتحة'], group: 'draw', run: (c) => placeOpening(c, 'window') };

const REPLACEOPENING: CommandDef = {
  name: 'REPLACEOPENING', names: ['REPLACEOPEN'], title: ['Replace door/window', 'استبدال الباب أو النافذة'], group: 'modify',
  async run(c) {
    const picked = await c.getEntity(['Select a door or window', 'اختر باباً أو نافذة'], { filter: OPENING });
    if (!picked || typeof picked === 'string') return;
    const e = openingInsert(c, picked.id);
    if (!e) return;
    const k = await c.getKeyword(['Replace with [Door/Window]', 'استبدال بـ [باب/نافذة]'], [kw('D', 'Door', 'باب'), kw('W', 'Window', 'نافذة')], { defaultText: e.arch.kind === 'door' ? 'D' : 'W' });
    if (!k) return;
    if (!changeOpening(c.doc, e.id, k === 'D' ? 'door' : 'window')) c.error(['Could not replace the selected opening.', 'تعذر استبدال الفتحة المحددة.']);
  },
};

const FLIPDOOR: CommandDef = {
  name: 'FLIPDOOR', names: ['DFLIP'], title: ['Flip door swing', 'قلب اتجاه فتح الباب'], group: 'modify',
  async run(c) {
    const picked = await c.getEntity(['Select a door', 'اختر باباً'], { filter: (e) => OPENING(e) && e.arch?.role === 'opening-symbol' && e.arch.kind === 'door' });
    if (!picked || typeof picked === 'string') return;
    const e = openingInsert(c, picked.id);
    if (!e || e.arch.kind !== 'door') return;
    changeOpening(c.doc, e.id, 'door', e.arch.side === 1 ? -1 : 1);
    c.print(['Door swing flipped.', 'تم قلب اتجاه فتح الباب.']);
  },
};

export const ARCHITECTURE_COMMANDS: CommandDef[] = [WALL, WALLFROM, WALLTHICK, WALLDELETE, AXIS, AXISGRID, COLUMN, DOOR, WINDOW, REPLACEOPENING, FLIPDOOR];