import { stripComment } from './csv.js';

export type ConfigValue = string | number | boolean | number[] | string[] | null;

export interface ConfigEntry {
  key: string;
  raw: string;
  value: ConfigValue;
  label: string | null;   // text inside 【...】
  comment: string | null; // remaining comment text
  notes: string[];        // indented continuation comments
  section: string;
}

export interface ConfigSection { title: string; keys: string[] }

export interface ParsedConfig {
  sections: ConfigSection[];
  entries: ConfigEntry[];
  values: Record<string, ConfigValue>;
}

export function typedValue(raw: string): ConfigValue {
  const v = raw.trim();
  if (v === '') return null;
  const lower = v.toLowerCase();
  if (lower === 'yes') return true;
  if (lower === 'no') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.includes(',')) {
    const parts = v.split(',').map((s) => s.trim());
    if (parts.every((p) => /^-?\d+(\.\d+)?$/.test(p))) return parts.map(Number);
    return parts;
  }
  return v;
}

/** Parse YQArch config.txt: "KEY = value ;【label】comment", sections ";*** TITLE ***". */
export function parseConfig(text: string): ParsedConfig {
  const sections: ConfigSection[] = [];
  const entries: ConfigEntry[] = [];
  let section: ConfigSection = { title: 'GENERAL', keys: [] };
  let last: ConfigEntry | null = null;
  for (const raw of text.split('\n')) {
    const sec = raw.match(/^;\*{3,}\s*(.*?)\s*\*{3,}\s*$/);
    if (sec) {
      section = { title: sec[1], keys: [] };
      sections.push(section);
      last = null;
      continue;
    }
    const cont = raw.match(/^\s+;\s?(.*)$/);
    if (cont && last) { if (cont[1].trim()) last.notes.push(cont[1].trim()); continue; }
    const m = raw.match(/^([A-Za-z][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!m) { if (raw.trim() && !raw.trim().startsWith(';')) last = null; continue; }
    const [content, comment] = stripComment(m[2]);
    const labelMatch = comment.match(/【(.+?)】\s*(.*)$/);
    const entry: ConfigEntry = {
      key: m[1],
      raw: content.trim(),
      value: typedValue(content),
      label: labelMatch ? labelMatch[1] : null,
      comment: (labelMatch ? labelMatch[2] : comment).trim() || null,
      notes: [],
      section: section.title,
    };
    if (!sections.includes(section)) sections.push(section);
    section.keys.push(entry.key);
    entries.push(entry);
    last = entry;
  }
  const values: Record<string, ConfigValue> = {};
  for (const e of entries) values[e.key] = e.value;
  return { sections, entries, values };
}
