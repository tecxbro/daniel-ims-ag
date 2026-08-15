import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isAllowedControlOrigin } from "../server/index.js";
import { buildInteractionSystemPrompt } from "../server/interaction-agent.js";
import { isLocalMemoryRouteRequest } from "../server/memory/supermemory/routes.js";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: process.cwd(),
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
}

function token(...parts: string[]): string {
  return parts.join("");
}

describe("Implementation 10 runtime decommission", () => {
  it("keeps tunneled control routes and the WebSocket local-only", () => {
    const indexSource = source("server/index.ts");
    const composioSource = source("server/composio-routes.ts");

    expect(isAllowedControlOrigin(undefined)).toBe(true);
    expect(isAllowedControlOrigin("http://localhost:5173")).toBe(true);
    expect(isAllowedControlOrigin("http://127.0.0.1:3456")).toBe(true);
    expect(isAllowedControlOrigin("https://public.example")).toBe(false);
    expect(isLocalMemoryRouteRequest({ host: "localhost:3456" }, "127.0.0.1")).toBe(true);
    expect(
      isLocalMemoryRouteRequest(
        { host: "public.example", "x-forwarded-for": "203.0.113.10" },
        "127.0.0.1",
      ),
    ).toBe(false);
    expect(indexSource).toContain(
      "createComposioRouter({ requireControlAccess: requireLocalControl })",
    );
    expect(indexSource).toContain(
      'ws.close(1008, "Daniel control WebSocket is only available locally.")',
    );
    expect(composioSource).toContain('req.path === "/webhook"');
  });

  it("only advertises long-term memory when the service is available", () => {
    const base = {
      integrations: [],
      codingResponseStyle: "daniel_summary" as const,
    };
    const enabled = buildInteractionSystemPrompt({ ...base, memoryEnabled: true });
    const disabled = buildInteractionSystemPrompt({ ...base, memoryEnabled: false });

    expect(enabled).toContain("recall / remember_memory / update_memory");
    expect(enabled).toContain("Long-term context is already preloaded");
    expect(enabled).not.toContain("Long-term memory is unavailable this turn");
    expect(disabled).not.toContain("remember_memory");
    expect(disabled).not.toContain("Long-term context is already preloaded");
    expect(disabled).toContain("Do not claim you recalled, saved");
  });

  it("uses durable assistant persistence and has no retired runtime tokens", () => {
    const turnSource = source("server/dispatcher/turn.ts");
    expect(turnSource).toContain("finalizeAssistantTurnCapture({");
    expect(turnSource).toContain('opts.kind === "proactive"');

    const prohibited = [
      token("memory", "Records"),
      token("memory", "Events"),
      token("memory", "MigrationRows"),
      token("legacyMemory", "CleanupRuns"),
      token("consolidation", "Runs"),
      token("DANIEL_MEMORY_", "READ_MODE"),
      token("DANIEL_MEMORY_", "WRITE_MODE"),
      token("DANIEL_MEMORY_", "LEGACY_FALLBACK"),
      token("DANIEL_SUPERMEMORY_", "HISTORY_BACKFILL_DAYS"),
      token("@huggingface/", "transformers"),
      token("createMemory", "ReadStrategy"),
      token("createMemory", "WriteStrategy"),
      token("prepareRuntimeMemory", "Context"),
      token("recallLegacy", "Memory"),
    ];

    const violations: string[] = [];
    for (const path of trackedFiles()) {
      const absolutePath = resolve(process.cwd(), path);
      const contents = lstatSync(absolutePath).isSymbolicLink()
        ? Buffer.from(readlinkSync(absolutePath))
        : readFileSync(absolutePath);
      for (const prohibitedToken of prohibited) {
        if (contents.includes(Buffer.from(prohibitedToken))) {
          violations.push(`${path}: ${prohibitedToken}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
