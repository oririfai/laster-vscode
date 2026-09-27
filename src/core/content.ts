import { createHash } from 'node:crypto';

const BOM = '\uFEFF';

/** Text used for hashing/diffing: the BOM is dropped so disk content and `document.getText()` match. */
export function normalizeText(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

export function hashText(text: string): string {
  return createHash('sha1').update(normalizeText(text), 'utf8').digest('hex');
}

/** Git's heuristic: a NUL byte in the first 8000 bytes means binary. */
export function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) {
    if (bytes[i] === 0) {
      return true;
    }
  }
  return false;
}

export function decodeText(bytes: Uint8Array): string {
  return normalizeText(Buffer.from(bytes).toString('utf8'));
}
