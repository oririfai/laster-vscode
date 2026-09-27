import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChangeLite, classifyChange, ClassifyInput, Rng } from '../core/classify';

const at = (line: number, character = 0): Rng => ({ start: { line, character }, end: { line, character } });
const change = (line: number, text: string, endLine = line): ChangeLite => ({
  range: { start: { line, character: 0 }, end: { line: endLine, character: 0 } },
  text,
});

function input(over: Partial<ClassifyInput>): ClassifyInput {
  return {
    changes: [change(10, 'x')],
    isActiveEditor: true,
    selections: [at(10, 5)],
    gitOperation: false,
    userIntent: false,
    aiIntent: false,
    selfEdit: false,
    ...over,
  };
}

test('typing at the cursor in the active editor → user', () => {
  assert.equal(classifyChange(input({})), 'user');
});

test('Enter with auto-indent on the next line → user', () => {
  assert.equal(classifyChange(input({ changes: [change(10, '\n    ')] })), 'user');
});

test('multi-cursor typing → user', () => {
  assert.equal(classifyChange(input({ changes: [change(3, 'a'), change(20, 'a')], selections: [at(3), at(20)] })), 'user');
});

test('deleting a multi-line selection → user', () => {
  const sel: Rng = { start: { line: 5, character: 0 }, end: { line: 40, character: 0 } };
  assert.equal(classifyChange(input({ changes: [change(5, '', 40)], selections: [sel] })), 'user');
});

test('an edit far away from the cursor → ai', () => {
  assert.equal(classifyChange(input({ changes: [change(80, 'x')] })), 'ai');
});

test('a large insertion at the cursor (e.g. chat "insert at cursor") → ai', () => {
  assert.equal(classifyChange(input({ changes: [change(10, 'a\nb\nc\nd\ne\n')] })), 'ai');
});

test('an edit in a document that is not in the active editor → ai', () => {
  assert.equal(classifyChange(input({ isActiveEditor: false })), 'ai');
});

test('one of several changes is far from every cursor → ai', () => {
  assert.equal(classifyChange(input({ changes: [change(10, 'x'), change(90, 'y')] })), 'ai');
});

test('undo/redo → user, even far away', () => {
  assert.equal(classifyChange(input({ reason: 'undo', changes: [change(80, 'x')] })), 'user');
  assert.equal(classifyChange(input({ reason: 'redo', isActiveEditor: false })), 'user');
});

test('wrapped user command (paste, format, rename) → user', () => {
  assert.equal(classifyChange(input({ userIntent: true, changes: [change(80, 'a\nb\nc\nd\ne\n')] })), 'user');
});

test('AI intent (accepted inline suggestion) wins over everything', () => {
  assert.equal(classifyChange(input({ aiIntent: true })), 'ai');
  assert.equal(classifyChange(input({ aiIntent: true, userIntent: true })), 'ai');
});

test('editor reloading files during a git operation → ignore', () => {
  assert.equal(classifyChange(input({ gitOperation: true, isActiveEditor: false })), 'ignore');
});

test("Laster's own edits → user", () => {
  assert.equal(classifyChange(input({ selfEdit: true, isActiveEditor: false })), 'user');
});

test('no content changes → ignore', () => {
  assert.equal(classifyChange(input({ changes: [] })), 'ignore');
});
