# Backlog story format

The selected target project's `backlog/*.md` files are the canonical story
specifications. AI Factory validates the complete backlog before publishing an
Issue or starting a run. Validation errors include the source file and line.

Use the template exposed by `GET /api/stories/template` and shown in the
Backlog tab. The required contract is:

```markdown
---
storyId: US-001
title: A short imperative title
priority: 1
dependencies: none
labels: agent:ready
---

# US-001 — A short imperative title

## User Story
As a user, I want a capability so that I receive a concrete benefit.

## Context
Relevant constraints and references.

## Scope
- In scope: ...
- Out of scope: ...

## Acceptance Criteria
- [ ] AC-1: An observable, testable outcome.

## Technical Notes
- Preserve the target repository's stack and conventions.

## Validation
- [ ] Run the repository's documented checks.

## Human Decisions
None
```

`storyId` must match `US-###`, priority is a positive integer, and dependencies
are comma-separated story IDs or `none`. IDs and acceptance-criterion numbers
must be unique. Every dependency must resolve and the graph must be acyclic.

The exact required level-two headings are `User Story`, `Scope`, `Acceptance
Criteria`, and `Validation`. Known legacy English or Spanish headings are read
only as an explicit migration path and produce a deprecation warning; unknown
aliases are not interpreted silently. Unknown frontmatter keys also produce a
warning. Errors block synchronization and execution, while warnings remain
visible for a human to migrate.
