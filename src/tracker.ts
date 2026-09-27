import * as path from 'node:path';
import * as vscode from 'vscode';
import { BaselineMap, loadBaseline, saveBaseline } from './core/baselineFile';
import { decodeText, hashText, isBinary } from './core/content';
import { forwardUserEdits } from './core/forward';
import { GitActivity } from './core/gitActivity';
import { approveHunk, computeHunks, DiffStats, Hunk, revertHunk, statsOf } from './core/hunks';
import { splitKeep } from './core/lines';
import { ObjectStore } from './core/objectStore';
import { gitInternalPath, isExcludedPath } from './core/paths';

export type PendingKind = 'modified' | 'added' | 'deleted';

export interface PendingInfo {
  uri: vscode.Uri;
  kind: PendingKind;
  stats: DiffStats;
  /**
   * Hash of the file content right after the last non-user change (version "A" in the three-version model).
   * User edits = the difference A → current content. Undefined for deleted files.
   */
  aiHash?: string;
  /** When the file first became pending (kept across later changes; used for batching). */
  detectedAt: number;
  /**
   * Where the latest non-user change came from:
   * - `disk`: written to disk from outside VSCode (CLI agents, scripts).
   * - `editor`: an in-editor edit that could not be proven to be the user's (heuristic; may be a false positive).
   * - `ai`: an in-editor edit known to be AI (accepted inline suggestion, "Paste as AI Code").
   */
  source: ChangeSource;
}

export type ChangeSource = 'disk' | 'editor' | 'ai';

type DiskState =
  | { state: 'file'; bytes: Uint8Array; text: string; hash: string }
  | { state: 'missing' }
  | { state: 'skip' };

const DEBOUNCE_MS = 400;
const DOC_REFRESH_MS = 300;
/** Time window for recognizing watcher events that actually come from the user's own save. */
const OWN_SAVE_WINDOW_MS = 3000;

/**
 * Watches the workspace and decides which changes did not come from the user.
 *
 * Three-version model per pending file:
 * - B (baseline): the last content the user knew about / approved.
 * - A (`aiHash`): the content right after the last non-user change.
 * - C: the current content (the open document, or the disk).
 * What gets highlighted = diff(B', C), where B' = B + the user's edits (A→C) that lie outside AI regions.
 * See `forwardUserEdits`.
 */
export class Tracker implements vscode.Disposable {
  private baseline: BaselineMap = new Map();
  private readonly pending = new Map<string, PendingInfo>();
  private readonly objects: ObjectStore;
  private readonly baselineFile: string;
  private readonly git = new GitActivity();
  private readonly queue = new Map<string, { timer: NodeJS.Timeout; gitCaused: boolean; uri: vscode.Uri }>();
  private readonly docTimers = new Map<string, NodeJS.Timeout>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly savedHashes = new Map<string, { hash: string; time: number }>();
  private readonly savingKeys = new Map<string, number>();
  /** Documents Laster itself is editing right now (revert), so the editor watcher does not flag them. */
  private readonly selfEdits = new Set<string>();
  private readonly textCache = new Map<string, string>();
  private readonly hunkCache = new Map<string, { version: number; generation: number; hunks: Hunk[] }>();
  private readonly disposables: vscode.Disposable[] = [];
  private persistTimer: NodeJS.Timeout | undefined;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readyResolve!: () => void;
  private readonly ready = new Promise<void>((r) => (this.readyResolve = r));
  /** Bumped whenever the baseline/pending state changes; used to invalidate the hunk cache. */
  private generation = 0;

  /** Fires whenever the pending list or the baseline changes. */
  readonly onDidChange = this.changeEmitter.event;

  constructor(storageDir: string) {
    this.objects = new ObjectStore(path.join(storageDir, 'objects'));
    this.baselineFile = path.join(storageDir, 'baseline.json');
  }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'));
      watcher.onDidCreate((uri) => this.onFsEvent(uri, 'create'), null, this.disposables);
      watcher.onDidChange((uri) => this.onFsEvent(uri, 'change'), null, this.disposables);
      watcher.onDidDelete((uri) => this.onFsEvent(uri, 'delete'), null, this.disposables);
      this.disposables.push(watcher);
    }
    this.disposables.push(
      vscode.workspace.onWillSaveTextDocument((e) => this.savingKeys.set(e.document.uri.toString(), Date.now())),
      vscode.workspace.onDidSaveTextDocument((doc) => this.onUserSave(doc)),
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocChange(e.document)),
      // Creating/deleting files through the explorer or a WorkspaceEdit is not proof of the user (an in-editor
      // agent can do the same), so those go through the disk path. Renames keep the content, so the baseline moves.
      vscode.workspace.onDidRenameFiles((e) => this.onUserRename(e.files)),
    );

    const loaded = await loadBaseline(this.baselineFile);
    if (loaded) {
      this.baseline = loaded;
      await this.startupScan();
    } else {
      await this.initialSnapshot();
    }
    this.readyResolve();
    this.persist();
    this.notify();

    const keep = new Set([...this.baseline.values()].filter((h): h is string => !!h));
    for (const p of this.pending.values()) {
      if (p.aiHash) {
        keep.add(p.aiHash);
      }
    }
    void this.objects.gc(keep);
  }

  dispose(): void {
    for (const q of this.queue.values()) {
      clearTimeout(q.timer);
    }
    for (const t of this.docTimers.values()) {
      clearTimeout(t);
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      void saveBaseline(this.baselineFile, this.baseline);
    }
    vscode.Disposable.from(...this.disposables).dispose();
    this.changeEmitter.dispose();
  }

  // ---------------------------------------------------------------- public API

  pendingFiles(): PendingInfo[] {
    return [...this.pending.values()].sort((a, b) => a.uri.path.localeCompare(b.uri.path));
  }

  /** Whether file changes arriving at `time` are caused by a git operation. */
  isGitOperation(time: number): boolean {
    return this.git.isGitTime(time);
  }

  isSelfEditing(uri: vscode.Uri): boolean {
    return this.selfEdits.has(uri.toString());
  }

  getPending(uri: vscode.Uri): PendingInfo | undefined {
    return this.pending.get(uri.toString());
  }

  /** Raw baseline content (B) as text ('' for files that were not in the baseline). */
  async baselineText(uri: vscode.Uri): Promise<string | undefined> {
    const hash = this.baseline.get(uri.toString());
    if (hash === undefined) {
      return undefined;
    }
    return hash === null ? '' : this.textOf(hash);
  }

  /** Effective baseline (B'): the baseline plus the user's edits that lie outside AI-changed regions. */
  async effectiveBaseline(uri: vscode.Uri, current: string): Promise<string | undefined> {
    const base = await this.baselineText(uri);
    const p = this.pending.get(uri.toString());
    if (base === undefined || !p?.aiHash) {
      return base;
    }
    return forwardUserEdits(base, await this.textOf(p.aiHash), current);
  }

  /** Unreviewed hunks for this document (undefined if the file is not pending). */
  async hunksFor(doc: vscode.TextDocument): Promise<Hunk[] | undefined> {
    const key = doc.uri.toString();
    const p = this.pending.get(key);
    if (!p || p.kind === 'deleted') {
      return undefined;
    }
    const cached = this.hunkCache.get(key);
    if (cached && cached.version === doc.version && cached.generation === this.generation) {
      return cached.hunks;
    }
    const generation = this.generation;
    const text = doc.getText();
    const base = await this.effectiveBaseline(doc.uri, text);
    if (base === undefined) {
      return undefined;
    }
    const hunks = computeHunks(base, text);
    this.hunkCache.set(key, { version: doc.version, generation, hunks });
    return hunks;
  }

  /** Approve the whole file: the current disk content becomes the new baseline. */
  async approve(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    await this.serialize(key, async () => {
      const disk = await this.readDisk(uri);
      if (disk.state === 'file') {
        await this.objects.put(disk.hash, disk.bytes);
        this.baseline.set(key, disk.hash);
      } else {
        this.baseline.delete(key);
      }
      this.clearPending(key);
      this.persist();
    });
  }

  /** Approve one hunk (identified by its start line in the current document). */
  async approveHunkAt(uri: vscode.Uri, start: number): Promise<void> {
    const key = uri.toString();
    await this.serialize(key, async () => {
      const current = await this.currentText(uri);
      const base = current === undefined ? undefined : await this.effectiveBaseline(uri, current);
      if (current === undefined || base === undefined) {
        return;
      }
      const hunk = computeHunks(base, current).find((h) => h.start === start);
      if (!hunk) {
        return;
      }
      await this.storeBaseline(key, approveHunk(base, current, hunk));
      await this.refreshPending(uri);
    });
  }

  /** Revert one hunk in the document (undoable). The file is saved if it was not dirty before. */
  async revertHunkAt(uri: vscode.Uri, start: number): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const current = doc.getText();
    const base = await this.effectiveBaseline(uri, current);
    const hunk = base === undefined ? undefined : computeHunks(base, current).find((h) => h.start === start);
    if (base === undefined || !hunk) {
      return;
    }
    const cur = splitKeep(current);
    const startOffset = cur.slice(0, hunk.start).join('').length;
    const endOffset = startOffset + cur.slice(hunk.start, hunk.start + hunk.addedCount).join('').length;
    const replacement = splitKeep(base)
      .slice(hunk.baseStart, hunk.baseStart + hunk.removedLines.length)
      .join('');
    const wasDirty = doc.isDirty;

    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(doc.positionAt(startOffset), doc.positionAt(endOffset)), replacement);
    await this.applySelfEdit(uri, edit);
    if (doc.getText() !== revertHunk(base, current, hunk)) {
      console.warn('[laster] revertHunk: edit result does not match the expected content', uri.toString());
    }
    if (!wasDirty) {
      await doc.save();
    }
  }

  /** Revert the whole file to the effective baseline (user edits outside AI regions are kept). */
  async revert(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    const info = this.pending.get(key);
    const hash = this.baseline.get(key);
    if (!info || hash === undefined) {
      return;
    }

    if (hash === null && info.kind === 'added') {
      // New file created by a non-user → Revert = delete the file.
      await vscode.workspace.fs.delete(uri, { useTrash: true });
      return;
    }

    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
    if (doc && info.kind !== 'deleted') {
      // Through WorkspaceEdit so it can be undone with Ctrl+Z.
      const target = (await this.effectiveBaseline(uri, doc.getText())) ?? '';
      const edit = new vscode.WorkspaceEdit();
      const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
      edit.replace(uri, full, target);
      await this.applySelfEdit(uri, edit);
      await doc.save();
    } else if (hash !== null) {
      await vscode.workspace.fs.writeFile(uri, await this.objects.get(hash));
    }
  }

  /**
   * A non-user edit made inside the editor (not on disk yet). `before` is the document text just
   * before the edit (burst), `after` the text right after it.
   *
   * The user's own edits up to `before` are folded into the baseline first, then A := `after`.
   */
  async recordEditorEdit(uri: vscode.Uri, before: string, after: string, source: 'editor' | 'ai'): Promise<void> {
    const key = uri.toString();
    if (before === after || !this.isTrackable(uri)) {
      return;
    }
    await this.ready;
    await this.serialize(key, async () => {
      const p = this.pending.get(key);
      const base = this.baseline.get(key);
      if (p?.aiHash) {
        const forwarded = await this.effectiveBaseline(uri, before);
        if (forwarded !== undefined && forwarded !== (await this.baselineText(uri))) {
          await this.storeBaseline(key, forwarded);
        }
      } else if (base === undefined || (await this.baselineText(uri)) !== before) {
        // Not pending: everything up to `before` was the user's (including unsaved edits).
        await this.storeBaseline(key, before);
      }
      const aiHash = hashText(after);
      await this.objects.put(aiHash, Buffer.from(after, 'utf8'));
      this.setPending(key, {
        uri,
        kind: p?.kind === 'added' ? 'added' : 'modified',
        stats: p?.stats ?? { added: 0, removed: 0 },
        aiHash,
        detectedAt: p?.detectedAt ?? Date.now(),
        // A proven AI edit stays proven even if a later heuristic edit lands in the same file.
        source: p?.source === 'ai' || source === 'ai' ? 'ai' : p?.source === 'disk' ? 'disk' : source,
      });
      await this.refreshPending(uri, after);
    });
  }

  // ---------------------------------------------------------------- user events

  private async onUserSave(doc: vscode.TextDocument): Promise<void> {
    const key = doc.uri.toString();
    this.savingKeys.delete(key);
    if (doc.uri.scheme !== 'file' || !this.isTrackable(doc.uri)) {
      return;
    }
    const text = doc.getText();
    const hash = hashText(text);
    this.savedHashes.set(key, { hash, time: Date.now() });

    await this.ready;
    await this.serialize(key, async () => {
      const p = this.pending.get(key);
      if (this.baseline.get(key) === hash) {
        this.clearPending(key);
        return;
      }
      const disk = await this.readDisk(doc.uri);
      if (disk.state !== 'file') {
        return;
      }
      if (!p || p.kind === 'deleted') {
        // The user saved a file that is not pending (or recreated a deleted one) → it becomes the baseline.
        await this.objects.put(disk.hash, disk.bytes);
        this.baseline.set(key, disk.hash);
        this.clearPending(key);
        this.persist();
        return;
      }
      // The user saved a pending file: their edits outside AI regions go into the baseline, then A := saved content.
      const forwarded = await this.effectiveBaseline(doc.uri, text);
      if (forwarded !== undefined && forwarded !== (await this.baselineText(doc.uri))) {
        await this.storeBaseline(key, forwarded);
      }
      await this.objects.put(disk.hash, disk.bytes);
      this.pending.set(key, { ...p, aiHash: disk.hash });
      await this.refreshPending(doc.uri);
    });
  }

  /** Edit in a pending document: refresh the stats, and drop the file from the list once it matches the baseline. */
  private onDocChange(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    if (!this.pending.has(key)) {
      return;
    }
    clearTimeout(this.docTimers.get(key));
    this.docTimers.set(
      key,
      setTimeout(() => {
        this.docTimers.delete(key);
        void this.serialize(key, () => this.refreshPending(doc.uri));
      }, DOC_REFRESH_MS),
    );
  }

  private async onUserRename(files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): Promise<void> {
    await this.ready;
    for (const { oldUri, newUri } of files) {
      const oldPrefix = oldUri.toString();
      const newPrefix = newUri.toString();
      for (const key of this.keysUnder(oldUri)) {
        const newKey = newPrefix + key.slice(oldPrefix.length);
        this.baseline.set(newKey, this.baseline.get(key)!);
        this.baseline.delete(key);
        const p = this.pending.get(key);
        if (p) {
          this.pending.delete(key);
          this.pending.set(newKey, { ...p, uri: vscode.Uri.parse(newKey) });
        }
      }
    }
    this.persist();
    this.notify();
  }

  // ---------------------------------------------------------------- disk events

  private onFsEvent(uri: vscode.Uri, kind: 'create' | 'change' | 'delete'): void {
    const now = Date.now();
    const rel = this.relPath(uri);
    if (rel === undefined) {
      return;
    }
    const gitPath = gitInternalPath(rel);
    if (gitPath !== undefined) {
      this.git.onGitPathEvent(gitPath, kind, now);
      return;
    }
    if (isExcludedPath(rel, this.excludeFolders())) {
      return;
    }
    const gitCaused = this.git.isGitTime(now);

    if (kind === 'delete') {
      // A deleted folder only produces one event, for the folder itself.
      for (const key of this.keysUnder(uri)) {
        this.schedule(vscode.Uri.parse(key), gitCaused);
      }
      return;
    }
    if (kind === 'create') {
      void this.scheduleIfDirectory(uri, gitCaused);
    }
    this.schedule(uri, gitCaused);
  }

  private async scheduleIfDirectory(uri: vscode.Uri, gitCaused: boolean): Promise<void> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type & vscode.FileType.Directory) {
        const files = await vscode.workspace.findFiles(new vscode.RelativePattern(uri, '**/*'), this.excludeGlob());
        files.forEach((f) => this.schedule(f, gitCaused));
      }
    } catch {
      // already gone again
    }
  }

  private schedule(uri: vscode.Uri, gitCaused: boolean): void {
    const key = uri.toString();
    const prev = this.queue.get(key);
    if (prev) {
      clearTimeout(prev.timer);
    }
    const entry = {
      uri,
      gitCaused: gitCaused || (prev?.gitCaused ?? false),
      timer: setTimeout(() => {
        this.queue.delete(key);
        void this.ready.then(() => this.serialize(key, () => this.evaluate(uri, entry.gitCaused)));
      }, DEBOUNCE_MS),
    };
    this.queue.set(key, entry);
  }

  /** The core decision: compare the disk content with the baseline. */
  private async evaluate(uri: vscode.Uri, gitCaused: boolean): Promise<void> {
    const key = uri.toString();
    const disk = await this.readDisk(uri);
    const base = this.baseline.get(key);

    if (disk.state === 'skip') {
      if (base !== undefined) {
        this.baseline.delete(key);
        this.clearPending(key);
        this.persist();
      }
      return;
    }

    if (disk.state === 'missing') {
      if (base === undefined) {
        return;
      }
      if (gitCaused || base === null) {
        this.baseline.delete(key);
        this.clearPending(key);
        this.persist();
        return;
      }
      const baseText = (await this.baselineText(uri)) ?? '';
      this.setPending(key, {
        uri,
        kind: 'deleted',
        stats: statsOf(computeHunks(baseText, '')),
        detectedAt: this.pending.get(key)?.detectedAt ?? Date.now(),
        source: 'disk',
      });
      return;
    }

    if (gitCaused) {
      await this.objects.put(disk.hash, disk.bytes);
      this.baseline.set(key, disk.hash);
      this.clearPending(key);
      this.persist();
      return;
    }

    // Watcher event from the user's own save — handled by onUserSave.
    const saved = this.savedHashes.get(key);
    if (saved && saved.hash === disk.hash && Date.now() - saved.time < OWN_SAVE_WINDOW_MS) {
      if (!this.pending.has(key) && base !== disk.hash) {
        await this.objects.put(disk.hash, disk.bytes);
        this.baseline.set(key, disk.hash);
        this.persist();
      }
      return;
    }
    const saving = this.savingKeys.get(key);
    if (saving !== undefined && Date.now() - saving < OWN_SAVE_WINDOW_MS) {
      return;
    }

    if (base === disk.hash) {
      this.clearPending(key);
      return;
    }

    let kind: PendingKind = 'modified';
    if (base === undefined || base === null) {
      // A file that was never in the baseline → created by a non-user.
      this.baseline.set(key, null);
      this.persist();
      kind = 'added';
    }
    await this.objects.put(disk.hash, disk.bytes);
    const prev = this.pending.get(key);
    this.setPending(key, {
      uri,
      kind: prev?.kind === 'added' ? 'added' : kind,
      stats: prev?.stats ?? { added: 0, removed: 0 },
      aiHash: disk.hash,
      detectedAt: prev?.detectedAt ?? Date.now(),
      source: 'disk',
    });
    // Use the disk content, not the document: the editor may not have reloaded the file yet.
    await this.refreshPending(uri, disk.text);
  }

  // ---------------------------------------------------------------- snapshot & scan

  private async initialSnapshot(): Promise<void> {
    const maxBytes = this.config().get<number>('maxSnapshotMB', 200) * 1024 * 1024;
    let total = 0;
    let truncated = false;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Laster: initial workspace snapshot' },
      async () => {
        for (const uri of await this.findWorkspaceFiles()) {
          const disk = await this.readDisk(uri);
          if (disk.state !== 'file') {
            continue;
          }
          total += disk.bytes.length;
          if (total > maxBytes) {
            truncated = true;
            break;
          }
          await this.objects.put(disk.hash, disk.bytes);
          this.baseline.set(uri.toString(), disk.hash);
        }
      },
    );
    if (truncated) {
      void vscode.window.showWarningMessage(
        `Laster: the workspace is larger than the snapshot limit (${this.config().get('maxSnapshotMB')}MB). ` +
          'Some files are not tracked. Add folders to "laster.excludeFolders" or raise "laster.maxSnapshotMB".',
      );
    }
  }

  /** When VSCode is reopened: changes made while it was closed are detected too. */
  private async startupScan(): Promise<void> {
    const seen = new Set<string>();
    for (const uri of await this.findWorkspaceFiles()) {
      seen.add(uri.toString());
      await this.evaluate(uri, false);
    }
    for (const key of [...this.baseline.keys()]) {
      if (!seen.has(key)) {
        await this.evaluate(vscode.Uri.parse(key), false);
      }
    }
  }

  // ---------------------------------------------------------------- helpers

  private async applySelfEdit(uri: vscode.Uri, edit: vscode.WorkspaceEdit): Promise<void> {
    const key = uri.toString();
    this.selfEdits.add(key);
    try {
      await vscode.workspace.applyEdit(edit);
    } finally {
      this.selfEdits.delete(key);
    }
  }

  /**
   * Recompute a pending file's stats against the effective baseline. If nothing differs anymore
   * (e.g. the user tidied it up themselves, or every hunk was approved), the baseline is updated and the
   * file leaves the list. Must be called inside `serialize`.
   */
  private async refreshPending(uri: vscode.Uri, currentOverride?: string): Promise<void> {
    const key = uri.toString();
    const p = this.pending.get(key);
    if (!p || p.kind === 'deleted') {
      return;
    }
    const current = currentOverride ?? (await this.currentText(uri));
    if (current === undefined) {
      return;
    }
    const base = await this.effectiveBaseline(uri, current);
    if (base === undefined) {
      return;
    }
    if (base === current) {
      await this.storeBaseline(key, current);
      this.clearPending(key);
      return;
    }
    this.setPending(key, { ...p, stats: statsOf(computeHunks(base, current)) });
  }

  /** Current content: the open document (including unsaved edits), or the disk content. */
  private async currentText(uri: vscode.Uri): Promise<string | undefined> {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (doc) {
      return doc.getText();
    }
    const disk = await this.readDisk(uri);
    return disk.state === 'file' ? disk.text : undefined;
  }

  private async storeBaseline(key: string, text: string): Promise<void> {
    const hash = hashText(text);
    await this.objects.put(hash, Buffer.from(text, 'utf8'));
    this.baseline.set(key, hash);
    this.persist();
    this.notify();
  }

  private async textOf(hash: string): Promise<string> {
    let text = this.textCache.get(hash);
    if (text === undefined) {
      text = decodeText(await this.objects.get(hash));
      if (this.textCache.size > 50) {
        this.textCache.clear();
      }
      this.textCache.set(hash, text);
    }
    return text;
  }

  private setPending(key: string, info: PendingInfo): void {
    this.pending.set(key, info);
    this.notify();
  }

  private clearPending(key: string): void {
    if (this.pending.delete(key)) {
      this.hunkCache.delete(key);
      this.notify();
    }
  }

  private notify(): void {
    this.generation++;
    this.changeEmitter.fire();
  }

  private serialize(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn).catch((err) => console.error('[laster]', key, err));
    this.chains.set(key, next);
    void next.then(() => {
      if (this.chains.get(key) === next) {
        this.chains.delete(key);
      }
    });
    return next;
  }

  private persist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void saveBaseline(this.baselineFile, this.baseline).catch((err) => console.error('[laster] persist', err));
    }, 500);
  }

  private async readDisk(uri: vscode.Uri): Promise<DiskState> {
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch {
      return { state: 'missing' };
    }
    if (!(stat.type & vscode.FileType.File)) {
      return { state: 'skip' };
    }
    if (stat.size > this.config().get<number>('maxFileSizeKB', 1024) * 1024) {
      return { state: 'skip' };
    }
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      return { state: 'missing' };
    }
    if (isBinary(bytes)) {
      return { state: 'skip' };
    }
    const text = decodeText(bytes);
    return { state: 'file', bytes, text, hash: hashText(text) };
  }

  private keysUnder(uri: vscode.Uri): string[] {
    const exact = uri.toString();
    const prefix = exact.endsWith('/') ? exact : exact + '/';
    return [...this.baseline.keys()].filter((k) => k === exact || k.startsWith(prefix));
  }

  private relPath(uri: vscode.Uri): string | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      return undefined;
    }
    return path.posix.relative(folder.uri.path, uri.path);
  }

  private isTrackable(uri: vscode.Uri): boolean {
    const rel = this.relPath(uri);
    return rel !== undefined && gitInternalPath(rel) === undefined && !isExcludedPath(rel, this.excludeFolders());
  }

  private async findWorkspaceFiles(): Promise<vscode.Uri[]> {
    const all: vscode.Uri[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      all.push(...(await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'), this.excludeGlob())));
    }
    return all;
  }

  private excludeFolders(): string[] {
    return this.config().get<string[]>('excludeFolders', []);
  }

  private excludeGlob(): string | null {
    const folders = this.excludeFolders();
    return folders.length ? `**/{${folders.join(',')}}/**` : null;
  }

  private config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('laster');
  }
}
