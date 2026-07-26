import { execFile } from "node:child_process";
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG_DIRECTORY } from "../project-metadata.js";

const execFileAsync = promisify(execFile);

export interface WorkspaceSetupOptions {
  projectKey: string;
  repoUrl?: string;
  branch?: string;
}

export interface WorkspaceSetupResult {
  workspacePath: string;
  created: boolean;
}

export function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}

export function codingWorkspaceRoot(): string {
  return expandHome(process.env.DANIEL_PROJECTS_ROOT?.trim() || "~/daniel-projects");
}

export function safeProjectKey(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function randomProjectKey(): string {
  return `code_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function workspacePathForProjectKey(projectKey: string): string {
  return join(codingWorkspaceRoot(), safeProjectKey(projectKey) || randomProjectKey());
}

export function inferProjectTitle(opts: {
  task: string;
  projectHint?: string;
  repoUrl?: string;
}): string {
  const explicit = opts.projectHint?.trim();
  if (explicit) return explicit.slice(0, 80);

  if (opts.repoUrl) {
    const last = opts.repoUrl.split(/[/:]/).filter(Boolean).pop() ?? "coding-project";
    return last.replace(/\.git$/i, "").replace(/[-_]+/g, " ").slice(0, 80);
  }

  const words = opts.task
    .replace(/[^\w\s-]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
  return (words.join(" ") || "Daniel coding project").slice(0, 80);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function isEmptyDirectory(path: string): Promise<boolean> {
  if (!(await pathExists(path))) return true;
  const entries = await readdir(path);
  return entries.length === 0;
}

async function cloneRepo(opts: WorkspaceSetupOptions, workspacePath: string): Promise<void> {
  if (!opts.repoUrl) return;
  const args = ["clone", "--depth", "1"];
  if (opts.branch) args.push("--branch", opts.branch);
  args.push(opts.repoUrl, workspacePath);
  await execFileAsync("git", args, { timeout: 120_000 });
}

async function writeEnvExample(workspacePath: string): Promise<void> {
  const envExamplePath = join(workspacePath, ".env.example");
  if (await pathExists(envExamplePath)) return;
  await writeFile(
    envExamplePath,
    [
      "# Photon Spectrum",
      "PHOTON_PROJECT_ID=",
      "PHOTON_PROJECT_SECRET=",
      "PHOTON_IMESSAGE_PHONE=",
      "",
      "# Convex",
      "CONVEX_DEPLOYMENT=",
      "VITE_CONVEX_URL=",
      "",
    ].join("\n"),
  );
}

async function ensureGitignore(workspacePath: string): Promise<void> {
  const gitignorePath = join(workspacePath, ".gitignore");
  const required = [
    ".env",
    ".env.*",
    "!.env.example",
    `${DEFAULT_CONFIG_DIRECTORY}/`,
  ];
  const existing = (await pathExists(gitignorePath))
    ? await readFile(gitignorePath, "utf8")
    : "";
  const missing = required.filter((line) => !existing.split(/\r?\n/).includes(line));
  if (missing.length === 0) return;
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  await writeFile(
    gitignorePath,
    `${existing}${prefix}${missing.join("\n")}\n`,
  );
}

async function copyPhotonSkill(workspacePath: string): Promise<void> {
  const source = fileURLToPath(new URL("../../skills/photon-spectrum", import.meta.url));
  if (!(await pathExists(source))) return;
  const destination = join(workspacePath, ".agents", "skills", "photon-spectrum");
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
}

export async function setupCodingWorkspace(
  opts: WorkspaceSetupOptions,
): Promise<WorkspaceSetupResult> {
  const workspacePath = workspacePathForProjectKey(opts.projectKey);
  await mkdir(codingWorkspaceRoot(), { recursive: true });

  let created = false;
  if (opts.repoUrl && (await isEmptyDirectory(workspacePath))) {
    await cloneRepo(opts, workspacePath);
    created = true;
  } else {
    const existed = await pathExists(workspacePath);
    await mkdir(workspacePath, { recursive: true });
    created = !existed;
  }

  await copyPhotonSkill(workspacePath);
  await writeEnvExample(workspacePath);
  await ensureGitignore(workspacePath);

  return { workspacePath, created };
}
