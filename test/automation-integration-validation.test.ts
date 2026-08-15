import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mutation: vi.fn(),
}));

vi.mock("../server/convex-client.js", () => ({
  convex: { mutation: mocks.mutation, query: vi.fn() },
}));

vi.mock("../server/execution-agent.js", () => ({
  availableIntegrations: () => [],
}));

import { createAutomationTools } from "../server/automation-tools.js";

beforeEach(() => mocks.mutation.mockReset());

describe("automation integration validation", () => {
  it("does not persist an automation with an unavailable integration", async () => {
    const createAutomation = createAutomationTools(
      "automation-validation",
    ).find((tool) => tool.name === "create_automation")!;

    await expect(
      createAutomation.handle({
        name: "fixture",
        schedule: "0 8 * * *",
        task: "Read inbox",
        integrations: ["gmal"],
        notify: true,
      }),
    ).resolves.toEqual({
      text: expect.stringMatching(/Automation not created:.*gmal/),
      success: false,
    });

    expect(mocks.mutation).not.toHaveBeenCalled();
  });
});
