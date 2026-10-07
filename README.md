# worktree-term

A fast, worktree-centric terminal manager for coding agents. One tab per repo (local or over SSH), every git worktree in a sidebar, and persistent terminals per worktree that outlive the UI.

The CLI is `wtd`: a daemon per host owns the PTYs and git watches, and a local hub serves the browser UI and reaches every daemon over one protocol. See `architecture/` for the structure and its principles.

## Configuration

The hub reads `$XDG_CONFIG_HOME/worktree-term/config.json` (by default `~/.config/worktree-term/config.json`); every key is optional, and a new browser session picks up edits. `presets` lists the terminals a new tab or split can start, in order: `command` runs as `$SHELL -l -i -c <command>`, and `null` starts the plain login shell. Without `presets`, the only preset is a plain `shell`.

```json
{
  "port": 7417,
  "repos": ["~/src/app", "/srv/lib"],
  "presets": [
    { "name": "claude", "command": "claude" },
    { "name": "shell", "command": null }
  ]
}
```

## Keyboard

| Keys                        | Action                                                    |
| --------------------------- | --------------------------------------------------------- |
| Alt+Up / Alt+Down           | Previous / next worktree in the sidebar, under its filter |
| Alt+Left / Alt+Right        | Previous / next terminal tab                              |
| Alt+Shift+arrows            | Focus the pane in that direction                          |
| Ctrl+Shift+T                | New tab                                                   |
| Ctrl+Shift+D / Ctrl+Shift+E | Split the focused pane right / down                       |
| Ctrl+Shift+W                | Close the focused pane                                    |
| Ctrl+Shift+C / Ctrl+Shift+V | Copy the selection / paste                                |

The preset picker takes 1–9, the arrow keys and Enter, and Escape cancels it.

## Attention marks

Panes, terminal tabs, worktree rows and repo tabs show the most urgent mark of their terminals: needs input, exited with failure, exited, done (quiet after unseen output) and new output. A terminal needs input when its program rings the bell or sends a desktop notification (OSC 9, OSC 777 `notify` or OSC 99). Claude Code does so only when told to; put this in `~/.claude/settings.json`:

```json
{ "preferredNotifChannel": "terminal_bell" }
```

## Development

Requires Node 22 (`.nvmrc`), pnpm, and the `la-*` architecture tools on `PATH` (`uv tool install living-architecture==0.2.3`), which `pnpm test` runs.

```sh
pnpm install
pnpm build              # dist/wtd.mjs and dist/web
pnpm test               # unit, process, architecture and e2e tiers
pnpm test:integration   # opt-in real-SSH tests
pnpm lint               # tsc -b and ESLint
pnpm format             # Prettier
```
