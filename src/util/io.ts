import { promises as fs } from 'node:fs';
import path from 'node:path';
import { decodeText } from './encoding.js';

export async function readTextFile(file: string) {
  const buf = await fs.readFile(file);
  return decodeText(new Uint8Array(buf));
}

export async function readBinary(file: string): Promise<Uint8Array> {
  return new Uint8Array(await fs.readFile(file));
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

export async function writeJson(file: string, data: unknown, pretty = true) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(data, null, pretty ? 2 : 0) + '\n', 'utf8');
}

export async function writeText(file: string, text: string) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, text, 'utf8');
}

/** Recursively list files under dir (skips .git). Returns paths relative to dir with '/' separators. */
export async function walk(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true });
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(dir, r)));
    else out.push(r);
  }
  return out.sort();
}

/** Find a file case-insensitively inside dir (YQArch mixes .SHX/.shx, .DWG/.dwg). */
export async function findCaseInsensitive(dir: string, name: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(dir);
    const hit = entries.find((e) => e.toLowerCase() === name.toLowerCase());
    return hit ? path.join(dir, hit) : null;
  } catch {
    return null;
  }
}

/** Make a filesystem/URL-safe slug while keeping CJK characters readable. */
export function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]+/g, '_');
}
