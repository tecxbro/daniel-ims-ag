// @vitest-environment edge-runtime
/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

function formatHistory(
  turns: Array<{
    user: { content: string };
    assistant: { content: string };
  }>,
): string {
  return turns
    .map(
      (turn) =>
        `USER: ${turn.user.content}\nASSISTANT: ${turn.assistant.content}`,
    )
    .join("\n\n");
}

function hasBrokenSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("recent complete conversation history", () => {
  it("returns the newest ten complete prior turns and excludes noise and later turns", async () => {
    const t = convexTest(schema, modules);
    const conversationId = "local:history";

    for (let index = 1; index <= 12; index += 1) {
      const turnId = `turn-${String(index).padStart(2, "0")}`;
      await t.mutation(api.messages.send, {
        conversationId,
        role: "user",
        content: `question ${index}`,
        turnId,
      });
      await t.mutation(api.messages.send, {
        conversationId,
        role: "assistant",
        content: `answer ${index}`,
        turnId,
      });
    }

    // Malformed retry duplicates still collapse to one turn using the newest
    // row seen for each role.
    await t.mutation(api.messages.send, {
      conversationId,
      role: "user",
      content: "question 12 retried",
      turnId: "turn-12",
    });
    await t.mutation(api.messages.send, {
      conversationId,
      role: "assistant",
      content: "answer 12 retried",
      turnId: "turn-12",
    });

    await t.mutation(api.messages.send, {
      conversationId,
      role: "assistant",
      content: "progress acknowledgement",
    });
    await t.mutation(api.messages.send, {
      conversationId,
      role: "system",
      content: "[proactive notice] background event",
      turnId: "turn-proactive",
    });
    await t.mutation(api.messages.send, {
      conversationId,
      role: "assistant",
      content: "background event",
    });
    await t.mutation(api.messages.send, {
      conversationId,
      role: "user",
      content: "incomplete prior turn",
      turnId: "turn-incomplete",
    });
    const beforeMessageId = await t.mutation(api.messages.send, {
      conversationId,
      role: "user",
      content: "current message",
      turnId: "turn-current",
    });

    // This later turn must not enter the earlier turn's prompt even though it
    // has already completed by the time the history query runs.
    await t.mutation(api.messages.send, {
      conversationId,
      role: "user",
      content: "later concurrent question",
      turnId: "turn-later",
    });
    await t.mutation(api.messages.send, {
      conversationId,
      role: "assistant",
      content: "later concurrent answer",
      turnId: "turn-later",
    });

    const turns = await t.query(api.messages.recentCompleteTurns, {
      conversationId,
      beforeMessageId,
    });

    expect(turns.map((turn) => turn.turnId)).toEqual([
      "turn-03",
      "turn-04",
      "turn-05",
      "turn-06",
      "turn-07",
      "turn-08",
      "turn-09",
      "turn-10",
      "turn-11",
      "turn-12",
    ]);
    expect(turns[0]).toMatchObject({
      user: { content: "question 3", truncated: false },
      assistant: { content: "answer 3", truncated: false },
    });
    expect(turns.at(-1)).toMatchObject({
      user: { content: "question 12 retried", truncated: false },
      assistant: { content: "answer 12 retried", truncated: false },
    });
  });

  it("enforces the total budget and head-tail truncates unusually large replies", async () => {
    const t = convexTest(schema, modules);
    const conversationId = "local:history-budget";

    for (let index = 1; index <= 4; index += 1) {
      const turnId = `turn-large-${index}`;
      await t.mutation(api.messages.send, {
        conversationId,
        role: "user",
        content: `question-${index}-` + "U".repeat(5_000),
        turnId,
      });
      await t.mutation(api.messages.send, {
        conversationId,
        role: "assistant",
        content:
          `answer-${index}-` +
          "A".repeat(5_000) +
          "🧭".repeat(2_000) +
          `-tail-${index}`,
        turnId,
      });
    }
    const beforeMessageId = await t.mutation(api.messages.send, {
      conversationId,
      role: "user",
      content: "current message",
      turnId: "turn-current",
    });

    const turns = await t.query(api.messages.recentCompleteTurns, {
      conversationId,
      beforeMessageId,
    });
    const formatted = formatHistory(turns);

    expect(formatted.length).toBeLessThanOrEqual(16_000);
    expect(turns.length).toBeGreaterThan(0);
    expect(turns.at(-1)?.turnId).toBe("turn-large-4");
    expect(turns.at(-1)?.assistant.truncated).toBe(true);
    expect(turns.at(-1)?.assistant.content).toContain(
      "… [prior message truncated] …",
    );
    expect(turns.at(-1)?.assistant.content).toContain("-tail-4");
    expect(hasBrokenSurrogate(formatted)).toBe(false);
  });

  it("fails closed when the boundary is not the conversation's inbound user row", async () => {
    const t = convexTest(schema, modules);
    const beforeMessageId = await t.mutation(api.messages.send, {
      conversationId: "local:other",
      role: "assistant",
      content: "not an inbound boundary",
      turnId: "turn-other",
    });

    await expect(
      t.query(api.messages.recentCompleteTurns, {
        conversationId: "local:history",
        beforeMessageId,
      }),
    ).resolves.toEqual([]);
  });
});
