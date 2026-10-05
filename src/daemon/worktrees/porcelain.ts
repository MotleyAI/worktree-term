import type { Worktree } from '../../protocol/index.js';

const HEAD = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const UNBORN = /^0+$/;
const BRANCH_PREFIX = 'refs/heads/';

const parseRecord = (lines: readonly string[], main: boolean): Worktree => {
  const [first, ...rest] = lines;
  if (first?.startsWith('worktree ') !== true) throw new Error('worktree record does not start with its path');
  const path = first.slice('worktree '.length);
  if (!path.startsWith('/')) throw new Error(`worktree path ${JSON.stringify(path)} is not absolute`);
  const worktree: Worktree = { path, head: null, branch: null, detached: false, locked: false, prunable: false, bare: false, main };
  for (const line of rest) {
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    switch (key) {
      case 'HEAD':
        if (!HEAD.test(value)) throw new Error(`invalid HEAD ${JSON.stringify(value)}`);
        worktree.head = UNBORN.test(value) ? null : value;
        break;
      case 'branch':
        worktree.branch = value.startsWith(BRANCH_PREFIX) ? value.slice(BRANCH_PREFIX.length) : value;
        break;
      case 'detached':
        worktree.detached = true;
        break;
      case 'bare':
        worktree.bare = true;
        break;
      case 'locked':
        worktree.locked = true;
        break;
      case 'prunable':
        worktree.prunable = true;
        break;
      default:
        // Attributes of later git versions.
        break;
    }
  }
  return worktree;
};

/** Parses `git worktree list --porcelain -z` output; the first worktree is the main one. */
export const parsePorcelain = (text: string): Worktree[] => {
  if (text === '') return [];
  if (!text.endsWith('\0\0')) throw new Error('worktree list output is not terminated');
  const records: string[][] = [];
  let lines: string[] = [];
  for (const token of text.slice(0, -1).split('\0')) {
    if (token !== '') {
      lines.push(token);
      continue;
    }
    if (lines.length === 0) throw new Error('empty worktree record');
    records.push(lines);
    lines = [];
  }
  return records.map((record, index) => parseRecord(record, index === 0));
};
