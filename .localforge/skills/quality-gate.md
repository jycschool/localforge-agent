# LocalForge quality gate

Use this skill when changing LocalForge behavior or its desktop interface.

- Inspect the relevant contract, main-process handler, preload bridge, and Renderer call together when an IPC feature changes.
- Keep the Renderer sandboxed and never expose API keys or arbitrary IPC channels.
- Add or update focused tests for non-visual logic.
- Run `pnpm check`, `pnpm test`, and `pnpm build` before declaring the change complete.
- Report what was verified and distinguish automated checks from visual inspection.
