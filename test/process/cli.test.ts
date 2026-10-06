import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exec, REPO_ROOT, type ExecResult } from '../support/exec.js';

const BUNDLE = join(REPO_ROOT, 'dist', 'wtd.mjs');

const wtd = (...args: string[]): ExecResult => exec(process.execPath, [BUNDLE, ...args]);

const packageVersion = (): string => {
  const pkg: unknown = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  if (typeof pkg !== 'object' || pkg === null || !('version' in pkg) || typeof pkg.version !== 'string') {
    throw new Error('package.json has no version');
  }
  return pkg.version;
};

const usage = (): string => wtd('--help').stdout;

const expectUsageError = (result: ExecResult, mentions: RegExp): void => {
  expect(result.status).toBe(2);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain(usage());
  const error = result.stderr.replace(usage(), '').trim();
  expect(error).not.toContain('\n');
  expect(error).toMatch(mentions);
};

describe('dist/wtd.mjs', () => {
  it('is built together with the web bundle', () => {
    expect(existsSync(join(REPO_ROOT, 'dist', 'web', 'index.html'))).toBe(true);
  });

  it('starts with a node shebang', () => {
    expect(readFileSync(BUNDLE, 'utf8').split('\n', 1)[0]).toBe('#!/usr/bin/env node');
  });

  it('prints its version', () => {
    expect(wtd('--version')).toEqual({ status: 0, stdout: `wtd ${packageVersion()} (protocol 3)\n`, stderr: '' });
  });

  it('prints help listing every command and option', () => {
    const result = wtd('--help');
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    for (const word of ['ui', 'hub', 'daemon', 'connect', 'install-local', 'install-remote <alias>', '--help', '--version']) {
      expect(result.stdout).toContain(word);
    }
  });

  it('rejects no arguments', () => {
    expectUsageError(wtd(), /\S/);
  });

  it('names an unknown command', () => {
    expectUsageError(wtd('frobnicate'), /frobnicate/);
  });

  it('names an unknown option', () => {
    expectUsageError(wtd('--frob'), /--frob/);
  });

  it('requires an alias for install-remote', () => {
    expectUsageError(wtd('install-remote'), /alias.*required|required.*alias/i);
  });

  it.each([
    ['install-local', ['install-local']],
    ['install-remote', ['install-remote', 'devbox']],
  ])('%s exits 2 as not implemented', (verb, args) => {
    expect(wtd(...args)).toEqual({ status: 2, stdout: '', stderr: `wtd ${verb}: not implemented\n` });
  });
});
