import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const uiFiles = [
  "debug/src/App.tsx",
  "debug/src/components/MemoryPanel.tsx",
  "debug/src/components/EventsPanel.tsx",
  "debug/src/components/DashboardPanel.tsx",
  "debug/src/components/MemorySyncPanel.tsx",
  "debug/src/components/SupermemoryStatusBanner.tsx",
  "debug/src/components/MemoryGraphView.tsx",
  "debug/src/components/PrimaryOwnerPairing.tsx",
  "debug/src/lib/dashboardSnapshot.ts",
];

async function source(file: string): Promise<string> {
  return await readFile(path.join(root, file), "utf8");
}

describe("Implementation 10 Supermemory dashboard", () => {
  it("keeps active memory views off legacy Convex APIs and browser provider credentials", async () => {
    const combined = (await Promise.all(uiFiles.map(source))).join("\n");
    const removedApis = ["memory" + "Records", "memory" + "Events", "consolidation"];
    for (const apiName of removedApis) {
      expect(combined).not.toContain(["api", apiName].join("."));
    }
    expect(combined).not.toContain('from "supermemory"');
    expect(combined).not.toContain("SUPERMEMORY_API_KEY");
  });

  it("uses the normalized server-only provider routes", async () => {
    const memory = await source("debug/src/components/MemoryPanel.tsx");
    const explorer = await source("debug/src/components/MemoryGraphView.tsx");
    const status = await source("debug/src/components/SupermemoryStatusBanner.tsx");
    expect(status).toContain("/api/memory/provider-status");
    expect(memory).toContain("/api/memory/profile");
    expect(memory).toContain("/api/memory/search");
    expect(memory).toContain("/api/memory/documents?");
    expect(memory).toContain("No profile facts yet");
    expect(explorer).toContain("Version history");
    expect(explorer).toContain("Forgotten");
    expect(explorer).toContain("Similarity");
  });

  it("exposes failed and dead-letter retry controls", async () => {
    const sync = await source("debug/src/components/MemorySyncPanel.tsx");
    expect(sync).toContain("/api/memory/retry-job");
    expect(sync).toContain("/api/memory/retry-dead-letter");
    expect(sync).toContain("Retry dead letter");
    expect(sync).toContain("lastError");
  });

  it("does not render the former inferred relationship visualization or old controls", async () => {
    const explorer = await source("debug/src/components/MemoryGraphView.tsx");
    const memory = await source("debug/src/components/MemoryPanel.tsx");
    const app = await source("debug/src/App.tsx");
    expect(explorer).not.toContain("ForceGraph");
    expect(explorer).not.toContain("SEGMENT_COLORS");
    expect(memory).not.toContain("Re-embed");
    expect(app).toContain("Memory sync");
  });

  it("offers local primary-owner pairing without rendering protected identity fields", async () => {
    const settings = await source("debug/src/components/SettingsPanel.tsx");
    const pairing = await source("debug/src/components/PrimaryOwnerPairing.tsx");
    expect(settings).toContain("Primary memory owner");
    expect(pairing).toContain("/api/memory/pairing/status");
    expect(pairing).toContain("/api/memory/pairing/code");
    expect(pairing).toContain("/api/memory/pairing/candidates");
    expect(pairing).toContain("/api/memory/pairing/confirm");
    for (const protectedField of [
      "owner" + "Key",
      "container" + "Tag",
      "conversation" + "Id",
      "pairingAuthority" + "Proof",
      "salt" + "Fingerprint",
    ]) {
      expect(pairing).not.toContain(protectedField);
    }
  });
});
