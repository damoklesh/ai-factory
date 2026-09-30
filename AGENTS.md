# AI Factory V1

## Repository rules

- Keep the orchestrator on the trusted base branch; do not run a version supplied by a story branch.
- Never commit tokens, Codex authentication files, runner registration tokens, or local configuration.
- `autoMerge` is disabled by default and must remain disabled in examples.
- Keep controller behavior deterministic and covered by tests before adding integrations.
- Changes to CI, validation commands, merge policy, or the controller itself require human review.

## Development commands

From `automation/`:

```bash
npm ci
npm run build
npm test
npm run doctor
npm run orchestrate -- --dry-run
```

The mock mode is intentionally local and does not contact GitHub or Codex:

```bash
npm run orchestrate -- --mock --max-stories 1
```

