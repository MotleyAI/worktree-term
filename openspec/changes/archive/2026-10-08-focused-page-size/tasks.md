## 1. Web

- [x] 1.1 `TerminalManager`: send `resize` only while the page has the focus, once per size per terminal; on `focus` and on a host reconnecting, send the shown terminals' sizes (design D1)
- [x] 1.2 e2e: two pages with stubbed focus; a background page opening and resizing leaves the PTY size alone, the focused page takes it over, refocusing takes it back; verify it fails without 1.1

## 2. Final gates

- [x] 2.1 `pnpm test` green (incl. Playwright); `pnpm lint`, `la-typecheck`, `la-arch-check` exit 0; `openspec validate focused-page-size --strict` passes
