/**
 * Phase 1 asset pipeline: YQArch source folder -> web-ready assets (JSON + SVG).
 *
 *   npx tsx src/pipeline/convert.ts --src <path to YQArch folder> --out assets
 *
 * DWG blocks are converted separately by tools/dwg-convert (GPL-isolated, see its README).
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { readBinary, readTextFile, walk, writeJson, writeText, exists, safeName } from '../util/io.js';
import { buildCommandCatalog, aliasOverrides, parsePanels, parsePgp } from '../parsers/commands.js';
import { parseConfig } from '../parsers/config.js';
import * as P from '../parsers/profile.js';
import { parsePat, type HatchPattern } from '../parsers/pat.js';
import { parseLin } from '../parsers/lin.js';
import { parseSlide, parseSlideLibrary, slideToSvg, isSlide, type Slide } from '../parsers/sld.js';
import { parseShx, renderShape, shapeChar } from '../parsers/shx.js';

export interface StepReport { step: string; outputs: string[]; counts: Record<string, number>; warnings: string[] }

interface Ctx { src: string; out: string; files: string[]; reports: StepReport[] }

const SKIP_EXT = /\.(exe|dll|bat|vlx|fas|chm|doc|gif|zip|cuix|mnr|bak)$/i;

function argv(name: string, def?: string): string {
  const i = process.argv.lastIndexOf(`--${name}`); // last wins, so `npm run convert -- --src X` overrides the default
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (def !== undefined) return def;
  throw new Error(`missing --${name}`);
}

const rel = (ctx: Ctx, abs: string) => path.relative(ctx.out, abs).split(path.sep).join('/');
const text = async (ctx: Ctx, r: string) => (await readTextFile(path.join(ctx.src, r))).text;

// ------------------------------------------------------------------ commands & panels
async function stepCommands(ctx: Ctx): Promise<StepReport> {
  const rep: StepReport = { step: 'commands', outputs: [], counts: {}, warnings: [] };
  const yqs = ctx.files.find((f) => /^shortcut_.*\.yqs$/i.test(f));
  if (!yqs) { rep.warnings.push('root shortcut_*.yqs not found'); return rep; }
  const refFile = ctx.files.find((f) => f.toLowerCase() === 'yqshortcut.txt');
  const catalog = buildCommandCatalog(await text(ctx, yqs), refFile ? await text(ctx, refFile) : null);
  const out = path.join(ctx.out, 'commands.json');
  await writeJson(out, { source: [yqs, refFile].filter(Boolean), ...catalog });
  rep.outputs.push(rel(ctx, out));
  rep.counts.categories = catalog.categories.length;
  rep.counts.commands = catalog.commands.length;
  rep.counts.withDescription = catalog.commands.filter((c) => c.description).length;
  const missing = catalog.commands.filter((c) => !c.description).map((c) => c.id);
  if (missing.length) rep.warnings.push(`${missing.length} commands have no entry in yqshortcut.txt (e.g. ${missing.slice(0, 5).join(', ')})`);

  const panelFile = ctx.files.find((f) => f.toLowerCase() === 'yqpanel.txt');
  if (panelFile) {
    const panels = parsePanels(await text(ctx, panelFile));
    const po = path.join(ctx.out, 'panels.json');
    await writeJson(po, { source: panelFile, panels });
    rep.outputs.push(rel(ctx, po));
    rep.counts.panels = panels.length;
    rep.counts.panelButtons = panels.reduce((n, p) => n + p.sections.reduce((m, s) => m + s.items.filter((i) => !i.separator).length, 0), 0);
  }
  return rep;
}

// ------------------------------------------------------------------ profiles
const PROFILE_FILES: [string, string, (t: string) => unknown][] = [
  ['config.txt', 'config', parseConfig],
  ['layers.txt', 'layers', P.parseLayers],
  ['relay01.txt', 'layer-relay', P.parseLayerRelay],
  ['styles.txt', 'text-styles', P.parseStyles],
  ['hatching.txt', 'quick-hatch', P.parseQuickHatch],
  ['patterns1.txt', 'pattern-picks-1', P.parsePatternPicks],
  ['patterns2.txt', 'pattern-picks-2', P.parsePatternPicks],
  ['patterns3.txt', 'pattern-picks-3', P.parsePatternPicks],
  ['hatchkey.txt', 'hatch-keys', P.parseHatchKeys],
  ['ltypekey.txt', 'linetype-keys', P.parseLinetypeKeys],
  ['layerkey.txt', 'layer-keys', P.parseLayerKeys],
  ['wlaykey.txt', 'wildcard-layer-keys', P.parseWildcardLayerKeys],
  ['numbers.txt', 'numbers', P.parseNumberRows],
  ['dict.txt', 'dictionary', P.parseDictionary],
  ['dwgtitle.txt', 'drawing-titles', P.parseDictionary],
  ['userpanel.txt', 'user-panels', parsePanels],
  ['acad_.pgp', 'pgp-aliases', parsePgp],
  ['settings.txt', 'command-settings', P.parseCommandSettings],
];

function countOf(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.entries)) return o.entries.length;
    if (o.aliases && typeof o.aliases === 'object') return Object.keys(o.aliases).length;
    return Object.keys(o).length;
  }
  return 0;
}

async function stepProfiles(ctx: Ctx): Promise<StepReport> {
  const rep: StepReport = { step: 'profiles', outputs: [], counts: {}, warnings: [] };
  const roots = [...new Set(ctx.files.filter((f) => /^user[^/]*\/config\.txt$/i.test(f)).map((f) => f.split('/')[0]))];
  const yqs = ctx.files.find((f) => /^shortcut_.*\.yqs$/i.test(f));
  const defaultYqs = yqs ? await text(ctx, yqs) : null;
  const index: { name: string; files: Record<string, string>; counts: Record<string, number> }[] = [];
  for (const name of roots) {
    const entry = { name, files: {} as Record<string, string>, counts: {} as Record<string, number> };
    for (const [file, key, parser] of PROFILE_FILES) {
      const r = ctx.files.find((f) => f.toLowerCase() === `${name}/${file}`.toLowerCase());
      if (!r) continue;
      try {
        const data = parser(await text(ctx, r));
        const out = path.join(ctx.out, 'profiles', name, `${key}.json`);
        await writeJson(out, { source: r, data });
        entry.files[key] = rel(ctx, out);
        entry.counts[key] = countOf(data);
      } catch (e) {
        rep.warnings.push(`${r}: ${(e as Error).message}`);
      }
    }
    const pyqs = ctx.files.find((f) => f.toLowerCase() === `${name}/shortcut.yqs`.toLowerCase());
    if (pyqs && defaultYqs) {
      const ov = aliasOverrides(defaultYqs, await text(ctx, pyqs));
      const out = path.join(ctx.out, 'profiles', name, 'alias-overrides.json');
      await writeJson(out, { source: pyqs, base: yqs, data: ov });
      entry.files['alias-overrides'] = rel(ctx, out);
      entry.counts['alias-overrides'] = Object.keys(ov).length;
    }
    const dwgs = ctx.files.filter((f) => f.startsWith(name + '/') && /\.dwg$/i.test(f));
    if (dwgs.length) entry.counts.dwgTemplates = dwgs.length;
    index.push(entry);
    rep.outputs.push(...Object.values(entry.files));
  }
  await writeJson(path.join(ctx.out, 'profiles', 'index.json'), index);
  rep.outputs.push('profiles/index.json');
  rep.counts.profiles = index.length;
  rep.counts.files = rep.outputs.length - 1;
  return rep;
}

// ------------------------------------------------------------------ hatch patterns & linetypes
async function stepPatterns(ctx: Ctx): Promise<StepReport> {
  const rep: StepReport = { step: 'patterns', outputs: [], counts: {}, warnings: [] };
  const pats = ctx.files.filter((f) => /\.pat$/i.test(f));
  const all: (HatchPattern & { source: string; key: string })[] = [];
  const seen = new Map<string, string>();
  for (const f of pats) {
    const { patterns, warnings } = parsePat(await text(ctx, f));
    rep.warnings.push(...warnings.map((w) => `${f}: ${w}`));
    for (const p of patterns) {
      let key = p.name.toUpperCase();
      if (seen.has(key)) {
        // a single-pattern .pat in library/ overrides nothing; keep both with a qualified key
        key = `${key}@${path.basename(f, path.extname(f))}`;
        rep.counts.duplicates = (rep.counts.duplicates ?? 0) + 1;
      }
      seen.set(key, f);
      all.push({ key, source: f, ...p });
    }
  }
  const out = path.join(ctx.out, 'patterns.json');
  await writeJson(out, { sources: pats, patterns: all }, false);
  rep.outputs.push(rel(ctx, out));
  rep.counts.files = pats.length;
  rep.counts.patterns = all.length;
  rep.counts.lines = all.reduce((n, p) => n + p.lines.length, 0);
  return rep;
}

async function stepLinetypes(ctx: Ctx): Promise<StepReport> {
  const rep: StepReport = { step: 'linetypes', outputs: [], counts: {}, warnings: [] };
  const lins = ctx.files.filter((f) => /\.lin$/i.test(f));
  const all = [];
  for (const f of lins) {
    const { linetypes, warnings } = parseLin(await text(ctx, f));
    rep.warnings.push(...warnings.map((w) => `${f}: ${w}`));
    all.push(...linetypes.map((l) => ({ source: f, ...l })));
  }
  const out = path.join(ctx.out, 'linetypes.json');
  await writeJson(out, { sources: lins, linetypes: all });
  rep.outputs.push(rel(ctx, out));
  rep.counts.linetypes = all.length;
  rep.counts.complex = all.filter((l) => l.elements.some((e) => e.kind !== 'dash')).length;
  return rep;
}

// ------------------------------------------------------------------ slide thumbnails
async function stepThumbnails(ctx: Ctx): Promise<StepReport> {
  const rep: StepReport = { step: 'thumbnails', outputs: [], counts: { sld: 0, slbEntries: 0 }, warnings: [] };
  const index: { id: string; name: string; source: string; svg: string; dwg: string | null; pattern: string | null; segments: number }[] = [];
  const dwgSet = new Map(ctx.files.filter((f) => /\.dwg$/i.test(f)).map((f) => [f.replace(/\.dwg$/i, '').toLowerCase(), f]));
  const patNames = new Set<string>();
  for (const f of ctx.files.filter((f) => /\.pat$/i.test(f))) patNames.add(path.basename(f, path.extname(f)).toUpperCase());

  const emit = async (id: string, name: string, source: string, slide: Slide, dwg: string | null) => {
    const svgRel = `thumbnails/${id}.svg`;
    await writeText(path.join(ctx.out, svgRel), slideToSvg(slide, { background: null, whiteAs: 'currentColor' }));
    const pattern = patNames.has(name.toUpperCase()) ? name : null;
    index.push({ id, name, source, svg: svgRel, dwg, pattern, segments: slide.segments.length });
    if (slide.warnings.length) rep.warnings.push(...slide.warnings.slice(0, 3).map((w) => `${source}${source.endsWith(name) ? '' : '#' + name}: ${w}`));
  };

  for (const f of ctx.files.filter((f) => /\.sld$/i.test(f))) {
    const bytes = await readBinary(path.join(ctx.src, f));
    if (!isSlide(bytes)) { rep.warnings.push(`${f}: not a slide file`); continue; }
    try {
      const id = f.replace(/\.sld$/i, '').split('/').map(safeName).join('/');
      await emit(id, path.basename(f, path.extname(f)), f, parseSlide(bytes), dwgSet.get(f.replace(/\.sld$/i, '').toLowerCase()) ?? null);
      rep.counts.sld++;
    } catch (e) { rep.warnings.push(`${f}: ${(e as Error).message}`); }
  }
  for (const f of ctx.files.filter((f) => /\.slb$/i.test(f))) {
    const { entries, warnings } = parseSlideLibrary(await readBinary(path.join(ctx.src, f)));
    rep.warnings.push(...warnings.map((w) => `${f}: ${w}`));
    const lib = safeName(f.replace(/\.slb$/i, ''));
    for (const e of entries) {
      await emit(`slb/${lib}/${safeName(e.name)}`, e.name, f, e.slide, null);
      rep.counts.slbEntries++;
    }
    rep.counts[`slb:${f}`] = entries.length;
  }
  await writeJson(path.join(ctx.out, 'thumbnails', 'index.json'), index);
  rep.outputs.push('thumbnails/index.json', `thumbnails/**/*.svg (${index.length})`);
  rep.counts.svg = index.length;
  rep.counts.linkedToDwg = index.filter((i) => i.dwg).length;
  rep.counts.linkedToPattern = index.filter((i) => i.pattern).length;
  return rep;
}

// ------------------------------------------------------------------ SHX fonts
async function stepFonts(ctx: Ctx): Promise<StepReport> {
  const rep: StepReport = { step: 'fonts', outputs: [], counts: {}, warnings: [] };
  const index = [];
  for (const f of ctx.files.filter((f) => /\.shx$/i.test(f))) {
    try {
      const font = parseShx(await readBinary(path.join(ctx.src, f)));
      const glyphs: Record<string, { code: number; name?: string; w: number; h?: number; p: number[][] }> = {};
      let empty = 0;
      for (const n of [...font.shapes.keys()].sort((a, b) => a - b)) {
        const g = renderShape(font, n);
        if (!g) continue;
        const ch = shapeChar(font, n);
        const key = ch ?? (font.isFont ? `#${n}` : font.shapes.get(n)!.name || `#${n}`);
        if (!g.paths.length) empty++;
        glyphs[key] = { code: n, ...(font.isFont ? {} : { name: font.shapes.get(n)!.name }), w: g.advance[0], ...(g.advance[1] ? { h: g.advance[1] } : {}), p: g.paths };
      }
      const base = path.basename(f, path.extname(f));
      const outRel = `fonts/${safeName(base)}.json`;
      const meta = {
        name: base, source: f, kind: font.kind, signature: font.signature, notice: font.fontName,
        isFont: font.isFont, above: font.above, below: font.below, mode: font.mode,
        encoding: font.kind === 'bigfont' ? 'gbk' : font.kind === 'unifont' ? 'unicode' : 'ascii',
        escapeRanges: font.escapeRanges, glyphCount: Object.keys(glyphs).length, emptyGlyphs: empty,
      };
      await writeJson(path.join(ctx.out, outRel), { ...meta, glyphs }, false);
      index.push({ ...meta, file: outRel });
      rep.outputs.push(outRel);
      const uniqueWarn = [...new Set(font.warnings)];
      if (uniqueWarn.length) rep.warnings.push(`${f}: ${uniqueWarn.length} renderer notes (e.g. ${uniqueWarn[0]})`);
    } catch (e) { rep.warnings.push(`${f}: ${(e as Error).message}`); }
  }
  await writeJson(path.join(ctx.out, 'fonts', 'index.json'), index);
  rep.outputs.push('fonts/index.json');
  rep.counts.fonts = index.length;
  rep.counts.glyphs = index.reduce((n, i) => n + i.glyphCount, 0);
  return rep;
}

// ------------------------------------------------------------------ manifest & report
async function writeManifest(ctx: Ctx, started: number) {
  const exts: Record<string, number> = {};
  for (const f of ctx.files) { const e = path.extname(f).toLowerCase() || '(none)'; exts[e] = (exts[e] ?? 0) + 1; }
  const skipped = ctx.files.filter((f) => SKIP_EXT.test(f));
  const blocksIndex = path.join(ctx.out, 'blocks', 'index.json');
  const blocks = (await exists(blocksIndex)) ? JSON.parse(await fs.readFile(blocksIndex, 'utf8')) : null;
  const manifest = {
    generator: 'yqweb-cad phase1 pipeline',
    generatedAt: new Date().toISOString(),
    source: { path: path.basename(ctx.src), files: ctx.files.length, byExtension: exts },
    steps: ctx.reports.map((r) => ({ step: r.step, counts: r.counts, outputs: r.outputs, warnings: r.warnings.length })),
    blocks: blocks ? { files: blocks.files?.length ?? 0, failed: blocks.failed?.length ?? 0, generatedBy: 'tools/dwg-convert' } : null,
    excludedBinaries: skipped,
    durationMs: Date.now() - started,
  };
  await writeJson(path.join(ctx.out, 'manifest.json'), manifest);

  const md: string[] = ['# Phase 1 conversion report', '', `Generated: ${manifest.generatedAt}  `, `Source files scanned: ${ctx.files.length}`, ''];
  for (const r of ctx.reports) {
    md.push(`## ${r.step}`, '', '| metric | value |', '|---|---|');
    for (const [k, v] of Object.entries(r.counts)) md.push(`| ${k} | ${v} |`);
    md.push('');
    if (r.warnings.length) {
      md.push(`<details><summary>${r.warnings.length} warnings</summary>`, '', ...r.warnings.slice(0, 200).map((w) => `- ${w}`), r.warnings.length > 200 ? `- … ${r.warnings.length - 200} more` : '', '</details>', '');
    }
  }
  if (blocks) {
    md.push('## blocks (DWG)', '', `Converted files: ${blocks.files?.length ?? 0}, failed: ${blocks.failed?.length ?? 0} — see blocks/index.json`, '');
  } else md.push('## blocks (DWG)', '', 'Not converted yet — run `npm run convert:dwg`.', '');
  md.push('## Excluded binaries (not converted, not shipped)', '', ...skipped.map((s) => `- ${s}`), '');
  await writeText(path.join(ctx.out, 'report.md'), md.join('\n'));
}

export async function runPipeline(src: string, out: string) {
  const started = Date.now();
  const files = (await walk(src)).filter((f) => !f.startsWith('.git'));
  const ctx: Ctx = { src, out, files, reports: [] };
  // clean everything this pipeline owns (blocks/ belongs to tools/dwg-convert and is kept)
  for (const owned of ['commands.json', 'panels.json', 'patterns.json', 'linetypes.json', 'manifest.json', 'report.md', 'profiles', 'thumbnails', 'fonts']) {
    await fs.rm(path.join(out, owned), { recursive: true, force: true });
  }
  for (const step of [stepCommands, stepProfiles, stepPatterns, stepLinetypes, stepThumbnails, stepFonts]) {
    const t = Date.now();
    const r = await step(ctx);
    ctx.reports.push(r);
    console.log(`✔ ${r.step.padEnd(11)} ${JSON.stringify(r.counts)}  warnings=${r.warnings.length}  ${Date.now() - t}ms`);
  }
  await writeManifest(ctx, started);
  console.log(`manifest.json + report.md written to ${out} in ${Date.now() - started}ms`);
  return ctx.reports;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('pipeline', 'convert.ts'));
if (isMain) {
  runPipeline(path.resolve(argv('src')), path.resolve(argv('out', 'assets'))).catch((e) => { console.error(e); process.exit(1); });
}
