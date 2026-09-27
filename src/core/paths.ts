/** `relPath` uses `/`. A file is excluded if any of its folder segments is in the list. */
export function isExcludedPath(relPath: string, excludeFolders: readonly string[]): boolean {
  const segments = relPath.split('/');
  segments.pop();
  return segments.some((s) => excludeFolders.includes(s));
}

/** Returns the path inside `.git/` (e.g. `HEAD`, `refs/stash`), or undefined. */
export function gitInternalPath(relPath: string): string | undefined {
  const idx = relPath.indexOf('.git/');
  if (idx !== 0 && !(idx > 0 && relPath[idx - 1] === '/')) {
    return undefined;
  }
  return relPath.slice(idx + '.git/'.length);
}
