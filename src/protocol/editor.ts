import { z } from 'zod';
import { ProtocolError } from './errors.js';

/** Default editor command. */
export const DEFAULT_EDITOR = 'kate';
/** Stands for the worktree path in an editor command. */
export const PATH_PLACEHOLDER = '{path}';

const WHITESPACE = /\s/;

/** Reads a double-quoted part starting after its opening quote; returns its text and the index after the closing quote. */
const doubleQuoted = (command: string, start: number): { text: string; end: number } | null => {
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

/** Splits an editor command into words as a POSIX shell would, without expansions; null when it is invalid. */
export const editorWords = (command: string): string[] | null => {
  const words: string[] = [];
  let word: string | null = null;
  let i = 0;
  while (i < command.length) {
    const c = command.charAt(i);
    if (WHITESPACE.test(c)) {
      if (word !== null) words.push(word);
      word = null;
      i++;
    } else if (c === "'") {
      const close = command.indexOf("'", i + 1);
      if (close < 0) return null;
      word = (word ?? '') + command.slice(i + 1, close);
      i = close + 1;
    } else if (c === '"') {
      const part = doubleQuoted(command, i + 1);
      if (part === null) return null;
      word = (word ?? '') + part.text;
      i = part.end;
    } else if (c === '\\') {
      if (i + 1 >= command.length) return null;
      word = (word ?? '') + command.charAt(i + 1);
      i += 2;
    } else {
      word = (word ?? '') + c;
      i++;
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
