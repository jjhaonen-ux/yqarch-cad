/**
 * Importing blocks from converted library drawings (assets/blocks/**.json) into a document: missing layers, linetypes,
 * text styles and nested block definitions are added; anonymous blocks are renamed to avoid clashes; existing named
 * definitions in the document win (AutoCAD behaviour).
 */
import type { CadDocument } from '../model/document';
import type { BlockDef, Entity } from '../types';
import { blockFromJson, normalizeLayer, normalizeStyle, type DrawingJson } from './native';

/** Named, user-facing blocks of a library drawing (excludes anonymous/system blocks). */
export function listLibraryBlocks(file: DrawingJson): string[] {
  return Object.keys(file.blocks ?? {}).filter((n) => !n.startsWith('*') && !n.startsWith('_') && !/^A\$C/i.test(n)).sort((a, b) => a.localeCompare(b));
}

let anonCounter = 0;

/**
 * Make `blockName` (a block of `file`) available in `doc`, or — when `blockName` is omitted — define the whole file's
 * model space as a block called `asName`. Returns the name of the block definition to insert.
 */
export function importLibraryBlock(doc: CadDocument, file: DrawingJson, blockName: string | null, asName?: string): string {
  const fileUnits = file.units && file.units > 0 ? file.units : 4; // YQArch libraries are drawn in millimetres
  for (const l of file.layers ?? []) if (l.name && !doc.getLayer(l.name)) doc.setLayer({ ...normalizeLayer(l), locked: false, off: false, frozen: false });
  for (const lt of file.linetypes ?? []) if (lt?.name && !doc.getLinetype(lt.name) && lt.pattern?.length) doc.setLinetype({ name: lt.name, description: lt.description, length: lt.length, pattern: lt.pattern });
  for (const s of file.styles ?? []) if (s.name && !doc.styles.has(s.name.toUpperCase())) doc.setStyle(normalizeStyle(s));
  const rename = new Map<string, string>();
  const defs = file.blocks ?? {};
  const visit = (name: string, stack: Set<string>): string => {
    if (rename.has(name)) return rename.get(name)!;
    const src = defs[name];
    if (!src) return name;
    if (!name.startsWith('*') && doc.getBlock(name)) { rename.set(name, doc.getBlock(name)!.name); return doc.getBlock(name)!.name; }
    const target = name.startsWith('*') ? `${name}~L${++anonCounter}` : name;
    rename.set(name, target);
    if (stack.has(name)) return target;
    stack.add(name);
    const def = blockFromJson(target, src);
    def.entities = def.entities.map((e) => remap(e, (n) => visit(n, stack)));
    if (!def.units) def.units = fileUnits;
    doc.setBlock(def);
    stack.delete(name);
    return target;
  };
  if (blockName) return visit(blockName, new Set());
  const name = asName ?? file.name ?? 'BLOCK';
  if (doc.getBlock(name)) return doc.getBlock(name)!.name;
  const def: BlockDef = blockFromJson(name, { base: file.base ?? [0, 0], entities: file.entities });
  def.entities = def.entities.map((e) => remap(e, (n) => visit(n, new Set())));
  def.units = fileUnits;
  def.source = file.source;
  doc.setBlock(def);
  return name;
}

function remap(e: Entity, f: (n: string) => string): Entity {
  if (e.type === 'INSERT') return { ...e, name: f(e.name) };
  if (e.type === 'DIMENSION' && e.block) return { ...e, block: f(e.block) };
  return e;
}
