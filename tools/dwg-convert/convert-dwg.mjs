#!/usr/bin/env node
/**
 * DWG -> normalized JSON converter for YQArch block libraries.
 *
 *   node convert-dwg.mjs --src <YQArch folder> --out <assets/blocks> [--only <substring>]
 *
 * Reads every *.dwg under --src with libredwg-web (GPL-3.0, kept isolated in this folder) and writes one
 * compact JSON per drawing plus index.json. The output format is documented in docs/asset-formats.md.
 * All angles are radians, counter-clockwise. Object-coordinate-system (OCS) entities with a negative
 * extrusion (mirrored in AutoCAD) are converted to world coordinates here, so consumers never see OCS.
 */
import { Dwg_File_Type, LibreDwg } from '@mlightcad/libredwg-web';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.lastIndexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };

const VERSIONS = { AC1009: 'R12', AC1012: 'R13', AC1014: 'R14', AC1015: '2000', AC1018: '2004', AC1021: '2007', AC1024: '2010', AC1027: '2013', AC1032: '2018' };
// libredwg lineweight enum -> 1/100 mm (-1 ByLayer, -2 ByBlock, -3 Default)
const LW = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];
const lineweight = (v) => (v == null ? -1 : v <= 23 ? LW[v] : v === 30 ? -2 : v === 31 ? -3 : -1);

const R = (v, d = 5) => { const f = 10 ** d; const r = Math.round(v * f) / f; return Object.is(r, -0) ? 0 : r; };
const TAU = Math.PI * 2;

// ------------------------------------------------------------------ geometry helpers
/** Points along a polyline bulge segment p0->p1 (bulge = tan(sweep/4), positive = CCW), excluding p0. */
function bulgePts(p0, p1, b, seg = 64) {
  if (!b) return [p1];
  const th = 4 * Math.atan(b);
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  const chord = Math.hypot(dx, dy);
  if (!chord) return [p1];
  const r = chord / (2 * Math.sin(Math.abs(th) / 2));
  const d = r * Math.cos(Math.abs(th) / 2); // distance from chord midpoint to center
  const s = Math.sign(b);
  const mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2;
  const cx = mx - (s * d * dy) / chord, cy = my + (s * d * dx) / chord;
  const a0 = Math.atan2(p0[1] - cy, p0[0] - cx);
  const n = Math.max(2, Math.ceil((Math.abs(th) / TAU) * seg));
  const out = [];
  for (let i = 1; i < n; i++) { const a = a0 + (th * i) / n; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  out.push(p1);
  return out;
}

function arcPts(cx, cy, r, a0, a1, seg = 64) { // CCW from a0 to a1, includes both ends
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += TAU;
  if (sweep > TAU) sweep = TAU;
  const n = Math.max(2, Math.ceil((sweep / TAU) * seg));
  const out = [];
  for (let i = 0; i <= n; i++) { const a = a0 + (sweep * i) / n; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return out;
}

function ellipsePts(c, maj, ratio, t0, t1, seg = 64) { // CCW params
  let sweep = t1 - t0;
  while (sweep <= 0) sweep += TAU;
  if (sweep > TAU + 1e-9) sweep = TAU;
  const mn = [-maj[1] * ratio, maj[0] * ratio];
  const n = Math.max(4, Math.ceil((sweep / TAU) * seg));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = t0 + (sweep * i) / n;
    out.push([c[0] + maj[0] * Math.cos(t) + mn[0] * Math.sin(t), c[1] + maj[1] * Math.cos(t) + mn[1] * Math.sin(t)]);
  }
  return out;
}

/** Sample a (possibly rational) B-spline with de Boor's algorithm. */
function splinePts(degree, knots, ctrl, weights, samples) {
  const n = ctrl.length;
  if (n < 2 || !knots?.length || knots.length < n + degree + 1) return ctrl.map((p) => [p[0], p[1]]);
  const w = weights && weights.length === n && weights.some((x) => x > 0 && x !== 1) ? weights : null;
  const lo = knots[degree], hi = knots[n];
  const N = samples ?? Math.max(16, n * 8);
  const out = [];
  for (let s = 0; s <= N; s++) {
    let u = lo + ((hi - lo) * s) / N;
    if (s === N) u = hi - 1e-12 * Math.max(1, Math.abs(hi));
    let k = degree;
    while (k < n - 1 && u >= knots[k + 1]) k++;
    const d = [];
    for (let j = 0; j <= degree; j++) {
      const p = ctrl[k - degree + j]; const wt = w ? w[k - degree + j] : 1;
      d.push([p[0] * wt, p[1] * wt, wt]);
    }
    for (let r = 1; r <= degree; r++) {
      for (let j = degree; j >= r; j--) {
        const i = k - degree + j;
        const den = knots[i + degree - r + 1] - knots[i];
        const a = den ? (u - knots[i]) / den : 0;
        d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1], (1 - a) * d[j - 1][2] + a * d[j][2]];
      }
    }
    const q = d[degree];
    out.push([q[0] / q[2], q[1] / q[2]]);
  }
  return out;
}

const P = (p, m = false) => [R(m ? -(p?.x ?? 0) : p?.x ?? 0), R(p?.y ?? 0)];
const PR = (a, m = false) => [R(m ? -a[0] : a[0]), R(a[1])];
const ang = (a) => { let v = a % TAU; if (v < 0) v += TAU; return R(v, 6); };
const mirrored = (e) => !!e.extrusionDirection && e.extrusionDirection.z < 0;

// ------------------------------------------------------------------ entity normalization
function common(e) {
  const o = { type: e.type, layer: e.layer ?? '0' };
  if (e.colorIndex !== undefined && e.colorIndex !== 256) o.color = e.colorIndex;
  if (typeof e.color === 'number' && e.color >= 0 && e.colorIndex === undefined) o.trueColor = '#' + (e.color & 0xffffff).toString(16).padStart(6, '0');
  const lt = (e.lineType ?? '').trim();
  if (lt && lt.toUpperCase() !== 'BYLAYER') o.linetype = lt;
  if (e.lineTypeScale && e.lineTypeScale !== 1) o.ltScale = R(e.lineTypeScale);
  const lw = lineweight(e.lineweight);
  if (lw !== -1) o.lineweight = lw;
  return o;
}

function textProps(t, m) {
  const o = {
    p: P(t.startPoint, m), h: R(t.textHeight ?? 0), rot: R(m ? -(t.rotation ?? 0) : t.rotation ?? 0, 6),
    style: t.styleName ?? 'Standard',
  };
  if ((t.halign ?? 0) || (t.valign ?? 0)) { o.p2 = P(t.endPoint, m); o.halign = t.halign ?? 0; o.valign = t.valign ?? 0; }
  if (t.xScale && t.xScale !== 1) o.widthFactor = R(t.xScale);
  if (t.obliqueAngle) o.oblique = R(t.obliqueAngle, 6);
  if (t.generationFlag) o.generation = t.generationFlag;
  if (m) o.mirrored = true;
  return o;
}

function flattenHatchPath(p, seg = 48) {
  if (p.boundaryPathTypeFlag & 2) {
    const v = p.vertices ?? [];
    if (!v.length) return [];
    const pts = [[v[0].x, v[0].y]];
    const n = v.length;
    const closed = p.isClosed !== 0;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = v[i], b = v[(i + 1) % n];
      pts.push(...bulgePts([a.x, a.y], [b.x, b.y], a.bulge || 0, seg));
    }
    return pts;
  }
  const pts = [];
  const push = (arr) => { for (const q of arr) { const l = pts[pts.length - 1]; if (!l || Math.abs(l[0] - q[0]) > 1e-9 || Math.abs(l[1] - q[1]) > 1e-9) pts.push(q); } };
  for (const ed of p.edges ?? []) {
    if (ed.type === 1) push([[ed.start.x, ed.start.y], [ed.end.x, ed.end.y]]);
    else if (ed.type === 2) {
      if (ed.isCCW) push(arcPts(ed.center.x, ed.center.y, ed.radius, ed.startAngle, ed.endAngle, seg));
      else push(arcPts(ed.center.x, ed.center.y, ed.radius, -ed.endAngle, -ed.startAngle, seg).reverse());
    } else if (ed.type === 3) {
      const c = [ed.center.x, ed.center.y], maj = [ed.end.x, ed.end.y], ratio = ed.lengthOfMinorAxis;
      if (ed.isCCW) push(ellipsePts(c, maj, ratio, ed.startAngle, ed.endAngle, seg));
      else push(ellipsePts(c, maj, ratio, -ed.endAngle, -ed.startAngle, seg).reverse());
    } else if (ed.type === 4) {
      const ctrl = (ed.controlPoints ?? []).map((q) => [q.x, q.y]);
      const w = ed.isRational ? (ed.controlPoints ?? []).map((q) => q.w) : null;
      push(splinePts(ed.degree, ed.knots, ctrl, w));
    }
  }
  return pts;
}

function normalize(e, stats) {
  const m = mirrored(e);
  const o = common(e);
  switch (e.type) {
    case 'LINE': return { ...o, a: P(e.startPoint), b: P(e.endPoint) };            // WCS
    case 'POINT': return { ...o, p: P(e.position) };                                // WCS
    case 'CIRCLE': return { ...o, c: P(e.center, m), r: R(e.radius) };
    case 'ARC':
      return { ...o, c: P(e.center, m), r: R(e.radius), a0: ang(m ? Math.PI - e.endAngle : e.startAngle), a1: ang(m ? Math.PI - e.startAngle : e.endAngle) };
    case 'ELLIPSE': {                                                                // WCS center/axis; params flip with -Z normal
      const full = Math.abs(e.endAngle - e.startAngle) >= TAU - 1e-9;
      return { ...o, c: P(e.center), major: P(e.majorAxisEndPoint), ratio: R(e.axisRatio, 6), a0: full ? 0 : ang(m ? -e.endAngle : e.startAngle), a1: full ? R(TAU, 6) : ang(m ? -e.startAngle : e.endAngle) };
    }
    case 'LWPOLYLINE': {
      const pts = (e.vertices ?? []).map((v) => { const q = [R(m ? -v.x : v.x), R(v.y)]; if (v.bulge) q.push(R(m ? -v.bulge : v.bulge, 6)); return q; });
      const r = { ...o, pts, closed: !!((e.flag ?? 0) & 512) };
      if (e.constantWidth) r.width = R(e.constantWidth);
      return r;
    }
    case 'POLYLINE2D': {
      const vs = (e.vertices ?? []).filter((v) => !((v.flag ?? 0) & 16));
      const pts = vs.map((v) => { const q = [R(m ? -v.x : v.x), R(v.y)]; if (v.bulge) q.push(R(m ? -v.bulge : v.bulge, 6)); return q; });
      const r = { ...o, type: 'LWPOLYLINE', pts, closed: !!((e.flag ?? 0) & 1), source: 'POLYLINE2D' };
      const w = vs[0]?.startWidth;
      if (w && vs.every((v) => v.startWidth === w && v.endWidth === w)) r.width = R(w);
      return r;
    }
    case 'POLYLINE3D': {
      const vs = (e.vertices ?? []).filter((v) => !((v.flag ?? 0) & 16));
      return { ...o, type: 'LWPOLYLINE', pts: vs.map((v) => [R(v.x), R(v.y)]), closed: !!((e.flag ?? 0) & 1), source: 'POLYLINE3D' };
    }
    case 'SPLINE': {
      const ctrl = (e.controlPoints ?? []).map((q) => [q.x, q.y]);
      const fit = (e.fitPoints ?? []).map((q) => [q.x, q.y]);
      const pts = ctrl.length ? splinePts(e.degree, e.knots, ctrl, e.weights) : fit;
      return { ...o, degree: e.degree, closed: !!((e.flag ?? 0) & 1), knots: (e.knots ?? []).map((k) => R(k, 6)), ctrl: ctrl.map((q) => PR(q)), ...(e.weights?.length ? { weights: e.weights.map((x) => R(x, 6)) } : {}), ...(fit.length ? { fit: fit.map((q) => PR(q)) } : {}), pts: pts.map((q) => PR(q)) };
    }
    case 'SOLID': case 'TRACE':
      return { ...o, type: 'SOLID', pts: [e.corner1, e.corner2, e.corner3, e.corner4 ?? e.corner3].map((q) => P(q, m)) };
    case 'TEXT': return { ...o, text: e.text ?? '', ...textProps(e, m) };
    case 'MTEXT': {
      const rot = e.direction && (e.direction.x || e.direction.y) ? Math.atan2(e.direction.y, e.direction.x) : e.rotation ?? 0;
      const r = { ...o, text: e.text ?? '', p: P(e.insertionPoint), h: R(e.textHeight ?? 0), rot: R(rot, 6), attach: e.attachmentPoint ?? 1, style: e.styleName ?? 'Standard' };
      if (e.rectWidth) r.width = R(e.rectWidth);
      if (e.lineSpacing && e.lineSpacing !== 1) r.lineSpacing = R(e.lineSpacing);
      return r;
    }
    case 'ATTDEF': {
      const t = e.text ?? {};
      const def = typeof t === 'string' ? t : t.text ?? '';
      return { ...o, tag: e.tag ?? '', prompt: e.prompt ?? '', text: def, invisible: !!((e.flags ?? 0) & 1), ...textProps(typeof t === 'object' ? { ...t, extrusionDirection: t.extrusionDirection } : e, typeof t === 'object' ? mirrored(t) : m) };
    }
    case 'INSERT': {
      const r = { ...o, name: e.name, p: P(e.insertionPoint, m), sx: R(m ? -(e.xScale ?? 1) : e.xScale ?? 1, 6), sy: R(e.yScale ?? 1, 6), rot: R(m ? -(e.rotation ?? 0) : e.rotation ?? 0, 6) };
      if ((e.columnCount ?? 0) > 1 || (e.rowCount ?? 0) > 1) Object.assign(r, { cols: e.columnCount || 1, rows: e.rowCount || 1, colSpacing: R(e.columnSpacing ?? 0), rowSpacing: R(e.rowSpacing ?? 0) });
      const atts = (e.attribs ?? []).map((a) => {
        const t = a.text ?? {};
        const value = typeof t === 'string' ? t : t.text ?? a.value ?? '';
        const tm = typeof t === 'object' ? mirrored(t) : mirrored(a);
        const base = { ...common(a), type: 'ATTRIB', tag: a.tag ?? '', text: value, invisible: !!((a.flags ?? 0) & 1), ...textProps(typeof t === 'object' ? t : a, tm) };
        return base;
      });
      if (atts.length) r.attribs = atts;
      return r;
    }
    case 'DIMENSION':
      return { ...o, block: e.name, dimType: e.dimensionType, measurement: R(e.measurement ?? 0, 6), text: e.text ?? '', style: e.styleName ?? '', textPoint: P(e.textPoint) };
    case 'HATCH': {
      const loops = (e.boundaryPaths ?? []).map((p) => flattenHatchPath(p).map((q) => PR(q, m))).filter((l) => l.length >= 2);
      const r = { ...o, pattern: e.patternName ?? '', solid: !!e.solidFill, loops };
      if (!e.solidFill) {
        r.scale = R(e.patternScale ?? 1, 6);
        r.angle = R(m ? -(e.patternAngle ?? 0) : e.patternAngle ?? 0, 6);
        r.lines = (e.definitionLines ?? []).map((l) => ({ angle: ang(m ? Math.PI - l.angle : l.angle), base: P(l.base, m), offset: P(l.offset, m), dashes: (l.dashLengths ?? []).map((d) => R(d, 6)) }));
      }
      if (e.hatchStyle) r.style = e.hatchStyle;
      return r;
    }
    case 'WIPEOUT': {
      const u = e.uPixel, v = e.vPixel, pos = e.position, H = e.imageSize?.y ?? 1;
      let bp = (e.clippingBoundaryPath ?? []).map((q) => [q.x, q.y]);
      if (e.clippingBoundaryType === 1 && bp.length === 2) bp = [bp[0], [bp[1][0], bp[0][1]], bp[1], [bp[0][0], bp[1][1]]];
      const loop = bp.map(([px, py]) => {
        const sx = px + 0.5, sy = H - (py + 0.5) - (H - 1);
        return PR([pos.x + u.x * sx + v.x * sy, pos.y + u.y * sx + v.y * sy]);
      });
      return { ...o, loop };
    }
    case 'ATTRIB':   // already emitted inside its owning INSERT (attribs[])
    case 'VIEWPORT': stats.ignored[e.type] = (stats.ignored[e.type] ?? 0) + 1; return null;
    default: stats.unsupported[e.type] = (stats.unsupported[e.type] ?? 0) + 1; return null;
  }
}

// ------------------------------------------------------------------ bounding boxes
function bboxOf(entities, blocks, memo, depth = 0) {
  const bb = [Infinity, Infinity, -Infinity, -Infinity];
  const add = (x, y) => { if (!Number.isFinite(x) || !Number.isFinite(y)) return; if (x < bb[0]) bb[0] = x; if (y < bb[1]) bb[1] = y; if (x > bb[2]) bb[2] = x; if (y > bb[3]) bb[3] = y; };
  for (const e of entities) {
    switch (e.type) {
      case 'LINE': add(...e.a); add(...e.b); break;
      case 'POINT': add(...e.p); break;
      case 'CIRCLE': add(e.c[0] - e.r, e.c[1] - e.r); add(e.c[0] + e.r, e.c[1] + e.r); break;
      case 'ARC': {
        let sw = e.a1 - e.a0; while (sw <= 0) sw += TAU;
        const at = (a) => add(e.c[0] + e.r * Math.cos(a), e.c[1] + e.r * Math.sin(a));
        at(e.a0); at(e.a0 + sw);
        for (let k = Math.ceil(e.a0 / (Math.PI / 2)); k * (Math.PI / 2) < e.a0 + sw; k++) at(k * (Math.PI / 2));
        break;
      }
      case 'ELLIPSE': { const L = Math.hypot(...e.major); add(e.c[0] - L, e.c[1] - L); add(e.c[0] + L, e.c[1] + L); break; }
      case 'LWPOLYLINE': case 'SOLID': case 'SPLINE': for (const q of e.pts) add(q[0], q[1]); break;
      case 'HATCH': for (const l of e.loops) for (const q of l) add(q[0], q[1]); break;
      case 'WIPEOUT': for (const q of e.loop) add(q[0], q[1]); break;
      case 'TEXT': case 'ATTDEF': add(...e.p); add(e.p[0] + e.h * Math.max(1, e.text.length) * 0.8 * Math.cos(e.rot), e.p[1] + e.h + e.h * Math.max(1, e.text.length) * 0.8 * Math.sin(e.rot)); break;
      case 'MTEXT': add(...e.p); break;
      case 'INSERT': case 'DIMENSION': {
        const name = e.type === 'INSERT' ? e.name : e.block;
        const b = blocks[name];
        if (!b || depth > 12) break;
        if (!memo.has(name)) { memo.set(name, null); memo.set(name, bboxOf(b.entities, blocks, memo, depth + 1)); }
        const ib = memo.get(name);
        if (!ib) break;
        if (e.type === 'DIMENSION') { add(ib[0], ib[1]); add(ib[2], ib[3]); break; }
        const c = Math.cos(e.rot), s = Math.sin(e.rot);
        const cols = e.cols ?? 1, rows = e.rows ?? 1;
        for (const [x, y] of [[ib[0], ib[1]], [ib[2], ib[1]], [ib[0], ib[3]], [ib[2], ib[3]]]) {
          for (const [ci, ri] of [[0, 0], [cols - 1, rows - 1]]) {
            const lx = (x - b.base[0]) * e.sx + ci * (e.colSpacing ?? 0), ly = (y - b.base[1]) * e.sy + ri * (e.rowSpacing ?? 0);
            add(e.p[0] + lx * c - ly * s, e.p[1] + lx * s + ly * c);
          }
        }
        break;
      }
    }
  }
  return bb[0] === Infinity ? null : bb.map((v) => R(v, 4));
}

// ------------------------------------------------------------------ main
const jsonReplacer = (_k, v) => (typeof v === 'bigint' ? Number(v) : v);

async function walk(dir, rel = '') {
  const out = [];
  for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(dir, r))); else out.push(r);
  }
  return out.sort();
}
const safe = (s) => s.replace(/[\\/:*?"<>|\s]+/g, '_');

export function normalizeDrawing(db, source, version) {
  const stats = { entities: {}, unsupported: {}, ignored: {}, flaggedInvisible: 0 };
  const conv = (list) => {
    const out = [];
    for (const e of list ?? []) {
      if (e.isVisible === false) stats.flaggedInvisible++;
      const n = normalize(e, stats);
      if (n) { out.push(n); stats.entities[n.type] = (stats.entities[n.type] ?? 0) + 1; }
    }
    return out;
  };
  const h = db.header ?? {};
  const blocks = {};
  for (const b of db.tables?.BLOCK_RECORD?.entries ?? []) {
    if (/^\*(model|paper)_space/i.test(b.name)) continue;
    blocks[b.name] = { base: P(b.basePoint), ...(b.description ? { description: b.description } : {}), ...(b.name.startsWith('*') ? { anonymous: true } : {}), entities: conv(b.entities) };
  }
  const modelspace = conv(db.entities);
  const missing = new Set();
  const checkRefs = (list) => { for (const e of list) { const n = e.type === 'INSERT' ? e.name : e.type === 'DIMENSION' ? e.block : null; if (n && !blocks[n]) missing.add(n); } };
  checkRefs(modelspace); for (const b of Object.values(blocks)) checkRefs(b.entities);
  const memo = new Map();
  const ext = (p) => (p && Math.abs(p.x) < 1e19 ? P(p) : null);
  return {
    format: 'yqweb-drawing@1',
    source, version,
    units: h.INSUNITS ?? 0,
    base: P(h.INSBASE ?? { x: 0, y: 0 }),
    headerExtents: ext(h.EXTMIN) && ext(h.EXTMAX) ? [...ext(h.EXTMIN), ...ext(h.EXTMAX)] : null,
    bbox: bboxOf(modelspace, blocks, memo),
    ltscale: h.LTSCALE ?? 1,
    layers: (db.tables?.LAYER?.entries ?? []).map((l) => ({ name: l.name, color: Math.abs(l.colorIndex ?? 7), ...(typeof l.color === 'number' && l.color >= 0 ? { trueColor: '#' + (l.color & 0xffffff).toString(16).padStart(6, '0') } : {}), linetype: l.lineType ?? 'Continuous', lineweight: lineweight(l.lineweight), off: !!l.off || (l.colorIndex ?? 0) < 0, frozen: !!l.frozen, locked: !!l.locked, plot: l.plotFlag !== 0 })),
    linetypes: (db.tables?.LTYPE?.entries ?? []).filter((l) => !/^by(layer|block)$/i.test(l.name)).map((l) => ({ name: l.name, description: l.description ?? '', length: R(l.totalPatternLength ?? 0), pattern: (l.pattern ?? []).map((p) => R(p.elementLength ?? p.length ?? 0, 6)) })),
    styles: (db.tables?.STYLE?.entries ?? []).map((s) => ({ name: s.name, font: s.font ?? '', bigFont: s.bigFont ?? '', height: R(s.fixedTextHeight ?? 0), widthFactor: R(s.widthFactor ?? 1), oblique: R(s.obliqueAngle ?? 0, 6) })),
    blocks,
    entities: modelspace,
    stats: { ...stats, blocks: Object.keys(blocks).length, missingBlocks: [...missing] },
  };
}

async function main() {
  const src = path.resolve(arg('src', '.'));
  const out = path.resolve(arg('out', path.join(HERE, '../../assets/blocks')));
  const only = arg('only');
  const lib = await LibreDwg.create(path.join(HERE, 'node_modules/@mlightcad/libredwg-web/wasm/'));
  const files = (await walk(src)).filter((f) => /\.dwg$/i.test(f) && (!only || f.includes(only)));
  const index = { generator: 'tools/dwg-convert (libredwg-web 0.8.3)', generatedAt: new Date().toISOString(), files: [], failed: [], totals: { entities: {}, unsupported: {}, ignored: {}, flaggedInvisible: 0 } };
  const t0 = Date.now();
  const origLog = console.log, origErr = console.error, origWarn = console.warn; // libredwg prints "Open dwg file with error code: N" for recoverable warnings
  for (const f of files) {
    const buf = await fs.readFile(path.join(src, f));
    const sig = buf.subarray(0, 6).toString('latin1');
    let codeMsg = null;
    try {
      console.log = console.error = console.warn = (...a) => { const s = a.join(' '); const mm = s.match(/error code: (\d+)/); if (mm) codeMsg = Number(mm[1]); else origLog(...a); };
      const dwg = lib.dwg_read_data(buf, Dwg_File_Type.DWG);
      console.log = origLog; console.error = origErr; console.warn = origWarn;
      if (!dwg) throw new Error(`libredwg returned no data (code ${codeMsg})`);
      const db = lib.convert(dwg);
      lib.dwg_free(dwg);
      const drawing = normalizeDrawing(db, f, VERSIONS[sig] ?? sig);
      const outRel = f.replace(/\.dwg$/i, '').split('/').map(safe).join('/') + '.json';
      await fs.mkdir(path.dirname(path.join(out, outRel)), { recursive: true });
      await fs.writeFile(path.join(out, outRel), JSON.stringify(drawing, jsonReplacer));
      const s = drawing.stats;
      const count = Object.values(s.entities).reduce((a, b) => a + b, 0);
      index.files.push({ source: f, file: outRel, version: drawing.version, units: drawing.units, bbox: drawing.bbox, modelspace: drawing.entities.length, entities: count, blocks: s.blocks, readerCode: codeMsg, ...(s.missingBlocks.length ? { missingBlocks: s.missingBlocks } : {}) });
      for (const k of ['entities', 'unsupported', 'ignored']) for (const [t, n] of Object.entries(s[k])) index.totals[k][t] = (index.totals[k][t] ?? 0) + n;
      index.totals.flaggedInvisible += s.flaggedInvisible;
    } catch (e) {
      console.log = origLog; console.error = origErr; console.warn = origWarn;
      index.failed.push({ source: f, error: String(e?.message ?? e), readerCode: codeMsg });
    }
  }
  index.durationMs = Date.now() - t0;
  await fs.writeFile(path.join(out, 'index.json'), JSON.stringify(index, null, 2));
  origLog(`converted ${index.files.length}/${files.length} DWG files in ${index.durationMs}ms, failed ${index.failed.length}`);
  origLog('entities', JSON.stringify(index.totals.entities));
  origLog('unsupported', JSON.stringify(index.totals.unsupported), 'ignored', JSON.stringify(index.totals.ignored), 'flaggedInvisible', index.totals.flaggedInvisible);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e); process.exit(1); });
