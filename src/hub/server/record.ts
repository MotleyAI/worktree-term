import { readFileIfExists, removeFile, writeFileAtomic } from '../../platform/files/index.js';

/** The hub record `run/hub.json`. */
export interface HubRecord {
  pid: number;
  port: number;
  instance: string;
}

const INSTANCE = /^[A-Za-z0-9_-]{1,64}$/;

const isPositiveInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0;

/** The record's fields if `value` is exactly a hub record. */
const parseRecord = (value: unknown): HubRecord | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (Object.keys(value).length !== 3 || !('pid' in value) || !('port' in value) || !('instance' in value)) return null;
  const { pid, port, instance } = value;
  if (!isPositiveInt(pid) || !isPositiveInt(port) || port > 65535 || typeof instance !== 'string' || !INSTANCE.test(instance)) {
    return null;
  }
  return { pid, port, instance };
};

/** The hub record at `path`, or null when it is missing or malformed. */
export const readHubRecord = async (path: string): Promise<HubRecord | null> => {
  const text = await readFileIfExists(path);
  if (text === null) return null;
  try {
    return parseRecord(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
};

export const writeHubRecord = (path: string, record: HubRecord): Promise<void> => writeFileAtomic(path, JSON.stringify(record));

/** Removes the record at `path` if it still names `instance`. */
export const removeHubRecord = async (path: string, instance: string): Promise<void> => {
  if ((await readHubRecord(path))?.instance === instance) await removeFile(path);
};
