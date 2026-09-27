import * as vscode from 'vscode';
import { PendingInfo, Tracker } from './tracker';

const KIND_TEXT: Record<PendingInfo['kind'], string> = {
  modified: 'modified',
  added: 'new file',
  deleted: 'deleted',
};

/**
 * Marks files pending review in the explorer and on editor tabs, and every folder above them
 * (nested, up to the workspace root) so changed files can be found from a collapsed tree.
 */
export class PendingFileDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private files = new Map<string, PendingInfo>();
  /** Folder uri → number of pending files anywhere below it. */
  private folders = new Map<string, number>();
  private readonly disposables: vscode.Disposable[];

  constructor(private readonly tracker: Tracker) {
    this.disposables = [
      this.emitter,
      vscode.window.registerFileDecorationProvider(this),
      tracker.onDidChange(() => this.update()),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('laster.explorerDecorations') && this.update()),
    ];
    this.update();
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const key = uri.toString();
    const info = this.files.get(key);
    if (info) {
      const { added, removed } = info.stats;
      return {
        badge: 'C',
        tooltip: `Laster: ${KIND_TEXT[info.kind]} by someone other than you (+${added} −${removed}), pending review`,
        color: new vscode.ThemeColor('laster.fileDecorationForeground'),
      };
    }
    const count = this.folders.get(key);
    if (count) {
      return {
        badge: '•',
        tooltip: `Laster: ${count} ${count === 1 ? 'file' : 'files'} pending review inside`,
        color: new vscode.ThemeColor('laster.fileDecorationForeground'),
      };
    }
    return undefined;
  }

  private update(): void {
    const enabled = vscode.workspace.getConfiguration('laster').get<boolean>('explorerDecorations', true);
    const files = new Map<string, PendingInfo>();
    const folders = new Map<string, number>();
    for (const info of enabled ? this.tracker.pendingFiles() : []) {
      files.set(info.uri.toString(), info);
      for (const folder of ancestors(info.uri)) {
        folders.set(folder, (folders.get(folder) ?? 0) + 1);
      }
    }

    // Refresh everything that was or is decorated, but only when something actually changed.
    const changed = new Set<string>();
    for (const key of new Set([...this.files.keys(), ...files.keys()])) {
      if (this.files.get(key)?.stats !== files.get(key)?.stats || this.files.has(key) !== files.has(key)) {
        changed.add(key);
      }
    }
    for (const key of new Set([...this.folders.keys(), ...folders.keys()])) {
      if (this.folders.get(key) !== folders.get(key)) {
        changed.add(key);
      }
    }
    this.files = files;
    this.folders = folders;
    if (changed.size) {
      this.emitter.fire([...changed].map((k) => vscode.Uri.parse(k)));
    }
  }
}

/** Folders containing `uri`, from its parent up to (and including) its workspace folder. */
export function ancestors(uri: vscode.Uri): string[] {
  const root = vscode.workspace.getWorkspaceFolder(uri)?.uri;
  if (!root) {
    return [];
  }
  const result: string[] = [];
  let current = vscode.Uri.joinPath(uri, '..');
  while (current.path.length >= root.path.length && current.path.startsWith(root.path)) {
    result.push(current.toString());
    if (current.path === root.path) {
      break;
    }
    current = vscode.Uri.joinPath(current, '..');
  }
  return result;
}
