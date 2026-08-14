import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrimaryOwnerPairing } from "./PrimaryOwnerPairing.js";

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PrimaryOwnerPairing", () => {
  it("shows only masked candidates and confirms through the opaque token", async () => {
    let paired = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/status")) {
        return json({
          ok: true,
          paired,
          identityStatus: "ready",
          codeActive: false,
          codeExpiresAt: null,
        });
      }
      if (url.endsWith("/candidates")) {
        return json({
          ok: true,
          candidates: [
            {
              token: "opaque-candidate-token",
              label: "••• ••67",
              lastInboundAt: Date.UTC(2026, 7, 14, 12, 0),
              expiresAt: Date.UTC(2026, 7, 14, 12, 10),
            },
          ],
        });
      }
      if (url.endsWith("/confirm") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ token: "opaque-candidate-token" });
        paired = true;
        return json({ ok: true, status: "registered" });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PrimaryOwnerPairing isDark={false} />);

    expect(await screen.findByText("••• ••67")).toBeTruthy();
    expect(document.body.textContent).not.toContain("opaque-candidate-token");
    await userEvent.click(screen.getByRole("button", { name: "Pair this conversation" }));

    expect(await screen.findByText("Primary owner paired.")).toBeTruthy();
    expect(screen.queryByText("••• ••67")).toBeNull();
    expect(document.body.textContent).not.toMatch(/ownerKey|containerTag|conversationId|salt|proof/i);
  });

  it("generates an expiring text command without persisting it in browser storage", async () => {
    const expiresAt = Date.now() + 10 * 60_000;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/status")) {
          return json({
            ok: true,
            paired: false,
            identityStatus: "ready",
            codeActive: false,
            codeExpiresAt: null,
          });
        }
        if (url.endsWith("/candidates")) return json({ ok: true, candidates: [] });
        if (url.endsWith("/code") && init?.method === "POST") {
          return json({ ok: true, status: "ready", code: "A1B2C3D4", expiresAt });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const storageSpy = vi.spyOn(Storage.prototype, "setItem");

    render(<PrimaryOwnerPairing isDark />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Generate pairing code" }),
    );

    expect(
      (await screen.findByLabelText("Temporary pairing command")).textContent,
    ).toContain("PAIR A1B2C3D4");
    expect(storageSpy).not.toHaveBeenCalled();
    storageSpy.mockRestore();
  });

  it("renders recovery-required state without loading or exposing candidates", async () => {
    const fetchMock = vi.fn(async () =>
      json({
        ok: true,
        paired: false,
        identityStatus: "recovery_required",
        codeActive: false,
        codeExpiresAt: null,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<PrimaryOwnerPairing isDark={false} />);

    expect(await screen.findByText("Recovery required")).toBeTruthy();
    expect(
      screen.getByText("Memory identity recovery is required before pairing."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /pairing code/i })).toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});
