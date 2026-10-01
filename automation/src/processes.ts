import { spawn } from "node:child_process";

export interface ProcessResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; }

export function runProcess(command: string, args: string[], options: { cwd: string; input?: string; timeoutMs: number; shell?: boolean; env?: NodeJS.ProcessEnv; windowsVerbatimArguments?: boolean }): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, shell: options.shell ?? false, windowsHide: true, windowsVerbatimArguments: options.windowsVerbatimArguments });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
    if (options.input !== undefined) child.stdin.end(options.input);
  });
}

export async function runShellCommand(command: string, cwd: string, timeoutMs: number): Promise<ProcessResult> {
  // Do not use Node's shell:true mode: recent Node versions warn when command
  // arguments are concatenated, and the warning was being surfaced as an
  // orchestrator error. Invoke the platform shell explicitly instead.
  if (process.platform === "win32") return runProcess(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], { cwd, timeoutMs, windowsVerbatimArguments: true });
  return runProcess("/bin/sh", ["-lc", command], { cwd, timeoutMs });
}
