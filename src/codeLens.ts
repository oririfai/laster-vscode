import * as vscode from 'vscode';
import { hunkLine, lines } from './hunkUi';
import { Tracker } from './tracker';

/** `✓ Approve | ↺ Revert | ⊙ Peek` above every unreviewed hunk. */
export class HunkCodeLens implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly disposables: vscode.Disposable[];

  constructor(
    private readonly tracker: Tracker,
    private readonly isEnabled: () => boolean,
  ) {
    this.disposables = [
      this.emitter,
      tracker.onDidChange(() => this.emitter.fire()),
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this),
    ];
  }

  refresh(): void {
    this.emitter.fire();
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
  }

  async provideCodeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const hunks = this.isEnabled() ? await this.tracker.hunksFor(doc) : undefined;
    if (!hunks) {
      return [];
    }
    const lastLine = Math.max(doc.lineCount - 1, 0);
    const lenses: vscode.CodeLens[] = [];
    for (const h of hunks) {
      const range = new vscode.Range(hunkLine(h, lastLine), 0, hunkLine(h, lastLine), 0);
      const args = [doc.uri.toString(), h.start];
      const label =
        h.addedCount === 0
          ? `Laster: ${lines(h.removedLines.length)} deleted`
          : h.removedLines.length === 0
            ? `Laster: +${h.addedCount}`
            : `Laster: +${h.addedCount} −${h.removedLines.length}`;
      lenses.push(new vscode.CodeLens(range, { title: label, command: '' }));
      lenses.push(new vscode.CodeLens(range, { title: '✓ Approve', command: 'laster.approveHunk', arguments: args }));
      lenses.push(new vscode.CodeLens(range, { title: '↺ Revert', command: 'laster.revertHunk', arguments: args }));
      if (h.removedLines.length > 0) {
        lenses.push(new vscode.CodeLens(range, { title: '⊙ Peek', command: 'laster.peekHunk', arguments: args }));
      }
    }
    return lenses;
  }
}
