import { z } from 'zod';
import { ProtocolError } from './errors.js';
import { layout } from './layout.js';
import {
  depth,
  errorCode,
  errorMessage,
  head,
  hostIdx,
  instance,
  longText,
  MAX_DISCOVERED,
  MAX_ENTRIES,
  MAX_HOST_REPOS,
  MAX_HOSTS,
  MAX_PRESETS,
  MAX_ROOTS,
  MAX_VISIBLE,
  name,
  offset,
  path,
  presetCommand,
  presetName,
  req,
  secret,
  signal,
  size,
  termId,
  version,
} from './values.js';

const message = <T extends string, S extends z.core.$ZodLooseShape>(t: T, shape: S) => z.strictObject({ t: z.literal(t), ...shape });

// Frozen in every protocol version.
const hello = message('hello', { protocol: z.int().min(1), version, instance });
const shutdown = message('shutdown', {});

const worktree = z.strictObject({
  path,
  head,
  branch: longText,
  detached: z.boolean(),
  locked: z.boolean(),
  prunable: z.boolean(),
  bare: z.boolean(),
  main: z.boolean(),
});

const attentionState = z.enum(['working', 'idle', 'input']);

const terminal = z.strictObject({
  termId,
  worktree: path,
  preset: name,
  cols: size,
  rows: size,
  exit: z.strictObject({ code: z.int(), signal }).nullable(),
  unseen: z.boolean(),
  state: attentionState,
});

const repos = z.array(path).max(MAX_DISCOVERED);

export const preset = z.strictObject({ name: presetName, command: presetCommand });

const daemonRequests = [
  message('watchRepo', { req, repo: path }),
  message('unwatchRepo', { req, repo: path }),
  message('discoverRepos', { req, roots: z.array(path).min(1).max(MAX_ROOTS), depth }),
  message('createTerm', { req, worktree: path, preset: name, command: longText, cols: size, rows: size }),
  message('attach', { req, termId }),
  message('detach', { req, termId }),
  message('resize', { termId, cols: size, rows: size }),
  message('closeTerm', { req, termId }),
  message('ack', { termId, offset }),
  message('setVisible', { termIds: z.array(termId).max(MAX_VISIBLE) }),
  message('setChecked', { req, worktree: path, checked: z.boolean() }),
  message('setLayout', { req, worktree: path, layout }),
] as const;

const daemonEvents = [
  message('done', { req }),
  message('error', { req: req.nullable(), code: errorCode, message: errorMessage }),
  message('repoState', {
    repo: path,
    worktrees: z.array(worktree).max(MAX_ENTRIES),
    terminals: z.array(terminal).max(MAX_ENTRIES),
    checked: z.array(path).max(MAX_ENTRIES),
    layouts: z.array(z.strictObject({ worktree: path, layout })).max(MAX_ENTRIES),
  }),
  message('worktreesChanged', { repo: path, worktrees: z.array(worktree).max(MAX_ENTRIES) }),
  message('termCreated', { req: req.nullable(), term: terminal }),
  message('termExited', { termId, code: z.int(), signal }),
  message('termClosed', { termId }),
  message('detached', { termId, reason: z.literal('lagging') }),
  message('activity', { termId, unseen: z.boolean(), state: attentionState }),
  message('checkedChanged', { worktree: path, checked: z.boolean() }),
  message('layoutChanged', { worktree: path, layout }),
  message('reposDiscovered', { req, repos }),
] as const;

const hostEntry = z.strictObject({
  idx: hostIdx,
  name,
  remote: z.boolean(),
  status: z.enum(['connecting', 'connected', 'reconnecting', 'down', 'outdated']),
  daemonVersion: version.nullable(),
  instance: instance.nullable(),
  repos: z.array(path).max(MAX_HOST_REPOS),
});

export const messageSchemas = {
  clientToDaemon: z.discriminatedUnion('t', [hello, shutdown, ...daemonRequests]),
  daemonToClient: z.discriminatedUnion('t', [hello, ...daemonEvents]),
  browserToHub: z.discriminatedUnion('t', [
    hello,
    message('host', { host: hostIdx, m: z.discriminatedUnion('t', daemonRequests) }),
    message('addRepo', { req, host: hostIdx, repo: path }),
    message('removeRepo', { req, host: hostIdx, repo: path }),
    message('discoverRepos', { req, host: hostIdx }),
    message('restartDaemon', { req, host: hostIdx }),
    message('reinstallDaemon', { req, host: hostIdx }),
  ]),
  hubToBrowser: z.discriminatedUnion('t', [
    hello,
    message('token', { token: secret }),
    message('host', { host: hostIdx, m: z.discriminatedUnion('t', daemonEvents) }),
    message('hosts', { hosts: z.array(hostEntry).max(MAX_HOSTS) }),
    message('presets', { presets: z.array(preset).max(MAX_PRESETS) }),
    message('done', { req }),
    message('error', { req: req.nullable(), host: hostIdx.nullable(), code: errorCode, message: errorMessage }),
    message('reposDiscovered', { req, host: hostIdx, repos }),
  ]),
};

/** Who sends to whom: daemon link (client ↔ daemon) or browser link (browser ↔ hub). */
export type Direction = keyof typeof messageSchemas;

export type MessageOf<D extends Direction> = z.infer<(typeof messageSchemas)[D]>;

export type Worktree = z.infer<typeof worktree>;
export type HostEntry = z.infer<typeof hostEntry>;
export type Terminal = z.infer<typeof terminal>;
export type AttentionState = z.infer<typeof attentionState>;
export type Preset = z.infer<typeof preset>;

// No valid message nests deeper; checked before parsing so hostile nesting cannot exhaust the stack.
const MAX_NESTING = 32;

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const nestingOf = (text: string): number => {
  let level = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') max = Math.max(max, ++level);
    else if (c === '}' || c === ']') level--;
  }
  return max;
};

const parseJson = (text: string): unknown => {
  if (nestingOf(text) > MAX_NESTING) throw new ProtocolError('message nests too deep');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ProtocolError('invalid JSON', { cause: error });
  }
};

const toText = (data: string | Uint8Array): string => {
  if (typeof data === 'string') return data;
  try {
    return utf8.decode(data);
  } catch (error) {
    throw new ProtocolError('invalid UTF-8', { cause: error });
  }
};

function validate<D extends Direction>(dir: D, value: unknown): MessageOf<D>;
function validate(dir: Direction, value: unknown): MessageOf<Direction> {
  const result = messageSchemas[dir].safeParse(value);
  if (!result.success) throw new ProtocolError(`invalid ${dir} message: ${z.prettifyError(result.error)}`);
  return result.data;
}

/** Decodes one control message of direction `dir` from JSON text or UTF-8 bytes. */
export const decodeMessage = <D extends Direction>(dir: D, data: string | Uint8Array): MessageOf<D> =>
  validate(dir, parseJson(toText(data)));

/** Encodes a control message of direction `dir` as JSON text; refuses values that would not decode. */
export const encodeMessage = <D extends Direction>(dir: D, msg: MessageOf<D>): string => JSON.stringify(validate(dir, msg));

const codeResponse = z.strictObject({ code: secret });

export type CodeResponse = z.infer<typeof codeResponse>;

const parseCodeResponse = (value: unknown): CodeResponse => {
  const result = codeResponse.safeParse(value);
  if (!result.success) throw new ProtocolError(`invalid code response: ${z.prettifyError(result.error)}`);
  return result.data;
};

/** Decodes the hub's one-time code response from JSON text or UTF-8 bytes. */
export const decodeCodeResponse = (data: string | Uint8Array): CodeResponse => parseCodeResponse(parseJson(toText(data)));

/** Encodes a one-time code response; refuses values that would not decode. */
export const encodeCodeResponse = (response: CodeResponse): string => JSON.stringify(parseCodeResponse(response));
