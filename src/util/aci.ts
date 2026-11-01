/**
 * AutoCAD Color Index (ACI) palette, generated algorithmically.
 * 0 = ByBlock, 256 = ByLayer (not real colors; mapped to 0x000000 / 0xffffff placeholders).
 * 1..9 fixed colors, 10..249 = 24 hues x (5 brightness levels x full/half saturation), 250..255 grays.
 */
const FIXED: Record<number, number> = {
  0: 0x000000, 1: 0xff0000, 2: 0xffff00, 3: 0x00ff00, 4: 0x00ffff,
  5: 0x0000ff, 6: 0xff00ff, 7: 0xffffff, 8: 0x808080, 9: 0xc0c0c0,
};
const GRAYS = [0x333333, 0x505050, 0x696969, 0x828282, 0xbebebe, 0xffffff];
const LEVELS = [1, 0.65, 0.5, 0.3, 0.15];

function hsv(h: number, s: number, v: number): number {
  const c = v * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = v - c;
  const f = (n: number) => Math.floor((n + m) * 255 + 1e-9);
  return (f(r) << 16) | (f(g) << 8) | f(b);
}

export const ACI_PALETTE: number[] = Array.from({ length: 256 }, (_, i) => {
  if (i in FIXED) return FIXED[i];
  if (i >= 250) return GRAYS[i - 250];
  const hue = (Math.floor(i / 10) - 1) * 15;
  const k = i % 10;
  const v = LEVELS[Math.floor(k / 2)];
  const s = k % 2 === 0 ? 1 : 0.5;
  return hsv(hue, s, v);
});

export function aciToHex(index: number, fallback = '#ffffff'): string {
  if (index <= 0 || index >= 256) return fallback;
  return '#' + ACI_PALETTE[index].toString(16).padStart(6, '0');
}
