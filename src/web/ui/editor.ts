import type { HostEntry } from '../../protocol/index.js';
import { editorWords } from '../client/index.js';
import { statusText } from './hosts.js';

export const EDITOR_TITLE = 'Open in editor (right-click to change the command)';
export const EDITOR_HINT = '{path} stands for the worktree path; without it, the path is added at the end.';
const MAX_COMMAND = 4096;
const HOME_ONLY = "Open the editor from this machine's page";
/** Programs the hub runs to open a remote worktree. */
const MOUNT_PROGRAMS: readonly string[] = ['sshfs', 'fusermount3'];

/** What decides whether the "Open in editor" control is usable. */
export interface EditorState {
  remotePage: boolean;
  /** The selected worktree, null without one. */
  worktree: { prunable: boolean; gone: boolean } | null;
  remoteHost: boolean;
  /** The status of the selected worktree's host. */
  hostStatus: HostEntry['status'];
  /** The editor command the hub sent; null before it did. */
  command: string | null;
  /** A request the control sent is unanswered. */
  pending: boolean;
}

/** Why the control is disabled; null while it is usable. */
export const editorBlocker = (state: EditorState): string | null => {
  if (state.remotePage) return HOME_ONLY;
  if (state.worktree === null) return 'No worktree is selected';
  if (state.hostStatus !== 'connected') return `Its ${state.remoteHost ? 'host' : 'daemon'} is ${statusText(state.hostStatus)}`;
  if (state.worktree.prunable) return 'The worktree is prunable';
  if (state.worktree.gone) return 'The worktree is gone';
  if (state.command === null) return 'Waiting for the editor command from the hub';
  return state.pending ? 'Opening the editor…' : null;
};

/** What the failure dialog says: the missing mount program or the first word of `command`, or the error's message. */
export type EditorFailure = { t: 'missing'; program: string } | { t: 'failed'; message: string };

export const editorFailure = (code: string | null, message: string, command: string | null): EditorFailure => {
  if (code !== 'editor-missing') return { t: 'failed', message };
  if (MOUNT_PROGRAMS.includes(message)) return { t: 'missing', program: message };
  return { t: 'missing', program: (command === null ? null : editorWords(command)?.[0]) ?? message };
};

/** What saving the form's `text` does: refuse it, close without sending, or send the trimmed command. */
export type EditorSave = { t: 'refused'; error: string } | { t: 'unchanged' } | { t: 'send'; command: string };

export const editorSave = (text: string, shown: string): EditorSave => {
  const command = text.trim();
  if (command === '') return { t: 'refused', error: 'The command is empty' };
  if (command.length > MAX_COMMAND) return { t: 'refused', error: `The command is longer than ${String(MAX_COMMAND)} characters` };
  if (editorWords(command) === null) return { t: 'refused', error: 'The command has an unclosed quote or ends in a backslash' };
  return command === shown ? { t: 'unchanged' } : { t: 'send', command };
};
