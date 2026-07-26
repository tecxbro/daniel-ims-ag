import { describe, expect, it } from "vitest";
import {
  normalizeCodingResponseStyle,
  resolveCodingResponseStyle,
} from "../server/coding/response-style.js";

describe("coding response style", () => {
  it("falls back to Daniel summary for missing or invalid stored values", () => {
    expect(normalizeCodingResponseStyle(undefined)).toBe("daniel_summary");
    expect(normalizeCodingResponseStyle("nope")).toBe("daniel_summary");
    expect(resolveCodingResponseStyle({ storedValue: null }).style).toBe(
      "daniel_summary",
    );
  });

  it("detects durable raw Codex output preferences", () => {
    const resolved = resolveCodingResponseStyle({
      storedValue: "daniel_summary",
      content: "From now on give me raw Codex output.",
    });

    expect(resolved.style).toBe("raw_codex");
    expect(resolved.durableUpdate).toBe("raw_codex");
  });

  it("detects detailed coding reply preferences", () => {
    const resolved = resolveCodingResponseStyle({
      storedValue: "daniel_summary",
      content: "I prefer detailed coding replies by default.",
    });

    expect(resolved.style).toBe("detailed");
    expect(resolved.durableUpdate).toBe("detailed");
  });

  it("treats casual detail requests as one-off style changes", () => {
    const resolved = resolveCodingResponseStyle({
      storedValue: "daniel_summary",
      content: "Can you give me more detail on that?",
    });

    expect(resolved.style).toBe("detailed");
    expect(resolved.durableUpdate).toBeNull();
  });
});
