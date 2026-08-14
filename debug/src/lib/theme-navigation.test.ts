import { describe, expect, it } from "vitest";
import { isViewId, viewFromLocation, viewUrl } from "./navigation.js";
import { readStoredTheme, resolveTheme } from "./theme.js";

describe("theme model", () => {
  it("defaults to system and migrates existing light/dark values", () => {
    expect(readStoredTheme({ getItem: () => null })).toBe("system");
    expect(readStoredTheme({ getItem: () => "dark" })).toBe("dark");
    expect(readStoredTheme({ getItem: () => "light" })).toBe("light");
    expect(readStoredTheme({ getItem: () => "unsupported" })).toBe("system");
  });

  it("resolves system appearance without changing explicit overrides", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
  });
});

describe("view URLs", () => {
  it("validates and restores known dashboard views", () => {
    expect(isViewId("memory")).toBe(true);
    expect(isViewId("unknown")).toBe(false);
    expect(viewFromLocation({ search: "?view=agents" })).toBe("agents");
    expect(viewFromLocation({ search: "?view=unknown" })).toBe("dashboard");
  });

  it("preserves unrelated query state and omits the default view", () => {
    const location = { pathname: "/", search: "?debug=true", hash: "#top" };
    expect(viewUrl("memory", location)).toBe("/?debug=true&view=memory#top");
    expect(viewUrl("dashboard", { ...location, search: "?debug=true&view=agents" })).toBe(
      "/?debug=true#top",
    );
  });
});
