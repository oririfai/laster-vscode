import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

/**
 * Content-addressed file storage (like git's object store).
 * Content is stored raw (including BOM/CRLF) so Revert restores exactly the same bytes.
 */
export class ObjectStore {
  constructor(private readonly dir: string) {}

  private pathOf(hash: string): string {
    return path.join(this.dir, hash.slice(0, 2), hash.slice(2));
  }

  async has(hash: string): Promise<boolean> {
    try {
      await fs.access(this.pathOf(hash));
      return true;
    } catch {
      return false;
    }
  }

  async put(hash: string, bytes: Uint8Array): Promise<void> {
    if (await this.has(hash)) {
      return;
    }
    const target = this.pathOf(hash);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await writeAtomic(target, gzipSync(bytes));
  }

  async get(hash: string): Promise<Uint8Array> {
    return gunzipSync(await fs.readFile(this.pathOf(hash)));
  }

  /** Delete objects that are no longer referenced. Returns how many were deleted. */
  async gc(keep: Set<string>): Promise<number> {
    let removed = 0;
    let prefixes: string[];
    try {
      prefixes = await fs.readdir(this.dir);
    } catch {
      return 0;
    }
    for (const prefix of prefixes) {
      const sub = path.join(this.dir, prefix);
      for (const rest of await fs.readdir(sub)) {
        if (rest.endsWith('.tmp') || !keep.has(prefix + rest)) {
          await fs.rm(path.join(sub, rest), { force: true });
          removed++;
        }
      }
    }
    return removed;
  }
}

export async function writeAtomic(target: string, data: Uint8Array | string): Promise<void> {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, target);
}
