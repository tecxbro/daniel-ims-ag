import { once } from "node:events";
import { createServer, type Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter } from "../server/memory-routes.js";
import {
  isLocalMemoryRouteRequest,
  type MemoryRouteControlPlane,
} from "../server/memory/supermemory/routes.js";
import { deriveMemoryIdentity } from "../server/memory/supermemory/identity.js";
import type {
  DanielMemoryProvider,
  MemoryOwnerContext,
} from "../server/memory/supermemory/types.js";

const TEST_SALT = "7".repeat(64);

function owner(id: string): MemoryOwnerContext {
  return deriveMemoryIdentity(
    { memoryOwnerId: id, conversationId: `sms:+15555550123` },
    { salt: TEST_SALT },
  );
}

const authorized = owner("user-a");
const ownerScope = {
  ownerKey: authorized.ownerKey,
  containerTag: authorized.containerTag,
  conversationId: "sms:+15555550123",
  registeredAt: 100,
};

function controlPlane(
  overrides: Partial<MemoryRouteControlPlane> = {},
): MemoryRouteControlPlane {
  return {
    getProviderState: vi.fn(async () => ({
      healthStatus: "healthy",
      lastSuccessfulSubmissionAt: 100,
      updatedAt: 110,
    })),
    getBacklog: vi.fn(async () => ({
      counts: {
        pending: { count: 2 },
        processing: { count: 1 },
        submitted: { count: 0 },
        failed: { count: 3 },
        dead_letter: { count: 4 },
      },
      active: 6,
      total: 10,
      truncated: false,
    })),
    retryJob: vi.fn(async () => ({ retried: false, reason: "not_found", job: null })),
    getPrimaryOwnerScope: vi.fn(async () => ownerScope),
    ...overrides,
  };
}

function pairing() {
  return {
    status: vi.fn(async () => ({
      paired: false,
      identityStatus: "ready" as const,
      codeActive: false,
      codeExpiresAt: null,
    })),
    rotateCode: vi.fn(async () => ({
      status: "ready" as const,
      code: "ABCDEFGH",
      expiresAt: 10_000,
    })),
    listCandidates: vi.fn(async () => [
      { token: "candidate_opaque", label: "+1•••0123", lastInboundAt: 90, expiresAt: 10_000 },
    ]),
    confirmCandidate: vi.fn(async () => "registered" as const),
  };
}

async function withRouter<T>(
  router: express.Router,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use("/memory", router);
  const server: Server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Implementation 10 Supermemory routes", () => {
  it("limits the administrative surface to local browser requests", () => {
    expect(
      isLocalMemoryRouteRequest(
        { host: "localhost:3456", origin: "http://localhost:5173" },
        "127.0.0.1",
      ),
    ).toBe(true);
    expect(
      isLocalMemoryRouteRequest(
        { host: "localhost:3456", origin: "https://attacker.example" },
        "127.0.0.1",
      ),
    ).toBe(false);
    expect(
      isLocalMemoryRouteRequest(
        { host: "localhost:3456", "x-forwarded-for": "203.0.113.7" },
        "127.0.0.1",
      ),
    ).toBe(false);
  });

  it("returns safe configured and unconfigured provider state", async () => {
    const plane = controlPlane({
      getProviderState: vi.fn(async () => ({
        healthStatus: "degraded",
        lastSuccessfulSubmissionAt: 100,
        lastFailedSubmissionAt: 105,
        lastError: "Bearer sm_secret_should_not_leave_server",
        hasError: true,
        lastWorkerActivityAt: 108,
        updatedAt: 110,
      })),
    });
    const configuredRouter = createMemoryRouter({
      localOnly: false,
      controlPlane: plane,
      env: { SUPERMEMORY_API_KEY: "server-only-test-key" },
      getIdentityStatus: async () => ({ status: "ready" }),
      now: () => 120,
    });
    await withRouter(configuredRouter, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/memory/provider-status`);
      expect(response.status).toBe(200);
      const body = await json(response);
      expect(body).toMatchObject({
        ok: true,
        provider: "supermemory",
        configured: true,
        health: {
          status: "degraded",
          lastSuccessAt: 100,
          lastFailureAt: 105,
          hasError: true,
        },
        backlog: { pending: 2, processing: 1, failed: 3, deadLetter: 4 },
        checkedAt: 120,
      });
      expect(JSON.stringify(body)).not.toContain("secret_should_not_leave_server");
      expect(JSON.stringify(body)).not.toContain(authorized.ownerKey);
      expect(JSON.stringify(body)).not.toContain(ownerScope.conversationId);
    });

    const unconfiguredRouter = createMemoryRouter({
      localOnly: false,
      controlPlane: plane,
      env: {},
    });
    await withRouter(unconfiguredRouter, async (baseUrl) => {
      await expect(json(await fetch(`${baseUrl}/memory/provider-status`))).resolves.toMatchObject({
        configured: false,
        health: { status: "unconfigured" },
      });
    });

    const recoveryRouter = createMemoryRouter({
      localOnly: false,
      controlPlane: plane,
      env: { SUPERMEMORY_API_KEY: "server-only-test-key" },
      getIdentityStatus: async () => ({ status: "recovery_required" }),
    });
    await withRouter(recoveryRouter, async (baseUrl) => {
      await expect(json(await fetch(`${baseUrl}/memory/provider-status`))).resolves.toMatchObject({
        configured: true,
        health: { status: "recovery_required" },
      });
    });
  });

  it("requires a stored paired owner before provider dashboard reads", async () => {
    const profile = vi.fn<DanielMemoryProvider["profile"]>();
    const router = createMemoryRouter({
      localOnly: false,
      provider: {
        profile,
        search: vi.fn(),
        listDocuments: vi.fn(),
      },
      controlPlane: controlPlane({ getPrimaryOwnerScope: vi.fn(async () => null) }),
    });
    await withRouter(router, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/memory/profile`);
      expect(response.status).toBe(503);
      await expect(json(response)).resolves.toMatchObject({
        error: { code: "owner_not_paired" },
      });
    });
    expect(profile).not.toHaveBeenCalled();
  });

  it("treats empty profile, search, and document responses as successful", async () => {
    const profile = vi.fn<DanielMemoryProvider["profile"]>(async () => ({
      provider: "supermemory",
      profile: { static: [], dynamic: [] },
      results: [],
      latencyMs: 3,
    }));
    const search = vi.fn<DanielMemoryProvider["search"]>(async () => []);
    const listDocuments = vi.fn<DanielMemoryProvider["listDocuments"]>(async () => ({
      documents: [],
      page: 1,
      totalItems: 0,
      totalPages: 0,
    }));
    const router = createMemoryRouter({
      localOnly: false,
      provider: { profile, search, listDocuments },
      controlPlane: controlPlane(),
    });

    await withRouter(router, async (baseUrl) => {
      await expect(json(await fetch(`${baseUrl}/memory/profile`))).resolves.toMatchObject({
        ok: true,
        profileState: "empty",
        profile: { static: [], dynamic: [] },
        results: [],
      });
      await expect(
        json(
          await fetch(`${baseUrl}/memory/search`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ q: "nothing here" }),
          }),
        ),
      ).resolves.toMatchObject({ ok: true, results: [] });
      await expect(json(await fetch(`${baseUrl}/memory/documents`))).resolves.toMatchObject({
        ok: true,
        documents: [],
        totalItems: 0,
      });
    });

    for (const call of [profile, search, listDocuments]) {
      expect(call).toHaveBeenCalledWith(
        expect.objectContaining({ containerTag: authorized.containerTag }),
      );
    }
  });

  it("retries only an exact job owned by the stored owner", async () => {
    const retryJob = vi.fn(async (input: {
      jobId: string;
      ownerKey: string;
      containerTag: string;
      expectedStatus: "failed" | "dead_letter";
    }) => ({
      retried: true,
      job: {
        jobId: input.jobId,
        ownerKey: ownerScope.ownerKey,
        containerTag: ownerScope.containerTag,
        status: "pending",
        attempts: 0,
        nextAttemptAt: 300,
        updatedAt: 301,
      },
    }));
    const router = createMemoryRouter({
      localOnly: false,
      provider: null,
      controlPlane: controlPlane({ retryJob }),
    });

    await withRouter(router, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/memory/retry-job`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: "owned-job" }),
      });
      expect(response.status).toBe(200);
    });
    expect(retryJob).toHaveBeenCalledWith({
      jobId: "owned-job",
      ownerKey: ownerScope.ownerKey,
      containerTag: ownerScope.containerTag,
      expectedStatus: "failed",
    });
  });

  it("exposes only safe local pairing responses and no removed route", async () => {
    const pairingApi = pairing();
    const router = createMemoryRouter({
      localOnly: false,
      provider: null,
      controlPlane: controlPlane(),
      pairing: pairingApi,
    });
    await withRouter(router, async (baseUrl) => {
      await expect(json(await fetch(`${baseUrl}/memory/pairing/status`))).resolves.toEqual({
        ok: true,
        paired: false,
        identityStatus: "ready",
        codeActive: false,
        codeExpiresAt: null,
      });
      await expect(
        json(await fetch(`${baseUrl}/memory/pairing/code`, { method: "POST" })),
      ).resolves.toMatchObject({ ok: true, status: "ready", code: "ABCDEFGH" });
      await expect(
        json(await fetch(`${baseUrl}/memory/pairing/candidates`)),
      ).resolves.toMatchObject({
        ok: true,
        candidates: [{ token: "candidate_opaque", label: "+1•••0123" }],
      });
      const confirmation = await fetch(`${baseUrl}/memory/pairing/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "candidate_opaque" }),
      });
      expect(confirmation.status).toBe(200);
      await expect(json(confirmation)).resolves.toEqual({ ok: true, status: "registered" });
    });
  });
});
