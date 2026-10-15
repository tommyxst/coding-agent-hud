# Repository Guidelines

## Project Structure

- `src/`: React/TypeScript UI, state, settings, and native bridge.
- `src-tauri/src/`: Rust collectors, session model, window integration, and `bin/agent-hud-hook.rs`.
- `tests/`: frontend tests; Rust unit tests live beside implementation.
- `src-tauri/icons/`: application icons; `UI&UX/`: design references.
- `docs/`: development plan, verification instructions, and screenshots.

## Development and Checks

Use Windows 10/11, Node.js 22.12+, Rust, C++ Build Tools, and WebView2.
- `npm ci`: install locked dependencies.
- `npm run dev`: synthetic browser preview, not native acceptance.
- `npm run desktop:dev`: run the desktop application.
- `npm run check`: TypeScript checks and Vitest tests.
- `npm run build`: build frontend assets.
- `npm run desktop:build`: build the desktop executable without bundling.

Backend checks:
```bash
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

## Style and Testing

Use two-space TypeScript indentation, single quotes, semicolons, PascalCase components/types, and camelCase functions. Follow rustfmt and Rust snake_case conventions. TypeScript is strict; no frontend formatter or linter is configured.

Name Vitest tests `tests/frontend-*.test.ts` or `.test.tsx`; use Rust `#[test]` modules. Add regression coverage for changed behavior. Run `npm test` for frontend tests. Native acceptance requires Windows checks described in `docs/verification.md`, not synthetic fixtures alone.

## Commits and Pull Requests

Follow existing `feat:`, `fix:`, and `docs:` commit subjects. PRs should describe scope, link relevant issues, report checks and limitations, and include screenshots for UI changes. Never commit credentials or real session/transcript data.

## Agent Workflow

Read STATE.json and README.md before work. Resume the active task or start its approved followUp; otherwise wait for human direction.
STATE is the sole task definition: goal, criteria, scope, constraints, current, next, blocked.
Read further docs or relevant source only as needed; no mandatory layer traversal.
Run checks, update necessary usage docs, verify, then close with a knowledge summary.
Docs contain purpose and usage only. Notes and temporary findings are optional.
Re-read state before writing; human changes invalidate old verification. Never overwrite new human intent.
Keep modifications in Git task branches. Use git_status to resume, git_create to allocate a worktree before assigning a writing delegate; explicitly set its working directory and allowed paths. Read-only delegates need no branch.
Review git_diff, git_commit, then test and git_verify the exact commit. Integrate verified workers into the managed coordinator only; test the combined result again. Main merge/push requires human approval. Never stash/reset user changes automatically.
