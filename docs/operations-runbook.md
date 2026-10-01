# AI Factory V1 operations runbook

This runbook covers the local controller and the optional `ai-local` GitHub Actions runner. The default test path never contacts GitHub, Codex, Docker, or a user repository.

## Prerequisites and setup

Install Node 20+, npm, Git, the Codex CLI, and the project toolchain detected by the Project Doctor. Copy `automation/config.example.json` to a local config and set `AGENT_GH_TOKEN` only in the process environment. Never put tokens in `config.json`, a target repository, screenshots, or logs.

Run `npm ci`, `npm run build`, `npm run doctor`, and `npm test`. The first two test layers use temporary repositories. The E2E layer starts a local fake server and stores failure evidence under `.artifacts/playwright/`.

## Local versus Actions execution

The local UI starts the trusted controller from the control repository and launches the automation entrypoint from that trusted build. The target project is selected explicitly and each story receives an isolated worktree. The Actions workflow checks out the trusted base branch, uses the `ai-local` runner label, and keeps `autoMerge` disabled by default. A workflow dispatch may opt into its configured merge policy only after human review of that policy.

## Run lifecycle and recovery

Each target project has `.agent/projects/<project-id>/run.lock.json`. The lock records run ID, PID, host, and acquisition time. A live owner is never removed. A same-host dead PID is recoverable; a different-host lock younger than 24 hours requires operator reconciliation. Inspect the lock and process before removing anything.

On controller restart, durable snapshots and JSONL events are loaded. An old `ACTIVE`, pause-requested, or stop-requested run becomes `INTERRUPTED` when its lock owner is not live. Review the event log and target branch/PR before starting a new invocation; the stable branch and PR marker prevent duplicate delivery.

To stop a local run, use the UI Stop action. It terminates the child process group (or the Windows process tree) and records `CANCELLED`. A timeout records `FAILED` with a timeout reason. Do not kill unrelated PIDs or delete a broad `.agent` directory.

## Blocked runs and human actions

Auth, quota, failed checks, reviewer decisions, and missing evidence produce a blocked or terminal run with a durable reason. Review the run log and evidence, then approve, reject, defer, edit the story through its diff preview, or queue an instruction. Queued instructions are applied only to an explicitly logged next invocation.

## Cleanup and pilot limitations

Cancel an uncommitted scaffold only through the scaffold cancel action; it removes only the named scaffold worktree. Preserve branches and PRs until their evidence has been reconciled. Docker/Compose smoke lifecycle, full GitHub status pagination, and a real private-repository/Codex pilot remain opt-in follow-up work.
