/** World <-> screen mapping (Y up in world, Y down on screen), zoom and pan. */
import type { BBox, Pt } from '../types';
import type { Mat } from '../geom/matrix';

export interface ViewState { cx: number; cy: number; scale: number }
export class Viewport {
  cx = 0; cy = 0;
  /** Pixels per drawing unit. */
  scale = 0.2;
  width = 800; height = 600;
  private history: ViewState[] = [];

  resize(w: number, h: number) { this.width = Math.max(1, w); this.height = Math.max(1, h); }
  toScreen(p: Pt): Pt { return [(p[0] - this.cx) * this.scale + this.width / 2, this.height / 2 - (p[1] - this.cy) * this.scale]; }
  toWorld(sx: number, sy: number): Pt { return [(sx - this.width / 2) / this.scale + this.cx, (this.height / 2 - sy) / this.scale + this.cy]; }
  matrix(): Mat { const s = this.scale; return [s, 0, 0, -s, this.width / 2 - this.cx * s, this.height / 2 + this.cy * s]; }
  visibleBox(margin = 0): BBox {
    const a = this.toWorld(-margin, this.height + margin), b = this.toWorld(this.width + margin, -margin);
    return [a[0], a[1], b[0], b[1]];
  }
  /** Distance in world units of n pixels. */
  px(n: number) { return n / this.scale; }
  state(): ViewState { return { cx: this.cx, cy: this.cy, scale: this.scale }; }
  pushHistory() { this.history.push(this.state()); if (this.history.length > 50) this.history.shift(); }
  previous(): boolean { const s = this.history.pop(); if (!s) return false; this.cx = s.cx; this.cy = s.cy; this.scale = s.scale; return true; }
  zoomAt(sx: number, sy: number, factor: number) {
    const before = this.toWorld(sx, sy);
    this.scale = Math.min(1e7, Math.max(1e-7, this.scale * factor));
    const after = this.toWorld(sx, sy);
    this.cx += before[0] - after[0]; this.cy += before[1] - after[1];
  }
  pan(dxPx: number, dyPx: number) { this.cx -= dxPx / this.scale; this.cy += dyPx / this.scale; }
  fit(b: BBox, margin = 0.06) {
    const w = Math.max(b[2] - b[0], 1e-6), h = Math.max(b[3] - b[1], 1e-6);
    this.cx = (b[0] + b[2]) / 2; this.cy = (b[1] + b[3]) / 2;
    this.scale = Math.min(this.width / (w * (1 + 2 * margin)), this.height / (h * (1 + 2 * margin)));
    if (!Number.isFinite(this.scale) || this.scale <= 0) this.scale = 1;
  }
}
