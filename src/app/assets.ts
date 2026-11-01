import type { AliasSources, YqCommandMeta } from '../engine/commands/aliases';
import { LinetypeLibrary } from '../engine/render/linetypes';
import { PatternLibrary } from '../engine/render/hatch';
import type { ComplexLinetypeJson } from '../engine/render/linetypes';
import type { PatternDef } from '../engine/render/hatch';
import type { FontJson, FontProvider } from '../engine/render/fonts';

const assetUrl = (path: string) => `${import.meta.env.BASE_URL}assets/${path.replace(/^\//, '')}`;
async function readJson<T>(path: string): Promise<T> {
  const res = await fetch(assetUrl(path));
  if (!res.ok) throw new Error(`تعذر تحميل المورد: ${path}`);
  return res.json() as Promise<T>;
}

export interface LibraryEntry {
  source: string; file: string; version: string; units: number; bbox: number[];
  modelspace: number; entities: number; blocks: number;
}
export interface ThumbnailEntry { id: string; name: string; svg: string; dwg: string; pattern?: string | null }
interface FontIndexEntry { name: string; file: string }
interface CommandCatalog { commands: YqCommandMeta[] }
interface AssetIndexes { blocks: LibraryEntry[]; thumbnails: ThumbnailEntry[] }

class WebFontProvider implements FontProvider {
  private fonts = new Map<string, FontJson>();
  private files = new Map<string, string>();
  private pending = new Set<string>();
  constructor(index: FontIndexEntry[], private onLoad: () => void) {
    for (const item of index) this.files.set(item.name.toUpperCase(), item.file);
  }
  get(name: string): FontJson | undefined {
    const key = name.toUpperCase().replace(/\.(SHX|TTF|TTC|OTF)$/i, '');
    const cached = this.fonts.get(key);
    if (cached) return cached;
    const file = this.files.get(key);
    if (file && !this.pending.has(key)) {
      this.pending.add(key);
      void readJson<FontJson>(file).then((font) => {
        this.fonts.set(key, font);
        this.onLoad();
      }).catch((error) => console.warn(error)).finally(() => this.pending.delete(key));
    }
    return undefined;
  }
  available() { return [...this.files.keys()]; }
}

export interface EditorAssets extends AssetIndexes {
  fonts: FontProvider;
  patterns: PatternLibrary;
  linetypes: LinetypeLibrary;
  aliases: AliasSources;
  profiles: string[];
}

export async function loadEditorAssets(onFontLoad: () => void): Promise<EditorAssets> {
  const [blockIndex, thumbIndex, fontIndex, patternJson, linetypeJson, catalog, pgp, profileConfig] = await Promise.all([
    readJson<{ files: LibraryEntry[] }>('blocks/index.json'),
    readJson<ThumbnailEntry[]>('thumbnails/index.json'),
    readJson<FontIndexEntry[]>('fonts/index.json'),
    readJson<{ patterns: PatternDef[] }>('patterns.json'),
    readJson<{ linetypes: ComplexLinetypeJson[] }>('linetypes.json'),
    readJson<CommandCatalog>('commands.json'),
    readJson<{ data: { aliases: Record<string, string> } }>('profiles/user1/pgp-aliases.json'),
    readJson<{ data: { values?: Record<string, unknown> } }>('profiles/user1/config.json'),
  ]);
  const patterns = new PatternLibrary(); patterns.load(patternJson.patterns);
  const linetypes = new LinetypeLibrary(); linetypes.load(linetypeJson.linetypes);
  const aliases: AliasSources = {
    yqCommands: catalog.commands,
    pgp: pgp.data.aliases,
    overrides: {},
    yqPriority: Boolean(profileConfig.data.values?.YQARCH_SHORTCUT_PRIORITY),
  };
  return {
    fonts: new WebFontProvider(fontIndex, onFontLoad), patterns, linetypes, aliases,
    blocks: blockIndex.files, thumbnails: thumbIndex, profiles: ['user1', 'user2', 'userHBA', 'userCCD'],
  };
}

export async function loadBlockFile(file: string) {
  // `assets/blocks/index.json` stores paths relative to its own directory.
  const relative = file.replace(/^\/+/, '');
  return readJson<import('../engine/io/native').DrawingJson>(`blocks/${relative}`);
}
export const assetPath = assetUrl;
