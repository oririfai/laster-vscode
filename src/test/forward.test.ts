import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forwardUserEdits } from '../core/forward';
import { computeHunks } from '../core/hunks';

const L = (...lines: string[]) => lines.map((l) => l + '\n').join('');

/** Hunks left after forwarding the user's edits = what gets highlighted. */
function visible(base: string, ai: string, current: string) {
  return computeHunks(forwardUserEdits(base, ai, current), current);
}

const B = L('a', 'b', 'c', 'd', 'e', 'f', 'g');
// The AI replaces 'c' → 'C1','C2'.
const A = L('a', 'b', 'C1', 'C2', 'd', 'e', 'f', 'g');

test('no user edits → baseline unchanged', () => {
  assert.equal(forwardUserEdits(B, A, A), B);
});

test('user edits outside AI regions are forwarded to the baseline (not highlighted)', () => {
  const C = L('a', 'b', 'C1', 'C2', 'd', 'e', 'F!', 'g');
  assert.equal(forwardUserEdits(B, A, C), L('a', 'b', 'c', 'd', 'e', 'F!', 'g'));
  assert.deepEqual(visible(B, A, C), [{ start: 2, addedCount: 2, baseStart: 2, removedLines: ['c'] }]);
});

test('user edits before an AI region shift positions correctly', () => {
  const C = L('new', 'a', 'b', 'C1', 'C2', 'd', 'e', 'f', 'g');
  assert.equal(forwardUserEdits(B, A, C), L('new', 'a', 'b', 'c', 'd', 'e', 'f', 'g'));
  assert.deepEqual(visible(B, A, C), [{ start: 3, addedCount: 2, baseStart: 3, removedLines: ['c'] }]);
});

test('user edits inside an AI region stay marked as AI', () => {
  const C = L('a', 'b', 'C1-edited', 'C2', 'd', 'e', 'f', 'g');
  assert.equal(forwardUserEdits(B, A, C), B);
  assert.deepEqual(visible(B, A, C), [{ start: 2, addedCount: 2, baseStart: 2, removedLines: ['c'] }]);
});

test('a user insertion right after an AI block is forwarded', () => {
  const C = L('a', 'b', 'C1', 'C2', 'mine', 'd', 'e', 'f', 'g');
  assert.equal(forwardUserEdits(B, A, C), L('a', 'b', 'c', 'mine', 'd', 'e', 'f', 'g'));
});

test('AI deletes lines, user edits another line', () => {
  const A2 = L('a', 'b', 'e', 'f', 'g'); // AI deletes c, d
  const C = L('A!', 'b', 'e', 'f', 'g');
  assert.equal(forwardUserEdits(B, A2, C), L('A!', 'b', 'c', 'd', 'e', 'f', 'g'));
  assert.deepEqual(visible(B, A2, C), [{ start: 2, addedCount: 0, baseStart: 2, removedLines: ['c', 'd'] }]);
});

test('user deletes lines around the AI deletion point → not forwarded', () => {
  const A2 = L('a', 'b', 'e', 'f', 'g'); // AI deletes c, d (point at index 2)
  const C = L('a', 'f', 'g'); // user deletes b, e
  assert.equal(forwardUserEdits(B, A2, C), B);
});

test('user manually reverts the AI block → nothing highlighted', () => {
  const C = B;
  assert.deepEqual(visible(B, A, C), []);
});

test('AI deletes lines, user retypes them → no highlight and no duplicates', () => {
  const A2 = L('a', 'b', 'e', 'f', 'g'); // AI deletes c, d
  assert.equal(forwardUserEdits(B, A2, B), B);
  assert.deepEqual(visible(B, A2, B), []);
});

test('editor document not reloaded yet (still = baseline) → baseline unchanged', () => {
  for (const ai of [A, L('a', 'b', 'e', 'f', 'g'), L('a', 'b', 'c', 'X', 'd', 'e', 'f', 'g')]) {
    assert.equal(forwardUserEdits(B, ai, B), B);
  }
});

test('several AI blocks and several user edits', () => {
  const B2 = L('1', '2', '3', '4', '5', '6', '7', '8');
  const A2 = L('1', 'AI', '2', '3', '4', '6', '7', '8'); // AI inserts after 1, deletes 5
  const C2 = L('1', 'AI', '2', 'three', '4', '6', '7', 'eight'); // user edits 3 and 8
  assert.equal(forwardUserEdits(B2, A2, C2), L('1', '2', 'three', '4', '5', '6', '7', 'eight'));
  assert.equal(visible(B2, A2, C2).length, 2);
});

test('file without a trailing newline', () => {
  const B2 = 'a\nb\nc';
  const A2 = 'a\nB\nc';
  const C2 = 'a\nB\nc!';
  assert.equal(forwardUserEdits(B2, A2, C2), 'a\nb\nc!');
});
