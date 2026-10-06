import { z } from 'zod';

const U32_MAX = 2 ** 32 - 1;

export const req = z.int().min(1).max(U32_MAX);
export const termId = z.int().min(1).max(U32_MAX);
export const offset = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
export const size = z.int().min(1).max(1000);
export const hostIdx = z.int().min(0).max(65535);
export const depth = z.int().min(1).max(6);

// eslint-disable-next-line no-control-regex -- NUL is the character paths must not contain
const ABSOLUTE_WITHOUT_NUL = /^\/[^\u0000]*$/;

export const path = z.string().max(4096).regex(ABSOLUTE_WITHOUT_NUL);
export const head = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
  .nullable();
export const name = z.string().min(1).max(64);
export const longText = z.string().max(4096).nullable();
export const signal = z.string().max(32).nullable();
export const version = z.string().min(1).max(64);
export const instance = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
/** A hub token or one-time code. */
export const secret = z.string().regex(/^[0-9a-f]{64}$/);
export const errorMessage = z.string().max(1024);
export const errorCode = z.enum([
  'bad-message',
  'unknown-host',
  'unknown-term',
  'unknown-worktree',
  'not-watched',
  'busy',
  'spawn-failed',
  'version-mismatch',
  'not-a-repo',
  'host-unavailable',
  'internal',
]);

export const MAX_ENTRIES = 1024;
export const MAX_ROOTS = 32;
export const MAX_DISCOVERED = 4096;
export const MAX_VISIBLE = 4096;
export const MAX_HOSTS = 64;
export const MAX_HOST_REPOS = 256;
export const MAX_PRESETS = 64;
