import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approveHunk, computeHunks, revertHunk, statsOf } from '../core/hunks';

test('no change → no hunks', () => {
  assert.deepEqual(computeHunks('a\nb\n', 'a\nb\n'), []);
});

test('lines added in the middle', () => {
  const hunks = computeHunks('a\nb\n', 'a\nx\ny\nb\n');
  assert.deepEqual(hunks, [{ start: 1, addedCount: 2, baseStart: 1, removedLines: [] }]);
});

test('pure line deletion', () => {
  const hunks = computeHunks('a\nb\nc\nd\n', 'a\nd\n');
  assert.deepEqual(hunks, [{ start: 1, addedCount: 0, baseStart: 1, removedLines: ['b', 'c'] }]);
});

test('replaced lines = one hunk with both additions and removals', () => {
  const hunks = computeHunks('a\nold\nc\n', 'a\nnew1\nnew2\nc\n');
  assert.deepEqual(hunks, [{ start: 1, addedCount: 2, baseStart: 1, removedLines: ['old'] }]);
});

test('several separate hunks with correct line numbers', () => {
  const hunks = computeHunks('1\n2\n3\n4\n5\n', 'x\n1\n2\n4\n5\ny\n');
  assert.deepEqual(hunks, [
    { start: 0, addedCount: 1, baseStart: 0, removedLines: [] },
    { start: 3, addedCount: 0, baseStart: 2, removedLines: ['3'] },
    { start: 5, addedCount: 1, baseStart: 5, removedLines: [] },
  ]);
});

test('new file (empty baseline)', () => {
  assert.deepEqual(computeHunks('', 'a\nb\n'), [{ start: 0, addedCount: 2, baseStart: 0, removedLines: [] }]);
});

test('CRLF does not leak into removedLines', () => {
  const hunks = computeHunks('a\r\nb\r\n', 'a\r\n');
  assert.deepEqual(hunks, [{ start: 1, addedCount: 0, baseStart: 1, removedLines: ['b'] }]);
});

test('statsOf sums additions and removals', () => {
  const hunks = computeHunks('a\nold\nc\nd\n', 'a\nnew1\nnew2\nc\n');
  assert.deepEqual(statsOf(hunks), { added: 2, removed: 2 });
});

test('approveHunk only moves that hunk into the baseline', () => {
  const base = '1\n2\n3\n4\n5\n';
  const cur = 'x\n1\n2\n4\n5\ny\n';
  const [first, second] = computeHunks(base, cur);
  const newBase = approveHunk(base, cur, second);
  assert.equal(newBase, '1\n2\n4\n5\n');
  assert.deepEqual(computeHunks(newBase, cur).length, 2);
  // Hunks are always recomputed after the baseline changes.
  const afterFirst = approveHunk(base, cur, first);
  const last = computeHunks(afterFirst, cur).at(-1)!;
  assert.equal(approveHunk(afterFirst, cur, last), 'x\n1\n2\n3\n4\n5\ny\n');
});

test('revertHunk only restores that hunk', () => {
  const base = 'a\nold\nc\nd\n';
  const cur = 'a\nnew1\nnew2\nc\n';
  const [replaced, deleted] = computeHunks(base, cur);
  assert.equal(revertHunk(base, cur, replaced), 'a\nold\nc\n');
  assert.equal(revertHunk(base, cur, deleted), 'a\nnew1\nnew2\nc\nd\n');
  const cur2 = 'X\nb\nc\nY\n';
  const hunks = computeHunks('a\nb\nc\nd\n', cur2);
  assert.equal(revertHunk('a\nb\nc\nd\n', cur2, hunks[1]), 'X\nb\nc\nd\n');
});

test('an oversized diff falls back to one whole-file hunk (no hang)', () => {
  const base = Array.from({ length: 20000 }, (_, i) => `a${i}`).join('\n');
  const cur = Array.from({ length: 20000 }, (_, i) => `b${i}`).join('\n');
  const t0 = Date.now();
  const hunks = computeHunks(base, cur);
  assert.ok(Date.now() - t0 < 3000, 'must be fast');
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].addedCount, 20000);
});
