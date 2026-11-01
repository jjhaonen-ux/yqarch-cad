/**
 * YQArch commands implemented in the web engine (aliases from shortcut.yqs: yq, sd, yqunits, yquser, er*, ss*, bv/gj/zs/fh).
 * Other YQArch commands resolve through the alias table and report that they are planned for a later phase.
 */
import type { Entity, Layer } from '../types';
import { kw, type CommandDef, type CommandEngine } from './engine';
import { matchLayers, setCurrentLayer, UNIT_CODES, UNIT_KW } from './system';
import { UNIT_NAMES } from '../model/settings';

const yq = (id: string, title: [string, string], run: CommandDef['run'], noUndo = false): CommandDef => ({ name: id, title, run, noUndo, group: 'yq' });
const layersOf = (c: CommandEngine, ids: number[]) => { const s = new Map<string, Layer>(); for (const id of ids) { const e = c.doc.get(id); const l = e && c.doc.getLayer(e.layer); if (l) s.set(l.name.toUpperCase(), l); } return [...s.values()]; };
const isCurrent = (c: CommandEngine, l: Layer) => l.name.toUpperCase() === c.doc.settings.currentLayer.toUpperCase();
const done = (c: CommandEngine, n: number) => c.print([`${n} layer(s) changed.`, `تم تعديل ${n} طبقة.`]);

export const YQ_COMMANDS: CommandDef[] = [
  yq('yqarch', ['YQArch command overview', 'دليل أوامر YQArch'], async (c) => {
    const d = c.host.dialog?.('commands');
    if (d) { await d; return; }
    c.print(['Type a YQArch alias (e.g. sd, erc, sser) or an AutoCAD command.', 'اكتب اختصار YQArch (مثل sd، erc، sser) أو أمر AutoCAD.']);
  }, true),
  yq('yq_setdwgscale', ['Set drawing scale', 'تعيين مقياس الرسم'], async (c) => {
    const list = c.host.scaleList?.().filter((v) => v > 0) ?? [];
    if (list.length) c.print(`${c.t(['Scales', 'المقاييس'])}: ${list.map((v) => '1:' + v).join('  ')}`);
    const s = await c.getString(['Enter drawing scale 1:', 'أدخل مقياس الرسم 1:'], { defaultText: String(c.doc.settings.drawingScale) });
    const v = Number(String(s ?? '').replace(/^1\s*:\s*/, ''));
    if (!Number.isFinite(v) || v <= 0) { c.error(['Invalid scale.', 'مقياس غير صالح.']); return; }
    c.doc.setSettings({ drawingScale: v, ltscale: v });
    c.print([`Drawing scale 1:${v} (text, dimensions, hatch and linetype scale follow it).`, `مقياس الرسم 1:${v} (يتبعه ارتفاع النصوص والأبعاد والتهشير ومقياس الخطوط).`]);
  }),
  yq('yq_setunits', ['Default drawing units', 'وحدات الرسم الافتراضية'], async (c) => {
    const cur = Object.entries(UNIT_CODES).find(([, v]) => v === c.doc.units)?.[0] ?? 'MM';
    const k = await c.getKeyword(['Specify drawing units', 'حدد وحدات الرسم'], UNIT_KW, { defaultText: cur });
    if (k && UNIT_CODES[k] !== c.doc.units) { c.doc.setUnits(UNIT_CODES[k]); c.print(`→ ${UNIT_NAMES[UNIT_CODES[k]]}`); }
  }),
  yq('yq_setuser', ['Select current user profile', 'اختيار ملف المستخدم'], async (c) => {
    const profiles = c.host.profiles?.() ?? [];
    if (!profiles.length || !c.host.setProfile) { c.error(['No profiles available.', 'لا توجد ملفات مستخدمين.']); return; }
    const kws = profiles.map((p, i) => kw(String(i + 1), p, p));
    const k = await c.getKeyword(['Select user', 'اختر المستخدم'], kws, { defaultText: String(Math.max(1, profiles.indexOf(c.doc.settings.profile) + 1)) });
    if (!k) return;
    const name = profiles[Number(k) - 1] ?? k;
    if (await c.host.setProfile(name)) c.print([`Current user: ${name}`, `المستخدم الحالي: ${name}`]);
  }, true),
  // ---------- layer tools (er*) ----------
  yq('yq_layer_2current', ['Change to current layer', 'نقل إلى الطبقة الحالية'], async (c) => {
    const ids = await c.getSelection();
    for (const id of ids) c.doc.update(id, { layer: c.doc.settings.currentLayer } as Partial<Entity>);
    c.print([`${ids.length} object(s) moved to layer "${c.doc.settings.currentLayer}".`, `نُقل ${ids.length} كائن إلى الطبقة "${c.doc.settings.currentLayer}".`]);
  }),
  yq('yq_layer_new', ['Make a new layer', 'طبقة جديدة'], async (c) => {
    const name = await c.getString(['Enter new layer name', 'أدخل اسم الطبقة الجديدة'], { allowSpaces: true });
    if (!name) return;
    const col = await c.getString(['Enter color index (1-255)', 'أدخل رقم اللون (1-255)'], { defaultText: '7' });
    const v = Math.round(Number(col));
    const l = c.doc.ensureLayer(name);
    if (v >= 1 && v <= 255 && v !== l.color) c.doc.updateLayer(l.name, { color: v });
    setCurrentLayer(c, l.name);
  }),
  yq('yq_layer_current', ['Set current layer by object', 'تعيين الطبقة الحالية من كائن'], async (c) => {
    const p = await c.getEntity(['Select object whose layer will become current', 'اختر كائناً لتصبح طبقته هي الحالية'], { includeLocked: true });
    if (!p || typeof p === 'string') return;
    const e = c.doc.get(p.id)!;
    setCurrentLayer(c, e.layer);
    c.print([`Current layer: "${e.layer}"`, `الطبقة الحالية: "${e.layer}"`]);
  }),
  yq('yq_layer_iso', ['Isolate layers', 'عزل الطبقات'], async (c) => {
    const keep = new Set(layersOf(c, await c.getSelection()).map((l) => l.name.toUpperCase()));
    if (!keep.size) return;
    let n = 0;
    for (const l of [...c.doc.layers.values()]) { const off = !keep.has(l.name.toUpperCase()); if (l.off !== off) { c.doc.updateLayer(l.name, { off }); n++; } }
    if (!keep.has(c.doc.settings.currentLayer.toUpperCase())) setCurrentLayer(c, [...keep][0]);
    done(c, n);
  }),
  yq('yq_layer_off', ['Turn off layers', 'إطفاء الطبقات'], async (c) => {
    const ls = layersOf(c, await c.getSelection(['Select objects on layers to turn off', 'اختر كائنات على الطبقات المراد إطفاؤها']));
    for (const l of ls) c.doc.updateLayer(l.name, { off: true });
    done(c, ls.length);
  }),
  yq('yq_layer_off_all', ['Turn off all layers (except current)', 'إطفاء كل الطبقات عدا الحالية'], async (c) => {
    let n = 0; for (const l of [...c.doc.layers.values()]) if (!isCurrent(c, l) && !l.off) { c.doc.updateLayer(l.name, { off: true }); n++; }
    done(c, n);
  }),
  yq('yq_layer_on', ['Turn on layers', 'تشغيل طبقات'], async (c) => {
    const off = [...c.doc.layers.values()].filter((l) => l.off).map((l) => l.name);
    if (!off.length) { c.print(['All layers are on.', 'كل الطبقات مشغّلة.']); return; }
    c.print(`${c.t(['Off layers', 'الطبقات المطفأة'])}: ${off.join(', ')}`);
    const s = await c.getString(['Enter layer name(s) to turn on (wildcards allowed)', 'أدخل أسماء الطبقات المراد تشغيلها (يدعم *)'], { defaultText: '*' });
    if (!s) return;
    const ls = matchLayers(c, s).filter((l) => l.off);
    for (const l of ls) c.doc.updateLayer(l.name, { off: false });
    done(c, ls.length);
  }),
  yq('yq_layer_on_all', ['Turn on all layers', 'تشغيل كل الطبقات'], async (c) => {
    let n = 0; for (const l of [...c.doc.layers.values()]) if (l.off) { c.doc.updateLayer(l.name, { off: false }); n++; }
    done(c, n);
  }),
  yq('yq_layer_on2off', ['Swap layers on/off', 'عكس حالة تشغيل الطبقات'], async (c) => {
    let n = 0; for (const l of [...c.doc.layers.values()]) { if (isCurrent(c, l)) continue; c.doc.updateLayer(l.name, { off: !l.off }); n++; }
    done(c, n);
  }),
  yq('yq_layer_lock', ['Lock layers', 'قفل الطبقات'], async (c) => {
    const ls = layersOf(c, await c.getSelection()); for (const l of ls) c.doc.updateLayer(l.name, { locked: true }); done(c, ls.length);
  }),
  yq('yq_layer_iso_lock', ['Lock all other layers', 'قفل الطبقات غير المختارة'], async (c) => {
    const keep = new Set(layersOf(c, await c.getSelection(['Select objects on layers to keep unlocked', 'اختر كائنات على الطبقات التي تبقى مفتوحة'], { includeLocked: true })).map((l) => l.name.toUpperCase()));
    if (!keep.size) return;
    let n = 0; for (const l of [...c.doc.layers.values()]) { const locked = !keep.has(l.name.toUpperCase()); if (l.locked !== locked) { c.doc.updateLayer(l.name, { locked }); n++; } }
    done(c, n);
  }),
  yq('yq_layer_unlock', ['Unlock layers', 'فتح قفل الطبقات'], async (c) => {
    const ids = await c.getSelection(['Select objects on locked layers', 'اختر كائنات على طبقات مقفلة'], { includeLocked: true });
    const ls = layersOf(c, ids).filter((l) => l.locked); for (const l of ls) c.doc.updateLayer(l.name, { locked: false }); done(c, ls.length);
  }),
  yq('yq_layer_freeze', ['Freeze layers', 'تجميد الطبقات'], async (c) => {
    const ls = layersOf(c, await c.getSelection()).filter((l) => !isCurrent(c, l)); for (const l of ls) c.doc.updateLayer(l.name, { frozen: true }); done(c, ls.length);
  }),
  yq('yq_layer_iso_freeze', ['Freeze all other layers', 'تجميد الطبقات غير المختارة'], async (c) => {
    const keep = new Set(layersOf(c, await c.getSelection()).map((l) => l.name.toUpperCase()));
    if (!keep.size) return;
    let n = 0; for (const l of [...c.doc.layers.values()]) if (!keep.has(l.name.toUpperCase()) && !isCurrent(c, l) && !l.frozen) { c.doc.updateLayer(l.name, { frozen: true }); n++; }
    done(c, n);
  }),
  yq('yq_layer_thaw', ['Thaw all layers', 'إذابة كل الطبقات'], async (c) => {
    let n = 0; for (const l of [...c.doc.layers.values()]) if (l.frozen) { c.doc.updateLayer(l.name, { frozen: false }); n++; } done(c, n);
  }),
  yq('yq_layer_showall', ['Thaw, unlock and turn on all layers', 'إذابة وفتح وتشغيل كل الطبقات'], async (c) => {
    let n = 0; for (const l of [...c.doc.layers.values()]) if (l.frozen || l.locked || l.off) { c.doc.updateLayer(l.name, { frozen: false, locked: false, off: false }); n++; } done(c, n);
  }),
  // ---------- match brush (ss*) ----------
  ...([
    ['yq_match_layer', ['Match layer', 'مطابقة الطبقة'], (s: Entity) => ({ layer: s.layer }), undefined],
    ['yq_match_color', ['Match color', 'مطابقة اللون'], (s: Entity) => ({ color: s.color ?? 256, trueColor: s.trueColor }), undefined],
    ['yq_match_layercolor', ['Match layer and color', 'مطابقة الطبقة واللون'], (s: Entity) => ({ layer: s.layer, color: s.color ?? 256, trueColor: s.trueColor }), undefined],
    ['yq_match_linetype', ['Match linetype', 'مطابقة نوع الخط'], (s: Entity) => ({ linetype: s.linetype, ltScale: s.ltScale }), undefined],
    ['yq_match_textheight', ['Match text height', 'مطابقة ارتفاع النص'], (s: Entity) => ('h' in s ? { h: s.h } : {}), 'text'],
    ['yq_match_content', ['Match text content', 'مطابقة محتوى النص'], (s: Entity) => ('text' in s ? { text: s.text } : {}), 'text'],
    ['yq_match_style', ['Match text style', 'مطابقة نمط النص'], (s: Entity) => ('style' in s ? { style: s.style } : {}), 'text'],
  ] as [string, [string, string], (s: Entity) => Partial<Entity>, 'text' | undefined][]).map(([id, title, props, kind]) => yq(id, title, async (c) => {
    const isText = (e: Entity) => e.type === 'TEXT' || e.type === 'MTEXT' || e.type === 'ATTDEF';
    const src = await c.getEntity(['Select source object', 'اختر الكائن المصدر'], { filter: kind === 'text' ? isText : undefined, includeLocked: true });
    if (!src || typeof src === 'string') return;
    const patch = props(c.doc.get(src.id)!);
    const ids = await c.getSelection(['Select destination object(s)', 'اختر الكائنات الهدف'], { usePickfirst: false, filter: kind === 'text' ? isText : undefined });
    let n = 0;
    for (const id of ids) if (id !== src.id) { c.doc.update(id, (e) => { const o = { ...e, ...patch } as Entity; if ((patch as { color?: number }).color === 256) delete o.color; return o; }); n++; }
    c.print([`${n} object(s) matched.`, `تمت مطابقة ${n} كائن.`]);
  })),
  // ---------- block libraries ----------
  ...([['yq_blockviewer', 'user'], ['yq_sldcomponents', 'components'], ['yq_slddecoration', 'decoration'], ['yq_sldsymbols', 'symbols']] as const).map(([id, cat]) =>
    yq(id, ['Block library', 'مكتبة البلوكات'], async (c) => {
      const d = c.host.dialog?.('library', cat);
      if (d) await d; else c.print(['The block library panel is available in the editor UI.', 'لوحة مكتبة البلوكات متاحة في واجهة المحرر.']);
    }, true)),
];
