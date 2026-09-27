import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gitInternalPath, isExcludedPath } from '../core/paths';

test('isExcludedPath matches folder segments', () => {
  const ex = ['node_modules', 'dist'];
  assert.equal(isExcludedPath('node_modules/a/b.js', ex), true);
  assert.equal(isExcludedPath('packages/x/dist/y.js', ex), true);
  assert.equal(isExcludedPath('src/dist.ts', ex), false, 'file names are not matched');
  assert.equal(isExcludedPath('src/app.ts', ex), false);
});

test('gitInternalPath', () => {
  assert.equal(gitInternalPath('.git/HEAD'), 'HEAD');
  assert.equal(gitInternalPath('.git/refs/stash'), 'refs/stash');
  assert.equal(gitInternalPath('sub/.git/index.lock'), 'index.lock');
  assert.equal(gitInternalPath('src/app.ts'), undefined);
  assert.equal(gitInternalPath('foo.git/HEAD'), undefined);
});
