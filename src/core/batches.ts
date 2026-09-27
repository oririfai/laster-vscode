/** Changes detected less than this apart belong to the same batch. */
export const BATCH_GAP_MS = 10_000;

export interface Batch<T> {
  /** Detection time of the first item in the batch. */
  start: number;
  items: T[];
}

/** Groups items into time-based batches, newest batch first. */
export function groupIntoBatches<T>(items: readonly T[], timeOf: (item: T) => number, gapMs = BATCH_GAP_MS): Batch<T>[] {
  const sorted = [...items].sort((a, b) => timeOf(a) - timeOf(b));
  const batches: Batch<T>[] = [];
  let last = -Infinity;
  for (const item of sorted) {
    const t = timeOf(item);
    if (!batches.length || t - last > gapMs) {
      batches.push({ start: t, items: [] });
    }
    batches[batches.length - 1].items.push(item);
    last = t;
  }
  return batches.reverse();
}
