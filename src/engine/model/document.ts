/**
 * The CAD document: layers, linetypes, text styles, block definitions and model-space entities,
 * with a spatial index (rbush) and a command-pattern undo/redo history.
 * Every mutation goes through a method here so it is recorded as an invertible operation.
 */
import RBush from 'rbush';
import type { BBox, BlockDef, Entity, HatchLine, Layer, LinetypeDef, NewEntity, Pt, TextStyle } from '../types';
import type { FontProvider } from '../render/fonts';
import { boxValid, emptyBox, boxUnion } from '../types';
import { defaultSettings, type DocSettings } from './settings';
import { entityBBox, type ExtentsContext } from '../geom/extents';

export type Op =
  | { k: 'add'; e: Entity }
  | { k: 'del'; e: Entity; index: number }
  | { k: 'mod'; before: Entity; after: Entity }
  | { k: 'layer'; key: string; before: Layer | null; after: Layer | null }
  | { k: 'block'; name: string; before: BlockDef | null; after: BlockDef | null }
  | { k: 'ltype'; key: string; before: LinetypeDef | null; after: LinetypeDef | null }
  | { k: 'style'; key: string; before: TextStyle | null; after: TextStyle | null }
  | { k: 'settings'; before: DocSettings; after: DocSettings }
  | { k: 'units'; before: number; after: number };

export interface UndoGroup { label: string; ops: Op[] }
export type ChangeKind = 'entities' | 'layers' | 'blocks' | 'settings' | 'styles' | 'all';
interface IndexItem { minX: number; minY: number; maxX: number; maxY: number; id: number }

/** Maximum number of undo groups kept in memory. */
export const MAX_UNDO = 500;

export const defaultLayer = (name: string, color = 7): Layer => ({ name, color, linetype: 'Continuous', lineweight: -3, off: false, frozen: false, locked: false, plot: true });

export class CadDocument {
  name = 'Drawing1';
  units = 4;
  settings: DocSettings = defaultSettings();
  layers = new Map<string, Layer>();
  linetypes = new Map<string, LinetypeDef>();
  styles = new Map<string, TextStyle>();
  blocks = new Map<string, BlockDef>();
  entities = new Map<number, Entity>();
  /** Bumped on every change (UI subscriptions). */
  version = 0;
  /** Bumped when cached tessellation may be stale for all entities (layer colours, linetypes, ltscale, fonts, blocks). */
  renderEpoch = 0;
  /** Exact text box provider installed by the renderer once SHX fonts are available. */
  textBox?: ExtentsContext['textBox'];
  /** Pattern-line lookup (scale, angle in degrees, origin) installed by the app once hatch patterns are loaded. */
  patternLines?: (name: string, scale: number, angleDeg: number, origin: Pt) => HatchLine[] | undefined;
  /** SHX fonts installed by the app (used by EXPLODE of word-wrapped MTEXT). */
  fonts?: FontProvider;

  private index = new RBush<IndexItem>();
  private items = new Map<number, IndexItem>();
  private nextId = 1;
  private undoStack: UndoGroup[] = [];
  private redoStack: UndoGroup[] = [];
  private group: UndoGroup | null = null;
  private groupDepth = 0;
  private recording = true;
  private listeners = new Set<(k: ChangeKind) => void>();
  private blockBoxCache = new Map<string, BBox>();
  dirty = false;

  constructor() {
    this.layers.set('0', defaultLayer('0'));
    this.styles.set('STANDARD', { name: 'Standard', font: 'txt', bigFont: 'hzdx', height: 0, widthFactor: 0.7, oblique: 0 });
  }

  // ---------------- events ----------------
  onChange(cb: (k: ChangeKind) => void): () => void { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  private emit(k: ChangeKind) {
    this.version++;
    if (k !== 'entities') { this.renderEpoch++; this.blockBoxCache.clear(); }
    if (k === 'settings' || k === 'styles') this.reindex();
    if (this.recording) this.dirty = true;
    for (const l of this.listeners) l(k);
  }
  /** Invalidate render caches (e.g. after fonts load or the theme changes). */
  invalidate(reindex = false) {
    this.renderEpoch++; this.blockBoxCache.clear();
    if (reindex) this.reindex();
    this.version++;
    for (const l of this.listeners) l('all');
  }

  // ---------------- lookups ----------------
  getLayer(name: string): Layer | undefined { return this.layers.get(name.toUpperCase()); }
  getBlock(name: string): BlockDef | undefined {
    const b = this.blocks.get(name);
    if (b) return b;
    const up = name.toUpperCase();
    for (const [k, v] of this.blocks) if (k.toUpperCase() === up) return v;
    return undefined;
  }
  getStyle(name: string): TextStyle | undefined { return this.styles.get((name || 'STANDARD').toUpperCase()) ?? this.styles.get('STANDARD'); }
  getLinetype(name: string): LinetypeDef | undefined { return this.linetypes.get(name.toUpperCase()); }
  get(id: number) { return this.entities.get(id); }
  get size() { return this.entities.size; }
  /** Effective layer of an entity (undefined if missing). */
  layerOf(e: { layer: string }) { return this.getLayer(e.layer); }
  isVisible(e: { layer: string }) { const l = this.getLayer(e.layer); return !l || (!l.off && !l.frozen); }
  isLocked(e: { layer: string }) { return !!this.getLayer(e.layer)?.locked; }

  extentsContext(): ExtentsContext {
    return { getBlock: (n) => this.getBlock(n), blockBox: this.blockBoxCache, textBox: this.textBox, settings: this.settings, units: this.units };
  }
  bboxOf(e: Entity): BBox { return entityBBox(e, this.extentsContext()); }
  /** Extents of visible model-space entities (or null for an empty drawing). */
  extents(includeHidden = false): BBox | null {
    let b = emptyBox();
    for (const e of this.entities.values()) {
      if (!includeHidden && !this.isVisible(e)) continue;
      const it = this.items.get(e.id);
      if (it) b = boxUnion(b, [it.minX, it.minY, it.maxX, it.maxY]);
    }
    return boxValid(b) ? b : null;
  }
  /** Entity ids whose bounding boxes intersect the box. */
  query(b: BBox): number[] { return this.index.search({ minX: b[0], minY: b[1], maxX: b[2], maxY: b[3] }).map((i) => i.id); }
  cachedBox(id: number): BBox | null { const it = this.items.get(id); return it ? [it.minX, it.minY, it.maxX, it.maxY] : null; }

  private indexAdd(e: Entity) {
    const b = this.bboxOf(e);
    if (!boxValid(b)) return;
    const it = { minX: b[0], minY: b[1], maxX: b[2], maxY: b[3], id: e.id };
    this.items.set(e.id, it); this.index.insert(it);
  }
  private indexRemove(id: number) { const it = this.items.get(id); if (it) { this.index.remove(it); this.items.delete(id); } }
  reindex() {
    this.index.clear(); this.items.clear(); this.blockBoxCache.clear();
    const all: IndexItem[] = [];
    for (const e of this.entities.values()) {
      const b = this.bboxOf(e);
      if (!boxValid(b)) continue;
      const it = { minX: b[0], minY: b[1], maxX: b[2], maxY: b[3], id: e.id };
      this.items.set(e.id, it); all.push(it);
    }
    this.index.load(all);
  }

  // ---------------- history ----------------
  beginGroup(label: string) { if (this.groupDepth++ === 0) this.group = { label, ops: [] }; }
  endGroup() {
    if (this.groupDepth === 0) return;
    if (--this.groupDepth === 0 && this.group) {
      if (this.group.ops.length) { this.pushUndo(this.group); this.redoStack = []; }
      this.group = null;
    }
  }
  get inGroup() { return this.groupDepth > 0; }
  /** Push onto the undo stack, keeping at most MAX_UNDO groups. */
  private pushUndo(g: UndoGroup) { this.undoStack.push(g); if (this.undoStack.length > MAX_UNDO) this.undoStack.shift(); }
  /** Ops recorded so far in the open group (used by commands that undo their own last step, e.g. LINE → U). */
  groupOps(): Op[] { return this.group?.ops ?? []; }
  private record(op: Op) {
    if (!this.recording) return;
    if (this.group) this.group.ops.push(op);
    else { this.pushUndo({ label: op.k, ops: [op] }); this.redoStack = []; }
  }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  undoLabel() { return this.undoStack[this.undoStack.length - 1]?.label; }
  redoLabel() { return this.redoStack[this.redoStack.length - 1]?.label; }
  undo(): string | null {
    if (this.groupDepth) this.endGroupForce();
    const g = this.undoStack.pop();
    if (!g) return null;
    this.withoutRecording(() => { for (let i = g.ops.length - 1; i >= 0; i--) this.applyOp(g.ops[i], true); });
    this.redoStack.push(g);
    this.dirty = true; // the drawing no longer matches what was last saved
    return g.label;
  }
  redo(): string | null {
    const g = this.redoStack.pop();
    if (!g) return null;
    this.withoutRecording(() => { for (const op of g.ops) this.applyOp(op, false); });
    this.pushUndo(g);
    this.dirty = true;
    return g.label;
  }
  /** Undo the last `n` ops of the open group (without touching the redo stack). */
  rollbackGroupOps(n: number) {
    if (!this.group) return;
    const ops = this.group.ops.splice(this.group.ops.length - n, n);
    this.withoutRecording(() => { for (let i = ops.length - 1; i >= 0; i--) this.applyOp(ops[i], true); });
  }
  private endGroupForce() { this.groupDepth = 1; this.endGroup(); }
  clearHistory() { this.undoStack = []; this.redoStack = []; this.group = null; this.groupDepth = 0; }
  withoutRecording<T>(fn: () => T): T { const r = this.recording; this.recording = false; try { return fn(); } finally { this.recording = r; } }

  private applyOp(op: Op, inverse: boolean) {
    switch (op.k) {
      case 'add': inverse ? this.rawRemove(op.e.id) : this.rawInsert(op.e); break;
      case 'del': inverse ? this.rawInsert(op.e, op.index) : this.rawRemove(op.e.id); break;
      case 'mod': this.rawReplace(inverse ? op.before : op.after); break;
      case 'layer': this.rawSet(this.layers, op.key, inverse ? op.before : op.after, 'layers'); break;
      case 'block': this.rawSet(this.blocks, op.name, inverse ? op.before : op.after, 'blocks'); break;
      case 'ltype': this.rawSet(this.linetypes, op.key, inverse ? op.before : op.after, 'styles'); break;
      case 'style': this.rawSet(this.styles, op.key, inverse ? op.before : op.after, 'styles'); break;
      case 'settings': this.settings = structuredClone(inverse ? op.before : op.after); this.emit('settings'); break;
      case 'units': this.units = inverse ? op.before : op.after; this.emit('settings'); break;
    }
  }
  private rawSet<T>(map: Map<string, T>, key: string, v: T | null, kind: ChangeKind) {
    if (v) map.set(key, v); else map.delete(key);
    if (kind === 'blocks') this.reindex();
    this.emit(kind);
  }
  private rawInsert(e: Entity, index?: number) {
    if (index !== undefined && index < this.entities.size) {
      // restore draw order: rebuild map with e at position `index`
      const arr = [...this.entities.values()];
      arr.splice(index, 0, e);
      this.entities = new Map(arr.map((x) => [x.id, x]));
    } else this.entities.set(e.id, e);
    if (e.id >= this.nextId) this.nextId = e.id + 1;
    this.indexAdd(e);
    this.emit('entities');
  }
  private rawRemove(id: number) { this.entities.delete(id); this.indexRemove(id); this.emit('entities'); }
  private rawReplace(e: Entity) {
    this.entities.set(e.id, e); // Map.set on an existing key keeps the insertion order
    this.indexRemove(e.id); this.indexAdd(e);
    this.emit('entities');
  }

  // ---------------- mutations (recorded) ----------------
  /** Add an entity; missing layer defaults to the current layer, unknown layers are created. */
  add(n: NewEntity): Entity {
    const e = { ...n, id: this.nextId++ } as Entity;
    if (!e.layer) e.layer = this.settings.currentLayer;
    this.ensureLayer(e.layer);
    this.rawInsert(e);
    this.record({ k: 'add', e });
    return e;
  }
  /** Apply current layer/color/linetype properties to a new entity and add it. */
  addWithCurrent(n: NewEntity): Entity {
    const s = this.settings;
    const e = { ...n } as NewEntity;
    if (!e.layer) e.layer = s.currentLayer;
    if (e.color === undefined && s.currentColor !== 256) e.color = s.currentColor;
    if (e.linetype === undefined && s.currentLinetype.toUpperCase() !== 'BYLAYER') e.linetype = s.currentLinetype;
    if (e.ltScale === undefined && s.currentLtScale !== 1) e.ltScale = s.currentLtScale;
    return this.add(e);
  }
  remove(id: number) {
    const e = this.entities.get(id);
    if (!e) return;
    let index = 0;
    for (const k of this.entities.keys()) { if (k === id) break; index++; }
    this.rawRemove(id);
    this.record({ k: 'del', e, index });
  }
  /** Replace an entity with a modified copy (`patch` may be an object or a function returning the new entity). */
  update(id: number, patch: Partial<Entity> | ((e: Entity) => Entity)): Entity | undefined {
    const before = this.entities.get(id);
    if (!before) return undefined;
    const after = (typeof patch === 'function' ? patch(structuredClone(before)) : { ...before, ...patch }) as Entity;
    after.id = id;
    for (const k of Object.keys(after) as (keyof Entity)[]) if (after[k] === undefined) delete after[k];
    this.rawReplace(after);
    this.record({ k: 'mod', before, after });
    return after;
  }
  ensureLayer(name: string): Layer {
    const l = this.getLayer(name);
    if (l) return l;
    const nl = defaultLayer(name);
    this.setLayer(nl);
    return nl;
  }
  setLayer(layer: Layer) {
    const key = layer.name.toUpperCase();
    const before = this.layers.get(key) ?? null;
    const after = { ...layer };
    this.rawSet(this.layers, key, after, 'layers');
    this.record({ k: 'layer', key, before, after });
  }
  updateLayer(name: string, patch: Partial<Layer>) { const l = this.getLayer(name); if (l) this.setLayer({ ...l, ...patch, name: l.name }); }
  deleteLayer(name: string): boolean {
    const key = name.toUpperCase();
    if (key === '0' || key === 'DEFPOINTS' || key === this.settings.currentLayer.toUpperCase()) return false;
    for (const e of this.entities.values()) if (e.layer.toUpperCase() === key) return false;
    const before = this.layers.get(key) ?? null;
    if (!before) return false;
    this.rawSet(this.layers, key, null, 'layers');
    this.record({ k: 'layer', key, before, after: null });
    return true;
  }
  renameLayer(oldName: string, newName: string): boolean {
    const l = this.getLayer(oldName);
    if (!l || oldName.toUpperCase() === '0' || this.getLayer(newName)) return false;
    this.beginGroup('rename layer');
    this.setLayer({ ...l, name: newName });
    for (const e of [...this.entities.values()]) if (e.layer.toUpperCase() === oldName.toUpperCase()) this.update(e.id, { layer: newName });
    if (this.settings.currentLayer.toUpperCase() === oldName.toUpperCase()) this.setSettings({ currentLayer: newName });
    const key = oldName.toUpperCase();
    const before = this.layers.get(key) ?? null;
    this.rawSet(this.layers, key, null, 'layers');
    this.record({ k: 'layer', key, before, after: null });
    this.endGroup();
    return true;
  }
  setBlock(def: BlockDef | null, name = def?.name ?? '') {
    const before = this.blocks.get(name) ?? null;
    this.rawSet(this.blocks, name, def, 'blocks');
    this.record({ k: 'block', name, before, after: def });
  }
  setLinetype(def: LinetypeDef) {
    const key = def.name.toUpperCase();
    const before = this.linetypes.get(key) ?? null;
    this.rawSet(this.linetypes, key, def, 'styles');
    this.record({ k: 'ltype', key, before, after: def });
  }
  setStyle(def: TextStyle) {
    const key = def.name.toUpperCase();
    const before = this.styles.get(key) ?? null;
    this.rawSet(this.styles, key, def, 'styles');
    this.record({ k: 'style', key, before, after: def });
  }
  setSettings(patch: Partial<DocSettings>) {
    const before = structuredClone(this.settings);
    const after = { ...before, ...structuredClone(patch) } as DocSettings;
    this.settings = after;
    this.emit('settings');
    this.record({ k: 'settings', before, after: structuredClone(after) });
  }
  setUnits(u: number) {
    const before = this.units;
    this.units = u; this.emit('settings');
    this.record({ k: 'units', before, after: u });
  }

  /** Load data without recording history (used by file open). */
  loadRaw(fn: (d: this) => void) {
    this.withoutRecording(() => fn(this));
    if (!this.layers.has('0')) this.layers.set('0', defaultLayer('0'));
    this.reindex();
    this.clearHistory();
    this.dirty = false;
    this.emit('all');
    this.dirty = false;
  }
  /** Low-level insert used by loaders (no history). Returns the new id. */
  insertRaw(n: NewEntity): Entity {
    const e = { ...n, id: this.nextId++ } as Entity;
    this.entities.set(e.id, e);
    return e;
  }
}
