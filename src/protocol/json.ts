import { ProtocolError } from './errors.js';

// No valid message nests deeper; checked before parsing so hostile nesting cannot exhaust the stack.
const MAX_NESTING = 32;

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const nestingOf = (text: string): number => {
  let level = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') max = Math.max(max, ++level);
    else if (c === '}' || c === ']') level--;
  }
  return max;
};

/** Parses JSON text, refusing hostile nesting. */
export const parseJson = (text: string): unknown => {
  if (nestingOf(text) > MAX_NESTING) throw new ProtocolError('message nests too deep');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ProtocolError('invalid JSON', { cause: error });
  }
};

/** The text of `data`, decoded as strict UTF-8 when given bytes. */
export const toText = (data: string | Uint8Array): string => {
  if (typeof data === 'string') return data;
  try {
    return utf8.decode(data);
  } catch (error) {
    throw new ProtocolError('invalid UTF-8', { cause: error });
  }
};
