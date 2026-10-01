# AI Factory V1 setup

The automation is intentionally local-first. It needs Node 20+, Git, the Codex CLI, and a private GitHub repository. GitHub CLI is useful for setup but is not required by the controller.

1. Copy `automation/config.example.json` to `automation/config.json` and set the repository and validation commands. Keep this ignored file on the trusted runner; do not commit it. Set `AI_FACTORY_CONFIG` if it lives outside `automation/`.
2. From `automation/`, run `npm ci`, `npm run doctor`, `npm test`, and `npm run orchestrate -- --dry-run`.
3. Set `AGENT_GH_TOKEN` only in the runner environment. The token needs repository-scoped Contents, Issues, Pull requests, and Actions read permissions as required by the configured flow; the controller reads workflow jobs through Actions API and does not require the unavailable Checks permission on a fine-grained PAT.
4. Authenticate Codex as the same Linux user that will run the self-hosted runner. Confirm its exact CLI flags with `codex exec --help` before a real run.
5. Register a self-hosted Linux runner with label `ai-local` in a separate runner directory. Do not store the temporary registration token in this repository.
6. Create small Issues using `.github/ISSUE_TEMPLATE/agent-story.yml`, add `agent:ready`, and run one story with `autoMerge` disabled.

The dry-run, mock mode, and unit tests do not contact GitHub, create worktrees, invoke Codex, or merge pull requests. A missing GitHub or Codex login is a real-pilot blocker, not a test failure. The manual Action uses the checked-out trusted controller, requires the runner-local config, and forwards its `auto_merge` input only when explicitly enabled.
