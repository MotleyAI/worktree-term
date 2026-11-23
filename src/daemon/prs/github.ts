import { z } from 'zod';
import { prStatusSchema, type PrStatus, type Worktree } from '../../protocol/index.js';
import type { Runner, RunOutcome } from './run.js';

/** Why a refresh failed; it keeps the last statuses. */
export type FailureClass = 'timeout' | 'exit' | 'network' | 'invalid-json' | 'invalid-response';

export type FetchOutcome = { ok: true; prs: PrStatus[] } | { ok: false; failure: FailureClass };

/** Fetches the pull request statuses of `worktrees` of `repo`. */
export type Fetch = (repo: string, worktrees: readonly Worktree[], signal: AbortSignal) => Promise<FetchOutcome>;

export interface Origin {
  host: string;
  owner: string;
  name: string;
  /** Whether `host` may be an SSH alias. */
  ssh: boolean;
}

const GH_MS = 20_000;
const OTHER_MS = 5000;

const SEGMENT = String.raw`[\w.-]+`;
const REPO_PATH = String.raw`(${SEGMENT})/(${SEGMENT}?)(?:\.git)?/?`;
const HTTPS = new RegExp(String.raw`^https://(?:[^@/]+@)?([^@/:]+)(?::\d+)?/${REPO_PATH}$`);
const SSH_URL = new RegExp(String.raw`^ssh://(?:[^@/]+@)?([^@/:]+)(?::\d+)?/${REPO_PATH}$`);
const SCP = new RegExp(String.raw`^(?:[^@/:]+@)?([^@/:]+):${REPO_PATH}$`);

/** The GitHub repository `url` names, or null when it has none of the supported forms. */
export const parseOrigin = (url: string): Origin | null => {
  for (const [pattern, ssh] of [
    [HTTPS, false],
    [SSH_URL, true],
    [SCP, true],
  ] as const) {
    const [, host, owner, name] = pattern.exec(url) ?? [];
    if (host !== undefined && owner !== undefined && name !== undefined && name !== '') return { host, owner, name, ssh };
  }
  return null;
};

const PR_FIELDS = `fragment P on PullRequest {
  number url state isDraft updatedAt mergeable reviewDecision
  headRepository { nameWithOwner }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`;

const byHead = (alias: string, variable: string): string =>
  `${alias}: pullRequests(headRefName: $${variable}, first: 5, states: [OPEN, CLOSED, MERGED], orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ...P } }`;

/** The GraphQL request for `branches` of `owner/name`: one alias triple per distinct branch. */
export const buildQuery = (
  owner: string,
  name: string,
  branches: readonly string[],
): { query: string; variables: Record<string, string> } => {
  const distinct = [...new Set(branches)];
  const variables: Record<string, string> = { owner, name };
  const declared = ['$owner: String!', '$name: String!'];
  const own: string[] = [];
  const parent: string[] = [];
  distinct.forEach((branch, i) => {
    const [q, b] = [`q${String(i)}`, `b${String(i)}`];
    variables[q] = `refs/heads/${branch}`;
    variables[b] = branch;
    declared.push(`$${q}: String!`, `$${b}: String!`);
    own.push(
      `r${String(i)}: ref(qualifiedName: $${q}) { associatedPullRequests(first: 5, states: [OPEN, CLOSED, MERGED], orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ...P } } }`,
      byHead(`n${String(i)}`, b),
    );
    parent.push(byHead(`n${String(i)}`, b));
  });
  const query = `query(${declared.join(', ')}) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    ${own.join('\n    ')}
    parent {
      ${parent.join('\n      ')}
    }
  }
}
${PR_FIELDS}`;
  return { query, variables };
};

const prNode = z.object({
  number: z.number(),
  url: z.string(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  isDraft: z.boolean(),
  updatedAt: z.string(),
  mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
  reviewDecision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).nullable(),
  headRepository: z.object({ nameWithOwner: z.string() }).nullable(),
  commits: z.object({
    nodes: z.array(
      z.object({
        commit: z.object({
          statusCheckRollup: z.object({ state: z.enum(['ERROR', 'EXPECTED', 'FAILURE', 'PENDING', 'SUCCESS']) }).nullable(),
        }),
      }),
    ),
  }),
});
type PrNode = z.infer<typeof prNode>;

const nodes = z.object({ nodes: z.array(prNode) });
const refNodes = z.object({ associatedPullRequests: nodes }).nullable();
const response = z.object({
  data: z.object({
    repository: z.looseObject({ nameWithOwner: z.string(), parent: z.looseObject({}).nullable() }),
  }),
});

const STATE = { MERGED: 'merged', CLOSED: 'closed', OPEN: 'open' } as const;
const CHECKS = { FAILURE: 'failing', ERROR: 'failing', PENDING: 'pending', EXPECTED: 'pending', SUCCESS: 'passing' } as const;
const REVIEW = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes-requested', REVIEW_REQUIRED: 'review-required' } as const;

const newestFirst = (a: PrNode, b: PrNode): number => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);

/** The most recently updated open or draft candidate, else the most recently updated one. */
const choose = (candidates: readonly PrNode[]): PrNode | undefined => {
  const sorted = [...candidates].sort(newestFirst);
  return sorted.find((pr) => pr.state === 'OPEN') ?? sorted[0];
};

const toStatus = (branch: string, pr: PrNode): PrStatus => ({
  branch,
  number: pr.number,
  url: pr.url,
  state: pr.state === 'OPEN' && pr.isDraft ? 'draft' : STATE[pr.state],
  checks: ((rollup) => (rollup === undefined || rollup === null ? 'none' : CHECKS[rollup.state]))(
    pr.commits.nodes.at(-1)?.commit.statusCheckRollup,
  ),
  conflicts: pr.mergeable === 'CONFLICTING',
  review: pr.reviewDecision === null ? null : REVIEW[pr.reviewDecision],
});

const NETWORK =
  /error connecting to|check your internet connection|dial tcp|no such host|connection (?:refused|reset)|i\/o timeout|TLS handshake/i;

/** A failed process's failure class; an abort only happens on close, whose outcome nobody sees. */
const failureOf = (outcome: Exclude<RunOutcome, { kind: 'exit'; code: 0 }>): FailureClass => {
  switch (outcome.kind) {
    case 'timeout':
    case 'aborted':
      return 'timeout';
    case 'overflow':
      return 'invalid-response';
    case 'exit':
      return NETWORK.test(outcome.stderr) ? 'network' : 'exit';
    case 'missing':
    case 'error':
      return 'exit';
  }
};

/** Each asked branch's chosen pull request, or null when an alias is missing or malformed. */
const pickPrs = (repository: z.infer<typeof response>['data']['repository'], branches: readonly string[]): Map<string, PrNode> | null => {
  const own = repository.nameWithOwner.toLowerCase();
  const chosen = new Map<string, PrNode>();
  for (const [i, branch] of branches.entries()) {
    const ref = refNodes.safeParse(repository[`r${String(i)}`]);
    const heads = nodes.safeParse(repository[`n${String(i)}`]);
    const parentHeads =
      repository.parent === null ? { success: true as const, data: { nodes: [] } } : nodes.safeParse(repository.parent[`n${String(i)}`]);
    if (!ref.success || !heads.success || !parentHeads.success) return null;
    const candidates =
      ref.data === null
        ? [...heads.data.nodes, ...parentHeads.data.nodes].filter((pr) => pr.headRepository?.nameWithOwner.toLowerCase() === own)
        : ref.data.associatedPullRequests.nodes;
    const pr = choose(candidates);
    if (pr !== undefined) chosen.set(branch, pr);
  }
  return chosen;
};

type Step<T> = { ok: true; value: T } | { ok: false; outcome: FetchOutcome };

const EMPTY: FetchOutcome = { ok: true, prs: [] };

/** Parses `git config -z --get-regexp` output into each branch's remote and merge refs. */
const parseBranchConfig = (output: string): Map<string, { remote?: string; merges: string[] }> => {
  const branches = new Map<string, { remote?: string; merges: string[] }>();
  for (const entry of output.split('\0')) {
    const newline = entry.indexOf('\n');
    if (newline < 0) continue;
    const [key, value] = [entry.slice(0, newline), entry.slice(newline + 1)];
    const match = /^branch\.(.+)\.(remote|merge)$/.exec(key);
    const [, branch, variable] = match ?? [];
    if (branch === undefined) continue;
    const config = branches.get(branch) ?? { merges: [] };
    if (variable === 'remote') config.remote = value;
    else config.merges.push(value);
    branches.set(branch, config);
  }
  return branches;
};

/** The branch of `origin` local `branch` stands for, or null when it tracks another remote or several branches. */
const originBranch = (branch: string, config: { remote?: string; merges: string[] } | undefined): string | null => {
  if (config?.remote === undefined) return branch;
  if (config.remote !== 'origin') return null;
  if (config.merges.length > 1) return null;
  const [merge] = config.merges;
  return merge?.startsWith('refs/heads/') === true ? merge.slice('refs/heads/'.length) : branch;
};

/** A fetcher asking GitHub through `gh`, running every process with `run`. */
export const githubFetcher = (run: Runner): Fetch => {
  /** Real host names of SSH origins, by origin URL. */
  const sshHosts = new Map<string, string>();

  const query = async (repo: string, args: readonly string[], signal: AbortSignal): Promise<Step<string | null>> => {
    const outcome = await run('git', args, { cwd: repo, timeoutMs: OTHER_MS, signal });
    if (outcome.kind !== 'exit') return { ok: false, outcome: { ok: false, failure: failureOf(outcome) } };
    return { ok: true, value: outcome.code === 0 ? outcome.stdout : null };
  };

  const hostOf = async (url: string, origin: Origin, repo: string, signal: AbortSignal): Promise<Step<string>> => {
    if (!origin.ssh) return { ok: true, value: origin.host };
    const known = sshHosts.get(url);
    if (known !== undefined) return { ok: true, value: known };
    const outcome = await run('ssh', ['-G', origin.host], { cwd: repo, timeoutMs: OTHER_MS, signal });
    if (outcome.kind === 'timeout' || outcome.kind === 'aborted') return { ok: false, outcome: { ok: false, failure: 'timeout' } };
    const resolved = outcome.kind === 'exit' && outcome.code === 0 ? /^hostname (\S+)$/m.exec(outcome.stdout)?.[1] : undefined;
    if (resolved === undefined) return { ok: true, value: origin.host };
    sshHosts.set(url, resolved);
    return { ok: true, value: resolved };
  };

  const ask = async (repo: string, host: string, body: string, signal: AbortSignal): Promise<Step<unknown>> => {
    const outcome = await run('gh', ['api', 'graphql', '--hostname', host, '--input', '-'], {
      cwd: repo,
      timeoutMs: GH_MS,
      input: body,
      signal,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
    });
    if (outcome.kind === 'missing' || (outcome.kind === 'exit' && outcome.code === 4)) return { ok: false, outcome: EMPTY };
    if (outcome.kind !== 'exit' || outcome.code !== 0) return { ok: false, outcome: { ok: false, failure: failureOf(outcome) } };
    try {
      return { ok: true, value: JSON.parse(outcome.stdout) };
    } catch {
      return { ok: false, outcome: { ok: false, failure: 'invalid-json' } };
    }
  };

  return async (repo, worktrees, signal) => {
    const url = await query(repo, ['remote', 'get-url', 'origin'], signal);
    if (!url.ok) return url.outcome;
    const origin = url.value === null ? null : parseOrigin(url.value.trim());
    if (url.value === null || origin === null) return EMPTY;
    const config = await query(repo, ['config', '-z', '--get-regexp', String.raw`^branch\..*\.(remote|merge)$`], signal);
    if (!config.ok) return config.outcome;
    const branchConfig = parseBranchConfig(config.value ?? '');
    const asked = new Map<string, string>();
    for (const { branch, bare } of worktrees) {
      if (branch === null || bare || asked.has(branch)) continue;
      const remote = originBranch(branch, branchConfig.get(branch));
      if (remote !== null) asked.set(branch, remote);
    }
    const branches = [...new Set(asked.values())];
    if (branches.length === 0) return EMPTY;
    const host = await hostOf(url.value.trim(), origin, repo, signal);
    if (!host.ok) return host.outcome;
    const answer = await ask(repo, host.value, JSON.stringify(buildQuery(origin.owner, origin.name, branches)), signal);
    if (!answer.ok) return answer.outcome;
    const parsed = response.safeParse(answer.value);
    if (!parsed.success) return { ok: false, failure: 'invalid-response' };
    const chosen = pickPrs(parsed.data.data.repository, branches);
    if (chosen === null) return { ok: false, failure: 'invalid-response' };
    const prs: PrStatus[] = [];
    for (const [local, remote] of asked) {
      const pr = chosen.get(remote);
      if (pr === undefined) continue;
      const status = prStatusSchema.safeParse(toStatus(local, pr));
      if (!status.success) return { ok: false, failure: 'invalid-response' };
      prs.push(status.data);
    }
    return { ok: true, prs };
  };
};
