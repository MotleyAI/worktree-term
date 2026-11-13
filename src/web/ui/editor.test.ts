import { describe, expect, it } from 'vitest';
import { editorBlocker, editorFailure, editorSave, type EditorState } from './editor.js';

const usable: EditorState = {
  remotePage: false,
  worktree: { prunable: false, gone: false },
  remoteHost: false,
  command: 'kate',
  pending: false,
};

describe('editorBlocker', () => {
  it('lets a local worktree open once the command arrived', () => {
    expect(editorBlocker(usable)).toBeNull();
  });

  it.each<[string, Partial<EditorState>, RegExp]>([
    ['on a remote page', { remotePage: true }, /only worktrees on this machine/i],
    ['without a worktree', { worktree: null }, /no worktree is selected/i],
    ['for a remote host', { remoteHost: true }, /only worktrees on this machine/i],
    ['for a prunable worktree', { worktree: { prunable: true, gone: false } }, /prunable/],
    ['for a gone worktree', { worktree: { prunable: false, gone: true } }, /gone/],
    ['before the command arrived', { command: null }, /editor command/],
    ['while a request is unanswered', { pending: true }, /Opening/],
  ])('blocks %s, saying why', (_name, change, reason) => {
    expect(editorBlocker({ ...usable, ...change })).toMatch(reason);
  });

  it('names the remote page before a missing worktree', () => {
    expect(editorBlocker({ ...usable, remotePage: true, worktree: null })).toMatch(/only worktrees on this machine/i);
  });
});

describe('editorFailure', () => {
  it('names the first word of the shown command as the missing program', () => {
    expect(editorFailure('editor-missing', 'cannot find x', `'my ed' --folder {path}`)).toEqual({ t: 'missing', program: 'my ed' });
  });

  it('falls back to the message without a command', () => {
    expect(editorFailure('editor-missing', 'kate', null)).toEqual({ t: 'missing', program: 'kate' });
  });

  it.each(['editor-failed', 'internal', null])('gives the message for code %s', (code) => {
    expect(editorFailure(code, '<b>no</b>', 'kate')).toEqual({ t: 'failed', message: '<b>no</b>' });
  });
});

describe('editorSave', () => {
  it('sends the trimmed command', () => {
    expect(editorSave('  subl {path}  ', 'kate')).toEqual({ t: 'send', command: 'subl {path}' });
  });

  it('closes without sending the command it opened with', () => {
    expect(editorSave(' code {path} ', 'code {path}')).toEqual({ t: 'unchanged' });
  });

  it.each([
    ['a blank command', '   '],
    ['a command of 4097 characters', 'e'.repeat(4097)],
    ['an unclosed quote', 'code "{path}'],
    ['a trailing backslash', 'code \\'],
  ])('refuses %s', (_name, text) => {
    expect(editorSave(text, 'kate').t).toBe('refused');
  });

  it('accepts a command of 4096 characters', () => {
    expect(editorSave('e'.repeat(4096), 'kate')).toEqual({ t: 'send', command: 'e'.repeat(4096) });
  });
});
