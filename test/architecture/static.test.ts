import { describe, expect, it } from 'vitest';
import { exec } from '../support/exec.js';

describe('static checks', () => {
  it('tsc -b passes', () => {
    const result = exec('pnpm', ['exec', 'tsc', '-b']);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it('eslint passes with zero warnings', () => {
    const result = exec('pnpm', ['exec', 'eslint', '.', '--max-warnings', '0']);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});
