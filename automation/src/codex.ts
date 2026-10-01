import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runProcess, type ProcessResult } from "./processes.js";
import { parseReviewResult, validateDeveloperResult } from "./result.js";
import type { CodexExecution, ReviewResult } from "./types.js";

export interface CodexAgentConfig { model?: string; reasoning?: "low" | "medium" | "high"; }

export class CodexRunError extends Error {
  constructor(message: string, readonly kind: "AUTH" | "QUOTA" | "FAILED") { super(message); }
}

export class CodexRunner {
  private readonly developerConfig: CodexAgentConfig;
  private readonly reviewerConfig: CodexAgentConfig;
  private readonly processRunner: typeof runProcess;
  constructor(private readonly root: string, developer: string | CodexAgentConfig | undefined = undefined, reviewerOrRunner?: string | CodexAgentConfig | typeof runProcess, processRunner: typeof runProcess = runProcess) {
    this.developerConfig = typeof developer === "string" ? { model: developer } : developer || {};
    if (typeof reviewerOrRunner === "function") { this.reviewerConfig = this.developerConfig; this.processRunner = reviewerOrRunner; }
    else { this.reviewerConfig = typeof reviewerOrRunner === "string" ? { model: reviewerOrRunner } : reviewerOrRunner || this.developerConfig; this.processRunner = processRunner; }
  }

  private async execute(prompt: string, schema: string, outputName: string, cwd: string, timeoutMs: number, agent: CodexAgentConfig, sandbox: "workspace-write" | "read-only" = "workspace-write"): Promise<CodexExecution> {
    const outputPath = join(tmpdir(), `ai-factory-${process.pid}-${outputName}.json`);
    const args = ["exec", "--sandbox", sandbox, "--json", "--output-schema", join(this.root, "automation", "schemas", schema), "-o", outputPath];
    if (agent.model) args.push("--model", agent.model);
    if (agent.reasoning) args.push("-c", `model_reasoning_effort=${agent.reasoning}`);
    args.push("-");
    const command = process.platform === "win32" ? "codex.cmd" : "codex";
    const result: ProcessResult = await this.processRunner(command, args, { cwd, input: prompt, timeoutMs, shell: process.platform === "win32" });
    let parsed: unknown;
    try {
      try { parsed = JSON.parse(await readFile(outputPath, "utf8")); } catch {
        if (result.code !== 0) {
          const combined = `${result.stderr}\n${result.stdout}`.toLowerCase();
          const kind = /quota|rate limit|usage limit/.test(combined) ? "QUOTA" : /auth|login|token|unauthorized/.test(combined) ? "AUTH" : "FAILED";
          throw new CodexRunError(`Codex failed: ${result.stderr.trim() || result.stdout.trim() || "no output"}`, kind);
        }
        throw new CodexRunError("Codex completed without a valid JSON result", "FAILED");
      }
      if (result.code !== 0) throw new CodexRunError(`Codex exited with ${result.code}: ${result.stderr.trim()}`, "FAILED");
      return { exitCode: result.code, output: result.stdout, errorOutput: result.stderr, result: parsed };
    } finally {
      await unlink(outputPath).catch(() => undefined);
    }
  }

  async developer(prompt: string, cwd: string, timeoutMs: number): Promise<{ summary: string; tests: string[]; risks: string[] }> {
    const execution = await this.execute(prompt, "developer-result.json", "developer-result", cwd, timeoutMs, this.developerConfig);
    validateDeveloperResult(execution.result);
    return execution.result;
  }

  async reviewer(prompt: string, cwd: string, timeoutMs: number): Promise<ReviewResult> {
    const execution = await this.execute(prompt, "review-result.json", "review-result", cwd, timeoutMs, this.reviewerConfig, "read-only");
    return parseReviewResult(execution.result);
  }
}
