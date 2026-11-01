// Robustness: 400 random polylines (with bulges) through OFFSET/TRIM/EXTEND/BREAK/JOIN/FILLET/CHAMFER.
// Every result must be free of NaN/Infinity and no call may throw.
import { describe, it, expect } from 'vitest';
import { offsetCurve, trimByPicks, extendByPick, breakEntity, joinEntities } from '../src/engine/geom/modify';
import { fillet, chamfer, filletPolyline } from '../src/engine/geom/corner';

describe('3B geometry fuzz', () => {
  it('4800 random operations stay finite and never throw', () => {
let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const fin = (x: any): boolean => x === null || x === undefined || typeof x === 'boolean' || typeof x === 'string' ? true : typeof x === 'number' ? Number.isFinite(x) : Array.isArray(x) ? x.every(fin) : Object.values(x).every(fin);
let bad = 0, errs = 0, n = 0;
for (let k = 0; k < 400; k++) {
  const m = 3 + Math.floor(rnd() * 6);
  const pts = Array.from({ length: m }, () => [rnd() * 100, rnd() * 100, rnd() < 0.3 ? (rnd() - 0.5) * 1.5 : 0]);
  const closed = rnd() < 0.5;
  const pl: any = { id: 1, type: 'LWPOLYLINE', layer: '0', pts, closed };
  const ln: any = { id: 2, type: 'LINE', layer: '0', a: [rnd() * 100, rnd() * 100], b: [rnd() * 100, rnd() * 100] };
  const cc: any = { id: 3, type: 'CIRCLE', layer: '0', c: [rnd() * 100, rnd() * 100], r: 5 + rnd() * 30 };
  try {
    for (const d of [-7, -2, 3, 11]) { const r = offsetCurve(pl, d); n++; if (!fin(r)) bad++; }
    const p: [number, number] = [pts[0][0], pts[0][1]];
    for (const r of [trimByPicks(pl, [p], [ln, cc]), trimByPicks(cc, [[cc.c[0] + cc.r, cc.c[1]]], [pl, ln]), extendByPick(ln, ln.b, [pl, cc]), breakEntity(pl, p, [pts[1][0], pts[1][1]]), joinEntities([pl, ln]), fillet({ ent: ln, p: ln.a }, { ent: cc, p: cc.c }, 2), chamfer({ ent: ln, p: ln.a }, { ent: { ...ln, id: 5, a: [0, 0], b: [100, 30] }, p: [50, 15] }, { method: 'distance', d1: 1, d2: 2 }), filletPolyline(pl, 3)]) { n++; if (!fin(r)) bad++; }
  } catch (e) { errs++;  }
}
expect({ n, bad, errs }).toEqual({ n: 4800, bad: 0, errs: 0 });
  });
});
