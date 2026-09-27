import * as fs from 'node:fs/promises';
import { writeAtomic } from './objectStore';

/**
 * Per-file baseline: the hash of the content the user last knew about / approved,
 * or `null` if the file was not in the baseline (created by someone other than the user).
 * Key = `uri.toString()`.
 */
export type BaselineMap = Map<string, string | null>;

interface BaselineJson {
  version: 1;
  files: Record<string, string | null>;
}

export async function loadBaseline(file: string): Promise<BaselineMap | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  const json = JSON.parse(raw) as BaselineJson;
  return new Map(Object.entries(json.files));
}

export async function saveBaseline(file: string, map: BaselineMap): Promise<void> {
  const json: BaselineJson = { version: 1, files: Object.fromEntries(map) };
  await writeAtomic(file, JSON.stringify(json));
}
