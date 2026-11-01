import { isCommentOrBlank, splitSmart, stripComment } from './csv.js';

export interface CommandCategory {
  id: string;            // e.g. "wallcolumn" (derived from the panel command yq_wallcolumn)
  zh: string;            // 平面墙柱
  en: string;            // Plane Wall/Column
  panelCommand: string;  // yq_wallcolumn — opens the category dialog in YQArch
  panelAlias: string;    // www
  order: number;
}

export interface CommandDef {
  id: string;            // original LISP command name, e.g. yq_wall
  zh: string;
  en: string;
  category: string;      // CommandCategory.id
  group: number;         // visual group inside the category ("--" separators)
  order: number;         // global order as listed by YQArch
  alias: string;         // default keyboard alias, e.g. ww
  stars: number | null;  // 1..5 usage/importance rating from yqshortcut.txt
  description: string | null; // Chinese one-line description from yqshortcut.txt
  notes: string[];       // version notes, e.g. "v6.6 修改的"
}

export interface CommandCatalog {
  version: string | null;
  categories: CommandCategory[];
  commands: CommandDef[];
}

/** Parse shortcut.yqs (zh,en,command,defaultAlias,userAlias) — the authoritative command list. */
export function parseShortcutYqs(text: string): { categories: CommandCategory[]; commands: (Omit<CommandDef, 'stars' | 'description' | 'notes'> & { userAlias: string })[] } {
  const categories: CommandCategory[] = [];
  const commands: (Omit<CommandDef, 'stars' | 'description' | 'notes'> & { userAlias: string })[] = [];
  let cat: CommandCategory | null = null;
  let group = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (isCommentOrBlank(line)) continue;
    if (line.startsWith('--')) { group++; continue; }
    if (line.startsWith('****')) {
      const parts = splitSmart(line.slice(4));
      const userAlias = parts.pop() ?? '';
      const alias = parts.pop() ?? '';
      const panelCommand = parts.pop() ?? '';
      const zh = (parts.shift() ?? '').replace(/[【】]/g, '').replace(/命令列表/, '').trim();
      const en = parts.join(',').replace(/^\[/, '').replace(/\]\s*Command List$/i, '').trim();
      cat = {
        id: panelCommand.replace(/^yq_/, '') || `cat${categories.length + 1}`,
        zh, en, panelCommand, panelAlias: userAlias || alias, order: categories.length + 1,
      };
      categories.push(cat);
      group = 0;
      continue;
    }
    // plain split: .yqs has no LISP expressions, and some English names contain a stray '"'
    const parts = line.split(',').map((x) => x.trim());
    if (parts.length < 5) continue;
    const userAlias = parts.pop()!;
    const alias = parts.pop()!;
    const id = parts.pop()!;
    const zh = parts.shift()!;
    const en = parts.join(',').replace(/^"|"$/g, '').trim();
    commands.push({ id, zh, en, category: cat?.id ?? 'uncategorized', group, order: commands.length + 1, alias, userAlias });
  }
  return { categories, commands };
}

export interface CommandReferenceEntry {
  refCategory: string;
  alias: string;
  id: string;
  description: string;
  stars: number | null;
  notes: string[];
}

/** Parse yqshortcut.txt: "[类别] alias command ;description ****" (+ indented "(v6.6 修改的 ●●)" notes). */
export function parseCommandReference(text: string): { version: string | null; entries: CommandReferenceEntry[] } {
  const entries: CommandReferenceEntry[] = [];
  const versionMatch = text.match(/v(\d+\.\d+\.\d+\w*)/);
  const re = /^\[([^\]]+)\]\s+(\S+)\s+(\S+)\s*;\s*(.*?)\s*$/;
  let last: CommandReferenceEntry | null = null;
  for (const raw of text.split('\n')) {
    const m = raw.match(re);
    if (m) {
      const [, refCategory, alias, id, rest] = m;
      const starMatch = rest.match(/(\*+)\s*$/);
      const stars = starMatch ? starMatch[1].length : null;
      const description = rest.replace(/\*+\s*$/, '').trim();
      last = { refCategory, alias, id, description, stars, notes: [] };
      entries.push(last);
      continue;
    }
    const note = raw.match(/^\s{10,}\((.+?)\)\s*$/);
    if (note && last) { last.notes.push(note[1].replace(/\s*●+\s*$/, '').trim()); continue; }
    if (raw.trim() !== '' && !raw.startsWith(' ')) last = null;
  }
  return { version: versionMatch ? versionMatch[1] : null, entries };
}

export function buildCommandCatalog(yqsText: string, referenceText: string | null): CommandCatalog {
  const { categories, commands } = parseShortcutYqs(yqsText);
  const ref = referenceText ? parseCommandReference(referenceText) : { version: null, entries: [] };
  const byId = new Map(ref.entries.map((e) => [e.id.toLowerCase(), e]));
  return {
    version: ref.version,
    categories,
    commands: commands.map(({ userAlias: _u, ...c }) => {
      const r = byId.get(c.id.toLowerCase());
      return { ...c, stars: r?.stars ?? null, description: r?.description ?? null, notes: r?.notes ?? [] };
    }),
  };
}

/** Per-profile alias overrides: only entries whose user alias differs from the default. */
export function aliasOverrides(defaultYqs: string, profileYqs: string): Record<string, string> {
  const base = new Map(parseShortcutYqs(defaultYqs).commands.map((c) => [c.id, c.userAlias]));
  const out: Record<string, string> = {};
  for (const c of parseShortcutYqs(profileYqs).commands) {
    if (base.get(c.id) !== c.userAlias) out[c.id] = c.userAlias;
  }
  return out;
}

// ---------------------------------------------------------------- panels (yqpanel.txt / userpanel.txt)

export interface PanelItem { zh: string; en: string; command: string; alias: string | null; separator: boolean }
export interface PanelSection { zh: string; en: string; hint: string | null; items: PanelItem[] }
export interface Panel { zh: string; en: string; buttonsPerColumn: number | null; alias: string | null; sections: PanelSection[] }

export function parsePanels(text: string): Panel[] {
  const panels: Panel[] = [];
  let panel: Panel | null = null;
  let section: PanelSection | null = null;
  for (const raw of text.split('\n')) {
    if (raw.trim().startsWith(';') || raw.trim() === '') continue;
    const [content, comment] = stripComment(raw);
    const line = content.trim();
    if (line.startsWith('******')) {
      const [zh, en, n, alias] = splitSmart(line.slice(6));
      panel = { zh: unbracket(zh), en: unbracket(en), buttonsPerColumn: n ? Number(n) : null, alias: alias || null, sections: [] };
      panels.push(panel);
      section = null;
      continue;
    }
    if (!panel) continue;
    if (line.startsWith('****')) {
      const [zh, en] = splitSmart(line.slice(4));
      section = { zh: unbracket(zh), en: unbracket(en ?? ''), hint: comment || null, items: [] };
      panel.sections.push(section);
      continue;
    }
    if (!section) { section = { zh: '', en: '', hint: null, items: [] }; panel.sections.push(section); }
    const [zh = '', en = '', command = '', alias = ''] = splitSmart(line);
    section.items.push({ zh, en, command, alias: alias || null, separator: !zh && !en && !command });
  }
  return panels;
}

const unbracket = (s = '') => s.replace(/^[\[【]|[\]】]$/g, '').trim();

// ---------------------------------------------------------------- AutoCAD acad.pgp aliases

export interface PgpData { aliases: Record<string, string>; external: { alias: string; command: string; flags: string; prompt: string }[] }

export function parsePgp(text: string): PgpData {
  const aliases: Record<string, string> = {};
  const external: PgpData['external'] = [];
  for (const raw of text.split('\n')) {
    if (isCommentOrBlank(raw)) continue;
    const [content] = stripComment(raw);
    const m = content.match(/^\s*([^,\s]+)\s*,\s*\*(\S+)\s*$/);
    if (m) { aliases[m[1].toUpperCase()] = m[2].toUpperCase(); continue; }
    const parts = content.split(',').map((s) => s.trim());
    if (parts.length >= 3) external.push({ alias: parts[0], command: parts[1], flags: parts[2], prompt: parts[3] ?? '' });
  }
  return { aliases, external };
}
