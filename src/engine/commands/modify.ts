/**
 * Modify commands (Phase 3A): ERASE, OOPS, MOVE, COPY, ROTATE, SCALE, MIRROR, EXPLODE, SELECT, MIRRTEXT, the grip
 * editor GRIPEDIT (STRETCH / MOVE / ROTATE / SCALE / MIRROR on hot grips), plus BLOCK and INSERT.
 * Every command runs inside one undo group (see CommandEngine.run).
 */
import type { BlockDef, Entity, InsertEnt, MTextEnt, NewEntity, Pt, TextEnt } from '../types';
import { IDENTITY, insertMatrix, mmul, type Mat } from '../geom/matrix';
import { mirrorM, moveM, rotateAbout, scaleAbout, transformEntity } from '../geom/transform';
import { affineEntity, inheritFrom, type AffineContext } from '../geom/affine';
import { bulgeToPrim } from '../geom/prims';
import { angleOf, dist, sub } from '../geom/vec';
import { dimensionGeometry } from '../model/dimension';
import type { CadDocument } from '../model/document';
import { hatchSegments } from '../render/hatch';
import { layoutMText, resolveFonts } from '../render/text';
import { stretchGrips } from '../edit/grips';
import { kw, type CommandDef, type CommandEngine, type Keyword } from './engine';

const strip = (e: Entity | NewEntity): NewEntity => { const { id: _id, ...rest } = e as Entity; return rest as NewEntity; };

/** Lookups used by the transformation code (styles, nested blocks, layers, hatch patterns). */
export function affineContext(doc: CadDocument): AffineContext {
  return {
    getBlock: (n) => doc.getBlock(n), getStyle: (n) => doc.getStyle(n), getLayer: (n) => doc.getLayer(n),
    patternLines: (name, scale, angle, origin) => doc.patternLines?.(name, scale, angle, origin),
    mtextLines: (t) => explodeMText(doc, t as MTextEnt),
  };
}
/** Transform an entity with the drawing's MIRRTEXT setting and lookups. */
export const xform = <E extends Entity>(doc: CadDocument, e: E, m: Mat): E => transformEntity(e, m, { mirrText: !!doc.settings.mirrText, ctx: affineContext(doc) });

const PREVIEW_LIMIT = 400;
const previewOf = (c: CommandEngine, ids: number[], m: Mat, limit = PREVIEW_LIMIT): NewEntity[] => {
  const out: NewEntity[] = [];
  for (const id of ids.slice(0, limit)) { const e = c.doc.get(id); if (e) out.push(strip(transformEntity(e, m, { mirrText: !!c.doc.settings.mirrText }))); }
  return out;
};
const report = (c: CommandEngine, n: number) => c.print([`${n} object(s)`, `${n} كائن`]);
const apply = (c: CommandEngine, ids: number[], m: Mat, copy: boolean) => {
  for (const id of ids) {
    const e = c.doc.get(id); if (!e) continue;
    if (copy) c.doc.add(strip(xform(c.doc, e, m))); else c.doc.update(id, (x) => xform(c.doc, x, m));
  }
};

export const ERASE: CommandDef = {
  name: 'ERASE', names: ['DELETE'], title: ['Erase', 'مسح'], group: 'modify',
  async run(c) {
    const ids = await c.getSelection();
    const gone: Entity[] = [];
    for (const id of ids) { const e = c.doc.get(id); if (e) { gone.push(structuredClone(e)); c.doc.remove(id); } }
    if (gone.length) { c.memory.lastErased = gone; report(c, gone.length); }
  },
};

export const OOPS: CommandDef = {
  name: 'OOPS', title: ['Restore erased objects', 'استعادة المحذوفات'], group: 'modify',
  async run(c) {
    const gone = c.memory.lastErased as Entity[] | undefined;
    if (!gone?.length) { c.print(['Nothing to restore.', 'لا يوجد ما يُستعاد.']); return; }
    const ids = gone.map((e) => c.doc.add(strip(e)).id);
    c.previousSelection = ids;
    c.memory.lastErased = undefined;
    report(c, ids.length);
  },
};

async function displacement(c: CommandEngine, ids: number[], verb: [string, string]): Promise<[Pt, Pt] | null> {
  const r = await c.getPoint(['Specify base point', 'حدد نقطة الأساس'], { keywords: [kw('D', 'Displacement', 'إزاحة')] });
  if (r === 'D') {
    const d = await c.getPoint(['Specify displacement', 'حدد الإزاحة (dx,dy)'], { defaultText: '0,0' });
    if (!Array.isArray(d)) return null;
    return [[0, 0], d];
  }
  if (!Array.isArray(r)) return null;
  const b = r;
  const r2 = await c.getPoint([`Specify second point (${verb[0]}) or <use first point as displacement>`, `حدد النقطة الثانية (${verb[1]}) أو <استخدم النقطة الأولى كإزاحة>`], { base: b, allowNone: true, preview: (p) => previewOf(c, ids, moveM(sub(p, b))) });
  if (r2 === null) return [[0, 0], b];
  if (!Array.isArray(r2)) return null;
  return [b, r2];
}

export const MOVE: CommandDef = {
  name: 'MOVE', title: ['Move', 'نقل'], group: 'modify',
  async run(c) {
    const ids = await c.getSelection();
    if (!ids.length) return;
    const d = await displacement(c, ids, ['move', 'النقل']);
    if (!d) return;
    apply(c, ids, moveM(sub(d[1], d[0])), false);
  },
};

export const COPY: CommandDef = {
  name: 'COPY', names: ['CO', 'CP'], title: ['Copy', 'نسخ'], group: 'modify',
  async run(c) {
    const ids = await c.getSelection();
    if (!ids.length) return;
    const r = await c.getPoint(['Specify base point', 'حدد نقطة الأساس'], { keywords: [kw('D', 'Displacement', 'إزاحة')] });
    if (r === 'D') {
      const d = await c.getPoint(['Specify displacement', 'حدد الإزاحة (dx,dy)']);
      if (Array.isArray(d)) apply(c, ids, moveM(d), true);
      return;
    }
    if (!Array.isArray(r)) return;
    const b = r;
    const marks: number[] = [];
    for (;;) {
      const p = await c.getPoint(['Specify second point or [Exit/Undo]', 'حدد النقطة الثانية أو [خروج/تراجع]'], { base: b, allowNone: true, keywords: [kw('E', 'Exit', 'خروج'), ...(marks.length ? [kw('U', 'Undo', 'تراجع')] : [])], preview: (q) => previewOf(c, ids, moveM(sub(q, b))) });
      if (p === 'U') { if (marks.length) c.rollbackTo(marks.pop()!); continue; }
      if (!Array.isArray(p)) return;
      marks.push(c.mark());
      apply(c, ids, moveM(sub(p, b)), true);
    }
  },
};

/** Angle given as a value, by picking relative to `b`, or [Points] as two points. */
async function angleWithPoints(c: CommandEngine, msg: [string, string], b: Pt | null, o: { defaultText?: string; preview?: (p: Pt) => NewEntity[]; keywords?: Keyword[] } = {}): Promise<number | string | null> {
  const r = await c.getAngle(msg, { base: b, defaultText: o.defaultText, preview: o.preview, keywords: [...(o.keywords ?? []), kw('P', 'Points', 'نقاط')] });
  if (r !== 'P') return r;
  const p1 = await c.requirePoint(['Specify first point', 'حدد النقطة الأولى']);
  const p2 = await c.requirePoint(['Specify second point', 'حدد النقطة الثانية'], { base: p1 });
  return angleOf(p1, p2);
}

export const ROTATE: CommandDef = {
  name: 'ROTATE', names: ['RO'], title: ['Rotate', 'تدوير'], group: 'modify',
  async run(c) {
    const ids = await c.getSelection();
    if (!ids.length) return;
    const b = await c.requirePoint(['Specify base point', 'حدد نقطة الأساس']);
    let copy = false;
    const def = (c.memory.rotate as number) ?? 0;
    for (;;) {
      const a = await c.getAngle(['Specify rotation angle or [Copy/Reference]', 'حدد زاوية الدوران أو [نسخ/مرجع]'], { base: b, keywords: [kw('C', 'Copy', 'نسخ'), kw('R', 'Reference', 'مرجع')], defaultText: c.fmt((def * 180) / Math.PI), preview: (p) => previewOf(c, ids, rotateAbout(b, angleOf(b, p))) });
      if (a === 'C') { copy = !copy; c.print(copy ? ['Rotating a copy of the selected objects.', 'تدوير نسخة من الكائنات المختارة.'] : ['Rotating the selected objects.', 'تدوير الكائنات المختارة.']); continue; }
      let ang: number;
      if (a === 'R') {
        const ref = await angleWithPoints(c, ['Specify the reference angle', 'حدد الزاوية المرجعية'], null, { defaultText: c.fmt(((c.memory.rotateRef as number) ?? 0) * 180 / Math.PI) });
        if (typeof ref !== 'number') return;
        c.memory.rotateRef = ref;
        const nw = await angleWithPoints(c, ['Specify the new angle', 'حدد الزاوية الجديدة'], b, { defaultText: '0', preview: (p) => previewOf(c, ids, rotateAbout(b, angleOf(b, p) - ref)) });
        if (typeof nw !== 'number') return;
        ang = nw - ref;
      } else if (typeof a === 'number') ang = a;
      else return;
      c.memory.rotate = ang;
      apply(c, ids, rotateAbout(b, ang), copy);
      return;
    }
  },
};

export const SCALE: CommandDef = {
  name: 'SCALE', names: ['SC'], title: ['Scale', 'تحجيم'], group: 'modify',
  async run(c) {
    const ids = await c.getSelection();
    if (!ids.length) return;
    const b = await c.requirePoint(['Specify base point', 'حدد نقطة الأساس']);
    let copy = false;
    for (;;) {
      const f0 = await c.getDistance(['Specify scale factor or [Copy/Reference]', 'حدد معامل التحجيم أو [نسخ/مرجع]'], { base: b, keywords: [kw('C', 'Copy', 'نسخ'), kw('R', 'Reference', 'مرجع')], defaultText: String((c.memory.scale as number) ?? 1), preview: (p) => { const f = dist(b, p); return f > 1e-12 ? previewOf(c, ids, scaleAbout(b, f)) : []; } });
      if (f0 === 'C') { copy = !copy; c.print(copy ? ['Scaling a copy of the selected objects.', 'تحجيم نسخة من الكائنات المختارة.'] : ['Scaling the selected objects.', 'تحجيم الكائنات المختارة.']); continue; }
      let f: number | null = typeof f0 === 'number' ? f0 : null;
      if (f0 === 'R') {
        const ref = await c.getDistance(['Specify reference length', 'حدد الطول المرجعي'], { defaultText: String((c.memory.scaleRef as number) ?? 1) });
        if (typeof ref !== 'number' || ref <= 0) { c.error(['Reference length must be positive.', 'يجب أن يكون الطول المرجعي موجباً.']); return; }
        c.memory.scaleRef = ref;
        let nl = await c.getDistance(['Specify new length or [Points]', 'حدد الطول الجديد أو [نقاط]'], { base: b, keywords: [kw('P', 'Points', 'نقاط')], preview: (p) => { const k = dist(b, p) / ref; return k > 1e-12 ? previewOf(c, ids, scaleAbout(b, k)) : []; } });
        if (nl === 'P') {
          const p1 = await c.requirePoint(['Specify first point', 'حدد النقطة الأولى']);
          const p2 = await c.requirePoint(['Specify second point', 'حدد النقطة الثانية'], { base: p1 });
          nl = dist(p1, p2);
        }
        f = typeof nl === 'number' ? nl / ref : null;
      }
      if (f === null) return;
      if (!(f > 0)) { c.error(['Scale factor must be positive.', 'يجب أن يكون معامل التحجيم موجباً.']); continue; }
      c.memory.scale = f;
      apply(c, ids, scaleAbout(b, f), copy);
      return;
    }
  },
};

export const MIRROR: CommandDef = {
  name: 'MIRROR', names: ['MI'], title: ['Mirror', 'انعكاس'], group: 'modify',
  async run(c) {
    const ids = await c.getSelection();
    if (!ids.length) return;
    const a = await c.requirePoint(['Specify first point of mirror line', 'حدد النقطة الأولى لخط الانعكاس']);
    let b: Pt;
    for (;;) {
      b = await c.requirePoint(['Specify second point of mirror line', 'حدد النقطة الثانية لخط الانعكاس'], { base: a, preview: (p) => (dist(a, p) > 0 ? previewOf(c, ids, mirrorM(a, p)) : []) });
      if (dist(a, b) > 1e-12) break;
      c.error(['The mirror line points must differ.', 'يجب أن تختلف نقطتا خط الانعكاس.']);
    }
    const del = await c.getKeyword(['Erase source objects? [Yes/No]', 'حذف الكائنات الأصلية؟ [نعم/لا]'], [kw('Y', 'Yes', 'نعم'), kw('N', 'No', 'لا')], { defaultText: 'N' });
    if (del === null) return;
    apply(c, ids, mirrorM(a, b), del !== 'Y');
  },
};

export const MIRRTEXT: CommandDef = {
  name: 'MIRRTEXT', title: ['Text mirroring', 'انعكاس النصوص'], group: 'settings',
  async run(c) {
    const cur = c.doc.settings.mirrText ? '1' : '0';
    for (;;) {
      const v = await c.getString(['Enter new value for MIRRTEXT (0 = keep text readable, 1 = mirror text)', 'أدخل قيمة MIRRTEXT (0 = إبقاء النص مقروءاً، 1 = عكس النص)'], { defaultText: cur });
      if (v === null) return;
      if (v === '0' || v === '1') { c.doc.setSettings({ mirrText: v === '1' }); return; }
      c.error(['Enter 0 or 1.', 'أدخل 0 أو 1.']);
    }
  },
};

export const SELECT: CommandDef = {
  name: 'SELECT', title: ['Select objects', 'اختيار الكائنات'], group: 'edit', noUndo: true,
  async run(c) {
    const ids = await c.getSelection(['Select objects', 'اختر الكائنات'], { usePickfirst: false });
    c.selection = new Set(ids);
    if (ids.length) c.print([`${ids.length} object(s) selected.`, `تم اختيار ${ids.length} كائن.`]);
  },
};

// ------------------------------------------------------------------------------------------------ EXPLODE
const props = (e: Entity) => {
  const o: Record<string, unknown> = { layer: e.layer };
  for (const k of ['color', 'trueColor', 'linetype', 'ltScale', 'lineweight'] as const) if (e[k] !== undefined) o[k] = e[k];
  return o;
};

/** Why an entity cannot be exploded (or null when it can). */
export function explodeRefusal(doc: CadDocument, e: Entity): [string, string] | null {
  switch (e.type) {
    case 'INSERT': return doc.getBlock(e.name) ? null : ['block definition is missing', 'تعريف البلوك غير موجود'];
    case 'LWPOLYLINE': return e.pts.length >= 2 ? null : ['empty polyline', 'خط متعدد فارغ'];
    case 'DIMENSION': return e.block ? (doc.getBlock(e.block) ? null : ['dimension block is missing', 'بلوك البعد غير موجود']) : e.kind ? null : ['dimension has no geometry', 'البعد بلا هندسة'];
    case 'HATCH': return e.solid || /^solid$/i.test(e.pattern) ? ['solid hatch', 'تهشير مصمت'] : null;
    case 'MTEXT': return null;
    default: return ['not explodable', 'غير قابل للتفجير'];
  }
}

/** Entities making up an entity one level down (EXPLODE); null when the entity cannot be exploded. */
export function explodeEntity(doc: CadDocument, e: Entity): NewEntity[] | null {
  if (explodeRefusal(doc, e)) return null;
  const ctx = affineContext(doc);
  switch (e.type) {
    case 'INSERT': {
      const def = doc.getBlock(e.name)!;
      const out: NewEntity[] = [];
      const cols = Math.max(1, e.cols ?? 1), rows = Math.max(1, e.rows ?? 1);
      for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
        const m = insertMatrix(e.p, e.sx, e.sy, e.rot, def.base, i * (e.colSpacing ?? 0), j * (e.rowSpacing ?? 0));
        for (const ch of def.entities) {
          if (ch.type === 'ATTDEF') continue;
          for (const part of affineEntity(ch, m, ctx)) out.push(inheritFrom(part as unknown as Record<string, unknown>, e, ctx) as unknown as NewEntity);
        }
      }
      for (const a of e.attribs ?? []) {
        if (a.invisible || !a.text) continue;
        const t = { ...structuredClone(a), type: 'TEXT', layer: a.layer ?? e.layer } as Record<string, unknown>;
        delete t.tag; delete t.prompt; delete t.invisible;
        out.push(inheritFrom(t, e, ctx) as unknown as NewEntity);
      }
      return out;
    }
    case 'LWPOLYLINE': {
      const out: NewEntity[] = [];
      const n = e.pts.length;
      const base = props(e);
      for (let i = 0; i < (e.closed ? n : n - 1); i++) {
        const a = e.pts[i], b = e.pts[(i + 1) % n];
        const q = bulgeToPrim([a[0], a[1]], [b[0], b[1]], a[2] ?? 0);
        if (q.k === 'seg') out.push({ ...base, type: 'LINE', a: q.a, b: q.b } as NewEntity);
        else out.push({ ...base, type: 'ARC', c: q.c, r: q.r, a0: q.a0, a1: q.a1 } as NewEntity);
      }
      return structuredClone(out);
    }
    case 'DIMENSION': {
      if (e.block) {
        const def = doc.getBlock(e.block)!;
        const out: NewEntity[] = [];
        for (const ch of def.entities) for (const part of affineEntity(ch, e.xform ?? IDENTITY, ctx)) out.push(inheritFrom(part as unknown as Record<string, unknown>, e, ctx) as unknown as NewEntity);
        return out;
      }
      return dimensionGeometry(e, doc.settings, doc.units).map((g) => inheritFrom({ ...structuredClone(g) } as unknown as Record<string, unknown>, e, ctx) as unknown as NewEntity);
    }
    case 'HATCH': {
      const lines = e.lines?.length ? e.lines : ctx.patternLines?.(e.pattern, e.scale ?? 1, e.angle ?? 0, e.origin ?? [0, 0]);
      const base = props(e);
      if (!lines?.length) { // pattern unknown: keep the boundary as polylines
        return e.loops.filter((l) => l.length >= 2).map((l) => ({ ...base, type: 'LWPOLYLINE', pts: l.map((p) => [p[0], p[1]]), closed: true }) as NewEntity);
      }
      return hatchSegments(e.loops, lines).segs.map((s) => ({ ...base, type: 'LINE', a: [s[0], s[1]], b: [s[2], s[3]] }) as NewEntity);
    }
    case 'MTEXT': return explodeMText(doc, e);
  }
  return null;
}

/** MTEXT → one TEXT per laid-out line, aligned like the MTEXT column so line widths are not needed. */
function explodeMText(doc: CadDocument, t: MTextEnt): NewEntity[] {
  const f = resolveFonts(doc.getStyle(t.style), doc.fonts);
  const lay = layoutMText(t.text, t.h, f, doc.fonts ? t.width ?? 0 : 0, t.lineSpacing);
  const at = (t.attach || 1) - 1, col = at % 3, row = Math.floor(at / 3);
  const top = row === 0 ? 0 : row === 1 ? lay.height / 2 : lay.height;
  const c = Math.cos(t.rot), s = Math.sin(t.rot);
  const out: NewEntity[] = [];
  lay.lines.forEach((l, i) => {
    if (!l.text.trim()) return;
    const y = top - t.h - i * lay.lineHeight;
    const p: Pt = [t.p[0] - s * y, t.p[1] + c * y];
    const o: Record<string, unknown> = { ...props(t as unknown as Entity), type: 'TEXT', text: l.text, p, h: t.h, rot: t.rot, style: t.style };
    if (col) { o.halign = col; o.p2 = p; }
    out.push(o as unknown as NewEntity);
  });
  return out;
}

export const EXPLODE: CommandDef = {
  name: 'EXPLODE', names: ['X'], title: ['Explode', 'تفجير'], group: 'modify',
  async run(c) {
    const ids = await c.getSelection();
    let n = 0;
    const made: number[] = [];
    const why = new Map<string, number>();
    for (const id of ids) {
      const e = c.doc.get(id);
      if (!e) continue;
      const parts = explodeEntity(c.doc, e);
      if (!parts) { const r = explodeRefusal(c.doc, e); const k = `${e.type}: ${c.t(r ?? ['not explodable', 'غير قابل للتفجير'])}`; why.set(k, (why.get(k) ?? 0) + 1); continue; }
      c.doc.remove(id);
      for (const p of parts) made.push(c.doc.add(p).id);
      n++;
    }
    if (made.length) c.previousSelection = made;
    c.print([`${n} object(s) exploded, ${ids.length - n} could not be exploded.`, `تم تفجير ${n} كائن، وتعذر تفجير ${ids.length - n}.`]);
    for (const [k, v] of why) c.print(`  ${v} × ${k}`);
  },
};

// ------------------------------------------------------------------------------------------------ GRIPEDIT
type GripMode = 'STRETCH' | 'MOVE' | 'ROTATE' | 'SCALE' | 'MIRROR';
const MODES: GripMode[] = ['STRETCH', 'MOVE', 'ROTATE', 'SCALE', 'MIRROR'];
const MODE_AR: Record<GripMode, string> = { STRETCH: 'مدّ', MOVE: 'نقل', ROTATE: 'تدوير', SCALE: 'تحجيم', MIRROR: 'انعكاس' };

/**
 * Grip editing, started by clicking a grip (CommandEngine.clickGrip). Enter cycles STRETCH → MOVE → ROTATE → SCALE →
 * MIRROR. Options: Base point, Copy (multiple copies), Undo, eXit; Reference for ROTATE and SCALE. One undo group.
 */
export const GRIPEDIT: CommandDef = {
  name: 'GRIPEDIT', title: ['Grip edit', 'تحرير بنقاط المسك'], group: 'edit',
  async run(c) {
    const hot = c.hotGrips.slice();
    const ids = [...c.selection].filter((id) => c.doc.get(id));
    if (!hot.length || !ids.length) return;
    let base: Pt = c.gripBase ?? c.gripPoint(hot[0]) ?? [0, 0];
    const gctx = { bbox: (e: Entity) => c.doc.bboxOf(e) };
    const byEnt = new Map<number, number[]>();
    for (const h of hot) { if (!byEnt.has(h.id)) byEnt.set(h.id, []); byEnt.get(h.id)!.push(h.index); }
    // original state of the hot entities: stretch is always computed from it (copies use it too)
    const orig = new Map<number, Entity>();
    for (const id of byEnt.keys()) { const e = c.doc.get(id); if (e) orig.set(id, structuredClone(e)); }
    const stretched = (d: Pt) => {
      const out: [number, Entity][] = [];
      for (const [id, idx] of byEnt) { const e = orig.get(id); if (!e) continue; const r = stretchGrips(e, idx, d, gctx); if (r) out.push([id, r]); }
      return out;
    };
    let mode = 0, copy = false, refAngle = 0, refLen = 0;
    const marks: number[] = [];
    let copies = 0;
    try {
      for (;;) {
        const md = MODES[mode];
        c.lastPoint = base;
        const kws: Keyword[] = [kw('B', 'Base point', 'نقطة الأساس'), kw('C', 'Copy', 'نسخ')];
        if (md === 'ROTATE' || md === 'SCALE') kws.push(kw('R', 'Reference', 'مرجع'));
        if (marks.length) kws.push(kw('U', 'Undo', 'تراجع'));
        kws.push(kw('X', 'eXit', 'خروج'));
        const b = base;
        const matrixFor = (p: Pt): Mat | null => {
          switch (md) {
            case 'MOVE': return moveM(sub(p, b));
            case 'ROTATE': return rotateAbout(b, angleOf(b, p) - refAngle);
            case 'SCALE': { const k = dist(b, p) / (refLen || 1); return k > 1e-12 ? scaleAbout(b, k) : null; }
            case 'MIRROR': return dist(b, p) > 1e-12 ? mirrorM(b, p) : null;
            default: return null;
          }
        };
        const preview = (p: Pt): NewEntity[] => {
          if (md === 'STRETCH') return stretched(sub(p, b)).slice(0, PREVIEW_LIMIT).map(([, e]) => strip(e));
          const m = matrixFor(p); return m ? previewOf(c, ids, m) : [];
        };
        const label: [string, string] = md === 'STRETCH' ? ['Specify stretch point', 'حدد نقطة المد'] : md === 'MOVE' ? ['Specify move point', 'حدد نقطة النقل']
          : md === 'ROTATE' ? ['Specify rotation angle', 'حدد زاوية الدوران'] : md === 'SCALE' ? ['Specify scale factor', 'حدد معامل التحجيم'] : ['Specify second point', 'حدد النقطة الثانية'];
        const opts = `${'Base point/Copy'}${md === 'ROTATE' || md === 'SCALE' ? '/Reference' : ''}${marks.length ? '/Undo' : ''}/eXit`;
        const optsAr = `نقطة الأساس/نسخ${md === 'ROTATE' || md === 'SCALE' ? '/مرجع' : ''}${marks.length ? '/تراجع' : ''}/خروج`;
        const msg: [string, string] = [`** ${md}${copy ? ' (multiple)' : ''} ** ${label[0]} or [${opts}]`, `** ${MODE_AR[md]}${copy ? ' (متعدد)' : ''} ** ${label[1]} أو [${optsAr}]`];
        let r: Pt | number | string | null;
        if (md === 'ROTATE') r = await c.getAngle(msg, { base: b, keywords: kws, allowNone: true, preview });
        else if (md === 'SCALE') r = await c.getDistance(msg, { base: b, keywords: kws, allowNone: true, preview });
        else r = await c.getPoint(msg, { base: b, keywords: kws, allowNone: true, preview });
        if (r === null) { mode = (mode + 1) % MODES.length; refAngle = 0; refLen = 0; continue; }
        if (r === 'X') return;
        if (r === 'B') { base = await c.requirePoint(['Specify base point', 'حدد نقطة الأساس']); continue; }
        if (r === 'C') { copy = true; continue; }
        if (r === 'U') { if (marks.length) { c.rollbackTo(marks.pop()!); copies = Math.max(0, copies - 1); } continue; }
        if (r === 'R' && md === 'ROTATE') {
          const ra = await angleWithPoints(c, ['Specify reference angle', 'حدد الزاوية المرجعية'], null, { defaultText: '0' });
          if (typeof ra === 'number') refAngle = ra;
          continue;
        }
        if (r === 'R' && md === 'SCALE') {
          const rl = await c.getDistance(['Specify reference length', 'حدد الطول المرجعي'], { defaultText: '1' });
          if (typeof rl === 'number' && rl > 0) refLen = rl;
          continue;
        }
        let m: Mat | null = null;
        if (md === 'ROTATE' && typeof r === 'number') m = rotateAbout(b, r - refAngle);
        else if (md === 'SCALE' && typeof r === 'number') { const k = r / (refLen || 1); m = k > 1e-12 ? scaleAbout(b, k) : null; }
        else if (Array.isArray(r)) m = matrixFor(r);
        marks.push(c.mark());
        if (md === 'STRETCH') {
          if (!Array.isArray(r)) { marks.pop(); continue; }
          const res = stretched(sub(r, b));
          for (const [id, e] of res) { if (copy) c.doc.add(strip(e)); else c.doc.update(id, () => e); }
        } else {
          if (!m) { marks.pop(); continue; }
          apply(c, ids, m, copy);
        }
        copies++;
        if (!copy) return;
      }
    } finally {
      c.clearHotGrips();
      c.gripBase = null;
    }
  },
};

export const BLOCK: CommandDef = {
  name: 'BLOCK', names: ['B', '-BLOCK'], title: ['Create block', 'إنشاء بلوك'], group: 'modify',
  async run(c) {
    let name: string | null = null;
    for (;;) {
      name = await c.getString(['Enter block name', 'أدخل اسم البلوك']);
      if (!name) return;
      if (/[<>/\\":;?*|,=`]/.test(name)) { c.error(['Invalid block name.', 'اسم بلوك غير صالح.']); continue; }
      if (c.doc.getBlock(name)) {
        const k = await c.getKeyword([`Block "${name}" already exists. Redefine it?`, `البلوك "${name}" موجود. إعادة تعريفه؟`], [kw('Y', 'Yes', 'نعم'), kw('N', 'No', 'لا')], { defaultText: 'N' });
        if (k !== 'Y') continue;
      }
      break;
    }
    const base = await c.requirePoint(['Specify insertion base point', 'حدد نقطة الأساس للإدراج']);
    const ids = await c.getSelection();
    if (!ids.length) { c.error(['No objects selected.', 'لم يتم اختيار كائنات.']); return; }
    const ents = ids.map((id, i) => ({ ...structuredClone(c.doc.get(id)!), id: i + 1 }));
    const def: BlockDef = { name, base, entities: ents, units: c.doc.units };
    c.doc.setBlock(def);
    for (const id of ids) c.doc.remove(id);
    c.add({ type: 'INSERT', layer: '', name, p: base, sx: 1, sy: 1, rot: 0 });
    c.print([`Block "${name}" created with ${ids.length} object(s).`, `تم إنشاء البلوك "${name}" من ${ids.length} كائن.`]);
  },
};

export const INSERT: CommandDef = {
  name: 'INSERT', names: ['I', '-INSERT', 'DDINSERT'], title: ['Insert block', 'إدراج بلوك'], group: 'modify',
  async run(c, r) {
    let name: string | null = null;
    const dlg = r.name.startsWith('-') ? undefined : c.host.dialog?.('insert');
    if (dlg) name = ((await dlg) as string | null) ?? null;
    else name = await c.getString(['Enter block name or [?]', 'أدخل اسم البلوك أو [?]'], { defaultText: (c.memory.lastBlock as string) ?? undefined });
    if (!name) return;
    if (name === '?') { c.print([...c.doc.blocks.keys()].filter((n) => !n.startsWith('*')).join(', ') || '—'); return; }
    if (!c.doc.getBlock(name) && !(await c.host.loadBlock?.(name))) { c.error([`Block "${name}" not found.`, `البلوك "${name}" غير موجود.`]); return; }
    const def = c.doc.getBlock(name)!;
    c.memory.lastBlock = def.name;
    let sc = 1, rot = 0;
    let p: Pt;
    for (;;) {
      const q = await c.getPoint(['Specify insertion point', 'حدد نقطة الإدراج'], { keywords: [kw('S', 'Scale', 'المقياس'), kw('R', 'Rotate', 'تدوير')], preview: (pt) => [{ type: 'INSERT', layer: c.doc.settings.currentLayer, name: def.name, p: pt, sx: sc, sy: sc, rot } as NewEntity] });
      if (q === 'S') { const v = await c.getDistance(['Specify scale factor', 'حدد معامل المقياس'], { defaultText: String(sc) }); if (typeof v === 'number' && v !== 0) sc = v; continue; }
      if (q === 'R') { const v = await c.getAngle(['Specify rotation angle', 'حدد زاوية الدوران'], { defaultText: '0' }); if (typeof v === 'number') rot = v; continue; }
      if (!Array.isArray(q)) return;
      p = q; break;
    }
    const sv = await c.getDistance(['Enter scale factor', 'أدخل معامل المقياس'], { defaultText: String(sc) });
    if (typeof sv === 'number' && sv !== 0) sc = sv;
    const rv = await c.getAngle(['Specify rotation angle', 'حدد زاوية الدوران'], { base: p, defaultText: c.fmt((rot * 180) / Math.PI) });
    if (typeof rv === 'number') rot = rv;
    const ins: Omit<InsertEnt, 'id'> = { type: 'INSERT', layer: '', name: def.name, p, sx: sc, sy: sc, rot };
    const attdefs = def.entities.filter((e): e is TextEnt => e.type === 'ATTDEF');
    if (attdefs.length) {
      const m = insertMatrix(p, sc, sc, rot, def.base);
      ins.attribs = [];
      for (const a of attdefs) {
        const v = await c.getString([`Enter attribute value ${a.prompt || a.tag || ''}`, `أدخل قيمة السمة ${a.prompt || a.tag || ''}`], { allowSpaces: true, defaultText: a.text });
        const t = transformEntity({ ...a, type: 'ATTRIB' } as TextEnt, m);
        ins.attribs.push({ ...t, text: v ?? a.text, layer: a.layer === '0' ? undefined : a.layer } as TextEnt);
      }
    }
    c.add(ins as NewEntity);
  },
};

export const MODIFY_COMMANDS = [ERASE, OOPS, MOVE, COPY, ROTATE, SCALE, MIRROR, EXPLODE, BLOCK, INSERT, SELECT, MIRRTEXT, GRIPEDIT];
export { mmul };
