/**
 * Integration test against the real YQArch folder. Set YQARCH_SRC or keep the repo next to this project
 * (../Jdjdjehfjthgfh). Skipped automatically when the source is not available.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runPipeline } from '../src/pipeline/convert.js';

const SRC = process.env.YQARCH_SRC ?? path.resolve(__dirname, '../../Jdjdjehfjthgfh');
const has = existsSync(path.join(SRC, 'yqshortcut.txt'));

describe.skipIf(!has)('full pipeline on the YQArch source', () => {
  it('extracts every asset family', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'yqweb-'));
    const reports = await runPipeline(SRC, out);
    const by = Object.fromEntries(reports.map((r) => [r.step, r]));
    expect(by.commands.counts).toMatchObject({ categories: 22, commands: 477 });
    expect(by.profiles.counts.profiles).toBe(4);
    expect(by.patterns.counts.files).toBe(23);
    expect(by.linetypes.counts.linetypes).toBe(42);
    expect(by.thumbnails.counts.svg).toBe(772);
    expect(by.fonts.counts.fonts).toBe(13);
    const manifest = JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    expect(manifest.excludedBinaries.some((f: string) => f.endsWith('.vlx'))).toBe(true);
  }, 60_000);
});
