import * as vscode from 'vscode';
import { Hunk } from './core/hunks';

export const BASE_SCHEME = 'laster-base';

/** Virtual URI for a file's effective baseline (used by the diff view and peek). */
export function baselineUri(uri: vscode.Uri): vscode.Uri {
  return vscode.Uri.from({ scheme: BASE_SCHEME, path: uri.path, query: uri.toString() });
}

/** A pure deletion is shown on the line before where it happened (↓), or on line 0 if it was at the start of the file (↑). */
export function deletionAnchor(h: Hunk, lastLine: number): { line: number; below: boolean } {
  if (h.start === 0) {
    return { line: 0, below: false };
  }
  return { line: Math.min(h.start - 1, lastLine), below: true };
}

/** The line a hunk "lives" on in the editor (for CodeLens, navigation, and actions at the cursor). */
export function hunkLine(h: Hunk, lastLine: number): number {
  return h.addedCount > 0 ? h.start : deletionAnchor(h, lastLine).line;
}

export function hunkAtLine(hunks: Hunk[], line: number, lastLine: number): Hunk | undefined {
  return hunks.find((h) =>
    h.addedCount > 0 ? line >= h.start && line < h.start + h.addedCount : deletionAnchor(h, lastLine).line === line,
  );
}

/** "1 line", "3 lines". */
export function lines(n: number): string {
  return `${n} line${n === 1 ? '' : 's'}`;
}

export function commandLink(command: string, args: unknown[]): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}
