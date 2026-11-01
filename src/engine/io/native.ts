/**
 * Native file format "yqweb-drawing@1" (JSON, extension .yqd). It is the same structure Phase 1 produces for converted
 * DWG blocks, plus `settings`/`name`, so converted drawings open directly in the editor. Entity ids are not persisted.
 */
import { CadDocument, defaultLayer } from '../model/document';
import { defaultSettings, type DocSettings } from '../model/settings';
import type { BlockDef, Entity, Layer, LinetypeDef, NewEntity, Pt, TextStyle } from '../types';

export const FORMAT = 'yqweb-drawing@1';
export const GENERATOR = 'yqweb-cad 0.3.0';

export interface DrawingJson {
  format: string;
  generator?: string;
  name?: string;
  source?: string;
  version?: string;
  units?: number;
  base?: Pt;
  bbox?: number[] | null;
  ltscale?: number;
  layers?: Partial<Layer>[];
  linetypes?: LinetypeDef[];
  styles?: Partial<TextStyle>[];
  blocks?: Record<string, { base?: Pt; entities: Record<string, unknown>[]; units?: number; anonymous?: boolean; source?: string }>;
  entities: Record<string, unknown>[];
  settings?: Partial<DocSettings>;
  [k: string]: unknown;
}

const stripId = (e: Entity) => { const { id: _id, ...rest } = e; return rest; };

export function toJSON(doc: CadDocument): DrawingJson {
  const blocks: DrawingJson['blocks'] = {};
  for (const [name, b] of doc.blocks) {
    blocks[name] = { base: b.base, entities: b.entities.map(stripId), ...(b.units ? { units: b.units } : {}), ...(b.anonymous ? { anonymous: true } : {}), ...(b.source ? { source: b.source } : {}) };
  }
  const ext = doc.extents(true);
  return {
    format: FORMAT, generator: GENERATOR, name: doc.name, units: doc.units, base: [0, 0], bbox: ext ? ext.map((v) => +v.toFixed(6)) : null,
    ltscale: doc.settings.ltscale, settings: structuredClone(doc.settings),
    layers: [...doc.layers.values()], linetypes: [...doc.linetypes.values()], styles: [...doc.styles.values()],
    blocks, entities: [...doc.entities.values()].map(stripId),
  };
}

export function serialize(doc: CadDocument, pretty = false): string { return JSON.stringify(toJSON(doc), null, pretty ? 1 : undefined); }

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function normalizeLayer(l: Partial<Layer>): Layer {
  const base = defaultLayer(String(l.name ?? '0'));
  return { ...base, ...l, name: String(l.name ?? '0'), color: Math.abs(num(l.color, 7)) || 7, linetype: l.linetype || 'Continuous', lineweight: num(l.lineweight, -3) } as Layer;
}
export function normalizeStyle(s: Partial<TextStyle>): TextStyle {
  return { name: String(s.name ?? 'Standard'), font: s.font ?? '', bigFont: s.bigFont ?? '', height: num(s.height, 0), widthFactor: num(s.widthFactor, 1) || 1, oblique: num(s.oblique, 0) };
}

/** Assign ids to block entities (ids inside blocks are only used as cache keys). */
export const blockFromJson = (name: string, b: { base?: Pt; entities: Record<string, unknown>[]; units?: number; anonymous?: boolean; source?: string }): BlockDef => ({
  name, base: b.base ?? [0, 0], entities: b.entities.map((e, i) => ({ ...(e as object), id: i + 1 }) as Entity),
  ...(b.units ? { units: b.units } : {}), ...(b.anonymous || name.startsWith('*') ? { anonymous: true } : {}), ...(b.source ? { source: b.source } : {}),
});

/** Load a drawing into a (new or cleared) document. Accepts native files and Phase 1 converted drawings. */
export function fromJSON(json: DrawingJson | string, doc = new CadDocument()): CadDocument {
  const d: DrawingJson = typeof json === 'string' ? JSON.parse(json) : json;
  if (!d || typeof d !== 'object' || !Array.isArray(d.entities)) throw new Error('Not a yqweb drawing (missing entities).');
  if (d.format && d.format !== FORMAT) throw new Error(`Unsupported format "${d.format}".`);
  doc.loadRaw((x) => {
    x.entities.clear(); x.blocks.clear(); x.layers.clear(); x.linetypes.clear();
    x.units = d.units && d.units > 0 ? d.units : 4;
    x.settings = { ...defaultSettings(), ...(d.settings ?? {}), dim: { ...defaultSettings().dim, ...(d.settings?.dim ?? {}) } };
    if (!d.settings && d.ltscale) x.settings.ltscale = d.ltscale;
    if (d.name) x.name = d.name;
    for (const l of d.layers ?? []) { const n = normalizeLayer(l); x.layers.set(n.name.toUpperCase(), n); }
    for (const lt of d.linetypes ?? []) if (lt?.name) x.linetypes.set(lt.name.toUpperCase(), { name: lt.name, description: lt.description, length: lt.length, pattern: lt.pattern ?? [] });
    for (const s of d.styles ?? []) { const n = normalizeStyle(s); if (n.name.toUpperCase() === 'STANDARD' && !n.font) { n.font = 'txt'; n.bigFont = n.bigFont || 'hzdx'; } x.styles.set(n.name.toUpperCase(), n); }
    for (const [name, b] of Object.entries(d.blocks ?? {})) x.blocks.set(name, blockFromJson(name, b));
    for (const e of d.entities) {
      const n = e as NewEntity;
      if (!n || typeof n.type !== 'string') continue;
      if (!n.layer) n.layer = '0';
      if (!x.layers.has(n.layer.toUpperCase())) x.layers.set(n.layer.toUpperCase(), defaultLayer(n.layer));
      x.insertRaw(n);
    }
    if (!x.getLayer(x.settings.currentLayer)) x.settings.currentLayer = '0';
  });
  return doc;
}
