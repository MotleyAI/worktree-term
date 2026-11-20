## Context

- `src/web/ui/sidebar.ts`: `WorktreeFilter = 'all' | 'checked'`; `visibleWorktrees` and `defaultWorktree` take it; `SidebarEntry` carries no terminal information, although `sidebarEntries` already receives the repo's terminals.
- `src/web/ui/view.ts`: the per-repo filter is stored under `wtd.filters` as `'checked'`; `worktree` is computed as the stored selection if it is an entry, else `defaultWorktree(entries, filter)` — re-derived on every data change, so terminal or checked changes move a selection the user never made (the structural cause behind the "Selection" delta; it already breaks the existing "Selected worktree stays listed" scenario when no selection is stored).
- `repoState` delivers a repo's worktrees and terminals together; `termCreated` / `termClosed` are broadcast to every page.

## Goals / Non-Goals

**Goals:**
- One predicate decides what the switches show, used by both the listing and the default selection.
- Terminal presence is computed once per entry, independent of marks.
- A derived default selection only moves on user action or when its worktree is no longer an entry.

**Non-Goals:**
- No wire, protocol, daemon, hub or architecture model changes.
- No change to how explicit selections are stored.
- No storage write for a derived default.

## Architecture

- Element `typescript.web` (component `ui`, plus `main` for styles); spec `web` stays attached to `typescript.web`. No model, arc42 or `index.yaml` edits; imports stay within existing arrows.
- Principles that apply: web 1 (no Node APIs; `sidebar.ts` stays pure), web 2 (no wire change), web 5 (switching and filtering perform no network round trip); system 1–4 (model arrows, `index.ts` entry points, allowlist, strict types and lint), system 5 (stored values: `loadRecord` validates the object shape and string values, and any `wtd.openFilters` value other than `'open'` reads as off), system 6, system 8 (unit beside the code, e2e in `test/e2e`).

## Decisions

1. **Label "Open"** — over "Terminals" (long; reads as "show terminals") and "In use" (suggests activity; new vocabulary). "Open" matches the ring's `open: <n>` hover text and is short. (user)
2. **Derived default selection is held in memory per repo** — once derived (non-null) it is kept until the user toggles a filter switch of that repo or the worktree is no longer an entry; explicit selections are stored as today; nothing new is written to storage, so after a reload the default is re-derived. Rejected: storing the derived default as the repo's selection — indistinguishable from a click, so toggling a switch could no longer re-derive (the issue's "first one the filters show … as today"), and it writes storage on page load. (user)
3. **Open is stored under a new key `wtd.openFilters`** (repo key → `'open'`; off drops the entry); `wtd.filters` (`'checked'`) is untouched. Rejected: a combined encoding in `wtd.filters`, which an older bundle would read as "all", losing a stored "starred only". (default)
4. **Filter model** — `WorktreeFilter` becomes `{ checked: boolean; open: boolean }` with one predicate shared by `visibleWorktrees` and `defaultWorktree`; `SidebarEntry` gains `hasTerminals`, computed in `sidebarEntries` from one `Set` of terminal worktree paths. (default)
5. **On colour** — CSS tokens `--open: #b392f0` (knob), track `#4a3870`, border `#7d5bc4`: violet, distinct from the star's gold, the mark colours (`#e5c07b`, `--danger`, `#23d18b`, `#3b8eea`) and the accent blue (too close to new-output blue). (default)
6. **Narrow header** — both switches sit in one wrapping group; labels and switches never shrink, so at 160 px each is wholly visible and clickable on its own row if needed. (default)
7. **Spec shape** — "Checked filter" is renamed "Worktree filters" and covers both switches, rather than a second requirement cross-referencing the first. (default)
8. **Selection wording is observable** — the "Selection" delta states when a default is (re-)derived and that it is otherwise kept, without naming the mechanism; re-deriving on a switch toggle stays, per decision 2. (codex) Rejected part: Codex proposed never re-deriving on a switch toggle; this contradicts the issue ("the first one the filters show … as today") and decision 2. (rejected (codex))
9. **Held default is replaced immutably** — the per-repo held defaults are a signal replaced with a new record on every change, never mutated in place, so dependents recompute; tests drive it through terminal and checked updates, not only direct calls. (codex)
10. **Cross-page tests are distinct** — one e2e test creates a terminal from a second page and sees the hidden worktree listed on the first; another closes the last terminal from a second page and sees a non-selected worktree leave. (codex)
11. **Gone selected entry** — a selected gone worktree leaves when its last terminal closes (it is no longer an entry), and the default is re-derived; scenario and test added beside the normal "stays listed" case. (codex)
12. **Terminal-state coverage** — unit tests show `hasTerminals` is true for input, working, idle+unseen, idle+seen and failed-exited terminals: presence only, never `aggregate`, `ringTitle`, `exit` or "running". (codex)
13. **Legacy persistence tests** — a preloaded `wtd.filters` alone keeps "Starred" on after reload with "Open" off; malformed or unknown `wtd.openFilters` values read as off. (codex)
14. **Animation keyed per input** — each switch's `<input>` is keyed by repo itself, not via the wrapping group; the no-transition-on-repo-switch, click-animates and reduced-motion checks cover both switches. (codex)
15. **160 px test asserts geometry and clicks** — both inputs have non-zero bounding boxes wholly inside the sidebar, and each toggles on click. (codex)
16. **Colour is a named token, tested** — the checked "Open" knob's computed colour differs from `--star`, `--danger`, `#e5c07b`, `#23d18b` and `#3b8eea`. (codex)
17. **Naming** — the entry field is `hasTerminals`; "Open" is only the user-facing label. (codex)
18. **One Set in `sidebarEntries`** — terminal presence is derived from one `Set` of terminal worktree paths. (codex)
19. **Presence, not mark** — "Worktree filters" states Open goes by terminal presence (mark *or* ring), so a viewed failed terminal still counts. (codex)
20. **System principle 5 note** — stored-value validation is stated precisely: `loadRecord` validates shape and string values; unknown Open values read as off. (codex)

## Risks / Trade-offs

- [The held default could survive a filter change the user expects to re-derive it] → it is cleared on every switch toggle of that repo; tests cover toggle re-derive.
- [Header grows up to four rows at 160 px] → accepted by the issue ("the header may wrap"); e2e asserts usability.
- [Existing unit tests pin the `'all' | 'checked'` filter shape (`sidebar.test.ts` "repo filters", `visibleWorktrees`, `defaultWorktree`)] → aligned in pr-tests after approval.
