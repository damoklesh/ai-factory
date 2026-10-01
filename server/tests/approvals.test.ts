import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalRequest } from "@ai-factory/contracts";
import { AgentPersistence } from "../src/persistence.js";
import { LocalController } from "../src/controller.js";

const approval = (type: ApprovalRequest["type"], evidence = ["reviewer evidence: ready"]): ApprovalRequest => ({ schemaVersion: 1, requestId: `${type}-1`, runId: "run-1", storyId: "US-1", type, status: "PENDING", problem: "A decision is needed", evidence, proposedAction: "Continue at the next safe point", expectedHeadSha: "sha-current", expectedSpecRevision: "spec-current", createdAt: new Date().toISOString() });

test("approves, rejects with a reason, defers and applies idempotency", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-factory-approvals-"));
  const persistence = new AgentPersistence(root); const controller = new LocalController(persistence, { approvals: [approval("CLARIFICATION"), approval("SCOPE_CHANGE")] });
  const approved = await controller.decideApproval("CLARIFICATION-1", { decision: "APPROVE", expectedHeadSha: "sha-current", expectedSpecRevision: "spec-current", idempotencyKey: "same" });
  assert.equal(approved.status, "APPROVED");
  assert.deepEqual(await controller.decideApproval("CLARIFICATION-1", { decision: "APPROVE", expectedHeadSha: "sha-current", expectedSpecRevision: "spec-current", idempotencyKey: "same" }), approved);
  const restarted = new LocalController(persistence, { approvals: [approval("CLARIFICATION")] }); assert.deepEqual(await restarted.decideApproval("CLARIFICATION-1", { decision: "APPROVE", expectedHeadSha: "sha-current", expectedSpecRevision: "spec-current", idempotencyKey: "same" }), approved);
  await assert.rejects(() => controller.decideApproval("SCOPE_CHANGE-1", { decision: "REJECT", expectedHeadSha: "sha-current", expectedSpecRevision: "spec-current", idempotencyKey: "reject" }), /reason/);
  const rejected = await controller.decideApproval("SCOPE_CHANGE-1", { decision: "REJECT", reason: "Need product confirmation", expectedHeadSha: "sha-current", expectedSpecRevision: "spec-current", idempotencyKey: "reject" });
  assert.equal(rejected.status, "REJECTED");
});

test("rejects stale approvals and merge approvals with failed checks", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-factory-stale-"));
  const controller = new LocalController(new AgentPersistence(root), { approvals: [approval("MERGE", ["CI checks failed: test suite"]) ] });
  await assert.rejects(() => controller.decideApproval("MERGE-1", { decision: "APPROVE", expectedHeadSha: "sha-old", expectedSpecRevision: "spec-current", idempotencyKey: "stale" }), /STALE_APPROVAL/);
  await assert.rejects(() => controller.decideApproval("MERGE-1", { decision: "APPROVE", expectedHeadSha: "sha-current", expectedSpecRevision: "spec-current", idempotencyKey: "failed-ci" }), /MERGE_CHECKS_NOT_PASSING/);
});
