import { describe, expect, it } from 'vitest';
import { PendingRequests } from './requests.js';

describe('PendingRequests', () => {
  it('numbers requests from 1 and delivers each reply to its request', async () => {
    const pending = new PendingRequests<string>();
    const a = pending.add(0);
    const b = pending.add(null);
    expect([a.req, b.req]).toEqual([1, 2]);
    expect(pending.resolve(2, 'two')).toBe(true);
    expect(pending.resolve(1, 'one')).toBe(true);
    expect(await a.reply).toBe('one');
    expect(await b.reply).toBe('two');
  });

  it('ignores a reply to an unknown or settled request', async () => {
    const pending = new PendingRequests<string>();
    const a = pending.add(0);
    expect(pending.resolve(1, 'x')).toBe(true);
    expect(pending.resolve(1, 'y')).toBe(false);
    expect(pending.resolve(7, 'z')).toBe(false);
    expect(await a.reply).toBe('x');
  });

  it('fails the pending requests of a host that left connected, and only those', async () => {
    const pending = new PendingRequests<string>();
    const host0 = pending.add(0);
    const host1 = pending.add(1);
    const hub = pending.add(null);
    pending.failHost(0, 'host 0 is reconnecting');
    await expect(host0.reply).rejects.toThrow('host 0 is reconnecting');
    pending.resolve(host1.req, 'one');
    pending.resolve(hub.req, 'hub');
    expect(await host1.reply).toBe('one');
    expect(await hub.reply).toBe('hub');
  });

  it('fails every pending request when the session closes', async () => {
    const pending = new PendingRequests<string>();
    const requests = [pending.add(0), pending.add(3), pending.add(null)];
    pending.failAll('session closed');
    for (const request of requests) await expect(request.reply).rejects.toThrow('session closed');
    expect(pending.resolve(1, 'late')).toBe(false);
  });

  it('keeps numbering after failures', () => {
    const pending = new PendingRequests<string>();
    void pending.add(0).reply.catch(() => undefined);
    pending.failAll('closed');
    expect(pending.add(0).req).toBe(2);
  });
});
