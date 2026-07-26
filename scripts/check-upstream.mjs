#!/usr/bin/env node
// Background check that nudges the user when upstream has new commits.
// Runs in parallel with dev.mjs startup; silent on no-op or failure.
//
// Opt out: set DANIEL_UPSTREAM_CHECK=false in .env.local, or comment out the
// `spawn("node", ["scripts/check-upstream.mjs"], ...)` block in scripts/dev.mjs.
//
// Behavior matrix:
//   - DANIEL_UPSTREAM_CHECK=false → silent (disabled)
//   - upstream remote + new commits → banner w/ count + /upgrade-daniel instruction
//   - upstream remote, up to date   → silent
//   - no upstream + forked origin   → one-line hint on how to add upstream
//   - no upstream + canonical origin → silent

import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import metadata from "../project-metadata.json" with { type: "json" };

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const FETCH_TIMEOUT_MS = 5000;
const {
  canonicalRepository: CANONICAL_REPOSITORY,
  defaultBranch: DEFAULT_BRANCH,
  repositorySlug: REPOSITORY_SLUG,
  upgradeCommand: UPGRADE_COMMAND,
} = metadata;

const C = {
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  yellow: "\x1b[33m",
  reset: "\x1b[0m",
};

function tryExec(cmd) {
  try {
    return execSync(cmd, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function isAncestor(ref) {
  try {
    execSync(`git merge-base --is-ancestor ${ref} HEAD`, { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function fetchUpstream() {
  return new Promise((resolveFn) => {
    const child = spawn("git", ["fetch", "upstream", DEFAULT_BRANCH, "--quiet"], {
      cwd: root,
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      child.kill();
      resolveFn(false);
    }, FETCH_TIMEOUT_MS);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolveFn(code === 0);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolveFn(false);
    });
  });
}

function printBehindBanner(ahead) {
  const pad = (s, n) => s + " ".repeat(Math.max(0, n - stripAnsi(s).length));
  const line = `📦  ${ahead} new commit${ahead === 1 ? "" : "s"} upstream on ${REPOSITORY_SLUG}`;
  const cmd = `${C.bold}${UPGRADE_COMMAND}${C.reset}${C.yellow}`;
  console.log(`
${C.yellow}╭──────────────────────────────────────────────────────────────╮
│ ${pad(line, 60)} │
│                                                              │
│ Open Daniel in this repo and run:                            │
│   ${pad(cmd, 58)} │
│                                                              │
│ Previews diffs, tags a rollback, merges, surfaces [BREAKING] │
│ entries in CHANGELOG.                                        │
╰──────────────────────────────────────────────────────────────╯${C.reset}
`);
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function printNoUpstreamHint() {
  console.log(
    `${C.dim}  ℹ Tip: set up upstream for new-version checks on \`npm run dev\`:
     ${C.bold}git remote add upstream ${CANONICAL_REPOSITORY}${C.reset}${C.dim}
     Then open Daniel in this repo and run \`${UPGRADE_COMMAND}\`
     whenever upstream has changes.${C.reset}
`,
  );
}

function normalizedRepository(remote) {
  return remote
    .trim()
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

function isCanonicalRemote(remote) {
  return normalizedRepository(remote) === normalizedRepository(CANONICAL_REPOSITORY);
}

// Opt-out via env var. Reads .env.local the same way dev.mjs does so users
// don't have to export variables in their shell to disable the check.
function readEnvLocal() {
  const p = resolve(root, ".env.local");
  if (!existsSync(p)) return {};
  const out = {};
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*?)(?:\s+#.*)?$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const envFromFile = readEnvLocal();
const upstreamCheckEnabled =
  (process.env.DANIEL_UPSTREAM_CHECK ?? envFromFile.DANIEL_UPSTREAM_CHECK ?? "true") !== "false";
if (!upstreamCheckEnabled) process.exit(0);

(async () => {
  const upstreamUrl = tryExec("git remote get-url upstream");

  if (!upstreamUrl) {
    const originUrl = tryExec("git remote get-url origin") || "";
    // Canonical clone (rare) or fork-with-no-upstream (common). Only nag the
    // latter — if this user IS the upstream they have nothing to pull.
    if (!isCanonicalRemote(originUrl)) {
      printNoUpstreamHint();
    }
    return;
  }

  const fetched = await fetchUpstream();
  if (!fetched) return; // offline, perms, network — fail open

  const upstreamHead = tryExec(`git rev-parse upstream/${DEFAULT_BRANCH}`);
  if (!upstreamHead) return;

  if (isAncestor(upstreamHead)) return; // already have it

  const ahead = parseInt(tryExec(`git rev-list --count HEAD..${upstreamHead}`) || "0", 10);
  if (!ahead) return;
  printBehindBanner(ahead);
})().catch(() => {
  /* never block startup on failure */
});
