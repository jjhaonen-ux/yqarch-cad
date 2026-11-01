/**
 * Render a converted drawing to SVG:
 *   npx tsx src/preview/cli.ts assets/blocks/<file>.json out.svg [--block NAME] [--fonts assets/fonts] [--bg #000000]
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { drawingToSvg } from './drawing-svg.js';
import type { Drawing, FontJson } from './types.js';

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const [input, output] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!input || !output) { console.error('usage: preview <drawing.json> <out.svg> [--block NAME] [--fonts DIR] [--bg COLOR]'); process.exit(1); }

const fontDir = opt('fonts') ?? path.join(path.dirname(input).split(path.sep).includes('blocks') ? input.slice(0, input.indexOf('blocks')) : 'assets', 'fonts');
const fonts: Record<string, FontJson> = {};
try {
  for (const f of await fs.readdir(fontDir)) if (f.endsWith('.json') && f !== 'index.json') fonts[f.replace(/\.json$/, '').toUpperCase()] = JSON.parse(await fs.readFile(path.join(fontDir, f), 'utf8'));
} catch { /* fonts optional */ }
// common AutoCAD names that YQArch styles reference but are not shipped: fall back to closest shipped fonts
const alias: Record<string, string> = { TXT: 'TXT1', SIMPLEX: 'SUPEROS', ROMANS: 'SUPEROS', TSSDENG: 'SUPEROS', GBENOR: 'SUPEROS', GBCBIG: 'HZDX', HZTXT: 'HZDX', TSSDCHN: 'HZDX' };
for (const [k, v] of Object.entries(alias)) if (!fonts[k] && fonts[v]) fonts[k] = fonts[v];

const d: Drawing = JSON.parse(await fs.readFile(input, 'utf8'));
const svg = drawingToSvg(d, { fonts, block: opt('block'), background: opt('bg') ?? '#000000' });
await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
await fs.writeFile(output, svg);
console.log(`wrote ${output} (${svg.length} bytes)`);
