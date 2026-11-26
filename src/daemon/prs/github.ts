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
const SCP = new RegExp(`^(?:[^@/:]+@)?([^@/:]+):${REPO_PATH}$`);

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
  repository { nameWithOwner }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`;

const ORDER = 'orderBy: {field: UPDATED_AT, direction: DESC}';
/** Every state, and open ones apart, so the limit never hides an open pull request behind newer closed ones. */
const ALL = `first: 5, states: [OPEN, CLOSED, MERGED], ${ORDER}`;
const OPEN = `first: 5, states: [OPEN], ${ORDER}`;

const byHead = (i: string, variable: string): string[] => [
  `n${i}: pullRequests(headRefName: $${variable}, ${ALL}) { nodes { ...P } }`,
  `o${i}: pullRequests(headRefName: $${variable}, ${OPEN}) { nodes { ...P } }`,
];

/** The GraphQL request for `branches` of `owner/name`: one alias set per distinct branch. */
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
  distinct.forEach((branch, index) => {
    const i = String(index);
    const [q, b] = [`q${i}`, `b${i}`];
    variables[q] = `refs/heads/${branch}`;
    variables[b] = branch;
    declared.push(`$${q}: String!`, `$${b}: String!`);
    own.push(
      `r${i}: ref(qualifiedName: $${q}) { all: associatedPullRequests(${ALL}) { nodes { ...P } } open: associatedPullRequests(${OPEN}) { nodes { ...P } } }`,
      ...byHead(i, b),
    );
    parent.push(...byHead(i, b));
  });
  const query = `query(${declared.join(', ')}) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    ${own.join('\n    ')}
    parent {
      nameWithOwner
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
  repository: z.object({ nameWithOwner: z.string() }),
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
const refNodes = z.object({ all: nodes, open: nodes }).nullable();
const response = z.object({
  data: z.object({
    repository: z.looseObject({ nameWithOwner: z.string(), parent: z.looseObject({ nameWithOwner: z.string() }).nullable() }),
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

const checksOf = (pr: PrNode): PrStatus['checks'] => {
  const rollup = pr.commits.nodes.at(-1)?.commit.statusCheckRollup;
  return rollup === undefined || rollup === null ? 'none' : CHECKS[rollup.state];
};

const toStatus = (branch: string, pr: PrNode): PrStatus => ({
  branch,
  number: pr.number,
  url: pr.url,
  state: pr.state === 'OPEN' && pr.isDraft ? 'draft' : STATE[pr.state],
  checks: checksOf(pr),
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

/** Branch `i`'s pull requests by head name in `repository` (none without one), or null when malformed. */
const headsOf = (repository: Readonly<Record<string, unknown>> | null, i: string): PrNode[] | null => {
  if (repository === null) return [];
  const all = nodes.safeParse(repository[`n${i}`]);
  const open = nodes.safeParse(repository[`o${i}`]);
  return all.success && open.success ? [...all.data.nodes, ...open.data.nodes] : null;
};

/** Each asked branch's chosen pull request, or null when an alias is missing or malformed. */
const pickPrs = (repository: z.infer<typeof response>['data']['repository'], branches: readonly string[]): Map<string, PrNode> | null => {
  const own = repository.nameWithOwner.toLowerCase();
  const bases = new Set([own, ...(repository.parent === null ? [] : [repository.parent.nameWithOwner.toLowerCase()])]);
  /** Headed by origin's branch and belonging to origin or its parent. */
  const isCandidate = (pr: PrNode): boolean =>
    pr.headRepository?.nameWithOwner.toLowerCase() === own && bases.has(pr.repository.nameWithOwner.toLowerCase());
  const chosen = new Map<string, PrNode>();
  for (const [index, branch] of branches.entries()) {
    const i = String(index);
    const ref = refNodes.safeParse(repository[`r${i}`]);
    const heads = headsOf(repository, i);
    const parentHeads = headsOf(repository.parent, i);
    if (!ref.success || heads === null || parentHeads === null) return null;
    const byRef = ref.data === null ? [] : [...ref.data.all.nodes, ...ref.data.open.nodes];
    const pr = choose([...byRef, ...heads, ...parentHeads].filter(isCandidate));
    if (pr !== undefined) chosen.set(branch, pr);
  }
  return chosen;
};

type Step<T> = { ok: true; value: T } | { ok: false; outcome: FetchOutcome };

const EMPTY: FetchOutcome = { ok: true, prs: [] };

const HEADS = 'refs/heads/';
const FOR_EACH_REF = ['for-each-ref', '--format=%(refname)%00%(push:remotename)%00%(upstream:remotename)', 'refs/heads'];
const CONFIG = ['config', '-z', '--get-regexp', String.raw`^(push\.default|branch\..*\.merge)$`];
/** `push.default` modes under which `git push` sends a branch to its upstream's name. */
const TO_UPSTREAM = new Set(['upstream', 'tracking']);

const refLine = z.tuple([z.string().startsWith(HEADS), z.string(), z.string()]);
const configEntry = z.tuple([z.string().regex(/^(?:push\.default|branch\..+\.merge)$/), z.string()]);

interface Remotes {
  push: string;
  upstream: string;
}

interface GitConfig {
  pushDefault?: string;
  merges: Map<string, string[]>;
}

/** Each local branch's push and upstream remote (empty when unset), or null when malformed. */
const parseRefs = (output: string): Map<string, Remotes> | null => {
  const remotes = new Map<string, Remotes>();
  for (const line of output.split('\n')) {
    if (line === '') continue;
    const parsed = refLine.safeParse(line.split('\0'));
    if (!parsed.success) return null;
    const [refname, push, upstream] = parsed.data;
    remotes.set(refname.slice(HEADS.length), { push, upstream });
  }
  return remotes;
};

/** `push.default` and each branch's merge values, or null when malformed. */
const parseConfig = (output: string): GitConfig | null => {
  const config: GitConfig = { merges: new Map() };
  for (const entry of output.split('\0')) {
    if (entry === '') continue;
    const newline = entry.indexOf('\n');
    const parsed = configEntry.safeParse(newline < 0 ? [entry] : [entry.slice(0, newline), entry.slice(newline + 1)]);
    if (!parsed.success) return null;
    const [key, value] = parsed.data;
    if (key === 'push.default') {
      config.pushDefault = value;
      continue;
    }
    const branch = key.slice('branch.'.length, -'.merge'.length);
    config.merges.set(branch, [...(config.merges.get(branch) ?? []), value]);
  }
  return config;
};

/** The branch of `origin` local `branch` is pushed to, or null when it is pushed to another remote. */
const originBranch = (branch: string, remotes: Remotes | undefined, config: GitConfig): string | null => {
  const push = remotes?.push ?? '';
  if (push !== '' && push !== 'origin') return null;
  const merges = config.merges.get(branch) ?? [];
  const [merge] = merges;
  const toUpstream = config.pushDefault !== undefined && TO_UPSTREAM.has(config.pushDefault) && remotes?.upstream === 'origin';
  return toUpstream && merges.length === 1 && merge?.startsWith(HEADS) === true ? merge.slice(HEADS.length) : branch;
};

/** The origin branch of each worktree's local branch, for those that have one, or null when git's output is malformed. */
const originBranches = (worktrees: readonly Worktree[], refs: string, configOutput: string): Map<string, string> | null => {
  const remotes = parseRefs(refs);
  const config = parseConfig(configOutput);
  if (remotes === null || config === null) return null;
  const asked = new Map<string, string>();
  for (const { branch, bare } of worktrees) {
    if (branch === null || bare || asked.has(branch)) continue;
    const remote = originBranch(branch, remotes.get(branch), config);
    if (remote !== null) asked.set(branch, remote);
  }
  return asked;
};

/** The status of each local branch whose origin branch has a chosen pull request, or null when one is invalid. */
const statusesOf = (asked: ReadonlyMap<string, string>, chosen: ReadonlyMap<string, PrNode>): PrStatus[] | null => {
  const prs: PrStatus[] = [];
  for (const [local, remote] of asked) {
    const pr = chosen.get(remote);
    if (pr === undefined) continue;
    const status = prStatusSchema.safeParse(toStatus(local, pr));
    if (!status.success) return null;
    prs.push(status.data);
  }
  return prs;
};

/** A fetcher asking GitHub through `gh`, running every process with `run`. */
export const githubFetcher = (run: Runner): Fetch => {
  /** Real host names of SSH origins, by origin URL. */
  const sshHosts = new Map<string, string>();

  /** Git's output in `repo`, null on an exit code `absent` accepts, else the failure. */
  const query = async (
    repo: string,
    args: readonly string[],
    signal: AbortSignal,
    absent: (code: number) => boolean,
  ): Promise<Step<string | null>> => {
    const outcome = await run('git', args, { cwd: repo, timeoutMs: OTHER_MS, signal });
    if (outcome.kind === 'exit' && outcome.code === 0) return { ok: true, value: outcome.stdout };
    if (outcome.kind === 'exit' && absent(outcome.code)) return { ok: true, value: null };
    return { ok: false, outcome: { ok: false, failure: failureOf(outcome) } };
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
    const url = await query(repo, ['remote', 'get-url', 'origin'], signal, () => true);
    if (!url.ok) return url.outcome;
    const origin = url.value === null ? null : parseOrigin(url.value.trim());
    if (url.value === null || origin === null) return EMPTY;
    const refs = await query(repo, FOR_EACH_REF, signal, () => false);
    if (!refs.ok) return refs.outcome;
    const config = await query(repo, CONFIG, signal, (code) => code === 1);
    if (!config.ok) return config.outcome;
    const asked = originBranches(worktrees, refs.value ?? '', config.value ?? '');
    if (asked === null) return { ok: false, failure: 'invalid-response' };
    const branches = [...new Set(asked.values())];
    if (branches.length === 0) return EMPTY;
    const host = await hostOf(url.value.trim(), origin, repo, signal);
    if (!host.ok) return host.outcome;
    const answer = await ask(repo, host.value, JSON.stringify(buildQuery(origin.owner, origin.name, branches)), signal);
    if (!answer.ok) return answer.outcome;
    const parsed = response.safeParse(answer.value);
    if (!parsed.success) return { ok: false, failure: 'invalid-response' };
    const chosen = pickPrs(parsed.data.data.repository, branches);
    const prs = chosen === null ? null : statusesOf(asked, chosen);
    return prs === null ? { ok: false, failure: 'invalid-response' } : { ok: true, prs };
  };
};
