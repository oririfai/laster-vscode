/**
 * Decides whether a file change was caused by a git operation (checkout, pull, reset, stash, ...).
 *
 * Git holds `.git/index.lock` while writing the working tree, and updates `HEAD`/`ORIG_HEAD`/
 * `MERGE_HEAD` when moving between commits. File events that arrive while the lock is held, or
 * shortly after a git signal, count as git. Events that arrive *before* the lock is created still
 * count as non-user — e.g. an agent that edits a file and then immediately runs `git add`.
 */
export class GitActivity {
  private readonly activeLocks = new Set<string>();
  private lastSignal = -Infinity;

  constructor(private readonly graceMs = 800) {}

  /** Called for every file event inside the `.git/` folder. */
  onGitPathEvent(gitRelPath: string, kind: 'create' | 'change' | 'delete', now: number): void {
    if (gitRelPath.endsWith('index.lock')) {
      if (kind === 'delete') {
        this.activeLocks.delete(gitRelPath);
      } else {
        this.activeLocks.add(gitRelPath);
      }
      this.lastSignal = now;
      return;
    }
    if (/^(HEAD|ORIG_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REBASE_HEAD|refs\/stash)$/.test(gitRelPath)) {
      this.lastSignal = now;
    }
  }

  isGitTime(eventTime: number): boolean {
    return this.activeLocks.size > 0 || eventTime - this.lastSignal <= this.graceMs;
  }
}
