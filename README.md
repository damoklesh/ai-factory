# AI Factory V1

## AI Factory local UI

The local supervision application is started from the repository root:

```bash
npm ci
npm run dev
```

It listens on `http://127.0.0.1:3333` by default. `npm run start` uses the same production build and local controller. Opening the page only reads project state; it never starts a run. Mutations require the browser session cookie and an exact same-origin `Origin` header. GitHub and Codex diagnostics are displayed without exposing credentials.

The UI packages are `ui/` (React), `server/` (Node HTTP API and local controller), and `packages/contracts/` (shared TypeScript contracts). Markdown stories are read from `backlog/` when that directory exists. Operational state is written to `.agent/`, which remains ignored by Git.

Useful commands:

```bash
npm run build   # contracts, server and UI
npm test        # build plus deterministic server/persistence/controller tests
npm run dev     # build and serve on loopback
npm run start   # production-style local start
```

The GitHub adapter in this UI pass is simulated through controller options for deterministic tests. A real private-repository pilot still needs credentials configured only in the backend/runner and must validate native GitHub checks and reviews manually. `autoMerge` remains disabled by default.

AI Factory is a local-first TypeScript automation controller for implementing small GitHub Issues with Codex CLI. It selects one eligible user story, gives an isolated worktree to a Developer Codex process, runs configured validation, opens or reuses a pull request, waits for required CI checks, asks a fresh Reviewer Codex process for a structured review, and optionally merges only when the reviewed commit SHA is still current.

This repository contains the automation controller described by [`AI_Factory_V1_Plan.md`](AI_Factory_V1_Plan.md) plus the local supervision server and UI described by `Orquestrator UI.md`. The UI is local-first and uses files rather than a database.

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

## Complete setup: Windows, WSL2, runner and token

The workflow in `.github/workflows/agent-orchestrator.yml` requests a runner with these labels:

```yaml
runs-on: [self-hosted, linux, ai-local]
```

Therefore a native Windows runner is not enough for the current workflow. On a Windows machine, use WSL2 with Ubuntu, or change the workflow deliberately after human review.

### 1. Install WSL2 on Windows

Run PowerShell as Administrator:

```powershell
wsl --install -d Ubuntu-22.04
```

Restart Windows if requested, open Ubuntu, create the Linux user, then install the basic tools:

```bash
sudo apt-get update
sudo apt-get install -y curl git build-essential
```

Install Node.js 20 or newer. For example, with `nvm`:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20
node --version
npm --version
```

### 2. Create the GitHub self-hosted runner

In the target repository, open:

```text
Settings > Actions > Runners > New self-hosted runner
```

Select **Linux** and **x64**. GitHub will display commands containing the current runner download URL and a temporary registration token. Run those commands inside WSL2, not in the Windows PowerShell window. The registration token is temporary and must never be committed.

The resulting runner directory can be, for example:

```bash
mkdir -p "$HOME/actions-runner"
cd "$HOME/actions-runner"
# Paste here the download, extract and config commands shown by GitHub.
./config.sh --url https://github.com/OWNER/REPO --token TEMPORARY_REGISTRATION_TOKEN --labels ai-local
```

When prompted, use the repository URL, keep the runner attached to the repository, and confirm the `ai-local` label. Start it interactively while testing:

```bash
./run.sh
```

After it works, install it as a service if the WSL2 environment is kept running:

```bash
sudo ./svc.sh install
sudo ./svc.sh start
sudo ./svc.sh status
```

If systemd is not enabled in WSL2, use `./run.sh` in a dedicated Ubuntu terminal instead of installing the service. Do not close that terminal while testing the runner.

The runner must show **Idle** in GitHub before launching the workflow. The runner user needs access to the checkout directory and to the local Codex profile.

Official GitHub guide: [adding a self-hosted runner](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/adding-self-hosted-runners).

### 3. Create the GitHub access token

Create a **fine-grained personal access token** at:

```text
https://github.com/settings/personal-access-tokens/fine-grained/new
```

Use these values:

1. Token name: for example `Icara AI Factory`.
2. Expiration: use a short expiry suitable for the pilot.
3. Resource owner: the user or organization that owns the repository.
4. Repository access: **Only select repositories**, then select the pilot repository.
5. Repository permissions required by the workflow:

   - **Contents: Read and write**
   - **Issues: Read and write**
   - **Pull requests: Read and write**
   - **Checks: Read**
   - **Actions: Read**

Generate the token and copy it immediately; GitHub does not show the full value again. If the repository belongs to an organization, an administrator may need to approve the token.

### 4. Store the token safely

For GitHub Actions, create a repository secret at:

```text
Settings > Secrets and variables > Actions > New repository secret
```

Use exactly this name:

```text
AGENT_GH_TOKEN
```

The workflow already maps that secret into the job as `AGENT_GH_TOKEN`:

```yaml
env:
  AGENT_GH_TOKEN: ${{ secrets.AGENT_GH_TOKEN }}
```

Do not put the token in `automation/config.json`, source code, prompts, `.agent/`, or a commit.

For a local run inside PowerShell, set it only for the current terminal session:

```powershell
$env:AGENT_GH_TOKEN = "github_pat_..."
cd C:\Users\damoklesh\workspace\Icara\automation
npm run doctor
npm run orchestrate -- --max-stories 1
Remove-Item Env:AGENT_GH_TOKEN
```

For a local run inside WSL2:

```bash
export AGENT_GH_TOKEN='github_pat_...'
cd /path/to/Icara/automation
npm run doctor
npm run orchestrate -- --max-stories 1
unset AGENT_GH_TOKEN
```

The code also accepts `GITHUB_TOKEN` as a fallback, but `AGENT_GH_TOKEN` is the explicit name used by this repository.

### 5. Configure the repository and validate the runner

Copy the configuration on the runner:

```bash
cd /path/to/Icara/automation
cp config.example.json config.json
```

Edit the repository fields. If the repository URL is `https://github.com/damoklesh/revenue-net-calculator`, the values are:

```json
{
  "owner": "damoklesh",
  "repo": "revenue-net-calculator",
  "baseBranch": "main",
  "runnerLabel": "ai-local",
  "maxStories": 1,
  "maxFixCycles": 3,
  "autoMerge": false
}
```

The repository name must not contain a trailing newline, slash, or `.git` suffix.

Install and verify:

```bash
npm ci
npm run doctor
npm test
npm run orchestrate -- --dry-run
```

The expected result is `PASS` for Node, npm, Git, config, and `github-permissions`. A missing `codex` command is a blocker for a real run, but not for the dry-run or mock tests.

### 6. Install and authenticate Codex on the runner

The desktop application on Windows is not the same as the `codex` executable launched by the orchestrator. Install the CLI in the same environment and as the same user that runs the GitHub runner:

```bash
npm install -g @openai/codex@latest
codex --version
codex login
codex login status
```

Do not copy Codex authentication files into the repository. The runner service and interactive shell must use the same Linux user/profile.

### 7. About `launch_with_cache_clear.sh`

`launch_with_cache_clear.sh` is not part of this repository and is not required by AI Factory. If it belongs to another application, such as Stable Diffusion, keep it outside this setup. The AI Factory runner should execute the commands from `.github/workflows/agent-orchestrator.yml` and the commands configured in `automation/config.json`.

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
