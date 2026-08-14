import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryPanel } from "./MemoryPanel.js";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function providerStatus() {
  return {
    ok: true,
    configured: true,
    health: { status: "healthy" },
    backlog: { total: 0, active: 0 },
  };
}

function installFetch(profileResponse: Response | (() => Response)) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/memory/provider-status") return json(providerStatus());
    if (path === "/api/memory/profile") {
      return typeof profileResponse === "function" ? profileResponse() : profileResponse.clone();
    }
    if (path.startsWith("/api/memory/entries?")) {
      return json({
        entries: [
          {
            id: "memory-current",
            memory: "Prefers concise launch briefs",
            version: 2,
            isLatest: true,
            isForgotten: false,
            updatedAt: "2026-08-14T12:00:00.000Z",
            history: [
              {
                id: "memory-v1",
                version: 1,
                memory: "Prefers launch briefs",
                updatedAt: "2026-08-13T12:00:00.000Z",
              },
            ],
          },
        ],
      });
    }
    if (path.startsWith("/api/memory/documents?")) {
      return json({ documents: [{ id: "document-1", title: "Launch notes" }] });
    }
    if (path === "/api/memory/search" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { searchMode?: string };
      return body.searchMode === "documents"
        ? json({ ok: true, documents: [{ id: "document-2", title: "Matching notes" }] })
        : json({ ok: true, results: [] });
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MemoryPanel provider contracts", () => {
  it("renders ready profile facts and normalized current/version history", async () => {
    installFetch(
      json({
        profileState: "ready",
        profile: { static: ["Prefers concise answers"], dynamic: ["Planning a launch"] },
      }),
    );
    render(<MemoryPanel isDark={false} />);

    expect(await screen.findByText("Prefers concise answers")).toBeTruthy();
    expect(await screen.findByText("Planning a launch")).toBeTruthy();
    expect(await screen.findByText("Prefers concise launch briefs")).toBeTruthy();
    expect(screen.getByText("Current")).toBeTruthy();
    expect(screen.getByText("Version history · 1")).toBeTruthy();
  });

  it("renders an empty profile only when the provider successfully reports no facts", async () => {
    installFetch(json({ profileState: "empty", profile: { static: [], dynamic: [] } }));
    render(<MemoryPanel isDark />);
    expect(await screen.findByText(/No profile facts yet/)).toBeTruthy();
  });

  it("treats an empty semantic search response as a successful result", async () => {
    installFetch(json({ profileState: "empty", profile: { static: [], dynamic: [] } }));
    const user = userEvent.setup();
    render(<MemoryPanel isDark={false} />);

    await user.click(await screen.findByRole("tab", { name: "Search" }));
    await user.type(screen.getByRole("searchbox", { name: "Semantic memory search" }), "launch preferences");
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText("0 results found.")).toBeTruthy();
    expect(screen.getByText("No search results to show.")).toBeTruthy();
  });

  it("treats an empty document browse response as a successful result", async () => {
    const fetchMock = installFetch(
      json({ profileState: "empty", profile: { static: [], dynamic: [] } }),
    );
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/memory/provider-status") return json(providerStatus());
      if (path === "/api/memory/profile") {
        return json({ profileState: "empty", profile: { static: [], dynamic: [] } });
      }
      if (path.startsWith("/api/memory/entries?")) return json({ entries: [] });
      if (path.startsWith("/api/memory/documents?")) {
        return json({ ok: true, documents: [] });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const user = userEvent.setup();
    render(<MemoryPanel isDark={false} />);

    await user.click(await screen.findByRole("tab", { name: "Documents" }));
    expect(await screen.findByText("0 documents browsed.")).toBeTruthy();
    expect(screen.getByText("No source documents yet.")).toBeTruthy();
  });

  it("renders unavailable when the profile route fails", async () => {
    installFetch(() => json({ error: "provider unavailable" }, 503));
    render(<MemoryPanel isDark />);
    expect(await screen.findByText(/Profile unavailable: Request failed \(503\)/)).toBeTruthy();
  });

  it("browses documents without q and searches documents through POST search", async () => {
    const fetchMock = installFetch(
      json({ profileState: "empty", profile: { static: [], dynamic: [] } }),
    );
    const user = userEvent.setup();
    render(<MemoryPanel isDark={false} />);

    await user.click(await screen.findByRole("tab", { name: "Documents" }));
    expect(await screen.findByText("Launch notes")).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(([path]) =>
        String(path).startsWith("/api/memory/documents?page=1&limit=50"),
      ),
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(([path]) => String(path).includes("/api/memory/documents?q=")),
    ).toBe(false);

    const input = screen.getByRole("searchbox", { name: "Search source documents" });
    await user.type(input, "launch");
    await user.click(screen.getByRole("button", { name: "Search documents" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([path, init]) => String(path) === "/api/memory/search" && init?.method === "POST",
      );
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call?.[1]?.body))).toEqual(
        expect.objectContaining({ q: "launch", searchMode: "documents" }),
      );
    });
  });
});
