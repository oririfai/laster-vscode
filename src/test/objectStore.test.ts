import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { loadBaseline, saveBaseline } from '../core/baselineFile';
import { hashText } from '../core/content';
import { ObjectStore } from '../core/objectStore';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'laster-test-'));
}

test('put/get returns exactly the same bytes (BOM & CRLF preserved)', async () => {
  const store = new ObjectStore(path.join(await tmpDir(), 'objects'));
  const bytes = Buffer.from('\uFEFFhello\r\nworld\r\n', 'utf8');
  const hash = hashText(bytes.toString('utf8'));
  await store.put(hash, bytes);
  assert.deepEqual(Buffer.from(await store.get(hash)), bytes);
});

test('hashText ignores the BOM', () => {
  assert.equal(hashText('\uFEFFabc'), hashText('abc'));
});

test('gc deletes unreferenced objects', async () => {
  const store = new ObjectStore(path.join(await tmpDir(), 'objects'));
  const a = hashText('a');
  const b = hashText('b');
  await store.put(a, Buffer.from('a'));
  await store.put(b, Buffer.from('b'));
  assert.equal(await store.gc(new Set([a])), 1);
  assert.equal(await store.has(a), true);
  assert.equal(await store.has(b), false);
});

test('baseline.json round-trip including null (new file)', async () => {
  const file = path.join(await tmpDir(), 'baseline.json');
  assert.equal(await loadBaseline(file), undefined);
  const map = new Map<string, string | null>([
    ['file:///a.ts', 'abc'],
    ['file:///b.ts', null],
  ]);
  await saveBaseline(file, map);
  assert.deepEqual(await loadBaseline(file), map);
});
