/**
 * Command alias resolution mirroring YQArch: aliases come from
 *  - shortcut.yqs (assets/commands.json → YQArch command id ↔ alias), with per-profile overrides (alias-overrides.json),
 *  - acad_.pgp of the active profile (pgp-aliases.json → AutoCAD command names),
 *  - the engine's own command names.
 * YQARCH_SHORTCUT_PRIORITY (profile config) decides who wins when the same alias exists in both:
 * true → YQArch shortcut first, false → acad.pgp first (the user1 default).
 */
export interface YqCommandMeta {
  id: string; zh: string; en: string; category: string; alias: string; stars?: number; description?: string; group?: number; order?: number; notes?: string[];
}
export interface YqCategory { id: string; zh: string; en: string; panelCommand?: string; panelAlias?: string; order?: number }

export type ResolveSource = 'command' | 'yq-id' | 'yq-alias' | 'pgp' | 'builtin-alias';
export interface Resolved {
  /** Name to look up in the command registry (engine command name or YQArch command id). */
  name: string;
  source: ResolveSource;
  /** AutoCAD command name the alias pointed to (pgp), even if the web engine does not implement it. */
  target?: string;
  meta?: YqCommandMeta;
}

export interface AliasSources {
  yqCommands: YqCommandMeta[];
  pgp: Record<string, string>;
  overrides?: Record<string, string>;
  yqPriority?: boolean;
}

/** Aliases always available even when no pgp is loaded (standard AutoCAD acad.pgp subset). */
export const BUILTIN_ALIASES: Record<string, string> = {
  L: 'LINE', PL: 'PLINE', C: 'CIRCLE', A: 'ARC', REC: 'RECTANG', POL: 'POLYGON', EL: 'ELLIPSE', PO: 'POINT',
  T: 'MTEXT', MT: 'MTEXT', DT: 'TEXT', DLI: 'DIMLINEAR', DAL: 'DIMALIGNED', DRA: 'DIMRADIUS', DDI: 'DIMDIAMETER',
  H: 'HATCH', BH: 'HATCH', I: 'INSERT', B: 'BLOCK', E: 'ERASE', M: 'MOVE', CO: 'COPY', CP: 'COPY', RO: 'ROTATE', SC: 'SCALE', MI: 'MIRROR',
  U: 'U', Z: 'ZOOM', P: 'PAN', RE: 'REGEN', LA: 'LAYER', '-LA': '-LAYER', COL: 'COLOR', LT: 'LINETYPE', LTS: 'LTSCALE', UN: 'UNITS',
  OS: 'OSNAP', SN: 'SNAP', DI: 'DIST', LI: 'LIST', LS: 'LIST', PR: 'PROPERTIES', CH: 'PROPERTIES', ED: 'DDEDIT', X: 'EXPLODE',
  O: 'OFFSET', TR: 'TRIM', EX: 'EXTEND', F: 'FILLET', CHA: 'CHAMFER', AR: 'ARRAY', S: 'STRETCH', BR: 'BREAK', J: 'JOIN',
  WA: 'WALL', WFROM: 'WALLFROM', WTHICK: 'WALLTHICK', WDEL: 'WALLDELETE',
  AX: 'AXIS', AG: 'AXISGRID', COLN: 'COLUMN', DR: 'DOOR', WN: 'WINDOW', DFLIP: 'FLIPDOOR',
};

export class AliasResolver {
  private yqById = new Map<string, YqCommandMeta>();
  private yqByAlias = new Map<string, YqCommandMeta>();
  private pgp = new Map<string, string>();
  yqPriority: boolean;

  constructor(private commandNames: () => Iterable<string>, src: AliasSources) {
    this.yqPriority = !!src.yqPriority;
    for (const c of src.yqCommands) {
      this.yqById.set(c.id.toUpperCase(), c);
      const alias = (src.overrides?.[c.id] ?? c.alias ?? '').trim();
      if (alias) this.yqByAlias.set(alias.toUpperCase(), { ...c, alias });
    }
    for (const [k, v] of Object.entries(src.pgp)) this.pgp.set(k.toUpperCase(), String(v).toUpperCase().replace(/^[._]+/, ''));
  }

  yqMeta(idOrAlias: string): YqCommandMeta | undefined {
    const k = idOrAlias.toUpperCase();
    return this.yqById.get(k) ?? this.yqByAlias.get(k);
  }
  get yqCommands(): YqCommandMeta[] { return [...this.yqById.values()]; }
  aliasOf(yqId: string): string | undefined { for (const c of this.yqByAlias.values()) if (c.id === yqId) return c.alias; return undefined; }

  resolve(input: string): Resolved | null {
    const raw = input.trim().replace(/^[._']+/, '');
    if (!raw) return null;
    const k = raw.toUpperCase();
    const names = new Set([...this.commandNames()].map((n) => n.toUpperCase()));
    if (names.has(k) && !this.yqById.has(k)) return { name: k, source: 'command' };
    const yqId = this.yqById.get(k);
    if (yqId) return { name: yqId.id, source: 'yq-id', meta: yqId };
    const yq = this.yqByAlias.get(k);
    const pg = this.pgp.get(k);
    const fromYq = yq ? { name: yq.id, source: 'yq-alias' as const, meta: yq } : null;
    const fromPgp = pg ? { name: pg, source: 'pgp' as const, target: pg } : null;
    const first = this.yqPriority ? fromYq ?? fromPgp : fromPgp ?? fromYq;
    if (first) return first;
    const b = BUILTIN_ALIASES[k];
    if (b) return { name: b, source: 'builtin-alias', target: b };
    return null;
  }

  /** Autocomplete candidates for a prefix: engine commands, YQArch aliases and pgp aliases. */
  complete(prefix: string, limit = 12): { text: string; detail: string; kind: 'command' | 'yq' | 'pgp' }[] {
    const p = prefix.trim().toUpperCase();
    if (!p) return [];
    const out: { text: string; detail: string; kind: 'command' | 'yq' | 'pgp'; rank: number }[] = [];
    const seen = new Set<string>();
    const push = (text: string, detail: string, kind: 'command' | 'yq' | 'pgp') => {
      const key = text.toUpperCase();
      if (seen.has(key) || !key.startsWith(p)) return;
      seen.add(key); out.push({ text, detail, kind, rank: (key === p ? 0 : 1) * 1000 + key.length });
    };
    for (const [a, c] of this.yqByAlias) push(a.toLowerCase(), `${c.en} · ${c.zh}`, 'yq');
    for (const [a, t] of this.pgp) push(a, t, 'pgp');
    for (const n of this.commandNames()) if (!n.toLowerCase().startsWith('yq')) push(n, '', 'command');
    out.sort((a, b) => a.rank - b.rank || a.text.localeCompare(b.text));
    return out.slice(0, limit).map(({ rank: _r, ...x }) => x);
  }
}
