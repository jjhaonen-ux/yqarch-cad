/** Draw commands: LINE, PLINE, CIRCLE, ARC, RECTANG, POLYGON, ELLIPSE, POINT. */
import type { NewEntity, Pt } from '../types';
import { bulgeFrom3, bulgeTangent, circleFrom3, seg, type Prim } from '../geom/prims';
import { add, angleOf, dist, mid, normAngle, polar, sub, TAU } from '../geom/vec';
import { CommandCancelled, kw, type CommandDef, type CommandEngine } from './engine';

const L = (c: CommandEngine) => c.doc.settings.currentLayer;
export const mkLine = (c: CommandEngine, a: Pt, b: Pt): NewEntity => ({ type: 'LINE', layer: L(c), a, b });
export const mkCircle = (c: CommandEngine, ctr: Pt, r: number): NewEntity => ({ type: 'CIRCLE', layer: L(c), c: ctr, r });
export const mkPoly = (c: CommandEngine, pts: number[][], closed: boolean, width?: number): NewEntity => ({ type: 'LWPOLYLINE', layer: L(c), pts, closed, ...(width ? { width } : {}) });

const K = {
  close: kw('C', 'Close', 'إغلاق'), undo: kw('U', 'Undo', 'تراجع'), arc: kw('A', 'Arc', 'قوس'), line: kw('L', 'Line', 'خط'),
  width: kw('W', 'Width', 'سماكة'), second: kw('S', 'Second pt', 'نقطة ثانية'), center: kw('C', 'Center', 'مركز'),
  p3: kw('3P', '3P', '3 نقاط'), p2: kw('2P', '2P', 'نقطتان'), diameter: kw('D', 'Diameter', 'قطر'), edge: kw('E', 'Edge', 'ضلع'),
  inscribed: kw('I', 'Inscribed in circle', 'داخل الدائرة'), circumscribed: kw('C', 'Circumscribed about circle', 'خارج الدائرة'),
  dims: kw('D', 'Dimensions', 'أبعاد'), rotation: kw('R', 'Rotation', 'دوران'), cl: kw('CL', 'CLose', 'إغلاق'),
};

export const LINE: CommandDef = {
  name: 'LINE', title: ['Line', 'خط'], group: 'draw',
  async run(c) {
    let first = await c.getPoint(['Specify first point', 'حدد النقطة الأولى'], { allowNone: true });
    if (!Array.isArray(first)) { if (!c.lastPoint) return; first = c.lastPoint; }
    const pts: Pt[] = [first];
    const marks: number[] = [];
    for (;;) {
      const last = pts[pts.length - 1];
      const keywords = pts.length >= 3 ? [K.close, K.undo] : pts.length >= 2 ? [K.undo] : [];
      const r = await c.getPoint(['Specify next point', 'حدد النقطة التالية'], { base: last, keywords, allowNone: true, preview: (p) => [mkLine(c, last, p)] });
      if (r === null) return;
      if (r === 'U') {
        if (marks.length) { c.rollbackTo(marks.pop()!); pts.pop(); c.lastPoint = pts[pts.length - 1]; }
        else c.print(['All segments already undone.', 'لا توجد مقاطع للتراجع.']);
        continue;
      }
      if (r === 'C') { c.add(mkLine(c, last, pts[0])); c.lastPoint = pts[0]; return; }
      if (typeof r === 'string') continue;
      if (dist(r, last) < 1e-12) continue;
      marks.push(c.mark());
      c.add(mkLine(c, last, r));
      pts.push(r);
    }
  },
};

export const PLINE: CommandDef = {
  name: 'PLINE', names: ['PL', 'LWPOLYLINE'], title: ['Polyline', 'خط متعدد'], group: 'draw',
  async run(c) {
    const start = await c.requirePoint(['Specify start point', 'حدد نقطة البداية']);
    const verts: number[][] = [[start[0], start[1]]];
    let arcMode = false;
    let width = (c.memory.plineWidth as number) ?? 0;
    c.print([`Current line-width is ${c.fmt(width)}`, `سماكة الخط الحالية ${c.fmt(width)}`]);
    const lastPt = (): Pt => { const v = verts[verts.length - 1]; return [v[0], v[1]]; };
    const endTangent = (): Pt => {
      if (verts.length < 2) return [1, 0];
      const a = verts[verts.length - 2], b = verts[verts.length - 1];
      const ch = angleOf([a[0], a[1]], [b[0], b[1]]), th = 4 * Math.atan(a[2] ?? 0);
      const t = ch + th / 2;
      return [Math.cos(t), Math.sin(t)];
    };
    const finish = (closed: boolean) => {
      if (verts.length < 2) return;
      if (closed && verts.length >= 3) {
        const a = verts[0], b = verts[verts.length - 1];
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) { const lastB = verts.pop()!; void lastB; }
      }
      const pts = verts.map((v) => (v[2] ? [v[0], v[1], v[2]] : [v[0], v[1]]));
      c.add(mkPoly(c, pts, closed, width || undefined));
    };
    const draft = (p: Pt, bulge: number): NewEntity[] => {
      const pts = verts.map((v) => [...v]);
      pts[pts.length - 1][2] = bulge;
      pts.push([p[0], p[1]]);
      return [mkPoly(c, pts.map((v) => (v[2] ? v : [v[0], v[1]])), false, width || undefined)];
    };
    try {
      for (;;) {
        const last = lastPt();
        if (!arcMode) {
          const keywords = [K.arc, ...(verts.length >= 3 ? [K.close] : []), ...(verts.length >= 2 ? [K.undo] : []), K.width];
          const r = await c.getPoint(['Specify next point', 'حدد النقطة التالية'], { base: last, keywords, allowNone: true, preview: (p) => draft(p, 0) });
          if (r === null) break;
          if (r === 'A') { arcMode = true; continue; }
          if (r === 'C') { finish(true); return; }
          if (r === 'U') { if (verts.length > 1) { verts.pop(); verts[verts.length - 1].length = 2; } continue; }
          if (r === 'W') { const w = await c.getDistance(['Specify width', 'حدد السماكة'], { defaultText: c.fmt(width) }); if (typeof w === 'number') { width = w; c.memory.plineWidth = w; } continue; }
          if (typeof r === 'string') continue;
          if (dist(r, last) < 1e-12) continue;
          verts[verts.length - 1].length = 2;
          verts.push([r[0], r[1]]);
        } else {
          const tan = endTangent();
          const keywords = [...(verts.length >= 2 ? [K.cl] : []), K.line, K.second, ...(verts.length >= 2 ? [K.undo] : []), K.width];
          const r = await c.getPoint(['Specify endpoint of arc', 'حدد نهاية القوس'], { base: last, keywords, allowNone: true, rubber: 'none', preview: (p) => draft(p, bulgeTangent(last, tan, p)) });
          if (r === null) break;
          if (r === 'L') { arcMode = false; continue; }
          if (r === 'CL') { verts[verts.length - 1][2] = bulgeTangent(last, tan, [verts[0][0], verts[0][1]]); finish(true); return; }
          if (r === 'U') { if (verts.length > 1) { verts.pop(); verts[verts.length - 1].length = 2; } continue; }
          if (r === 'W') { const w = await c.getDistance(['Specify width', 'حدد السماكة'], { defaultText: c.fmt(width) }); if (typeof w === 'number') { width = w; c.memory.plineWidth = w; } continue; }
          if (r === 'S') {
            const p2 = await c.requirePoint(['Specify second point on arc', 'حدد نقطة ثانية على القوس'], { base: last });
            const p3 = await c.requirePoint(['Specify end point of arc', 'حدد نهاية القوس'], { base: p2, preview: (p) => draft(p, bulgeFrom3(last, p2, p)) });
            verts[verts.length - 1][2] = bulgeFrom3(last, p2, p3);
            verts.push([p3[0], p3[1]]);
            continue;
          }
          if (typeof r === 'string') continue;
          if (dist(r, last) < 1e-12) continue;
          verts[verts.length - 1][2] = bulgeTangent(last, tan, r);
          verts.push([r[0], r[1]]);
        }
      }
    } catch (e) {
      if (e instanceof CommandCancelled) finish(false);
      throw e;
    }
    finish(false);
  },
};

export const CIRCLE: CommandDef = {
  name: 'CIRCLE', title: ['Circle', 'دائرة'], group: 'draw',
  async run(c) {
    const r0 = await c.getPoint(['Specify center point for circle', 'حدد مركز الدائرة'], { keywords: [K.p3, K.p2] });
    if (r0 === '3P') {
      const a = await c.requirePoint(['Specify first point on circle', 'حدد النقطة الأولى على الدائرة']);
      const b = await c.requirePoint(['Specify second point on circle', 'حدد النقطة الثانية على الدائرة'], { base: a });
      const p = await c.requirePoint(['Specify third point on circle', 'حدد النقطة الثالثة على الدائرة'], { preview: (q) => { const cc = circleFrom3(a, b, q); return cc ? [mkCircle(c, cc.c, cc.r)] : []; } });
      const cc = circleFrom3(a, b, p);
      if (!cc) { c.error(['Points are collinear.', 'النقاط على استقامة واحدة.']); return; }
      c.add(mkCircle(c, cc.c, cc.r)); c.memory.radius = cc.r; return;
    }
    if (r0 === '2P') {
      const a = await c.requirePoint(['Specify first end point of circle\'s diameter', 'حدد الطرف الأول للقطر']);
      const b = await c.requirePoint(['Specify second end point of circle\'s diameter', 'حدد الطرف الثاني للقطر'], { base: a, preview: (q) => [mkCircle(c, mid(a, q), dist(a, q) / 2)] });
      c.add(mkCircle(c, mid(a, b), dist(a, b) / 2)); c.memory.radius = dist(a, b) / 2; return;
    }
    if (!Array.isArray(r0)) return;
    const ctr = r0;
    const last = (c.memory.radius as number) ?? 0;
    let r = await c.getDistance(['Specify radius of circle', 'حدد نصف قطر الدائرة'], { base: ctr, keywords: [K.diameter], defaultText: last ? c.fmt(last) : undefined, preview: (p) => [mkCircle(c, ctr, dist(ctr, p))] });
    if (r === 'D') {
      const d = await c.getDistance(['Specify diameter of circle', 'حدد قطر الدائرة'], { base: ctr, defaultText: last ? c.fmt(last * 2) : undefined, preview: (p) => [mkCircle(c, ctr, dist(ctr, p) / 2)] });
      r = typeof d === 'number' ? d / 2 : null;
    }
    if (typeof r !== 'number' || r <= 0) return;
    c.memory.radius = r;
    c.add(mkCircle(c, ctr, r));
  },
};

function arcFrom3(a: Pt, b: Pt, p: Pt): NewEntity | null {
  const cc = circleFrom3(a, b, p);
  if (!cc) return null;
  const ccw = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) > 0;
  const sa = angleOf(cc.c, a), ea = angleOf(cc.c, p);
  return { type: 'ARC', layer: '', c: cc.c, r: cc.r, a0: normAngle(ccw ? sa : ea), a1: normAngle(ccw ? ea : sa) };
}

export const ARC: CommandDef = {
  name: 'ARC', title: ['Arc', 'قوس'], group: 'draw',
  async run(c) {
    const lay = (e: NewEntity | null) => (e ? [{ ...e, layer: c.doc.settings.currentLayer }] : []);
    const r0 = await c.getPoint(['Specify start point of arc', 'حدد بداية القوس'], { keywords: [K.center] });
    if (r0 === 'C') {
      const ctr = await c.requirePoint(['Specify center point of arc', 'حدد مركز القوس']);
      const s = await c.requirePoint(['Specify start point of arc', 'حدد بداية القوس'], { base: ctr });
      const rr = dist(ctr, s), a0 = angleOf(ctr, s);
      const e = await c.requirePoint(['Specify end point of arc (CCW)', 'حدد نهاية القوس (عكس عقارب الساعة)'], { base: ctr, preview: (p) => lay({ type: 'ARC', layer: '', c: ctr, r: rr, a0, a1: angleOf(ctr, p) }) });
      c.add({ type: 'ARC', layer: '', c: ctr, r: rr, a0: normAngle(a0), a1: normAngle(angleOf(ctr, e)) });
      return;
    }
    if (!Array.isArray(r0)) return;
    const a = r0;
    const r1 = await c.getPoint(['Specify second point of arc', 'حدد النقطة الثانية للقوس'], { base: a, keywords: [K.center] });
    if (r1 === 'C') {
      const ctr = await c.requirePoint(['Specify center point of arc', 'حدد مركز القوس'], { base: a });
      const rr = dist(ctr, a), a0 = angleOf(ctr, a);
      const e = await c.requirePoint(['Specify end point of arc (CCW)', 'حدد نهاية القوس'], { base: ctr, preview: (p) => lay({ type: 'ARC', layer: '', c: ctr, r: rr, a0, a1: angleOf(ctr, p) }) });
      c.add({ type: 'ARC', layer: '', c: ctr, r: rr, a0: normAngle(a0), a1: normAngle(angleOf(ctr, e)) });
      return;
    }
    if (!Array.isArray(r1)) return;
    const b = r1;
    const p = await c.requirePoint(['Specify end point of arc', 'حدد نهاية القوس'], { preview: (q) => lay(arcFrom3(a, b, q)) });
    const e = arcFrom3(a, b, p);
    if (!e) { c.error(['Points are collinear.', 'النقاط على استقامة واحدة.']); return; }
    c.add(e);
  },
};

const rectPts = (a: Pt, b: Pt, rot = 0): number[][] => {
  if (!rot) return [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]];
  const u: Pt = [Math.cos(rot), Math.sin(rot)], v: Pt = [-u[1], u[0]];
  const d = sub(b, a), w = d[0] * u[0] + d[1] * u[1], h = d[0] * v[0] + d[1] * v[1];
  const p1 = add(a, [u[0] * w, u[1] * w]), p3 = add(a, [v[0] * h, v[1] * h]);
  return [[a[0], a[1]], [p1[0], p1[1]], [b[0], b[1]], [p3[0], p3[1]]];
};

export const RECTANG: CommandDef = {
  name: 'RECTANG', names: ['RECTANGLE'], title: ['Rectangle', 'مستطيل'], group: 'draw',
  async run(c) {
    const a = await c.requirePoint(['Specify first corner point', 'حدد الركن الأول']);
    let rot = (c.memory.rectRot as number) ?? 0;
    for (;;) {
      const r = await c.getPoint(['Specify other corner point', 'حدد الركن المقابل'], { base: a, keywords: [K.dims, K.rotation], rubber: 'none', preview: (p) => [mkPoly(c, rectPts(a, p, rot), true)] });
      if (r === 'R') { const ang = await c.getAngle(['Specify rotation angle', 'حدد زاوية الدوران'], { base: a, defaultText: c.fmt((rot * 180) / Math.PI) }); if (typeof ang === 'number') { rot = ang; c.memory.rectRot = rot; } continue; }
      if (r === 'D') {
        const w = await c.getDistance(['Specify length for rectangles', 'حدد طول المستطيل'], { defaultText: c.memory.rectW ? c.fmt(c.memory.rectW as number) : undefined });
        const h = await c.getDistance(['Specify width for rectangles', 'حدد عرض المستطيل'], { defaultText: c.memory.rectH ? c.fmt(c.memory.rectH as number) : undefined });
        if (typeof w !== 'number' || typeof h !== 'number') return;
        c.memory.rectW = w; c.memory.rectH = h;
        const u: Pt = [Math.cos(rot), Math.sin(rot)], v: Pt = [-u[1], u[0]];
        const q = await c.requirePoint(['Specify other corner point (side)', 'حدد جهة الركن المقابل'], { base: a });
        const sx = Math.sign((q[0] - a[0]) * u[0] + (q[1] - a[1]) * u[1]) || 1, sy = Math.sign((q[0] - a[0]) * v[0] + (q[1] - a[1]) * v[1]) || 1;
        const b: Pt = [a[0] + u[0] * w * sx + v[0] * h * sy, a[1] + u[1] * w * sx + v[1] * h * sy];
        c.add(mkPoly(c, rectPts(a, b, rot), true)); return;
      }
      if (!Array.isArray(r)) return;
      if (Math.abs(r[0] - a[0]) < 1e-12 || Math.abs(r[1] - a[1]) < 1e-12) { if (!rot) { c.error(['Degenerate rectangle.', 'مستطيل بأبعاد صفرية.']); continue; } }
      c.add(mkPoly(c, rectPts(a, r, rot), true));
      return;
    }
  },
};

export const POLYGON: CommandDef = {
  name: 'POLYGON', title: ['Polygon', 'مضلع'], group: 'draw',
  async run(c) {
    const nDef = (c.memory.polySides as number) ?? 4;
    let n = nDef;
    for (;;) {
      const s = await c.getString(['Enter number of sides', 'أدخل عدد الأضلاع'], { defaultText: String(nDef) });
      const v = Math.round(Number(s));
      if (v >= 3 && v <= 1024) { n = v; break; }
      c.error(['Requires an integer between 3 and 1024.', 'يلزم عدد صحيح بين 3 و1024.']);
    }
    c.memory.polySides = n;
    const ring = (ctr: Pt, r: number, a: number) => Array.from({ length: n }, (_, i) => { const p = polar(ctr, a + (i * TAU) / n, r); return [p[0], p[1]]; });
    const r0 = await c.getPoint(['Specify center of polygon', 'حدد مركز المضلع'], { keywords: [K.edge] });
    if (r0 === 'E') {
      const a = await c.requirePoint(['Specify first endpoint of edge', 'حدد الطرف الأول للضلع']);
      const make = (b: Pt) => { const L2 = dist(a, b), R = L2 / (2 * Math.sin(Math.PI / n)); const m2 = mid(a, b), h = R * Math.cos(Math.PI / n); const ang = angleOf(a, b); const ctr = polar(m2, ang + Math.PI / 2, h); return ring(ctr, R, angleOf(ctr, a)); };
      const b = await c.requirePoint(['Specify second endpoint of edge', 'حدد الطرف الثاني للضلع'], { base: a, preview: (p) => (dist(a, p) > 0 ? [mkPoly(c, make(p), true)] : []) });
      c.add(mkPoly(c, make(b), true)); return;
    }
    if (!Array.isArray(r0)) return;
    const ctr = r0;
    const mode = (await c.getKeyword(['Enter an option', 'اختر'], [K.inscribed, K.circumscribed], { defaultText: (c.memory.polyMode as string) ?? 'I' })) ?? 'I';
    c.memory.polyMode = mode;
    const make = (p: Pt) => { const d = dist(ctr, p), a = angleOf(ctr, p); return mode === 'I' ? ring(ctr, d, a) : ring(ctr, d / Math.cos(Math.PI / n), a + Math.PI / n); };
    const r = await c.getPoint(['Specify radius of circle', 'حدد نصف قطر الدائرة'], { base: ctr, preview: (p) => [mkPoly(c, make(p), true)] });
    if (Array.isArray(r)) { c.add(mkPoly(c, make(r), true)); return; }
  },
};

export const ELLIPSE: CommandDef = {
  name: 'ELLIPSE', title: ['Ellipse', 'قطع ناقص'], group: 'draw',
  async run(c) {
    const lay = c.doc.settings.currentLayer;
    const mk = (ctr: Pt, major: Pt, ratio: number): NewEntity => ({ type: 'ELLIPSE', layer: lay, c: ctr, major, ratio: Math.max(1e-6, ratio), a0: 0, a1: TAU });
    const build = (ctr: Pt, axisEnd: Pt, other: number): NewEntity => {
      const major = sub(axisEnd, ctr), ml = Math.hypot(major[0], major[1]);
      if (other <= ml) return mk(ctr, major, other / ml);
      const u: Pt = [-major[1] / ml * other, major[0] / ml * other]; // other axis becomes major
      return mk(ctr, u, ml / other);
    };
    const r0 = await c.getPoint(['Specify axis endpoint of ellipse', 'حدد طرف محور القطع الناقص'], { keywords: [K.center] });
    let ctr: Pt, axisEnd: Pt;
    if (r0 === 'C') {
      ctr = await c.requirePoint(['Specify center of ellipse', 'حدد مركز القطع الناقص']);
      axisEnd = await c.requirePoint(['Specify endpoint of axis', 'حدد طرف المحور'], { base: ctr });
    } else if (Array.isArray(r0)) {
      const a = r0;
      const b = await c.requirePoint(['Specify other endpoint of axis', 'حدد الطرف الآخر للمحور'], { base: a });
      ctr = mid(a, b); axisEnd = b;
    } else return;
    const c0 = ctr, ae = axisEnd;
    const d = await c.getDistance(['Specify distance to other axis', 'حدد المسافة إلى المحور الآخر'], { base: c0, preview: (p) => [build(c0, ae, distToAxis(c0, ae, p))] });
    if (typeof d !== 'number' || d <= 0) return;
    c.add(build(c0, ae, d));
  },
};
function distToAxis(c: Pt, e: Pt, p: Pt) { const u = sub(e, c), l = Math.hypot(u[0], u[1]) || 1; return Math.abs(((p[0] - c[0]) * -u[1] + (p[1] - c[1]) * u[0]) / l); }

export const POINT: CommandDef = {
  name: 'POINT', names: ['PO'], title: ['Point', 'نقطة'], group: 'draw',
  async run(c) {
    for (;;) {
      const p = await c.getPoint(['Specify a point', 'حدد نقطة'], { allowNone: true });
      if (!Array.isArray(p)) return;
      c.add({ type: 'POINT', layer: '', p });
    }
  },
};

/** Primitives of in-progress geometry, offered to object snaps (e.g. snapping to the first PLINE vertex). */
export const progressPrims = (pts: Pt[]): Prim[] => pts.slice(1).map((p, i) => seg(pts[i], p));

export const DRAW_COMMANDS = [LINE, PLINE, CIRCLE, ARC, RECTANG, POLYGON, ELLIPSE, POINT];
