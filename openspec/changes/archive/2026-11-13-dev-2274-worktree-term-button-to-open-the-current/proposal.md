## Why

There is no way to open the selected worktree in an editor from the UI; the user has to copy the path and launch the editor by hand. The sidebar also cannot tell a worktree that has quiet open terminals from one with none, so finding where sessions run means hovering each row.

## What Changes

- An "Open in editor" control at the right end of the terminal tab bar, after the split controls, opens the selected worktree with the configured editor command (default `kate`), launched detached by the local hub on its own machine.
- The control is disabled with no worktree selected, for prunable or gone worktrees, for remote hosts and on remote pages (remote opening is out of scope).
- A missing editor program shows a pop-up telling the user to install it or set another command; other launch failures show their error in the same pop-up.
- Right-clicking the control opens a form to edit the command (`{path}` placeholder, else the path is appended) or reset it to the default.
- The command is stored in the hub's `config.json` under a new `editor` key and pushed to every open page.
- Worktree rows with at least one terminal and no attention mark show a hollow ring.
- Browser link: new messages `openEditor`, `setEditor`, `editor`; new hub error codes `editor-missing`, `editor-failed`; `BROWSER_PROTOCOL_VERSION` becomes 15. The daemon protocol is unchanged.

## Capabilities

### New Capabilities

### Modified Capabilities
- `web`: open-in-editor control, its command form and error pop-up; hollow ring on worktree rows with terminals but no mark.
- `hub`: `editor` configuration key, editing it from the page, sending it to sessions, and launching the editor.
- `protocol`: browser-link messages and error codes for the editor; editor command value rules; browser protocol version 15.

## Impact

- Code: `src/web/ui` (control, form, pop-up, ring), `src/web/client` (messages, editor state), `src/hub/config` (schema, `ConfigEditor` key removal), `src/hub/router` (session editor state, requests), `src/hub/links` (launch), `src/platform/dialer` (detached spawn with `cwd` returning the PID), `src/platform/scopes` (editor scope unit), `src/protocol` (schemas, command parser, version, goldens).
- No architecture model or arc42 change; no new dependencies.
- Pages of the previous browser protocol version reload as on any browser-link bump; daemons are unaffected.
