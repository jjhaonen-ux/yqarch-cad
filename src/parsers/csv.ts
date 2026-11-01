/** Split a comma-separated line, respecting (...) nesting and "..." quotes (used for LISP expressions in panels). */
export function splitSmart(line: string, sep = ','): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let inQuote = false;
  for (const ch of line) {
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote && ch === '(') depth++;
    else if (!inQuote && ch === ')') depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0 && !inQuote) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Strip a trailing ';comment' that is not inside parentheses/quotes. Returns [content, comment]. */
export function stripComment(line: string): [string, string] {
  let depth = 0;
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote && ch === '(') depth++;
    else if (!inQuote && ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0 && !inQuote) return [line.slice(0, i).trimEnd(), line.slice(i + 1).trim()];
  }
  return [line.trimEnd(), ''];
}

export function isCommentOrBlank(line: string): boolean {
  const t = line.trim();
  return t === '' || t.startsWith(';');
}

export function yesNo(v: string | undefined): boolean | null {
  if (v == null) return null;
  const t = v.trim().toLowerCase();
  if (t === 'yes' || t === 't' || t === 'true') return true;
  if (t === 'no' || t === 'nil' || t === 'false') return false;
  return null;
}

export function num(v: string | undefined): number | null {
  if (v == null || v.trim() === '') return null;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : null;
}
