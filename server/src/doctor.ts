import { execFile } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ProjectDoctorReport, ProjectStack, ScaffoldPlan, ScaffoldResult } from "@ai-factory/contracts";

const execFileAsync = promisify(execFile);
type ConcreteStack = Exclude<ProjectStack, "mixed" | "unknown">;
const signals: Array<{ stack: ConcreteStack; files: string[]; reason: string }> = [
  { stack: "node", files: ["package.json"], reason: "Node package manifest" },
  { stack: "java", files: ["pom.xml", "build.gradle", "build.gradle.kts"], reason: "Java build manifest" },
  { stack: "python", files: ["pyproject.toml", "requirements.txt", "setup.py"], reason: "Python project manifest" },
  { stack: "go", files: ["go.mod"], reason: "Go module manifest" },
];

export async function inspectProject(root: string): Promise<ProjectDoctorReport> {
  const names = await readdir(root); const lower = new Map(names.map((name) => [name.toLowerCase(), name])); const detected = new Set<ConcreteStack>(); const evidence: ProjectDoctorReport["evidence"] = [];
  for (const signal of signals) for (const file of signal.files) if (lower.has(file.toLowerCase())) { detected.add(signal.stack); evidence.push({ path: lower.get(file.toLowerCase())!, reason: signal.reason }); }
  for (const name of names.filter((item) => /\.(sln|csproj)$/i.test(item))) { detected.add("dotnet"); evidence.push({ path: name, reason: ".NET solution or project" }); }
  const detectedStacks = [...detected].sort() as ConcreteStack[]; const stack: ProjectStack = detectedStacks.length === 0 ? "unknown" : detectedStacks.length === 1 ? detectedStacks[0] : "mixed";
  const documentation = await Promise.all(["README.md", "AGENTS.md", join("docs", "DEVELOPMENT.md")].map(async (path) => ({ path, exists: await exists(join(root, path)) })));
  return { stack, detectedStacks, confidence: stack === "unknown" ? "UNKNOWN" : stack === "mixed" ? "AMBIGUOUS" : "CONFIRMED", evidence, validationCommands: await discoverCommands(root, detectedStacks), documentation, inspectedAt: new Date().toISOString() };
}

export async function planScaffold(root: string, confirmedStack: ConcreteStack): Promise<ScaffoldPlan> {
  const report = await inspectProject(root); if (!(["node", "java", "python", "dotnet", "go"] as string[]).includes(confirmedStack)) throw new Error("STACK_CONFIRMATION_REQUIRED");
  const definitions = scaffoldDefinitions(confirmedStack, report.validationCommands); const files = await Promise.all(definitions.map(async (item) => ({ path: item.path, action: await exists(join(root, item.path)) ? "KEEP" as const : "CREATE" as const, purpose: item.purpose })));
  return { stack: confirmedStack, files, validationCommands: report.validationCommands.length ? report.validationCommands : defaultCommands(confirmedStack), requiresConfirmation: true };
}

export async function applyScaffold(root: string, stateRoot: string, plan: ScaffoldPlan, confirm: boolean): Promise<ScaffoldResult> {
  if (!confirm) throw new Error("SCAFFOLD_CONFIRMATION_REQUIRED");
  const branch = "ai-factory/scaffold"; const worktreePath = join(stateRoot, "scaffold-worktree");
  if (await exists(worktreePath)) throw new Error("SCAFFOLD_WORKTREE_ALREADY_EXISTS");
  await mkdir(dirname(worktreePath), { recursive: true });
  await execFileAsync("git", ["-C", root, "worktree", "add", "-b", branch, worktreePath], { windowsHide: true });
  const definitions = scaffoldDefinitions(plan.stack, plan.validationCommands); const filesCreated: string[] = []; const filesKept: string[] = [];
  for (const definition of definitions) {
    const path = join(worktreePath, definition.path); if (await exists(path)) { filesKept.push(definition.path); continue; }
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, definition.content, "utf8"); filesCreated.push(definition.path);
  }
  const validation = plan.validationCommands.map((command) => ({ command, status: "SKIPPED" as const, detail: "Run after reviewing and installing the confirmed stack dependencies." }));
  return { branch, worktreePath, filesCreated, filesKept, validation };
}

export async function cancelScaffold(root: string, stateRoot: string): Promise<void> { const worktreePath = join(stateRoot, "scaffold-worktree"); if (await exists(worktreePath)) await execFileAsync("git", ["-C", root, "worktree", "remove", "--force", worktreePath], { windowsHide: true }); }

async function discoverCommands(root: string, stacks: ConcreteStack[]): Promise<string[]> {
  const commands: string[] = [];
  if (stacks.includes("node") && await exists(join(root, "package.json"))) { try { const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> }; if (pkg.scripts?.build) commands.push("npm run build"); if (pkg.scripts?.test) commands.push("npm test"); } catch { /* malformed manifests remain evidence but yield no commands */ } }
  if (stacks.includes("java")) commands.push(await exists(join(root, "mvnw")) || await exists(join(root, "mvnw.cmd")) ? "./mvnw test" : await exists(join(root, "gradlew")) || await exists(join(root, "gradlew.bat")) ? "./gradlew test" : "mvn test");
  if (stacks.includes("python")) commands.push("python -m pytest"); if (stacks.includes("dotnet")) commands.push("dotnet test"); if (stacks.includes("go")) commands.push("go test ./..."); return [...new Set(commands)];
}
function defaultCommands(stack: ConcreteStack): string[] { return { node: ["npm test"], java: ["mvn test"], python: ["python -m pytest"], dotnet: ["dotnet test"], go: ["go test ./..."] }[stack]; }
function scaffoldDefinitions(stack: ConcreteStack, commands: string[]): Array<{ path: string; purpose: string; content: string }> {
  const validation = (commands.length ? commands : defaultCommands(stack)).map((command) => `- \`${command}\``).join("\n");
  const common = [
    { path: "README.md", purpose: "project setup and purpose", content: `# Project\n\nTechnology: ${stack}.\n\n## Validation\n\n${validation}\n` },
    { path: "AGENTS.md", purpose: "repository-local agent guidance", content: `# Repository guidance\n\nConfirmed stack: ${stack}.\n\n## Validation\n\n${validation}\n\nReview diffs before committing. Do not store credentials.\n` },
    { path: join("docs", "DEVELOPMENT.md"), purpose: "concise development workflow", content: `# Development\n\nInstall the ${stack} toolchain, then run:\n\n${validation}\n` },
  ];
  const skeleton = stack === "java" ? [{ path: "pom.xml", purpose: "minimal Java build manifest", content: "<project xmlns=\"http://maven.apache.org/POM/4.0.0\"><modelVersion>4.0.0</modelVersion><groupId>local.project</groupId><artifactId>project</artifactId><version>0.1.0</version></project>\n" }] : stack === "python" ? [{ path: "pyproject.toml", purpose: "minimal Python project manifest", content: "[project]\nname = \"project\"\nversion = \"0.1.0\"\nrequires-python = \">=3.11\"\n" }] : [];
  return [...common, ...skeleton];
}
async function exists(path: string): Promise<boolean> { return access(path).then(() => true).catch(() => false); }
