# Stabilization baseline

Captured before stabilization implementation on 2026-10-01.

## Source and environment

- Branch: `codex/stabilize-orchestrator`
- Base: `origin/main` and local `main` at `c4dfd40ddf8d4b51d28b87d1b2f2742438b4b3e6`
- Node.js: `v22.23.1`
- npm: `11.6.2`
- OS: Windows (PowerShell)
- `autoMerge`: remains `false`
- No GitHub, Codex, or credentialed service was used.

## Commands and final results

1. `git fetch origin` — passed; `origin/main` matched the checked-out main SHA.
2. `npm ci` — passed. npm reported 2 audit findings (1 moderate, 1 high); no install failure.
3. `npm run test:all` — passed to completion.
   - Server unit suite: 27 tests passed, 0 failed, 0 skipped.
   - Server integration suite: 16 tests passed, 0 failed, 0 skipped.
   - Playwright E2E: 1 test passed, 0 failed, 0 skipped.
   - Automation suite: 31 tests passed, 0 failed, 0 skipped.

The E2E process reached its final state (`1 passed (4.6s)`); it was not recorded while running.

## Reproduction

From a clean checkout at the recorded SHA, run `npm ci` followed by `npm run test:all`. The commands above completed successfully in this baseline, so there are no reproducible product/test failures to report. The only diagnostic is the npm audit summary noted above.

## Change guard

No application source or test file was changed before this report was saved. User-provided untracked files were preserved and were not included.
