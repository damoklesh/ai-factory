import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "./processes.js";
import { parseReviewResult, validateDeveloperResult } from "./result.js";
import type { CodexExecution, ReviewResult } from "./types.js";

export class CodexRunError extends Error {
  constructor(message: string, readonly kind: "AUTH" | "QUOTA" | "FAILED") { super(message); }
}

export class CodexRunner {
  constructor(private readonly root: string, private readonly model?: string) {}

  private async execute(prompt: string, schema: string, outputName: string, cwd: string, timeoutMs: number): Promise<CodexExecution> {
    const outputPath = join(cwd, `.ai-factory-${outputName}.json`);
    const args = ["exec", "--sandbox", "workspace-write", "--json", "--output-schema", join(this.root, "automation", "schemas", schema), "-o", outputPath];
    if (this.model) args.push("--model", this.model);
    args.push("-");
    const result = await runProcess("codex", args, { cwd, input: prompt, timeoutMs });
    let parsed: unknown;
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
  }

  async developer(prompt: string, cwd: string, timeoutMs: number): Promise<{ summary: string; tests: string[]; risks: string[] }> {
    const execution = await this.execute(prompt, "developer-result.json", "developer-result", cwd, timeoutMs);
    validateDeveloperResult(execution.result);
    return execution.result;
  }

  async reviewer(prompt: string, cwd: string, timeoutMs: number): Promise<ReviewResult> {
    const execution = await this.execute(prompt, "review-result.json", "review-result", cwd, timeoutMs);
    return parseReviewResult(execution.result);
  }
}

