import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convex } from "../server/convex-client.js";
import {
  legacyConsolidationEnabled,
  runConsolidation,
} from "../server/consolidation.js";
import {
  activeProvider,
  embed,
  embeddingsAvailable,
  legacyEmbeddingRuntimeEnabled,
  preloadLocalModel,
} from "../server/embeddings.js";
import {
  cleanMemories,
  legacyCleanupEnabled,
  startCleanupLoop,
} from "../server/memory/clean.js";
import {
  extractAndStore,
  legacyExtractionEnabled,
} from "../server/memory/extract.js";
import { isAllowedControlOrigin } from "../server/index.js";
import { isLocalMemoryRouteRequest } from "../server/memory/supermemory/routes.js";

const CUTOVER_ENV = {
  DANIEL_MEMORY_READ_MODE: "supermemory",
  DANIEL_MEMORY_WRITE_MODE: "supermemory",
  DANIEL_MEMORY_LEGACY_FALLBACK: "false",
};

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Implementation 8 runtime cutover", () => {
  it("does not start cleanup, consolidation, or the local embedding model", () => {
    const indexSource = source("server/index.ts");
    expect(indexSource).not.toContain("startCleanupLoop()");
    expect(indexSource).not.toContain("startConsolidationLoop()");
    expect(indexSource).not.toContain("preloadLocalModel()");
    expect(indexSource).not.toContain('from "./memory/clean.js"');
    expect(indexSource).not.toContain('from "./consolidation.js"');
    expect(indexSource).not.toContain('from "./embeddings.js"');
  });

  it("compatibility-retires the manual consolidation endpoint", () => {
    const indexSource = source("server/index.ts");
    expect(indexSource).toContain('app.post("/consolidate"');
    expect(indexSource).toContain("res.status(410)");
    expect(indexSource).not.toContain('import("./consolidation.js")');
  });

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

  it("uses durable capture and has no active legacy extraction path", () => {
    const interactionSource = source("server/interaction-agent.ts");
    expect(interactionSource).toContain("enqueueRawTurnCapture({");
    expect(interactionSource).toContain('opts.kind === "proactive"');
    expect(interactionSource).not.toContain('from "./memory/extract.js"');
    expect(interactionSource).not.toContain("extractAndStore(");
    expect(interactionSource).not.toContain("createMemoryTools(opts.conversationId)");
  });

  it("makes stale legacy callers harmless under every mode configuration", async () => {
    for (const [key, value] of Object.entries(CUTOVER_ENV)) vi.stubEnv(key, value);
    const mutation = vi.spyOn(convex, "mutation");
    const query = vi.spyOn(convex, "query");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    expect(legacyExtractionEnabled(CUTOVER_ENV)).toBe(false);
    expect(legacyCleanupEnabled(CUTOVER_ENV)).toBe(false);
    expect(legacyConsolidationEnabled(CUTOVER_ENV)).toBe(false);
    expect(legacyEmbeddingRuntimeEnabled(CUTOVER_ENV)).toBe(false);
    expect(legacyExtractionEnabled({})).toBe(false);
    expect(legacyCleanupEnabled({ DANIEL_MEMORY_WRITE_MODE: "convex" })).toBe(false);
    expect(legacyConsolidationEnabled({ DANIEL_MEMORY_WRITE_MODE: "dual" })).toBe(false);
    expect(legacyEmbeddingRuntimeEnabled({})).toBe(false);
    expect(embeddingsAvailable()).toBe(false);
    expect(activeProvider()).toBe("retired");

    await extractAndStore({
      conversationId: "sms:+15555550100",
      userMessage: "Remember this",
      assistantReply: "Okay",
      turnId: "turn_cutover",
    });
    await expect(cleanMemories()).resolves.toEqual({
      scanned: 0,
      archived: 0,
      pruned: 0,
    });
    expect(startCleanupLoop()).toBeTypeOf("function");
    preloadLocalModel();
    await expect(embed("must not be embedded")).resolves.toBeNull();
    await expect(runConsolidation("manual")).rejects.toThrow(/retired/i);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(mutation).not.toHaveBeenCalled();
  });
});
