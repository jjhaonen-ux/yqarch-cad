/**
 * Text decoding for YQArch resources.
 * YQArch ships most text files in GB18030/GBK (Simplified Chinese ANSI code page).
 * We try strict UTF-8 first (with or without BOM) and fall back to GB18030.
 */
const utf8Strict = new TextDecoder('utf-8', { fatal: true });
const gb18030 = new TextDecoder('gb18030');

export type DetectedEncoding = 'utf-8' | 'utf-8-bom' | 'gb18030';

export function decodeText(bytes: Uint8Array): { text: string; encoding: DetectedEncoding } {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: normalizeNewlines(utf8Strict.decode(bytes.subarray(3))), encoding: 'utf-8-bom' };
  }
  try {
    const u = utf8Strict.decode(bytes);
    if (looksLikeMisreadGbk(u)) return { text: normalizeNewlines(gb18030.decode(bytes)), encoding: 'gb18030' };
    return { text: normalizeNewlines(u), encoding: 'utf-8' };
  } catch {
    return { text: normalizeNewlines(gb18030.decode(bytes)), encoding: 'gb18030' };
  }
}

/**
 * Short GBK strings can accidentally be valid UTF-8 (e.g. 源泉 = D4 B4 C8 AA decodes to "ԴȪ").
 * Real UTF-8 Chinese text uses 3-byte sequences (>= U+0800); if every non-ASCII character is in the
 * 2-byte range U+0080..U+07FF we treat the bytes as GBK instead.
 */
function looksLikeMisreadGbk(u: string): boolean {
  let twoByte = 0;
  for (const ch of u) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x800) return false;
    if (c >= 0x80) twoByte++;
  }
  return twoByte > 0;
}

/** Decode a GBK/GB18030 byte string (used for names embedded in binary formats). */
export function decodeGbk(bytes: Uint8Array): string {
  return decodeText(bytes).text;
}

/** Convert a double-byte big-font code (lead<<8 | trail) to a Unicode string. */
export function gbkCodeToChar(code: number): string | null {
  if (code < 0x80) return String.fromCharCode(code);
  if (code <= 0xff) return null;
  const s = gb18030.decode(new Uint8Array([code >> 8, code & 0xff]));
  if (!s || s.includes('\ufffd') || [...s].length !== 1) return null;
  return s;
}

export function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

/** Split text into lines, keeping 1-based line numbers. */
export function lines(text: string): { no: number; line: string }[] {
  return text.split('\n').map((line, i) => ({ no: i + 1, line }));
}
