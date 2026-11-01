/**
 * Minimal SVG renderer for normalized drawings — used to spot-check converted DWG blocks and as a
 * reference for the Phase 2 canvas renderer. Linetype dashes are not applied (all lines continuous).
 */
import { aciToHex } from '../util/aci.js';
import { bulgePoints } from '../util/geom.js';
import type { Drawing, Entity, FontJson, Pt, TextLike } from './types.js';

type M = [number, number, number, number, number, number]; // affine a b c d e f  (x' = a x + c y + e, y' = b x + d y + f)
const I: M = [1, 0, 0, 1, 0, 0];
const mul = (m: M, n: M): M => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const ap = (m: M, x: number, y: number): Pt => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const T = (x: number, y: number): M => [1, 0, 0, 1, x, y];
const S = (sx: number, sy: number): M => [sx, 0, 0, sy, 0, 0];
const Rm = (a: number): M => [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];

export interface SvgOptions { fonts?: Record<string, FontJson>; background?: string; width?: number; block?: string; maxHatchLines?: number }

export function drawingToSvg(d: Drawing, opts: SvgOptions = {}): string {
  const layers = new Map(d.layers.map((l) => [l.name, l]));
  const styles = new Map(d.styles.map((s) => [s.name.toUpperCase(), s]));
  const fonts = opts.fonts ?? {};
  const findFont = (name: string) => fonts[name.replace(/\.shx$/i, '').toUpperCase()];
  const out: string[] = [];
  const bb = [Infinity, Infinity, -Infinity, -Infinity];
  const grow = (p: Pt) => { if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return; bb[0] = Math.min(bb[0], p[0]); bb[1] = Math.min(bb[1], p[1]); bb[2] = Math.max(bb[2], p[0]); bb[3] = Math.max(bb[3], p[1]); };

  const colorOf = (e: { layer: string; color?: number; trueColor?: string }, byBlock: string): string => {
    if (e.trueColor) return e.trueColor;
    const c = e.color ?? 256;
    if (c === 0) return byBlock;
    if (c === 256) { const l = layers.get(e.layer); return l?.trueColor ?? aciToHex(l?.color ?? 7); }
    return aciToHex(c);
  };
  const visible = (e: Entity) => { const l = layers.get(e.layer); return !(l && (l.off || l.frozen)); };
  let growing = true; // hatch pattern lines are clipped, so they must not enlarge the view box
  const poly = (pts: Pt[], m: M, stroke: string, closed = false, fill?: string) => {
    if (pts.length < 2) return;
    const w = pts.map((p) => ap(m, p[0], p[1]));
    if (growing) w.forEach(grow);
    out.push(`<path d="M${w.map((p) => `${p[0].toFixed(3)} ${(-p[1]).toFixed(3)}`).join('L')}${closed ? 'Z' : ''}" stroke="${fill ? 'none' : stroke}"${fill ? ` fill="${fill}" fill-rule="evenodd"` : ''}/>`);
  };
  const arc = (c: Pt, r: number, a0: number, a1: number) => {
    let sw = a1 - a0; while (sw <= 0) sw += Math.PI * 2;
    const n = Math.max(8, Math.ceil(sw / (Math.PI / 32)));
    return Array.from({ length: n + 1 }, (_, i) => [c[0] + r * Math.cos(a0 + (sw * i) / n), c[1] + r * Math.sin(a0 + (sw * i) / n)] as Pt);
  };

  const text = (t: TextLike, m: M, stroke: string) => {
    if (t.invisible || !t.text) return;
    const st = styles.get(t.style.toUpperCase());
    const main = st ? findFont(st.font || 'txt') : undefined;
    const big = (st?.bigFont ? findFont(st.bigFont) : undefined) ?? findFont('HZDX'); // HZDX = bundled Chinese big font
    const raw = t.text.replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±').replace(/%%[cC]/g, '⌀').replace(/%%[uUoO]/g, '').replace(/\\P/g, ' ');
    const wf = t.widthFactor ?? st?.widthFactor ?? 1;
    // measure
    const glyphs: { g: { w: number; p: number[][] } | null; f: FontJson | undefined }[] = [];
    let width = 0;
    for (const ch of raw) {
      const f = ch.charCodeAt(0) < 128 ? main : big ?? main;
      const g = f?.glyphs[ch] ?? null;
      const s = f ? t.h / (f.above || 1) : 0;
      glyphs.push({ g, f });
      width += g ? g.w * s * wf : t.h * 0.7 * wf;
    }
    let ox = 0, oy = 0;
    const ha = t.halign ?? 0, va = t.valign ?? 0;
    let anchor = t.p;
    if ((ha || va) && t.p2) anchor = t.p2;
    if (ha === 1 || ha === 4) ox = -width / 2; else if (ha === 2) ox = -width;
    if (ha === 3 || ha === 5) { anchor = t.p; } // aligned/fit: start at first point
    if (va === 1) oy = 0; else if (va === 2 || ha === 4) oy = -t.h / 2; else if (va === 3) oy = -t.h;
    const base = mul(m, mul(T(anchor[0], anchor[1]), mul(Rm(t.rot), mul(S(t.mirrored ? -1 : 1, 1), T(ox, oy)))));
    let x = 0;
    for (const { g, f } of glyphs) {
      const s = f ? t.h / (f.above || 1) : 0;
      if (g && f) {
        const gm = mul(base, mul(T(x, 0), S(s * wf, s)));
        for (const p of g.p) { const pts: Pt[] = []; for (let i = 0; i < p.length; i += 2) pts.push([p[i], p[i + 1]]); poly(pts, gm, stroke); }
        x += g.w * s * wf;
      } else x += t.h * 0.7 * wf;
    }
    if (!main) { // no SHX available: placeholder underline so text position is still visible
      poly([[0, 0], [width, 0]], base, stroke);
    }
  };

  const hatchLines = (e: Extract<Entity, { type: 'HATCH' }>, m: M, stroke: string) => {
    const max = opts.maxHatchLines ?? 4000;
    const xs = e.loops.flat();
    if (!xs.length || !e.lines?.length) return;
    const bx = [Math.min(...xs.map((p) => p[0])), Math.min(...xs.map((p) => p[1])), Math.max(...xs.map((p) => p[0])), Math.max(...xs.map((p) => p[1]))];
    const id = `h${out.length}`;
    const clip = e.loops.map((l) => `M${l.map((p) => ap(m, p[0], p[1])).map((p) => `${p[0].toFixed(3)} ${(-p[1]).toFixed(3)}`).join('L')}Z`).join('');
    e.loops.flat().forEach((p) => grow(ap(m, p[0], p[1])));
    out.push(`<clipPath id="${id}"><path d="${clip}" clip-rule="evenodd"/></clipPath><g clip-path="url(#${id})">`);
    growing = false;
    let count = 0;
    const diag = Math.hypot(bx[2] - bx[0], bx[3] - bx[1]);
    for (const l of e.lines) {
      const dir: Pt = [Math.cos(l.angle), Math.sin(l.angle)];
      const nrm: Pt = [-dir[1], dir[0]];
      const spacing = l.offset[0] * nrm[0] + l.offset[1] * nrm[1];
      const shift = l.offset[0] * dir[0] + l.offset[1] * dir[1];
      if (Math.abs(spacing) < 1e-9) continue;
      const corners: Pt[] = [[bx[0], bx[1]], [bx[2], bx[1]], [bx[0], bx[3]], [bx[2], bx[3]]];
      const ds = corners.map((c) => ((c[0] - l.base[0]) * nrm[0] + (c[1] - l.base[1]) * nrm[1]) / spacing);
      const k0 = Math.floor(Math.min(...ds)), k1 = Math.ceil(Math.max(...ds));
      for (let k = k0; k <= k1 && count < max; k++, count++) {
        const o: Pt = [l.base[0] + l.offset[0] * k, l.base[1] + l.offset[1] * k];
        const cx = (bx[0] + bx[2]) / 2, cy = (bx[1] + bx[3]) / 2;
        const tc = (cx - o[0]) * dir[0] + (cy - o[1]) * dir[1];
        const pattern = l.dashes.reduce((a, b) => a + Math.abs(b), 0);
        if (!l.dashes.length || pattern < 1e-9) { poly([[o[0] + dir[0] * (tc - diag), o[1] + dir[1] * (tc - diag)], [o[0] + dir[0] * (tc + diag), o[1] + dir[1] * (tc + diag)]], m, stroke); continue; }
        let t = Math.floor((tc - diag - shift * k) / pattern) * pattern + shift * k;
        const end = tc + diag;
        let guard = 0;
        while (t < end && guard++ < 2000) {
          for (const dsh of l.dashes) {
            const len = Math.abs(dsh) || 0;
            if (dsh > 0) poly([[o[0] + dir[0] * t, o[1] + dir[1] * t], [o[0] + dir[0] * (t + len), o[1] + dir[1] * (t + len)]], m, stroke);
            else if (dsh === 0) poly([[o[0] + dir[0] * t, o[1] + dir[1] * t], [o[0] + dir[0] * (t + diag * 1e-4), o[1] + dir[1] * (t + diag * 1e-4)]], m, stroke);
            t += len;
          }
        }
      }
    }
    growing = true;
    out.push('</g>');
  };

  const draw = (list: Entity[], m: M, byBlock: string, depth: number) => {
    if (depth > 16) return;
    for (const e of list) {
      if (!visible(e)) continue;
      const col = colorOf(e, byBlock);
      switch (e.type) {
        case 'LINE': poly([e.a, e.b], m, col); break;
        case 'POINT': poly([e.p, [e.p[0] + 1e-3, e.p[1]]], m, col); break;
        case 'CIRCLE': poly(arc(e.c, e.r, 0, Math.PI * 2), m, col, true); break;
        case 'ARC': poly(arc(e.c, e.r, e.a0, e.a1), m, col); break;
        case 'ELLIPSE': {
          let sw = e.a1 - e.a0; while (sw <= 0) sw += Math.PI * 2;
          const n = Math.max(16, Math.ceil(sw / (Math.PI / 32)));
          const mn: Pt = [-e.major[1] * e.ratio, e.major[0] * e.ratio];
          poly(Array.from({ length: n + 1 }, (_, i) => { const t = e.a0 + (sw * i) / n; return [e.c[0] + e.major[0] * Math.cos(t) + mn[0] * Math.sin(t), e.c[1] + e.major[1] * Math.cos(t) + mn[1] * Math.sin(t)] as Pt; }), m, col);
          break;
        }
        case 'LWPOLYLINE': {
          const pts: Pt[] = [];
          const v = e.pts;
          if (!v.length) break;
          pts.push([v[0][0], v[0][1]]);
          const n = v.length;
          for (let i = 0; i < (e.closed ? n : n - 1); i++) {
            const a = v[i], b = v[(i + 1) % n];
            if (a[2]) pts.push(...bulgePoints([a[0], a[1]], [b[0], b[1]], a[2], 64).slice(1));
            else pts.push([b[0], b[1]]);
          }
          if (e.width && e.width > 0) out.push(`<g stroke-width="${(e.width * Math.hypot(m[0], m[1])).toFixed(3)}" vector-effect="none">`);
          poly(pts, m, col, e.closed);
          if (e.width && e.width > 0) out.push('</g>');
          break;
        }
        case 'SPLINE': poly(e.pts, m, col, e.closed); break;
        case 'SOLID': poly([e.pts[0], e.pts[1], e.pts[3], e.pts[2]], m, col, true, col); break;
        case 'TEXT': case 'ATTDEF': case 'ATTRIB': text(e, m, col); break;
        case 'MTEXT': {
          const plain = e.text.replace(/\\[A-Za-z][^;\\]*;/g, '').replace(/[{}]/g, '').replace(/\\P/g, ' ');
          const ha = [0, 0, 1, 2, 0, 1, 2, 0, 1, 2][e.attach] ?? 0, va = [0, 3, 3, 3, 2, 2, 2, 0, 0, 0][e.attach] ?? 0;
          text({ ...e, type: 'TEXT', text: plain, halign: ha, valign: va, p2: e.p }, m, col);
          break;
        }
        case 'INSERT': {
          const b = d.blocks[e.name];
          if (!b) break;
          const cols = e.cols ?? 1, rows = e.rows ?? 1;
          for (let ci = 0; ci < cols; ci++) for (let ri = 0; ri < rows; ri++) {
            const im = mul(m, mul(T(e.p[0], e.p[1]), mul(Rm(e.rot), mul(T(ci * (e.colSpacing ?? 0), ri * (e.rowSpacing ?? 0)), mul(S(e.sx, e.sy), T(-b.base[0], -b.base[1]))))));
            draw(b.entities.filter((x) => x.type !== 'ATTDEF'), im, col, depth + 1);
          }
          for (const a of e.attribs ?? []) text(a, m, colorOf(a, col));
          break;
        }
        case 'DIMENSION': { const b = d.blocks[e.block]; if (b) draw(b.entities, m, col, depth + 1); break; }
        case 'HATCH':
          if (e.solid) { const loops = e.loops.map((l) => l.map((p) => ap(m, p[0], p[1]))); loops.flat().forEach(grow); out.push(`<path d="${loops.map((l) => `M${l.map((p) => `${p[0].toFixed(3)} ${(-p[1]).toFixed(3)}`).join('L')}Z`).join('')}" fill="${col}" fill-rule="evenodd" stroke="none"/>`); }
          else hatchLines(e, m, col);
          break;
        case 'WIPEOUT': poly(e.loop, m, col, true, opts.background ?? '#000'); break;
      }
    }
  };

  const list = opts.block ? d.blocks[opts.block]?.entities ?? [] : d.entities;
  draw(list, I, '#ffffff', 0);
  if (bb[0] === Infinity) { bb[0] = 0; bb[1] = 0; bb[2] = 1; bb[3] = 1; }
  const pad = Math.max(bb[2] - bb[0], bb[3] - bb[1]) * 0.03 || 1;
  const vb = [bb[0] - pad, -bb[3] - pad, bb[2] - bb[0] + 2 * pad, bb[3] - bb[1] + 2 * pad];
  const W = opts.width ?? 800;
  const H = Math.round((W * vb[3]) / vb[2]);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${vb.map((v) => v.toFixed(3)).join(' ')}" fill="none" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">` +
    `<style>path{vector-effect:non-scaling-stroke}</style>` +
    (opts.background ? `<rect x="${vb[0]}" y="${vb[1]}" width="${vb[2]}" height="${vb[3]}" fill="${opts.background}"/>` : '') +
    out.join('') + '</svg>\n';
}
