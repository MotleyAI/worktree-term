import { z } from 'zod';
import { ProtocolError } from './errors.js';

/** Default editor command. */
export const DEFAULT_EDITOR = 'kate';
/** Stands for the worktree path in an editor command. */
export const PATH_PLACEHOLDER = '{path}';

const WHITESPACE = /\s/;

interface Part {
  text: string;
  end: number;
}

/** Reads a double-quoted part starting after its opening quote; returns its text and the index after the closing quote. */
const doubleQuoted = (command: string, start: number): Part | null => {
  let text = '';
  let i = start;
  while (i < command.length) {
    const c = command.charAt(i);
    if (c === '"') return { text, end: i + 1 };
    const next = command.charAt(i + 1);
    const escaped = c === '\\' && (next === '"' || next === '\\');
    text += escaped ? next : c;
    i += escaped ? 2 : 1;
  }
  return null;
};

/** Reads the non-blank word part at `i`: a quoted span, an escaped character or a plain one; null when unterminated. */
const wordPart = (command: string, i: number): Part | null => {
  const c = command.charAt(i);
  if (c === "'") {
    const close = command.indexOf("'", i + 1);
    return close < 0 ? null : { text: command.slice(i + 1, close), end: close + 1 };
  }
  if (c === '"') return doubleQuoted(command, i + 1);
  if (c === '\\') return i + 1 < command.length ? { text: command.charAt(i + 1), end: i + 2 } : null;
  return { text: c, end: i + 1 };
};

/** Splits an editor command into words as a POSIX shell would, without expansions; null when it is invalid. */
export const editorWords = (command: string): string[] | null => {
  const words: string[] = [];
  let word: string | null = null;
  let i = 0;
  while (i < command.length) {
    if (WHITESPACE.test(command.charAt(i))) {
      if (word !== null) words.push(word);
      word = null;
      i++;
    } else {
      const part = wordPart(command, i);
      if (part === null) return null;
      word = (word ?? '') + part.text;
      i = part.end;
    }
  }
  if (word !== null) words.push(word);
  return words.length > 0 ? words : null;
};

/** The arguments an editor command yields for `path`, the first naming the program; throws on an invalid command. */
export const editorArgs = (command: string, path: string): string[] => {
  const words = editorWords(command);
  if (words === null) throw new ProtocolError(`invalid editor command: ${command}`);
  if (!words.some((word) => word.includes(PATH_PLACEHOLDER))) return [...words, path];
  return words.map((word) => word.split(PATH_PLACEHOLDER).join(path));
};

/** An editor command: 1–4096 characters splitting into at least one word. */
export const editorCommand = z
  .string()
  .min(1)
  .max(4096)
  .refine((command) => editorWords(command) !== null, 'must be a valid editor command');
