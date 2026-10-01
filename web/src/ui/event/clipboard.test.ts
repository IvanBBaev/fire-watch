import { describe, expect, it } from 'vitest';

import { copyText } from './clipboard.js';

describe('copyText', () => {
  it('reports success when the clipboard accepts the text', async () => {
    const written: string[] = [];
    const ok = await copyText('fw-2026-k9s2r', {
      writeText: (text) => {
        written.push(text);
        return Promise.resolve();
      },
    });
    expect(ok).toBe(true);
    expect(written).toEqual(['fw-2026-k9s2r']);
  });

  it('reports failure instead of throwing when the clipboard refuses or is missing', async () => {
    expect(await copyText('x', { writeText: () => Promise.reject(new Error('denied')) })).toBe(
      false,
    );
    expect(await copyText('x', undefined)).toBe(false);
  });
});
