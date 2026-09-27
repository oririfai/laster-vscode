import { Block, changedBlocks, splitKeep } from './lines';

/**
 * Forwards the user's own edits into the baseline (three-version model).
 *
 * - `base` (B): the baseline — the last content the user knows about / approved.
 * - `ai`   (A): the content right after the last non-user change.
 * - `current` (C): the content now (including user edits made after A).
 *
 * The A→C changes are the user's edits. Edits outside the regions the AI changed (B→A) are
 * applied to B as well, so they are not highlighted. Edits that touch an AI region are left
 * alone, so that region stays marked as an unreviewed AI change.
 *
 * This does not depend on the order of editor events, so a reload from disk, undo, or revert
 * cannot put the state out of sync.
 */
export function forwardUserEdits(base: string, ai: string, current: string): string {
  if (ai === current) {
    return base;
  }
  const B = splitKeep(base);
  const A = splitKeep(ai);
  const C = splitKeep(current);
  const aiBlocks = changedBlocks(B, A); // A coordinates = bStart/bLen
  const userBlocks = changedBlocks(A, C); // A coordinates = aStart/aLen

  const edits: { at: number; len: number; lines: string[] }[] = [];
  for (const e of userBlocks) {
    if (aiBlocks.some((h) => overlaps(e, h))) {
      continue;
    }
    edits.push({ at: mapAToB(e.aStart, aiBlocks), len: e.aLen, lines: C.slice(e.bStart, e.bStart + e.bLen) });
  }
  for (let i = edits.length - 1; i >= 0; i--) {
    B.splice(edits[i].at, edits[i].len, ...edits[i].lines);
  }
  return B.join('');
}

/** Whether user edit `e` (region A[aStart, aStart+aLen)) touches AI region `h` (A[bStart, bStart+bLen)). */
function overlaps(e: Block, h: Block): boolean {
  const eEnd = e.aStart + e.aLen;
  const hEnd = h.bStart + h.bLen;
  if (h.bLen === 0) {
    // The AI deleted lines at point h.bStart. A user insertion exactly at that point (e.g. retyping
    // the deleted lines), or an edit spanning it, cannot be mapped 1:1 onto the baseline.
    return e.aLen === 0 ? e.aStart === h.bStart : e.aStart < h.bStart && h.bStart < eEnd;
  }
  if (e.aLen === 0) {
    // A user insertion inside an AI block.
    return h.bStart < e.aStart && e.aStart < hEnd;
  }
  return e.aStart < hEnd && h.bStart < eEnd;
}

/** Map a line index in A to the matching index in B, for positions outside AI regions. */
function mapAToB(a: number, aiBlocks: Block[]): number {
  let offset = 0;
  for (const h of aiBlocks) {
    const before = h.bLen > 0 ? h.bStart + h.bLen <= a : h.bStart <= a;
    if (before) {
      offset += h.aLen - h.bLen;
    }
  }
  return a + offset;
}
