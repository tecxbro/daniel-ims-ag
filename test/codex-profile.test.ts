import { describe, expect, it } from "vitest";
import {
  buildCodexCollaborationMode,
  codexAppServerArgsForProfile,
  codexSandboxForRequest,
} from "../server/runtimes/codex-app-server.js";
import type { RuntimeRunRequest } from "../server/runtimes/types.js";

function request(overrides: Partial<RuntimeRunRequest> = {}): RuntimeRunRequest {
  return {
    prompt: "test",
    systemPrompt: "system",
    model: "gpt-5.5",
    tools: [],
    mode: "execution",
    ...overrides,
  };
}

describe("Codex runner profiles", () => {
  it("keeps broad disables on the Daniel-safe profile", () => {
    const args = codexAppServerArgsForProfile("daniel-safe");
    expect(args).toContain("--disable");
    expect(args).toContain("shell_tool");
    expect(args).toContain("unified_exec");
  });

  it("does not pass broad disables on the Daniel-full profile", () => {
    const args = codexAppServerArgsForProfile("daniel-full");
    expect(args).toEqual(["app-server", "--listen", "stdio://"]);
  });

  it("uses workspace-write with network for Daniel coding", () => {
    expect(
      codexSandboxForRequest(
        request({
          mode: "coding",
          codexProfile: "daniel-full",
          cwd: "/tmp/daniel-project",
        }),
      ),
    ).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/tmp/daniel-project"],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
  });

  it("requires an explicit workspace for Daniel-full", () => {
    expect(() =>
      codexSandboxForRequest(
        request({
          mode: "coding",
          codexProfile: "daniel-full",
        }),
      ),
    ).toThrow("workspace cwd");
  });

  it("keeps dispatcher read-only without network", () => {
    expect(
      codexSandboxForRequest(request({ mode: "dispatcher" })),
    ).toEqual({ type: "readOnly", networkAccess: false });
  });

  it("omits collaboration mode for non-coding requests", () => {
    expect(
      buildCodexCollaborationMode(
        request({
          mode: "execution",
          codexCollaborationMode: "plan",
        }),
      ),
    ).toBeUndefined();
  });

  it("sends explicit developer instructions for coding plan mode", () => {
    const collaborationMode = buildCodexCollaborationMode(
      request({
        mode: "coding",
        codexCollaborationMode: "plan",
      }),
    );

    expect(collaborationMode?.mode).toBe("plan");
    expect(collaborationMode?.settings.model).toBe("gpt-5.5");
    expect(collaborationMode?.settings.reasoning_effort).toBe("medium");
    expect(collaborationMode?.settings.developer_instructions).toContain("system");
    expect(collaborationMode?.settings.developer_instructions).toContain("Daniel");
  });

  it("defaults coding collaboration mode to default with developer instructions", () => {
    const collaborationMode = buildCodexCollaborationMode(
      request({
        mode: "coding",
      }),
    );

    expect(collaborationMode?.mode).toBe("default");
    expect(collaborationMode?.settings.developer_instructions).toContain("system");
  });

  it("sends explicit default collaboration mode when requested", () => {
    const collaborationMode = buildCodexCollaborationMode(
      request({
        mode: "coding",
        codexCollaborationMode: "default",
      }),
    );

    expect(collaborationMode?.mode).toBe("default");
    expect(collaborationMode?.settings.developer_instructions).toContain("system");
  });
});
