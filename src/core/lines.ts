import { diffArrays } from 'diff';

/** Diff work limit. Beyond this the whole file is treated as one changed block (avoids high CPU). */
const MAX_EDIT_LENGTH = 4000;

/** Split text into lines, keeping each line's terminator (`\n` / `\r\n`) attached. */
export function splitKeep(text: string): string[] {
  if (text === '') {
    return [];
  }
  return text.split(/(?<=\n)/);
}

export function stripEol(line: string): string {
  return line.replace(/\r?\n$/, '');
}

/** A region that differs between `a` and `b`: a[aStart, aStart+aLen) became b[bStart, bStart+bLen). */
export interface Block {
  aStart: number;
  aLen: number;
  bStart: number;
  bLen: number;
}

export function changedBlocks(a: readonly string[], b: readonly string[]): Block[] {
  const changes = diffArrays(a as string[], b as string[], { maxEditLength: MAX_EDIT_LENGTH });
  if (!changes) {
    return a.length || b.length ? [{ aStart: 0, aLen: a.length, bStart: 0, bLen: b.length }] : [];
  }
  const blocks: Block[] = [];
  let ai = 0;
  let bi = 0;
  let open: Block | undefined;
  for (const c of changes) {
    const n = c.value.length;
    if (c.added) {
      open ??= { aStart: ai, aLen: 0, bStart: bi, bLen: 0 };
      open.bLen += n;
      bi += n;
    } else if (c.removed) {
      open ??= { aStart: ai, aLen: 0, bStart: bi, bLen: 0 };
      open.aLen += n;
      ai += n;
    } else {
      if (open) {
        blocks.push(open);
        open = undefined;
      }
      ai += n;
      bi += n;
    }
  }
  if (open) {
    blocks.push(open);
  }
  return blocks;
}
