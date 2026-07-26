import { describe, expect, it } from "vitest";
import {
  codexCollaborationModeForCodingTurn,
  formatCodingQuestionForMessage,
  parsePendingInputAnswer,
  resolveCodingMode,
} from "../server/coding-agent.js";

describe("coding agent routing helpers", () => {
  it("starts new app and major feature work in plan mode", () => {
    expect(resolveCodingMode("Build me an iMessage agent for date planning")).toBe(
      "plan",
    );
    expect(resolveCodingMode("Create a landing page and backend")).toBe("plan");
  });

  it("routes bug fixes to debug mode", () => {
    expect(resolveCodingMode("Fix the webhook error in my Photon agent")).toBe(
      "debug",
    );
    expect(resolveCodingMode("The tests are failing, debug it")).toBe("debug");
  });

  it("honors explicit mode overrides", () => {
    expect(resolveCodingMode("Build this directly", "build")).toBe("build");
    expect(resolveCodingMode("Debug this later", "plan")).toBe("plan");
  });

  it("maps only the first planning turn to Codex plan mode", () => {
    expect(codexCollaborationModeForCodingTurn("plan")).toBe("plan");
    expect(codexCollaborationModeForCodingTurn("build")).toBe("default");
    expect(codexCollaborationModeForCodingTurn("debug")).toBe("default");
    expect(codexCollaborationModeForCodingTurn("followup")).toBe("default");
  });
});

describe("coding user input formatting", () => {
  it("formats Codex choices for iMessage", () => {
    const formatted = formatCodingQuestionForMessage({
      questions: [
        {
          id: "db",
          header: "Database",
          question: "Which database should we use?",
          isOther: true,
          isSecret: false,
          options: [
            { label: "Convex", description: "Use existing backend." },
            { label: "Supabase", description: "Use Postgres." },
          ],
        },
      ],
    });

    expect(formatted.message).toContain("I need one decision");
    expect(formatted.message).not.toContain("Codex needs one decision");
    expect(formatted.message).toContain("1. Convex");
    expect(formatted.options).toEqual(["Convex", "Supabase"]);
    expect(formatted.allowFreeform).toBe(true);
  });

  it("parses numeric, label, and freeform answers", () => {
    expect(
      parsePendingInputAnswer({
        content: "2",
        options: ["Convex", "Supabase"],
        allowFreeform: true,
      }),
    ).toEqual({ ok: true, answer: "Supabase" });

    expect(
      parsePendingInputAnswer({
        content: "convex",
        options: ["Convex", "Supabase"],
        allowFreeform: false,
      }),
    ).toEqual({ ok: true, answer: "Convex" });

    expect(
      parsePendingInputAnswer({
        content: "SQLite",
        options: ["Convex", "Supabase"],
        allowFreeform: true,
      }),
    ).toEqual({ ok: true, answer: "SQLite" });
  });

  it("rejects invalid non-freeform answers", () => {
    const parsed = parsePendingInputAnswer({
      content: "4",
      options: ["Convex", "Supabase"],
      allowFreeform: false,
    });
    expect(parsed.ok).toBe(false);
  });
});
