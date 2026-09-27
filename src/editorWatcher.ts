import * as vscode from 'vscode';
import { classifyChange, Rng } from './core/classify';
import { Tracker } from './tracker';

/** AI edits closer together than this are recorded as one burst (e.g. an agent streaming edits). */
const AI_BURST_MS = 300;
/** How long an AI intent (accepting an inline suggestion) stays armed, and how long it lingers after the first edit. */
const AI_INTENT_MS = 1000;
const AI_INTENT_TAIL_MS = 300;
/** After the first edit of a wrapped user command, further edits in this window still belong to it (multi-file rename). */
const USER_INTENT_TAIL_MS = 1000;

interface Burst {
  before: string;
  source: 'editor' | 'ai';
  timer: NodeJS.Timeout;
  /** The document was saved during the burst (an agent that edits and saves right away). */
  saved: boolean;
}

/**
 * Watches edits made inside VSCode and reports the ones that are not proven to be the user's
 * (in-editor agents like Cline, Continue, Copilot Edits, accepted inline suggestions).
 */
export class EditorWatcher implements vscode.Disposable {
  /** Last known text of every open, trackable document (the "before" of the next change). */
  private readonly shadow = new Map<string, string>();
  /** Selections of the editor showing each document, as of before the next change. */
  private readonly selections = new Map<string, Rng[]>();
  private readonly bursts = new Map<string, Burst>();
  private readonly disposables: vscode.Disposable[] = [];
  private userIntentUntil = 0;
  private aiIntentUntil = 0;

  constructor(private readonly tracker: Tracker) {
    for (const doc of vscode.workspace.textDocuments) {
      this.remember(doc);
    }
    for (const editor of vscode.window.visibleTextEditors) {
      this.rememberSelections(editor);
    }
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => this.remember(doc)),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        this.shadow.delete(doc.uri.toString());
        this.selections.delete(doc.uri.toString());
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => this.rememberSelections(e.textEditor)),
      vscode.window.onDidChangeActiveTextEditor((e) => e && this.rememberSelections(e)),
      vscode.workspace.onDidChangeTextDocument((e) => this.onChange(e)),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        const burst = this.bursts.get(doc.uri.toString());
        if (burst) {
          burst.saved = true;
        }
      }),
    );
  }

  dispose(): void {
    for (const b of this.bursts.values()) {
      clearTimeout(b.timer);
    }
    vscode.Disposable.from(...this.disposables).dispose();
  }

  /** A wrapped user command (paste, format, rename, quick fix) is about to edit. */
  markUserIntent(ms: number): void {
    this.userIntentUntil = Date.now() + ms;
  }

  /** An AI command (accepting an inline suggestion, "Paste as AI Code") is about to edit. */
  markAiIntent(): void {
    this.aiIntentUntil = Date.now() + AI_INTENT_MS;
  }

  private onChange(e: vscode.TextDocumentChangeEvent): void {
    const key = e.document.uri.toString();
    const before = this.shadow.get(key);
    if (before === undefined) {
      return;
    }
    const after = e.document.getText();
    this.shadow.set(key, after);
    if (!vscode.workspace.getConfiguration('laster').get<boolean>('trackEditorEdits', true)) {
      return;
    }

    const now = Date.now();
    const aiIntent = now < this.aiIntentUntil;
    const userIntent = now < this.userIntentUntil;
    const kind = classifyChange({
      changes: e.contentChanges.map((c) => ({ range: c.range, text: c.text })),
      isActiveEditor: vscode.window.activeTextEditor?.document === e.document,
      selections: this.selections.get(key) ?? [],
      reason:
        e.reason === vscode.TextDocumentChangeReason.Undo ? 'undo' : e.reason === vscode.TextDocumentChangeReason.Redo ? 'redo' : undefined,
      gitOperation: this.tracker.isGitOperation(now),
      userIntent,
      aiIntent,
      selfEdit: this.tracker.isSelfEditing(e.document.uri),
    });

    if (kind === 'ai' && aiIntent) {
      this.aiIntentUntil = Math.min(this.aiIntentUntil, now + AI_INTENT_TAIL_MS);
    }
    if (kind === 'user' && userIntent) {
      this.userIntentUntil = Math.min(this.userIntentUntil, now + USER_INTENT_TAIL_MS);
    }
    if (kind === 'ai') {
      this.extendBurst(e.document, before, aiIntent ? 'ai' : 'editor');
    }
  }

  private extendBurst(doc: vscode.TextDocument, before: string, source: 'editor' | 'ai'): void {
    const key = doc.uri.toString();
    const burst = this.bursts.get(key);
    if (burst) {
      clearTimeout(burst.timer);
    }
    const next: Burst = {
      before: burst?.before ?? before,
      source: burst?.source === 'ai' ? 'ai' : source,
      saved: burst?.saved ?? false,
      timer: setTimeout(() => {
        this.bursts.delete(key);
        // `isDirty` is only reliable now, not during the change event. A document that matches the disk
        // without having been saved was reloaded from disk (or reverted with "Revert File"): the disk path decides.
        if (!doc.isDirty && !next.saved) {
          return;
        }
        void this.tracker.recordEditorEdit(doc.uri, next.before, doc.getText(), next.source);
      }, AI_BURST_MS),
    };
    this.bursts.set(key, next);
  }

  private remember(doc: vscode.TextDocument): void {
    if (doc.uri.scheme !== 'file') {
      return;
    }
    const maxChars = vscode.workspace.getConfiguration('laster').get<number>('maxFileSizeKB', 1024) * 1024;
    const text = doc.getText();
    if (text.length <= maxChars) {
      this.shadow.set(doc.uri.toString(), text);
    }
  }

  private rememberSelections(editor: vscode.TextEditor): void {
    if (editor.document.uri.scheme === 'file') {
      this.selections.set(
        editor.document.uri.toString(),
        editor.selections.map((s) => ({ start: s.start, end: s.end })),
      );
    }
  }
}
