## 1. Tests first (pr-tests)

- [x] 1.1 Daemon unit tests in `src/daemon/server/daemon.test.ts`: clean exit retires (layoutChanged then termClosed, no termExited, absent from a later repoState), failed exit and signal exit keep the terminal with termExited, clean exit with a failing layout write still sends termClosed and reports, `removeWorktree` of a worktree with two terminals writes its layout once; verify they fail before implementation
- [x] 1.2 Terminal unit test in `src/daemon/terminals/terminal.test.ts`: a hidden clean exit without further output reports no unseen activity, a hidden failed exit does; verify they fail before implementation
- [x] 1.3 Process tests: `test/process/daemon-terminals-lifecycle.test.ts` (clean exit closes, `exit 3` reported, killed by SIGTERM stays, removed worktree pruned after a clean exit), `test/process/daemon-terminals-output.test.ts` (1 MiB burst then code 1 before termExited, code 0 before termClosed), `test/process/daemon-terminals-unseen.test.ts` (Exit while hidden with code 1; Clean exit while hidden); verify the new ones fail before implementation
- [x] 1.4 Protocol tests: `src/protocol/constants.test.ts` / `wire.golden.test.ts` expect daemon protocol 7, `src/protocol/messages.test.ts` hello sample uses protocol 8; version strings `daemon protocol 7` in `src/cli/run.test.ts`, `test/process/cli.test.ts`, `test/process/install-local.test.ts`, `test/process/daemon-server-startup.test.ts`; hub restart tests stop assuming fixed versions
- [x] 1.5 Web unit test `src/web/ui/marks.test.ts`: MARK_ORDER `input, failed, done, output`, any exit marks `failed`, status text "exited with code N" / "killed by <signal>"
- [x] 1.6 E2E: `test/e2e/terminals.spec.ts` (Exited terminal uses `exit 1`; Clean exit closes the tab on every page; Last terminal leaves the choices and 1 starts the first preset; Confirmed close leaves the choices focused; Choices leave the focus in the worktree search alone), `test/e2e/splits.spec.ts` or the pane-focus spec (cleanly exited pane's sibling focused and typed into), `test/e2e/closing.spec.ts` (existing `exit` cases become `exit 1`; dialog closes when its terminal exits cleanly), `test/e2e/attention.spec.ts` (no `exited` mark in counts; killed terminal marked failed); update `MARKS` in `test/e2e/contract.ts`

## 2. Daemon

- [x] 2.1 Add `retire(terms)` in `src/daemon/server/daemon.ts` per design D1 and route `closeTerm` and `removeWorktree` through it; `shutdown` keeps only process ending; verify 1.1 and existing daemon tests pass
- [x] 2.2 Branch the `exited` handler in `createTerm` on clean vs failed (design D2); verify 1.1 and 1.3 pass
- [x] 2.3 In `TerminalProcess.onExit` set `unseen` only for a failed exit; verify 1.2 and the unseen process tests pass

## 3. Protocol

- [x] 3.1 Raise `DAEMON_PROTOCOL_VERSION` to 7 in `src/protocol/constants.ts` and re-bless `src/protocol/wire.golden.json` with schemas unchanged; verify 1.4 passes

## 4. Web

- [x] 4.1 Drop the plain `exited` mark (`src/web/ui/marks.ts`, `.mark-exited` in `src/web/main/styles.css`); verify 1.5 and the attention e2e pass
- [x] 4.2 Choices focus rule (design D6) in `src/web/ui/app.tsx` / `src/web/ui/view.ts`; verify the choices e2e scenarios in 1.6 pass

## 5. Gates

- [x] 5.1 Run `pnpm lint`, `tsc -b`, `la-arch-check` and the full `pnpm test`; all green
