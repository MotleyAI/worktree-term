## Context

See proposal.md for motivation. The browser reaches only its hub; within the hub only `links` spawns processes (hub principle 2) and `router` already depends on `links` and `config`. Presets show the pattern for a page-edited, hub-owned setting: a `config.json` key edited through `ConfigEditor`, pushed to every session. The hub and the daemon of host 0 run on the same machine; remote hosts' daemons and remote pages' hubs run on machines without the user's display. The hub enters a transient scope of its own at start when a lasting user manager is reachable, so anything it spawns lands in that scope unless moved.

## Goals / Non-Goals

**Goals:**
- One shared, pure editor-command parser used by the config schema, the wire schemas, the page's form validation and the hub's launch.
- An editor launch that detects a missing program without a shell or timing guesses and leaves the editor independent of the hub.

**Non-Goals:**
- Opening worktrees of remote hosts or from remote pages (deferred by the user).
- Observing the editor's exit status after it started, including a shell's exit 127.
- A keyboard shortcut for the control; a ring on repo tabs, terminal tabs or pane headers.
- Per-host editor commands.

## Decisions

1. **The local hub launches the editor; the control works only for worktrees on the browser's own machine.** Options: hub launch, local only; hub launch plus a second remote command template run locally with `{host}`/`{path}`; daemon of the owning host launches (the issue's wording). The hub launch needs no daemon protocol change, fits the existing arrows, and always opens the editor on the user's display; a daemon launch on a remote host opens on a machine without the user's display. The control is disabled for remote hosts on a home page and on remote pages. (user)
2. **Remote opening is deferred.** The user: "running that remotely is a pain, so let's leave that for later". (user)
3. **Ring on worktree rows only.** Options: worktree rows only; rows and repo tabs. Rows are where the user scans for open sessions; most open repo tabs have terminals. (user)
4. **The ring counts every terminal the daemon lists for the worktree**, exited ones whose tab is still open and those of a gone worktree included; it shows only where no mark shows. Its element is distinct from the mark's (own test id) so existing mark assertions keep their meaning. (default)
5. **Own word splitter, no shell.** Options: split the command ourselves and spawn directly; run `sh -c` with the path as `$1`. Direct spawn reports a missing program as a spawn `ENOENT` at once; through a shell, a missing program is an exit 127 that can only be told apart from a running editor by waiting an arbitrary time, since the shell execs the long-running editor. Cost: no `$VAR` or `~` expansion in the command. The parser lives in `protocol` (pure, zod-only) and backs the `editorCommand` schema. (default)
6. **The issue's "exit 127 through a shell" is not handled.** Codex proposed a bounded early-exit watch mapping 127 to `editor-missing`; rejected because no shell is ever run, so 127 can only come from a user-written `sh -c …` command, and catching it needs a timing heuristic. rejected (codex)
7. **The editor is moved into a transient scope of its own** (`platform.scopes` helper `editorUnit(stateDir)` beside `daemonUnit`/`hubUnit`, Codex finding) when a lasting user manager is reachable, via the existing enter-scope call on the started pid; a failure is reported to the hub log and does not fail the launch. Left in the hub's scope, the editor's memory would be attributed to the hub and an OOM kill of the hub's cgroup would take the editor with it. (default) (codex)
8. **Launch primitive.** `platform.dialer`'s detached spawn gains a working-directory option and returns the started child's pid, keeping the spawn error (with its `code`) as `cause`; existing callers keep their behaviour, guarded by regression tests. `hub.links` exposes the editor launch built on it. (codex)
9. **Missing directory vs missing program.** Node reports a missing `cwd` as `ENOENT` too. The launch primitive checks that the working directory is an existing directory before spawning and, on a spawn `ENOENT`, checks again (the directory can vanish in between, Codex finding), failing with a typed error that tells a missing directory, a missing program and any other failure apart; the hub maps them to `editor-failed` naming the path, `editor-missing` naming the program, and `editor-failed` with the reason. The check sits in `platform.dialer` through a new `platform.files` directory helper, because `hub.links` may not use `fs` (dependency allowlist) while `platform.dialer → platform.files` exists. (default) (codex)
10. **Per-session editor command.** Each session holds its own editor command, initialised from its snapshot and replaced by the same broadcast that sends `editor`, so `openEditor` always runs the command that session's page shows, including edits made from another page. (codex)
11. **Removing a config key.** `ConfigEditor`'s field edit gains an explicit "remove the key" result distinct from "no edit"; `setEditor(null)` uses it, keeping every other value as written. (codex)
12. **Default command `kate`, path appended**, as in the issue; reset removes the `editor` key rather than writing the default. (default)
13. **Wire.** Browser→hub `openEditor{req, worktree}` and `setEditor{req, command | null}`; hub→browser `editor{command}`, sent after `presets` and before `hosts`; hub error codes `editor-missing` and `editor-failed`; `BROWSER_PROTOCOL_VERSION` 14 → 15, wire golden re-blessed, frozen golden unchanged. `openEditor` carries no host: the hub always launches on its own machine. (default)
14. **Dialog wording names the missing program** rather than always "Kate", since the command may name another editor. (user, approved wording) — editor-missing: "Could not find `<program>`. Install it, or right-click the editor button to set the command of the editor you prefer."; editor-failed: "Could not open the editor: <message>"; form hint: "{path} stands for the worktree path; without it, the path is added at the end."; control title: "Open in editor (right-click to change the command)". `<program>` is the first word of the command the page shows.
15. **The control is disabled while its request is unanswered**, preventing double launches; it does not depend on the host's connection status, since the launch does not involve the daemon. (default)
16. **Right-click works on the disabled control** (a disabled button receives no pointer events, so the context-menu handler sits on a wrapper), except on a remote page, whose hub's command would never be used. (default)
17. **Stale shared-constants requirement fixed.** The protocol spec's "Shared constants" requirement still states daemon 10 / browser 13 while the code and the version requirement say 11 / 14; this change states 11 / 15 in both. (default)
18. **OpenSpec deltas.** Codex flagged missing spec updates; they are this change's `web`, `hub` and `protocol` deltas. rejected (codex)
19. **No architecture change.** Uses existing arrows `web.ui → web.client`, `hub.router → hub.links`, `hub.router → hub.config`, `hub.links → platform.dialer`, `hub.links → platform.scopes`. Applicable principles: system 5 (command parsed by schema at the boundary), 6 (launch and scope failures reported), 8 (tests per tier); hub 2 (only `links` spawns), 5 (the command is config); protocol 2–4 (schema-defined command, strict decoding, version bump); web 2 (only `client` encodes wire data). (default)

## Risks / Trade-offs

- [The hub's `PATH` or display variables may differ from the user's shell when the hub was started from a desktop entry] → `editor-missing` names the program; the user can set an absolute path in the command.
- [Processes the editor forks before it is moved into its scope stay in the hub's scope] → the move happens right after spawn; editors fork their GUI later or hand off to a running instance.
- [Commands relying on shell features (`$VAR`, `~`, pipes) do not work] → documented in the form hint's spirit; a user can write `sh -c '…' sh {path}` explicitly, accepting that a missing inner program is not detected.
- [A browser-link bump reloads open pages of the old version] → same as every browser-link change; daemons are unaffected.
