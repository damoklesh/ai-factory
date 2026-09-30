# Architecture and user-story gap analysis

Reviewed against [`AI_Factory_V1_Plan.md`](../AI_Factory_V1_Plan.md), the five construction user stories, the supplied Developer/Reviewer contracts, and the current TypeScript implementation.

## Implemented and aligned

| Intended behavior | Implementation evidence |
| --- | --- |
| TypeScript controller with no server/database/UI | `automation/src/` and local CLI scripts |
| GitHub Issues as story source and labels as visible state | `github.ts`, `stories.ts`, Issue Form |
| Priority/dependency selection | `parseStory`, `validateDependencyGraph`, `selectNextStory` |
| Stable `agent/issue-N` branch and isolated worktree | `git.ts` |
| Separate Developer and Reviewer Codex invocations | `codex.ts`, separate prompts and JSON schemas |
| Validation and required checks bound to a head SHA | `verify.ts`, `checks.ts` |
| Bounded fixes and persisted state | `state.ts`, orchestrator fix-cycle loop |
| SHA check immediately before merge | `merge.ts` |
| Manual Action, independent CI, concurrency group, dry-run, mock mode | `.github/workflows/`, CLI and tests |
| Secret redaction and default `autoMerge=false` | config defaults, doctor output, setup docs |

## Divergences and risk

| Priority | Documented intent | Current implementation | Impact / recommended follow-up |
| --- | --- | --- | --- |
| High | US5 proves two small stories through the real GitHub flow | Mock mode proves selector ordering only; no real private-repository pilot has run | Run the disposable private-repository pilot after provisioning the runner, PAT, Codex login, CI, and Issues |
| High | Docker/Compose smoke tests use isolated ports, health checks, real HTTP, and scoped cleanup | `smokeCommands` is loaded but never executed; there is no Docker lifecycle implementation | Implement a dedicated smoke runner before relying on integration services |
| High | State transitions include `VERIFYING` and `MERGED` | The controller goes from `PR_OPEN` to `REVIEWING` and then directly to `DONE` after merge | Add explicit verifying/merged transitions and tests so the operational state matches the plan |
| High | Local lock prevents simultaneous controllers | GitHub Actions has repository concurrency, but direct local invocations have no lock file/OS lock | Add an atomic lock with stale-owner recovery before enabling local and Action triggers together |
| Medium | Configured `runnerLabel`, `logDirectory`, and validation/smoke settings drive runtime | `runnerLabel` is hardcoded in the workflow, `logDirectory` is unused, and `smokeCommands` is unused | Either implement these fields or remove them from the public config until supported |
| Medium | Controller repeats validation and records logs outside the worktree | Validation output is held in memory/stdout; no structured log files are written | Add bounded structured logs outside worktrees, with secret-safe redaction and retention guidance |
| Medium | CI adapts to the pilot project | `ci.yml` only runs the automation package tests and does not run project-specific commands | Add project commands to the pilot CI workflow or document the project-specific CI workflow as required |
| Medium | GitHub checks can represent required checks | Only GitHub Check Runs are queried; legacy commit statuses and skipped/neutral policy are not modeled | Support status contexts and define explicit conclusions accepted as pass |
| Medium | Startup reconciles branch, PR, and durable state | Existing open PRs are found by stable branch and state is reloaded, but merged/closed PRs, stale labels, and base-branch freshness are not comprehensively reconciled | Add a reconciliation phase with explicit tests before resuming complex interrupted runs |
| Medium | GitHub API operations use the least necessary permissions and robust pagination | The REST client reads one page of Issues/PRs and the doctor only confirms repository readability, not write permissions | Add pagination and permission probes or document the small-backlog limitation clearly |
| Medium | The controller owns safe commits | `git add -A` commits every worktree change made by Developer, including unreviewed generated files | Add an allow/deny policy for controller/config paths and inspect the diff before commit |
| Low | Codex child processes are terminated cleanly on cancellation | Timeout calls `child.kill`, but there is no process-tree cleanup or cancellation signal propagation | Add process-group cancellation and an integration test for descendants |
| Low | Issue template follows the parser contract | The parser now accepts both hand-written `##` and GitHub-form `###` headings | Fixed in this audit; retain the regression test |

## User-story acceptance audit

### US1 — Base and doctor

Implemented: config template, dry-run, tool/auth/repository-access diagnostics, schemas, docs, and tests. Partial: the doctor does not verify every write permission or Docker capability, and configuration validation is intentionally lightweight.

### US2 — One US to PR

Implemented in code: selector, worktree, Developer invocation, local validation, commit/push, stable PR body, PR reuse, and checkout isolation. Not yet externally proven: a real Issue-to-PR run against GitHub.

### US3 — CI and review

Implemented: required-check polling for the current SHA, red CI blocking, schema validation, independent Reviewer invocation, and stale-SHA merge protection. Partial: no legacy status-context support and no real CI/reviewer pilot evidence.

### US4 — Fix, merge, and next

Implemented: bounded fix cycles, persisted state, dependent mock sprint, and merge SHA guard. Divergent: `VERIFYING`/`MERGED` states are not emitted exactly as documented, and merge-rule/approval/conflict reconciliation is delegated to the GitHub merge response.

### US5 — Actions and real test

Implemented: manual workflow, repository concurrency group, self-hosted runner labels, independent CI workflow, setup guide, and two-story mock simulation. Not complete: runner registration, real credentials, real Issues, Docker smoke, and the disposable private-repository end-to-end test remain manual.

## Reviewer conclusion

The implementation is a useful deterministic V1 controller and is suitable for continued pilot preparation. It should not be described as having completed the real GitHub acceptance test until the high-priority gaps above are addressed or explicitly accepted by the product owner.
