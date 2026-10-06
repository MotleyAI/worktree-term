import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InputWriter } from './input.js';

let dir: string;
let file: string;
let fd: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wtd-input-'));
  file = join(dir, 'in');
  fd = openSync(file, 'w');
});

afterEach(() => {
  closeSync(fd);
  rmSync(dir, { recursive: true, force: true });
});

describe('InputWriter.stopThen', () => {
  it('calls back at once when no write is in flight', () => {
    const writer = new InputWriter(fd);
    let called = false;
    writer.stopThen(() => {
      called = true;
    });
    expect(called).toBe(true);
  });

  it('waits for the write in flight, then writes nothing more', async () => {
    const writer = new InputWriter(fd);
    writer.push(Buffer.from('first'));
    const done = new Promise<boolean>((resolve) => {
      let sync = true;
      writer.stopThen(() => {
        resolve(sync);
      });
      sync = false;
    });
    writer.push(Buffer.from('second'));
    expect(await done).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('first');
  });
});
