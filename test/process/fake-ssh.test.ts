import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { waitUntil } from '../support/daemon-host.js';
import { FakeSsh } from '../support/fake-ssh.js';

it('cleanup removes its directory while runs it cannot see keep recording their calls for a while', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wtd-fake-ssh-')));
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'wtd-fake-ssh-copy-')));
  const ssh = new FakeSsh(dir);
  // Like a hub killed mid-reconnect whose last runs start late: four loops of a copy of the program, whose runs
  // outlive the program's removal, keep recording calls for a second.
  const program = join(elsewhere, 'ssh');
  copyFileSync(ssh.program, program);
  const loop = 'end=$(($(date +%s%3N)+1000)); while [ "$(date +%s%3N)" -lt "$end" ]; do "$0" -- nowhere true 2>/dev/null; done';
  const stopped = Array.from({ length: 4 }, () => {
    const runs = spawn('/bin/sh', ['-c', loop, program], { stdio: 'ignore' });
    return new Promise((resolve) => runs.once('exit', resolve));
  });
  try {
    await waitUntil(() => ssh.calls().length > 0, 'a first run');
    await ssh.cleanup();
    expect(existsSync(dir)).toBe(false);
  } finally {
    await Promise.all(stopped);
    rmSync(elsewhere, { recursive: true, force: true });
  }
});
