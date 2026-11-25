import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { git, makeRepo } from '../../../test/support/daemon-host.js';
import type { PrStatus, Worktree } from '../../protocol/index.js';
import { buildQuery, githubFetcher, parseOrigin } from './github.js';
import { runBounded, type RunOptions, type RunOutcome, type Runner } from './run.js';

describe('parseOrigin', () => {
  it.each([
    ['https://github.com/acme/app.git', 'github.com', false],
    ['https://github.com/acme/app', 'github.com', false],
    ['https://github.example.com/acme/app.git', 'github.example.com', false],
    ['git@github.com:acme/app.git', 'github.com', true],
    ['git@github.com:acme/app', 'github.com', true],
    ['git@gh-work:acme/app.git', 'gh-work', true],
    ['ssh://git@github.com/acme/app.git', 'github.com', true],
    ['ssh://github.com:2222/acme/app', 'github.com', true],
  ])('parses %s', (url, host, ssh) => {
    expect(parseOrigin(url)).toEqual({ host, owner: 'acme', name: 'app', ssh });
  });

  it.each([
    '',
    '/srv/git/app.git',
    'file:///srv/git/app.git',
    'http://github.com/acme/app.git',
    'https://github.com/acme',
    'https://github.com/acme/app/pulls',
    'ext::sh -c x',
  ])('yields null for %j', (url) => {
    expect(parseOrigin(url)).toBeNull();
  });
});

describe('buildQuery', () => {
  it('asks for one alias set per distinct branch, with the repository in variables', () => {
    const { query, variables } = buildQuery('acme', 'app', ['feature/x', 'fix/y', 'feature/x']);
    expect(variables).toEqual({
      owner: 'acme',
      name: 'app',
      q0: 'refs/heads/feature/x',
      b0: 'feature/x',
      q1: 'refs/heads/fix/y',
      b1: 'fix/y',
    });
    for (const i of ['0', '1']) {
      expect(query).toContain(`r${i}: ref(qualifiedName: $q${i})`);
      expect(query.split(`n${i}: pullRequests(headRefName: $b${i}, first: 5, states: [OPEN, CLOSED, MERGED]`)).toHaveLength(3);
      expect(query.split(`o${i}: pullRequests(headRefName: $b${i}, first: 5, states: [OPEN],`)).toHaveLength(3);
    }
    expect(query.split('all: associatedPullRequests(first: 5, states: [OPEN, CLOSED, MERGED]')).toHaveLength(3);
    expect(query.split('open: associatedPullRequests(first: 5, states: [OPEN],')).toHaveLength(3);
    expect(query).not.toContain('r2:');
    expect(query).toContain('parent {');
    expect(query).toContain('headRepository');
  });
});

const graphqlBody = z.object({ query: z.string(), variables: z.record(z.string(), z.string()) });
type GraphqlBody = z.infer<typeof graphqlBody>;

const bodyOf = (input: string | undefined): GraphqlBody => graphqlBody.parse(JSON.parse(input ?? ''));

interface Call {
  command: string;
  args: readonly string[];
  options: RunOptions;
}

type Reply = RunOutcome | ((body: GraphqlBody) => RunOutcome);

interface PrNode {
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  updatedAt: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  headRepository: { nameWithOwner: string } | null;
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
}

/** What GitHub knows about one branch: PRs of its ref (null when the branch is gone), and by head name in origin and its parent. */
interface BranchOnGitHub {
  ref: PrNode[] | null;
  heads?: PrNode[];
  parentHeads?: PrNode[];
}

const pr = (number: number, fields: Partial<PrNode> = {}): PrNode => ({
  number,
  url: `https://github.com/acme/app/pull/${String(number)}`,
  state: 'OPEN',
  isDraft: false,
  updatedAt: '2026-11-20T10:00:00Z',
  mergeable: 'MERGEABLE',
  reviewDecision: null,
  headRepository: { nameWithOwner: 'acme/app' },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  ...fields,
});

const withChecks = (state: string | null): Partial<PrNode> => ({
  commits: { nodes: [{ commit: { statusCheckRollup: state === null ? null : { state } } }] },
});

const exit = (code: number, stdout = '', stderr = ''): RunOutcome => ({ kind: 'exit', code, stdout, stderr });

/** One connection page as GitHub returns it: the 5 most recently updated, of every state or open ones only. */
const page = (prs: readonly PrNode[], openOnly: boolean): { nodes: PrNode[] } => ({
  nodes: prs
    .filter((p) => !openOnly || p.state === 'OPEN')
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 5),
});

/** A gh reply answering each asked branch from `github`, as GitHub's GraphQL API does. */
const answer =
  (github: Readonly<Record<string, BranchOnGitHub>>, { parent = true, nameWithOwner = 'acme/app' } = {}) =>
  (body: GraphqlBody): RunOutcome => {
    const parentRepo: Record<string, unknown> = {};
    const repository: Record<string, unknown> = { nameWithOwner, parent: parent ? parentRepo : null };
    for (const [key, branch] of Object.entries(body.variables)) {
      const i = /^b(\d+)$/.exec(key)?.[1];
      if (i === undefined) continue;
      expect(body.variables[`q${i}`]).toBe(`refs/heads/${branch}`);
      const known = github[branch] ?? { ref: [] };
      repository[`r${i}`] = known.ref === null ? null : { all: page(known.ref, false), open: page(known.ref, true) };
      repository[`n${i}`] = page(known.heads ?? [], false);
      repository[`o${i}`] = page(known.heads ?? [], true);
      parentRepo[`n${i}`] = page(known.parentHeads ?? [], false);
      parentRepo[`o${i}`] = page(known.parentHeads ?? [], true);
    }
    return exit(0, JSON.stringify({ data: { repository } }));
  };

let root: string;
let repo: string;
let calls: Call[];
let ghReply: Reply;
let sshReply: RunOutcome;

const run: Runner = (command, args, options) => {
  calls.push({ command, args, options });
  if (command === 'gh') {
    const reply = ghReply;
    if (typeof reply !== 'function') return Promise.resolve(reply);
    return Promise.resolve(reply(bodyOf(options.input)));
  }
  if (command === 'ssh') return Promise.resolve(sshReply);
  return runBounded(command, args, options);
};

const ghCalls = (): Call[] => calls.filter((c) => c.command === 'gh');
const askedBranches = (call: Call | undefined): string[] => {
  return Object.entries(bodyOf(call?.options.input).variables)
    .filter(([key]) => /^b\d+$/.test(key))
    .map(([, branch]) => branch)
    .sort((a, b) => a.localeCompare(b));
};

const worktree = (branch: string | null, path = `/wt/${branch ?? 'detached'}`): Worktree => ({
  path,
  head: null,
  branch,
  detached: branch === null,
  locked: false,
  prunable: false,
  bare: false,
  main: false,
});

const sorted = (prs: readonly PrStatus[]): PrStatus[] => [...prs].sort((a, b) => a.branch.localeCompare(b.branch));

const status = (branch: string, number: number, fields: Partial<PrStatus> = {}): PrStatus => ({
  branch,
  number,
  url: `https://github.com/acme/app/pull/${String(number)}`,
  state: 'open',
  checks: 'passing',
  conflicts: false,
  review: null,
  ...fields,
});

beforeEach(() => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  root = realpathSync(mkdtempSync(join(tmpdir(), 'wtd-prs-')));
  repo = makeRepo(join(root, 'repo'));
  git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
  calls = [];
  ghReply = answer({});
  sshReply = exit(255, '', 'ssh: unexpected');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const fetchOnce = (worktrees: readonly Worktree[], fetch = githubFetcher(run)) => fetch(repo, worktrees, new AbortController().signal);

describe('githubFetcher: the request', () => {
  it("asks gh once, for origin's host, with the query on stdin and a 20 s bound", async () => {
    await fetchOnce([{ ...worktree('main', repo), main: true }, worktree('feature/x'), worktree(null)]);
    expect(ghCalls()).toHaveLength(1);
    const [call] = ghCalls();
    expect(call?.args).toEqual(['api', 'graphql', '--hostname', 'github.com', '--input', '-']);
    expect(call?.options.timeoutMs).toBe(20_000);
    expect(askedBranches(call)).toEqual(['feature/x', 'main']);
    const body = bodyOf(call?.options.input);
    expect(body.variables).toMatchObject({ owner: 'acme', name: 'app' });
    expect(body.query).toContain('r0: ref(qualifiedName: $q0)');
  });

  it('bounds every other process to 5 s and hands every process the abort signal', async () => {
    git(repo, 'remote', 'set-url', 'origin', 'git@gh-work:acme/app.git');
    sshReply = exit(0, 'user git\nhostname github.com\nport 22\n');
    const abort = new AbortController();
    await githubFetcher(run)(repo, [worktree('feature/x')], abort.signal);
    expect(calls.filter((c) => c.command !== 'gh').length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.options.signal).toBe(abort.signal);
      if (call.command !== 'gh') expect(call.options.timeoutMs).toBe(5000);
    }
  });

  it('asks for the host of a GitHub Enterprise origin', async () => {
    git(repo, 'remote', 'set-url', 'origin', 'https://github.example.com/acme/app');
    await fetchOnce([worktree('feature/x')]);
    expect(ghCalls()[0]?.args).toContain('github.example.com');
  });

  it('resolves an SSH host alias through ssh -G, once per origin URL', async () => {
    git(repo, 'remote', 'set-url', 'origin', 'git@gh-work:acme/app.git');
    sshReply = exit(0, 'user git\nhostname github.com\nport 22\n');
    const fetch = githubFetcher(run);
    await fetchOnce([worktree('feature/x')], fetch);
    await fetchOnce([worktree('feature/x')], fetch);
    const sshCalls = calls.filter((c) => c.command === 'ssh');
    expect(sshCalls).toHaveLength(1);
    expect(sshCalls[0]?.args).toEqual(['-G', 'gh-work']);
    expect(ghCalls().map((c) => c.args[3])).toEqual(['github.com', 'github.com']);
  });

  it('asks for the origin branch a local branch tracks, and keys its status by the local branch', async () => {
    git(repo, 'config', 'branch.wip.remote', 'origin');
    git(repo, 'config', 'branch.wip.merge', 'refs/heads/feature/x');
    ghReply = answer({ 'feature/x': { ref: [pr(12)] } });
    expect(await fetchOnce([worktree('wip')])).toEqual({ ok: true, prs: [status('wip', 12)] });
    expect(askedBranches(ghCalls()[0])).toEqual(['feature/x']);
  });

  it('asks once for an origin branch two local branches track, and lists both', async () => {
    for (const local of ['a', 'b']) {
      git(repo, 'config', `branch.${local}.remote`, 'origin');
      git(repo, 'config', `branch.${local}.merge`, 'refs/heads/feature/x');
    }
    ghReply = answer({ 'feature/x': { ref: [pr(12)] } });
    const outcome = await fetchOnce([worktree('a'), worktree('b')]);
    expect(outcome.ok).toBe(true);
    expect(outcome.ok ? sorted(outcome.prs) : []).toEqual([status('a', 12), status('b', 12)]);
    expect(askedBranches(ghCalls()[0])).toEqual(['feature/x']);
  });

  it('asks for no branch that tracks another remote or several branches', async () => {
    git(repo, 'config', 'branch.up.remote', 'upstream');
    git(repo, 'config', 'branch.up.merge', 'refs/heads/up');
    git(repo, 'config', 'branch.multi.remote', 'origin');
    git(repo, 'config', 'branch.multi.merge', 'refs/heads/one');
    git(repo, 'config', '--add', 'branch.multi.merge', 'refs/heads/two');
    ghReply = answer({ up: { ref: [pr(1)] }, multi: { ref: [pr(2)] }, one: { ref: [pr(3)] }, plain: { ref: [pr(4)] } });
    expect(await fetchOnce([worktree('up'), worktree('multi'), worktree('plain')])).toEqual({ ok: true, prs: [status('plain', 4)] });
    expect(askedBranches(ghCalls()[0])).toEqual(['plain']);
  });

  it('lists no status for a detached or bare worktree', async () => {
    ghReply = answer({ main: { ref: [pr(1)] } });
    expect(await fetchOnce([worktree(null), { ...worktree(null, repo), bare: true, detached: false }])).toEqual({ ok: true, prs: [] });
  });
});

describe('githubFetcher: outcomes', () => {
  it('succeeds empty without running gh when the repo has no origin', async () => {
    git(repo, 'remote', 'remove', 'origin');
    expect(await fetchOnce([worktree('feature/x')])).toEqual({ ok: true, prs: [] });
    expect(ghCalls()).toHaveLength(0);
  });

  it("succeeds empty without running gh when origin's URL is not a GitHub form", async () => {
    git(repo, 'remote', 'set-url', 'origin', '/srv/git/app.git');
    expect(await fetchOnce([worktree('feature/x')])).toEqual({ ok: true, prs: [] });
    expect(ghCalls()).toHaveLength(0);
  });

  it.each([
    ['gh is missing', { kind: 'missing' }],
    ['gh reports no login (exit 4)', exit(4, '', 'To get started with GitHub CLI, please run:  gh auth login')],
  ] as const)('succeeds empty when %s', async (_name, reply) => {
    ghReply = reply;
    expect(await fetchOnce([worktree('feature/x')])).toEqual({ ok: true, prs: [] });
  });

  it.each([
    ['gh times out', { kind: 'timeout' }, 'timeout'],
    ['gh fails', exit(1, '', 'GraphQL: Something went wrong (repository)'), 'exit'],
    [
      'gh cannot reach GitHub',
      exit(1, '', 'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com'),
      'network',
    ],
    ['gh prints no JSON', exit(0, 'not json'), 'invalid-json'],
    [
      'gh prints JSON of another shape',
      exit(0, JSON.stringify({ data: { repository: { nameWithOwner: 'acme/app', r0: 5 } } })),
      'invalid-response',
    ],
  ] as const)('fails with %s, carrying only the failure class', async (_name, reply, failure) => {
    ghReply = reply;
    expect(await fetchOnce([worktree('feature/x')])).toEqual({ ok: false, failure });
  });

  it('fails when the response lacks an asked branch', async () => {
    ghReply = exit(0, JSON.stringify({ data: { repository: { nameWithOwner: 'acme/app', parent: null } } }));
    expect(await fetchOnce([worktree('feature/x')])).toEqual({ ok: false, failure: 'invalid-response' });
  });

  it('fails when a pull request URL is not https', async () => {
    ghReply = answer({ 'feature/x': { ref: [pr(12, { url: 'http://github.com/acme/app/pull/12' })] } });
    expect(await fetchOnce([worktree('feature/x')])).toEqual({ ok: false, failure: 'invalid-response' });
  });
});

describe('githubFetcher: which pull request', () => {
  const fetchFor = (known: BranchOnGitHub, options?: { parent?: boolean; nameWithOwner?: string }) => {
    ghReply = answer({ 'feature/x': known }, options);
    return fetchOnce([worktree('feature/x')]);
  };

  it('lists the pull request of the exact head, into origin or its parent', async () => {
    const intoParent = pr(12, { url: 'https://github.com/upstream/app/pull/12' });
    expect(await fetchFor({ ref: [intoParent] })).toEqual({
      ok: true,
      prs: [status('feature/x', 12, { url: 'https://github.com/upstream/app/pull/12' })],
    });
  });

  it("ignores another fork's pull request of the same name while the branch exists", async () => {
    expect(await fetchFor({ ref: [], heads: [pr(5, { headRepository: { nameWithOwner: 'other/app' } })] })).toEqual({
      ok: true,
      prs: [],
    });
  });

  it('falls back to head names after the branch was deleted, keeping only heads of origin', async () => {
    const merged = pr(7, { state: 'MERGED' });
    const otherFork = pr(8, { headRepository: { nameWithOwner: 'other/app' }, updatedAt: '2026-11-21T10:00:00Z' });
    expect(await fetchFor({ ref: null, heads: [otherFork, merged] })).toEqual({
      ok: true,
      prs: [status('feature/x', 7, { state: 'merged' })],
    });
  });

  it("finds a deleted branch's pull request into the parent", async () => {
    expect(await fetchFor({ ref: null, parentHeads: [pr(9, { url: 'https://github.com/upstream/app/pull/9' })] })).toEqual({
      ok: true,
      prs: [status('feature/x', 9, { url: 'https://github.com/upstream/app/pull/9' })],
    });
  });

  it('compares head repositories case-insensitively', async () => {
    expect(await fetchFor({ ref: null, heads: [pr(7, { headRepository: { nameWithOwner: 'Acme/App' } })] })).toMatchObject({
      ok: true,
      prs: [{ number: 7 }],
    });
  });

  it('drops pull requests whose head repository is gone', async () => {
    expect(await fetchFor({ ref: null, heads: [pr(7, { headRepository: null })] })).toEqual({ ok: true, prs: [] });
  });

  it('lists none when only another fork has a pull request of that name', async () => {
    const other = { headRepository: { nameWithOwner: 'other/app' } };
    expect(await fetchFor({ ref: null, heads: [pr(5, other)], parentHeads: [pr(6, other)] })).toEqual({ ok: true, prs: [] });
  });

  it('copes with a repository that is no fork', async () => {
    expect(await fetchFor({ ref: null, heads: [pr(7)] }, { parent: false })).toMatchObject({ ok: true, prs: [{ number: 7 }] });
  });

  it('prefers an open pull request over a more recently updated closed one', async () => {
    const closed = pr(2, { state: 'CLOSED', updatedAt: '2026-11-21T10:00:00Z' });
    const open = pr(1, { updatedAt: '2026-11-14T10:00:00Z' });
    expect(await fetchFor({ ref: [closed, open] })).toMatchObject({ ok: true, prs: [{ number: 1, state: 'open' }] });
  });

  it.each([
    ['of the exact head', (prs: PrNode[]): BranchOnGitHub => ({ ref: prs })],
    ['by head name after the branch was deleted', (prs: PrNode[]): BranchOnGitHub => ({ ref: null, heads: prs })],
  ])('finds an open pull request %s behind five more recently updated closed ones', async (_name, known) => {
    const closed = [1, 2, 3, 4, 5].map((n) => pr(n + 1, { state: 'CLOSED', updatedAt: `2026-11-2${String(n)}T10:00:00Z` }));
    const open = pr(1, { updatedAt: '2026-11-10T10:00:00Z' });
    expect(await fetchFor(known([...closed, open]))).toMatchObject({ ok: true, prs: [{ number: 1, state: 'open' }] });
  });

  it('counts a draft as open', async () => {
    const closed = pr(2, { state: 'CLOSED', updatedAt: '2026-11-21T10:00:00Z' });
    const draft = pr(1, { isDraft: true, updatedAt: '2026-11-14T10:00:00Z' });
    expect(await fetchFor({ ref: [closed, draft] })).toMatchObject({ ok: true, prs: [{ number: 1, state: 'draft' }] });
  });

  it('takes the most recently updated open one across origin and its parent', async () => {
    const older = pr(1, { updatedAt: '2026-11-10T10:00:00Z' });
    const newer = pr(2, { updatedAt: '2026-11-15T10:00:00Z' });
    expect(await fetchFor({ ref: null, heads: [older], parentHeads: [newer] })).toMatchObject({ ok: true, prs: [{ number: 2 }] });
  });

  it('takes the most recently updated one when none is open', async () => {
    const merged = pr(1, { state: 'MERGED', updatedAt: '2026-11-20T10:00:00Z' });
    const closed = pr(2, { state: 'CLOSED', updatedAt: '2026-11-21T10:00:00Z' });
    expect(await fetchFor({ ref: [closed, merged] })).toMatchObject({ ok: true, prs: [{ number: 2, state: 'closed' }] });
  });

  it('lists only branches that have a pull request', async () => {
    ghReply = answer({ 'feature/x': { ref: [pr(12)] } });
    expect(await fetchOnce([worktree('feature/x'), worktree('fix/y')])).toEqual({ ok: true, prs: [status('feature/x', 12)] });
  });
});

describe('githubFetcher: mapping', () => {
  const mapped = async (fields: Partial<PrNode>): Promise<PrStatus | undefined> => {
    ghReply = answer({ 'feature/x': { ref: [pr(12, fields)] } });
    const outcome = await fetchOnce([worktree('feature/x')]);
    return outcome.ok ? outcome.prs[0] : undefined;
  };

  it.each([
    [{ state: 'MERGED' }, 'merged'],
    [{ state: 'CLOSED' }, 'closed'],
    [{ state: 'OPEN', isDraft: true }, 'draft'],
    [{ state: 'OPEN', isDraft: false }, 'open'],
  ] as const)('maps %o to state %s', async (fields, state) => {
    expect(await mapped(fields)).toMatchObject({ state });
  });

  it.each([
    ['FAILURE', 'failing'],
    ['ERROR', 'failing'],
    ['PENDING', 'pending'],
    ['EXPECTED', 'pending'],
    ['SUCCESS', 'passing'],
    [null, 'none'],
  ] as const)('maps check rollup %s to checks %s', async (rollup, checks) => {
    expect(await mapped(withChecks(rollup))).toMatchObject({ checks });
  });

  it('maps a head without commits to checks none', async () => {
    expect(await mapped({ commits: { nodes: [] } })).toMatchObject({ checks: 'none' });
  });

  it.each([
    ['CONFLICTING', true],
    ['MERGEABLE', false],
    ['UNKNOWN', false],
  ] as const)('maps mergeable %s to conflicts %s', async (mergeable, conflicts) => {
    expect(await mapped({ mergeable })).toMatchObject({ conflicts });
  });

  it.each([
    ['APPROVED', 'approved'],
    ['CHANGES_REQUESTED', 'changes-requested'],
    ['REVIEW_REQUIRED', 'review-required'],
    [null, null],
  ] as const)('maps review decision %s to %s', async (reviewDecision, review) => {
    expect(await mapped({ reviewDecision })).toMatchObject({ review });
  });

  it('carries the number and URL', async () => {
    expect(await mapped({ number: 4294967295, url: 'https://github.com/acme/app/pull/4294967295' })).toMatchObject({
      number: 4294967295,
      url: 'https://github.com/acme/app/pull/4294967295',
    });
  });
});

describe('githubFetcher: a response captured from GitHub', () => {
  it('parses it into each branch status', async () => {
    const captured = readFileSync(join(import.meta.dirname, 'github-capture.json'), 'utf8');
    git(repo, 'remote', 'set-url', 'origin', 'git@github.com:MotleyAI/worktree-term.git');
    sshReply = exit(0, 'hostname github.com\n');
    ghReply = exit(0, captured);
    const branches = ['egor/dev-2359-worktree-term-sidebar-toggle-to-show-only', 'egor/empty-worktree-choices-focus', 'wtd-no-such-branch'];
    expect(await fetchOnce(branches.map((b) => worktree(b)))).toEqual({
      ok: true,
      prs: [
        {
          branch: branches[0],
          number: 27,
          url: 'https://github.com/MotleyAI/worktree-term/pull/27',
          state: 'merged',
          checks: 'passing',
          conflicts: false,
          review: null,
        },
        {
          branch: branches[1],
          number: 19,
          url: 'https://github.com/MotleyAI/worktree-term/pull/19',
          state: 'closed',
          checks: 'failing',
          conflicts: true,
          review: null,
        },
      ],
    });
  });
});
