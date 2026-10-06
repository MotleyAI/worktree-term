import { randomBytes } from 'node:crypto';
import { readPrivateFile, writeFileAtomic } from '../../platform/files/index.js';

const TOKEN = /^[0-9a-f]{64}$/;

/** Whether `text` is a well-formed token or one-time code. */
export const isSecret = (text: string): boolean => TOKEN.test(text);

/** The valid token stored at `path`, or null when it is missing or malformed. */
export const readToken = async (path: string): Promise<string | null> => {
  const text = await readPrivateFile(path);
  return text !== null && isSecret(text) ? text : null;
};

/** The hub token at `path`, created or replaced atomically when missing or malformed. */
export const loadToken = async (path: string): Promise<string> => {
  const existing = await readToken(path);
  if (existing !== null) return existing;
  const token = randomBytes(32).toString('hex');
  await writeFileAtomic(path, token);
  return token;
};
