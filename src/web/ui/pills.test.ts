import { describe, expect, it } from 'vitest';
import type { HostEntry } from '../../protocol/index.js';
import { cloneLabels, hostHue, rowPill, type PillHost } from './pills.js';

type Status = HostEntry['status'];

const laptop = (status: Status = 'connected'): PillHost => ({ idx: 0, name: 'laptop', remote: false, status });
const box = (status: Status = 'connected'): PillHost => ({ idx: 1, name: 'box', remote: true, status });

const member = (host: number, repo: string) => ({ host, repo });

/** A tab holding this machine's `/r/app` and `box`'s `/srv/app`. */
const ONE_EACH = [member(0, '/r/app'), member(1, '/srv/app')];
/** A tab holding two clones on `box` and two on this machine. */
const TWO_EACH = [member(0, '/r/app'), member(0, '/r/app-2'), member(1, '/srv/app'), member(1, '/srv/x/app')];

describe('hostHue', () => {
  it('derives a whole hue from the host name alone, the same on every call', () => {
    const hue = hostHue('box');
    expect(Number.isInteger(hue)).toBe(true);
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(360);
    expect(hostHue('box')).toBe(hue);
  });
});

describe('cloneLabels', () => {
  it('labels clones by directory name', () => {
    expect(cloneLabels(['/r/app', '/r/app-2'])).toEqual(['app', 'app-2']);
  });

  it('adds leading path segments until the labels are unique', () => {
    expect(cloneLabels(['/srv/app', '/srv/x/app'])).toEqual(['srv/app', 'x/app']);
  });

  it('labels a single clone by its directory name', () => {
    expect(cloneLabels(['/srv/app'])).toEqual(['app']);
  });
});

describe('rowPill', () => {
  it('shows no pill on the rows of a tab’s single local clone', () => {
    expect(rowPill(laptop(), '/r/app', ONE_EACH)).toBeNull();
    expect(rowPill(laptop(), '/r/app', [member(0, '/r/app')])).toBeNull();
  });

  it('shows the host’s name in its hue on a remote host’s rows', () => {
    expect(rowPill(box(), '/srv/app', ONE_EACH)).toEqual({
      text: 'box',
      hue: hostHue('box'),
      muted: false,
      look: 'normal',
      title: 'box: connected',
    });
  });

  it('adds the clone to the host’s name when the tab holds several clones on that host', () => {
    expect(rowPill(box(), '/srv/app', TWO_EACH)?.text).toBe('box · srv/app');
    expect(rowPill(box(), '/srv/x/app', TWO_EACH)?.text).toBe('box · x/app');
  });

  it('shows a muted pill naming the clone when the tab holds several local clones', () => {
    expect(rowPill(laptop(), '/r/app', TWO_EACH)).toMatchObject({ text: 'app', muted: true });
    expect(rowPill(laptop(), '/r/app-2', TWO_EACH)).toMatchObject({ text: 'app-2', muted: true });
  });

  it('labels clones only among those of the row’s host', () => {
    const tab = [member(0, '/r/app'), member(1, '/srv/app'), member(1, '/srv/app-2')];
    expect(rowPill(box(), '/srv/app', tab)?.text).toBe('box · app');
  });

  it('colours a host’s pills the same in every tab and whatever its status', () => {
    const hues = [rowPill(box(), '/srv/app', ONE_EACH)?.hue, rowPill(box('down'), '/srv/x/app', TWO_EACH)?.hue];
    expect(hues).toEqual([hostHue('box'), hostHue('box')]);
  });

  it.each<[Status, 'normal' | 'dimmed' | 'error', string]>([
    ['connected', 'normal', 'box: connected'],
    ['connecting', 'dimmed', 'box: connecting'],
    ['reconnecting', 'dimmed', 'box: reconnecting'],
    ['down', 'error', 'box: down'],
    ['outdated', 'error', 'box: outdated'],
    ['needs-login', 'error', 'box: needs login'],
  ])('shows a %s host’s pill as %s, its hover giving the host and status', (status, look, title) => {
    expect(rowPill(box(status), '/srv/app', ONE_EACH)).toMatchObject({ look, title });
  });

  it('shows this machine’s status on a local clone pill', () => {
    expect(rowPill(laptop('outdated'), '/r/app', TWO_EACH)).toMatchObject({ look: 'error', title: 'laptop: outdated' });
  });
});
