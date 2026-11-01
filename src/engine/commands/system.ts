/** Editing, view, layer, settings, inquiry and file commands. */
import type { Entity, Layer, Pt } from '../types';
import { angleOf, deg, dist } from '../geom/vec';
import { polylinePoints } from '../geom/extents';
import { polygonArea } from '../geom/prims';
import { UNIT_NAMES } from '../model/settings';
import { OSNAP_KINDS, type SnapKind } from '../snap/osnap';
import { kw, type CommandDef, type CommandEngine, type Keyword } from './engine';

const ON_OFF = [kw('ON', 'ON', 'تشغيل'), kw('OFF', 'OFF', 'إيقاف')];

export const UNDO: CommandDef = {
  name: 'UNDO', noUndo: true, title: ['Undo', 'تراجع'], group: 'edit',
  async run(c) {
    const s = await c.getString(['Enter the number of operations to undo', 'أدخل عدد العمليات المراد التراجع عنها'], { defaultText: '1' });
    const n = Math.max(1, Math.floor(Number(s) || 1));
    for (let i = 0; i < n; i++) { const l = c.doc.undo(); if (!l) { c.print(['Everything has been undone.', 'لا يوجد ما يمكن التراجع عنه.']); break; } c.print([`Undo ${l}`, `تراجع: ${l}`]); }
  },
};
export const U: CommandDef = {
  name: 'U', noUndo: true, title: ['Undo last', 'تراجع خطوة'], group: 'edit',
  async run(c) { const l = c.doc.undo(); c.print(l ? [`Undo ${l}`, `تراجع: ${l}`] : ['Everything has been undone.', 'لا يوجد ما يمكن التراجع عنه.']); },
};
export const REDO: CommandDef = {
  name: 'REDO', names: ['MREDO'], noUndo: true, title: ['Redo', 'إعادة'], group: 'edit',
  async run(c) { const l = c.doc.redo(); c.print(l ? [`Redo ${l}`, `إعادة: ${l}`] : ['Nothing to redo.', 'لا يوجد ما يمكن إعادته.']); },
};

/** Typed factor such as "2x" or "0.5" for ZOOM. */
export const ZOOM_FACTOR_RE = /^\s*(\d*\.?\d+)\s*[xX]?\s*$/;
export const ZOOM: CommandDef = {
  name: 'ZOOM', names: ['Z'], noUndo: true, title: ['Zoom', 'تكبير/تصغير'], group: 'view',
  async run(c) {
    const r = await c.getPoint(['Specify corner of window, enter a scale factor (nX) or', 'حدد ركن النافذة أو معامل تكبير (nX) أو'], {
      keywords: [kw('A', 'All', 'الكل'), kw('E', 'Extents', 'الامتدادات'), kw('W', 'Window', 'نافذة'), kw('P', 'Previous', 'السابق')], noSnap: true, allowNone: true, rawText: ZOOM_FACTOR_RE,
    });
    if (r === 'A' || r === 'E' || r === null) { c.host.zoom?.('extents'); return; }
    if (r === 'P') { c.host.zoom?.('previous'); return; }
    if (typeof r === 'string' && ZOOM_FACTOR_RE.test(r)) { c.host.zoom?.('scale', undefined, Number(ZOOM_FACTOR_RE.exec(r)![1])); return; }
    let a: Pt | null = Array.isArray(r) ? r : null;
    if (r === 'W') a = await c.requirePoint(['Specify first corner', 'حدد الركن الأول'], { noSnap: true });
    if (typeof r === 'string' && r !== 'W') return;
    if (!a) return;
    const b = await c.requirePoint(['Specify opposite corner', 'حدد الركن المقابل'], { base: a, rubber: 'rect', noSnap: true });
    c.host.zoom?.('window', a, b);
  },
};

export const PAN: CommandDef = {
  name: 'PAN', names: ['P', '-PAN'], noUndo: true, title: ['Pan', 'تحريك العرض'], group: 'view',
  async run(c) {
    c.print(['Tip: drag with the middle mouse button (or Space+drag) to pan at any time.', 'تلميح: اسحب بزر الفأرة الأوسط (أو مسافة+سحب) للتحريك في أي وقت.']);
    const a = await c.getPoint(['Specify base point or displacement', 'حدد نقطة الأساس'], { noSnap: true, allowNone: true });
    if (!Array.isArray(a)) return;
    const b = await c.getPoint(['Specify second point', 'حدد النقطة الثانية'], { base: a, noSnap: true, allowNone: true });
    if (!Array.isArray(b)) return;
    c.host.pan?.(b[0] - a[0], b[1] - a[1]);
  },
};
export const REGEN: CommandDef = {
  name: 'REGEN', names: ['RE', 'REGENALL', 'REDRAW', 'R'], noUndo: true, title: ['Regenerate', 'إعادة التوليد'], group: 'view',
  async run(c) { c.doc.invalidate(true); c.host.regen?.(); c.print(['Regenerating model.', 'تمت إعادة توليد الرسم.']); },
};

// ---------- layers ----------
const LAYER_KW: Keyword[] = [kw('?', '?', '؟'), kw('M', 'Make', 'إنشاء وتعيين'), kw('S', 'Set', 'تعيين'), kw('N', 'New', 'جديد'), kw('ON', 'ON', 'تشغيل'), kw('OFF', 'OFF', 'إطفاء'),
  kw('C', 'Color', 'لون'), kw('L', 'Ltype', 'نوع الخط'), kw('LO', 'LOck', 'قفل'), kw('U', 'Unlock', 'فتح القفل'), kw('F', 'Freeze', 'تجميد'), kw('T', 'Thaw', 'إذابة')];

/** Layers matching a name list with wildcards ("WALL*,DOTE"). */
export function matchLayers(c: CommandEngine, spec: string): Layer[] {
  const pats = spec.split(',').map((s) => s.trim()).filter(Boolean).map((s) => new RegExp('^' + s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i'));
  return [...c.doc.layers.values()].filter((l) => pats.some((r) => r.test(l.name)));
}
export const setCurrentLayer = (c: CommandEngine, name: string) => { const l = c.doc.ensureLayer(name); if (l.frozen) c.doc.updateLayer(l.name, { frozen: false }); c.doc.setSettings({ currentLayer: l.name }); };

export const LAYER_CLI: CommandDef = {
  name: '-LAYER', names: ['-LA'], title: ['Layer (command line)', 'الطبقات (سطر الأوامر)'], group: 'layer',
  async run(c) {
    for (;;) {
      c.print([`Current layer: "${c.doc.settings.currentLayer}"`, `الطبقة الحالية: "${c.doc.settings.currentLayer}"`]);
      const k = await c.getKeyword(['Enter an option', 'اختر'], LAYER_KW, { allowNone: true });
      if (!k) return;
      if (k === '?') { for (const l of c.doc.layers.values()) c.print(`${l.name}  ${l.off ? 'Off' : 'On'}  ${l.frozen ? 'F' : '-'}  ${l.locked ? 'L' : '-'}  ${l.color}  ${l.linetype}`); continue; }
      const names = await c.getString(k === 'M' || k === 'N' || k === 'S' ? ['Enter name(s) for layer', 'أدخل اسم الطبقة'] : ['Enter name list of layer(s)', 'أدخل قائمة أسماء الطبقات (يدعم *)'], { defaultText: k === 'S' ? c.doc.settings.currentLayer : undefined });
      if (!names) continue;
      switch (k) {
        case 'M': setCurrentLayer(c, names.split(',')[0].trim()); break;
        case 'N': for (const n of names.split(',')) if (n.trim()) c.doc.ensureLayer(n.trim()); break;
        case 'S': { const l = c.doc.getLayer(names); if (l) setCurrentLayer(c, l.name); else c.error([`Cannot find layer "${names}".`, `الطبقة "${names}" غير موجودة.`]); break; }
        case 'C': {
          const col = await c.getString(['Enter color index (1-255)', 'أدخل رقم اللون (1-255)']);
          const v = parseColor(col ?? '');
          if (v === null || v === 0 || v === 256) { c.error(['Invalid color.', 'لون غير صالح.']); break; }
          for (const l of matchLayers(c, names)) c.doc.updateLayer(l.name, { color: v });
          break;
        }
        case 'L': { const lt = await c.getString(['Enter linetype name', 'أدخل اسم نوع الخط'], { defaultText: 'Continuous' }); if (lt) for (const l of matchLayers(c, names)) c.doc.updateLayer(l.name, { linetype: lt }); break; }
        default: {
          const patch: Partial<Layer> = k === 'ON' ? { off: false } : k === 'OFF' ? { off: true } : k === 'LO' ? { locked: true } : k === 'U' ? { locked: false } : k === 'F' ? { frozen: true } : { frozen: false };
          for (const l of matchLayers(c, names)) {
            if (k === 'F' && l.name.toUpperCase() === c.doc.settings.currentLayer.toUpperCase()) { c.error(['Cannot freeze the current layer.', 'لا يمكن تجميد الطبقة الحالية.']); continue; }
            c.doc.updateLayer(l.name, patch);
          }
        }
      }
    }
  },
};
export const LAYER: CommandDef = {
  name: 'LAYER', names: ['LA', 'DDLMODES'], title: ['Layer manager', 'مدير الطبقات'], group: 'layer',
  async run(c, r) { const d = c.host.dialog?.('layers'); if (d) { await d; return; } await LAYER_CLI.run(c, r); },
};

const COLOR_NAMES: Record<string, number> = { RED: 1, YELLOW: 2, GREEN: 3, CYAN: 4, BLUE: 5, MAGENTA: 6, WHITE: 7, BYLAYER: 256, BYBLOCK: 0,
  'أحمر': 1, 'أصفر': 2, 'أخضر': 3, 'سماوي': 4, 'أزرق': 5, 'أرجواني': 6, 'أبيض': 7 };
export function parseColor(s: string): number | null {
  const t = s.trim(); if (!t) return null;
  const n = COLOR_NAMES[t.toUpperCase()] ?? COLOR_NAMES[t];
  if (n !== undefined) return n;
  const v = Number(t);
  return Number.isInteger(v) && v >= 0 && v <= 256 ? v : null;
}
export const colorName = (v: number | undefined) => v === undefined || v === 256 ? 'ByLayer' : v === 0 ? 'ByBlock' : String(v);

export const COLOR: CommandDef = {
  name: 'COLOR', names: ['COL', 'COLOUR', 'DDCOLOR'], title: ['Current color', 'اللون الحالي'], group: 'settings',
  async run(c) {
    const d = c.host.dialog?.('color', c.doc.settings.currentColor);
    let v: number | null;
    if (d) { const r = await d; if (r === null || r === undefined) return; v = r as number; }
    else { const s = await c.getString(['Enter default object color [ByLayer/ByBlock/1-255]', 'أدخل لون الكائنات [ByLayer/ByBlock/1-255]'], { defaultText: colorName(c.doc.settings.currentColor) }); v = parseColor(s ?? ''); }
    if (v === null) { c.error(['Invalid color.', 'لون غير صالح.']); return; }
    c.doc.setSettings({ currentColor: v });
  },
};
export const LINETYPE: CommandDef = {
  name: 'LINETYPE', names: ['LT', 'LTYPE', '-LINETYPE'], title: ['Current linetype', 'نوع الخط الحالي'], group: 'settings',
  async run(c) {
    const d = c.host.dialog?.('linetype');
    if (d) { await d; return; }
    const s = await c.getString(['Enter linetype name [ByLayer/ByBlock/Continuous/...]', 'أدخل اسم نوع الخط'], { defaultText: c.doc.settings.currentLinetype });
    if (s) c.doc.setSettings({ currentLinetype: s });
  },
};
export const LTSCALE: CommandDef = {
  name: 'LTSCALE', names: ['LTS'], title: ['Linetype scale', 'مقياس نوع الخط'], group: 'settings',
  async run(c) {
    const v = await c.getDistance(['Enter new linetype scale factor', 'أدخل معامل مقياس نوع الخط'], { defaultText: String(c.doc.settings.ltscale) });
    if (typeof v === 'number' && v > 0) { c.doc.setSettings({ ltscale: v }); c.print(['Regenerating model.', 'تمت إعادة التوليد.']); }
  },
};
export const UNIT_KW = [kw('MM', 'Millimeters', 'مليمتر'), kw('CM', 'Centimeters', 'سنتيمتر'), kw('M', 'Meters', 'متر'), kw('IN', 'Inches', 'إنش'), kw('FT', 'Feet', 'قدم')];
export const UNIT_CODES: Record<string, number> = { MM: 4, CM: 5, M: 6, IN: 1, FT: 2 };
export const UNITS: CommandDef = {
  name: 'UNITS', names: ['UN', 'DDUNITS', '-UNITS', 'INSUNITS'], title: ['Drawing units', 'وحدات الرسم'], group: 'settings',
  async run(c) {
    const cur = Object.entries(UNIT_CODES).find(([, v]) => v === c.doc.units)?.[0] ?? 'MM';
    const k = await c.getKeyword(['Specify drawing units', 'حدد وحدات الرسم'], UNIT_KW, { defaultText: cur });
    if (k && UNIT_CODES[k] !== c.doc.units) {
      c.doc.setUnits(UNIT_CODES[k]);
      c.print([`Drawing units: ${UNIT_NAMES[UNIT_CODES[k]]}. Existing geometry is not rescaled; library blocks are converted on insertion.`, `وحدات الرسم: ${UNIT_NAMES[UNIT_CODES[k]]}. لا يُعاد تحجيم الرسم الحالي؛ تُحوَّل بلوكات المكتبة عند الإدراج.`]);
    }
    const p = await c.getString(['Enter display precision (0-8)', 'أدخل دقة العرض (0-8)'], { defaultText: String(c.doc.settings.precision) });
    const v = Math.round(Number(p));
    if (Number.isFinite(v) && v >= 0 && v <= 8 && v !== c.doc.settings.precision) c.doc.setSettings({ precision: v });
  },
};

export const OSNAP: CommandDef = {
  name: 'OSNAP', names: ['OS', '-OSNAP', 'DDOSNAP'], noUndo: true, title: ['Object snap', 'الالتقاط'], group: 'settings',
  async run(c, r) {
    const d = r.name.startsWith('-') ? undefined : c.host.dialog?.('osnap');
    if (d) { await d; return; }
    const cur = [...c.snap.modes].map((m) => m.toUpperCase()).join(',') || 'NONE';
    const s = await c.getString(['Enter list of object snap modes (END,MID,CEN,INT,PER,QUA,NEA,NODE,INS / NONE)', 'أدخل أوضاع الالتقاط (END,MID,CEN,INT,PER,QUA,NEA,NODE,INS / NONE)'], { defaultText: cur });
    if (!s) return;
    const modes = new Set<SnapKind>();
    for (const t of s.split(/[,\s]+/)) { const k = t.trim().toLowerCase().slice(0, 4) as SnapKind; const m = OSNAP_KINDS.find((x) => k.startsWith(x)); if (m) modes.add(m); }
    c.snap.modes = modes; c.snap.osnapOn = modes.size > 0;
  },
};
const toggleCmd = (name: string, names: string[], title: [string, string], get: (c: CommandEngine) => boolean, set: (c: CommandEngine, v: boolean) => void): CommandDef => ({
  name, names, noUndo: true, title, group: 'settings',
  async run(c) {
    const k = await c.getKeyword([`Enter mode`, 'اختر الوضع'], ON_OFF, { defaultText: get(c) ? 'OFF' : 'ON' });
    if (k) set(c, k === 'ON');
  },
});
export const ORTHO = toggleCmd('ORTHO', [], ['Ortho mode', 'الوضع المتعامد'], (c) => c.snap.orthoOn, (c, v) => { c.snap.orthoOn = v; if (v) c.snap.polarOn = false; });
export const SNAP: CommandDef = {
  name: 'SNAP', names: ['SN'], noUndo: true, title: ['Snap spacing', 'التقاط الشبكة'], group: 'settings',
  async run(c) {
    const r = await c.getDistance(['Specify snap spacing or', 'حدد تباعد الالتقاط أو'], { keywords: ON_OFF, defaultText: String(c.snap.snapSpacing) });
    if (r === 'ON' || r === 'OFF') c.snap.gridSnapOn = r === 'ON';
    else if (typeof r === 'number' && r > 0) { c.snap.snapSpacing = r; c.snap.gridSnapOn = true; }
  },
};
export const GRID: CommandDef = {
  name: 'GRID', names: [], noUndo: true, title: ['Grid', 'الشبكة'], group: 'settings',
  async run(c) {
    const r = await c.getDistance(['Specify grid spacing or', 'حدد تباعد الشبكة أو'], { keywords: ON_OFF, defaultText: String(c.grid.spacing) });
    if (r === 'ON' || r === 'OFF') c.grid.on = r === 'ON';
    else if (typeof r === 'number' && r > 0) { c.grid.spacing = r; c.grid.on = true; }
  },
};

// ---------- inquiry ----------
export const DIST: CommandDef = {
  name: 'DIST', names: ['DI'], noUndo: true, title: ['Distance', 'مسافة'], group: 'inquiry',
  async run(c) {
    const a = await c.requirePoint(['Specify first point', 'حدد النقطة الأولى']);
    const b = await c.requirePoint(['Specify second point', 'حدد النقطة الثانية'], { base: a });
    c.print([`Distance = ${c.fmt(dist(a, b))},  Angle = ${c.fmt(((deg(angleOf(a, b)) % 360) + 360) % 360)}°,  Delta X = ${c.fmt(b[0] - a[0])},  Delta Y = ${c.fmt(b[1] - a[1])}`,
      `المسافة = ${c.fmt(dist(a, b))}،  الزاوية = ${c.fmt(((deg(angleOf(a, b)) % 360) + 360) % 360)}°،  ΔX = ${c.fmt(b[0] - a[0])}،  ΔY = ${c.fmt(b[1] - a[1])}`]);
  },
};
export const ID: CommandDef = {
  name: 'ID', noUndo: true, title: ['Point coordinates', 'إحداثيات نقطة'], group: 'inquiry',
  async run(c) { const p = await c.requirePoint(['Specify point', 'حدد نقطة']); c.print(`X = ${c.fmt(p[0])}     Y = ${c.fmt(p[1])}`); },
};

export function describeEntity(c: CommandEngine, e: Entity): string[] {
  const out = [`${e.type}  ${c.t(['Layer', 'الطبقة'])}: "${e.layer}"  ${c.t(['Color', 'اللون'])}: ${colorName(e.color)}  ${c.t(['Linetype', 'نوع الخط'])}: ${e.linetype ?? 'ByLayer'}`];
  const f = (v: number) => c.fmt(v);
  switch (e.type) {
    case 'LINE': out.push(`from ${c.fmtPt(e.a)} to ${c.fmtPt(e.b)}  ${c.t(['Length', 'الطول'])} = ${f(dist(e.a, e.b))}  ${c.t(['Angle', 'الزاوية'])} = ${f(((deg(angleOf(e.a, e.b)) % 360) + 360) % 360)}°`); break;
    case 'CIRCLE': out.push(`${c.t(['Center', 'المركز'])} ${c.fmtPt(e.c)}  R = ${f(e.r)}  ${c.t(['Circumference', 'المحيط'])} = ${f(2 * Math.PI * e.r)}  ${c.t(['Area', 'المساحة'])} = ${f(Math.PI * e.r * e.r)}`); break;
    case 'ARC': out.push(`${c.t(['Center', 'المركز'])} ${c.fmtPt(e.c)}  R = ${f(e.r)}  ${f(deg(e.a0))}° → ${f(deg(e.a1))}°`); break;
    case 'LWPOLYLINE': {
      const pts = polylinePoints(e.pts, e.closed);
      let L = 0; for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
      out.push(`${e.closed ? c.t(['Closed', 'مغلق']) : c.t(['Open', 'مفتوح'])}  ${e.pts.length} ${c.t(['vertices', 'رؤوس'])}  ${c.t(['Length', 'الطول'])} = ${f(L)}${e.closed ? `  ${c.t(['Area', 'المساحة'])} = ${f(Math.abs(polygonArea(pts)))}` : ''}`);
      break;
    }
    case 'TEXT': case 'MTEXT': out.push(`"${e.text}"  h = ${f(e.h)}  ${c.t(['Style', 'النمط'])}: ${e.style}  @ ${c.fmtPt(e.p)}`); break;
    case 'INSERT': out.push(`${c.t(['Block', 'البلوك'])}: ${e.name}  @ ${c.fmtPt(e.p)}  X=${f(e.sx)} Y=${f(e.sy)}  ${f(deg(e.rot))}°`); break;
    case 'DIMENSION': out.push(`${e.kind ?? e.dimType ?? ''}  ${e.text ?? ''}`); break;
    case 'HATCH': out.push(`${c.t(['Pattern', 'النقش'])}: ${e.pattern}  ${e.loops.length} ${c.t(['loops', 'حلقات'])}`); break;
    case 'POINT': out.push(c.fmtPt(e.p)); break;
    default: break;
  }
  return out;
}
export const LIST: CommandDef = {
  name: 'LIST', names: ['LI', 'LS'], noUndo: true, title: ['List', 'معلومات الكائنات'], group: 'inquiry',
  async run(c) {
    const ids = await c.getSelection();
    for (const id of ids.slice(0, 50)) { const e = c.doc.get(id); if (e) for (const l of describeEntity(c, e)) c.print(l); }
    if (ids.length > 50) c.print(`… ${ids.length - 50}`);
  },
};
export const PROPERTIES: CommandDef = {
  name: 'PROPERTIES', names: ['PR', 'CH', 'PROPS', 'DDMODIFY'], noUndo: true, title: ['Properties', 'الخصائص'], group: 'edit',
  async run(c, r) { const d = c.host.dialog?.('properties'); if (d) { await d; return; } await LIST.run(c, r); },
};
export const DDEDIT: CommandDef = {
  name: 'DDEDIT', names: ['ED', 'TEXTEDIT'], title: ['Edit text', 'تحرير النص'], group: 'edit',
  async run(c) {
    for (;;) {
      const pick = await c.getEntity(['Select an annotation object', 'اختر نصاً أو بعداً'], { filter: (e) => e.type === 'TEXT' || e.type === 'MTEXT' || e.type === 'DIMENSION' || e.type === 'ATTDEF', allowNone: true });
      if (!pick || typeof pick === 'string') return;
      const e = c.doc.get(pick.id)!;
      const cur = e.type === 'DIMENSION' ? e.text ?? '<>' : (e as { text: string }).text;
      let v: string | null | undefined;
      const d = e.type === 'MTEXT' ? c.host.dialog?.('mtext', { text: cur.replace(/\\P/g, '\n'), height: e.h }) : undefined;
      if (d) { const r = (await d) as { text: string } | null; v = r ? r.text.replace(/\r?\n/g, '\\P') : null; }
      else v = await c.getString(['Enter new text', 'أدخل النص الجديد'], { allowSpaces: true, defaultText: cur });
      if (v === null || v === undefined) continue;
      c.doc.update(e.id, { text: v } as Partial<Entity>);
    }
  },
};

// ---------- file ----------
const fileCmd = (name: string, names: string[], op: 'new' | 'open' | 'save' | 'saveas' | 'export', title: [string, string]): CommandDef => ({
  name, names, noUndo: true, title, group: 'file',
  async run(c, r) {
    if (!c.host.file) { c.error(['File operations are not available here.', 'عمليات الملفات غير متاحة هنا.']); return; }
    let arg: string | undefined;
    if (op === 'export') arg = (await c.getKeyword(['Export format', 'صيغة التصدير'], [kw('DXF', 'DXF', 'DXF'), kw('SVG', 'SVG', 'SVG'), kw('PNG', 'PNG', 'PNG'), kw('JSON', 'JSON', 'JSON')], { defaultText: 'DXF' })) ?? undefined;
    void r;
    await c.host.file(op, arg);
  },
});
export const FILE_COMMANDS = [
  fileCmd('NEW', ['QNEW'], 'new', ['New drawing', 'رسم جديد']), fileCmd('OPEN', [], 'open', ['Open', 'فتح']), fileCmd('SAVE', ['QSAVE'], 'save', ['Save', 'حفظ']),
  fileCmd('SAVEAS', [], 'saveas', ['Save as', 'حفظ باسم']), fileCmd('EXPORT', ['DXFOUT', 'EXP'], 'export', ['Export', 'تصدير']),
];

export const HELP: CommandDef = {
  name: 'HELP', names: ['?', 'COMMANDS'], noUndo: true, title: ['Command list', 'قائمة الأوامر'], group: 'view',
  async run(c) {
    const d = c.host.dialog?.('commands');
    if (d) { await d; return; }
    const seen = new Set<string>();
    for (const def of c.registry.values()) { if (seen.has(def.name)) continue; seen.add(def.name); c.print(`${def.name} — ${c.t(def.title)}`); }
  },
};

export const SYSTEM_COMMANDS = [UNDO, U, REDO, ZOOM, PAN, REGEN, LAYER, LAYER_CLI, COLOR, LINETYPE, LTSCALE, UNITS, OSNAP, ORTHO, SNAP, GRID, DIST, ID, LIST, PROPERTIES, DDEDIT, ...FILE_COMMANDS, HELP];
