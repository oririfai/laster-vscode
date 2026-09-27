/**
 * Classifies an in-editor text change as the user's or not (very aggressive: when in doubt, AI).
 * Pure: takes plain data so it can be unit-tested without VSCode.
 */

export interface Pos {
  line: number;
  character: number;
}

export interface Rng {
  start: Pos;
  end: Pos;
}

export interface ChangeLite {
  range: Rng;
  text: string;
}

export interface ClassifyInput {
  changes: readonly ChangeLite[];
  /** The document is shown in the active (focused) editor. */
  isActiveEditor: boolean;
  /** Selections of that editor *before* the change. */
  selections: readonly Rng[];
  reason?: 'undo' | 'redo';
  /** A git operation (checkout, pull, ...) is running; the editor is reloading files it changed. */
  gitOperation: boolean;
  /** A wrapped user command (paste, format, rename, quick fix, ...) is in progress. */
  userIntent: boolean;
  /** An AI command (accept inline suggestion, "Paste as AI Code") is in progress. */
  aiIntent: boolean;
  /** Laster itself is editing the document (revert). */
  selfEdit: boolean;
}

export type Classification = 'ignore' | 'user' | 'ai';

/** Typed text larger than this is not "typing" (snippets, auto-indent and auto-close stay well below). */
const MAX_TYPED_LINES = 3;
const MAX_TYPED_CHARS = 200;

export function classifyChange(input: ClassifyInput): Classification {
  if (input.changes.length === 0) {
    return 'ignore';
  }
  if (input.selfEdit) {
    return 'user';
  }
  if (input.gitOperation) {
    return 'ignore';
  }
  if (input.aiIntent) {
    return 'ai';
  }
  if (input.reason || input.userIntent) {
    return 'user';
  }
  if (!input.isActiveEditor) {
    return 'ai';
  }
  return input.changes.every((c) => isTypingAtCursor(c, input.selections)) ? 'user' : 'ai';
}

/** A small change on (or right next to) a line where the user has a cursor or selection. */
function isTypingAtCursor(change: ChangeLite, selections: readonly Rng[]): boolean {
  const lines = change.text.split('\n').length;
  if (lines > MAX_TYPED_LINES || change.text.length > MAX_TYPED_CHARS) {
    return false;
  }
  return selections.some((s) => {
    const top = Math.min(s.start.line, s.end.line) - 1;
    const bottom = Math.max(s.start.line, s.end.line) + 1;
    return change.range.start.line >= top && change.range.end.line <= bottom;
  });
}
