import * as path from 'node:path';
import * as vscode from 'vscode';
import { HunkCodeLens } from './codeLens';
import { Decorations } from './decorations';
import { EditorWatcher } from './editorWatcher';
import { PendingFileDecorations } from './fileDecorations';
import { BASE_SCHEME, baselineUri, hunkAtLine, hunkLine } from './hunkUi';
import { ReviewNode, ReviewView } from './reviewView';
import { PendingInfo, Tracker } from './tracker';

/** Used by the integration tests. */
export interface LasterApi {
  tracker: Tracker;
  ready: Promise<void>;
  editorWatcher: EditorWatcher;
  reviewView: ReviewView;
  fileDecorations: PendingFileDecorations;
}

export async function activate(context: vscode.ExtensionContext): Promise<LasterApi | undefined> {
  if (!vscode.workspace.workspaceFolders?.length || !context.storageUri) {
    return undefined;
  }
  // Stored outside the project folder so AI agents cannot read or modify the baseline.
  await vscode.workspace.fs.createDirectory(context.storageUri);

  const t = new Tracker(context.storageUri.fsPath);
  const decorations = new Decorations(t, context.extensionUri);
  const codeLens = new HunkCodeLens(t, () => decorations.isEnabled);
  const view = new ReviewView(t);
  const watcher = new EditorWatcher(t);
  const fileDecorations = new PendingFileDecorations(t);
  const baseChanged = new vscode.EventEmitter<vscode.Uri>();

  context.subscriptions.push(
    t,
    decorations,
    codeLens,
    view,
    watcher,
    fileDecorations,
    baseChanged,
    // Effective baseline content for the diff view and peek; refreshed whenever the baseline changes.
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, {
      onDidChange: baseChanged.event,
      provideTextDocumentContent: async (uri) => {
        if (!uri.query) {
          return '';
        }
        const target = vscode.Uri.parse(uri.query);
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.query);
        const current = doc?.getText();
        return ((current !== undefined ? await t.effectiveBaseline(target, current) : await t.baselineText(target)) ?? '');
      },
    }),
    t.onDidChange(() => {
      for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.scheme === BASE_SCHEME) {
          baseChanged.fire(doc.uri);
        }
      }
    }),

    // ---- per file
    vscode.commands.registerCommand('laster.approveFile', async (arg?: unknown) => {
      const uri = resolveUri(arg);
      if (uri) {
        await t.approve(uri);
      }
    }),
    vscode.commands.registerCommand('laster.revertFile', async (arg?: unknown) => {
      const uri = resolveUri(arg);
      const info = uri && t.getPending(uri);
      if (uri && info && (await confirmRevert([info]))) {
        await t.revert(uri);
      }
    }),
    vscode.commands.registerCommand('laster.openDiff', async (arg?: unknown) => {
      const uri = resolveUri(arg);
      const info = uri && t.getPending(uri);
      if (uri && info) {
        await openDiff(info);
      }
    }),

    // ---- per hunk: arguments (uri string, hunk start line)
    vscode.commands.registerCommand('laster.approveHunk', async (...args: unknown[]) => {
      const target = resolveHunk(args);
      if (target) {
        await t.approveHunkAt(target.uri, target.start);
      }
    }),
    vscode.commands.registerCommand('laster.revertHunk', async (...args: unknown[]) => {
      const target = resolveHunk(args);
      if (target) {
        await t.revertHunkAt(target.uri, target.start);
      }
    }),
    vscode.commands.registerCommand('laster.peekHunk', async (...args: unknown[]) => {
      const target = resolveHunk(args);
      if (target) {
        await peekHunk(t, target.uri, target.start);
      }
    }),
    vscode.commands.registerCommand('laster.approveHunkAtCursor', () => atCursor(t, (uri, start) => t.approveHunkAt(uri, start))),
    vscode.commands.registerCommand('laster.revertHunkAtCursor', () => atCursor(t, (uri, start) => t.revertHunkAt(uri, start))),
    vscode.commands.registerCommand('laster.nextHunk', () => navigate(t, 1)),
    vscode.commands.registerCommand('laster.previousHunk', () => navigate(t, -1)),

    // ---- all files
    vscode.commands.registerCommand('laster.approveAll', async () => {
      const all = t.pendingFiles();
      if (!all.length) {
        return;
      }
      const ok = await vscode.window.showInformationMessage(
        `Approve all changes in ${all.length} ${all.length === 1 ? 'file' : 'files'}?`,
        { modal: true },
        'Approve All',
      );
      if (ok) {
        for (const info of all) {
          await t.approve(info.uri);
        }
      }
    }),
    vscode.commands.registerCommand('laster.revertAll', async () => {
      const all = t.pendingFiles();
      if (all.length && (await confirmRevert(all))) {
        for (const info of all) {
          await t.revert(info.uri);
        }
      }
    }),
    // ---- per batch (tree nodes)
    vscode.commands.registerCommand('laster.approveBatch', async (node?: ReviewNode) => {
      for (const info of node?.type === 'batch' ? node.batch.items : []) {
        await t.approve(info.uri);
      }
    }),
    vscode.commands.registerCommand('laster.revertBatch', async (node?: ReviewNode) => {
      const items = node?.type === 'batch' ? node.batch.items : [];
      if (items.length && (await confirmRevert(items))) {
        for (const info of items) {
          await t.revert(info.uri);
        }
      }
    }),
    // Same effect as Approve; offered where Laster could only guess that an in-editor edit was not the user's.
    vscode.commands.registerCommand('laster.markAsMine', async (arg?: unknown) => {
      const node = arg as ReviewNode | undefined;
      const uris = node?.type === 'batch' ? node.batch.items.map((i) => i.uri) : [resolveUri(arg)].filter((u): u is vscode.Uri => !!u);
      for (const uri of uris) {
        await t.approve(uri);
      }
    }),

    // ---- wrapped editor commands: tell the editor watcher who is about to edit, then run the original
    vscode.commands.registerCommand('laster.acceptInlineSuggestion', () => {
      watcher.markAiIntent();
      return vscode.commands.executeCommand('editor.action.inlineSuggest.commit');
    }),
    vscode.commands.registerCommand('laster.acceptInlineSuggestionNextWord', () => {
      watcher.markAiIntent();
      return vscode.commands.executeCommand('editor.action.inlineSuggest.acceptNextWord');
    }),
    vscode.commands.registerCommand('laster.pasteAsAi', () => {
      watcher.markAiIntent();
      return vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    }),
    ...USER_COMMANDS.map(([id, original, ms]) =>
      vscode.commands.registerCommand(id, () => {
        watcher.markUserIntent(ms);
        return vscode.commands.executeCommand(original);
      }),
    ),

    vscode.commands.registerCommand('laster.toggleHighlights', () => {
      const on = decorations.toggle();
      codeLens.refresh();
      void vscode.window.setStatusBarMessage(`Laster: highlights ${on ? 'on' : 'hidden'}`, 2000);
    }),
  );

  const ready = t.start();
  return { tracker: t, ready, editorWatcher: watcher, reviewView: view, fileDecorations };
}

export function deactivate(): void {}

/**
 * User commands Laster wraps (through keybindings) so their multi-location edits are not mistaken for AI.
 * [wrapper id, original command, how long the edit may take to arrive (ms)].
 * Rename and quick fix open UI first, so the window is long; it shrinks after the first edit.
 */
const USER_COMMANDS: [string, string, number][] = [
  ['laster.paste', 'editor.action.clipboardPasteAction', 2000],
  ['laster.formatDocument', 'editor.action.formatDocument', 5000],
  ['laster.formatSelection', 'editor.action.formatSelection', 5000],
  ['laster.organizeImports', 'editor.action.organizeImports', 5000],
  ['laster.rename', 'editor.action.rename', 20_000],
  ['laster.quickFix', 'editor.action.quickFix', 20_000],
];

/** The argument can be a Uri (tree item / editor title), a PendingInfo, a uri string (hover link), or empty (active file). */
function resolveUri(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) {
    return arg;
  }
  if (typeof arg === 'string') {
    return vscode.Uri.parse(arg);
  }
  if (arg && typeof arg === 'object' && 'uri' in arg && (arg as PendingInfo).uri instanceof vscode.Uri) {
    return (arg as PendingInfo).uri;
  }
  const node = arg as ReviewNode | undefined;
  if (node?.type === 'file' || node?.type === 'hunk') {
    return node.info.uri;
  }
  return vscode.window.activeTextEditor?.document.uri;
}

/** Per-hunk commands get either (uri string, start line) from CodeLens/hover links, or a hunk node from the tree. */
function resolveHunk(args: unknown[]): { uri: vscode.Uri; start: number } | undefined {
  const [first, second] = args;
  if (typeof first === 'string' && typeof second === 'number') {
    return { uri: vscode.Uri.parse(first), start: second };
  }
  const node = first as ReviewNode | undefined;
  return node?.type === 'hunk' ? { uri: node.info.uri, start: node.hunk.start } : undefined;
}

async function atCursor(t: Tracker, action: (uri: vscode.Uri, start: number) => Promise<void>): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const hunks = editor && (await t.hunksFor(editor.document));
  const hunk = hunks && hunkAtLine(hunks, editor.selection.active.line, Math.max(editor.document.lineCount - 1, 0));
  if (editor && hunk) {
    await action(editor.document.uri, hunk.start);
  } else {
    void vscode.window.setStatusBarMessage('Laster: no change at the cursor', 2000);
  }
}

/** Jump to the next/previous hunk; at the end of a file, continue with the next pending file. */
async function navigate(t: Tracker, dir: 1 | -1): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const hunks = (await t.hunksFor(editor.document)) ?? [];
    const lastLine = Math.max(editor.document.lineCount - 1, 0);
    const lines = hunks.map((h) => hunkLine(h, lastLine));
    const cur = editor.selection.active.line;
    const target = dir === 1 ? lines.find((l) => l > cur) : [...lines].reverse().find((l) => l < cur);
    if (target !== undefined) {
      reveal(editor, target);
      return;
    }
  }

  const files = t.pendingFiles().filter((p) => p.kind !== 'deleted');
  if (!files.length) {
    void vscode.window.setStatusBarMessage('Laster: no changes pending review', 2000);
    return;
  }
  const idx = editor ? files.findIndex((p) => p.uri.toString() === editor.document.uri.toString()) : -1;
  const next = files[(idx + dir + files.length) % files.length] ?? files[0];
  const nextEditor = await vscode.window.showTextDocument(next.uri);
  const hunks = (await t.hunksFor(nextEditor.document)) ?? [];
  if (hunks.length) {
    const lastLine = Math.max(nextEditor.document.lineCount - 1, 0);
    reveal(nextEditor, hunkLine(dir === 1 ? hunks[0] : hunks[hunks.length - 1], lastLine));
  }
}

function reveal(editor: vscode.TextEditor, line: number): void {
  const pos = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/** Show a hunk's "before" code as an inline peek (an embedded editor below the line). */
async function peekHunk(t: Tracker, uri: vscode.Uri, start: number): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const hunks = (await t.hunksFor(doc)) ?? [];
  const hunk = hunks.find((h) => h.start === start);
  if (!hunk || hunk.removedLines.length === 0) {
    return;
  }
  const lastLine = Math.max(doc.lineCount - 1, 0);
  const endLine = hunk.baseStart + hunk.removedLines.length - 1;
  const location = new vscode.Location(
    baselineUri(uri),
    new vscode.Range(hunk.baseStart, 0, endLine, hunk.removedLines[hunk.removedLines.length - 1].length),
  );
  await vscode.commands.executeCommand('editor.action.peekLocations', uri, new vscode.Position(hunkLine(hunk, lastLine), 0), [location], 'peek');
}

async function confirmRevert(infos: PendingInfo[]): Promise<boolean> {
  const newFiles = infos.filter((i) => i.kind === 'added');
  const message =
    infos.length === 1
      ? `Revert ${vscode.workspace.asRelativePath(infos[0].uri)} to how it was before the change?`
      : `Revert ${infos.length} files to how they were before the changes?`;
  const detail = newFiles.length ? `${newFiles.length} new ${newFiles.length === 1 ? 'file' : 'files'} will be moved to the Trash.` : undefined;
  const ok = await vscode.window.showWarningMessage(message, { modal: true, detail }, 'Revert');
  return ok === 'Revert';
}

async function openDiff(info: PendingInfo): Promise<void> {
  const base = baselineUri(info.uri);
  const current = info.kind === 'deleted' ? vscode.Uri.from({ scheme: BASE_SCHEME, path: info.uri.path }) : info.uri;
  const name = path.posix.basename(info.uri.path);
  await vscode.commands.executeCommand('vscode.diff', base, current, `${name} (before ↔ now) · Laster`);
}
