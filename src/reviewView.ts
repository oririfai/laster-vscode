import * as path from 'node:path';
import * as vscode from 'vscode';
import { Batch, groupIntoBatches } from './core/batches';
import { Hunk } from './core/hunks';
import { lines } from './hunkUi';
import { PendingInfo, Tracker } from './tracker';

const KIND_LABEL: Record<PendingInfo['kind'], string> = {
  modified: 'modified',
  added: 'new',
  deleted: 'deleted',
};

export type ReviewNode =
  | { type: 'batch'; batch: Batch<PendingInfo> }
  | { type: 'file'; info: PendingInfo }
  | { type: 'hunk'; info: PendingInfo; hunk: Hunk };

/** A batch made only of heuristic in-editor edits may well be the user's own work. */
export function maybeUserBatch(batch: Batch<PendingInfo>): boolean {
  return batch.items.every((i) => i.source === 'editor');
}

/** The "Pending Review" panel: time-based batches → files → hunks. */
export class ReviewView implements vscode.TreeDataProvider<ReviewNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly view: vscode.TreeView<ReviewNode>;
  private readonly statusItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(private readonly tracker: Tracker) {
    this.view = vscode.window.createTreeView('laster.review', { treeDataProvider: this, showCollapseAll: true });
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusItem.command = 'laster.review.focus';
    this.disposables.push(
      this.view,
      this.statusItem,
      this.emitter,
      tracker.onDidChange(() => this.scheduleUpdate()),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateContext()),
    );
    this.update();
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    vscode.Disposable.from(...this.disposables).dispose();
  }

  async getChildren(node?: ReviewNode): Promise<ReviewNode[]> {
    if (!node) {
      return groupIntoBatches(this.tracker.pendingFiles(), (i) => i.detectedAt).map((batch) => ({ type: 'batch', batch }));
    }
    if (node.type === 'batch') {
      return node.batch.items
        .slice()
        .sort((a, b) => a.uri.path.localeCompare(b.uri.path))
        .map((info) => ({ type: 'file', info }));
    }
    if (node.type === 'file' && node.info.kind !== 'deleted') {
      const doc = await vscode.workspace.openTextDocument(node.info.uri);
      const hunks = (await this.tracker.hunksFor(doc)) ?? [];
      return hunks.map((hunk) => ({ type: 'hunk', info: node.info, hunk }));
    }
    return [];
  }

  getTreeItem(node: ReviewNode): vscode.TreeItem {
    switch (node.type) {
      case 'batch':
        return this.batchItem(node.batch);
      case 'file':
        return this.fileItem(node.info);
      case 'hunk':
        return this.hunkItem(node.info, node.hunk);
    }
  }

  private batchItem(batch: Batch<PendingInfo>): vscode.TreeItem {
    const time = new Date(batch.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const item = new vscode.TreeItem(time, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `batch:${batch.start}`;
    const added = batch.items.reduce((n, i) => n + i.stats.added, 0);
    const removed = batch.items.reduce((n, i) => n + i.stats.removed, 0);
    const files = `${batch.items.length} ${batch.items.length === 1 ? 'file' : 'files'}`;
    const maybeMine = maybeUserBatch(batch);
    item.description = `${files} · +${added} −${removed}${maybeMine ? ' · maybe your edits?' : ''}`;
    item.tooltip = maybeMine
      ? 'Edits made inside the editor that could not be proven to be yours. If they are, use "Mark as My Edit".'
      : `Changes detected around ${time}`;
    item.iconPath = new vscode.ThemeIcon(maybeMine ? 'question' : 'history');
    item.contextValue = maybeMine ? 'laster.batch.maybeMine' : 'laster.batch';
    return item;
  }

  private fileItem(info: PendingInfo): vscode.TreeItem {
    const deleted = info.kind === 'deleted';
    const item = new vscode.TreeItem(info.uri, deleted ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `file:${info.uri.toString()}`;
    const rel = vscode.workspace.asRelativePath(info.uri, true);
    const dir = path.posix.dirname(rel);
    const { added, removed } = info.stats;
    const via = info.source === 'disk' ? 'from disk' : info.source === 'ai' ? 'AI in editor' : 'in editor';
    item.description = `${dir === '.' ? '' : dir + ' · '}${KIND_LABEL[info.kind]} +${added} −${removed}`;
    item.tooltip = `${rel}\n${KIND_LABEL[info.kind]} · +${added} −${removed} · ${via}\nNot reviewed yet`;
    item.contextValue = info.source === 'editor' ? 'laster.pendingFile.maybeMine' : 'laster.pendingFile';
    item.command = deleted
      ? { command: 'laster.openDiff', title: 'Open Diff', arguments: [info.uri] }
      : { command: 'vscode.open', title: 'Open', arguments: [info.uri] };
    return item;
  }

  private hunkItem(info: PendingInfo, h: Hunk): vscode.TreeItem {
    const label =
      h.addedCount > 0 ? `Lines ${h.start + 1}–${h.start + h.addedCount}` : `Line ${h.start + 1}: ${lines(h.removedLines.length)} deleted`;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = `hunk:${info.uri.toString()}#${h.start}`;
    item.description = h.addedCount > 0 ? `+${h.addedCount} −${h.removedLines.length}` : '';
    item.iconPath = new vscode.ThemeIcon(h.addedCount === 0 ? 'remove' : h.removedLines.length === 0 ? 'add' : 'edit');
    item.contextValue = 'laster.hunk';
    const line = h.addedCount > 0 ? h.start : Math.max(h.start - 1, 0);
    item.command = {
      command: 'vscode.open',
      title: 'Go to Change',
      arguments: [info.uri, { selection: new vscode.Range(line, 0, line, 0) } satisfies vscode.TextDocumentShowOptions],
    };
    return item;
  }

  private scheduleUpdate(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.update(), 200);
  }

  private update(): void {
    this.emitter.fire();
    const count = this.tracker.pendingFiles().length;
    const tooltip = `${count} ${count === 1 ? 'file' : 'files'} pending review`;
    this.view.badge = count ? { value: count, tooltip } : undefined;
    if (count) {
      this.statusItem.text = `$(eye) Laster: ${count}`;
      this.statusItem.tooltip = tooltip;
      this.statusItem.show();
    } else {
      this.statusItem.hide();
    }
    void vscode.commands.executeCommand('setContext', 'laster.hasPending', count > 0);
    this.updateContext();
  }

  private updateContext(): void {
    const uri = vscode.window.activeTextEditor?.document.uri;
    void vscode.commands.executeCommand('setContext', 'laster.activeFilePending', !!(uri && this.tracker.getPending(uri)));
  }
}
