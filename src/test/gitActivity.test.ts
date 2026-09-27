import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitActivity } from '../core/gitActivity';

test('no git signal → not git', () => {
  assert.equal(new GitActivity().isGitTime(1000), false);
});

test('while index.lock exists → git', () => {
  const g = new GitActivity(800);
  g.onGitPathEvent('index.lock', 'create', 1000);
  assert.equal(g.isGitTime(5000), true);
  g.onGitPathEvent('index.lock', 'delete', 6000);
  assert.equal(g.isGitTime(6500), true, 'still within the grace period after the lock is released');
  assert.equal(g.isGitTime(7000), false);
});

test('a HEAD change opens a grace window', () => {
  const g = new GitActivity(800);
  g.onGitPathEvent('HEAD', 'change', 1000);
  assert.equal(g.isGitTime(1500), true);
  assert.equal(g.isGitTime(2000), false);
});

test('an edit before git runs is still not git (agent edits, then git add)', () => {
  // The tracker asks isGitTime when the file event arrives, before git has created the lock.
  const g = new GitActivity(800);
  assert.equal(g.isGitTime(1000), false);
  g.onGitPathEvent('index.lock', 'create', 1100);
  g.onGitPathEvent('index.lock', 'delete', 1150);
  assert.equal(g.isGitTime(1150), true);
});

test('other files in .git (e.g. objects, config) are not signals', () => {
  const g = new GitActivity(800);
  g.onGitPathEvent('config', 'change', 1000);
  g.onGitPathEvent('logs/HEAD', 'change', 1000);
  assert.equal(g.isGitTime(1000), false);
});
