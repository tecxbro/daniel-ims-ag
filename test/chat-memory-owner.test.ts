import { describe, expect, it } from "vitest";
import { resolveChatMemoryOwnerId } from "../server/index.js";

describe("/chat memory owner boundary", () => {
  it("accepts and normalizes an explicit memory owner", () => {
    expect(
      resolveChatMemoryOwnerId(
        { conversationId: "dashboard:one", memoryOwnerId: " USER@example.com " },
        { NODE_ENV: "production" },
      ),
    ).toBe("user@example.com");
    expect(
      resolveChatMemoryOwnerId(
        { conversationId: "dashboard:one", memoryOwnerId: "(555) 123-4567" },
        { NODE_ENV: "production" },
      ),
    ).toBe("+15551234567");
  });

  it("derives a canonical owner from a direct SMS conversation", () => {
    expect(
      resolveChatMemoryOwnerId(
        { conversationId: "sms:(555) 123-4567", memoryOwnerId: undefined },
        { NODE_ENV: "production" },
      ),
    ).toBe("+15551234567");
  });

  it("allows local-default only outside production", () => {
    expect(
      resolveChatMemoryOwnerId(
        { conversationId: "dashboard:local", memoryOwnerId: undefined },
        { NODE_ENV: "development" },
      ),
    ).toBe("local-default");
    expect(
      resolveChatMemoryOwnerId(
        { conversationId: "dashboard:prod", memoryOwnerId: undefined },
        { NODE_ENV: "production" },
      ),
    ).toBeNull();
    expect(
      resolveChatMemoryOwnerId(
        { conversationId: "dashboard:prod", memoryOwnerId: "local-default" },
        { NODE_ENV: "production" },
      ),
    ).toBeNull();
  });
});
