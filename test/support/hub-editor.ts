import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { z } from 'zod';
import { waitUntil } from './daemon-host.js';
import type { HubClient, Reply } from './hub-client.js';

const launchSchema = z.strictObject({
  pid: z.number(),
  args: z.array(z.string()),
  cwd: z.string(),
  sid: z.number(),
  stdin: z.string(),
  stdout: z.string(),
});
export type Launch = z.infer<typeof launchSchema>;

/** Stand-in editor: appends one JSON line describing its launch to `log`, then keeps running. */
const RECORDER = (log: string): string => String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const stat = fs.readFileSync('/proc/self/stat', 'utf8');
const sid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[3]);
const fd = (n) => { try { return fs.readlinkSync('/proc/self/fd/' + n); } catch { return 'closed'; } };
const launch = { pid: process.pid, args: process.argv.slice(2), cwd: fs.readlinkSync('/proc/self/cwd'), sid, stdin: fd(0), stdout: fd(1) };
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(launch) + '\n');
setTimeout(() => process.exit(0), 60000);
`;

const launched: number[] = [];

/** Registers the cleanup killing every recorded editor after each test. */
export const useEditorRecorders = (): void => {
  afterEach(() => {
    for (const pid of launched.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  });
};

/** A recording editor program in `dir/editors`, its launches, and its editor command with a `{path}` placeholder. */
export const recorder = (dir: string, name = 'my editor'): { program: string; command: string; launches: () => Launch[] } => {
  const editors = join(dir, 'editors');
  mkdirSync(editors, { recursive: true });
  const program = join(editors, name);
  const log = join(editors, `${name}.log`);
  writeFileSync(program, RECORDER(log));
  chmodSync(program, 0o755);
  return {
    program,
    command: `'${program}' {path}`,
    launches: () => {
      if (!existsSync(log)) return [];
      const entries = readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => launchSchema.parse(JSON.parse(line)));
      for (const entry of entries) if (!launched.includes(entry.pid)) launched.push(entry.pid);
      return entries;
    },
  };
};

/** The launches once there are at least `count`. */
export const launchesOf = async (launches: () => Launch[], count = 1): Promise<Launch[]> => {
  await waitUntil(() => launches().length >= count, 'the editor to record its launch');
  return launches();
};

/** Sends `openEditor` for `worktree` on host `host`. */
export const openEditor = (client: HubClient, host: number, worktree: string, timeout?: number): Promise<Reply> =>
  client.hubRequest({ t: 'openEditor', host, worktree }, timeout);

/** The message of an error reply, else the empty string. */
export const errorMessage = (reply: Reply): string => (reply.m.t === 'error' ? reply.m.message : '');
