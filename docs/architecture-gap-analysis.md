# Architecture and user-story gap analysis

## 2026-10-01 implementation baseline

[`AI_Factory_Architecture_and_Roadmap.md`](../AI_Factory_Architecture_and_Roadmap.md)
is the accepted architecture baseline for the next iteration. Architecture,
controller, validation, CI, and merge-policy changes remain subject to human
review. Local implementation commits do not imply approval, push, or merge.

The proposal was written from `master` at
`4a82311136602e475b036c0f7d2b4d697d0675eb`, while the inspected checkout is
`main` at `99965f0034c5a50a705f02f3b353e0b8312e99ee`. The current branch already
contains a React UI, local Node API, durable run data, human decision/spec-edit
contracts, GitHub observation, and a separate CLI orchestrator. Therefore the
roadmap is an incremental convergence plan, not authorization to replace those
pieces.

Confirmed implementation constraints:

- The local UI/API is the V1 control plane; the Actions workflow remains a CI
  or explicitly selected legacy entry point, never a concurrent controller for
  the same target.
- Target identity and paths must be explicit. Neither `process.cwd()` nor the
  AI Factory checkout may silently become the target project.
- Backlog Markdown in the selected target is canonical; GitHub Issues are an
  idempotent collaboration mirror and external-state source.
- Operational state belongs under ignored controller storage, outside the
  target and story worktree.
- A run is not `ACTIVE` before a real child process has spawned. Unknown live
  state after restart becomes `INTERRUPTED`, not active or successful.
- `autoMerge` remains `false` by default. No push or merge is implied by the
  UI, and merge requires current spec revision, validated HEAD SHA, and human
  approval.
- Default automated tests use temporary repositories and fake GitHub/Codex
  adapters, make no service calls, and require no credentials.

Initial verification on this baseline passed both existing suites: root
`npm test` (20 tests) and `automation/npm test` (25 tests). The sections below
describe the older controller audit and remain as historical evidence until
each roadmap story replaces its corresponding gap.

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
