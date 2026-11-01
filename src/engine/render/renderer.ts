/**
 * Canvas2D renderer. Entities are tessellated once (cached per entity object + document render epoch), culled with
 * their bounding boxes, transformed to screen space, and stroked in colour batches. Overlays: selection highlight,
 * hover, command previews, grips, snap markers, tracking lines, selection windows, grid and crosshair.
 */
import type { CadDocument } from '../model/document';
import type { BBox, Entity, Pt } from '../types';
import { boxIntersects } from '../types';
import { mmul, type Mat } from '../geom/matrix';
import type { Viewport } from './view';
import { tessellate, textBBox, type DrawItem, type TessContext } from './tessellate';
import type { SnapKind } from '../snap/osnap';

export interface Theme { bg: string; fg: string; grid: string; gridMajor: string; select: string; hover: string; snap: string; grip: string; gripHot: string; crosshair: string; track: string }
export const DARK: Theme = { bg: '#1e2228', fg: '#ffffff', grid: '#2a2f37', gridMajor: '#343a44', select: '#5aa9ff', hover: '#9fd0ff', snap: '#ffd000', grip: '#2f7dff', gripHot: '#ff3b3b', crosshair: '#c8ccd2', track: '#7fdc7f' };
export const LIGHT: Theme = { bg: '#ffffff', fg: '#000000', grid: '#eef0f3', gridMajor: '#dde1e6', select: '#1f6fe0', hover: '#4f8ff0', snap: '#d48a00', grip: '#1f6fe0', gripHot: '#e02020', crosshair: '#555b63', track: '#1a9a1a' };

export interface Overlay {
  selection?: Set<number>;
  hover?: number | null;
  preview?: Entity[];
  grips?: { p: Pt; hot?: boolean }[];
  snap?: { p: Pt; kind: SnapKind } | null;
  tracking?: { from: Pt; angle: number } | null;
  rubber?: { a: Pt; b: Pt; crossing: boolean } | null;
  /** Fence (open) or polygon selection path being drawn; `crossing` picks the green dashed style. */
  rubberPath?: { pts: Pt[]; closed: boolean; crossing: boolean } | null;
  /** Cursor in screen pixels. */
  cursor?: Pt | null;
  pickbox?: number;
  showPickbox?: boolean;
  grid?: { on: boolean; spacing: number };
  lineweights?: boolean;
  label?: string | null;
}

export class CanvasRenderer {
  private cache = new WeakMap<Entity, { epoch: number; items: DrawItem[] }>();
  theme: Theme = DARK;
  constructor(public tc: TessContext) {
    tc.fg = this.theme.fg; tc.bg = this.theme.bg;
    tc.doc.textBox = (e) => textBBox(e, this.tc);
  }
  get doc(): CadDocument { return this.tc.doc; }
  setDocument(doc: CadDocument) { this.tc.doc = doc; doc.textBox = (e) => textBBox(e, this.tc); this.cache = new WeakMap(); }
  setTheme(t: Theme) { this.theme = t; this.tc.fg = t.fg; this.tc.bg = t.bg; this.cache = new WeakMap(); }
  itemsFor(e: Entity): DrawItem[] {
    const c = this.cache.get(e);
    if (c && c.epoch === this.doc.renderEpoch) return c.items;
    const items = tessellate(e, this.tc);
    this.cache.set(e, { epoch: this.doc.renderEpoch, items });
    return items;
  }

  render(ctx: CanvasRenderingContext2D, view: Viewport, ov: Overlay = {}) {
    const t = this.theme, W = view.width, H = view.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = t.bg; ctx.fillRect(0, 0, W, H);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (ov.grid?.on) this.drawGrid(ctx, view, ov.grid.spacing);
    const vb = view.visibleBox(2);
    const doc = this.doc;
    const m = view.matrix();
    const batch = new Batch(ctx, m);
    for (const e of doc.entities.values()) {
      const b = doc.cachedBox(e.id);
      if (!b || !boxIntersects(b, vb) || !doc.isVisible(e)) continue;
      if ((b[2] - b[0]) * view.scale < 0.8 && (b[3] - b[1]) * view.scale < 0.8) { batch.dot(this.colorHint(e), (b[0] + b[2]) / 2, (b[1] + b[3]) / 2); continue; }
      batch.items(this.itemsFor(e), ov.lineweights);
    }
    batch.flush();
    // selection highlight (dashed) and hover
    if (ov.selection?.size) {
      ctx.setLineDash([6, 4]);
      const hb = new Batch(ctx, m, 2, t.select);
      for (const id of ov.selection) { const e = doc.get(id); if (e && doc.isVisible(e)) hb.items(this.itemsFor(e), false, true); }
      hb.flush(); ctx.setLineDash([]);
    }
    if (ov.hover != null && !ov.selection?.has(ov.hover)) {
      const e = doc.get(ov.hover);
      if (e) { const hb = new Batch(ctx, m, 2.5, t.hover); hb.items(this.itemsFor(e), false, true); hb.flush(); }
    }
    if (ov.preview?.length) {
      const pb = new Batch(ctx, m);
      for (const e of ov.preview) pb.items(tessellate(e, this.tc), false);
      pb.flush();
    }
    this.drawOverlays(ctx, view, ov);
  }

  private colorHint(e: Entity): string {
    const items = this.itemsFor(e);
    return items[0]?.color ?? this.theme.fg;
  }

  private drawGrid(ctx: CanvasRenderingContext2D, view: Viewport, spacing: number) {
    let g = spacing > 0 ? spacing : 100;
    while (g * view.scale < 10) g *= 5;
    const vb = view.visibleBox();
    const x0 = Math.floor(vb[0] / g), x1 = Math.ceil(vb[2] / g), y0 = Math.floor(vb[1] / g), y1 = Math.ceil(vb[3] / g);
    if ((x1 - x0) * (y1 - y0) > 40000) return;
    for (const major of [false, true]) {
      ctx.strokeStyle = major ? this.theme.gridMajor : this.theme.grid; ctx.lineWidth = 1; ctx.beginPath();
      for (let i = x0; i <= x1; i++) { if ((i % 10 === 0) !== major) continue; const s = Math.round(view.toScreen([i * g, 0])[0]) + 0.5; ctx.moveTo(s, 0); ctx.lineTo(s, view.height); }
      for (let j = y0; j <= y1; j++) { if ((j % 10 === 0) !== major) continue; const s = Math.round(view.toScreen([0, j * g])[1]) + 0.5; ctx.moveTo(0, s); ctx.lineTo(view.width, s); }
      ctx.stroke();
    }
  }

  private drawOverlays(ctx: CanvasRenderingContext2D, view: Viewport, ov: Overlay) {
    const t = this.theme;
    if (ov.rubber) {
      const a = view.toScreen(ov.rubber.a), b = view.toScreen(ov.rubber.b);
      const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]), w = Math.abs(a[0] - b[0]), h = Math.abs(a[1] - b[1]);
      ctx.fillStyle = ov.rubber.crossing ? 'rgba(60,200,90,0.15)' : 'rgba(60,120,255,0.15)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = ov.rubber.crossing ? '#4cd964' : '#4a8cff'; ctx.lineWidth = 1;
      ctx.setLineDash(ov.rubber.crossing ? [5, 4] : []); ctx.strokeRect(x + 0.5, y + 0.5, w, h); ctx.setLineDash([]);
    }
    if (ov.rubberPath && ov.rubberPath.pts.length >= 2) {
      const rp = ov.rubberPath, sp = rp.pts.map((q) => view.toScreen(q));
      const col = rp.closed ? (rp.crossing ? '#4cd964' : '#4a8cff') : '#ffd23f';
      ctx.beginPath(); ctx.moveTo(sp[0][0], sp[0][1]);
      for (let i = 1; i < sp.length; i++) ctx.lineTo(sp[i][0], sp[i][1]);
      if (rp.closed && sp.length >= 3) { ctx.closePath(); ctx.fillStyle = rp.crossing ? 'rgba(60,200,90,0.15)' : 'rgba(60,120,255,0.15)'; ctx.fill(); }
      ctx.strokeStyle = col; ctx.lineWidth = 1.25; ctx.setLineDash(rp.closed && !rp.crossing ? [] : [6, 4]); ctx.stroke(); ctx.setLineDash([]);
    }
    for (const g of ov.grips ?? []) {
      const s = view.toScreen(g.p);
      ctx.fillStyle = g.hot ? t.gripHot : t.grip; ctx.fillRect(Math.round(s[0]) - 4, Math.round(s[1]) - 4, 9, 9);
      ctx.strokeStyle = t.bg; ctx.lineWidth = 1; ctx.strokeRect(Math.round(s[0]) - 4.5, Math.round(s[1]) - 4.5, 10, 10);
    }
    if (ov.tracking) {
      const a = view.toScreen(ov.tracking.from);
      const far = 4 * Math.max(view.width, view.height);
      const b: Pt = [a[0] + Math.cos(ov.tracking.angle) * far, a[1] - Math.sin(ov.tracking.angle) * far];
      ctx.strokeStyle = t.track; ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); ctx.setLineDash([]);
    }
    if (ov.snap && ov.snap.kind !== 'grid') drawSnapMarker(ctx, view.toScreen(ov.snap.p), ov.snap.kind, t.snap);
    if (ov.cursor) {
      const [cx, cy] = ov.cursor.map((v) => Math.round(v) + 0.5);
      ctx.strokeStyle = t.crosshair; ctx.lineWidth = 1; ctx.globalAlpha = 0.85;
      ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(view.width, cy); ctx.moveTo(cx, 0); ctx.lineTo(cx, view.height); ctx.stroke();
      if (ov.showPickbox) { const pb = ov.pickbox ?? 5; ctx.strokeRect(cx - pb, cy - pb, pb * 2, pb * 2); }
      ctx.globalAlpha = 1;
      if (ov.label) {
        ctx.font = '12px system-ui, sans-serif';
        const w = ctx.measureText(ov.label).width + 10;
        ctx.fillStyle = 'rgba(20,24,30,0.85)'; ctx.fillRect(cx + 14, cy + 14, w, 20);
        ctx.fillStyle = '#ffe680'; ctx.fillText(ov.label, cx + 19, cy + 28);
      }
    }
  }
}

export function drawSnapMarker(ctx: CanvasRenderingContext2D, s: Pt, kind: SnapKind, color: string) {
  const r = 6, [x, y] = s;
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
  switch (kind) {
    case 'end': ctx.rect(x - r, y - r, 2 * r, 2 * r); break;
    case 'mid': ctx.moveTo(x, y - r); ctx.lineTo(x + r, y + r); ctx.lineTo(x - r, y + r); ctx.closePath(); break;
    case 'cen': ctx.arc(x, y, r, 0, Math.PI * 2); break;
    case 'int': ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); break;
    case 'per': ctx.moveTo(x - r, y - r); ctx.lineTo(x - r, y + r); ctx.lineTo(x + r, y + r); ctx.moveTo(x - r, y); ctx.lineTo(x, y); ctx.lineTo(x, y + r); break;
    case 'qua': ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); break;
    case 'nea': ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y - r); ctx.lineTo(x - r, y + r); ctx.lineTo(x + r, y + r); ctx.closePath(); break;
    case 'node': ctx.arc(x, y, r, 0, Math.PI * 2); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); break;
    case 'ins': ctx.rect(x - r, y - r, r, r); ctx.rect(x, y, r, r); break;
    default: ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r);
  }
  ctx.stroke();
}

/** Collects screen-space strokes per colour and flushes them in as few canvas calls as possible. */
class Batch {
  private paths = new Map<string, Path2D>();
  constructor(private ctx: CanvasRenderingContext2D, private m: Mat, private width = 1, private override?: string) {}
  dot(color: string, x: number, y: number) {
    const sx = this.m[0] * x + this.m[4], sy = this.m[3] * y + this.m[5];
    this.path(color).rect(sx, sy, 0.5, 0.5);
  }
  private path(color: string) { let p = this.paths.get(color); if (!p) { p = new Path2D(); this.paths.set(color, p); } return p; }
  items(items: DrawItem[], lineweights = false, outlineOnly = false) {
    const m = this.m, ctx = this.ctx;
    for (const it of items) {
      const color = this.override ?? it.color;
      if (it.kind === 'stroke') {
        const wpx = it.width ? it.width * m[0] : 0;
        const lwpx = lineweights && it.lw && it.lw > 0 ? Math.max(1, (it.lw / 100) * (96 / 25.4)) : 0;
        if (wpx > 1.5 || lwpx > 1.5) {
          this.flush();
          ctx.strokeStyle = color; ctx.lineWidth = Math.max(wpx, lwpx, this.width);
          ctx.beginPath(); for (let i = 0; i < it.paths.length; i++) addPath(ctx, it.paths[i], m, it.closed?.[i]); ctx.stroke();
          continue;
        }
        const p = this.path(color);
        for (let i = 0; i < it.paths.length; i++) addPath(p, it.paths[i], m, it.closed?.[i]);
      } else if (it.kind === 'fill') {
        if (outlineOnly) { const p = this.path(color); for (const l of it.loops) addPath(p, l, m, true); continue; }
        this.flush();
        ctx.fillStyle = color; ctx.beginPath();
        for (const l of it.loops) addPath(ctx, l, m, true);
        ctx.fill('evenodd');
      } else if (it.kind === 'text') {
        this.flush();
        const tm = mmul(m, it.m);
        const px = it.h * Math.hypot(tm[2], tm[3]);
        if (px < 2) continue;
        ctx.save();
        // x column relative to the text height keeps width factor and non-uniform stretching of the browser-font fallback
        const sy = Math.hypot(tm[2], tm[3]);
        ctx.setTransform(tm[0] / sy, tm[1] / sy, -tm[2] / sy, -tm[3] / sy, tm[4], tm[5]);
        ctx.fillStyle = color; ctx.font = `${px}px ${it.family}, "Noto Sans Arabic", "Noto Sans SC", sans-serif`;
        ctx.textBaseline = 'alphabetic'; ctx.direction = 'inherit';
        ctx.fillText(it.text, 0, 0);
        ctx.restore();
      }
    }
  }
  flush() {
    const ctx = this.ctx;
    ctx.lineWidth = this.width;
    for (const [color, p] of this.paths) { ctx.strokeStyle = color; ctx.stroke(p); }
    this.paths.clear();
  }
}

interface PathLike { moveTo(x: number, y: number): void; lineTo(x: number, y: number): void; closePath(): void }
function addPath(p: PathLike, f: number[], m: Mat, closed?: boolean) {
  if (f.length < 2) return;
  let lx = m[0] * f[0] + m[2] * f[1] + m[4], ly = m[1] * f[0] + m[3] * f[1] + m[5];
  p.moveTo(lx, ly);
  if (f.length === 2 || (f.length === 4 && f[0] === f[2] && f[1] === f[3])) { p.lineTo(lx + 0.01, ly); return; }
  const n = f.length;
  for (let i = 2; i < n; i += 2) {
    const x = m[0] * f[i] + m[2] * f[i + 1] + m[4], y = m[1] * f[i] + m[3] * f[i + 1] + m[5];
    if (i < n - 2 && Math.abs(x - lx) < 0.4 && Math.abs(y - ly) < 0.4) continue; // skip sub-pixel steps
    p.lineTo(x, y); lx = x; ly = y;
  }
  if (closed) p.closePath();
}

export type { BBox };
