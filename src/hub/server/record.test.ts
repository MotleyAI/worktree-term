import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readHubRecord, removeHubRecord, writeHubRecord } from './record.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wtd-record-'));
  path = join(dir, 'hub.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const record = { pid: 123, port: 7417, instance: 'hub_A-1' };

describe('hub record', () => {
  it('round-trips through an owner-only file', async () => {
    await writeHubRecord(path, record);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(record);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await readHubRecord(path)).toEqual(record);
  });

  it('reads a missing record as null', async () => {
    expect(await readHubRecord(path)).toBeNull();
  });

  it.each([
    ['invalid JSON', '{"pid":'],
    ['an array', '[]'],
    ['a missing field', JSON.stringify({ pid: 1, port: 7417 })],
    ['an extra field', JSON.stringify({ ...record, token: 'x' })],
    ['a zero pid', JSON.stringify({ ...record, pid: 0 })],
    ['a fractional port', JSON.stringify({ ...record, port: 1.5 })],
    ['a port over 65535', JSON.stringify({ ...record, port: 65536 })],
    ['an instance with a space', JSON.stringify({ ...record, instance: 'a b' })],
  ])('reads a record with %s as null', async (_name, text) => {
    writeFileSync(path, text);
    expect(await readHubRecord(path)).toBeNull();
  });

  it('removes the record only while it names the instance', async () => {
    await writeHubRecord(path, record);
    await removeHubRecord(path, 'other');
    expect(await readHubRecord(path)).toEqual(record);
    await removeHubRecord(path, record.instance);
    expect(await readHubRecord(path)).toBeNull();
  });
});
