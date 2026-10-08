## Context

Each page fits its shown terminals to their panes and, today, sends `resize` whenever its own fitted size changes. The daemon gives the PTY the last size it receives. Principles applied: web 2, 4, 7.

## Decisions

### D1 The page in focus owns the sizes
`document.hasFocus()` decides whether a fit is sent: a page in the background fits its xterm only. On `focus` the page forgets what it last sent and sends the size of every terminal it shows; the same happens for a host's terminals when its link connects again, since a size sent while disconnected was lost. Per terminal, the page remembers the size it sent since gaining the focus, so refits that change nothing send nothing. Alternative — the daemon picking the smallest size of all attached pages (as tmux does by default) — rejected: the window in use would get a narrower terminal than it has room for.

### D2 No page in focus
When no page has the focus (another application is in front), sizes stay as the last focused page set them.
