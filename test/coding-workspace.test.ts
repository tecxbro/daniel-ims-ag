import { describe, expect, it } from "vitest";
import {
  inferProjectTitle,
  safeProjectKey,
  workspacePathForProjectKey,
} from "../server/coding/workspace.js";

describe("coding workspace helpers", () => {
  it("normalizes project keys for filesystem paths", () => {
    expect(safeProjectKey(" My App: v1!! ")).toBe("my-app-v1");
  });

  it("infers titles from project hints, repos, and tasks", () => {
    expect(
      inferProjectTitle({
        task: "Build something",
        projectHint: "Date Planner",
      }),
    ).toBe("Date Planner");

    expect(
      inferProjectTitle({
        task: "Build something",
        repoUrl: "https://github.com/acme/date-planner.git",
      }),
    ).toBe("date planner");

    expect(
      inferProjectTitle({
        task: "Build me an iMessage date planning agent with Convex",
      }),
    ).toBe("Build me an iMessage date planning agent with");
  });

  it("uses the configured workspace root", () => {
    process.env.DANIEL_PROJECTS_ROOT = "/tmp/daniel-projects-test";
    expect(workspacePathForProjectKey("abc")).toBe("/tmp/daniel-projects-test/abc");
    delete process.env.DANIEL_PROJECTS_ROOT;
  });
});
