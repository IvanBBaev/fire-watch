import { describe, expect, it } from 'vitest';

import { PROBLEM_CODES, PROBLEM_CODE_MEMBER, isProblemCode } from './problem-codes.js';

describe('problem codes', () => {
  it('are unique, stable-looking snake_case identifiers', () => {
    expect(new Set(PROBLEM_CODES).size).toBe(PROBLEM_CODES.length);
    for (const code of PROBLEM_CODES) expect(code).toMatch(/^[a-z]+(?:_[a-z]+)*$/);
  });

  it('recognise exactly the listed codes', () => {
    for (const code of PROBLEM_CODES) expect(isProblemCode(code)).toBe(true);
    expect(isProblemCode('Link expired')).toBe(false);
    expect(isProblemCode('')).toBe(false);
    expect(isProblemCode(undefined)).toBe(false);
    expect(isProblemCode(400)).toBe(false);
  });

  it('name the RFC 9457 extension member', () => {
    expect(PROBLEM_CODE_MEMBER).toBe('code');
  });
});
