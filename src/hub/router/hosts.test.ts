import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../../protocol/index.js';
import { hostTransition, initialHostState, localHostName, retryDelay, type HostEvent, type HostState } from './hosts.js';

const hello = (protocol: number, instance = 'd_1'): HostEvent => ({ kind: 'hello', protocol, version: '9.9.9', instance });
const failed: HostEvent = { kind: 'failed' };

const run = (...events: HostEvent[]): HostState => events.reduce(hostTransition, initialHostState);

describe('host status', () => {
  it('starts connecting with no daemon', () => {
    expect(initialHostState).toEqual({ status: 'connecting', daemonVersion: null, instance: null, failures: 0 });
  });

  it('is connected to a daemon speaking our protocol', () => {
    expect(run(hello(PROTOCOL_VERSION))).toEqual({ status: 'connected', daemonVersion: '9.9.9', instance: 'd_1', failures: 0 });
  });

  it('is outdated for a daemon speaking another protocol, without an instance', () => {
    expect(run(hello(PROTOCOL_VERSION + 1))).toEqual({ status: 'outdated', daemonVersion: '9.9.9', instance: null, failures: 0 });
    expect(run(hello(1)).status).toBe('outdated');
  });

  it('is reconnecting after one or two consecutive failures and down after three', () => {
    expect(run(failed).status).toBe('reconnecting');
    expect(run(failed, failed).status).toBe('reconnecting');
    expect(run(failed, failed, failed).status).toBe('down');
    expect(run(failed, failed, failed, failed).status).toBe('down');
  });

  it('counts consecutive failures', () => {
    expect(run(failed, failed).failures).toBe(2);
  });

  it.each([
    ['connected', hello(PROTOCOL_VERSION)],
    ['outdated', hello(PROTOCOL_VERSION + 1)],
  ])('drops the instance when a %s link is lost', (_name, event) => {
    const lost = run(event, failed);
    expect(lost.status).toBe('reconnecting');
    expect(lost.instance).toBeNull();
  });

  it('resets the failure count on a hello', () => {
    const recovered = run(failed, failed, failed, hello(PROTOCOL_VERSION, 'd_2'));
    expect(recovered).toEqual({ status: 'connected', daemonVersion: '9.9.9', instance: 'd_2', failures: 0 });
    expect(hostTransition(recovered, failed)).toMatchObject({ status: 'reconnecting', failures: 1 });
  });

  it('does not change the state it is given', () => {
    const state: HostState = { ...initialHostState };
    hostTransition(state, failed);
    expect(state).toEqual(initialHostState);
  });
});

describe('retry delay', () => {
  it.each([
    [1, 250],
    [2, 500],
    [3, 1000],
    [4, 2000],
    [5, 4000],
    [6, 5000],
    [7, 5000],
    [50, 5000],
  ])('after %d failures is %d ms', (failures, delay) => {
    expect(retryDelay(failures)).toBe(delay);
  });
});

describe('local host name', () => {
  it.each([
    ['box', 'box'],
    ['', 'local'],
    ['h'.repeat(64), 'h'.repeat(64)],
    ['h'.repeat(100), 'h'.repeat(64)],
  ])('names host %j as %j', (raw, name) => {
    expect(localHostName(raw)).toBe(name);
  });
});
