export type Vec2 = [number, number];

export const round = (n: number, d = 4) => {
  const f = 10 ** d;
  const r = Math.round(n * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

/** Points along a circular arc (angles in radians, ccw from a0 to a1 when ccw=true). */
export function arcPoints(cx: number, cy: number, r: number, a0: number, a1: number, ccw = true, segPerCircle = 64): Vec2[] {
  let sweep = a1 - a0;
  if (ccw) { while (sweep <= 0) sweep += Math.PI * 2; }
  else { while (sweep >= 0) sweep -= Math.PI * 2; }
  const n = Math.max(2, Math.ceil((Math.abs(sweep) / (Math.PI * 2)) * segPerCircle));
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/** Tessellate a bulge segment p0->p1 (bulge = tan(theta/4), positive = ccw). Excludes p0, includes p1. */
export function bulgePoints(p0: Vec2, p1: Vec2, bulge: number, segPerCircle = 64): Vec2[] {
  if (Math.abs(bulge) < 1e-9) return [p1];
  const theta = 4 * Math.atan(bulge);
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-12) return [p1];
  const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
  const mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2;
  const h = Math.sqrt(Math.max(0, r * r - (chord / 2) ** 2));
  const sgn = (bulge > 0 ? 1 : -1) * (Math.abs(theta) > Math.PI ? -1 : 1);
  const cx = mx - (sgn * h * dy) / chord;
  const cy = my + (sgn * h * dx) / chord;
  const a0 = Math.atan2(p0[1] - cy, p0[0] - cx);
  const a1 = a0 + theta;
  const pts = arcPoints(cx, cy, r, a0, a1, bulge > 0, segPerCircle);
  pts.shift();
  pts[pts.length - 1] = p1;
  return pts;
}
