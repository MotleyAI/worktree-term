import { describe, expect, it } from 'vitest';
import { exec } from '../support/exec.js';

describe('architecture checks', () => {
  it('la-arch-check passes', () => {
    const result = exec('pnpm', ['exec', 'la-arch-check']);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it('likec4 validate passes', () => {
    const result = exec('pnpm', ['exec', 'likec4', 'validate', 'architecture']);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});
