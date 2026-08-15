import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawnExecutionAgent: vi.fn(),
}));

vi.mock("../server/execution-agent.js", () => ({
  spawnExecutionAgent: mocks.spawnExecutionAgent,
  availableIntegrations: () => [],
}));

import { createDispatcherTools } from "../server/dispatcher/tools.js";

function spawnTool(content = "Check my inbox") {
  return createDispatcherTools({
    conversationId: "integration-validation",
    content,
    integrations: ["gmail", "browser"],
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
  }).tools.find((tool) => tool.name === "spawn_agent")!;
}

beforeEach(() => {
  mocks.spawnExecutionAgent.mockReset();
  mocks.spawnExecutionAgent.mockResolvedValue({
    agentId: "agent-fixture",
    status: "completed",
    result: "done",
  });
});

describe("dispatcher worker integration validation", () => {
  it("rejects unknown-only and mixed integration names before spawn", async () => {
    await expect(
      spawnTool().handle({ task: "Read inbox", integrations: ["gmal"] }),
    ).resolves.toEqual({
      text: expect.stringMatching(/Worker not started:.*gmal/),
      success: false,
    });
    await expect(
      spawnTool().handle({
        task: "Read inbox",
        integrations: ["gmail", "slak"],
      }),
    ).resolves.toEqual({
      text: expect.stringMatching(/Worker not started:.*slak/),
      success: false,
    });
    expect(mocks.spawnExecutionAgent).not.toHaveBeenCalled();
  });

  it("validates before explicit-browser forcing can mask a typo", async () => {
    await expect(
      spawnTool("Use Chrome on my machine to check this").handle({
        task: "Use local Chrome",
        integrations: ["gmal"],
      }),
    ).resolves.toEqual({
      text: expect.stringMatching(/Worker not started:.*gmal/),
      success: false,
    });
    expect(mocks.spawnExecutionAgent).not.toHaveBeenCalled();
  });

  it("keeps an empty list valid for a web-only worker", async () => {
    await expect(
      spawnTool("Look up today's weather").handle({
        task: "Look up weather",
        integrations: [],
      }),
    ).resolves.toMatchObject({ text: expect.stringContaining("done") });
    expect(mocks.spawnExecutionAgent).toHaveBeenCalledWith(
      expect.objectContaining({ integrations: [] }),
    );
  });
});
