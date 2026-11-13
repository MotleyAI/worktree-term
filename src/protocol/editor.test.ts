import { describe, expect, it } from 'vitest';
import { editorArgs, editorCommandSchema, editorWords, ProtocolError } from './index.js';

describe('editor command words', () => {
  it.each([
    ['kate', ['kate']],
    ['  code   --new-window\t{path} ', ['code', '--new-window', '{path}']],
    ['a\nb', ['a', 'b']],
    [`my-ed --title 'a b' "c \\"d\\"" e\\ f`, ['my-ed', '--title', 'a b', 'c "d"', 'e f']],
    [`'a\\b "c"'`, ['a\\b "c"']],
    ['"a\\b \\\\ $HOME"', ['a\\b \\ $HOME']],
    [`pre'mid dle'"post"x`, ['premid dlepostx']],
    [`a '' b ""`, ['a', '', 'b', '']],
    ["\\'quoted\\'", ["'quoted'"]],
    ['~/bin/ed $HOME', ['~/bin/ed', '$HOME']],
  ])('splits %j into %j', (command, words) => {
    expect(editorWords(command)).toEqual(words);
  });

  it.each([`code "{path}`, `code 'x`, 'code \\', '   ', '', `"a\\"`])('finds %j invalid', (command) => {
    expect(editorWords(command)).toBeNull();
  });
});

describe('editor command arguments', () => {
  it('yields quoted words followed by the path', () => {
    expect(editorArgs(`my-ed --title 'a b' "c \\"d\\"" e\\ f`, '/w')).toEqual(['my-ed', '--title', 'a b', 'c "d"', 'e f', '/w']);
  });

  it('replaces every placeholder, inside words too, and does not append the path', () => {
    expect(editorArgs('code --folder-uri=file://{path} {path}', '/w x')).toEqual(['code', '--folder-uri=file:///w x', '/w x']);
  });

  it('never expands, splits or substitutes into the path', () => {
    expect(editorArgs('kate', '/w/$HOME/~/{path}')).toEqual(['kate', '/w/$HOME/~/{path}']);
    expect(editorArgs('ed {path}', '/a b/"c"/{path}')).toEqual(['ed', '/a b/"c"/{path}']);
  });

  it('replaces a quoted placeholder', () => {
    expect(editorArgs(`ed '{path}'`, '/w')).toEqual(['ed', '/w']);
  });

  it('refuses an invalid command', () => {
    expect(() => editorArgs('code "{path}', '/w')).toThrow(ProtocolError);
  });
});

describe('editor command schema', () => {
  it.each([
    ['kate', 'kate'],
    ['a command with a placeholder', 'code --new-window {path}'],
    ['4096 characters', 'e'.repeat(4096)],
  ])('accepts %s', (_name, command) => {
    expect(editorCommandSchema.safeParse(command).success).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['an unclosed quote', 'code "{path}'],
    ['a trailing backslash', 'code \\'],
    ['4097 characters', 'e'.repeat(4097)],
  ])('rejects %s', (_name, command) => {
    expect(editorCommandSchema.safeParse(command).success).toBe(false);
  });

  it('does not trim or rewrite the command', () => {
    expect(editorCommandSchema.parse(' kate ')).toBe(' kate ');
  });
});
