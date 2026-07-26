#!/usr/bin/env tsx
import prompts from "prompts";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const ENV_PATH = resolve(ROOT, ".env.local");
const EXAMPLE_PATH = resolve(ROOT, ".env.example");

type RuntimeChoice = "claude" | "codex";

const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6";
const DEFAULT_CODEX_MODEL = "gpt-5.5";
const DEFAULT_CODEX_REASONING_EFFORT = "medium";

const CLAUDE_MODEL_CHOICES = [
  { title: "claude-sonnet-4-6 (recommended)", value: "claude-sonnet-4-6" },
  { title: "claude-opus-4-6 (slowest, most capable)", value: "claude-opus-4-6" },
  { title: "claude-haiku-4-5 (fastest, cheapest)", value: "claude-haiku-4-5" },
];

const CODEX_MODEL_CHOICES = [
  { title: "gpt-5.5 (most capable)", value: "gpt-5.5" },
  { title: "gpt-5.4-mini (faster local testing)", value: "gpt-5.4-mini" },
  { title: "gpt-5.4 (balanced)", value: "gpt-5.4" },
  { title: "gpt-5.3-codex (coding optimized)", value: "gpt-5.3-codex" },
];

const CODEX_REASONING_CHOICES = [
  { title: "low (fastest)", value: "low" },
  { title: "medium (recommended)", value: "medium" },
  { title: "high (deeper reasoning)", value: "high" },
  { title: "xhigh (maximum reasoning)", value: "xhigh" },
];

function runtimeFromEnv(value: string | undefined): RuntimeChoice {
  return value === "codex" ? "codex" : "claude";
}

function initialForChoice<T extends readonly { value: string }[]>(
  choices: T,
  value: string | undefined,
  fallback = 0,
): number {
  const index = choices.findIndex((choice) => choice.value === value);
  return index >= 0 ? index : fallback;
}

function readEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const lines = readFileSync(path, "utf8").split("\n");
  const env: Record<string, string> = {};
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

function writeEnv(path: string, env: Record<string, string>): void {
  const example = existsSync(EXAMPLE_PATH) ? readFileSync(EXAMPLE_PATH, "utf8") : "";

  let out = "";
  const seen = new Set<string>();
  const sections = example.split(/\n(?=# ----)/);

  for (const section of sections) {
    const sectionKeys = [...section.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]);
    let s = section;
    for (const k of sectionKeys) {
      // Remove ALL existing occurrences of this key in the section (dedupe).
      const pattern = new RegExp(`^${k}=.*(\\r?\\n)?`, "gm");
      const matches = [...s.matchAll(pattern)];
      if (matches.length === 0) continue;

      if (seen.has(k)) {
        // Already written in an earlier section — just strip any re-occurrences.
        s = s.replace(pattern, "");
        continue;
      }

      const v = env[k] ?? "";
      // Replace first occurrence, remove the rest.
      let replaced = false;
      s = s.replace(pattern, (match) => {
        if (!replaced) {
          replaced = true;
          return `${k}=${v}` + (match.endsWith("\n") ? "\n" : "");
        }
        return "";
      });
      seen.add(k);
    }
    out += s + "\n";
  }
  writeFileSync(path, out.trim() + "\n");
}

function cleanConvexUrlEnv(path: string): void {
  const envContent = readFileSync(path, "utf8");
  const updated = envContent.replace(/^(?:CONVEX_URL|VITE_CONVEX_URL)=.*(\r?\n)?/gm, "");
  writeFileSync(path, updated);
}

function banner(s: string) {
  console.log("\n" + "━".repeat(60));
  console.log("  " + s);
  console.log("━".repeat(60));
}

async function runConvexDev(): Promise<void> {
  // If CONVEX_DEPLOYMENT is already set, `convex dev` reuses that deployment.
  // Only pass --configure new if this is a first-time setup — otherwise re-running
  // setup would silently create a new project and abandon all existing data.
  const existing = readEnv(ENV_PATH);
  const args = existing.CONVEX_DEPLOYMENT
    ? ["convex", "dev", "--once"]
    : ["convex", "dev", "--once", "--configure", "new"];

  if (!existing.CONVEX_DEPLOYMENT) {
    // Remove old Convex URLs from the env file to allow convex cli to populate
    // the Vite URL cleanly.
    cleanConvexUrlEnv(ENV_PATH);
  }

  console.log(
    `\nLaunching \`npx ${args.join(" ")}\` to configure your deployment.`,
  );
  console.log("Convex will open a browser window if you're not logged in.");
  if (existing.CONVEX_DEPLOYMENT) {
    console.log(`Reusing existing deployment: ${existing.CONVEX_DEPLOYMENT}`);
  }

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("npx", args, { stdio: "inherit", cwd: ROOT });
    child.on("exit", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`convex dev exited ${code}`)),
    );
  });
}

function hasBinary(name: string): Promise<boolean> {
  return new Promise((ok) => {
    const lookup = process.platform === "win32" ? "where" : "which";
    const child = spawn(lookup, [name], { stdio: "ignore" });
    child.on("exit", (code) => ok(code === 0));
    child.on("error", () => ok(false));
  });
}

function openInBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* ignore — fall back to the printed URL */
  }
}

function runInherit(cmd: string, args: string[]): Promise<void> {
  return new Promise((ok, fail) => {
    const child = spawn(cmd, args, { stdio: "inherit", cwd: ROOT });
    child.on("exit", (code) =>
      code === 0 ? ok() : fail(new Error(`${cmd} ${args.join(" ")} exited ${code}`)),
    );
    child.on("error", fail);
  });
}

function runCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((ok, fail) => {
    const child = spawn(cmd, args, { stdio: ["inherit", "pipe", "pipe"], cwd: ROOT });
    let out = "";
    child.stdout.on("data", (d) => {
      const s = d.toString();
      out += s;
      process.stdout.write(s);
    });
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("exit", (code) =>
      code === 0 ? ok(out) : fail(new Error(`${cmd} exited ${code}`)),
    );
    child.on("error", fail);
  });
}

function normalizeOptionalE164(raw: string | undefined): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return "";
  if (trimmed.startsWith("+")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^\d{11,15}$/.test(digits)) return `+${digits}`;
  return trimmed;
}

async function main() {
  banner("daniel setup");

  console.log(`
What this does:
  1. Captures your Photon Spectrum project credentials for iMessage
  2. Asks whether Daniel should use your Claude Code or Codex subscription
  3. Optionally enables local browser use
  4. Runs \`npx convex dev\` to create a Convex project
  5. Writes .env.local

Before you start:
  • Claude Code subscription if choosing Claude: https://claude.com/code
  • Codex/ChatGPT account if choosing Codex:     run \`codex login\`
  • Convex account (free tier):                  https://convex.dev
  • Photon Spectrum project:                     https://app.photon.codes
`);

  const existing = readEnv(ENV_PATH);
  const runtimeDefault = runtimeFromEnv(existing.DANIEL_RUNTIME);
  banner("Photon Spectrum — iMessage bridge");
  console.log(`
Daniel uses Photon Spectrum's cloud iMessage provider. Find PROJECT_ID and
SECRET_KEY in your Photon project settings. PHOTON_IMESSAGE_PHONE is optional;
set it only when you have a dedicated line and want all outbound DMs pinned
to that line.
`);

  const answers = await prompts(
    [
      {
        type: "text",
        name: "PHOTON_PROJECT_ID",
        message: "Photon project ID",
        initial: existing.PHOTON_PROJECT_ID ?? "",
      },
      {
        type: "password",
        name: "PHOTON_PROJECT_SECRET",
        message: "Photon project secret",
        initial: existing.PHOTON_PROJECT_SECRET ?? "",
      },
      {
        type: "text",
        name: "PHOTON_IMESSAGE_PHONE",
        message: "Photon dedicated iMessage line (optional, e.g. +1XXXXXXXXXX)",
        initial: existing.PHOTON_IMESSAGE_PHONE ?? "",
      },
      {
        type: "select",
        name: "DANIEL_RUNTIME",
        message: "Which subscription should Daniel use for the agent runtime?",
        choices: [
          {
            title: "Claude Code subscription",
            value: "claude",
            description: "Uses the Claude Agent SDK and your local `claude` login.",
          },
          {
            title: "Codex / ChatGPT subscription",
            value: "codex",
            description: "Uses local `codex app-server` auth from `codex login`.",
          },
        ],
        initial: runtimeDefault === "codex" ? 1 : 0,
      },
      {
        type: (_prev: unknown, values: Record<string, unknown>) =>
          values.DANIEL_RUNTIME === "claude" ? "select" : null,
        name: "DANIEL_MODEL",
        message: "Which Claude model should the agent use?",
        choices: CLAUDE_MODEL_CHOICES,
        initial: initialForChoice(CLAUDE_MODEL_CHOICES, existing.DANIEL_MODEL),
      },
      {
        type: (_prev: unknown, values: Record<string, unknown>) =>
          values.DANIEL_RUNTIME === "codex" ? "select" : null,
        name: "DANIEL_CODEX_MODEL",
        message: "Which Codex model should the agent use?",
        choices: CODEX_MODEL_CHOICES,
        initial: initialForChoice(CODEX_MODEL_CHOICES, existing.DANIEL_CODEX_MODEL),
      },
      {
        type: (_prev: unknown, values: Record<string, unknown>) =>
          values.DANIEL_RUNTIME === "codex" ? "select" : null,
        name: "DANIEL_CODEX_REASONING_EFFORT",
        message: "How much Codex reasoning effort should Daniel use?",
        choices: CODEX_REASONING_CHOICES,
        initial: initialForChoice(
          CODEX_REASONING_CHOICES,
          existing.DANIEL_CODEX_REASONING_EFFORT,
          1,
        ),
      },
      {
        type: "text",
        name: "PORT",
        message: "Local server port",
        initial: existing.PORT ?? "3456",
      },
      {
        type: "confirm",
        name: "runConvex",
        message: "Run `convex dev` now to configure your Convex deployment?",
        initial: true,
      },
    ],
    {
      onCancel: () => {
        console.log("Setup cancelled.");
        process.exit(1);
      },
    },
  );

  // Merge CLI-sourced defaults with what the user answered (answer wins).
  Object.assign(answers, {
    DANIEL_RUNTIME: answers.DANIEL_RUNTIME ?? runtimeDefault,
    DANIEL_MODEL: answers.DANIEL_MODEL ?? existing.DANIEL_MODEL ?? DEFAULT_CLAUDE_MODEL,
    DANIEL_CODEX_MODEL:
      answers.DANIEL_CODEX_MODEL ?? existing.DANIEL_CODEX_MODEL ?? DEFAULT_CODEX_MODEL,
    DANIEL_CODEX_REASONING_EFFORT:
      answers.DANIEL_CODEX_REASONING_EFFORT ??
      existing.DANIEL_CODEX_REASONING_EFFORT ??
      DEFAULT_CODEX_REASONING_EFFORT,
    PHOTON_PROJECT_ID: answers.PHOTON_PROJECT_ID ?? existing.PHOTON_PROJECT_ID ?? "",
    PHOTON_PROJECT_SECRET:
      answers.PHOTON_PROJECT_SECRET ?? existing.PHOTON_PROJECT_SECRET ?? "",
    PHOTON_IMESSAGE_PHONE: normalizeOptionalE164(
      answers.PHOTON_IMESSAGE_PHONE ?? existing.PHOTON_IMESSAGE_PHONE,
    ),
  });

  // ---- Composio API key ---------------------------------------------------
  banner("Composio — integrations (Gmail, Slack, GitHub, Linear, 1000+ more)");
  const composioSettingsUrl = "https://platform.composio.dev/settings";
  const existingComposio = existing.COMPOSIO_API_KEY ?? "";
  const { composioMode } = await prompts(
    {
      type: "select",
      name: "composioMode",
      message: existingComposio
        ? "Composio API key detected. Keep it or replace?"
        : "Configure Composio now? (needed to connect any integration)",
      choices: existingComposio
        ? [
            { title: "Keep existing key", value: "keep" },
            { title: "Replace (opens the Composio dashboard)", value: "replace" },
            { title: "Skip", value: "skip" },
          ]
        : [
            { title: "Yes — open the Composio dashboard and paste my key", value: "replace" },
            { title: "Skip for now", value: "skip" },
          ],
      initial: 0,
    },
    {
      onCancel: () => {
        console.log("Setup cancelled.");
        process.exit(1);
      },
    },
  );

  if (composioMode === "replace") {
    console.log(`\nOpening ${composioSettingsUrl} — grab your API key there.`);
    console.log(`(If the browser doesn't open, copy the URL above.)\n`);
    openInBrowser(composioSettingsUrl);
    const { COMPOSIO_API_KEY } = await prompts(
      {
        type: "password",
        name: "COMPOSIO_API_KEY",
        message: "Paste your Composio API key (leave blank to skip):",
        initial: "",
      },
      {
        onCancel: () => {
          console.log("Setup cancelled.");
          process.exit(1);
        },
      },
    );
    (answers as any).COMPOSIO_API_KEY = COMPOSIO_API_KEY || existingComposio;
  } else if (composioMode === "keep") {
    (answers as any).COMPOSIO_API_KEY = existingComposio;
  } else {
    (answers as any).COMPOSIO_API_KEY = existingComposio;
    console.log(
      `\nSkipped. Add COMPOSIO_API_KEY to .env.local later to enable integrations.`,
    );
  }

  // ---- Embedding provider --------------------------------------------------
  banner("Memory search — embedding provider");
  const existingVoyage = existing.VOYAGE_API_KEY ?? "";
  const existingOpenai = existing.OPENAI_API_KEY ?? "";
  const inferredCurrent = existingVoyage
    ? "voyage"
    : existingOpenai
      ? "openai"
      : "local";
  console.log(`
Daniel's recall() searches your stored memories by semantic similarity. Pick
how you want to generate embeddings:

  • Local  — free, runs in-process via @huggingface/transformers
            (Xenova/bge-large-en-v1.5, 1024-dim). First run downloads
            ~440MB and caches forever. No API key.
  • Voyage — paid, ~$0.06/M tokens. Slightly stronger English retrieval.
  • OpenAI — paid, ~$0.13/M tokens. Comparable to Voyage.

All three produce 1024-dim vectors (compatible with the same Convex index)
so you can switch later by adding/removing the API key.
`);
  const { embeddingProvider } = await prompts(
    {
      type: "select",
      name: "embeddingProvider",
      message: "Which embedding provider should daniel use?",
      choices: [
        { title: "Local (free, recommended)", value: "local" },
        { title: "Voyage (paid — I have a key)", value: "voyage" },
        { title: "OpenAI (paid — I have a key)", value: "openai" },
      ],
      initial:
        inferredCurrent === "voyage" ? 1 : inferredCurrent === "openai" ? 2 : 0,
    },
    {
      onCancel: () => {
        console.log("Setup cancelled.");
        process.exit(1);
      },
    },
  );

  if (embeddingProvider === "voyage") {
    const { VOYAGE_API_KEY } = await prompts({
      type: "password",
      name: "VOYAGE_API_KEY",
      message: "Paste your Voyage API key (https://dash.voyageai.com):",
      initial: existingVoyage,
    });
    (answers as any).VOYAGE_API_KEY = VOYAGE_API_KEY || "";
    (answers as any).OPENAI_API_KEY = "";
  } else if (embeddingProvider === "openai") {
    const { OPENAI_API_KEY } = await prompts({
      type: "password",
      name: "OPENAI_API_KEY",
      message: "Paste your OpenAI API key:",
      initial: existingOpenai,
    });
    (answers as any).OPENAI_API_KEY = OPENAI_API_KEY || "";
    (answers as any).VOYAGE_API_KEY = "";
  } else {
    // Local — clear any stale paid keys so embeddings.ts falls through to
    // the local provider on next start.
    (answers as any).VOYAGE_API_KEY = "";
    (answers as any).OPENAI_API_KEY = "";

    const { preload } = await prompts({
      type: "confirm",
      name: "preload",
      message:
        "Pre-download the local model now? (~440MB, ~30s on broadband — saves the wait on first recall)",
      initial: true,
    });
    if (preload) {
      console.log("\nDownloading Xenova/bge-large-en-v1.5… (Ctrl+C to skip)\n");
      try {
        await runInherit("npx", ["tsx", "scripts/preload-embeddings.ts"]);
        console.log("✓ Local model cached.");
      } catch (err) {
        console.warn(
          "Preload failed — model will download on first recall instead.",
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  // ---- Local browser use ---------------------------------------------------
  banner("Local browser use — optional");
  console.log(`
Daniel can optionally expose a local Patchright Chrome profile to spawned agents.
Use it for login-required services, visual browser workflows, or sites that
reject ordinary automation. It is off by default, and agents cannot see or use
the browser integration unless you enable it.
`);

  const { enableLocalBrowser } = await prompts(
    {
      type: "confirm",
      name: "enableLocalBrowser",
      message: "Enable Local browser use now?",
      initial: existing.DANIEL_BROWSER_ENABLED === "true",
    },
    {
      onCancel: () => {
        console.log("Setup cancelled.");
        process.exit(1);
      },
    },
  );
  (answers as any).DANIEL_BROWSER_ENABLED = enableLocalBrowser ? "true" : "false";

  if (enableLocalBrowser) {
    const { installBrowser } = await prompts(
      {
        type: "confirm",
        name: "installBrowser",
        message: "Install the Patchright Chrome browser binary now?",
        initial: false,
      },
      {
        onCancel: () => {
          console.log("Setup cancelled.");
          process.exit(1);
        },
      },
    );
    if (installBrowser) {
      console.log("\nInstalling Patchright Chrome… (Ctrl+C to skip)\n");
      try {
        await runInherit("npx", ["-y", "patchright", "install", "chrome"]);
        console.log("✓ Patchright Chrome installed.");
      } catch (err) {
        console.warn(
          "Patchright Chrome install failed — you can retry from Settings later.",
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  // ---- Tunnel configuration ------------------------------------------------
  banner("Tunnel — public URL for proactive webhooks");
  console.log(`
Photon Spectrum iMessage uses the SDK stream and does not need a public
webhook URL. A tunnel is still useful for Composio proactive webhooks, such
as Gmail events. For a stable public URL, pick one of:

  1. Free ngrok             (fine for testing / demos)
  2. ngrok RESERVED domain  (paid — stays the same across restarts)
  3. Cloudflare Tunnel / other static tunnel you set up yourself
`);

  const { tunnelChoice } = await prompts(
    {
      type: "select",
      name: "tunnelChoice",
      message: "Which option are you using?",
      choices: [
        { title: "Free ngrok — rotate URL each restart", value: "free" },
        { title: "ngrok reserved domain (paid)", value: "ngrok-domain" },
        { title: "Cloudflare Tunnel or another stable URL", value: "static" },
      ],
      initial: 0,
    },
    {
      onCancel: () => {
        console.log("Setup cancelled.");
        process.exit(1);
      },
    },
  );

  if (tunnelChoice === "ngrok-domain") {
    const { NGROK_DOMAIN } = await prompts({
      type: "text",
      name: "NGROK_DOMAIN",
      message: "Your ngrok reserved domain (e.g. daniel.ngrok.app, no https://):",
      initial: existing.NGROK_DOMAIN ?? "",
    });
    const clean = (NGROK_DOMAIN ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "");
    if (clean) {
      (answers as any).NGROK_DOMAIN = clean;
      (answers as any).PUBLIC_URL = `https://${clean}`;
    }
  } else if (tunnelChoice === "static") {
    const { PUBLIC_URL } = await prompts({
      type: "text",
      name: "PUBLIC_URL",
      message: "Your stable public URL (e.g. https://daniel.mydomain.com):",
      initial: existing.PUBLIC_URL ?? "",
    });
    if (PUBLIC_URL) {
      (answers as any).PUBLIC_URL = PUBLIC_URL.replace(/\/$/, "");
      (answers as any).NGROK_DOMAIN = "";
    }
  } else {
    // free ngrok — clear any stale domain and keep PUBLIC_URL at the localhost default
    (answers as any).NGROK_DOMAIN = "";
  }

  const env: Record<string, string> = { ...existing, ...answers };
  delete (env as any).runConvex;
  if (!env.PUBLIC_URL) env.PUBLIC_URL = `http://localhost:${env.PORT ?? "3456"}`;
  // Clear stale / stub Convex values so `convex dev` can populate them freshly.
  // (`convex dev` uses .convex/ to identify the deployment, not these env vars.)
  if (env.CONVEX_URL?.includes("example.convex.cloud")) delete env.CONVEX_URL;
  if (env.VITE_CONVEX_URL?.includes("example.convex.cloud")) delete env.VITE_CONVEX_URL;
  writeEnv(ENV_PATH, env);

  if (env.DANIEL_RUNTIME === "codex") {
    const codexInstalled = await hasBinary("codex");
    banner("Codex authentication");
    console.log(`This project uses your Codex / ChatGPT subscription through local Codex auth — no OpenAI API key needed.

If you haven't already:
  • Install Codex CLI:  npm install -g @openai/codex
  • Run once:           codex login
  • Sign in when prompted

Daniel reads the Codex credentials saved on disk. Set DANIEL_CODEX_AUTH_HOME in
.env.local only if you need Daniel to read a different Codex home containing
auth.json.

${codexInstalled ? "✓ Codex CLI found on PATH." : "⚠ Codex CLI was not found on PATH. Install it before running `npm run dev`."}
`);
  } else {
    const claudeInstalled = await hasBinary("claude");
    banner("Claude authentication");
    console.log(`This project uses your Claude Code subscription — no Anthropic API key needed.

If you haven't already:
  • Install Claude Code:  npm install -g @anthropic-ai/claude-code
  • Run once:              claude
  • Sign in when prompted

The Claude Agent SDK reads the credentials Claude Code saves on disk.
You can override with ANTHROPIC_API_KEY in .env.local if you'd rather use an API key.

${claudeInstalled ? "✓ Claude Code found on PATH." : "⚠ Claude Code was not found on PATH. Install it before running `npm run dev`."}
`);
  }

  if (answers.runConvex) {
    await runConvexDev();
    const after = readEnv(ENV_PATH);

    // VITE_CONVEX_URL is written to .env.local as part of `convex dev`. The
    // server falls back to it, so avoid writing an active CONVEX_URL too; Convex
    // CLI treats multiple Convex URL env vars as ambiguous.
    const deploymentMatch =
      after.CONVEX_DEPLOYMENT?.match(/^([a-z]+):([\w-]+)/);

    if (deploymentMatch) {
      const url =
        after.VITE_CONVEX_URL ||
        after.CONVEX_URL ||
        `https://${deploymentMatch[2]}.convex.cloud`;
      if (after.VITE_CONVEX_URL !== url || after.CONVEX_URL) {
        writeEnv(ENV_PATH, {
          ...after,
          VITE_CONVEX_URL: url,
        });
        console.log(`\n✓ Synced VITE_CONVEX_URL → ${url}`);
      }
    }
  } else {
    console.log("\nSkipped Convex. Run `npx convex dev` yourself when ready.");
  }

  const port = answers.PORT ?? "3456";
  banner("You're set up. Here's how to actually run it.");
  console.log(`
Before you start: install ngrok (one-time).

  brew install ngrok                           # macOS
  # or download:  https://ngrok.com/download
  ngrok config add-authtoken <your-token>      # free at https://dashboard.ngrok.com

ngrok's FREE plan gives you a NEW URL every restart. That is fine for local
testing. If you rely on proactive Composio webhooks, use a stable URL:
    • ngrok paid plan (reserved domain), or
    • Cloudflare Tunnel: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/

Then run ONE command:

  npm run dev

That starts the server, Convex watcher, debug dashboard, AND ngrok all
together — color-prefixed output so you can tell who's saying what. Once
the tunnel is live, you'll see a banner with your public URL.

Photon iMessage:
  • Make sure PHOTON_PROJECT_ID and PHOTON_PROJECT_SECRET are set.
  • PHOTON_IMESSAGE_PHONE is optional; set it only for a dedicated line.
  • No inbound webhook needs to be pasted anywhere.

Test it:
  • Open http://localhost:5173 for the debug dashboard (Chat tab works
    without iMessage).
  • Or text your Photon-backed iMessage line. The agent replies.

Integrations (via Composio):
  1. Set COMPOSIO_API_KEY in .env.local.
  2. Open the debug dashboard → Connections tab.
  3. Click Connect on any toolkit (Gmail, Slack, GitHub, Linear, Notion, …).
  4. Composio handles OAuth; the toolkit becomes available to the agent.

Local browser use:
  • Off by default unless you enabled it during setup or in Settings.
  • Open the debug dashboard → Settings → Local browser use to toggle it.
  • The Patchright Chrome binary is installed only if you opt in from setup
    or click "Install Patchright Chrome" in the local browser settings.
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
