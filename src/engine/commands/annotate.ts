/** Annotation commands: TEXT/DTEXT, MTEXT, DIMLINEAR, DIMALIGNED, DIMRADIUS, DIMDIAMETER, HATCH. */
import type { DimEnt, Entity, HatchEnt, NewEntity, Pt } from '../types';
import { angleOf, dist, polar } from '../geom/vec';
import { closedLoopOf, findBoundary } from '../geom/boundary';
import { unitsPerMm } from '../model/settings';
import { kw, KeywordAnswer, type CommandDef, type CommandEngine } from './engine';

const JUSTIFY: Record<string, [number, number]> = {
  L: [0, 0], C: [1, 0], R: [2, 0], M: [4, 0], TL: [0, 3], TC: [1, 3], TR: [2, 3], ML: [0, 2], MC: [1, 2], MR: [2, 2], BL: [0, 1], BC: [1, 1], BR: [2, 1],
};
const JUSTIFY_KW = [
  kw('L', 'Left', 'يسار'), kw('C', 'Center', 'وسط'), kw('R', 'Right', 'يمين'), kw('M', 'Middle', 'منتصف'),
  kw('TL', 'TL', 'أعلى يسار'), kw('TC', 'TC', 'أعلى وسط'), kw('TR', 'TR', 'أعلى يمين'), kw('ML', 'ML', 'وسط يسار'), kw('MC', 'MC', 'وسط'),
  kw('MR', 'MR', 'وسط يمين'), kw('BL', 'BL', 'أسفل يسار'), kw('BC', 'BC', 'أسفل وسط'), kw('BR', 'BR', 'أسفل يمين'),
];

/** Default text height in drawing units: paper height × drawing scale. */
export const defaultTextHeight = (c: CommandEngine) => (c.memory.textHeight as number) ?? c.paper(c.doc.settings.textHeight);

export const TEXT: CommandDef = {
  name: 'TEXT', names: ['DTEXT', 'DT'], title: ['Single-line text', 'نص سطر واحد'], group: 'annotate',
  async run(c) {
    const s = c.doc.settings;
    let style = s.currentTextStyle;
    let just = (c.memory.textJust as string) ?? 'L';
    c.print([`Current text style: "${style}"  Text height: ${c.fmt(defaultTextHeight(c))}  Justify: ${just}`, `نمط النص الحالي: "${style}"  الارتفاع: ${c.fmt(defaultTextHeight(c))}  المحاذاة: ${just}`]);
    let p: Pt;
    for (;;) {
      const r = await c.getPoint(['Specify start point of text', 'حدد نقطة بداية النص'], { keywords: [kw('J', 'Justify', 'محاذاة'), kw('S', 'Style', 'نمط')] });
      if (r === 'J') { const j = await c.getKeyword(['Enter an option', 'اختر المحاذاة'], JUSTIFY_KW, { defaultText: just }); if (j) { just = j; c.memory.textJust = j; } continue; }
      if (r === 'S') {
        const n = await c.getString(['Enter style name', 'أدخل اسم النمط'], { defaultText: style });
        if (n && c.doc.styles.has(n.toUpperCase())) style = c.doc.getStyle(n)!.name; else if (n) c.error([`Style ${n} not found.`, `النمط ${n} غير موجود.`]);
        continue;
      }
      if (!Array.isArray(r)) return;
      p = r; break;
    }
    const st = c.doc.getStyle(style);
    let h = st && st.height > 0 ? st.height : defaultTextHeight(c);
    if (!(st && st.height > 0)) {
      const hv = await c.getDistance(['Specify height', 'حدد ارتفاع النص'], { base: p, defaultText: c.fmt(h) });
      if (typeof hv === 'number' && hv > 0) h = hv;
      c.memory.textHeight = h;
    }
    const rotDef = (c.memory.textRot as number) ?? 0;
    const rv = await c.getAngle(['Specify rotation angle of text', 'حدد زاوية دوران النص'], { base: p, defaultText: c.fmt((rotDef * 180) / Math.PI) });
    const rot = typeof rv === 'number' ? rv : rotDef;
    c.memory.textRot = rot;
    const [ha, va] = JUSTIFY[just] ?? [0, 0];
    let at = p;
    for (;;) {
      const t = await c.getString(['Enter text', 'أدخل النص'], { allowSpaces: true });
      if (!t) return;
      const e: NewEntity = { type: 'TEXT', layer: '', text: t, p: at, h, rot, style, ...(ha || va ? { halign: ha, valign: va, p2: at } : {}) };
      c.add(e);
      at = polar(at, rot - Math.PI / 2, h * 1.6667);
    }
  },
};

export const MTEXT: CommandDef = {
  name: 'MTEXT', names: ['MT', 'T'], title: ['Multiline text', 'نص متعدد الأسطر'], group: 'annotate',
  async run(c) {
    const h = defaultTextHeight(c);
    const a = await c.requirePoint(['Specify first corner', 'حدد الركن الأول']);
    const b = await c.requirePoint(['Specify opposite corner', 'حدد الركن المقابل'], { base: a, rubber: 'rect' });
    let text: string | null | undefined;
    const d = c.host.dialog?.('mtext', { height: h, text: '' });
    if (d) { const r = (await d) as { text: string; height?: number } | null; if (!r) return; text = r.text.replace(/\r?\n/g, '\\P'); if (r.height) c.memory.textHeight = r.height; }
    else text = await c.getString(['Enter text (use \\P for a new line)', 'أدخل النص (\\P لسطر جديد)'], { allowSpaces: true });
    if (!text) return;
    const p: Pt = [Math.min(a[0], b[0]), Math.max(a[1], b[1])];
    c.add({ type: 'MTEXT', layer: '', text, p, h: (c.memory.textHeight as number) ?? h, rot: 0, attach: 1, style: c.doc.settings.currentTextStyle, width: Math.abs(b[0] - a[0]) });
  },
};

const dimBase = (c: CommandEngine): Pick<DimEnt, 'type' | 'layer' | 'dimScale'> => ({ type: 'DIMENSION', layer: c.doc.settings.currentLayer, dimScale: c.doc.settings.drawingScale });

/** Rotation for DIMLINEAR from the dimension line location (horizontal vs vertical), AutoCAD style. */
export function linearRotation(p1: Pt, p2: Pt, loc: Pt): number {
  const minx = Math.min(p1[0], p2[0]), maxx = Math.max(p1[0], p2[0]), miny = Math.min(p1[1], p2[1]), maxy = Math.max(p1[1], p2[1]);
  const outX = loc[0] < minx ? minx - loc[0] : loc[0] > maxx ? loc[0] - maxx : 0;
  const outY = loc[1] < miny ? miny - loc[1] : loc[1] > maxy ? loc[1] - maxy : 0;
  if (outY > 0 && outX === 0) return 0;
  if (outX > 0 && outY === 0) return Math.PI / 2;
  if (outX === 0 && outY === 0) return Math.abs(p2[0] - p1[0]) >= Math.abs(p2[1] - p1[1]) ? 0 : Math.PI / 2;
  return outY >= outX ? 0 : Math.PI / 2;
}

async function extOrigins(c: CommandEngine): Promise<[Pt, Pt] | null> {
  const r = await c.getPoint(['Specify first extension line origin or <select object>', 'حدد بداية خط الامتداد الأول أو <اختر كائناً>'], { allowNone: true });
  if (r === null) {
    const pick = await c.getEntity(['Select object to dimension', 'اختر الكائن المراد تبعيده'], { filter: (e) => e.type === 'LINE' || e.type === 'LWPOLYLINE' });
    if (!pick || typeof pick === 'string') return null;
    const e = c.doc.get(pick.id)!;
    if (e.type === 'LINE') return [e.a, e.b];
    if (e.type === 'LWPOLYLINE') { // nearest segment
      let best: [Pt, Pt] | null = null, bd = Infinity;
      const n = e.pts.length;
      for (let i = 0; i < (e.closed ? n : n - 1); i++) {
        const a: Pt = [e.pts[i][0], e.pts[i][1]], b: Pt = [e.pts[(i + 1) % n][0], e.pts[(i + 1) % n][1]];
        const d = dist(a, pick.p) + dist(b, pick.p) - dist(a, b);
        if (d < bd) { bd = d; best = [a, b]; }
      }
      return best;
    }
    return null;
  }
  if (!Array.isArray(r)) return null;
  const p2 = await c.requirePoint(['Specify second extension line origin', 'حدد بداية خط الامتداد الثاني'], { base: r });
  return [r, p2];
}

async function placeDim(c: CommandEngine, mk: (loc: Pt, mode: string) => DimEnt, kws = true) {
  let mode = 'auto';
  let text: string | undefined;
  let rotated = 0;
  const build = (loc: Pt) => { const d = mk(loc, mode); if (mode === 'R') d.rot = rotated; if (text !== undefined) d.text = text; return d; };
  for (;;) {
    const keywords = kws ? [kw('T', 'Text', 'نص'), kw('H', 'Horizontal', 'أفقي'), kw('V', 'Vertical', 'رأسي'), kw('R', 'Rotated', 'مدوّر')] : [kw('T', 'Text', 'نص')];
    const r = await c.getPoint(['Specify dimension line location', 'حدد موضع خط البعد'], { keywords, rubber: 'none', preview: (p) => [build(p) as unknown as NewEntity] });
    if (r === 'T') { const t = await c.getString(['Enter dimension text (<> = measured value)', 'أدخل نص البعد (<> = القيمة المقاسة)'], { allowSpaces: true, defaultText: '<>' }); if (t !== null) text = t; continue; }
    if (r === 'H' || r === 'V') { mode = r; continue; }
    if (r === 'R') { const a = await c.getAngle(['Specify angle of dimension line', 'حدد زاوية خط البعد']); if (typeof a === 'number') { rotated = a; mode = 'R'; } continue; }
    if (!Array.isArray(r)) return;
    const d = build(r);
    const { id: _id, ...rest } = d;
    const e = c.add(rest as NewEntity) as DimEnt;
    c.print([`Dimension text = ${c.fmt(dimValue(e), c.doc.settings.dim.precision)}`, `قيمة البعد = ${c.fmt(dimValue(e), c.doc.settings.dim.precision)}`]);
    return;
  }
}
function dimValue(d: DimEnt): number {
  if (!d.p1 || !d.p2) return d.measurement ?? 0;
  if (d.kind === 'linear') { const r = d.rot ?? 0; return Math.abs((d.p2[0] - d.p1[0]) * Math.cos(r) + (d.p2[1] - d.p1[1]) * Math.sin(r)); }
  if (d.kind === 'diameter') return 2 * dist(d.p1, d.p2);
  return dist(d.p1, d.p2);
}

export const DIMLINEAR: CommandDef = {
  name: 'DIMLINEAR', names: ['DIMLIN'], title: ['Linear dimension', 'بعد خطي'], group: 'annotate',
  async run(c) {
    const o = await extOrigins(c);
    if (!o) return;
    const [p1, p2] = o;
    await placeDim(c, (loc, mode) => ({ ...dimBase(c), id: -1, kind: 'linear', p1, p2, loc, rot: mode === 'H' ? 0 : mode === 'V' ? Math.PI / 2 : linearRotation(p1, p2, loc) }) as DimEnt);
  },
};
export const DIMALIGNED: CommandDef = {
  name: 'DIMALIGNED', names: ['DIMALI'], title: ['Aligned dimension', 'بعد مائل'], group: 'annotate',
  async run(c) {
    const o = await extOrigins(c);
    if (!o) return;
    const [p1, p2] = o;
    await placeDim(c, (loc) => ({ ...dimBase(c), id: -1, kind: 'aligned', p1, p2, loc }) as DimEnt, false);
  },
};
function radial(kind: 'radius' | 'diameter'): CommandDef['run'] {
  return async (c) => {
    const pick = await c.getEntity(['Select arc or circle', 'اختر قوساً أو دائرة'], { filter: (e) => e.type === 'CIRCLE' || e.type === 'ARC' });
    if (!pick || typeof pick === 'string') return;
    const picked = c.doc.get(pick.id);
    if (!picked || (picked.type !== 'CIRCLE' && picked.type !== 'ARC')) { c.error(['Select an arc or a circle.', 'اختر قوساً أو دائرة.']); return; }
    const e = picked as Extract<Entity, { type: 'CIRCLE' | 'ARC' }>;
    const ctr = e.c, r = e.r;
    await placeDim(c, (loc) => ({ ...dimBase(c), id: -1, kind, p1: ctr, p2: polar(ctr, angleOf(ctr, loc), r), loc }) as DimEnt, false);
  };
}
export const DIMRADIUS: CommandDef = { name: 'DIMRADIUS', names: ['DIMRAD'], title: ['Radius dimension', 'بعد نصف قطر'], group: 'annotate', run: radial('radius') };
export const DIMDIAMETER: CommandDef = { name: 'DIMDIAMETER', names: ['DIMDIA'], title: ['Diameter dimension', 'بعد قطر'], group: 'annotate', run: radial('diameter') };

/** Effective pattern scale in drawing units for the settings' hatch scale. */
export const hatchEffectiveScale = (c: CommandEngine, userScale = c.doc.settings.hatchScale) => userScale * c.doc.settings.drawingScale * unitsPerMm(c.doc.units);

export const HATCH: CommandDef = {
  name: 'HATCH', names: ['BHATCH', '-HATCH', '-BHATCH'], title: ['Hatch', 'تهشير'], group: 'annotate',
  async run(c) {
    const s = c.doc.settings;
    let pattern = s.hatchPattern, scale = s.hatchScale, angleDeg = s.hatchAngle;
    const persist = () => { if (pattern !== s.hatchPattern || scale !== s.hatchScale || angleDeg !== s.hatchAngle) c.doc.setSettings({ hatchPattern: pattern, hatchScale: scale, hatchAngle: angleDeg }); };
    const loops: Pt[][] = [];
    const make = (lp: Pt[][]): NewEntity => {
      const solid = /^solid$/i.test(pattern);
      return { type: 'HATCH', layer: c.doc.settings.currentLayer, pattern, solid, loops: lp.map((l) => [...l, l[0]]), scale: hatchEffectiveScale(c, scale), angle: (angleDeg * Math.PI) / 180 } as NewEntity;
    };
    c.print([`Pattern: ${pattern}  Scale: ${scale}  Angle: ${angleDeg}°`, `النقش: ${pattern}  المقياس: ${scale}  الزاوية: ${angleDeg}°`]);
    const keywords = [kw('S', 'Select objects', 'اختيار كائنات'), kw('P', 'Pattern', 'النقش'), kw('SC', 'SCale', 'المقياس'), kw('A', 'Angle', 'الزاوية'), kw('U', 'Undo', 'تراجع')];
    const added: number[] = [];
    for (;;) {
      const r = await c.getPoint(['Pick internal point', 'انقر نقطة داخل المنطقة'], { keywords, allowNone: true, noSnap: true, rubber: 'none', preview: () => (loops.length ? [make(loops)] : []) });
      if (r === null) break;
      if (r === 'P') {
        const dlg = c.host.dialog?.('pattern', { pattern, scale, angle: angleDeg });
        if (dlg) { const v = (await dlg) as { pattern: string; scale?: number; angle?: number } | null; if (v) { pattern = v.pattern; if (v.scale) scale = v.scale; if (v.angle !== undefined) angleDeg = v.angle; } }
        else { const n = await c.getString(['Enter a pattern name or [?/SOLID]', 'أدخل اسم النقش أو [SOLID]'], { defaultText: pattern }); if (n) pattern = n; }
        continue;
      }
      if (r === 'SC') { const v = await c.getDistance(['Specify a scale for the pattern', 'حدد مقياس النقش'], { defaultText: String(scale) }); if (typeof v === 'number' && v > 0) scale = v; continue; }
      if (r === 'A') { const v = await c.getAngle(['Specify an angle for the pattern', 'حدد زاوية النقش'], { defaultText: String(angleDeg) }); if (typeof v === 'number') angleDeg = Math.round(((v * 180) / Math.PI) * 1e6) / 1e6; continue; }
      if (r === 'U') { if (added.length) loops.length -= added.pop()!; continue; }
      if (r === 'S') {
        let ids: number[] = [];
        try { ids = await c.getSelection(['Select objects', 'اختر الكائنات'], { usePickfirst: false }); } catch (e) { if (!(e instanceof KeywordAnswer)) throw e; }
        let n = 0;
        for (const id of ids) { const e = c.doc.get(id); const l = e && closedLoopOf(e); if (l) { loops.push(l); n++; } }
        if (!n) c.error(['No closed objects selected.', 'لم يتم اختيار كائنات مغلقة.']);
        added.push(n);
        continue;
      }
      if (typeof r === 'string') continue;
      const box = c.host.viewBox?.() ?? c.doc.extents() ?? undefined;
      if (!box) { c.error(['Nothing to hatch.', 'لا توجد عناصر.']); continue; }
      const b = findBoundary(c.doc, r, box);
      if (!b) { c.error(['Valid hatch boundary not found.', 'لم يتم العثور على حدود مغلقة صالحة حول النقطة.']); continue; }
      loops.push(...b.loops); added.push(b.loops.length);
      c.print([`${b.loops.length} loop(s) found (${b.islands.length} island(s)).`, `تم العثور على ${b.loops.length} حلقة (${b.islands.length} جزيرة).`]);
    }
    persist();
    if (!loops.length) return;
    c.add(make(loops) as NewEntity);
  },
};
export type { HatchEnt };
export const ANNOTATE_COMMANDS = [TEXT, MTEXT, DIMLINEAR, DIMALIGNED, DIMRADIUS, DIMDIAMETER, HATCH];
