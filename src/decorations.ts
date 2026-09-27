import { diffWords } from 'diff';
import * as vscode from 'vscode';
import { Hunk } from './core/hunks';
import { commandLink, deletionAnchor, hunkAtLine, lines } from './hunkUi';
import { Tracker } from './tracker';

/** Per-word highlights only for small hunks (expensive and not useful for large blocks). */
const WORD_DIFF_MAX_LINES = 40;

/**
 * Green highlights for lines added/changed by a non-user (plus per-word highlights inside changed lines),
 * red markers for deleted lines, and a hover that shows the "before" code.
 */
export class Decorations implements vscode.Disposable, vscode.HoverProvider {
  private readonly addedType: vscode.TextEditorDecorationType;
  private readonly addedWordType: vscode.TextEditorDecorationType;
  private readonly deletedType: vscode.TextEditorDecorationType;
  private readonly replacedType: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  private enabled = true;

  constructor(
    private readonly tracker: Tracker,
    extensionUri: vscode.Uri,
  ) {
    this.addedType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('laster.addedBackground'),
      gutterIconPath: vscode.Uri.joinPath(extensionUri, 'media', 'gutter-added.svg'),
      gutterIconSize: 'contain',
      overviewRulerColor: new vscode.ThemeColor('laster.addedBackground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.addedWordType = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('laster.addedWordBackground'),
    });
    this.deletedType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      gutterIconPath: vscode.Uri.joinPath(extensionUri, 'media', 'gutter-deleted.svg'),
      gutterIconSize: 'contain',
      overviewRulerColor: new vscode.ThemeColor('laster.deletedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      after: { color: new vscode.ThemeColor('laster.deletedForeground'), margin: '0 0 0 2em', fontStyle: 'italic' },
    });
    this.replacedType = vscode.window.createTextEditorDecorationType({
      after: { color: new vscode.ThemeColor('laster.deletedForeground'), margin: '0 0 0 2em', fontStyle: 'italic' },
    });

    this.disposables.push(
      this.addedType,
      this.addedWordType,
      this.deletedType,
      this.replacedType,
      tracker.onDidChange(() => this.scheduleRefresh()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (tracker.getPending(e.document.uri)) {
          this.scheduleRefresh();
        }
      }),
      vscode.languages.registerHoverProvider({ scheme: 'file' }, this),
    );
    this.scheduleRefresh();
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  toggle(): boolean {
    this.enabled = !this.enabled;
    this.scheduleRefresh();
    return this.enabled;
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => void this.refreshAll(), 150);
  }

  private async refreshAll(): Promise<void> {
    for (const editor of vscode.window.visibleTextEditors) {
      await this.refresh(editor);
    }
  }

  private async refresh(editor: vscode.TextEditor): Promise<void> {
    const doc = editor.document;
    const hunks = this.enabled ? await this.tracker.hunksFor(doc) : undefined;
    const added: vscode.Range[] = [];
    const addedWords: vscode.Range[] = [];
    const deleted: vscode.DecorationOptions[] = [];
    const replaced: vscode.DecorationOptions[] = [];
    const lastLine = Math.max(doc.lineCount - 1, 0);

    for (const h of hunks ?? []) {
      if (h.addedCount > 0) {
        added.push(new vscode.Range(h.start, 0, h.start + h.addedCount - 1, 0));
        if (h.removedLines.length > 0) {
          const line = Math.min(h.start, lastLine);
          replaced.push({
            range: endOfLine(line),
            renderOptions: { after: { contentText: `⊖ ${lines(h.removedLines.length)} replaced` } },
          });
          addedWords.push(...wordRanges(doc, h));
        }
      } else {
        const { line, below } = deletionAnchor(h, lastLine);
        deleted.push({
          range: endOfLine(line),
          renderOptions: { after: { contentText: `⊖ ${lines(h.removedLines.length)} deleted ${below ? '↓' : '↑'}` } },
        });
      }
    }
    editor.setDecorations(this.addedType, added);
    editor.setDecorations(this.addedWordType, addedWords);
    editor.setDecorations(this.deletedType, deleted);
    editor.setDecorations(this.replacedType, replaced);
  }

  async provideHover(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Hover | undefined> {
    const hunks = this.enabled ? await this.tracker.hunksFor(doc) : undefined;
    const hunk = hunks && hunkAtLine(hunks, pos.line, Math.max(doc.lineCount - 1, 0));
    if (!hunk) {
      return undefined;
    }

    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = {
      enabledCommands: ['laster.approveHunk', 'laster.revertHunk', 'laster.peekHunk', 'laster.approveFile', 'laster.revertFile', 'laster.openDiff'],
    };
    md.supportThemeIcons = true;

    if (hunk.removedLines.length === 0) {
      md.appendMarkdown(`**Laster** · ${lines(hunk.addedCount)} added (not by you)\n\n`);
    } else {
      const what = hunk.addedCount > 0 ? 'Previously' : 'Deleted';
      md.appendMarkdown(`**Laster** · ${what} (${lines(hunk.removedLines.length)}):\n`);
      md.appendCodeblock(hunk.removedLines.join('\n'), doc.languageId);
    }

    const hunkArgs = [doc.uri.toString(), hunk.start];
    const fileArgs = [doc.uri.toString()];
    const links = [
      `[$(check) Approve](${commandLink('laster.approveHunk', hunkArgs)})`,
      `[$(discard) Revert](${commandLink('laster.revertHunk', hunkArgs)})`,
    ];
    if (hunk.removedLines.length > 0) {
      links.push(`[$(eye) Peek](${commandLink('laster.peekHunk', hunkArgs)})`);
    }
    md.appendMarkdown(`\n${links.join(' &nbsp; ')}\n\n`);
    md.appendMarkdown(
      `Whole file: [Approve](${commandLink('laster.approveFile', fileArgs)}) · ` +
        `[Revert](${commandLink('laster.revertFile', fileArgs)}) · ` +
        `[Diff](${commandLink('laster.openDiff', fileArgs)})`,
    );
    return new vscode.Hover(md);
  }
}

function endOfLine(line: number): vscode.Range {
  return new vscode.Range(line, Number.MAX_SAFE_INTEGER, line, Number.MAX_SAFE_INTEGER);
}

/** The words that actually changed inside a "replaced" hunk. */
function wordRanges(doc: vscode.TextDocument, h: Hunk): vscode.Range[] {
  if (h.addedCount > WORD_DIFF_MAX_LINES || h.removedLines.length > WORD_DIFF_MAX_LINES) {
    return [];
  }
  const startOffset = doc.offsetAt(new vscode.Position(h.start, 0));
  const endLine = h.start + h.addedCount - 1;
  const endOffset = doc.offsetAt(doc.lineAt(endLine).range.end);
  const addedText = doc.getText().slice(startOffset, endOffset).replace(/\r\n/g, '\n');
  const parts = diffWords(h.removedLines.join('\n'), addedText);

  // If almost everything changed, per-word highlights only add noise.
  const changedChars = parts.filter((p) => p.added).reduce((n, p) => n + p.value.length, 0);
  if (changedChars > addedText.length * 0.7) {
    return [];
  }

  const ranges: vscode.Range[] = [];
  const crlf = doc.eol === vscode.EndOfLine.CRLF;
  let offset = 0;
  for (const p of parts) {
    if (p.removed) {
      continue;
    }
    // Offset in the normalized text (\n) → offset in the document (possibly \r\n).
    const len = crlf ? p.value.length + (p.value.match(/\n/g)?.length ?? 0) : p.value.length;
    if (p.added && p.value.trim()) {
      ranges.push(new vscode.Range(doc.positionAt(startOffset + offset), doc.positionAt(startOffset + offset + len)));
    }
    offset += len;
  }
  return ranges;
}
