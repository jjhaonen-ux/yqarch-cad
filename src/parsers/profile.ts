/**
 * Parsers for the small data files inside a YQArch user profile folder (user1, user2, userHBA, userCCD...).
 * Field meanings come from the header comments of each file; where YQArch does not document a field,
 * it is kept under `extra` (raw) instead of guessing.
 */
import { isCommentOrBlank, num, splitSmart, stripComment, yesNo } from './csv.js';

const dataLines = (text: string) =>
  text.split('\n').filter((l) => !isCommentOrBlank(l)).map((l) => stripComment(l)[0].trim()).filter(Boolean);

// layers.txt — 图层名称,颜色号(1-255),线型名称,线宽,是否打印该层(yes/no),说明
export interface LayerDef { name: string; color: number | null; linetype: string; lineweight: number | null; plot: boolean; description: string }
export function parseLayers(text: string): LayerDef[] {
  return dataLines(text).map((l) => {
    const [name, color, linetype = 'Continuous', lw, plot, ...desc] = splitSmart(l);
    return { name, color: num(color), linetype: linetype || 'Continuous', lineweight: num(lw), plot: yesNo(plot) ?? true, description: desc.join(',') };
  });
}

// relay01.txt — 旧图层名称 = 新图层名称,颜色号,线型名称,线宽,是否打印,说明
export interface LayerRelay { from: string; to: LayerDef }
export function parseLayerRelay(text: string): LayerRelay[] {
  return dataLines(text).filter((l) => l.includes('=')).map((l) => {
    const i = l.indexOf('=');
    return { from: l.slice(0, i).trim(), to: parseLayers(l.slice(i + 1).trim())[0] };
  });
}

// styles.txt — 字体样式名 = 字体文档名组合
export interface TextStyleDef { name: string; fonts: string[]; isTrueType: boolean }
export function parseStyles(text: string): TextStyleDef[] {
  return dataLines(text).filter((l) => l.includes('=')).map((l) => {
    const i = l.indexOf('=');
    const fonts = l.slice(i + 1).split(',').map((s) => s.trim()).filter(Boolean);
    return { name: l.slice(0, i).trim(), fonts, isTrueType: fonts.every((f) => !/\.shx$/i.test(f)) };
  });
}

// hatching.txt — quick hatch list: 显示名,图案名,角度?,比例?,? (4th/5th fields undocumented)
export interface QuickHatch { label: string; pattern: string; angle: number | null; scale: number | null; extra: string[] }
export function parseQuickHatch(text: string): QuickHatch[] {
  return dataLines(text).map((l) => {
    const [label, pattern, angle, scale, ...extra] = splitSmart(l);
    return { label, pattern: pattern || label, angle: num(angle), scale: num(scale), extra };
  });
}

// patterns1..3.txt — slide hatch picker: 图案名,?,?,比例?,说明
export interface PatternPick { pattern: string; fields: string[]; description: string }
export function parsePatternPicks(text: string): PatternPick[] {
  return dataLines(text).map((l) => {
    const parts = splitSmart(l);
    return { pattern: parts[0], fields: parts.slice(1, 4), description: parts.slice(4).join(',') };
  });
}

// hatchkey.txt — 快捷键,图案名,比例,角度,?,?
export interface HatchKey { alias: string; pattern: string; scale: number | null; angle: number | null; extra: string[] }
export function parseHatchKeys(text: string): HatchKey[] {
  return dataLines(text).map((l) => {
    const [alias, pattern, scale, angle, ...extra] = splitSmart(l);
    return { alias, pattern, scale: num(scale), angle: num(angle), extra };
  });
}

// ltypekey.txt — 快捷键,线型,线型比例,?
export interface LinetypeKey { alias: string; linetype: string; scale: number | null; extra: string[] }
export function parseLinetypeKeys(text: string): LinetypeKey[] {
  return dataLines(text).map((l) => {
    const [alias, linetype, scale, ...extra] = splitSmart(l);
    return { alias, linetype, scale: num(scale), extra };
  });
}

// layerkey.txt — 快捷键,图层名,颜色,线型,线宽,是否打印,说明
export interface LayerKey { alias: string; layer: LayerDef }
export function parseLayerKeys(text: string): LayerKey[] {
  return dataLines(text).map((l) => {
    const [alias, ...rest] = splitSmart(l);
    return { alias, layer: parseLayers(rest.join(','))[0] };
  });
}

// wlaykey.txt — 快捷键,通配符,说明
export interface WildcardLayerKey { alias: string; pattern: string; description: string }
export function parseWildcardLayerKeys(text: string): WildcardLayerKey[] {
  return dataLines(text).map((l) => {
    const [alias, pattern, ...d] = splitSmart(l);
    return { alias, pattern, description: d.join(',') };
  });
}

// numbers.txt — dimension number rows, "3*600 1200" means 600 600 600 1200
export interface NumberRow { raw: string; values: number[] }
export function parseNumberRows(text: string): NumberRow[] {
  return dataLines(text).map((raw) => {
    const values: number[] = [];
    for (const tok of raw.split(/\s+/)) {
      const m = tok.match(/^(\d+)\*(-?\d+(?:\.\d+)?)$/);
      if (m) for (let i = 0; i < Number(m[1]); i++) values.push(Number(m[2]));
      else if (Number.isFinite(Number(tok))) values.push(Number(tok));
    }
    return { raw, values };
  });
}

// dict.txt / dwgtitle.txt — "****section" headers followed by entries
export interface DictEntry { code: string | null; zh: string; en: string | null }
export interface DictSection { title: string; entries: DictEntry[] }
export function parseDictionary(text: string): DictSection[] {
  const sections: DictSection[] = [];
  let cur: DictSection | null = null;
  for (const raw of text.split('\n')) {
    if (raw.trim().startsWith(';')) continue;
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('****')) { cur = { title: line.slice(4).trim(), entries: [] }; sections.push(cur); continue; }
    if (!cur) { cur = { title: '', entries: [] }; sections.push(cur); }
    if (line.includes('=') && !line.includes(',')) {
      const i = line.indexOf('=');
      cur.entries.push({ code: null, zh: line.slice(0, i).trim(), en: line.slice(i + 1).trim() || null });
      continue;
    }
    const parts = line.split(',').map((s) => s.trim());
    if (parts.length >= 3) cur.entries.push({ code: parts[0] || null, zh: parts[1], en: parts.slice(2).join(',') || null });
    else if (parts.length === 2) cur.entries.push({ code: null, zh: parts[0], en: parts[1] || null });
    else cur.entries.push({ code: null, zh: line, en: null });
  }
  return sections.filter((s) => s.entries.length > 0);
}

// settings.txt — saved command parameters: command=v1,v2,... (LISP t/nil kept as booleans)
export function parseCommandSettings(text: string): Record<string, (string | number | boolean | null)[]> {
  const out: Record<string, (string | number | boolean | null)[]> = {};
  for (const l of dataLines(text)) {
    const i = l.indexOf('=');
    if (i < 0) continue;
    out[l.slice(0, i).trim()] = l.slice(i + 1).split(',').map((v) => {
      const t = v.trim();
      if (t === 't') return true;
      if (t === 'nil') return null;
      const n = Number(t);
      return t !== '' && Number.isFinite(n) ? n : t;
    });
  }
  return out;
}
