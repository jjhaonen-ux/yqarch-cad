/**
 * Geometry-dependent editing tools (Phase 3B) with AutoCAD prompts and options:
 * OFFSET, TRIM, EXTEND, FILLET, CHAMFER, ARRAY (rectangular / polar), STRETCH, BREAK, BREAKATPOINT, JOIN.
 */
import type { Entity, NewEntity, PolylineEnt, Pt } from '../types';
import {
  arcToCircle, breakEntity, distanceToCurve, extendByPick, isModifiableCurve, joinEntities, offsetCurve, offsetSideSign,
  stretchEntity, trimByPicks, trimByPredicate, type EdgeOptions,
} from '../geom/modify';
import { chamfer, chamferPolyline, fillet, filletPolyline, type ChamferSpec, type CornerError, type CornerResult } from '../geom/corner';
import { edgeIntersections, edgePoint, entityPath, isArcEdge, edgeSweep, type Edge } from '../geom/curve';
import { pointInPolygon } from '../geom/prims';
import { evalSpline, hasNurbs } from '../geom/spline';
import { TAU, sub } from '../geom/vec';
import { moveM, rotateAbout } from '../geom/transform';
import { xform } from './modify';
import { kw, type CommandDef, type CommandEngine, type Msg } from './engine';

const CURVES = (e: Entity) => isModifiableCurve(e);
const propsOnly = (e: Entity): NewEntity => { const { id: _id, ...rest } = e; return rest as NewEntity; };
const KW_UNDO = kw('U', 'Undo', 'تراجع');
const KW_EXIT = kw('E', 'Exit', 'خروج');

function replaceOne(c: CommandEngine, id: number, replacement: NewEntity[]) {
  if (!replacement.length) { c.doc.remove(id); return; }
  c.doc.update(id, () => ({ ...replacement[0], id } as Entity));
  for (const e of replacement.slice(1)) c.add(e);
}
const splinePoints = (e: Entity): Pt[] | null => (e.type === 'SPLINE' && hasNurbs(e) ? evalSpline(e, Math.max(64, 8 * (e.ctrl?.length ?? 0) + 1)) : null);
const visibleEntities = (c: CommandEngine) => [...c.doc.entities.values()].filter((e) => c.doc.isVisible(e));
const editable = (c: CommandEngine, e: Entity | undefined): e is Entity => !!e && !c.doc.isLocked(e) && c.doc.isVisible(e);

/** Undo stack inside one command (rolls back the ops of the last step). */
function undoStack(c: CommandEngine) {
  const marks: number[] = [];
  return {
    push() { marks.push(c.mark()); },
    /** Drop the last mark when the step turned out to change nothing. */
    cancel() { const m = marks[marks.length - 1]; if (m !== undefined && c.mark() === m) marks.pop(); },
    undo() {
      const m = marks.pop();
      if (m === undefined) { c.print(['All operations have been undone.', 'تم التراجع عن جميع العمليات.']); return false; }
      c.rollbackTo(m); return true;
    },
  };
}

// ======================================================================= OFFSET
type OffsetMem = { dist: number | 'T'; erase: boolean; layer: 'C' | 'S' };
const offsetMem = (c: CommandEngine): OffsetMem => (c.memory.offset3b as OffsetMem) ?? (c.memory.offset3b = { dist: 'T', erase: false, layer: 'S' }) as OffsetMem;

export const OFFSET: CommandDef = {
  name: 'OFFSET', names: ['OF'], title: ['Offset', 'إزاحة'], group: 'modify',
  async run(c) {
    const m = offsetMem(c);
    c.print([`Current settings: Erase source=${m.erase ? 'Yes' : 'No'}  Layer=${m.layer === 'C' ? 'Current' : 'Source'}  OFFSETGAPTYPE=0`,
      `الإعدادات الحالية: حذف المصدر=${m.erase ? 'نعم' : 'لا'}  الطبقة=${m.layer === 'C' ? 'الحالية' : 'المصدر'}  OFFSETGAPTYPE=0`]);
    // ---- distance / options
    for (;;) {
      const def = m.dist === 'T' ? 'Through' : c.fmt(m.dist);
      const a = await c.getDistance(['Specify offset distance or [Through/Erase/Layer]', 'حدد مسافة الإزاحة أو [مرور/حذف/طبقة]'],
        { keywords: [kw('T', 'Through', 'مرور'), kw('E', 'Erase', 'حذف'), kw('L', 'Layer', 'طبقة')], defaultText: def });
      if (a === null) return;
      if (a === 'T') { m.dist = 'T'; break; }
      if (a === 'E') { const k = await c.getKeyword(['Erase source object after offsetting? [Yes/No]', 'حذف الكائن المصدر بعد الإزاحة؟ [نعم/لا]'], [kw('Y', 'Yes', 'نعم'), kw('N', 'No', 'لا')], { defaultText: m.erase ? 'Yes' : 'No' }); if (k) m.erase = k === 'Y'; continue; }
      if (a === 'L') { const k = await c.getKeyword(['Enter layer option for offset objects [Current/Source]', 'خيار طبقة كائنات الإزاحة [الحالية/المصدر]'], [kw('C', 'Current', 'الحالية'), kw('S', 'Source', 'المصدر')], { defaultText: m.layer === 'C' ? 'Current' : 'Source' }); if (k) m.layer = k as 'C' | 'S'; continue; }
      if (typeof a === 'number') {
        if (a <= 0) { c.error(['Value must be positive and nonzero.', 'يجب أن تكون القيمة موجبة وغير صفرية.']); continue; }
        m.dist = a; break;
      }
    }
    const through = m.dist === 'T';
    const signedFor = (e: Entity, p: Pt) => {
      const d = through ? distanceToCurve(e, p) : (m.dist as number);
      return d > 1e-12 && Number.isFinite(d) ? offsetSideSign(e, p) * d : 0;
    };
    const resultFor = (e: Entity, p: Pt) => { const d = signedFor(e, p); return d ? offsetCurve(e, d) : []; };
    const undo = undoStack(c);
    const create = (src: Entity, p: Pt): Entity[] | null => {
      const out = resultFor(src, p);
      if (!out.length) { c.print(['Cannot offset that object.', 'لا يمكن إزاحة هذا الكائن.']); return null; }
      undo.push();
      return out.map((n) => c.add(m.layer === 'C' ? { ...n, layer: '' } : n));
    };
    // ---- objects
    for (;;) {
      const ans = await c.getEntity(['Select object to offset or [Exit/Undo]', 'حدد الكائن لإزاحته أو [خروج/تراجع]'], { filter: CURVES, keywords: [KW_EXIT, KW_UNDO], allowNone: true });
      if (ans === null || ans === 'E') return;
      if (ans === 'U') { undo.undo(); continue; }
      if (typeof ans === 'string') continue;
      const src = c.doc.get(ans.id);
      if (!src) continue;
      let multiple = false, cur: Entity = src, erased = false;
      for (;;) {
        const msg: Msg = through
          ? (multiple ? ['Specify through point or [Exit/Undo] <next object>', 'حدد نقطة المرور أو [خروج/تراجع] <الكائن التالي>'] : ['Specify through point or [Exit/Multiple/Undo] <Exit>', 'حدد نقطة المرور أو [خروج/متعدد/تراجع] <خروج>'])
          : (multiple ? ['Specify point on side to offset or [Exit/Undo] <next object>', 'حدد نقطة على جانب الإزاحة أو [خروج/تراجع] <الكائن التالي>'] : ['Specify point on side to offset or [Exit/Multiple/Undo] <Exit>', 'حدد نقطة على جانب الإزاحة أو [خروج/متعدد/تراجع] <خروج>']);
        const base = cur;
        const p = await c.getPoint(msg, { keywords: multiple ? [KW_EXIT, KW_UNDO] : [KW_EXIT, kw('M', 'Multiple', 'متعدد'), KW_UNDO], allowNone: true, preview: (q) => resultFor(base, q) });
        if (p === null) { if (multiple) break; return; }
        if (p === 'E') return;
        if (p === 'M') { multiple = true; continue; }
        if (p === 'U') { if (undo.undo()) { cur = src; erased = false; } if (!multiple) break; continue; }
        if (typeof p === 'string') continue;
        const made = create(cur, p);
        if (!made) continue;
        if (m.erase && !erased && c.doc.get(src.id)) { c.doc.remove(src.id); erased = true; }
        if (!multiple) break;
        cur = made[0];
      }
    }
  },
};

// ======================================================================= TRIM / EXTEND
type TrimMem = { quick: boolean; extendEdges: boolean };
const trimMem = (c: CommandEngine): TrimMem => (c.memory.trim3b as TrimMem) ?? (c.memory.trim3b = { quick: false, extendEdges: false }) as TrimMem;

function pieceHitsFence(edges: Edge[], fence: Pt[]): boolean {
  for (let i = 0; i + 1 < fence.length; i++) {
    const f: Edge = { a: fence[i], b: fence[i + 1], bulge: 0 };
    for (const e of edges) if (edgeIntersections(e, f).length) return true;
  }
  return false;
}
function pieceHitsBox(edges: Edge[], a: Pt, b: Pt): boolean {
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
  const inBox = (p: Pt) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
  for (const e of edges) {
    if (inBox(e.a) || inBox(e.b)) return true;
    if (isArcEdge(e)) { const n = Math.max(4, Math.ceil(Math.abs(edgeSweep(e)) / (TAU / 64))); for (let k = 1; k < n; k++) if (inBox(edgePoint(e, k / n))) return true; }
  }
  return pieceHitsFence(edges, [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]);
}

function trimOrExtendCommand(mode: 'TRIM' | 'EXTEND'): CommandDef {
  const isTrim = mode === 'TRIM';
  return {
    name: mode, title: isTrim ? ['Trim', 'قص'] : ['Extend', 'إطالة'], group: 'modify',
    async run(c) {
      const m = trimMem(c);
      const settings = () => c.print([`Current settings: Projection=UCS, Edge=${m.extendEdges ? 'Extend' : 'None'}, Mode=${m.quick ? 'Quick' : 'Standard'}`,
        `الإعدادات الحالية: الإسقاط=UCS، الحافة=${m.extendEdges ? 'ممتدة' : 'بدون'}، الوضع=${m.quick ? 'سريع' : 'قياسي'}`]);
      settings();
      let edgeIds: number[] | null = null; // null = every visible object
      const chooseEdges = async () => {
        c.print(isTrim ? ['Select cutting edges ...', 'حدد حواف القص ...'] : ['Select boundary edges ...', 'حدد حواف الحد ...']);
        const ids = await c.getSelection(['Select objects or <select all>', 'حدد الكائنات أو <تحديد الكل>']);
        edgeIds = ids.length ? ids : null;
      };
      if (!m.quick) await chooseEdges();
      const edges = (): Entity[] => edgeIds ? edgeIds.map((id) => c.doc.get(id)).filter((e): e is Entity => !!e) : visibleEntities(c);
      const opts = (): EdgeOptions & { quick?: boolean } => ({ extendEdges: m.extendEdges, splinePoints, quick: m.quick });
      const undo = undoStack(c);
      const apply = (op: 'TRIM' | 'EXTEND', target: Entity, pick: Pt): boolean => {
        if (op === 'TRIM') {
          const r = trimByPicks(target, [pick], edges(), opts());
          if (!r) return false;
          replaceOne(c, target.id, r); return true;
        }
        const r = extendByPick(target, pick, edges(), opts());
        if (!r) return false;
        replaceOne(c, target.id, [r]); return true;
      };
      const keywords = () => [
        ...(m.quick ? [] : [kw('T', 'cuTting edges', 'حواف القص')]),
        kw('F', 'Fence', 'سياج'), kw('C', 'Crossing', 'تقاطع'), kw('O', 'mOde', 'الوضع'), kw('P', 'Project', 'إسقاط'),
        kw('E', 'Edge', 'الحافة'), ...(isTrim ? [kw('R', 'eRase', 'حذف')] : []), KW_UNDO,
      ];
      const prompt = (): Msg => isTrim
        ? ['Select object to trim or shift-select to extend or [' + (m.quick ? '' : 'cuTting edges/') + 'Fence/Crossing/mOde/Project/Edge/eRase/Undo]', 'حدد الكائن لقصه أو Shift للإطالة أو [' + (m.quick ? '' : 'حواف القص/') + 'سياج/تقاطع/الوضع/إسقاط/الحافة/حذف/تراجع]']
        : ['Select object to extend or shift-select to trim or [' + (m.quick ? '' : 'Boundary edges/') + 'Fence/Crossing/mOde/Project/Edge/Undo]', 'حدد الكائن لإطالته أو Shift للقص أو [' + (m.quick ? '' : 'حواف الحد/') + 'سياج/تقاطع/الوضع/إسقاط/الحافة/تراجع]'];
      const multi = async (hit: (edgesOf: Edge[]) => boolean, fencePts: Pt[] | null, box: [Pt, Pt] | null) => {
        const targets = visibleEntities(c).filter((e) => CURVES(e) && !c.doc.isLocked(e));
        undo.push(); let n = 0;
        for (const t of targets) {
          const cur = c.doc.get(t.id); if (!cur) continue;
          if (isTrim) {
            const r = trimByPredicate(cur, edges(), hit, opts());
            if (r) { replaceOne(c, cur.id, r); n++; }
          } else {
            // extend: the end nearest where the fence / window meets the object
            const pts = fencePts ? fencePts : box ? [box[0], [box[1][0], box[0][1]] as Pt, box[1], [box[0][0], box[1][1]] as Pt, box[0]] : [];
            const at = boundaryHits(cur, pts);
            const r = at ? extendByPick(cur, at, edges(), opts()) : null;
            if (r) { replaceOne(c, cur.id, [r]); n++; }
          }
        }
        if (!n) { undo.cancel(); c.print(['No objects were modified.', 'لم يتم تعديل أي كائن.']); }
      };
      for (;;) {
        const ans = await c.getEntity(prompt(), { filter: CURVES, keywords: keywords(), allowNone: true });
        if (ans === null) return;
        if (typeof ans === 'string') {
          switch (ans) {
            case 'U': undo.undo(); break;
            case 'T': await chooseEdges(); break;
            case 'O': { const k = await c.getKeyword(['Enter a trim mode option [Quick/Standard]', 'حدد وضع القص [سريع/قياسي]'], [kw('Q', 'Quick', 'سريع'), kw('S', 'Standard', 'قياسي')], { defaultText: m.quick ? 'Quick' : 'Standard' }); if (k) { m.quick = k === 'Q'; if (!m.quick) await chooseEdges(); else edgeIds = null; settings(); } break; }
            case 'E': { const k = await c.getKeyword(['Enter an implied edge extension mode [Extend/No extend]', 'وضع امتداد الحواف الضمني [امتداد/بدون امتداد]'], [kw('E', 'Extend', 'امتداد'), kw('N', 'No extend', 'بدون امتداد')], { defaultText: m.extendEdges ? 'Extend' : 'No extend' }); if (k) { m.extendEdges = k === 'E'; settings(); } break; }
            case 'P': c.print(['Projection: UCS (2D drawing).', 'الإسقاط: UCS (رسم ثنائي الأبعاد).']); break;
            case 'R': {
              const ids = await c.getSelection(['Select objects to erase', 'حدد الكائنات لحذفها']);
              if (ids.length) { undo.push(); for (const id of ids) c.doc.remove(id); }
              break;
            }
            case 'F': {
              const pts: Pt[] = [await c.requirePoint(['Specify first fence point', 'حدد نقطة السياج الأولى'])];
              for (;;) { const p = await c.getPoint(['Specify next fence point or [Undo]', 'حدد نقطة السياج التالية أو [تراجع]'], { base: pts[pts.length - 1], keywords: [KW_UNDO], allowNone: true }); if (p === null) break; if (p === 'U') { if (pts.length > 1) pts.pop(); continue; } if (Array.isArray(p)) pts.push(p); }
              if (pts.length >= 2) await multi((e) => pieceHitsFence(e, pts), pts, null);
              break;
            }
            case 'C': {
              const a = await c.requirePoint(['Specify first corner', 'حدد الركن الأول']);
              const b = await c.requirePoint(['Specify opposite corner', 'حدد الركن المقابل'], { base: a, rubber: 'rect' });
              await multi((e) => pieceHitsBox(e, a, b), null, [a, b]);
              break;
            }
            default: break;
          }
          continue;
        }
        const target = c.doc.get(ans.id);
        if (!editable(c, target)) continue;
        const op: 'TRIM' | 'EXTEND' = ans.shift ? (isTrim ? 'EXTEND' : 'TRIM') : mode;
        undo.push();
        if (!apply(op, target, ans.p)) {
          undo.cancel();
          c.print(op === 'TRIM' ? ['Object does not intersect a cutting edge.', 'الكائن لا يتقاطع مع حافة قص.'] : ['Object does not intersect an edge.', 'الكائن لا يتقاطع مع حافة حد.']);
        }
      }
    },
  };
}
/** First point where a fence polyline meets an entity (used to choose the extended end). */
function boundaryHits(e: Entity, fence: Pt[]): Pt | null {
  const path = entityEdges(e);
  for (let i = 0; i + 1 < fence.length; i++) {
    const f: Edge = { a: fence[i], b: fence[i + 1], bulge: 0 };
    for (const x of path) { const h = edgeIntersections(x, f); if (h.length) return h[0].p; }
  }
  return null;
}
const entityEdges = (e: Entity): Edge[] => entityPath(e)?.edges ?? [];

// ======================================================================= FILLET / CHAMFER
const CORNER_MSG: Record<CornerError, [string, string]> = {
  parallel: ['Lines are parallel.', 'الخطان متوازيان.'],
  radius: ['Radius is too large.', 'نصف القطر كبير جداً.'],
  distance: ['Distance is too large.', 'المسافة كبيرة جداً.'],
  unsupported: ['Cannot fillet/chamfer that object.', 'لا يمكن معالجة هذا الكائن.'],
  notAdjacent: ['Polyline segments are not adjacent.', 'قطعتا الخط المتعدد غير متجاورتين.'],
  notEndSegment: ['Only an end segment of an open polyline can be used with another object.', 'يمكن استخدام القطعة الطرفية لخط متعدد مفتوح فقط مع كائن آخر.'],
  noSolution: ['No valid solution for these objects.', 'لا يوجد حل صالح لهذين الكائنين.'],
  sameObject: ['Cannot use the same object twice.', 'لا يمكن استخدام نفس الكائن مرتين.'],
  collinear: ['Objects are collinear.', 'الكائنان على استقامة واحدة.'],
};
function applyCorner(c: CommandEngine, r: CornerResult): boolean {
  if (!r.ok) { c.error(CORNER_MSG[r.error]); return false; }
  for (const u of r.updates) c.doc.update(u.id, () => ({ ...u.ent, id: u.id } as Entity));
  for (const n of r.add) c.add(n);
  return true;
}

type FilletMem = { radius: number; trim: boolean };
export const FILLET: CommandDef = {
  name: 'FILLET', title: ['Fillet', 'تدوير الزاوية'], group: 'modify',
  async run(c) {
    const m = (c.memory.fillet3b as FilletMem) ?? (c.memory.fillet3b = { radius: (c.memory.filletRadius as number) ?? 0, trim: true }) as FilletMem;
    c.print([`Current settings: Mode = ${m.trim ? 'TRIM' : 'NOTRIM'}, Radius = ${c.fmt(m.radius)}`, `الإعدادات الحالية: الوضع = ${m.trim ? 'قص' : 'بدون قص'}، نصف القطر = ${c.fmt(m.radius)}`]);
    const undo = undoStack(c);
    let multiple = false;
    const askRadius = async () => {
      const r = await c.getDistance(['Specify fillet radius', 'حدد نصف قطر التدوير'], { defaultText: c.fmt(m.radius) });
      if (typeof r === 'number') { if (r < 0) c.error(['Value must be positive.', 'يجب أن تكون القيمة موجبة.']); else { m.radius = r; c.memory.filletRadius = r; } }
    };
    for (;;) {
      const first = await c.getEntity(['Select first object or [Undo/Polyline/Radius/Trim/Multiple]', 'حدد الكائن الأول أو [تراجع/خط متعدد/نصف القطر/قص/متعدد]'],
        { filter: CURVES, keywords: [KW_UNDO, kw('P', 'Polyline', 'خط متعدد'), kw('R', 'Radius', 'نصف القطر'), kw('T', 'Trim', 'قص'), kw('M', 'Multiple', 'متعدد')], allowNone: true });
      if (first === null) return;
      if (typeof first === 'string') {
        if (first === 'U') undo.undo();
        else if (first === 'R') await askRadius();
        else if (first === 'M') multiple = true;
        else if (first === 'T') { const k = await c.getKeyword(['Enter Trim mode option [Trim/No trim]', 'خيار وضع القص [قص/بدون قص]'], [kw('T', 'Trim', 'قص'), kw('N', 'No trim', 'بدون قص')], { defaultText: m.trim ? 'Trim' : 'No trim' }); if (k) m.trim = k === 'T'; }
        else if (first === 'P') {
          const pl = await c.getEntity(['Select 2D polyline', 'حدد خطاً متعدداً ثنائي الأبعاد'], { filter: (e) => e.type === 'LWPOLYLINE' });
          if (pl && typeof pl !== 'string') {
            const e = c.doc.get(pl.id) as PolylineEnt | undefined;
            if (e && editable(c, e)) {
              const r = filletPolyline(e, m.radius);
              if (r.count) { undo.push(); c.doc.update(e.id, () => ({ ...r.ent, id: e.id } as Entity)); }
              c.print([`${r.count} lines were filleted${r.tooShort ? `, ${r.tooShort} were too short` : ''}`, `تم تدوير ${r.count} زاوية${r.tooShort ? `، ${r.tooShort} قصيرة جداً` : ''}`]);
              if (!multiple) return;
            }
          }
        }
        continue;
      }
      const e1 = c.doc.get(first.id);
      if (!editable(c, e1)) continue;
      let r2: { id: number; p: Pt; shift?: boolean } | null = null;
      for (;;) {
        const s = await c.getEntity(['Select second object or shift-select to apply corner or [Radius]', 'حدد الكائن الثاني أو Shift لزاوية حادة أو [نصف القطر]'], { filter: CURVES, keywords: [kw('R', 'Radius', 'نصف القطر')], allowNone: true });
        if (s === 'R') { await askRadius(); continue; }
        if (s === null) break;
        if (typeof s !== 'string') { r2 = s; break; }
      }
      if (!r2) { if (multiple) continue; return; }
      const e2 = c.doc.get(r2.id);
      if (!editable(c, e2)) continue;
      undo.push();
      const res = fillet({ ent: e1, p: first.p }, { ent: e2, p: r2.p }, r2.shift ? 0 : m.radius, { trim: m.trim });
      if (!applyCorner(c, res)) undo.cancel();
      if (!multiple) return;
    }
  },
};

type ChamferMem = { method: 'D' | 'A'; d1: number; d2: number; length: number; angle: number; trim: boolean };
export const CHAMFER: CommandDef = {
  name: 'CHAMFER', title: ['Chamfer', 'شطف'], group: 'modify',
  async run(c) {
    const m = (c.memory.chamfer3b as ChamferMem) ?? (c.memory.chamfer3b = { method: 'D', d1: (c.memory.chamfer1 as number) ?? 0, d2: (c.memory.chamfer2 as number) ?? 0, length: 0, angle: 0, trim: true }) as ChamferMem;
    const status = () => c.print(m.method === 'D'
      ? [`(${m.trim ? 'TRIM' : 'NOTRIM'} mode) Current chamfer Dist1 = ${c.fmt(m.d1)}, Dist2 = ${c.fmt(m.d2)}`, `(وضع ${m.trim ? 'القص' : 'بدون قص'}) مسافة الشطف الحالية 1 = ${c.fmt(m.d1)}، 2 = ${c.fmt(m.d2)}`]
      : [`(${m.trim ? 'TRIM' : 'NOTRIM'} mode) Current chamfer Length = ${c.fmt(m.length)}, Angle = ${c.fmt(m.angle)}`, `(وضع ${m.trim ? 'القص' : 'بدون قص'}) طول الشطف = ${c.fmt(m.length)}، الزاوية = ${c.fmt(m.angle)}`]);
    status();
    const spec = (zero = false): ChamferSpec => zero ? { method: 'distance', d1: 0, d2: 0 } : m.method === 'D' ? { method: 'distance', d1: m.d1, d2: m.d2 } : { method: 'angle', length: m.length, angle: (m.angle * Math.PI) / 180 };
    const undo = undoStack(c);
    let multiple = false;
    const LINES = (e: Entity) => e.type === 'LINE' || e.type === 'LWPOLYLINE';
    for (;;) {
      const first = await c.getEntity(['Select first line or [Undo/Polyline/Distance/Angle/Trim/mEthod/Multiple]', 'حدد الخط الأول أو [تراجع/خط متعدد/مسافة/زاوية/قص/الطريقة/متعدد]'],
        { filter: LINES, keywords: [KW_UNDO, kw('P', 'Polyline', 'خط متعدد'), kw('D', 'Distance', 'مسافة'), kw('A', 'Angle', 'زاوية'), kw('T', 'Trim', 'قص'), kw('E', 'mEthod', 'الطريقة'), kw('M', 'Multiple', 'متعدد')], allowNone: true });
      if (first === null) return;
      if (typeof first === 'string') {
        switch (first) {
          case 'U': undo.undo(); break;
          case 'M': multiple = true; break;
          case 'D': {
            const a = await c.getDistance(['Specify first chamfer distance', 'حدد مسافة الشطف الأولى'], { defaultText: c.fmt(m.d1) });
            if (typeof a === 'number' && a >= 0) m.d1 = a;
            const b = await c.getDistance(['Specify second chamfer distance', 'حدد مسافة الشطف الثانية'], { defaultText: c.fmt(m.d1) });
            if (typeof b === 'number' && b >= 0) m.d2 = b; else m.d2 = m.d1;
            m.method = 'D'; c.memory.chamfer1 = m.d1; c.memory.chamfer2 = m.d2; break;
          }
          case 'A': {
            const a = await c.getDistance(['Specify chamfer length on the first line', 'حدد طول الشطف على الخط الأول'], { defaultText: c.fmt(m.length) });
            if (typeof a === 'number' && a >= 0) m.length = a;
            const g = await c.getDistance(['Specify chamfer angle from the first line', 'حدد زاوية الشطف من الخط الأول'], { defaultText: c.fmt(m.angle) });
            if (typeof g === 'number') m.angle = g;
            m.method = 'A'; break;
          }
          case 'E': { const k = await c.getKeyword(['Enter trim method [Distance/Angle]', 'حدد طريقة الشطف [مسافة/زاوية]'], [kw('D', 'Distance', 'مسافة'), kw('A', 'Angle', 'زاوية')], { defaultText: m.method === 'D' ? 'Distance' : 'Angle' }); if (k) m.method = k as 'D' | 'A'; break; }
          case 'T': { const k = await c.getKeyword(['Enter Trim mode option [Trim/No trim]', 'خيار وضع القص [قص/بدون قص]'], [kw('T', 'Trim', 'قص'), kw('N', 'No trim', 'بدون قص')], { defaultText: m.trim ? 'Trim' : 'No trim' }); if (k) m.trim = k === 'T'; break; }
          case 'P': {
            const pl = await c.getEntity(['Select 2D polyline', 'حدد خطاً متعدداً ثنائي الأبعاد'], { filter: (e) => e.type === 'LWPOLYLINE' });
            if (pl && typeof pl !== 'string') {
              const e = c.doc.get(pl.id) as PolylineEnt | undefined;
              if (e && editable(c, e)) {
                const r = chamferPolyline(e, spec());
                if (r.count) { undo.push(); c.doc.update(e.id, () => ({ ...r.ent, id: e.id } as Entity)); }
                c.print([`${r.count} lines were chamfered${r.tooShort ? `, ${r.tooShort} were too short` : ''}`, `تم شطف ${r.count} زاوية${r.tooShort ? `، ${r.tooShort} قصيرة جداً` : ''}`]);
                if (!multiple) return;
              }
            }
            break;
          }
          default: break;
        }
        continue;
      }
      const e1 = c.doc.get(first.id);
      if (!editable(c, e1)) continue;
      const second = await c.getEntity(['Select second line or shift-select to apply corner', 'حدد الخط الثاني أو Shift لزاوية حادة'], { filter: LINES, allowNone: true });
      if (!second || typeof second === 'string') { if (multiple) continue; return; }
      const e2 = c.doc.get(second.id);
      if (!editable(c, e2)) continue;
      undo.push();
      const res = chamfer({ ent: e1, p: first.p }, { ent: e2, p: second.p }, spec(!!second.shift), { trim: m.trim });
      if (!applyCorner(c, res)) undo.cancel();
      if (!multiple) return;
    }
  },
};

// ======================================================================= ARRAY
/** Reference point used by a non-rotated polar array (AutoCAD uses the last selected object's base point). */
export function referencePoint(e: Entity): Pt {
  switch (e.type) {
    case 'LINE': return e.a;
    case 'CIRCLE': case 'ARC': case 'ELLIPSE': return e.c;
    case 'LWPOLYLINE': return [e.pts[0][0], e.pts[0][1]];
    case 'POINT': case 'TEXT': case 'MTEXT': case 'INSERT': case 'ATTDEF': case 'ATTRIB': return e.p;
    case 'SPLINE': return e.pts[0] ?? [0, 0];
    case 'SOLID': return e.pts[0];
    case 'HATCH': return e.loops[0]?.[0] ?? [0, 0];
    case 'WIPEOUT': return e.loop[0];
    case 'DIMENSION': return e.p1 ?? e.loc ?? e.textPoint ?? [0, 0];
    default: return [0, 0];
  }
}
/** Angles of the copies of a classic polar array (item 0 = the source). */
export function polarAngles(count: number, fill: number): number[] {
  const n = Math.floor(count);
  if (n < 2) return [];
  const full = Math.abs(Math.abs(fill) - TAU) < 1e-9 || Math.abs(fill) > TAU;
  const step = full ? (Math.sign(fill) || 1) * TAU / n : fill / (n - 1);
  return Array.from({ length: n - 1 }, (_, i) => step * (i + 1));
}

export const ARRAY: CommandDef = {
  name: 'ARRAY', names: ['ARRAYCLASSIC'], title: ['Array', 'مصفوفة'], group: 'modify',
  async run(c) {
    const mode = await c.getKeyword(['Enter the type of array [Rectangular/Polar]', 'نوع المصفوفة [مستطيلة/قطبية]'], [kw('R', 'Rectangular', 'مستطيلة'), kw('P', 'Polar', 'قطبية')], { defaultText: (c.memory.arrayMode as string) === 'P' ? 'Polar' : 'Rectangular' });
    if (!mode) return;
    c.memory.arrayMode = mode;
    const ids = await c.getSelection(['Select objects', 'حدد الكائنات']);
    const source = ids.map((id) => c.doc.get(id)).filter((e): e is Entity => !!e);
    if (!source.length) return;
    if (mode === 'R') {
      const rows = await c.getDistance(['Enter the number of rows (---)', 'عدد الصفوف (---)'], { defaultText: String((c.memory.arrayRows as number) ?? 1) });
      if (typeof rows !== 'number' || rows < 1) return;
      const cols = await c.getDistance(['Enter the number of columns (|||)', 'عدد الأعمدة (|||)'], { defaultText: String((c.memory.arrayCols as number) ?? 1) });
      if (typeof cols !== 'number' || cols < 1) return;
      const R = Math.floor(rows), C = Math.floor(cols);
      if (R * C < 2) { c.error(['A one-element array is not allowed.', 'لا يُسمح بمصفوفة من عنصر واحد.']); return; }
      let rowSpace = 0, colSpace = 0;
      if (R > 1) { const v = await c.getDistance(['Enter the distance between rows', 'المسافة بين الصفوف'], { defaultText: String((c.memory.arrayRowSpace as number) ?? 100) }); if (typeof v !== 'number') return; rowSpace = v; }
      if (C > 1) { const v = await c.getDistance(['Specify the distance between columns (|||)', 'المسافة بين الأعمدة (|||)'], { defaultText: String((c.memory.arrayColSpace as number) ?? 100) }); if (typeof v !== 'number') return; colSpace = v; }
      c.memory.arrayRows = R; c.memory.arrayCols = C; c.memory.arrayRowSpace = rowSpace; c.memory.arrayColSpace = colSpace;
      for (let row = 0; row < R; row++) for (let col = 0; col < C; col++) {
        if (row === 0 && col === 0) continue;
        const mm = moveM([col * colSpace, row * rowSpace]);
        for (const e of source) c.add(propsOnly(xform(c.doc, e, mm)));
      }
      return;
    }
    const center = await c.requirePoint(['Specify center point of array', 'حدد مركز المصفوفة']);
    const count = await c.getDistance(['Enter the number of items in the array', 'عدد العناصر في المصفوفة'], { defaultText: String((c.memory.arrayPolarCount as number) ?? 6) });
    if (typeof count !== 'number' || count < 2) { if (typeof count === 'number') c.error(['At least two items are required.', 'يلزم عنصران على الأقل.']); return; }
    const fill = await c.getAngle(['Specify the angle to fill (+=ccw, -=cw)', 'حدد زاوية الملء (+ عكس عقارب الساعة، - مع عقارب الساعة)'], { defaultText: String((c.memory.arrayPolarSweep as number) ?? 360) });
    if (typeof fill !== 'number' || Math.abs(fill) < 1e-12) return;
    const rot = await c.getKeyword(['Rotate arrayed objects? [Yes/No]', 'تدوير عناصر المصفوفة؟ [نعم/لا]'], [kw('Y', 'Yes', 'نعم'), kw('N', 'No', 'لا')], { defaultText: 'Yes' });
    // getAngle maps typed 360 to 0 rad: treat a typed full turn as 360
    const fillRad = Math.abs(fill) < 1e-9 ? TAU : fill;
    c.memory.arrayPolarCount = Math.floor(count); c.memory.arrayPolarSweep = Math.round((fillRad * 180) / Math.PI * 1e9) / 1e9;
    const ref = referencePoint(source[source.length - 1]);
    for (const a of polarAngles(count, fillRad)) {
      const rm = rotateAbout(center, a);
      const tm = (() => { const cs = Math.cos(a), sn = Math.sin(a), dx = ref[0] - center[0], dy = ref[1] - center[1]; return moveM([center[0] + dx * cs - dy * sn - ref[0], center[1] + dx * sn + dy * cs - ref[1]]); })();
      for (const e of source) c.add(propsOnly(xform(c.doc, e, rot === 'N' ? tm : rm)));
    }
  },
};

// ======================================================================= STRETCH
export const STRETCH: CommandDef = {
  name: 'STRETCH', title: ['Stretch', 'مط'], group: 'modify',
  async run(c) {
    c.print(['Select objects to stretch by crossing-window or crossing-polygon...', 'حدد الكائنات للمط بنافذة تقاطع أو مضلع تقاطع...']);
    const ids = await c.getSelection(['Select objects', 'حدد الكائنات']);
    if (!ids.length) return;
    const regions = c.selectionRegions.filter((r) => r.crossing || r.kind === 'box');
    if (!regions.length) { c.print(['Objects must be selected with a crossing window or crossing polygon; nothing to stretch.', 'يجب التحديد بنافذة أو مضلع تقاطع؛ لا يوجد ما يُمط.']); return; }
    const inside = (p: Pt) => regions.some((r) => r.kind === 'box'
      ? p[0] >= Math.min(r.pts[0][0], r.pts[1][0]) - 1e-9 && p[0] <= Math.max(r.pts[0][0], r.pts[1][0]) + 1e-9 && p[1] >= Math.min(r.pts[0][1], r.pts[1][1]) - 1e-9 && p[1] <= Math.max(r.pts[0][1], r.pts[1][1]) + 1e-9
      : pointInPolygon(p, r.pts));
    const ents = ids.map((id) => c.doc.get(id)).filter((e): e is Entity => !!e && !c.doc.isLocked(e));
    const base = await c.getPoint(['Specify base point or [Displacement]', 'حدد نقطة الأساس أو [إزاحة]'], { keywords: [kw('D', 'Displacement', 'إزاحة')], allowNone: true });
    let delta: Pt;
    if (base === null || base === 'D') {
      const d = await c.requirePoint(['Specify displacement', 'حدد الإزاحة'], { preview: (p) => ents.map((e) => propsOnly(stretchEntity(e, inside, p))) });
      delta = d;
    } else if (Array.isArray(base)) {
      const end = await c.getPoint(['Specify second point or <use first point as displacement>', 'حدد النقطة الثانية أو <استخدام النقطة الأولى كإزاحة>'], { base, allowNone: true, preview: (p) => ents.map((e) => propsOnly(stretchEntity(e, inside, sub(p, base)))) });
      delta = Array.isArray(end) ? sub(end, base) : base;
    } else return;
    for (const e of ents) c.doc.update(e.id, (x) => stretchEntity(x, inside, delta));
  },
};

// ======================================================================= BREAK
async function breakFlow(c: CommandEngine, single: boolean) {
  const picked = await c.getEntity(['Select object', 'حدد الكائن'], { filter: CURVES });
  if (!picked || typeof picked === 'string') return;
  const target = c.doc.get(picked.id);
  if (!editable(c, target)) return;
  let p1: Pt = picked.p, p2: Pt;
  if (single) {
    p1 = await c.requirePoint(['Specify break point', 'حدد نقطة القطع']);
    p2 = p1;
  } else {
    let s = await c.getPoint(['Specify second break point or [First point]', 'حدد نقطة القطع الثانية أو [النقطة الأولى]'], { keywords: [kw('F', 'First point', 'النقطة الأولى')], rawText: /^@$/ });
    if (s === 'F') {
      p1 = await c.requirePoint(['Specify first break point', 'حدد نقطة القطع الأولى']);
      s = await c.getPoint(['Specify second break point', 'حدد نقطة القطع الثانية'], { rawText: /^@$/ });
    }
    if (s === '@') p2 = p1; else if (Array.isArray(s)) p2 = s; else return;
  }
  const pieces = breakEntity(target, p1, p2);
  if (!pieces) { c.error(target.type === 'CIRCLE' ? ['Arc cannot be full 360 degrees.', 'لا يمكن قطع دائرة عند نقطة واحدة.'] : ['Cannot break the object at these points.', 'لا يمكن قطع الكائن عند هاتين النقطتين.']); return; }
  replaceOne(c, target.id, pieces);
}
export const BREAK: CommandDef = { name: 'BREAK', title: ['Break', 'قطع'], group: 'modify', run: (c) => breakFlow(c, false) };
export const BREAKATPOINT: CommandDef = { name: 'BREAKATPOINT', names: ['BREAKAT'], title: ['Break at point', 'قطع عند نقطة'], group: 'modify', run: (c) => breakFlow(c, true) };

// ======================================================================= JOIN
export const JOIN: CommandDef = {
  name: 'JOIN', title: ['Join', 'وصل'], group: 'modify',
  async run(c) {
    const ids = await c.getSelection(['Select source object or multiple objects to join at once', 'حدد الكائن المصدر أو عدة كائنات لوصلها دفعة واحدة'], { filter: (e) => CURVES(e) && e.type !== 'CIRCLE' });
    const input = ids.map((id) => c.doc.get(id)).filter((e): e is Entity => !!e && !c.doc.isLocked(e));
    if (!input.length) return;
    if (input.length === 1) {
      const e = input[0];
      if (e.type === 'ARC') {
        const k = await c.getKeyword(['Select arcs to join to source or [cLose]', 'حدد أقواساً لوصلها بالمصدر أو [إغلاق]'], [kw('L', 'cLose', 'إغلاق')], { allowNone: true });
        if (k === 'L') { replaceOne(c, e.id, [arcToCircle(e)]); c.print(['Arc converted to a circle.', 'تم تحويل القوس إلى دائرة.']); }
        return;
      }
      c.print(['1 object selected; nothing to join.', 'تم تحديد كائن واحد؛ لا يوجد ما يُوصل.']);
      return;
    }
    let ext = 1;
    for (const e of input) for (const x of entityEdges(e)) ext = Math.max(ext, Math.abs(x.a[0]), Math.abs(x.a[1]), Math.abs(x.b[0]), Math.abs(x.b[1]));
    const r = joinEntities(input, 1e-9 * ext + 1e-7);
    if (!r.add.length) { c.print(['0 objects joined.', 'لم يتم وصل أي كائن.']); return; }
    for (const id of r.remove) c.doc.remove(id);
    for (const e of r.add) c.add(e);
    c.print([`${r.joined} objects converted to ${r.add.length} object(s).`, `تم تحويل ${r.joined} كائن إلى ${r.add.length} كائن.`]);
  },
};

export const TRIM = trimOrExtendCommand('TRIM');
export const EXTEND = trimOrExtendCommand('EXTEND');
export const MODIFY_3B_COMMANDS: CommandDef[] = [OFFSET, TRIM, EXTEND, FILLET, CHAMFER, ARRAY, STRETCH, BREAK, BREAKATPOINT, JOIN];
