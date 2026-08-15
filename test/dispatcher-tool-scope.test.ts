import { describe, expect, it } from "vitest";
import { validateIntegrationNames } from "../server/integrations/registry.js";
import { resolveDispatcherToolScope } from "../server/dispatcher/scope.js";
import {
  createDispatcherTools,
  dispatcherAllowedTools,
} from "../server/dispatcher/tools.js";
import type { DispatcherToolFamily } from "../server/dispatcher/scope.js";

const integrations = ["gmail", "googlecalendar", "browser"];

function toolNames(families: DispatcherToolFamily[]): string[] {
  return createDispatcherTools({
    conversationId: "scope-fixture",
    content: "fixture",
    integrations,
    inboundImageStorageIds: [],
    spawnableImageStorageIds: [],
    memoryService: null,
    runtimeConfig: {
      runtime: "claude",
      model: "claude-fixture",
      billingMode: "api",
    },
    codingResponseStyle: "daniel_summary",
    toolFamilies: families,
    persistAcknowledgement: async () => undefined,
    log: () => undefined,
  }).tools.map((tool) => tool.name);
}

describe("dispatcher request tool scope", () => {
  it.each([
    ["Explain how DNS caching works", []],
    ["I prefer aisle seats on flights.", []],
    ["Explain JavaScript closures.", []],
    ["Explain what a memory leak in code means.", []],
    ["Explain the Python automation library.", []],
    ["Fix the failing webhook tests in my repo.", ["coding"]],
    ["Draft a README for my repo.", ["coding"]],
    ["What's the weather in Seattle today?", ["spawn"]],
    ["What's the newest unread email in my Gmail inbox?", ["spawn"]],
    ["Schedule a meeting with Rowan tomorrow.", ["spawn"]],
    ["Remember that I prefer aisle seats on flights.", ["memory"]],
    ["What did we decide to call Project Atlas?", ["memory"]],
    ["What drafts are waiting for approval?", ["draft"]],
    [
      "Every weekday at 8 AM, send me a weather summary.",
      ["automation", "self"],
    ],
    ["Inspect the available integration toolkits.", ["self"]],
    [
      "Look up the latest Vite version and update my repo.",
      ["coding", "spawn"],
    ],
  ] as const)("scopes %j", (content, expected) => {
    expect(resolveDispatcherToolScope(content, integrations)).toEqual({
      families: expected,
      fallback: false,
    });
  });

  it("uses the conservative full-family fallback only for unclear actions", () => {
    expect(
      resolveDispatcherToolScope("Please handle this.", integrations),
    ).toEqual({
      families: ["coding", "spawn", "memory", "draft", "automation", "self"],
      fallback: true,
    });
  });

  it("constructs only selected families and derives the runtime allowlist", () => {
    expect(toolNames([])).toEqual([]);
    expect(toolNames(["coding"])).toEqual(["spawn_coding_agent"]);
    expect(toolNames(["spawn"])).toEqual(["send_ack", "spawn_agent"]);
    expect(toolNames(["draft"])).toEqual([
      "list_drafts",
      "send_draft",
      "reject_draft",
    ]);
    expect(toolNames(["automation"])).toEqual([
      "create_automation",
      "list_automations",
      "toggle_automation",
      "delete_automation",
    ]);
    expect(toolNames(["self"])).toEqual([
      "get_config",
      "search_composio_catalog",
      "inspect_toolkit",
    ]);

    const tools = createDispatcherTools({
      conversationId: "scope-fixture",
      content: "Check today's weather",
      integrations,
      inboundImageStorageIds: [],
      spawnableImageStorageIds: [],
      memoryService: null,
      runtimeConfig: {
        runtime: "claude",
        model: "claude-fixture",
        billingMode: "api",
      },
      codingResponseStyle: "daniel_summary",
      toolFamilies: ["spawn"],
      persistAcknowledgement: async () => undefined,
      log: () => undefined,
    }).tools;
    expect(dispatcherAllowedTools(tools)).toEqual([
      "mcp__daniel-ack__send_ack",
      "mcp__daniel-spawn__spawn_agent",
    ]);
  });
});

describe("integration-name validation", () => {
  it("keeps empty and canonical names, deduping without dropping", () => {
    expect(validateIntegrationNames([], integrations)).toEqual([]);
    expect(validateIntegrationNames(["gmail", "gmail"], integrations)).toEqual([
      "gmail",
    ]);
  });

  it("rejects unknown-only, mixed, and display-alias requests", () => {
    expect(() => validateIntegrationNames(["gmal"], integrations)).toThrow(
      /Unknown or unavailable integration: gmal/,
    );
    expect(() =>
      validateIntegrationNames(["gmail", "slak"], integrations),
    ).toThrow(/slak/);
    expect(() => validateIntegrationNames(["Gmail"], integrations)).toThrow(
      /Gmail/,
    );
  });
});
