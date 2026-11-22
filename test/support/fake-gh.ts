import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { z } from 'zod';
import { livePidsWhere } from './daemon-host.js';
import { pathWithout } from './fake-ssh.js';

/** One pull request GitHub reports on a branch's ref. */
export interface FakePr {
  number: number;
  state?: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft?: boolean;
  /** The head commit's combined check state; null for none. */
  checks?: 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | 'EXPECTED' | null;
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
}

/** How the fake `gh` answers every later call. */
export type GhBehaviour =
  /** Answers the GraphQL request with each asked branch's pull request, on `acme/app`. */
  { kind: 'answer'; prs: Readonly<Record<string, FakePr>> } | { kind: 'exit'; code: number; stderr?: string } | { kind: 'hang' };

const ghCall = z.object({
  pid: z.number(),
  args: z.array(z.string()),
  /** The origin branches the GraphQL request asked for, sorted. */
  branches: z.array(z.string()),
});

/** One run of the fake `gh`. */
export type GhCall = z.infer<typeof ghCall>;

/** The pull request URL the fake `gh` reports for `number`. */
export const fakePrUrl = (number: number): string => `https://github.com/acme/app/pull/${String(number)}`;

const SCRIPT = (dir: string): string => `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = ${JSON.stringify(dir)};
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  let variables = {};
  try {
    variables = JSON.parse(input).variables ?? {};
  } catch {}
  const branches = Object.entries(variables).filter(([k]) => /^b\\d+$/.test(k)).map(([, v]) => v).sort();
  const call = path.join(dir, 'calls', String(process.hrtime.bigint()).padStart(24, '0') + '-' + process.pid);
  fs.writeFileSync(call + '.tmp', JSON.stringify({ pid: process.pid, args: process.argv.slice(2), branches }));
  fs.renameSync(call + '.tmp', call + '.json');
  const behaviour = JSON.parse(fs.readFileSync(path.join(dir, 'behaviour.json'), 'utf8'));
  if (behaviour.kind === 'hang') {
    setInterval(() => undefined, 1 << 30);
    return;
  }
  if (behaviour.kind === 'exit') {
    process.stderr.write(behaviour.stderr ?? '');
    process.exit(behaviour.code);
  }
  const repository = { nameWithOwner: 'acme/app', parent: null };
  for (const [key, branch] of Object.entries(variables)) {
    const i = /^b(\\d+)$/.exec(key)?.[1];
    if (i === undefined) continue;
    const pr = behaviour.prs[branch];
    const nodes = pr === undefined ? [] : [{
      number: pr.number,
      url: 'https://github.com/acme/app/pull/' + pr.number,
      state: pr.state ?? 'OPEN',
      isDraft: pr.isDraft ?? false,
      updatedAt: '2026-11-20T10:00:00Z',
      mergeable: pr.mergeable ?? 'MERGEABLE',
      reviewDecision: pr.reviewDecision ?? null,
      headRepository: { nameWithOwner: 'acme/app' },
      commits: { nodes: [{ commit: { statusCheckRollup: pr.checks === null ? null : { state: pr.checks ?? 'SUCCESS' } } }] },
    }];
    repository['r' + i] = { associatedPullRequests: { nodes } };
    repository['n' + i] = { nodes: [] };
  }
  process.stdout.write(JSON.stringify({ data: { repository } }));
});
`;

/** A fake `gh` CLI in its own directory, to put first on a daemon's PATH. */
export class FakeGh {
  readonly bin: string;
  private readonly script: string;

  constructor(readonly dir: string) {
    this.bin = join(dir, 'bin');
    this.script = join(this.bin, 'gh');
    mkdirSync(this.bin, { recursive: true });
    mkdirSync(join(dir, 'calls'), { recursive: true });
    writeFileSync(this.script, SCRIPT(dir), { mode: 0o755 });
    this.behave({ kind: 'answer', prs: {} });
  }

  /** A PATH finding this `gh` before any other. */
  get path(): string {
    return `${this.bin}${delimiter}${process.env['PATH'] ?? ''}`;
  }

  /** A PATH with the usual commands and no `gh` at all. */
  pathWithoutGh(): string {
    return pathWithout(join(this.dir, 'no-gh'), new Set(['gh']));
  }

  /** Sets how every later call answers. */
  behave(behaviour: GhBehaviour): void {
    const file = join(this.dir, 'behaviour.json');
    writeFileSync(`${file}.tmp`, JSON.stringify(behaviour));
    renameSync(`${file}.tmp`, file);
  }

  /** Every call so far, in the order started. */
  calls(): GhCall[] {
    const dir = join(this.dir, 'calls');
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ghCall.parse(JSON.parse(readFileSync(join(dir, name), 'utf8'))));
  }

  /** Pids of the runs of this `gh` that are still alive. */
  running(): number[] {
    return livePidsWhere((cmdline) => cmdline[1] === this.script);
  }
}
