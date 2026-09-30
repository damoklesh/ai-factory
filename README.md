# AI Factory V1

AI Factory is a local-first TypeScript automation controller for implementing small GitHub Issues with Codex CLI. It selects one eligible user story, gives an isolated worktree to a Developer Codex process, runs configured validation, opens or reuses a pull request, waits for required CI checks, asks a fresh Reviewer Codex process for a structured review, and optionally merges only when the reviewed commit SHA is still current.

This repository contains the controller described by [`AI_Factory_V1_Plan.md`](AI_Factory_V1_Plan.md). It is an automation tool, not a product web application: there is no server, database, UI, or mandatory paid OpenAI API integration.

## Current status

All five planned user-story areas are implemented in code and have deterministic local tests. The real GitHub pilot is not complete until a private repository, runner, credentials, local configuration, and two disposable Issues are provisioned. The exact implementation/documentation differences are recorded in [`docs/architecture-gap-analysis.md`](docs/architecture-gap-analysis.md).

The default is deliberately safe:

- `autoMerge` is `false`.
- `maxStories` is `1`.
- Dry-run and mock mode do not contact GitHub, Codex, or push code.
- Secrets and Codex authentication stay outside Git.

## Architecture

```text
GitHub Issue (agent:ready)
        |
        v
Trusted TypeScript orchestrator
  |       |          |          |
  |       |          |          +--> GitHub REST API: labels, PRs, checks, comments, merge
  |       |          +-------------> validation commands and CI polling
  |       +------------------------> Codex Developer / Reviewer child processes
  +--------------------------------> isolated Git worktree and persisted state
```

The intended production flow is:

1. A manual GitHub Actions workflow runs the trusted controller from the base branch.
2. The selector validates Issue contracts, dependencies, labels, and priority.
3. The controller creates `agent/issue-<number>` in a temporary Git worktree.
4. Codex Developer receives the Issue contract on stdin and returns schema-checked JSON.
5. The controller runs configured validation, commits, pushes, and creates or reuses one PR.
6. Required checks are polled for the exact PR head SHA.
7. A separate Codex Reviewer evaluates the diff and validation evidence.
8. Review/CI failures use the bounded fix budget. `autoMerge=true` additionally rechecks the PR SHA immediately before merging.
9. A successful merge closes the Issue and applies `agent:done`.

GitHub-hosted CI is intentionally separate from the self-hosted orchestration runner. The same runner must not be the only machine waiting for its own CI job.

## Repository layout

- `.github/workflows/agent-orchestrator.yml` — manual self-hosted workflow.
- `.github/workflows/ci.yml` — independent GitHub-hosted TypeScript test workflow.
- `.github/ISSUE_TEMPLATE/agent-story.yml` — structured Issue form.
- `automation/src/` — controller, GitHub client, Codex runner, worktree, state, checks, and validation code.
- `automation/tests/` — unit and integration-style deterministic tests.
- `automation/prompts/` and `automation/schemas/` — Developer/Reviewer contracts.
- `automation/config.example.json` — safe configuration template.
- `docs/automation-setup.md` — concise setup checklist.
- `docs/architecture-gap-analysis.md` — audit against the original architecture and five user stories.

## Prerequisites

For local development:

- Node.js 20 or newer and npm.
- Git.
- Codex CLI installed and authenticated for the same user that runs the controller. Verify with `codex --version`, `codex login`, and `codex login status`.

For a real pilot:

- A private GitHub repository. Do not use this ChatGPT-login workflow with a public/open-source repository.
- A Linux self-hosted GitHub Actions runner, normally Ubuntu in WSL2 on Windows, labelled `ai-local`.
- A separate GitHub-hosted runner or genuinely independent CI runner.
- GitHub Actions enabled and repository workflow permissions configured.
- Two small disposable Issues using the story template.

The controller does not register runners, change branch rules, create Issues, or configure GitHub on your behalf.

## Configuration

Copy the example locally:

```bash
cd automation
cp config.example.json config.json
```

On PowerShell:

```powershell
Copy-Item config.example.json config.json
```

`config.json` is ignored by Git. Keep it on the trusted runner. If it is stored elsewhere, set `AI_FACTORY_CONFIG` to its path.

| Setting | Purpose | Typical value / default |
| --- | --- | --- |
| `owner`, `repo` | GitHub repository | required; replace `OWNER`/`REPO` |
| `baseBranch` | Branch used for new worktrees and PRs | `main` |
| `runnerLabel` | Intended runner label | `ai-local`; currently also set in the workflow |
| `model` | Optional Codex model override | empty |
| `validationCommands` | Commands repeated by the controller in the worktree | project-specific, e.g. `npm test` |
| `smokeCommands` | Reserved project smoke commands | currently not executed; see the gap analysis |
| `requiredChecks` | Exact GitHub check names required for the PR SHA | project-specific, e.g. `automation` |
| `timeouts.codexMinutes` | Per Codex invocation timeout | `45` |
| `timeouts.ciMinutes` | Required-check polling timeout | `20` |
| `timeouts.workflowMinutes` | Local validation command timeout | `180` |
| `maxStories` | Stories per run | `1` |
| `maxFixCycles` | Maximum correction cycles per story | `3` |
| `autoMerge` | Allow the controller to merge after all gates | `false` |
| `stateFile` | Recoverable local state cache | `.cache/state.json` |
| `logDirectory` | Intended log directory | `logs` |

### Secrets, accounts, and variables

| Name / setting | Where it belongs | Required for |
| --- | --- | --- |
| `AGENT_GH_TOKEN` | GitHub Actions secret or runner environment | Real GitHub API operations |
| `GITHUB_TOKEN` | Native Actions token fallback | Supported fallback, but the fine-grained PAT is preferred |
| Codex ChatGPT login | Local Codex profile of the runner user | Developer and Reviewer invocations |
| `AI_FACTORY_CONFIG` | Runner environment variable | Config outside `automation/config.json` |
| `max_stories` | `workflow_dispatch` input | Per-run limit; default `1` |
| `auto_merge` | `workflow_dispatch` input | Explicitly enables merge for one run |
| `agent:ready`, `agent:running`, `agent:blocked`, `agent:done` | GitHub Issue labels | Visible state and selection |
| `ai-local` | Self-hosted runner label | Workflow routing |

The fine-grained PAT should be restricted to the pilot repository and granted only the required Contents, Issues, Pull requests, Checks, and Actions read permissions. Never put the PAT, Codex auth files, or runner registration token in this repository or in prompts. Rotate the PAT and set an expiry.

The GitHub Actions workflow also needs repository settings that allow the selected workflow to run and permit the intended PR/Issue operations. Branch protection, required approvals, and merge rules can intentionally stop the controller; do not weaken them to force automation through.

## Running locally

From `automation/`:

```bash
npm ci
npm run doctor
npm test
npm run orchestrate -- --dry-run
npm run orchestrate -- --mock --max-stories 2
```

`doctor` reports missing config, authentication, and (when config/token are present) GitHub repository access without printing token values. Missing config/auth warnings are expected on a fresh checkout; missing Node, npm, Git, or Codex is a failing prerequisite.

The configured real run is intentionally explicit:

```bash
AGENT_GH_TOKEN=... npm run orchestrate -- --max-stories 1
```

On PowerShell:

```powershell
$env:AGENT_GH_TOKEN = "<token>"
npm run orchestrate -- --max-stories 1
Remove-Item Env:AGENT_GH_TOKEN
```

Do not enable `--auto-merge` on the first run. Review the PR, CI, state file, labels, and comments first.

## Running through GitHub Actions

1. Merge the trusted controller and workflows into the repository default branch.
2. Provision `config.json` on the self-hosted runner, or set `AI_FACTORY_CONFIG` to a runner-local path.
3. Add `AGENT_GH_TOKEN` as a repository secret.
4. Authenticate Codex as the effective runner user.
5. Register the Linux runner with label `ai-local`.
6. Create two small Issues: the second should depend on the first and both should have `agent:ready`.
7. Run **AI Factory** manually with `max_stories=1` and `auto_merge=false`.
8. Inspect the first PR and its CI. Only after the pilot is understood should `auto_merge` be considered.

The Action checkout uses the default branch controller. A PR must not be allowed to execute a modified orchestrator while that PR is being reviewed.

## Issue contract

Each Issue must contain these headings, generated by the Issue Form or written manually:

```markdown
## Objective
As a user I want ... so that ...
## Acceptance criteria
- Observable normal case
- Observable error or boundary case
## Scope
Files/components and exclusions.
## Dependencies
None or #12, #15
## Priority
1
## Validation
npm test
```

The selector requires an open Issue with `agent:ready`, a valid positive priority, valid dependency references, and all dependencies marked `agent:done`. It orders by priority and then Issue number. Missing, ambiguous, or cyclic dependencies are not selected.

## State, recovery, and safety

State is cached in `stateFile`; GitHub labels, PRs, and structured failure comments are the durable operational record. Stable branches and PR body markers prevent duplicate PR creation. Re-running the workflow is the supported recovery mechanism after interruption, quota exhaustion, authentication failure, or a runner restart.

Stop the workflow rather than changing credentials or silently falling back to a paid API when Codex authentication or quota is unavailable. A suspended or powered-off PC cannot run a self-hosted job. Cancelled runs may leave a branch/PR and recoverable state by design.

Validation and smoke commands are configuration-controlled shell commands. Keep them trusted and review changes to them. The Developer is not allowed to weaken tests, CI, workflows, thresholds, merge rules, or this controller to obtain a pass.

## Tests and coverage

```bash
cd automation
npm test
npm run coverage
```

The coverage command enforces approximately 60% coverage on the controller code while excluding bootstrap/configuration/type-only modules. The suite covers contract parsing, dependency selection, state persistence/reconciliation, result schemas, SHA-bound checks and merges, process/validation behavior, REST client mapping, and CLI mock/dry-run paths. A real GitHub/Codex run remains a pilot test because it requires external credentials and infrastructure.

## Known limitations

Read [`docs/architecture-gap-analysis.md`](docs/architecture-gap-analysis.md) before calling the pilot production-ready. In particular, Docker/Compose smoke execution, file logging, local process locking, full GitHub pagination/status contexts, and a complete end-to-end real-repository run still need follow-up work.
