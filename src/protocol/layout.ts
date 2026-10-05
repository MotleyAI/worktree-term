import { z } from 'zod';
import { name, termId } from './values.js';

const MAX_TABS = 64;
const MAX_DEPTH = 16;

const termPane = z.strictObject({ term: termId });

const splitPane = z.strictObject({
  split: z.enum(['right', 'down']),
  ratio: z.number().min(0.05).max(0.95),
  get a() {
    return pane;
  },
  get b() {
    return pane;
  },
});

const pane = z.union([termPane, splitPane]);

type Pane = z.infer<typeof pane>;

const depthOf = (p: Pane): number => ('term' in p ? 1 : 1 + Math.max(depthOf(p.a), depthOf(p.b)));

const termsOf = (p: Pane): number[] => ('term' in p ? [p.term] : [...termsOf(p.a), ...termsOf(p.b)]);

const distinct = (values: readonly unknown[]): boolean => new Set(values).size === values.length;

export const layout = z
  .strictObject({
    tabs: z.array(z.strictObject({ id: name, root: pane })).max(MAX_TABS),
    active: z.int().min(0),
  })
  .refine((l) => l.active < Math.max(l.tabs.length, 1), 'active must index a tab, or be 0 without tabs')
  .refine((l) => distinct(l.tabs.map((t) => t.id)), 'tab ids must be unique')
  .refine((l) => l.tabs.every((t) => depthOf(t.root) <= MAX_DEPTH), `panes nest at most ${String(MAX_DEPTH)} levels deep`)
  .refine((l) => distinct(l.tabs.flatMap((t) => termsOf(t.root))), 'a terminal appears at most once');
