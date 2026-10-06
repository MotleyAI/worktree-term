import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import frozenJson from './frozen.golden.json' with { type: 'json' };
import wireJson from './wire.golden.json' with { type: 'json' };
import {
  ACK_EVERY,
  decodeMessage,
  encodeFrame,
  FLOW_HIGH,
  FLOW_LOW,
  LAG_EVICT_MS,
  MAX_FRAME,
  MAX_INPUT,
  messageSchemas,
  PROTOCOL_VERSION,
  ProtocolError,
  StreamDecoder,
  type Direction,
  type Frame,
} from './index.js';
import { DIRECTIONS, featWorktree, hello, layout, raw, REPO, samples, WT } from './test-samples.js';

const directionSchema = z.enum(['clientToDaemon', 'daemonToClient', 'browserToHub', 'hubToBrowser']);

const snapshotSchema = z.object({
  protocolVersion: z.number(),
  constants: z.record(z.string(), z.number()),
  schemas: z.record(z.string(), z.unknown()),
  corpus: z.array(z.object({ dir: directionSchema, json: z.string(), valid: z.boolean() })),
});
const previousSchema = snapshotSchema.partial();

type WireSnapshot = z.infer<typeof snapshotSchema>;
type PreviousSnapshot = z.infer<typeof previousSchema>;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const key = (entry: { dir: string; json: string }): string => `${entry.dir} ${entry.json}`;

/** Wire changes between two goldens that a missing PROTOCOL_VERSION bump makes illegal. */
const wireViolations = (previous: PreviousSnapshot, current: WireSnapshot): string[] => {
  if (previous.protocolVersion === undefined) return [];
  if (current.protocolVersion < previous.protocolVersion) return ['PROTOCOL_VERSION decreased'];
  if (current.protocolVersion > previous.protocolVersion) return [];
  const violations: string[] = [];
  if (!same(previous.constants, current.constants)) violations.push('constants changed');
  const schemaDirs = new Set([...Object.keys(previous.schemas ?? {}), ...Object.keys(current.schemas)]);
  for (const dir of schemaDirs) {
    if (!same(previous.schemas?.[dir], current.schemas[dir])) violations.push(`schema ${dir} changed`);
  }
  const now = new Map(current.corpus.map((entry) => [key(entry), entry.valid]));
  for (const entry of previous.corpus ?? []) {
    const valid = now.get(key(entry));
    if (valid === undefined) violations.push(`corpus entry removed: ${key(entry)}`);
    else if (valid !== entry.valid) violations.push(`verdict changed: ${key(entry)}`);
  }
  return violations;
};

const decodes = (dir: Direction, json: string): boolean => {
  try {
    decodeMessage(dir, json);
    return true;
  } catch (error) {
    if (!(error instanceof ProtocolError)) throw error;
    return false;
  }
};

const EDGE_CASES: readonly unknown[] = [
  { t: 'attach', req: 1, termId: 1, x: 1 },
  { t: 'attach', req: 1 },
  { t: 'resize', termId: 1, cols: '80', rows: 24 },
  { t: 'resize', termId: 1, cols: 0, rows: 24 },
  { t: 'resize', termId: 1, cols: 1001, rows: 24 },
  { t: 'resize', req: 1, termId: 1, cols: 80, rows: 24 },
  { t: 'closeTerm', termId: 1 },
  { t: 'ack', req: 1, termId: 1, offset: 0 },
  { t: 'ack', termId: 1, offset: 2 ** 53 },
  { t: 'attach', req: 0, termId: 1 },
  { t: 'attach', req: 1, termId: 4294967296 },
  { t: 'watchRepo', req: 1, repo: 'repo/a' },
  { t: 'watchRepo', req: 1, repo: '/a\u0000b' },
  { t: 'watchRepo', req: 1, repo: '/' + 'a'.repeat(4096) },
  { t: 'discoverRepos', req: 1, roots: [], depth: 1 },
  { t: 'discoverRepos', req: 1, roots: ['/a'], depth: 7 },
  { t: 'detached', termId: 1, reason: 'closed' },
  { t: 'error', req: 1, code: 'oops', message: 'x' },
  { t: 'error', req: 1, code: 'internal', message: 'm'.repeat(1025) },
  { t: 'termExited', termId: 1, code: 0, signal: 'S'.repeat(33) },
  { t: 'worktreesChanged', repo: REPO, worktrees: [{ ...featWorktree, head: 'A'.repeat(40) }] },
  { t: 'worktreesChanged', repo: REPO, worktrees: [{ ...featWorktree, branch: 'b'.repeat(4097) }] },
  { t: 'createTerm', req: 1, worktree: WT, preset: '', command: null, cols: 80, rows: 24 },
  { t: 'setLayout', req: 1, worktree: WT, layout: { tabs: [], active: 1 } },
  { t: 'setLayout', req: 1, worktree: WT, layout: { ...layout, active: 2 } },
  {
    t: 'setLayout',
    req: 1,
    worktree: WT,
    layout: { tabs: [{ id: 'a', root: { split: 'right', ratio: 0.5, a: { term: 5 }, b: { term: 5 } } }], active: 0 },
  },
  {
    t: 'setLayout',
    req: 1,
    worktree: WT,
    layout: { tabs: [{ id: 'a', root: { split: 'right', ratio: 0.96, a: { term: 1 }, b: { term: 2 } } }], active: 0 },
  },
  { t: 'host', host: 0, m: hello },
  { t: 'host', host: 0, m: { t: 'shutdown' } },
  { t: 'host', host: 65536, m: { t: 'detach', req: 1, termId: 1 } },
  { t: 'hosts', hosts: [{ idx: 0, name: 'local', remote: false, status: 'up', daemonVersion: null, repos: [] }] },
  { t: 'error', req: null, code: 'internal', message: 'x', host: 1 },
  { t: 'error', req: 1, host: 0, code: 'host-unavailable', message: 'x' },
  { t: 'token', token: 'a'.repeat(63) },
  { t: 'token', token: 'A'.repeat(64) },
  { t: 'hosts', hosts: [{ idx: 0, name: 'local', remote: false, status: 'connected', daemonVersion: '0.1.0', repos: [] }] },
];

const allJson = [...new Set([...DIRECTIONS.flatMap((dir) => samples[dir].map((m) => raw(m))), ...EDGE_CASES.map((m) => raw(m))])];

const currentSnapshot = (): WireSnapshot => ({
  protocolVersion: PROTOCOL_VERSION,
  constants: { MAX_FRAME, MAX_INPUT, FLOW_HIGH, FLOW_LOW, ACK_EVERY, LAG_EVICT_MS },
  schemas: Object.fromEntries(DIRECTIONS.map((dir) => [dir, z.toJSONSchema(messageSchemas[dir])])),
  corpus: DIRECTIONS.flatMap((dir) => allJson.map((json) => ({ dir, json, valid: decodes(dir, json) }))),
});

describe('wire golden guard', () => {
  const base: WireSnapshot = {
    protocolVersion: 3,
    constants: { MAX_FRAME: 1 },
    schemas: { clientToDaemon: { type: 'object' } },
    corpus: [{ dir: 'clientToDaemon', json: '{"t":"shutdown"}', valid: true }],
  };

  it('allows an identical golden', () => {
    expect(wireViolations(base, base)).toEqual([]);
  });

  it('allows a first golden', () => {
    expect(wireViolations({}, base)).toEqual([]);
  });

  it('flags a schema change without a version bump', () => {
    expect(wireViolations(base, { ...base, schemas: { clientToDaemon: { type: 'array' } } })).toEqual(['schema clientToDaemon changed']);
  });

  it('flags a new message union without a version bump', () => {
    expect(wireViolations(base, { ...base, schemas: { ...base.schemas, hubToBrowser: {} } })).toEqual(['schema hubToBrowser changed']);
  });

  it('flags a constant change without a version bump', () => {
    expect(wireViolations(base, { ...base, constants: { MAX_FRAME: 2 } })).toEqual(['constants changed']);
  });

  it('flags a flipped verdict without a version bump', () => {
    expect(wireViolations(base, { ...base, corpus: [{ dir: 'clientToDaemon', json: '{"t":"shutdown"}', valid: false }] })).toEqual([
      'verdict changed: clientToDaemon {"t":"shutdown"}',
    ]);
  });

  it('flags a removed corpus entry', () => {
    expect(wireViolations(base, { ...base, corpus: [] })).toEqual(['corpus entry removed: clientToDaemon {"t":"shutdown"}']);
  });

  it('allows an added corpus entry', () => {
    const added = { dir: 'daemonToClient' as const, json: '{"t":"shutdown"}', valid: false };
    expect(wireViolations(base, { ...base, corpus: [...base.corpus, added] })).toEqual([]);
  });

  it('allows any change with a version bump', () => {
    expect(wireViolations(base, { protocolVersion: 4, constants: {}, schemas: {}, corpus: [] })).toEqual([]);
  });

  it('flags a version decrease', () => {
    expect(wireViolations(base, { ...base, protocolVersion: 2 })).toEqual(['PROTOCOL_VERSION decreased']);
  });
});

describe('wire golden', () => {
  // Regenerate with `vitest run -u` only together with a PROTOCOL_VERSION bump.
  it('matches src/protocol/wire.golden.json unless PROTOCOL_VERSION was bumped', async () => {
    const current = currentSnapshot();
    expect(wireViolations(previousSchema.parse(wireJson), current)).toEqual([]);
    await expect(JSON.stringify(current, null, 2) + '\n').toMatchFileSnapshot('./wire.golden.json');
  });

  it('is blessed for protocol version 3', () => {
    expect(previousSchema.parse(wireJson).protocolVersion).toBe(3);
  });

  it('records every sample as valid in its own direction', () => {
    const corpus = currentSnapshot().corpus;
    for (const dir of DIRECTIONS) {
      for (const message of samples[dir]) {
        expect(corpus).toContainEqual({ dir, json: raw(message), valid: true });
      }
    }
  });
});

const frozenSchema = z.object({
  frames: z.array(z.object({ kind: z.number(), payload: z.string(), bytes: z.string() })),
  messages: z.array(z.object({ dirs: z.array(directionSchema), json: z.string(), valid: z.boolean() })),
});

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (text: string): Uint8Array =>
  Uint8Array.from({ length: text.length / 2 }, (_, i) => parseInt(text.slice(i * 2, i * 2 + 2), 16));

const frameKindSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);

describe('frozen handshake and frame header', () => {
  const frozen = frozenSchema.parse(frozenJson);

  it.each(frozen.frames)('encodes and decodes kind $kind with payload "$payload" as $bytes', ({ kind, payload, bytes }) => {
    const frame: Frame = { kind: frameKindSchema.parse(kind), payload: fromHex(payload) };
    expect(hex(encodeFrame(frame))).toBe(bytes);
    const decoder = new StreamDecoder();
    expect(decoder.push(fromHex(bytes))).toEqual([frame]);
    decoder.end();
  });

  it.each(frozen.messages)('decodes $json in $dirs: valid=$valid', ({ dirs, json, valid }) => {
    for (const dir of dirs) {
      expect(decodes(dir, json), dir).toBe(valid);
      const parsed: unknown = JSON.parse(json);
      if (valid) expect(decodeMessage(dir, json)).toEqual(parsed);
    }
  });
});
