/**
 * Command engine: AutoCAD-style command line with asynchronous prompts.
 *
 * Commands are async functions that await prompts (point, distance, angle, string, keyword, selection, entity).
 * The UI (or a test script) feeds input: points (already snapped), typed text, Enter, Esc. Every command runs inside an
 * undo group, so one UNDO reverts a whole command; commands can also roll back their own last step (LINE → U).
 */
import type { CadDocument } from '../model/document';
import type { Entity, NewEntity, Pt } from '../types';
import type { Prim } from '../geom/prims';
import { dist } from '../geom/vec';
import { normalizeInput, parseAngle, parseNumber, parsePoint } from './coords';
import { AliasResolver, type Resolved } from './aliases';
import { defaultSnapSettings, type SnapSettings } from '../snap/osnap';
import { angleOf } from '../geom/vec';
import { entityGrips, GRIP_OBJECT_LIMIT, type Grip } from '../edit/grips';

export type Lang = 'ar' | 'en';
/** Bilingual message: [english, arabic] or a plain string. */
export type Msg = string | readonly [string, string];
export interface Keyword { key: string; en: string; ar: string }
export const kw = (key: string, en: string, ar: string): Keyword => ({ key, en, ar });

export class CommandCancelled extends Error { constructor() { super('*Cancel*'); } }

interface PromptCommon { msg: Msg; keywords?: Keyword[]; defaultText?: string }
export interface PointPrompt extends PromptCommon {
  kind: 'point'; base?: Pt | null; allowNone?: boolean; preview?: (p: Pt) => NewEntity[];
  rubber?: 'line' | 'rect' | 'none'; snapPrims?: Prim[]; snapPoints?: Pt[]; noSnap?: boolean;
  /** Typed text matching this pattern is returned verbatim (as a keyword answer) instead of being parsed as a point. */
  rawText?: RegExp;
}
export interface DistancePrompt extends PromptCommon { kind: 'distance'; base?: Pt | null; allowNone?: boolean; preview?: (p: Pt) => NewEntity[] }
export interface AnglePrompt extends PromptCommon { kind: 'angle'; base?: Pt | null; allowNone?: boolean; preview?: (p: Pt) => NewEntity[] }
export interface StringPrompt extends PromptCommon { kind: 'string'; allowSpaces?: boolean; allowNone?: boolean; multiline?: boolean }
export interface KeywordPrompt extends PromptCommon { kind: 'keyword'; keywords: Keyword[]; allowNone?: boolean }
export interface SelectPrompt extends PromptCommon { kind: 'select'; filter?: (e: Entity) => boolean; single?: boolean; includeLocked?: boolean }
export interface EntityPrompt extends PromptCommon { kind: 'entity'; filter?: (e: Entity) => boolean; allowNone?: boolean; includeLocked?: boolean }
export type Prompt = PointPrompt | DistancePrompt | AnglePrompt | StringPrompt | KeywordPrompt | SelectPrompt | EntityPrompt;

export type Answer =
  | { t: 'point'; p: Pt }
  | { t: 'value'; v: number }
  | { t: 'text'; s: string }
  | { t: 'kw'; key: string }
  | { t: 'none' }
  | { t: 'sel'; ids: number[] }
  | { t: 'ent'; id: number; p: Pt; shift?: boolean };

/** A window / polygon used during the last object selection (STRETCH needs the crossing regions). */
export type SelectionRegion = { kind: 'box' | 'poly'; pts: Pt[]; crossing: boolean };

/** Services the engine needs from its host (the editor UI or a headless harness). */
export interface EngineHost {
  /** Entity under a world point (uses the pick box), honouring visibility/locks. */
  pick(p: Pt, filter?: (e: Entity) => boolean, includeLocked?: boolean): number | null;
  /** Window (inside) or crossing selection between two world corners. */
  windowSelect(a: Pt, b: Pt, crossing: boolean, filter?: (e: Entity) => boolean, includeLocked?: boolean): number[];
  /** Fence (open path) or WP/CP polygon selection from a list of world points. */
  pathSelect?(pts: Pt[], mode: 'F' | 'WP' | 'CP', filter?: (e: Entity) => boolean, includeLocked?: boolean): number[];
  /** Visible part of the drawing (world box), used as the boundary search area. */
  viewBox?(): [number, number, number, number];
  pan?(dx: number, dy: number): void;
  zoom?(how: 'extents' | 'window' | 'previous' | 'scale' | 'center', a?: Pt, b?: Pt | number): void;
  /** Ask the UI for a richer input (dialogs). Returning undefined means "not available → use the command line". */
  dialog?(name: string, arg?: unknown): Promise<unknown> | undefined;
  /** File operations (NEW/OPEN/SAVE/EXPORT). */
  file?(op: 'new' | 'open' | 'save' | 'saveas' | 'export', arg?: string): Promise<void> | void;
  /** Bring a library block into the document (INSERT of a name that is not defined yet). */
  loadBlock?(name: string): Promise<boolean>;
  setProfile?(name: string): Promise<boolean> | boolean;
  profiles?(): string[];
  /** Drawing scales offered by the profile (YQArch DRAWING_SCALE_LIST). */
  scaleList?(): number[];
  regen?(): void;
}

export interface CommandDef {
  name: string;
  /** Additional names (e.g. BHATCH for HATCH, YQArch ids). */
  names?: string[];
  title: Msg;
  run(c: CommandEngine, resolved: Resolved): Promise<void>;
  /** Do not wrap in an undo group (UNDO/REDO, file commands). */
  noUndo?: boolean;
  /** Category for the command browser / toolbar. */
  group?: 'draw' | 'modify' | 'annotate' | 'view' | 'layer' | 'file' | 'settings' | 'inquiry' | 'yq' | 'edit';
}

export interface LogLine { text: string; kind: 'cmd' | 'prompt' | 'info' | 'error' | 'input' }
type Listener = () => void;

interface Pending { prompt: Prompt; resolve: (a: Answer) => void; reject: (e: Error) => void }
type PathMode = 'F' | 'WP' | 'CP';
interface SelState {
  ids: Set<number>; remove: boolean; corner: Pt | null; force?: 'W' | 'C'; history: number[][];
  /** Fence / polygon being drawn (Enter finishes it) and its points so far. */
  mode?: PathMode; pts: Pt[]; pathRemove?: boolean;
}
/** A grip of a selected entity: entity id + index in entityGrips(). */
export interface GripRef { id: number; index: number }
export interface ShownGrip extends Grip { id: number; hot: boolean }

const SELECT_KEYWORDS: Keyword[] = [kw('ALL', 'ALL', 'الكل'), kw('L', 'Last', 'الأخير'), kw('P', 'Previous', 'السابق'), kw('W', 'Window', 'نافذة'), kw('C', 'Crossing', 'تقاطع'), kw('F', 'Fence', 'سياج'), kw('WP', 'WPolygon', 'مضلع-نافذة'), kw('CP', 'CPolygon', 'مضلع-تقاطع'), kw('R', 'Remove', 'إزالة'), kw('A', 'Add', 'إضافة'), kw('U', 'Undo', 'تراجع')];

export class CommandEngine {
  doc: CadDocument;
  lang: Lang = 'ar';
  registry = new Map<string, CommandDef>();
  resolver: AliasResolver;
  log: LogLine[] = [];
  /** Pick-first selection (grips) used when idle and by noun-verb commands. */
  selection = new Set<number>();
  previousSelection: number[] = [];
  lastPoint: Pt | null = null;
  /** Current cursor in world coordinates (already snapped), maintained by the UI. */
  cursor: Pt | null = null;
  snap: SnapSettings = defaultSnapSettings();
  grid = { on: false, spacing: 1000 };
  lineweights = false;
  lastCommand: string | null = null;
  active: CommandDef | null = null;
  /** Window corner when selecting while idle. */
  idleCorner: Pt | null = null;
  /** Remembered values between commands (radius, text height, polygon sides…). */
  memory: Record<string, unknown> = {};
  /** Hot (selected) grips; the first one is the base grip of GRIPEDIT. */
  hotGrips: GripRef[] = [];
  /** Base point of the running grip edit. */
  gripBase: Pt | null = null;
  private prunedAt = -1;
  private gripCache: { key: string; grips: ShownGrip[] } | null = null;
  private pending: Pending | null = null;
  private sel: SelState | null = null;
  /** Windows / polygons of the last object selection (additive ones only), in selection order. */
  selectionRegions: SelectionRegion[] = [];
  private idleRegions: SelectionRegion[] = [];
  private listeners = new Set<Listener>();
  private waiters: (() => void)[] = [];
  private running: Promise<void> | null = null;
  private cancelled = false;

  constructor(doc: CadDocument, public host: EngineHost, resolver?: AliasResolver) {
    this.doc = doc;
    this.resolver = resolver ?? new AliasResolver(() => this.registry.keys(), { yqCommands: [], pgp: {} });
  }

  // ---------- registry ----------
  register(...defs: CommandDef[]) {
    for (const d of defs) for (const n of [d.name, ...(d.names ?? [])]) this.registry.set(n.toUpperCase(), d);
  }
  setResolver(r: AliasResolver) { this.resolver = r; }
  setDocument(doc: CadDocument) { this.cancel(); this.doc = doc; this.selection.clear(); this.hotGrips = []; this.gripCache = null; this.prunedAt = -1; this.previousSelection = []; this.lastPoint = null; this.emit(); }

  // ---------- events ----------
  subscribe(l: Listener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
  private emit() { for (const l of this.listeners) l(); const w = this.waiters; this.waiters = []; for (const f of w) f(); }

  t(m: Msg): string { return typeof m === 'string' ? m : this.lang === 'ar' ? m[1] : m[0]; }
  print(m: Msg, kind: LogLine['kind'] = 'info') {
    this.log.push({ text: this.t(m), kind });
    if (this.log.length > 400) this.log.splice(0, this.log.length - 400);
    this.emit();
  }
  error(m: Msg) { this.print(m, 'error'); }

  // ---------- state for the UI ----------
  get prompt(): Prompt | null { return this.pending?.prompt ?? null; }
  get busy() { return !!this.active; }
  /** Text of the current prompt including keywords and default, e.g. "Specify next point or [Close/Undo]:". */
  promptText(): string {
    const p = this.prompt;
    if (!p) return this.lang === 'ar' ? 'الأمر:' : 'Command:';
    let s = this.t(p.msg);
    if (this.sel?.mode && p.kind === 'select') {
      const m = this.sel.mode, n = this.sel.pts.length;
      const what = m === 'F' ? ['fence point', 'نقطة السياج'] : ['polygon point', 'نقطة المضلع'];
      const first = this.t([`Specify first ${what[0]}`, `حدد أول ${what[1]}`]);
      const next = this.t([`Specify next ${what[0]} or [Undo]`, `حدد ${what[1]} التالية أو [تراجع(U)]`]);
      return (n ? next : first) + ':';
    }
    if (this.sel && p.kind === 'select') {
      const n = this.sel.ids.size;
      if (this.sel.corner) s = this.t(['Specify opposite corner', 'حدد الركن المقابل']);
      else if (n) s += ` (${n} ${this.t(['found', 'محدد'])})`;
      if (this.sel.remove) s = this.t(['Remove objects', 'إزالة كائنات']);
    }
    if (p.keywords?.length) s += ` [${p.keywords.map((k) => this.kwLabel(k)).join('/')}]`;
    if (p.defaultText !== undefined && p.defaultText !== '') s += ` <${p.defaultText}>`;
    return s + ':';
  }
  kwLabel(k: Keyword) { return this.lang === 'ar' ? `${k.ar}(${k.key})` : k.en.toUpperCase().startsWith(k.key.toUpperCase()) ? k.key + k.en.slice(k.key.length).toLowerCase() : `${k.en}(${k.key})`; }
  /** Entities to draw as preview for the current cursor. */
  previewAt(p: Pt): NewEntity[] {
    const pr = this.prompt;
    if (!pr) return [];
    if ((pr.kind === 'point' || pr.kind === 'distance' || pr.kind === 'angle') && pr.preview) {
      try { return pr.preview(p); } catch { return []; }
    }
    return [];
  }
  /** Rubber band for the current prompt (line from base or selection window). */
  rubberAt(p: Pt): { line?: [Pt, Pt]; rect?: { a: Pt; b: Pt; crossing: boolean }; path?: { pts: Pt[]; closed: boolean; crossing: boolean } } | null {
    const pr = this.prompt;
    if (this.sel?.mode && pr?.kind === 'select') return { path: { pts: [...this.sel.pts, p], closed: this.sel.mode !== 'F', crossing: this.sel.mode !== 'WP' } };
    const corner = this.sel?.corner ?? (!pr ? this.idleCorner : null);
    if (corner) {
      const force = this.sel?.force;
      return { rect: { a: corner, b: p, crossing: force ? force === 'C' : p[0] < corner[0] } };
    }
    if (!pr) return null;
    if (pr.kind === 'point' && pr.base && pr.rubber === 'rect') return { rect: { a: pr.base, b: p, crossing: false } };
    if ((pr.kind === 'point' || pr.kind === 'distance' || pr.kind === 'angle') && pr.base && (pr.kind !== 'point' || pr.rubber !== 'none') && !pr.preview) return { line: [pr.base, p] };
    return null;
  }
  /** Base point for ortho/polar/perpendicular snapping. */
  snapBase(): Pt | null { const p = this.prompt; return p && (p.kind === 'point' || p.kind === 'distance' || p.kind === 'angle') ? p.base ?? null : null; }
  /** Highlighted entities: pending selection while selecting, otherwise the pick-first set. */
  highlighted(): Set<number> { return this.sel ? this.sel.ids : this.selection; }
  wantsPickbox(): boolean { const p = this.prompt; return !!p && (p.kind === 'select' || p.kind === 'entity') && !this.sel?.corner && !this.sel?.mode; }
  wantsSnap(): boolean { const p = this.prompt; return !!p && (p.kind === 'point' || p.kind === 'distance' || p.kind === 'angle' || (p.kind === 'select' && !!this.sel?.mode)) && !(p.kind === 'point' && p.noSnap); }
  /** True while a fence / polygon selection path is being drawn (clicks add vertices, Enter finishes). */
  get pathMode(): boolean { return !!this.sel?.mode; }

  // ---------- running commands ----------
  /** Resolve an alias/command name. */
  resolve(input: string): { def: CommandDef; r: Resolved } | { def: null; r: Resolved | null } {
    const r = this.resolver.resolve(input);
    if (!r) return { def: null, r: null };
    const def = this.registry.get(r.name.toUpperCase()) ?? null;
    return def ? { def, r } : { def: null, r };
  }

  /** Start a command typed or clicked by the user. Cancels a running command first. */
  async run(input: string): Promise<void> {
    if (this.running) { this.cancel(); await this.running.catch(() => {}); }
    const raw = input.trim();
    const res = this.resolve(raw);
    if (!res.def) {
      if (res.r?.meta) {
        const m = res.r.meta;
        this.print(`${raw} → ${m.id}: ${m.en} · ${m.zh}${m.description ? ' — ' + m.description : ''}`, 'cmd');
        this.print(['This YQArch command is planned for a later phase of the web version.', 'هذا الأمر من YQArch مخطط له في مرحلة لاحقة من نسخة الويب.']);
      } else if (res.r?.target) {
        this.print(`${raw} → ${res.r.target}`, 'cmd');
        this.print([`Command ${res.r.target} is not available in the web version yet.`, `الأمر ${res.r.target} غير متوفر في نسخة الويب بعد.`], 'error');
      } else this.print([`Unknown command "${raw.toUpperCase()}". Type YQ or ? for the command list.`, `أمر غير معروف "${raw.toUpperCase()}". اكتب YQ أو ? لعرض قائمة الأوامر.`], 'error');
      return;
    }
    const def = res.def;
    this.lastCommand = raw;
    this.active = def;
    this.cancelled = false;
    this.print(`${this.lang === 'ar' ? 'الأمر' : 'Command'}: ${raw.toUpperCase() === def.name ? def.name : `${raw} (${def.name})`}`, 'cmd');
    if (!def.noUndo) this.doc.beginGroup(def.name);
    const p = (async () => {
      try { await def.run(this, res.r); }
      catch (e) {
        if (e instanceof CommandCancelled) this.print('*Cancel*' + (this.lang === 'ar' ? ' (أُلغي)' : ''));
        else { this.error(`${def.name}: ${(e as Error).message}`); console.error(e); }
      } finally {
        if (!def.noUndo) this.doc.endGroup();
        this.pending = null; this.sel = null; this.active = null; this.running = null;
        this.emit();
      }
    })();
    this.running = p;
    this.emit();
    return p;
  }
  /** Promise of the running command (tests). */
  get current(): Promise<void> | null { return this.running; }

  cancel() {
    this.idleCorner = null;
    if (this.pending) { const p = this.pending; this.pending = null; this.cancelled = true; p.reject(new CommandCancelled()); }
    else if (!this.active) { this.hotGrips = []; if (this.selection.size) { this.selection.clear(); } }
    this.emit();
  }

  // ---------- prompts ----------
  ask(prompt: Prompt): Promise<Answer> {
    if (this.cancelled) return Promise.reject(new CommandCancelled());
    return new Promise<Answer>((resolve, reject) => {
      this.pending = { prompt, resolve, reject };
      this.print(this.promptText(), 'prompt');
    });
  }
  private answer(a: Answer) {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    p.resolve(a);
    this.emit();
  }
  /** Wait until the engine waits for input or the command finished (test harness). */
  waitInput(): Promise<void> {
    if (this.pending || !this.running) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }

  /** Feed a picked/snapped world point. */
  point(p: Pt, opts: { shift?: boolean } = {}) {
    const pr = this.prompt;
    if (!pr) { this.idleClick(p, !!opts.shift); return; }
    switch (pr.kind) {
      case 'point': this.lastPoint = p; this.answer({ t: 'point', p }); break;
      case 'distance': {
        if (pr.base) this.answer({ t: 'value', v: dist(pr.base, p) });
        else { this.answer({ t: 'point', p }); }
        break;
      }
      case 'angle': if (pr.base) this.answer({ t: 'value', v: angleOf(pr.base, p) }); else this.answer({ t: 'point', p }); break;
      case 'select': this.selectClick(p, !!opts.shift); break;
      case 'entity': {
        const id = this.host.pick(p, pr.filter, pr.includeLocked);
        if (id == null) { this.print(['No object found.', 'لم يتم العثور على كائن.']); break; }
        this.answer({ t: 'ent', id, p, shift: !!opts.shift });
        break;
      }
      default: break;
    }
  }

  /** Feed typed text (Enter pressed with text). Empty text = Enter. */
  text(input: string) {
    const s = normalizeInput(input);
    if (!this.prompt) {
      if (!s) { if (this.lastCommand) void this.run(this.lastCommand); return; }
      void this.run(s);
      return;
    }
    const pr = this.prompt;
    if (s) this.print(s, 'input');
    if (!s) { this.enter(); return; }
    const k = this.matchKeyword(s, pr.kind === 'select' ? [...SELECT_KEYWORDS, ...(pr.keywords ?? [])] : pr.keywords);
    if (k && pr.kind !== 'string') {
      if (pr.kind === 'select') { this.selectKeyword(k.key); return; }
      this.answer({ t: 'kw', key: k.key });
      return;
    }
    const ctx = { last: this.lastPoint, base: 'base' in pr ? pr.base ?? null : null, cursor: this.cursor };
    switch (pr.kind) {
      case 'point': {
        if (pr.rawText?.test(s)) { this.answer({ t: 'kw', key: s }); return; }
        const p = parsePoint(s, ctx);
        if (p) { this.lastPoint = p; this.answer({ t: 'point', p }); return; }
        break;
      }
      case 'distance': {
        const v = parseNumber(s);
        if (v !== null) { this.answer({ t: 'value', v }); return; }
        const p = parsePoint(s, ctx);
        if (p && pr.base) { this.answer({ t: 'value', v: dist(pr.base, p) }); return; }
        if (p) { this.answer({ t: 'point', p }); return; }
        break;
      }
      case 'angle': {
        const v = parseAngle(s);
        if (v !== null) { this.answer({ t: 'value', v }); return; }
        const p = parsePoint(s, ctx);
        if (p && pr.base) { this.answer({ t: 'value', v: angleOf(pr.base, p) }); return; }
        break;
      }
      case 'string': this.answer({ t: 'text', s: input.trim() }); return;
      case 'keyword': break;
      case 'select': {
        const st = this.sel;
        if (st && (st.mode || st.corner)) {
          const p = parsePoint(s, { ...ctx, base: st.pts.length ? st.pts[st.pts.length - 1] : st.corner });
          if (p) { this.lastPoint = p; this.selectClick(p, false); return; }
        }
        break;
      }
      case 'entity': break;
    }
    this.error(pr.kind === 'point' ? ['Invalid point.', 'نقطة غير صالحة.'] : pr.kind === 'keyword' || pr.kind === 'select' ? ['Invalid option keyword.', 'خيار غير صالح.'] : ['Invalid value.', 'قيمة غير صالحة.']);
    this.print(this.promptText(), 'prompt');
  }

  /** Enter / Space / right click. */
  enter() {
    const pr = this.prompt;
    if (!pr) { if (this.lastCommand) void this.run(this.lastCommand); return; }
    if (pr.kind === 'select') {
      const s = this.sel;
      if (s?.mode) { this.finishPath(); return; }
      if (s?.corner) return;
      const ids = s ? [...s.ids] : [];
      if (ids.length) this.previousSelection = ids;
      this.sel = null;
      this.answer({ t: 'sel', ids });
      return;
    }
    if (pr.defaultText !== undefined && pr.defaultText !== '' && pr.kind !== 'string') { this.text(pr.defaultText); return; }
    if (pr.kind === 'string' && pr.defaultText !== undefined) { this.answer({ t: 'text', s: pr.defaultText }); return; }
    if ('allowNone' in pr && pr.allowNone) { this.answer({ t: 'none' }); return; }
    if (pr.kind === 'string') { this.answer({ t: 'text', s: '' }); return; }
    this.print(this.promptText(), 'prompt');
  }

  private matchKeyword(s: string, kws?: Keyword[]): Keyword | null {
    if (!kws?.length) return null;
    const u = s.toUpperCase();
    return kws.find((k) => k.key.toUpperCase() === u)
      ?? kws.find((k) => k.en.toUpperCase() === u || k.ar === s)
      ?? (u.length >= 2 ? kws.find((k) => k.en.toUpperCase().startsWith(u)) ?? null : null);
  }

  // ---------- selection ----------
  private idleClick(p: Pt, shift: boolean) {
    if (!this.selection.size) this.idleRegions = [];
    if (this.idleCorner) {
      const a = this.idleCorner; this.idleCorner = null;
      const ids = this.host.windowSelect(a, p, p[0] < a[0]);
      if (!shift) this.idleRegions.push({ kind: 'box', pts: [a, p], crossing: p[0] < a[0] });
      for (const id of ids) shift ? this.selection.delete(id) : this.selection.add(id);
      this.emit();
      return;
    }
    const id = this.host.pick(p);
    if (id != null) { if (shift || this.selection.has(id) && shift) this.selection.delete(id); else this.selection.add(id); this.emit(); return; }
    this.idleCorner = p; this.emit();
  }
  private selectClick(p: Pt, shift: boolean) {
    const s = this.sel!;
    const pr = this.prompt as SelectPrompt;
    if (s.mode) { s.pts.push(p); if (shift && s.pts.length === 1) s.pathRemove = true; this.emit(); return; }
    const remove = s.remove || shift;
    if (s.corner) s.history.push([...s.ids]);
    if (s.corner) {
      const a = s.corner; s.corner = null;
      const crossing = s.force ? s.force === 'C' : p[0] < a[0];
      s.force = undefined;
      const ids = this.host.windowSelect(a, p, crossing, pr.filter, pr.includeLocked);
      if (!remove) this.selectionRegions.push({ kind: 'box', pts: [a, p], crossing });
      for (const id of ids) remove ? s.ids.delete(id) : s.ids.add(id);
      this.print(`${ids.length} ${this.t(['found', 'كائن'])}, ${s.ids.size} ${this.t(['total', 'المجموع'])}`);
    } else if (!s.force) {
      const id = this.host.pick(p, pr.filter, pr.includeLocked);
      if (id != null) {
        s.history.push([...s.ids]);
        remove ? s.ids.delete(id) : s.ids.add(id);
        this.print(`1 ${this.t(['found', 'كائن'])}, ${s.ids.size} ${this.t(['total', 'المجموع'])}`);
      } else s.corner = p;
    } else s.corner = p;
    if (pr.single && s.ids.size && !s.corner) { const ids = [...s.ids]; this.previousSelection = ids; this.sel = null; this.answer({ t: 'sel', ids }); return; }
    this.emit();
  }
  private selectKeyword(key: string) {
    const s = this.sel!;
    const pr = this.prompt as SelectPrompt;
    const ok = (id: number) => { const e = this.doc.get(id); return !!e && this.doc.isVisible(e) && (pr.includeLocked || !this.doc.isLocked(e)) && (!pr.filter || pr.filter(e)); };
    const addAll = (ids: number[]) => { s.history.push([...s.ids]); for (const id of ids) if (ok(id)) (s.remove ? s.ids.delete(id) : s.ids.add(id)); };
    if (s.mode && key !== 'U') { this.print(['Finish the current fence/polygon first (Enter).', 'أنهِ السياج/المضلع الحالي أولاً (Enter).'], 'error'); this.print(this.promptText(), 'prompt'); return; }
    switch (key) {
      case 'F': case 'WP': case 'CP': s.mode = key; s.pts = []; s.pathRemove = s.remove; s.corner = null; s.force = undefined; break;
      case 'U': {
        if (s.mode) { if (s.pts.length) s.pts.pop(); else { s.mode = undefined; s.pathRemove = false; } break; }
        const prev = s.history.pop();
        if (prev) { s.ids = new Set(prev); s.corner = null; } else this.print(['Everything has been undone.', 'لا يوجد ما يُتراجع عنه.']);
        break;
      }
      case 'ALL': addAll([...this.doc.entities.keys()]); break;
      case 'L': { const ids = [...this.doc.entities.keys()]; for (let i = ids.length - 1; i >= 0; i--) if (ok(ids[i])) { addAll([ids[i]]); break; } break; }
      case 'P': addAll(this.previousSelection); break;
      case 'R': s.remove = true; break;
      case 'A': s.remove = false; break;
      case 'W': case 'C': s.force = key; break;
      default: this.answer({ t: 'kw', key }); return;
    }
    if (!s.mode || key === 'U') this.print(`${s.ids.size} ${this.t(['total', 'المجموع'])}`);
    this.print(this.promptText(), 'prompt');
    this.emit();
  }
  /** Enter while drawing a fence / polygon: select with it and return to the normal object prompt. */
  private finishPath() {
    const s = this.sel!, pr = this.prompt as SelectPrompt;
    const mode = s.mode!, pts = s.pts, remove = s.remove || !!s.pathRemove;
    s.mode = undefined; s.pts = []; s.pathRemove = false;
    if (pts.length < (mode === 'F' ? 2 : 3)) {
      this.print(['Not enough points.', 'عدد النقاط غير كافٍ.'], 'error');
    } else {
      const ids = this.host.pathSelect ? this.host.pathSelect(pts, mode, pr.filter, pr.includeLocked) : [];
      if (!remove && mode !== 'F') this.selectionRegions.push({ kind: 'poly', pts: [...pts], crossing: mode === 'CP' });
      s.history.push([...s.ids]);
      for (const id of ids) remove ? s.ids.delete(id) : s.ids.add(id);
      this.print(`${ids.length} ${this.t(['found', 'كائن'])}, ${s.ids.size} ${this.t(['total', 'المجموع'])}`);
      if (pr.single && s.ids.size) { const all = [...s.ids]; this.previousSelection = all; this.sel = null; this.answer({ t: 'sel', ids: all }); return; }
    }
    this.print(this.promptText(), 'prompt');
    this.emit();
  }

  // ---------- pick-first selection & grips ----------
  /** Drop deleted entities from the pick-first selection and hot grips (lazily, once per document version). */
  pruneSelection() {
    if (this.prunedAt === this.doc.version) return;
    this.prunedAt = this.doc.version;
    for (const id of [...this.selection]) if (!this.doc.get(id)) this.selection.delete(id);
    if (this.hotGrips.length) this.hotGrips = this.hotGrips.filter((g) => this.selection.has(g.id) && this.doc.get(g.id));
  }
  /** Select every visible entity (Ctrl+A / SELECT ALL while idle). */
  selectAll() {
    if (this.busy) return;
    for (const [id, e] of this.doc.entities) if (this.doc.isVisible(e)) this.selection.add(id);
    this.emit();
  }
  clearHotGrips() { if (this.hotGrips.length) { this.hotGrips = []; this.emit(); } }
  /** Grips of the pick-first selection (empty while a command other than GRIPEDIT runs, or past GRIPOBJLIMIT). */
  grips(): ShownGrip[] {
    if (this.busy && this.active?.name !== 'GRIPEDIT') return [];
    this.pruneSelection();
    if (!this.selection.size || this.selection.size > GRIP_OBJECT_LIMIT) return [];
    const key = `${this.doc.version}|${[...this.selection].join(',')}|${this.hotGrips.map((g) => g.id + ':' + g.index).join(',')}`;
    if (this.gripCache?.key === key) return this.gripCache.grips;
    const hot = new Set(this.hotGrips.map((g) => g.id + ':' + g.index));
    const out: ShownGrip[] = [];
    const ctx = { bbox: (e: Entity) => this.doc.bboxOf(e) };
    for (const id of this.selection) {
      const e = this.doc.get(id);
      if (!e || this.doc.isLocked(e)) continue;
      for (const g of entityGrips(e, ctx)) out.push({ ...g, id, hot: hot.has(id + ':' + g.index) });
    }
    this.gripCache = { key, grips: out };
    return out;
  }
  gripPoint(ref: GripRef): Pt | null { return this.grips().find((g) => g.id === ref.id && g.index === ref.index)?.p ?? null; }
  /** Nearest grip within `tol` (world units) of `p`. */
  gripAt(p: Pt, tol: number): ShownGrip | null {
    let best: ShownGrip | null = null, bd = tol;
    for (const g of this.grips()) { const d = Math.max(Math.abs(g.p[0] - p[0]), Math.abs(g.p[1] - p[1])); if (d <= bd) { bd = d; best = g; } }
    return best;
  }
  /**
   * Click on a grip while idle. Shift toggles the grip (and coincident ones) as hot without starting an edit;
   * a plain click makes it the base grip and starts GRIPEDIT. Returns the running command promise, if any.
   */
  clickGrip(ref: GripRef, shift = false): Promise<void> | null {
    if (this.busy) return null;
    const all = this.grips();
    const g = all.find((x) => x.id === ref.id && x.index === ref.index);
    if (!g) return null;
    const tol = 1e-9 * Math.max(1, Math.abs(g.p[0]), Math.abs(g.p[1]));
    const same = all.filter((x) => Math.abs(x.p[0] - g.p[0]) <= tol && Math.abs(x.p[1] - g.p[1]) <= tol).map((x) => ({ id: x.id, index: x.index }));
    const isHot = (r: GripRef) => this.hotGrips.some((h) => h.id === r.id && h.index === r.index);
    if (shift) {
      if (isHot(ref)) this.hotGrips = this.hotGrips.filter((h) => !same.some((s2) => s2.id === h.id && s2.index === h.index));
      else this.hotGrips.push(...same.filter((r) => !isHot(r)));
      this.emit();
      return null;
    }
    const rest = this.hotGrips.filter((h) => !same.some((s2) => s2.id === h.id && s2.index === h.index));
    this.hotGrips = [...same, ...rest];
    this.gripBase = [g.p[0], g.p[1]];
    return this.run('GRIPEDIT');
  }

  // ---------- typed prompt helpers used by commands ----------
  async getPoint(msg: Msg, o: Omit<PointPrompt, 'kind' | 'msg'> = {}): Promise<Pt | string | null> {
    const a = await this.ask({ kind: 'point', msg, ...o });
    if (a.t === 'point') return a.p;
    if (a.t === 'kw') return a.key;
    return null;
  }
  /** Point that is required (re-prompts on Enter unless keywords/none allowed). */
  async requirePoint(msg: Msg, o: Omit<PointPrompt, 'kind' | 'msg'> = {}): Promise<Pt> {
    for (;;) { const r = await this.getPoint(msg, o); if (Array.isArray(r)) return r; }
  }
  async getDistance(msg: Msg, o: Omit<DistancePrompt, 'kind' | 'msg'> = {}): Promise<number | string | null> {
    for (;;) {
      const a = await this.ask({ kind: 'distance', msg, ...o });
      if (a.t === 'value') return a.v;
      if (a.t === 'kw') return a.key;
      if (a.t === 'none') return null;
      if (a.t === 'point') { // no base: second point gives the distance
        const p2 = await this.requirePoint(['Specify second point', 'حدد النقطة الثانية'], { base: a.p });
        return dist(a.p, p2);
      }
    }
  }
  async getAngle(msg: Msg, o: Omit<AnglePrompt, 'kind' | 'msg'> = {}): Promise<number | string | null> {
    for (;;) {
      const a = await this.ask({ kind: 'angle', msg, ...o });
      if (a.t === 'value') return a.v;
      if (a.t === 'kw') return a.key;
      if (a.t === 'none') return null;
      if (a.t === 'point') { const p2 = await this.requirePoint(['Specify second point', 'حدد النقطة الثانية'], { base: a.p }); return angleOf(a.p, p2); }
    }
  }
  async getString(msg: Msg, o: Omit<StringPrompt, 'kind' | 'msg'> = {}): Promise<string | null> {
    const a = await this.ask({ kind: 'string', msg, ...o });
    if (a.t === 'text') return a.s;
    if (a.t === 'kw') return a.key;
    return null;
  }
  async getKeyword(msg: Msg, keywords: Keyword[], o: { defaultText?: string; allowNone?: boolean } = {}): Promise<string | null> {
    const a = await this.ask({ kind: 'keyword', msg, keywords, ...o });
    return a.t === 'kw' ? a.key : null;
  }
  /** Object selection; uses (and clears) the pick-first selection when present. */
  async getSelection(msg: Msg = ['Select objects', 'اختر الكائنات'], o: { filter?: (e: Entity) => boolean; usePickfirst?: boolean; single?: boolean; keywords?: Keyword[]; includeLocked?: boolean } = {}): Promise<number[]> {
    this.pruneSelection();
    this.selectionRegions = [];
    if (o.usePickfirst !== false && this.selection.size) {
      this.selectionRegions = this.idleRegions; this.idleRegions = [];
      const ids = [...this.selection].filter((id) => { const e = this.doc.get(id); return e && (o.includeLocked || !this.doc.isLocked(e)) && (!o.filter || o.filter(e)); });
      this.selection.clear(); this.hotGrips = [];
      if (ids.length) { this.previousSelection = ids; this.print(`${ids.length} ${this.t(['found', 'كائن محدد'])}`); this.emit(); return ids; }
    }
    this.sel = { ids: new Set(), remove: false, corner: null, history: [], pts: [] };
    const a = await this.ask({ kind: 'select', msg, filter: o.filter, single: o.single, keywords: o.keywords, includeLocked: o.includeLocked });
    this.sel = null;
    if (a.t === 'sel') return a.ids;
    if (a.t === 'kw') throw new KeywordAnswer(a.key);
    return [];
  }
  async getEntity(msg: Msg, o: { filter?: (e: Entity) => boolean; keywords?: Keyword[]; allowNone?: boolean; includeLocked?: boolean } = {}): Promise<{ id: number; p: Pt; shift?: boolean } | string | null> {
    for (;;) {
      const a = await this.ask({ kind: 'entity', msg, ...o });
      if (a.t === 'ent') return { id: a.id, p: a.p, shift: !!a.shift };
      if (a.t === 'kw') return a.key;
      if (a.t === 'none') return null;
    }
  }

  // ---------- helpers ----------
  /** Add an entity with the current layer/colour/linetype. */
  add(n: NewEntity): Entity { return this.doc.addWithCurrent(n); }
  /** Marker for rolling back the ops recorded so far in this command. */
  mark(): number { return this.doc.groupOps().length; }
  rollbackTo(mark: number) { const n = this.doc.groupOps().length - mark; if (n > 0) this.doc.rollbackGroupOps(n); }
  fmt(v: number, prec = this.doc.settings.precision): string { return Number(v.toFixed(prec)).toString(); }
  fmtPt(p: Pt): string { return `${this.fmt(p[0])},${this.fmt(p[1])}`; }
  /** Paper-size (mm) → drawing units at the current drawing scale. */
  paper(mm: number): number { const s = this.doc.settings; return mm * s.drawingScale * unitsPerMmOf(this.doc.units); }
}

/** Thrown by getSelection when a custom keyword was chosen instead of objects. */
export class KeywordAnswer extends Error { constructor(public key: string) { super(key); } }

function unitsPerMmOf(u: number) { switch (u) { case 1: return 1 / 25.4; case 2: return 1 / 304.8; case 5: return 0.1; case 6: return 0.001; default: return 1; } }

/** Run a scripted command for tests / macros: tokens are typed text ('' = Enter), {p:[x,y]} = click, 'ESC' = cancel. */
export async function runScript(c: CommandEngine, command: string, tokens: (string | { p: Pt; shift?: boolean })[]): Promise<void> {
  const done = c.run(command);
  for (const t of tokens) {
    await c.waitInput();
    await Promise.resolve();
    if (!c.busy) throw new Error(`command ${command} finished before token ${JSON.stringify(t)}`);
    if (typeof t === 'string') { if (t === 'ESC') c.cancel(); else c.text(t); }
    else c.point(t.p, { shift: t.shift });
  }
  await done;
}
