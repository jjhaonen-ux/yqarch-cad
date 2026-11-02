import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { CadDocument } from '../engine/model/document';
import { UNIT_NAMES } from '../engine/model/settings';
import { CommandEngine } from '../engine/commands/engine';
import { registerAll } from '../engine/commands';
import { ARCHITECTURE_COMMANDS } from '../engine/commands/architecture';
import { AliasResolver } from '../engine/commands/aliases';
import { CanvasRenderer, DARK, type Overlay } from '../engine/render/renderer';
import { Viewport } from '../engine/render/view';
import { LinetypeLibrary } from '../engine/render/linetypes';
import { PatternLibrary, patternToLines } from '../engine/render/hatch';
import { pick, windowSelect, crossingSelect, fenceSelect, polygonSelect } from '../engine/select/select';
import { computeSnap, type SnapKind, OSNAP_KINDS, SNAP_LABELS } from '../engine/snap/osnap';
import { aciToHex } from '../util/aci';
import { fromJSON, serialize, type DrawingJson } from '../engine/io/native';
import { importLibraryBlock } from '../engine/io/library';
import { loadBlockFile, loadEditorAssets, assetPath, type EditorAssets, type LibraryEntry, type ThumbnailEntry } from './assets';
import { SAMPLE_DRAWING } from './sample-drawing';
import type { Entity, Layer, NewEntity, Pt } from '../engine/types';
import './app.css';

type DialogState = { type: 'insert' } | { type: 'mtext'; height: number; text: string } | { type: 'commands' } | null;
type DragState = { start: Pt; startScreen: Pt; last: Pt; lastScreen: Pt; pan: boolean; grip?: boolean } | null;
type Tab = 'layers' | 'blocks' | 'properties';
const LS_KEY = 'yqweb-cad-drawing-v1';
const blankDrawing = (): DrawingJson => ({ format: 'yqweb-drawing@1', name: 'Drawing1', units: 4, entities: [] });
const pointEntity = (p: Pt, layer = '0'): NewEntity => ({ type: 'POINT', layer, p });
const distance = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const insideInput = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest('input,textarea,select,[contenteditable="true"]');

const ARCHITECTURE_COMMAND_CATALOG = ARCHITECTURE_COMMANDS.map((command) => {
  const [en, zh] = typeof command.title === 'string' ? [command.title, command.title] : command.title;
  return { id: command.name, alias: command.names?.[0] ?? '', en, zh, category: 'architecture', stars: 5 };
});

function createDocument() {
  const doc = new CadDocument();
  try {
    const saved = localStorage.getItem(LS_KEY);
    if (saved) return fromJSON(saved, doc);
  } catch { /* use the demo when storage is unavailable */ }
  return fromJSON(SAMPLE_DRAWING, doc);
}

export default function App() {
  const [doc] = useState(createDocument);
  const [engine, setEngine] = useState<CommandEngine | null>(null);
  const [assets, setAssets] = useState<EditorAssets | null>(null);
  const [revision, setRevision] = useState(0);
  const [tab, setTab] = useState<Tab>('layers');
  const [commandValue, setCommandValue] = useState('');
  const [dialog, setDialog] = useState<DialogState>(null);
  const [blockSearch, setBlockSearch] = useState('');
  const [commandSearch, setCommandSearch] = useState('');
  const [newLayerName, setNewLayerName] = useState('');
  const [toast, setToast] = useState('');
  const [activeTool, setActiveTool] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const commandInputRef = useRef<HTMLInputElement>(null);
  const engineRef = useRef<CommandEngine | null>(null);
  const assetsRef = useRef<EditorAssets | null>(null);
  const rendererRef = useRef<CanvasRenderer | null>(null);
  const viewRef = useRef(new Viewport());
  const dragRef = useRef<DragState>(null);
  const spaceRef = useRef(false);
  const pointerRef = useRef<Pt | null>(null);
  const worldRef = useRef<Pt>([0, 0]);
  const snapRef = useRef<{ p: Pt; kind: SnapKind | null; tracking?: { from: Pt; angle: number } }>({ p: [0, 0], kind: null });
  const hoverRef = useRef<number | null>(null);
  const dirtyRef = useRef(false);
  const blockDialogResolve = useRef<((name: string | null) => void) | null>(null);
  const mtextDialogResolve = useRef<((value: { text: string; height?: number } | null) => void) | null>(null);
  const queuedBlock = useRef<string | null>(null);
  const [autoSaved, setAutoSaved] = useState(true);
  const [, setCurrentFile] = useState(doc.name);

  const tick = useCallback(() => setRevision((n) => n + 1), []);
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const renderer = rendererRef.current;
    const cmd = engineRef.current;
    if (!canvas || !renderer || !cmd) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const view = viewRef.current;
    if (view.width !== rect.width || view.height !== rect.height) {
      view.resize(rect.width, rect.height);
      canvas.width = Math.max(1, Math.round(rect.width));
      canvas.height = Math.max(1, Math.round(rect.height));
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const cursor = pointerRef.current;
    const world = worldRef.current;
    const previews = cursor ? cmd.previewAt(snapRef.current.p).map((e) => ({ ...e, id: -999 }) as Entity) : [];
    const rubber = cursor ? cmd.rubberAt(snapRef.current.p) : null;
    if (rubber?.line) previews.push({ type: 'LINE', id: -998, layer: doc.settings.currentLayer, a: rubber.line[0], b: rubber.line[1] });
    const overlay: Overlay = {
      selection: cmd.highlighted(), hover: hoverRef.current, preview: previews,
      snap: snapRef.current.kind ? { p: snapRef.current.p, kind: snapRef.current.kind } : null,
      tracking: snapRef.current.tracking ?? null,
      rubber: rubber?.rect ? { a: rubber.rect.a, b: rubber.rect.b, crossing: rubber.rect.crossing } : null,
      rubberPath: rubber?.path ?? null,
      grips: cmd.grips().map((g) => ({ p: g.p, hot: g.hot })),
      cursor, showPickbox: cmd.wantsPickbox(), pickbox: 5,
      grid: { on: cmd.grid.on, spacing: cmd.grid.spacing }, lineweights: cmd.lineweights,
      label: cursor ? `${world[0].toFixed(2)}, ${world[1].toFixed(2)}` : null,
    };
    renderer.render(ctx, view, overlay);
  }, [doc]);

  useEffect(() => {
    const view = viewRef.current;
    const host = {
      pick: (p: Pt, filter?: (e: Entity) => boolean, includeLocked?: boolean) => {
        const r = rendererRef.current;
        return r ? pick(doc, r, p, view.px(8), { filter, includeLocked }) : null;
      },
      windowSelect: (a: Pt, b: Pt, crossing: boolean, filter?: (e: Entity) => boolean, includeLocked?: boolean) => {
        const box = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])] as [number, number, number, number];
        const options = { filter, includeLocked };
        return crossing && rendererRef.current ? crossingSelect(doc, rendererRef.current, box, options) : windowSelect(doc, box, options);
      },
      pathSelect: (pts: Pt[], mode: 'F' | 'WP' | 'CP', filter?: (e: Entity) => boolean, includeLocked?: boolean) => {
        const r = rendererRef.current;
        if (!r) return [];
        const options = { filter, includeLocked };
        return mode === 'F' ? fenceSelect(doc, r, pts, options) : polygonSelect(doc, r, pts, mode === 'CP', options);
      },
      viewBox: () => view.visibleBox(),
      pan: (dx: number, dy: number) => { view.cx -= dx; view.cy -= dy; tick(); },
      zoom: (how: 'extents' | 'window' | 'previous' | 'scale' | 'center', a?: Pt, b?: Pt | number) => {
        if (how === 'extents') { const ext = doc.extents(); if (ext) { view.pushHistory(); view.fit(ext, 0.12); } }
        else if (how === 'window' && a && Array.isArray(b)) { view.pushHistory(); view.fit([Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])], 0.06); }
        else if (how === 'previous') view.previous();
        else if (how === 'scale' && typeof b === 'number') { view.pushHistory(); view.zoomAt(view.width / 2, view.height / 2, b); }
        else if (how === 'center' && a) { view.cx = a[0]; view.cy = a[1]; }
        tick();
      },
      dialog: (name: string, arg?: unknown) => {
        if (name === 'insert') {
          const selected = queuedBlock.current; queuedBlock.current = null;
          if (selected) return Promise.resolve(selected);
          setDialog({ type: 'insert' });
          return new Promise<string | null>((resolve) => { blockDialogResolve.current = resolve; });
        }
        if (name === 'mtext') {
          const info = arg as { height?: number; text?: string };
          setDialog({ type: 'mtext', height: info.height ?? doc.settings.textHeight, text: info.text ?? '' });
          return new Promise<{ text: string; height?: number } | null>((resolve) => { mtextDialogResolve.current = resolve; });
        }
        if (name === 'commands') { setDialog({ type: 'commands' }); return Promise.resolve(); }
        return undefined;
      },
      file: async (op: 'new' | 'open' | 'save' | 'saveas' | 'export', arg?: string) => {
        if (op === 'new') {
          if (doc.dirty && !window.confirm('يوجد تعديل غير محفوظ كملف. هل تريد بدء رسم جديد؟')) return;
          fromJSON(blankDrawing(), doc); doc.clearHistory(); setCurrentFile(doc.name); view.fit([-500, -500, 500, 500], 0.08); tick(); return;
        }
        if (op === 'open') {
          if (doc.dirty && !window.confirm('يوجد تعديل غير محفوظ كملف. هل تريد فتح رسم آخر؟')) return;
          fileInputRef.current?.click(); return;
        }
        if (op === 'save' || op === 'saveas' || op === 'export') {
          const name = op === 'saveas' ? (window.prompt('اسم الملف', doc.name) || doc.name) : (arg || doc.name);
          doc.name = name.replace(/\.(yqd|json)$/i, '') || doc.name;
          downloadDrawing(doc, doc.name); setCurrentFile(doc.name); doc.dirty = false; dirtyRef.current = false; setAutoSaved(true); tick(); return;
        }
      },
      loadBlock: async (name: string) => {
        const item = findLibraryEntry(assetsRef.current, name);
        if (!item) return false;
        const json = await loadBlockFile(item.file);
        const requested = Object.keys(json.blocks ?? {}).find((key) => key.toUpperCase() === name.toUpperCase());
        if (requested) importLibraryBlock(doc, json, requested);
        else importLibraryBlock(doc, json, null, displayName(item));
        return true;
      },
      setProfile: async (name: string) => { doc.setSettings({ profile: name }); return true; },
      profiles: () => assetsRef.current?.profiles ?? ['user1'],
      scaleList: () => [20, 25, 50, 75, 100, 150, 200],
      regen: () => tick(),
    };
    const cmd = new CommandEngine(doc, host);
    registerAll(cmd);
    cmd.lang = 'ar';
    engineRef.current = cmd;
    setEngine(cmd);
    rendererRef.current = new CanvasRenderer({ doc, fg: DARK.fg, bg: DARK.bg, linetypes: new LinetypeLibrary(), patterns: new PatternLibrary() });
    const offDoc = doc.onChange(() => { dirtyRef.current = true; setAutoSaved(false); tick(); });
    const offCmd = cmd.subscribe(() => { setActiveTool(cmd.active?.name ?? ''); tick(); });
    const resize = new ResizeObserver(() => {
      const c = canvasRef.current;
      if (!c) return;
      const r = c.getBoundingClientRect();
      view.resize(r.width, r.height);
      c.width = Math.max(1, Math.round(r.width)); c.height = Math.max(1, Math.round(r.height));
      redraw();
    });
    if (canvasRef.current) resize.observe(canvasRef.current);
    const ext = doc.extents(); if (ext) view.fit(ext, 0.13);
    redraw();
    return () => { offDoc(); offCmd(); resize.disconnect(); };
    // The editor host and document are intentionally created once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadEditorAssets(() => { doc.invalidate(); redraw(); }).then((loaded) => {
      if (cancelled) return;
      assetsRef.current = loaded;
      setAssets(loaded);
      const cmd = engineRef.current;
      if (cmd) cmd.setResolver(new AliasResolver(() => cmd.registry.keys(), loaded.aliases));
      const renderer = rendererRef.current;
      // EXPLODE / MIRROR need the pattern definitions and fonts too
      doc.patternLines = (name, scale, angleDeg, origin) => {
        const pat = loaded.patterns.find(name);
        return pat ? patternToLines(pat, scale, (angleDeg * Math.PI) / 180, origin) : undefined;
      };
      doc.fonts = loaded.fonts;
      if (renderer) {
        renderer.tc.fonts = loaded.fonts;
        renderer.tc.patterns = loaded.patterns;
        renderer.tc.linetypes = loaded.linetypes;
      }
      // Warm the common single-stroke font; larger glyph sets are loaded on demand.
      loaded.fonts.get('TXT1');
      redraw(); tick();
    }).catch((e) => setToast(`تعذّر تحميل بعض الموارد: ${String(e)}`));
    return () => { cancelled = true; };
  }, [doc, redraw, tick]);

  useEffect(() => {
    if (!engine) return;
    engine.lang = 'ar';
    tick();
  }, [engine, tick]);

  useEffect(() => { redraw(); }, [revision, redraw]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try { localStorage.setItem(LS_KEY, serialize(doc)); setAutoSaved(true); }
      catch { setAutoSaved(false); }
    }, 450);
    return () => window.clearTimeout(timer);
  }, [doc, revision]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const cmd = engineRef.current;
      if (!cmd) return;
      if (event.key === 'Escape') { cmd.cancel(); setDialog(null); blockDialogResolve.current?.(null); blockDialogResolve.current = null; mtextDialogResolve.current?.(null); mtextDialogResolve.current = null; }
      if (event.key === 'F3') { event.preventDefault(); cmd.snap.osnapOn = !cmd.snap.osnapOn; tick(); }
      if (event.key === 'F7') { event.preventDefault(); cmd.grid.on = !cmd.grid.on; tick(); }
      if (event.key === 'F8') { event.preventDefault(); cmd.snap.orthoOn = !cmd.snap.orthoOn; tick(); }
      if (event.key === 'F10') { event.preventDefault(); cmd.snap.polarOn = !cmd.snap.polarOn; tick(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void cmd.host.file?.('save'); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); doc.undo(); tick(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); doc.redo(); tick(); }
      if (event.key === 'Delete' && !insideInput(event.target) && cmd.selection.size) { event.preventDefault(); void cmd.run('ERASE'); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && !insideInput(event.target)) { event.preventDefault(); cmd.selectAll(); tick(); }
      if (event.key === ' ' && !insideInput(event.target)) spaceRef.current = true;
    };
    const onKeyUp = (event: KeyboardEvent) => { if (event.key === ' ') spaceRef.current = false; };
    window.addEventListener('keydown', onKeyDown); window.addEventListener('keyup', onKeyUp);
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); };
  }, [doc, tick]);

  const run = useCallback((name: string) => {
    const cmd = engineRef.current;
    if (!cmd) return;
    setCommandValue(''); setActiveTool(name.toUpperCase());
    void cmd.run(name);
  }, []);

  const updatePointer = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const screen: Pt = [event.clientX - rect.left, event.clientY - rect.top];
    const view = viewRef.current; view.resize(rect.width, rect.height);
    const raw = view.toWorld(screen[0], screen[1]);
    const cmd = engineRef.current;
    pointerRef.current = screen; worldRef.current = raw;
    if (cmd) {
      const snapped = cmd.wantsSnap() ? computeSnap(doc, view, cmd.snap, { cursor: raw, base: cmd.snapBase() }) : { p: raw, kind: null as SnapKind | null };
      snapRef.current = snapped;
      cmd.cursor = snapped.p;
      hoverRef.current = cmd.wantsPickbox() || !cmd.prompt ? pick(doc, rendererRef.current ?? { itemsFor: () => [] }, raw, view.px(8)) : null;
    }
    redraw();
    return { screen, raw, snapped: snapRef.current.p };
  }, [doc, redraw]);

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const p = updatePointer(event);
    const pan = event.button === 1 || spaceRef.current;
    const cmd = engineRef.current;
    // grips: a click on a grip while idle starts grip editing (Shift toggles extra hot grips); press-drag-release stretches
    if (!pan && event.button === 0 && cmd && !cmd.busy) {
      const g = cmd.gripAt(p.raw, viewRef.current.px(6));
      if (g) {
        dragRef.current = { start: g.p, startScreen: p.screen, last: g.p, lastScreen: p.screen, pan: false, grip: !event.shiftKey };
        void cmd.clickGrip({ id: g.id, index: g.index }, event.shiftKey);
        if (event.shiftKey) dragRef.current = null;
        tick(); redraw();
        return;
      }
    }
    dragRef.current = { start: p.snapped, startScreen: p.screen, last: p.snapped, lastScreen: p.screen, pan };
    if (pan) event.preventDefault();
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const p = updatePointer(event);
    const drag = dragRef.current;
    if (drag && drag.pan) {
      const dx = p.screen[0] - drag.lastScreen[0], dy = p.screen[1] - drag.lastScreen[1];
      viewRef.current.pan(dx, dy); drag.lastScreen = p.screen; drag.last = p.snapped; redraw();
    } else if (drag) { drag.last = p.snapped; drag.lastScreen = p.screen; redraw(); }
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current; dragRef.current = null;
    if (event.button === 2) { redraw(); return; }
    if (!drag || drag.pan) { redraw(); return; }
    const p = updatePointer(event); const cmd = engineRef.current;
    if (!cmd) return;
    const moved = distance(drag.startScreen, p.screen) > 5;
    if (drag.grip) { // grip press: a drag finishes the edit at the release point, a click leaves the grip edit waiting
      if (moved && cmd.active?.name === 'GRIPEDIT') cmd.point(p.snapped);
      tick(); commandInputRef.current?.focus();
      return;
    }
    if (moved && (!cmd.prompt || (cmd.prompt.kind === 'select' && !cmd.pathMode))) {
      cmd.point(drag.start, { shift: event.shiftKey });
      cmd.point(p.snapped, { shift: event.shiftKey });
    } else cmd.point(p.snapped, { shift: event.shiftKey });
    tick(); commandInputRef.current?.focus();
  };
  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect();
    viewRef.current.pushHistory();
    viewRef.current.zoomAt(event.clientX - rect.left, event.clientY - rect.top, Math.exp(-event.deltaY * 0.0012));
    redraw(); tick();
  };
  const onCanvasContext = (event: React.MouseEvent<HTMLCanvasElement>) => { event.preventDefault(); engineRef.current?.enter(); tick(); };

  const fitDrawing = () => { const ext = doc.extents(); if (ext) { viewRef.current.pushHistory(); viewRef.current.fit(ext, 0.13); } tick(); redraw(); };
  const save = () => { const cmd = engineRef.current; if (cmd) void cmd.host.file?.('save'); };
  const open = () => {
    if (doc.dirty && !window.confirm('يوجد تعديل غير محفوظ كملف. هل تريد فتح رسم آخر؟')) return;
    fileInputRef.current?.click();
  };
  const newDrawing = () => {
    if (doc.dirty && !window.confirm('يوجد تعديل غير محفوظ كملف. هل تريد بدء رسم جديد؟')) return;
    fromJSON(blankDrawing(), doc); doc.clearHistory(); dirtyRef.current = false; setAutoSaved(true); setCurrentFile(doc.name); viewRef.current.fit([-500, -500, 500, 500], 0.08); tick();
  };
  const onFileSelected = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    void file.text().then((text) => {
      fromJSON(text, doc); doc.clearHistory(); dirtyRef.current = false; setAutoSaved(true); setCurrentFile(doc.name || file.name.replace(/\.yqd$/i, ''));
      const ext = doc.extents(); if (ext) { viewRef.current.pushHistory(); viewRef.current.fit(ext, 0.13); }
      setToast(`تم فتح ${file.name}`); window.setTimeout(() => setToast(''), 2500); tick();
    }).catch((e) => setToast(`تعذّر فتح الملف: ${String(e)}`));
  };
  const startInsert = (item?: ThumbnailEntry) => {
    if (!engineRef.current) return;
    if (item) queuedBlock.current = item.name;
    setTab('blocks');
    void engineRef.current.run('INSERT');
    commandInputRef.current?.focus();
  };
  const finishInsertDialog = (name: string | null) => {
    blockDialogResolve.current?.(name); blockDialogResolve.current = null; setDialog(null);
  };
  const finishMtextDialog = (value: { text: string; height?: number } | null) => {
    mtextDialogResolve.current?.(value); mtextDialogResolve.current = null; setDialog(null);
  };
  const onCommandSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const value = commandValue.trim();
    if (!value) { engine?.enter(); tick(); return; }
    if (engine) { engine.text(value); setCommandValue(''); }
  };

  const promptText = engine?.promptText() ?? 'الأمر:';
  const filteredThumbnails = useMemo(() => (assets?.thumbnails ?? [])
    .filter((thumb) => !!thumb.dwg && assets?.blocks.some((block) => block.source.toLowerCase() === thumb.dwg.toLowerCase()))
    .filter((x) => `${x.name} ${x.id}`.toLowerCase().includes(blockSearch.toLowerCase()))
    .slice(0, 120), [assets, blockSearch]);
  const layerNames = [...doc.layers.values()].sort((a, b) => a.name === '0' ? -1 : b.name === '0' ? 1 : a.name.localeCompare(b.name));
  const selectedEntities = engine ? [...engine.selection].map((id) => doc.get(id)).filter((e): e is Entity => !!e) : [];
  const activeEntity = selectedEntities.length === 1 ? selectedEntities[0] : null;
  const logs = engine?.log.slice(-7) ?? [];
  const isModified = dirtyRef.current && !autoSaved;

  return <div className="cad-shell" dir="rtl">
    <header className="topbar">
      <div className="brand"><div className="brand-mark"><span>YQ</span></div><div><strong>YQArch</strong><small>WEB CAD</small></div></div>
      <div className="top-divider" />
      <div className="file-title"><strong>{doc.name}</strong><span className="file-ext">.yqd</span>{isModified && <i className="dirty-dot" />}</div>
      <div className="top-actions">
        <button className="top-action" onClick={newDrawing} title="رسم جديد"><Icon name="new" /> <span>جديد</span></button>
        <button className="top-action" onClick={open} title="فتح رسم"><Icon name="open" /> <span>فتح</span></button>
        <button className="top-action save-action" onClick={save} title="حفظ Ctrl+S"><Icon name="save" /> <span>حفظ</span></button>
        <span className="top-divider slim" />
        <button className="icon-button" onClick={() => { doc.undo(); tick(); }} disabled={!doc.canUndo} title="تراجع"><Icon name="undo" /></button>
        <button className="icon-button" onClick={() => { doc.redo(); tick(); }} disabled={!doc.canRedo} title="إعادة"><Icon name="redo" /></button>
        <span className="top-divider slim" />
      </div>
    </header>

    <div className="menubar">
      <button onClick={() => setDialog({ type: 'commands' })}>ملف</button><button onClick={() => setTab('layers')}>تحرير</button><button onClick={() => setDialog({ type: 'commands' })}>عرض</button><button onClick={() => setDialog({ type: 'commands' })}>إدراج</button><button onClick={() => setDialog({ type: 'commands' })}>مساعدة</button>
      <span className="menu-spacer" />
      <button className="help-link" onClick={() => setDialog({ type: 'commands' })}>دليل الأوامر <span>↗</span></button>
    </div>

    <section className="toolbar">
      <div className="tool-group">
        <span className="group-label">رسم</span>
        <ToolButton label="خط" icon="line" active={activeTool === 'LINE'} onClick={() => run('LINE')} />
        <ToolButton label="Polyline" icon="polyline" onClick={() => run('PLINE')} />
        <ToolButton label="دائرة" icon="circle" onClick={() => run('CIRCLE')} />
        <ToolButton label="قوس" icon="arc" onClick={() => run('ARC')} />
        <ToolButton label="مستطيل" icon="rect" onClick={() => run('RECTANG')} />
        <ToolButton label="نص" icon="text" onClick={() => run('TEXT')} />
        <ToolButton label="بعد" icon="dimension" onClick={() => run('DIMLINEAR')} />
      </div>
      <div className="toolbar-separator" />
      <div className="tool-group">
        <span className="group-label">تعديل</span>
        <ToolButton label="نقل" icon="move" onClick={() => run('MOVE')} />
        <ToolButton label="نسخ" icon="copy" onClick={() => run('COPY')} />
        <ToolButton label="تدوير" icon="rotate" onClick={() => run('ROTATE')} />
        <ToolButton label="تحجيم" icon="scale" onClick={() => run('SCALE')} />
        <ToolButton label="انعكاس" icon="mirror" onClick={() => run('MIRROR')} />
        <ToolButton label="تفجير" icon="explode" onClick={() => run('EXPLODE')} />
        <ToolButton label="إزاحة" icon="offset" onClick={() => run('OFFSET')} />
        <ToolButton label="قص" icon="trim" onClick={() => run('TRIM')} />
        <ToolButton label="إطالة" icon="extend" onClick={() => run('EXTEND')} />
        <ToolButton label="تدوير زاوية" icon="fillet" onClick={() => run('FILLET')} />
        <ToolButton label="شطف" icon="chamfer" onClick={() => run('CHAMFER')} />
        <ToolButton label="مصفوفة" icon="array" onClick={() => run('ARRAY')} />
        <ToolButton label="مط" icon="stretch" onClick={() => run('STRETCH')} />
        <ToolButton label="قطع" icon="break" onClick={() => run('BREAK')} />
        <ToolButton label="وصل" icon="join" onClick={() => run('JOIN')} />
        <ToolButton label="حذف" icon="erase" onClick={() => run('ERASE')} />
        <ToolButton label="تحديد الكل" icon="select" onClick={() => { engineRef.current?.selectAll(); tick(); redraw(); }} />
      </div>
      <div className="toolbar-separator" />
      <div className="tool-group view-tools">
        <button className="view-tool" onClick={fitDrawing} title="إظهار الرسم بالكامل"><Icon name="fit" /><span>ملاءمة</span></button>
        <button className="view-tool" onClick={() => { viewRef.current.pushHistory(); viewRef.current.zoomAt(viewRef.current.width/2, viewRef.current.height/2, 1.25); tick(); }} title="تكبير"><Icon name="plus" /></button>
        <button className="view-tool" onClick={() => { viewRef.current.pushHistory(); viewRef.current.zoomAt(viewRef.current.width/2, viewRef.current.height/2, 0.8); tick(); }} title="تصغير"><Icon name="minus" /></button>
      </div>
      <div className="toolbar-spacer" />
      <div className="current-layer-control"><span>الطبقة</span><select value={doc.settings.currentLayer} onChange={(e) => doc.setSettings({ currentLayer: e.target.value })}>{layerNames.map((l) => <option key={l.name} value={l.name}>{l.name}</option>)}</select><span className="layer-color-dot" style={{ background: aciToHex(doc.getLayer(doc.settings.currentLayer)?.color ?? 7, '#dfe7f2') }} /></div>
      <div className="toolbar-separator" />
      <div className="tool-group toggles">
        <Toggle label="OSNAP" hint="F3" active={!!engine?.snap.osnapOn} onClick={() => { if (engine) engine.snap.osnapOn = !engine.snap.osnapOn; tick(); }} />
        <Toggle label="ORTHO" hint="F8" active={!!engine?.snap.orthoOn} onClick={() => { if (engine) engine.snap.orthoOn = !engine.snap.orthoOn; tick(); }} />
        <Toggle label="POLAR" hint="F10" active={!!engine?.snap.polarOn} onClick={() => { if (engine) engine.snap.polarOn = !engine.snap.polarOn; tick(); }} />
        <Toggle label="GRID" hint="F7" active={!!engine?.grid.on} onClick={() => { if (engine) engine.grid.on = !engine.grid.on; tick(); }} />
      </div>
    </section>

    <main className="workspace">
      <aside className="left-rail" aria-label="أدوات الرسم">
        <button className="rail-button selected" title="التحديد" onClick={() => engine?.cancel()}><Icon name="select" /></button>
        <span className="rail-separator" />
        <button className="rail-button" title="الخط" onClick={() => run('LINE')}><Icon name="line" /></button>
        <button className="rail-button" title="Polyline" onClick={() => run('PLINE')}><Icon name="polyline" /></button>
        <button className="rail-button" title="دائرة" onClick={() => run('CIRCLE')}><Icon name="circle" /></button>
        <button className="rail-button" title="قوس" onClick={() => run('ARC')}><Icon name="arc" /></button>
        <button className="rail-button" title="مستطيل" onClick={() => run('RECTANG')}><Icon name="rect" /></button>
        <span className="rail-separator" />
        <button className="rail-button" title="إدراج بلوك" onClick={() => startInsert()}><Icon name="block" /></button>
        <button className="rail-button" title="تهشير" onClick={() => run('HATCH')}><Icon name="hatch" /></button>
        <button className="rail-button" title="القياس" onClick={() => run('DIST')}><Icon name="measure" /></button>
        <span className="rail-separator" />
        <button className="rail-button" title="جدار معماري" onClick={() => run('WALL')}><Icon name="line" /></button>
        <button className="rail-button" title="شبكة محاور" onClick={() => run('AXISGRID')}><Icon name="select" /></button>
        <button className="rail-button" title="عمود معماري" onClick={() => run('COLUMN')}><Icon name="rect" /></button>
        <button className="rail-button" title="باب" onClick={() => run('DOOR')}><Icon name="arc" /></button>
        <div className="rail-bottom"><button className="rail-button" title="الأوامر" onClick={() => setDialog({ type: 'commands' })}><Icon name="help" /></button></div>
      </aside>

      <section className="drawing-area">
        <div className="canvas-wrap">
          <canvas ref={canvasRef} className="drawing-canvas" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => { dragRef.current = null; }} onPointerLeave={() => { if (!dragRef.current) pointerRef.current = null; hoverRef.current = null; redraw(); }} onWheel={onWheel} onContextMenu={onCanvasContext} aria-label="مساحة الرسم الهندسي" />
          <div className="canvas-breadcrumb"><span className="model-icon">▦</span><b>Model</b><span className="breadcrumb-divider">/</span><span>مساحة النموذج</span></div>
          <div className="canvas-tools"><button title="إظهار الرسم بالكامل" onClick={fitDrawing}><Icon name="fit" /></button><button title="تراجع عن العرض" onClick={() => { viewRef.current.previous(); tick(); }}><Icon name="undo" /></button><span className="zoom-readout">{Math.round(viewRef.current.scale * 100)}%</span></div>
          {doc.size === 0 && <div className="empty-state"><div className="empty-mark"><Icon name="crosshair" /></div><strong>ابدأ رسماً جديداً</strong><span>اكتب LINE أو CIRCLE في سطر الأوامر، أو اختر أداة من الأعلى.</span><button onClick={() => run('LINE')}>ابدأ بخط <kbd>L</kbd></button></div>}
        </div>
      </section>

      <aside className="side-panel">
        <div className="panel-tabs">
          <button className={tab === 'layers' ? 'active' : ''} onClick={() => setTab('layers')}><Icon name="layers" /> الطبقات</button>
          <button className={tab === 'blocks' ? 'active' : ''} onClick={() => setTab('blocks')}><Icon name="block" /> المكتبة</button>
          <button className={tab === 'properties' ? 'active' : ''} onClick={() => setTab('properties')}><Icon name="sliders" /> الخصائص</button>
        </div>
        {tab === 'layers' && <div className="side-content">
          <div className="panel-heading"><div><strong>طبقات الرسم</strong><small>{layerNames.length} طبقات</small></div><button className="small-icon-btn" title="طبقة جديدة" onClick={() => { setNewLayerName(''); document.getElementById('new-layer')?.focus(); }}><Icon name="plus" /></button></div>
          <form className="new-layer-form" onSubmit={(e) => { e.preventDefault(); const name = newLayerName.trim(); if (!name) return; doc.ensureLayer(name); doc.setSettings({ currentLayer: name }); setNewLayerName(''); }}>
            <input id="new-layer" value={newLayerName} onChange={(e) => setNewLayerName(e.target.value)} placeholder="اسم طبقة جديدة" aria-label="اسم طبقة جديدة" />
            <button type="submit" aria-label="إضافة طبقة"><Icon name="plus" /></button>
          </form>
          <div className="layers-header"><span>الاسم</span><span>لون</span><span>مرئي</span></div>
          <div className="layer-list">{layerNames.map((layer) => <LayerRow key={layer.name} layer={layer} active={layer.name.toUpperCase() === doc.settings.currentLayer.toUpperCase()} onActivate={() => doc.setSettings({ currentLayer: layer.name })} onToggle={() => doc.updateLayer(layer.name, { off: !layer.off })} onLock={() => doc.updateLayer(layer.name, { locked: !layer.locked })} />)}</div>
          <div className="layer-footer"><span className="legend-dot" /> الحالية: <b>{doc.settings.currentLayer}</b></div>
          <section className="properties-mini"><div className="section-title"><strong>الخصائص</strong><span>{selectedEntities.length ? `${selectedEntities.length} محدد` : 'لا يوجد تحديد'}</span></div>{activeEntity ? <EntityProperties entity={activeEntity} layers={layerNames} doc={doc} tick={tick} /> : <div className="no-selection">حدد عنصراً لعرض خصائصه وتعديلها.</div>}</section>
        </div>}
        {tab === 'blocks' && <div className="side-content blocks-content">
          <div className="panel-heading"><div><strong>مكتبة الكتل</strong><small>{assets?.blocks.length ?? '—'} كتلة</small></div><button className="small-icon-btn" onClick={() => startInsert()} title="إدراج بالاسم"><Icon name="plus" /></button></div>
          <div className="search-box"><Icon name="search" /><input value={blockSearch} onChange={(e) => setBlockSearch(e.target.value)} placeholder="ابحث عن باب، نافذة، أثاث…" /></div>
          <div className="blocks-grid">{filteredThumbnails.map((item) => <BlockCard key={item.id} item={item} onInsert={() => startInsert(item)} />)}</div>
          {!assets && <div className="loading-note">جارٍ تحميل مكتبة الأصول…</div>}
        </div>}
        {tab === 'properties' && <div className="side-content properties-content">
          <div className="panel-heading"><div><strong>خصائص التحديد</strong><small>{selectedEntities.length ? `${selectedEntities.length} عنصر` : 'نموذج الرسم'}</small></div></div>
          {activeEntity ? <EntityProperties entity={activeEntity} layers={layerNames} doc={doc} tick={tick} /> : selectedEntities.length > 1 ? <div className="multi-selection"><div className="multi-icon"><Icon name="select" /></div><strong>{selectedEntities.length} عناصر محددة</strong><span>اسحب نقاط المسك الزرقاء للتعديل (Enter يبدّل: مدّ ← نقل ← تدوير ← تحجيم ← انعكاس)، أو استخدم نقل/نسخ/تدوير/تحجيم/انعكاس/تفجير/حذف على التحديد.</span></div> : <div className="drawing-info"><div className="drawing-symbol"><Icon name="cad" /></div><strong>{doc.name}</strong><div className="info-row"><span>الوحدات</span><b>{UNIT_NAMES[doc.units] ?? 'مجهول'}</b></div><div className="info-row"><span>العناصر</span><b>{doc.size.toLocaleString()}</b></div><div className="info-row"><span>الطبقات</span><b>{doc.layers.size}</b></div><div className="info-row"><span>مقياس الرسم</span><b>1:{doc.settings.drawingScale}</b></div></div>}
        </div>}
      </aside>
    </main>

    <section className="command-dock">
      <div className="command-head"><div className="command-title"><span className="command-pulse" /><strong>سطر الأوامر</strong><span className="command-tip">اكتب أمراً أو إحداثيات</span></div><button className="dock-collapse" title="إخفاء السجل" onClick={() => commandInputRef.current?.focus()}><Icon name="chevron" /></button></div>
      <div className="command-output" aria-live="polite">{logs.map((line, index) => <div key={`${index}-${line.text}`} className={`log-line ${line.kind}`}><span className="log-mark">{line.kind === 'error' ? '!' : line.kind === 'prompt' ? '›' : line.kind === 'cmd' ? '⌘' : '·'}</span><span>{line.text}</span></div>)}<div className="prompt-row"><span className="prompt-symbol">›</span><span className="prompt-text">{promptText}</span></div></div>
      <form className="command-entry" onSubmit={onCommandSubmit}><span className="entry-symbol">⌘</span><input ref={commandInputRef} value={commandValue} onChange={(e) => setCommandValue(e.target.value)} placeholder={engine?.prompt ? 'أدخل قيمة أو كلمة مفتاحية…' : 'اكتب أمراً مثل LINE أو CIRCLE أو L'} dir="ltr" autoComplete="off" spellCheck={false} aria-label="سطر الأوامر" /><button type="submit" title="تنفيذ الأمر"><Icon name="enter" /></button><span className="command-hint">Enter</span></form>
    </section>

    <footer className="statusbar">
      <div className="status-left"><span className="status-online"><i /> متصل محلياً</span><span className="status-separator" /><span className="status-saved">{autoSaved ? <><Icon name="check" /> نسخة استرداد محلية محفوظة</> : <><Icon name="cloud" /> جارٍ الحفظ محلياً</>}</span></div>
      <div className="status-right"><span>{selectedEntities.length ? `${selectedEntities.length} محدد` : 'جاهز'}</span><span className="status-separator" /><span>{UNIT_NAMES[doc.units] ?? 'مم'}</span><span className="status-separator" /><Toggle label="LWT" active={engine?.lineweights ?? false} onClick={() => { if (engine) engine.lineweights = !engine.lineweights; tick(); }} compact /><button className="status-snap" onClick={() => setDialog({ type: 'commands' })}><Icon name="target" /> الالتقاط</button></div>
    </footer>

    <input ref={fileInputRef} type="file" accept=".yqd,.json,application/json" className="hidden-file-input" onChange={onFileSelected} />
    {dialog?.type === 'insert' && <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) finishInsertDialog(null); }}><div className="modal-card library-modal"><div className="modal-head"><div><span className="modal-icon"><Icon name="block" /></span><div><strong>إدراج كتلة</strong><small>اختر كتلة من مكتبة الموارد</small></div></div><button onClick={() => finishInsertDialog(null)} aria-label="إغلاق">×</button></div><div className="modal-body"><div className="search-box"><Icon name="search" /><input autoFocus value={blockSearch} onChange={(e) => setBlockSearch(e.target.value)} placeholder="ابحث في مكتبة الكتل" /></div><div className="blocks-grid modal-blocks">{filteredThumbnails.slice(0, 36).map((item) => <BlockCard key={item.id} item={item} onInsert={() => finishInsertDialog(item.name)} />)}</div></div><div className="modal-foot"><span>اختر العنصر ثم حدّد نقطة الإدراج في مساحة الرسم.</span><button className="secondary-button" onClick={() => finishInsertDialog(null)}>إلغاء</button></div></div></div>}
    {dialog?.type === 'mtext' && <MTextDialog initial={dialog} onCancel={() => finishMtextDialog(null)} onSubmit={(value) => finishMtextDialog(value)} />}
    {dialog?.type === 'commands' && <CommandBrowser commands={[...(assets?.aliases.yqCommands ?? []), ...ARCHITECTURE_COMMAND_CATALOG]} query={commandSearch} setQuery={setCommandSearch} onClose={() => setDialog(null)} onRun={(id) => { setDialog(null); run(id); }} />}
    {toast && <div className="toast"><Icon name="check" />{toast}</div>}
  </div>;
}

function ToolButton({ label, icon, onClick, active = false }: { label: string; icon: string; onClick: () => void; active?: boolean }) {
  return <button className={`tool-button ${active ? 'active' : ''}`} onClick={onClick} title={label}><Icon name={icon} /><span>{label}</span></button>;
}
function Toggle({ label, hint, active, onClick, compact = false }: { label: string; hint?: string; active: boolean; onClick: () => void; compact?: boolean }) {
  return <button onClick={onClick} className={`toggle-button ${active ? 'on' : ''} ${compact ? 'compact' : ''}`} title={hint ? `${label} · ${hint}` : label}><span className="toggle-led" />{label}{hint && <kbd>{hint}</kbd>}</button>;
}
function LayerRow({ layer, active, onActivate, onToggle, onLock }: { layer: Layer; active: boolean; onActivate: () => void; onToggle: () => void; onLock: () => void }) {
  const color = aciToHex(layer.color, '#dce4ef');
  return <div className={`layer-row ${active ? 'active' : ''}`} onDoubleClick={onActivate}>
    <button className="layer-name" onClick={onActivate}><span className="layer-icon" style={{ color }}><Icon name="layers" /></span><span>{layer.name}</span>{active && <i className="current-indicator" />}</button>
    <button className="layer-color" onClick={onActivate} title={`ACI ${layer.color}`}><i style={{ background: color }} /></button>
    <button className={`layer-visible ${layer.off || layer.frozen ? 'off' : ''}`} onClick={onToggle} title={layer.off || layer.frozen ? 'إظهار الطبقة' : 'إخفاء الطبقة'}><Icon name={layer.off || layer.frozen ? 'eye-off' : 'eye'} /></button>
    <button className={`layer-lock ${layer.locked ? 'locked' : ''}`} onClick={onLock} title={layer.locked ? 'إلغاء القفل' : 'قفل الطبقة'}><Icon name={layer.locked ? 'lock' : 'unlock'} /></button>
  </div>;
}
function EntityProperties({ entity, layers, doc, tick }: { entity: Entity; layers: Layer[]; doc: CadDocument; tick: () => void }) {
  const layer = doc.getLayer(entity.layer)?.name ?? '0';
  const geom = entity.type === 'LINE' ? `${fmt(entity.a[0])}, ${fmt(entity.a[1])} → ${fmt(entity.b[0])}, ${fmt(entity.b[1])}`
    : entity.type === 'CIRCLE' || entity.type === 'ARC' ? `R ${fmt(entity.r)}`
    : entity.type === 'TEXT' || entity.type === 'MTEXT' ? entity.text.replace(/\\P/g, ' ').slice(0, 44)
    : entity.type === 'LWPOLYLINE' ? `${entity.pts.length} نقاط · ${entity.closed ? 'مغلق' : 'مفتوح'}`
    : entity.type === 'INSERT' ? entity.name
    : entity.type === 'DIMENSION' ? 'بُعد هندسي' : entity.type;
  return <div className="entity-properties">
    <div className="property-row"><span>النوع</span><b className="type-pill">{entity.type}</b></div>
    <div className="property-row"><span>الطبقة</span><select value={layer} onChange={(e) => { doc.update(entity.id, { layer: e.target.value }); tick(); }}>{layers.map((l) => <option key={l.name} value={l.name}>{l.name}</option>)}</select></div>
    <div className="property-row"><span>المحتوى / الهندسة</span><small className="geometry-value">{geom}</small></div>
    <div className="property-row"><span>اللون</span><div className="color-property"><i style={{ background: aciToHex(entity.color ?? doc.getLayer(layer)?.color ?? 7, '#e2e8f0') }} /><small>{entity.color ?? 'حسب الطبقة'}</small></div></div>
  </div>;
}
function BlockCard({ item, onInsert }: { item: ThumbnailEntry; onInsert: () => void }) {
  return <button className="block-card" onClick={onInsert} title={`إدراج ${item.name}`}><span className="block-preview"><img src={assetPath(item.svg)} loading="lazy" alt="" onError={(e) => { e.currentTarget.style.display = 'none'; }} /><span className="block-fallback"><Icon name="block" /></span></span><span className="block-name">{item.name}</span></button>;
}
function MTextDialog({ initial, onCancel, onSubmit }: { initial: Extract<DialogState, { type: 'mtext' }>; onCancel: () => void; onSubmit: (value: { text: string; height?: number }) => void }) {
  const [text, setText] = useState(initial.text); const [height, setHeight] = useState(initial.height);
  return <div className="modal-backdrop"><form className="modal-card mtext-modal" onSubmit={(e) => { e.preventDefault(); onSubmit({ text, height }); }}><div className="modal-head"><div><span className="modal-icon"><Icon name="text" /></span><div><strong>نص متعدد الأسطر</strong><small>اكتب النص ثم أكّد</small></div></div><button type="button" onClick={onCancel}>×</button></div><div className="mtext-controls"><label>ارتفاع النص<input type="number" min="0.1" step="0.1" value={height} onChange={(e) => setHeight(Number(e.target.value))} /></label></div><textarea autoFocus rows={7} value={text} onChange={(e) => setText(e.target.value)} placeholder="اكتب النص هنا…" /><div className="modal-foot"><span>تُحفظ الأسطر المتعددة داخل عنصر MTEXT.</span><button className="secondary-button" type="button" onClick={onCancel}>إلغاء</button><button className="primary-button" type="submit">إضافة النص</button></div></form></div>;
}
function CommandBrowser({ commands, query, setQuery, onClose, onRun }: { commands: EditorAssets['aliases']['yqCommands']; query: string; setQuery: (s: string) => void; onClose: () => void; onRun: (id: string) => void }) {
  const all = commands.filter((c) => `${c.id} ${c.alias} ${c.en} ${c.zh}`.toLowerCase().includes(query.toLowerCase())).slice(0, 60);
  return <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><div className="modal-card command-browser"><div className="modal-head"><div><span className="modal-icon"><Icon name="command" /></span><div><strong>دليل الأوامر</strong><small>الأوامر المدعومة وما هو مخطط للمراحل القادمة</small></div></div><button onClick={onClose}>×</button></div><div className="command-search"><Icon name="search" /><input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="ابحث بالاسم أو الاختصار" /></div><div className="command-list">{all.map((c) => <button className="command-item" key={c.id} onClick={() => onRun(c.id)}><span className="command-priority">{'★'.repeat(Math.min(c.stars ?? 0, 5))}</span><span className="command-name"><b>{c.en}</b><small>{c.id}</small></span><kbd>{c.alias || '—'}</kbd><span className="command-arrow">↵</span></button>)}</div><div className="modal-foot"><span>تتضمن القائمة كتالوج YQArch المرفق؛ التنفيذ يقتصر على أوامر المحرك الحالية.</span><button className="secondary-button" onClick={onClose}>إغلاق</button></div></div></div>;
}
function Icon({ name }: { name: string }) {
  const shared = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const };
  const paths: Record<string, ReactNode> = {
    line: <><path d="M5 19 19 5"/><circle cx="5" cy="19" r="1.5"/><circle cx="19" cy="5" r="1.5"/></>,
    polyline: <><path d="m4 18 6-12 5 10 5-10"/><circle cx="4" cy="18" r="1"/><circle cx="10" cy="6" r="1"/><circle cx="15" cy="16" r="1"/><circle cx="20" cy="6" r="1"/></>,
    circle: <><circle cx="12" cy="12" r="7.5"/><path d="M12 12 17.3 6.7"/><circle cx="12" cy="12" r="1"/></>,
    arc: <><path d="M5 18a9 9 0 0 1 13-12"/><path d="M4 15v4h4"/></>,
    rect: <><rect x="5" y="6" width="14" height="12" rx=".5"/><path d="M5 10h14" opacity=".45"/></>,
    text: <><path d="M4 6V4h16v2M12 4v16m-4 0h8"/><path d="M8 20h8"/></>,
    dimension: <><path d="M5 6v12M19 6v12M5 12h14M8 9l-3 3 3 3M16 9l3 3-3 3"/></>,
    move: <><path d="M12 3v18M3 12h18M12 3l-3 3m3-3 3 3M12 21l-3-3m3 3 3-3M3 12l3-3m-3 3 3 3m12-3 3-3m-3 3 3 3"/></>,
    copy: <><rect x="8" y="8" width="11" height="11" rx="1"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></>,
    rotate: <><path d="M20 11a8 8 0 1 0 1 4"/><path d="M20 4v7h-7"/></>,
    scale: <><rect x="4" y="10" width="10" height="10"/><path d="M10 4h10v10" strokeDasharray="2 2"/><path d="m12 12 7-7m-4 0h4v4"/></>,
    mirror: <><path d="M12 3v18" strokeDasharray="2 2"/><path d="M9 7 4 17h5zM15 7l5 10h-5z"/></>,
    explode: <><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/><rect x="10" y="10" width="4" height="4"/></>,
    offset: <><path d="M4 20V9a5 5 0 0 1 5-5h11"/><path d="M9 20v-9a2 2 0 0 1 2-2h9" strokeDasharray="2 2"/></>,
    trim: <><path d="M12 3v18"/><path d="M3 12h6" strokeDasharray="2 2"/><path d="M12 12h9"/><path d="m5 9 3 6M8 9l-3 6"/></>,
    extend: <><path d="M20 3v18"/><path d="M4 12h8"/><path d="M12 12h8" strokeDasharray="2 2"/><path d="m16 9 3 3-3 3"/></>,
    fillet: <><path d="M4 20V12a8 8 0 0 1 8-8h8"/><path d="M4 4h4M4 4v4" strokeDasharray="2 2"/></>,
    chamfer: <><path d="M4 20V10l6-6h10"/><path d="M4 4h6M4 4v6" strokeDasharray="2 2"/></>,
    array: <><rect x="3" y="3" width="6" height="6"/><rect x="15" y="3" width="6" height="6"/><rect x="3" y="15" width="6" height="6"/><rect x="15" y="15" width="6" height="6"/></>,
    stretch: <><path d="M3 7h8v10H3"/><path d="M11 7l6 0M11 17h6M17 7v10" strokeDasharray="2 2"/><path d="m18 12h4m-2-2 2 2-2 2"/></>,
    break: <><path d="M3 12h7M14 12h7"/><path d="m9 8 2 8M13 8l2 8"/></>,
    join: <><path d="M3 12h7M14 12h7"/><circle cx="12" cy="12" r="2"/></>,
    select: <><path d="M4 4h4M12 4h3M19 4v4M19 12v3M4 8v3M4 15v5h5" strokeDasharray="0"/><path d="m11 11 9 3-4 1.5L14.5 20z"/></>,
    erase: <><path d="m4 15 8-10 8 6-8 10H7z"/><path d="m10 19 6-8"/></>,
    fit: <><path d="M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4"/><path d="m9 15 6-6m-5 0h5v5"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>, minus: <path d="M5 12h14"/>,
    new: <><path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9z"/><path d="M13 3v7h7M12 13v6m-3-3h6"/></>,
    open: <><path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v1"/><path d="M3 9h18l-2 10H5z"/></>,
    save: <><path d="M5 3h12l4 4v14H3V5a2 2 0 0 1 2-2z"/><path d="M7 3v6h10V3M7 21v-8h10v8"/></>,
    undo: <><path d="M9 14 4 9l5-5"/><path d="M4 9h9a7 7 0 0 1 7 7v2"/></>, redo: <><path d="m15 14 5-5-5-5"/><path d="M20 9h-9a7 7 0 0 0-7 7v2"/></>,
    layers: <><path d="m12 3 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></>,
    block: <><rect x="4" y="4" width="6" height="6"/><rect x="14" y="4" width="6" height="6"/><rect x="4" y="14" width="6" height="6"/><rect x="14" y="14" width="6" height="6"/></>,
    hatch: <><path d="M4 19 18 5M8 20 20 8M4 15 15 4"/><path d="M4 4h16v16H4z"/></>,
    measure: <><path d="M3 16 16 3l5 5L8 21z"/><path d="m13 6 2 2m-5 1 2 2m-5 1 2 2"/></>,
    help: <><circle cx="12" cy="12" r="9"/><path d="M9.6 9a2.5 2.5 0 1 1 4.7 1.2c-.8 1.1-2.3 1.4-2.3 3M12 17h.01"/></>,
    eye: <><path d="M2.5 12s3.2-6 9.5-6 9.5 6 9.5 6-3.2 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></>,
    'eye-off': <><path d="m3 3 18 18M10.6 6.2A10.7 10.7 0 0 1 12 6c6.3 0 9.5 6 9.5 6a15 15 0 0 1-3 3.7M6.2 6.2C3.8 7.8 2.5 12 2.5 12s3.2 6 9.5 6c1 0 2-.2 2.9-.5"/></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3"/></>, unlock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.5-2"/></>,
    sliders: <><path d="M4 6h9m4 0h3M4 12h3m4 0h9M4 18h9m4 0h3"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="15" cy="18" r="2"/></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></>,
    enter: <><path d="M5 5v6a2 2 0 0 0 2 2h12"/><path d="m15 9 4 4-4 4"/></>,
    chevron: <path d="m7 10 5 5 5-5"/>,
    check: <><path d="m5 12 4 4L19 6"/></>, cloud: <><path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 8a5 5 0 0 0 1 10Z"/><path d="M12 10v6m-2-2 2 2 2-2"/></>,
    target: <><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3m10 7h-3M12 22v-3M2 12h3"/></>,
    command: <><path d="M9 7 6 12l3 5m6-10 3 5-3 5"/><path d="M14 5 10 19"/></>,
    crosshair: <><circle cx="12" cy="12" r="5"/><path d="M12 2v5m0 10v5M2 12h5m10 0h5"/></>,
    cad: <><path d="m4 18 5-12 4 9 3-6 4 9"/><path d="M3 21h18"/></>,
  };
  return <svg {...shared}>{paths[name] ?? paths.command}</svg>;
}
function findLibraryEntry(assets: EditorAssets | null, name: string): LibraryEntry | undefined {
  if (!assets) return undefined;
  const key = name.toLowerCase();
  return assets.blocks.find((b) => displayName(b).toLowerCase() === key || b.source.toLowerCase() === key || b.file.toLowerCase() === key || b.source.split('/').at(-1)?.replace(/\.dwg$/i, '').toLowerCase() === key);
}
function displayName(entry: LibraryEntry) { return entry.source.split('/').at(-1)?.replace(/\.dwg$/i, '') ?? entry.file; }
function fmt(n: number) { return Number(n.toFixed(2)).toString(); }
function downloadDrawing(doc: CadDocument, requested: string) {
  const base = requested.replace(/\.(yqd|json)$/i, '') || doc.name || 'Drawing1';
  const filename = /^[\x20-\x7E]+$/.test(base) ? base.replace(/[^a-zA-Z0-9._-]+/g, '-') : 'YQArch-Drawing';
  const blob = new Blob([serialize(doc, true)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = `${filename}.yqd`; a.style.display = 'none'; document.body.appendChild(a); a.click();
  window.setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}
