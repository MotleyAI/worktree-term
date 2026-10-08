## 1. Protocol

- [x] 1.1 `movePreset{req, name, to}` (0–63) in the browser-to-hub catalogue; `BROWSER_PROTOCOL_VERSION` 8; samples, correlation and rejection tests; verify the golden guard accepts the change with only the browser version raised, then re-bless; version expectations

## 2. Hub

- [x] 2.1 Configuration editor `movePreset` with unit tests (front, end, beyond the end, in place, unknown name); session and router handling; `test/process/hub-router.test.ts`: move answered with `done`, new order sent to every session and written

## 3. Web

- [x] 3.1 Client and view `movePreset`; `dropPosition` with unit tests; draggable rows with drop markers; Alt+Up/Down keeping the highlight and focus
- [x] 3.2 e2e: drag in the choices reorders every page and `config.json`; Alt+Up in the new-tab picker, then Enter runs the moved preset; two quick Alt+Down presses only move the highlighted preset (fails without the wait)

## 4. Final gates

- [x] 4.1 `pnpm test` green (incl. Playwright); `pnpm lint`, `la-typecheck`, `la-arch-check` exit 0; `openspec validate preset-order --strict` passes
