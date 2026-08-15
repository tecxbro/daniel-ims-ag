import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mutation: vi.fn(),
  spawnExecutionAgent: vi.fn(),
}));

vi.mock("../server/convex-client.js", () => ({
  convex: { query: mocks.query, mutation: mocks.mutation },
}));

vi.mock("../server/execution-agent.js", () => ({
  spawnExecutionAgent: mocks.spawnExecutionAgent,
}));

import { createDraftDecisionTools } from "../server/draft-tools.js";

beforeEach(() => {
  mocks.query.mockReset();
  mocks.mutation.mockReset();
  mocks.spawnExecutionAgent.mockReset();
  mocks.query.mockResolvedValue({
    draftId: "draft-fixture",
    status: "pending",
    kind: "gmail.new",
    summary: "Send fixture email",
    payload: "{}",
  });
});

describe("draft worker integration validation", () => {
  it("does not mark a draft sent when its integration name is unavailable", async () => {
    const sendDraft = createDraftDecisionTools("draft-validation").find(
      (tool) => tool.name === "send_draft",
    )!;

    await expect(
      sendDraft.handle({
        draftId: "draft-fixture",
        integrations: ["gmal"],
      }),
    ).resolves.toEqual({
      text: expect.stringMatching(/Draft not sent:.*gmal/),
      success: false,
    });

    expect(mocks.mutation).not.toHaveBeenCalled();
    expect(mocks.spawnExecutionAgent).not.toHaveBeenCalled();
  });
});
