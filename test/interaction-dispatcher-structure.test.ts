import { describe, expect, it } from "vitest";
import * as interactionAgent from "../server/interaction-agent.js";
import {
  DISPATCHER_DISALLOWED_TOOLS,
  buildInteractionSystemPrompt,
} from "../server/dispatcher/policy.js";
import {
  explicitlyRequestsBrowser,
  proactiveNoticeReply,
  resolveDirectModelSwitch,
  resolveDirectReasoningEffortSwitch,
  resolveDirectRuntimeSwitch,
  resolveDirectTimezoneSwitch,
  resolveSimpleSelfConfigurationRequest,
  resolveSpawnIntegrations,
} from "../server/dispatcher/gates.js";
import {
  buildConversationPrompt,
  buildHistoryBlock,
  buildTurnUserText,
  composePreloadedMemoryPrompt,
} from "../server/dispatcher/history.js";
import { resolveSpawnImageRefs } from "../server/dispatcher/tools.js";
import { handleUserMessage } from "../server/dispatcher/turn.js";

describe("dispatcher module structure", () => {
  it("keeps the interaction-agent facade's baseline runtime exports", () => {
    expect(Object.keys(interactionAgent).sort()).toEqual([
      "buildInteractionSystemPrompt",
      "composePreloadedMemoryPrompt",
      "handleUserMessage",
      "resolveDirectRuntimeSwitch",
      "resolveSpawnImageRefs",
      "resolveSpawnIntegrations",
    ]);

    expect(interactionAgent.buildInteractionSystemPrompt).toBe(
      buildInteractionSystemPrompt,
    );
    expect(interactionAgent.composePreloadedMemoryPrompt).toBe(
      composePreloadedMemoryPrompt,
    );
    expect(interactionAgent.resolveDirectRuntimeSwitch).toBe(
      resolveDirectRuntimeSwitch,
    );
    expect(interactionAgent.resolveSpawnImageRefs).toBe(resolveSpawnImageRefs);
    expect(interactionAgent.resolveSpawnIntegrations).toBe(
      resolveSpawnIntegrations,
    );
    expect(interactionAgent.handleUserMessage).toBe(handleUserMessage);
  });
});

describe("dispatcher policy boundary", () => {
  it("preserves the dispatcher sandbox and prompt substitutions", () => {
    expect(DISPATCHER_DISALLOWED_TOOLS).toEqual([
      "WebSearch",
      "WebFetch",
      "Bash",
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "Agent",
      "Skill",
    ]);

    const prompt = buildInteractionSystemPrompt({
      integrations: ["gmail", "browser"],
      codingResponseStyle: "detailed",
      memoryEnabled: true,
    });
    expect(prompt).toContain("Available worker integrations: gmail, browser");
    expect(prompt).toContain("Current coding response style: detailed.");
    expect(prompt).toContain("Long-term context is already preloaded");
    expect(prompt.length).toBeLessThan(8_000);
    expect(prompt).not.toContain("set_runtime");
    expect(prompt).not.toContain("set_model");
    expect(prompt).not.toContain("set_timezone");
    expect(prompt).not.toContain("Local browser fallback");
    expect(prompt).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it("advertises only request-scoped tools and delegates ordinary facts to turn capture", () => {
    const directPrompt = buildInteractionSystemPrompt({
      integrations: ["gmail"],
      codingResponseStyle: "daniel_summary",
      memoryEnabled: true,
      toolFamilies: [],
    });
    expect(directPrompt).toContain("(none; answer directly)");
    expect(directPrompt).toContain("Automatic turn capture handles those facts");
    expect(directPrompt).not.toContain("- spawn_agent");
    expect(directPrompt).not.toContain("- spawn_coding_agent");
    expect(directPrompt).not.toContain("- recall / remember_memory");

    const livePrompt = buildInteractionSystemPrompt({
      integrations: ["gmail"],
      codingResponseStyle: "daniel_summary",
      memoryEnabled: true,
      toolFamilies: ["spawn"],
    });
    expect(livePrompt).toContain("- send_ack / spawn_agent");
    expect(livePrompt).not.toContain("- spawn_coding_agent");
    expect(livePrompt).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });
});

describe("dispatcher gate boundary", () => {
  it("preserves direct runtime switching and explicit-browser routing", () => {
    expect(resolveDirectRuntimeSwitch("please switch me to ChatGPT Codex")).toBe(
      "codex",
    );
    expect(resolveDirectRuntimeSwitch("what is Codex?")).toBeNull();

    expect(resolveDirectModelSwitch("Use Opus")).toBe("Opus");
    expect(resolveDirectModelSwitch("Set model to gpt-5.4-mini")).toBe(
      "gpt-5.4-mini",
    );
    expect(resolveDirectModelSwitch("Use Codex mini")).toBe("mini");
    expect(resolveDirectModelSwitch("Use Opus and fix the repo")).toBeNull();

    expect(resolveDirectTimezoneSwitch("Use PT as my timezone")).toBe("PT");
    expect(resolveDirectTimezoneSwitch("I'm in Dallas")).toBe("Dallas");
    expect(
      resolveDirectTimezoneSwitch("I'll be in Dallas next week"),
    ).toBeNull();
    expect(
      resolveDirectTimezoneSwitch("Use Pacific time and schedule a reminder"),
    ).toBeNull();

    expect(
      resolveDirectReasoningEffortSwitch("Set Codex reasoning effort to high"),
    ).toBe("high");
    expect(
      resolveSimpleSelfConfigurationRequest(
        "Which integrations and accounts are connected right now?",
      ),
    ).toBe("integrations");
    expect(
      resolveSimpleSelfConfigurationRequest("What model are you using?"),
    ).toBe("model");
    expect(proactiveNoticeReply("[proactive notice] Security alert")).toBe(
      "Security alert",
    );

    expect(explicitlyRequestsBrowser("Use Chrome on my machine, not Composio.")).toBe(
      true,
    );
    expect(explicitlyRequestsBrowser("What is Patchright?")).toBe(false);
    expect(explicitlyRequestsBrowser("Don't use the local browser.")).toBe(
      false,
    );
    expect(
      explicitlyRequestsBrowser(
        "Save this page in Chrome's reading list after you email it.",
      ),
    ).toBe(false);
    expect(
      resolveSpawnIntegrations(
        ["gmail"],
        ["gmail", "browser"],
        "Please use the local browser for this.",
      ),
    ).toEqual(["browser"]);
  });
});

describe("dispatcher history boundary", () => {
  it("formats complete prior turns in chronological order", () => {
    expect(
      buildHistoryBlock([
        {
          turnId: "turn-1",
          user: { content: "Earlier question" },
          assistant: { content: "Earlier answer" },
        },
        {
          turnId: "turn-2",
          user: { content: "Follow-up question" },
          assistant: { content: "Follow-up answer" },
        },
      ]),
    ).toBe(
      "USER: Earlier question\nASSISTANT: Earlier answer\n\nUSER: Follow-up question\nASSISTANT: Follow-up answer",
    );

    expect(buildTurnUserText("Current message", "download failed")).toBe(
      "[user sent images but they couldn't be downloaded: download failed]\nCurrent message",
    );
    expect(
      buildConversationPrompt({
        kind: "user",
        historyBlock: "USER: Earlier question\nASSISTANT: Earlier answer",
        userText: "Current message",
      }),
    ).toBe(
      "Prior turns:\nUSER: Earlier question\nASSISTANT: Earlier answer\n\nCurrent message:\nCurrent message",
    );
  });

  it("preserves proactive isolation and preloaded-memory ordering", () => {
    expect(
      buildConversationPrompt({
        kind: "proactive",
        historyBlock: "USER: Must not appear",
        userText: "Flight delayed by 20 minutes",
      }),
    ).toBe(
      "Standalone proactive notice. Write a concise user-facing iMessage from this notice only. Do not research, spawn agents, or continue any prior conversation.\n\nFlight delayed by 20 minutes",
    );

    expect(
      composePreloadedMemoryPrompt("Current message", "  Saved profile fact  "),
    ).toBe("Saved profile fact\n\nCurrent message");
    expect(composePreloadedMemoryPrompt("Current message", "   ")).toBe(
      "Current message",
    );
    expect(composePreloadedMemoryPrompt("Current message", undefined)).toBe(
      "Current message",
    );
  });
});

describe("dispatcher tool boundary", () => {
  it("preserves current-turn image selection and safe fallback", () => {
    expect(resolveSpawnImageRefs(["img-2"], ["img-1", "img-2"])).toEqual([
      "img-2",
    ]);
    expect(resolveSpawnImageRefs(["stale"], ["img-1", "img-2"])).toEqual([
      "img-1",
      "img-2",
    ]);
    expect(resolveSpawnImageRefs(undefined, [])).toBeUndefined();
  });
});
