/** Bounding boxes of entities (used by the spatial index, zoom extents and culling). */
import type { BBox, BlockDef, Entity, Pt, TextEnt, MTextEnt } from '../types';
import { boxAdd, boxValid, emptyBox } from '../types';
import type { DocSettings } from '../model/settings';
import { apply, insertMatrix, type Mat } from './matrix';
import { bulgeToPrim, primPoints } from './prims';
import { TAU, angleOnArc, normAngle, rotate } from './vec';
import { dimensionGeometry } from '../model/dimension';

export interface ExtentsContext {
  getBlock(name: string): BlockDef | undefined;
  blockBox: Map<string, BBox>;
  /** Exact text box provider (installed by the renderer once fonts are loaded). */
  textBox?: (e: TextEnt | MTextEnt) => BBox | null;
  settings: DocSettings;
  units: number;
}

function arcBox(b: BBox, c: Pt, r: number, a0: number, a1: number, full = false) {
  boxAdd(b, c[0] + r * Math.cos(a0), c[1] + r * Math.sin(a0));
  boxAdd(b, c[0] + r * Math.cos(a1), c[1] + r * Math.sin(a1));
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    if (full || angleOnArc(a, normAngle(a0), normAngle(a1))) boxAdd(b, c[0] + r * Math.cos(a), c[1] + r * Math.sin(a));
  }
}

function estimateTextBox(e: TextEnt | MTextEnt): BBox {
  const b = emptyBox();
  const lines = e.type === 'MTEXT' ? e.text.split(/\\P|\n/) : [e.text];
  const n = Math.max(1, ...lines.map((l) => [...l].length));
  const w = e.type === 'MTEXT' && e.width ? e.width : n * e.h * 0.8;
  const hh = e.h * (1 + (lines.length - 1) * 1.667);
  const p = e.type === 'TEXT' && (e.halign || e.valign) && e.p2 ? e.p2 : e.p;
  for (const [x, y] of [[-w, -hh], [w, -hh], [-w, hh], [w, hh]] as Pt[]) { const q = rotate([p[0] + x, p[1] + y], e.rot, p); boxAdd(b, q[0], q[1]); }
  return b;
}

export function blockBBox(name: string, ctx: ExtentsContext, depth = 0): BBox {
  const cached = ctx.blockBox.get(name);
  if (cached) return cached;
  const def = ctx.getBlock(name);
  const b = emptyBox();
  if (def && depth < 16) {
    ctx.blockBox.set(name, b); // guard against recursion
    for (const e of def.entities) {
      if (e.type === 'ATTDEF') continue;
      const eb = entityBBox(e, ctx, depth + 1);
      if (boxValid(eb)) { boxAdd(b, eb[0], eb[1]); boxAdd(b, eb[2], eb[3]); }
    }
  }
  ctx.blockBox.set(name, b);
  return b;
}

export function entityBBox(e: Entity, ctx: ExtentsContext, depth = 0): BBox {
  const b = emptyBox();
  switch (e.type) {
    case 'LINE': boxAdd(b, e.a[0], e.a[1]); boxAdd(b, e.b[0], e.b[1]); break;
    case 'POINT': boxAdd(b, e.p[0], e.p[1]); break;
    case 'CIRCLE': boxAdd(b, e.c[0] - e.r, e.c[1] - e.r); boxAdd(b, e.c[0] + e.r, e.c[1] + e.r); break;
    case 'ARC': arcBox(b, e.c, e.r, e.a0, e.a1); break;
    case 'ELLIPSE': {
      let sw = e.a1 - e.a0; while (sw <= 0) sw += TAU;
      const mn: Pt = [-e.major[1] * e.ratio, e.major[0] * e.ratio];
      for (let i = 0; i <= 64; i++) { const t = e.a0 + (sw * i) / 64; boxAdd(b, e.c[0] + e.major[0] * Math.cos(t) + mn[0] * Math.sin(t), e.c[1] + e.major[1] * Math.cos(t) + mn[1] * Math.sin(t)); }
      break;
    }
    case 'LWPOLYLINE': {
      const v = e.pts, n = v.length;
      for (let i = 0; i < n; i++) {
        boxAdd(b, v[i][0], v[i][1]);
        if (v[i][2] && (i < n - 1 || e.closed)) {
          const q = bulgeToPrim([v[i][0], v[i][1]], [v[(i + 1) % n][0], v[(i + 1) % n][1]], v[i][2]);
          if (q.k === 'arc') arcBox(b, q.c, q.r, q.a0, q.a1);
        }
      }
      if (e.width) { b[0] -= e.width / 2; b[1] -= e.width / 2; b[2] += e.width / 2; b[3] += e.width / 2; }
      break;
    }
    case 'SPLINE': for (const p of e.pts) boxAdd(b, p[0], p[1]); for (const p of e.ctrl ?? []) boxAdd(b, p[0], p[1]); break;
    case 'SOLID': for (const p of e.pts) boxAdd(b, p[0], p[1]); break;
    case 'TEXT': case 'ATTDEF': case 'ATTRIB': case 'MTEXT': {
      const t = ctx.textBox?.(e) ?? null;
      return t && boxValid(t) ? t : estimateTextBox(e);
    }
    case 'INSERT': {
      const def = ctx.getBlock(e.name);
      if (!def) { boxAdd(b, e.p[0], e.p[1]); break; }
      const bb = blockBBox(e.name, ctx, depth);
      const cols = e.cols ?? 1, rows = e.rows ?? 1;
      if (boxValid(bb)) {
        for (const [ci, ri] of [[0, 0], [cols - 1, 0], [0, rows - 1], [cols - 1, rows - 1]]) {
          const m: Mat = insertMatrix(e.p, e.sx, e.sy, e.rot, def.base, ci * (e.colSpacing ?? 0), ri * (e.rowSpacing ?? 0));
          for (const c of [[bb[0], bb[1]], [bb[2], bb[1]], [bb[0], bb[3]], [bb[2], bb[3]]] as Pt[]) { const q = apply(m, c); boxAdd(b, q[0], q[1]); }
        }
      } else boxAdd(b, e.p[0], e.p[1]);
      for (const a of e.attribs ?? []) { if (a.invisible || !a.text) continue; const ab = estimateTextBox({ ...(a as TextEnt), type: 'TEXT' }); boxAdd(b, ab[0], ab[1]); boxAdd(b, ab[2], ab[3]); }
      break;
    }
    case 'DIMENSION': {
      if (e.block && ctx.getBlock(e.block)) {
        const bb = blockBBox(e.block, ctx, depth);
        if (!boxValid(bb)) break;
        if (!e.xform) return [...bb] as BBox;
        for (const c of [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]] as Pt[]) { const q = apply(e.xform, c); boxAdd(b, q[0], q[1]); }
        break;
      }
      for (const g of dimensionGeometry(e, ctx.settings, ctx.units)) {
        const gb = entityBBox({ ...g, id: -1 } as Entity, ctx, depth + 1);
        if (boxValid(gb)) { boxAdd(b, gb[0], gb[1]); boxAdd(b, gb[2], gb[3]); }
      }
      break;
    }
    case 'HATCH': for (const l of e.loops) for (const p of l) boxAdd(b, p[0], p[1]); break;
    case 'WIPEOUT': for (const p of e.loop) boxAdd(b, p[0], p[1]); break;
  }
  return b;
}

/** Points of an entity outline used by crossing tests when no tessellation is available. */
export function polylinePoints(pts: number[][], closed: boolean, segPerCircle = 96): Pt[] {
  const out: Pt[] = [];
  const n = pts.length;
  if (!n) return out;
  out.push([pts[0][0], pts[0][1]]);
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const q = bulgeToPrim([a[0], a[1]], [b[0], b[1]], a[2] ?? 0);
    if (q.k === 'seg') out.push([b[0], b[1]]);
    else {
      const ps = primPoints(q, segPerCircle);
      // primPoints is CCW; reverse for clockwise bulges so the path stays continuous
      if ((a[2] ?? 0) < 0) ps.reverse();
      out.push(...ps.slice(1, -1), [b[0], b[1]]);
    }
  }
  return out;
}
