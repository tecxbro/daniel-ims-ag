import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mutation: vi.fn(),
}));

vi.mock("../server/convex-client.js", () => ({
  convex: { mutation: mocks.mutation, query: vi.fn() },
}));

vi.mock("../server/integrations/registry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../server/integrations/registry.js")>();
  return {
    ...actual,
    listEnabledIntegrations: vi.fn(async () => [{ name: "gmail" }]),
  };
});

import { spawnExecutionAgent } from "../server/execution-agent.js";

beforeEach(() => mocks.mutation.mockReset());

describe("execution worker integration validation", () => {
  it("rejects a stale integration before creating an agent record", async () => {
    await expect(
      spawnExecutionAgent({
        task: "Read inbox",
        integrations: ["gmal"],
        conversationId: "execution-validation",
      }),
    ).rejects.toThrow(/Unknown or unavailable integration: gmal/);

    expect(mocks.mutation).not.toHaveBeenCalled();
  });
});
