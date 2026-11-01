/** SHX font data (converted in Phase 1 to assets/fonts/*.json) and the font provider used by text layout. */
export interface Glyph { code: number; w: number; p: number[][] }
export interface FontJson { name: string; kind: string; isFont: boolean; above: number; below: number; glyphs: Record<string, Glyph> }
export interface FontProvider {
  /** Returns the font if loaded; may trigger an asynchronous load and return undefined meanwhile. */
  get(name: string): FontJson | undefined;
  /** Bundled font names (upper case keys) -> file stem. */
  available(): string[];
}

/** Bundled fonts that stand in for common AutoCAD SHX fonts that are not shipped with YQArch. */
const MAIN_ALIASES: Record<string, string> = {
  TXT: 'TXT1', SIMPLEX: 'ROMAND', ROMANS: 'ROMAND', ROMANC: 'ROMAND', ISOCP: 'ROMAND', ISOCPEUR: 'ROMAND', GBENOR: 'ROMAND', GBEITC: 'ROMAND',
  TSSDENG: 'ROMAND', MONOTXT: 'TXT1', COMPLEX: 'ROMAND', ITALIC: 'ROMAND', ARCHS: 'ARCHS', HZTXTW: 'SUPEROS',
};
export const DEFAULT_MAIN = 'TXT1';
export const DEFAULT_BIG = 'HZDX';

const stem = (f: string) => f.replace(/^.*[\\/]/, '').replace(/\.(shx|ttf|ttc|otf)$/i, '').toUpperCase();
export const isTrueTypeFont = (f: string) => /\.(ttf|ttc|otf)$/i.test(f);

/** Resolve a style's main font file name to a bundled font key (upper case), or null for TrueType fonts. */
export function resolveMainFont(file: string, available: string[]): string | null {
  if (!file) return DEFAULT_MAIN;
  if (isTrueTypeFont(file)) return null;
  const s = stem(file);
  if (available.includes(s)) return s;
  const a = MAIN_ALIASES[s];
  if (a && available.includes(a)) return a;
  return DEFAULT_MAIN;
}
/** Resolve a big font file name; all Chinese big fonts fall back to the bundled HZDX. */
export function resolveBigFont(file: string, available: string[]): string {
  const s = file ? stem(file) : '';
  if (s && available.includes(s)) return s;
  return DEFAULT_BIG;
}
