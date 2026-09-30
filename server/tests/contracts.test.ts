import test from "node:test";
import assert from "node:assert/strict";
import { ContractValidationError, parseDecisionRequest, parseInstructionRequest, parseStartRunRequest } from "@ai-factory/contracts";

test("shared contracts validate run, decision, and instruction inputs", () => {
  assert.deepEqual(parseStartRunRequest({ maxStories: 2, autoMerge: false }), { maxStories: 2, autoMerge: false });
  assert.throws(() => parseStartRunRequest({ maxStories: 0, autoMerge: false }), ContractValidationError);
  assert.deepEqual(parseDecisionRequest({ decision: "REJECT", reason: "needs evidence", idempotencyKey: "k1" }).decision, "REJECT");
  assert.throws(() => parseDecisionRequest({ decision: "REJECT", idempotencyKey: "k1" }), /rejection reason/);
  assert.deepEqual(parseInstructionRequest({ content: "Please inspect the fixture", expectedRunStatus: "PAUSED", idempotencyKey: "k2" }).content, "Please inspect the fixture");
  assert.throws(() => parseInstructionRequest({ content: "", expectedRunStatus: "ACTIVE", idempotencyKey: "k2" }), /content/);
});
