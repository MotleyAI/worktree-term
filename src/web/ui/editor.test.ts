import { describe, expect, it } from 'vitest';
import { editorBlocker, editorFailure, editorSave, type EditorState } from './editor.js';

const usable: EditorState = {
  remotePage: false,
  worktree: { prunable: false, gone: false },
  remoteHost: false,
  hostStatus: 'connected',
  command: 'kate',
  pending: false,
};

describe('editorBlocker', () => {
  it('lets a local worktree open once the command arrived', () => {
    expect(editorBlocker(usable)).toBeNull();
  });

  it.each<[string, Partial<EditorState>, RegExp]>([
    ['on a remote page', { remotePage: true }, /open the editor from this machine['’]s page/i],
    ['without a worktree', { worktree: null }, /no worktree is selected/i],
    ['for a prunable worktree', { worktree: { prunable: true, gone: false } }, /prunable/],
    ['for a gone worktree', { worktree: { prunable: false, gone: true } }, /gone/],
    ['before the command arrived', { command: null }, /editor command/],
    ['while a request is unanswered', { pending: true }, /Opening/],
  ])('blocks %s, saying why', (_name, change, reason) => {
    expect(editorBlocker({ ...usable, ...change })).toMatch(reason);
  });

  it('names the remote page before a missing worktree', () => {
    expect(editorBlocker({ ...usable, remotePage: true, worktree: null })).toMatch(/open the editor from this machine['’]s page/i);
  });
});

describe('editorBlocker for remote worktrees', () => {
  it('lets a connected remote host’s worktree open on a home page', () => {
    expect(editorBlocker({ ...usable, remoteHost: true, hostStatus: 'connected' })).toBeNull();
  });

  it('blocks on a remote page, saying to open the editor from this machine’s page', () => {
    expect(editorBlocker({ ...usable, remotePage: true, hostStatus: 'connected' })).toMatch(/open the editor from this machine['’]s page/i);
    expect(editorBlocker({ ...usable, remotePage: true, remoteHost: true, hostStatus: 'connected', worktree: null })).toMatch(
      /open the editor from this machine['’]s page/i,
    );
  });

  it.each(['connecting', 'reconnecting', 'down', 'outdated'] as const)(
    'blocks while the remote host is %s, giving its status',
    (status) => {
      expect(editorBlocker({ ...usable, remoteHost: true, hostStatus: status })).toEqual(expect.stringContaining(status));
    },
  );

  it('blocks while the remote host needs login, giving that status', () => {
    expect(editorBlocker({ ...usable, remoteHost: true, hostStatus: 'needs-login' })).toMatch(/needs login/);
  });

  it('blocks a local worktree while this machine’s daemon is not connected', () => {
    expect(editorBlocker({ ...usable, hostStatus: 'outdated' })).toEqual(expect.stringContaining('outdated'));
  });

  it('names a missing worktree before the host’s status', () => {
    expect(editorBlocker({ ...usable, remoteHost: true, hostStatus: 'down', worktree: null })).toMatch(/no worktree is selected/i);
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

describe('editorFailure for a remote worktree', () => {
  it.each(['sshfs', 'fusermount3'])('names %s when the message is exactly that mount program', (program) => {
    expect(editorFailure('editor-missing', program, 'kate')).toEqual({ t: 'missing', program });
  });

  it('names the editor command’s first word for any other message', () => {
    expect(editorFailure('editor-missing', 'sshfs: not found', 'kate --new')).toEqual({ t: 'missing', program: 'kate' });
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
