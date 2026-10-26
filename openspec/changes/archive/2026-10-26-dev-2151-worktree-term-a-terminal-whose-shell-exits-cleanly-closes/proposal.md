## Why

A terminal whose shell or program exits cleanly (`exit`, Ctrl-D, `/exit` in an agent) stays as a dead "(exited)" tab that the user must close by hand, although leaving was the user's own choice. Only a failed exit carries information worth keeping on screen.

## What Changes

- A terminal whose process exits with code 0 and no signal is closed by the daemon itself, whatever its preset: after its last output is offered it leaves its worktree's layout and every watcher receives `termClosed`; no `termExited` is sent.
- A failed exit (non-zero code or a signal) keeps today's behaviour: `termExited`, the tab stays with its failed mark and readable screen until the user closes it.
- The daemon ends terminals through one closing path shared by `closeTerm`, worktree removal and a clean exit.
- A clean exit no longer sets `unseen` of its own.
- `DAEMON_PROTOCOL_VERSION` rises from 6 to 7, so a daemon still running the old behaviour shows as `outdated` and can be restarted from the page.
- The web drops the plain "exited" attention mark: any exit the page is told about is a failure.
- When the shown worktree's last terminal closes and the keyboard focus is left on the page body, the "Start a terminal" choices take the focus.
- The red worktree-deletion dialog border is unchanged.

## Capabilities

### New Capabilities

### Modified Capabilities
- `daemon`: Terminal lifetime (clean exit closes the terminal), Activity (no `unseen` from a clean exit), Persistence and pruning (pruning after a clean exit).
- `protocol`: Protocol version raised to 7 for the daemon link.
- `hub`: the newer-daemon restart scenario stops naming fixed versions.
- `web`: Terminal tabs (exited tab means a failed exit; clean exit drops the tab; choices take the focus), Pane focus, Closing terminals, Attention indicators (no plain "exited" mark).

## Impact

- `src/daemon/server/daemon.ts` (one retire path; clean-exit handling), `src/daemon/terminals/terminal.ts` (unseen only on a failed exit).
- `src/protocol/constants.ts`, `src/protocol/wire.golden.json`, version strings in CLI and install tests.
- `src/web/ui/marks.ts`, `src/web/ui/app.tsx`, `src/web/ui/view.ts`, `src/web/main/styles.css`, `test/e2e/contract.ts`.
- Upgrading `wtd` marks running daemons `outdated`; restarting one ends its terminals, as the existing restart flow states.
