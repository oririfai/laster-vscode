import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupIntoBatches } from '../core/batches';

test('items close together form one batch; batches are newest first', () => {
  const items = [{ t: 1000 }, { t: 3000 }, { t: 60_000 }, { t: 5000 }];
  const batches = groupIntoBatches(items, (i) => i.t, 10_000);
  assert.deepEqual(
    batches.map((b) => [b.start, b.items.map((i) => i.t)]),
    [
      [60_000, [60_000]],
      [1000, [1000, 3000, 5000]],
    ],
  );
});

test('a chain of small gaps stays one batch', () => {
  const items = [0, 8000, 16_000, 24_000].map((t) => ({ t }));
  assert.equal(groupIntoBatches(items, (i) => i.t, 10_000).length, 1);
});

test('empty input → no batches', () => {
  assert.deepEqual(groupIntoBatches([], () => 0), []);
});
