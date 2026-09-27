import { changedBlocks, splitKeep, stripEol } from './lines';

/**
 * One block of change between the baseline and the current content. Line numbers are 0-based.
 */
export interface Hunk {
  /** First added/changed line in the current document. For a pure deletion: where the lines used to be. */
  start: number;
  /** Number of new lines (0 = pure deletion). */
  addedCount: number;
  /** Position of the hunk in the baseline. */
  baseStart: number;
  /** Baseline lines that were removed/replaced (without newlines). */
  removedLines: string[];
}

export interface DiffStats {
  added: number;
  removed: number;
}

export function computeHunks(baseline: string, current: string): Hunk[] {
  const base = splitKeep(baseline);
  return changedBlocks(base, splitKeep(current)).map((b) => ({
    start: b.bStart,
    addedCount: b.bLen,
    baseStart: b.aStart,
    removedLines: base.slice(b.aStart, b.aStart + b.aLen).map(stripEol),
  }));
}

export function statsOf(hunks: Hunk[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    added += h.addedCount;
    removed += h.removedLines.length;
  }
  return { added, removed };
}

/** Approve one hunk: new baseline = baseline with the hunk's region replaced by the current content. */
export function approveHunk(baseline: string, current: string, hunk: Hunk): string {
  const base = splitKeep(baseline);
  const cur = splitKeep(current);
  base.splice(hunk.baseStart, hunk.removedLines.length, ...cur.slice(hunk.start, hunk.start + hunk.addedCount));
  return base.join('');
}

/** Revert one hunk: new content = current content with the hunk's region restored from the baseline. */
export function revertHunk(baseline: string, current: string, hunk: Hunk): string {
  const base = splitKeep(baseline);
  const cur = splitKeep(current);
  cur.splice(hunk.start, hunk.addedCount, ...base.slice(hunk.baseStart, hunk.baseStart + hunk.removedLines.length));
  return cur.join('');
}
