## 1. Protocol

- [x] 1.1 Editor command parser and argument builder (design 5): words, quotes, escapes, `{path}` substitution or append, validity; `editorCommand` schema built on it; verify the "Editor command syntax" scenarios in `src/protocol/*.test.ts`.
- [x] 1.2 Messages `openEditor`, `setEditor`, `editor`; hub error codes `editor-missing`, `editor-failed`; `BROWSER_PROTOCOL_VERSION` 15; re-bless the wire golden (frozen golden unchanged); verify the protocol delta's catalogue, value-limit and shared-constant scenarios in `src/protocol/messages.test.ts`, `constants.test.ts` and `wire.golden.test.ts`.

## 2. Platform

- [x] 2.1 `platform.files` directory helper; `platform.dialer` detached spawn with a working directory, returning the pid, failing with a typed error for missing directory (checked before and again on `ENOENT`), missing program and other failures (design 8, 9); existing callers unchanged; verify unit tests in `src/platform/dialer/dialer.test.ts` and `src/platform/files/files.test.ts`, including the directory-vanishes-before-spawn case.
- [x] 2.2 `editorUnit(stateDir)` in `platform.scopes` (design 7); verify in `src/platform/scopes/scopes.test.ts` that it carries the unit prefix, `editor-` and a random suffix.

## 3. Hub

- [x] 3.1 Config: `editor` key (schema, default `kate`, invalid-command refusal naming `editor`); verify the hub "Configuration" scenarios in `src/hub/config/config.test.ts`.
- [x] 3.2 `ConfigEditor`: explicit key removal in the field edit; `setEditor(command | null)` (design 11); verify in `src/hub/config/editor.test.ts` that set, unchanged, reset and reset-without-override behave as specified and every other value stays as written.
- [x] 3.3 Session: per-session editor command from the snapshot; `editor` after `presets` and before `hosts`; `setEditor` handling with `done` then broadcast that also replaces each session's command (design 10); verify the "Browser session handshake", "Configuration edits" and "Editing the editor command" scenarios in `test/process/hub-router-config.test.ts`, including survival across a hub restart.
- [x] 3.4 Editor launch in `hub.links` on the dialer primitive, scope move when a lasting user manager is reachable with failure reported to the hub log, error mapping; `openEditor` in the router; verify the "Opening a worktree in an editor" scenarios in a new `test/process/hub-router-editor.test.ts` with a fake editor recording its arguments and working directory (scope scenario skips without a lasting user manager).

## 4. Web

- [x] 4.1 Client: `editor` state from the hub, `openEditor` and `setEditor` requests; verify in the client unit tests.
- [x] 4.2 Hollow ring on worktree rows (design 3, 4) with `open: <N>` title and CSS; verify the "Attention indicators" ring scenarios in `src/web/ui/marks.test.ts` and `test/e2e/attention.spec.ts`.
- [x] 4.3 "Open in editor" control in `TabControls` with disabled reasons, pending state and the error dialog with the approved wording (design 14, 15); verify the "Open in editor" scenarios in a new `test/e2e/editor.spec.ts` and the overflow scenario in `test/e2e/tab-bar-scrollbar.spec.ts`.
- [x] 4.4 Right-click command form (design 16): field, hint, Save / Reset to default / Cancel, local validation through the shared parser, Enter / Escape / outside press; verify the "Editing the editor command" scenarios in `test/e2e/editor.spec.ts`.

## 5. Docs and verification

- [x] 5.1 README: the `editor` config key, command syntax and the local-only scope; verify by reading it against the specs.
- [x] 5.2 Run `pnpm test`, `pnpm lint`, `tsc -b`, `la-arch-check` and LikeC4 validation; verify all pass.
