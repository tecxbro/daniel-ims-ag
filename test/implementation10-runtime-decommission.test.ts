import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isAllowedControlOrigin } from "../server/index.js";
import { isLocalMemoryRouteRequest } from "../server/memory/supermemory/routes.js";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
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

  it("uses durable assistant persistence and has no retired runtime modules", () => {
    const interactionSource = source("server/interaction-agent.ts");
    expect(interactionSource).toContain("finalizeAssistantTurnCapture({");
    expect(interactionSource).toContain('opts.kind === "proactive"');

    const retired = [
      ["server", "memory", "extract.ts"],
      ["server", "memory", "clean.ts"],
      ["server", "consolidation.ts"],
      ["server", "embeddings.ts"],
      ["server", "memory", "read-strategy.ts"],
      ["server", "memory", "write-strategy.ts"],
      ["server", "memory", "runtime-context.ts"],
    ];
    for (const segments of retired) {
      expect(existsSync(resolve(process.cwd(), ...segments))).toBe(false);
    }
  });
});
