import { describe, expect, it } from 'vitest';
import { DAEMON_PROTOCOL_VERSION } from '../../protocol/index.js';
import { hostTransition, initialHostState, localHostName, retryDelay, type HostEvent, type HostState } from './hosts.js';

const hello = (protocol: number, instance = 'd_1'): HostEvent => ({ kind: 'hello', protocol, version: '9.9.9', instance });
const failed: HostEvent = { kind: 'failed', reason: 'ssh: connect to host box port 22: Connection refused' };
const failedWith = (reason: string): HostEvent => ({ kind: 'failed', reason });
const LOGIN_URL = 'https://login.tailscale.com/a/abc123';
const login = (url = LOGIN_URL): HostEvent => ({ kind: 'login', url });
const redial: HostEvent = { kind: 'redial' };

const run = (...events: HostEvent[]): HostState => events.reduce(hostTransition, initialHostState);

describe('host status', () => {
  it('starts connecting with no daemon', () => {
    expect(initialHostState).toEqual({ status: 'connecting', reason: null, daemonVersion: null, instance: null, login: null, failures: 0 });
  });

  it('is connected to a daemon speaking our protocol', () => {
    expect(run(hello(DAEMON_PROTOCOL_VERSION))).toEqual({
      status: 'connected',
      reason: null,
      daemonVersion: '9.9.9',
      instance: 'd_1',
      login: null,
      failures: 0,
    });
  });

  it('is outdated for a daemon speaking another protocol, keeping its instance', () => {
    expect(run(hello(DAEMON_PROTOCOL_VERSION + 1))).toEqual({
      status: 'outdated',
      reason: null,
      daemonVersion: '9.9.9',
      instance: 'd_1',
      login: null,
      failures: 0,
    });
    expect(run(hello(1, 'old_7'))).toMatchObject({ status: 'outdated', instance: 'old_7' });
  });

  it('names the latest failure as the reason while reconnecting and down', () => {
    expect(run(failedWith('first')).reason).toBe('first');
    expect(run(failedWith('first'), failedWith('second')).reason).toBe('second');
    expect(run(failedWith('a'), failedWith('b'), failedWith('ssh: Could not resolve hostname box'))).toMatchObject({
      status: 'down',
      reason: 'ssh: Could not resolve hostname box',
    });
  });

  it('clears the reason on a hello', () => {
    expect(run(failed, hello(DAEMON_PROTOCOL_VERSION)).reason).toBeNull();
    expect(run(failed, hello(1)).reason).toBeNull();
  });

  it('cuts a reason to 1024 characters', () => {
    expect(run(failedWith('r'.repeat(5000))).reason).toBe('r'.repeat(1024));
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
    ['connected', hello(DAEMON_PROTOCOL_VERSION)],
    ['outdated', hello(DAEMON_PROTOCOL_VERSION + 1)],
  ])('drops the instance when a %s link is lost', (_name, event) => {
    const lost = run(event, failed);
    expect(lost.status).toBe('reconnecting');
    expect(lost.instance).toBeNull();
  });

  it('resets the failure count on a hello', () => {
    const recovered = run(failed, failed, failed, hello(DAEMON_PROTOCOL_VERSION, 'd_2'));
    expect(recovered).toEqual({ status: 'connected', reason: null, daemonVersion: '9.9.9', instance: 'd_2', login: null, failures: 0 });
    expect(hostTransition(recovered, failed)).toMatchObject({ status: 'reconnecting', failures: 1 });
  });

  it('does not change the state it is given', () => {
    const state: HostState = { ...initialHostState };
    hostTransition(state, failed);
    expect(state).toEqual(initialHostState);
  });
});

describe('Tailscale login', () => {
  it('needs login while connecting, with the URL and no reason, daemon or instance', () => {
    expect(run(login())).toEqual({
      status: 'needs-login',
      reason: null,
      daemonVersion: null,
      instance: null,
      login: LOGIN_URL,
      failures: 0,
    });
  });

  it('goes from connecting through needs-login to connected', () => {
    expect(run(login(), hello(DAEMON_PROTOCOL_VERSION))).toEqual({
      status: 'connected',
      reason: null,
      daemonVersion: '9.9.9',
      instance: 'd_1',
      login: null,
      failures: 0,
    });
  });

  it('becomes outdated with a null login when the daemon speaks another protocol', () => {
    expect(run(login(), hello(DAEMON_PROTOCOL_VERSION + 1))).toMatchObject({ status: 'outdated', login: null });
  });

  it.each([
    ['reconnecting', [failed], 1],
    ['down', [failed, failed, failed], 3],
  ] as const)('needs login from %s, keeping the failure count', (_name, before, failures) => {
    expect(run(...before, login())).toEqual({
      status: 'needs-login',
      reason: null,
      daemonVersion: null,
      instance: null,
      login: LOGIN_URL,
      failures,
    });
  });

  it('continues the failure count when a needs-login link is lost', () => {
    expect(run(login(), failedWith('Tailscale SSH check timed out'))).toEqual({
      status: 'reconnecting',
      reason: 'Tailscale SSH check timed out',
      daemonVersion: null,
      instance: null,
      login: null,
      failures: 1,
    });
    expect(run(failed, failed, login(), failed)).toMatchObject({ status: 'down', failures: 3, login: null });
  });

  it('takes a new URL while needing login', () => {
    expect(run(login(), login('https://login.tailscale.com/a/next')).login).toBe('https://login.tailscale.com/a/next');
  });

  it('is connecting with a null login after a redial, keeping the failure count', () => {
    expect(run(failed, login(), redial)).toEqual({
      status: 'connecting',
      reason: null,
      daemonVersion: null,
      instance: null,
      login: null,
      failures: 1,
    });
  });

  it('has a null login in every status but needs-login', () => {
    const states = [
      run(login(), hello(DAEMON_PROTOCOL_VERSION)),
      run(login(), hello(1)),
      run(login(), failed),
      run(failed, failed, login(), failed),
      run(login(), redial),
    ];
    for (const state of states) {
      expect(state.status).not.toBe('needs-login');
      expect(state.login).toBeNull();
    }
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
