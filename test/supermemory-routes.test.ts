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
  MemoryHydrationResult,
  MemoryOwnerContext,
} from "../server/memory/supermemory/types.js";

const TEST_SALT = "test-only-route-salt-0123456789";

function owner(id: string): MemoryOwnerContext {
  return deriveMemoryIdentity(
    { memoryOwnerId: id, conversationId: `dashboard:${id}` },
    { salt: TEST_SALT },
  );
}

function controlPlane(
  overrides: Partial<MemoryRouteControlPlane> = {},
): MemoryRouteControlPlane {
  return {
    getProviderState: vi.fn(async () => ({
      healthStatus: "healthy",
      saltFingerprint: owner("configured-user").saltFingerprint,
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
    verifyMigration: vi.fn(async () => ({
      total: 10,
      pending: 0,
      migrated: 9,
      failed: 0,
      skipped: 1,
      migratedWithoutProviderId: 0,
      truncated: false,
      reconciled: true,
    })),
    getImageAnchorSummary: vi.fn(async () => ({
      pending: 0,
      active: 2,
      released: 1,
      activeWithoutProviderId: 0,
      truncated: false,
    })),
    ...overrides,
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

describe("Implementation 8 Supermemory routes", () => {
  it("limits the administrative surface to local requests and local browser origins", () => {
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

  it("returns normalized provider state without exposing persisted provider errors", async () => {
    const plane = controlPlane({
      getProviderState: vi.fn(async () => ({
        healthStatus: "degraded",
        lastSuccessfulSubmissionAt: 100,
        lastFailedSubmissionAt: 105,
        lastError: "Bearer sm_secret_should_not_leave_server",
        lastWorkerActivityAt: 108,
        updatedAt: 110,
      })),
    });
    const router = createMemoryRouter({
      localOnly: false,
      controlPlane: plane,
      env: {
        DANIEL_MEMORY_READ_MODE: "supermemory",
        DANIEL_MEMORY_WRITE_MODE: "supermemory",
        DANIEL_MEMORY_LEGACY_FALLBACK: "false",
        SUPERMEMORY_API_KEY: "server-only-test-key",
      },
      now: () => 120,
    });

    await withRouter(router, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/memory/provider-status`);
      expect(response.status).toBe(200);
      const body = await json(response);
      expect(body).toMatchObject({
        ok: true,
        provider: "supermemory",
        configured: true,
        readMode: "supermemory",
        writeMode: "supermemory",
        legacyFallback: false,
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
    });
  });

  it("derives the provider container from the authorized owner for profile, search, and documents", async () => {
    const authorized = owner("user-a");
    const foreign = owner("user-b");
    const hydration: MemoryHydrationResult = {
      provider: "supermemory",
      profile: { static: ["Prefers concise answers"], dynamic: ["Planning a trip"] },
      results: [
        {
          id: "memory-1",
          content: "Likes window seats",
          kind: "memory",
          similarity: 0.92,
          metadata: { source: "conversation" },
        },
      ],
      latencyMs: 12,
    };
    const profile = vi.fn<DanielMemoryProvider["profile"]>(async () => hydration);
    const search = vi.fn<DanielMemoryProvider["search"]>(async () => hydration.results);
    const listDocuments = vi.fn<DanielMemoryProvider["listDocuments"]>(async () => ({
      documents: [
        {
          id: "document-1",
          status: "done",
          customId: "turn-1",
          title: "Travel planning",
          summary: "Discussed a window-seat preference",
          type: "text",
          metadata: { source: "conversation" },
        },
      ],
      page: 1,
      totalItems: 1,
      totalPages: 1,
    }));
    const listMemories = vi.fn<NonNullable<DanielMemoryProvider["listMemories"]>>(async () => ({
      entries: [
        {
          id: "memory-1",
          content: "Likes window seats",
          version: 2,
          isLatest: true,
          isForgotten: false,
          isStatic: false,
          isInference: false,
          sourceCount: 1,
          parentMemoryId: "memory-0",
          rootMemoryId: "memory-0",
          forgetAfter: null,
          forgetReason: null,
          metadata: { source: "conversation" },
          history: [
            {
              id: "memory-0",
              content: "Likes aisle seats",
              version: 1,
              parentMemoryId: null,
              rootMemoryId: null,
              isLatest: false,
              isForgotten: false,
            },
          ],
          documentIds: ["document-1"],
        },
      ],
      page: 1,
      limit: 5,
      totalItems: 1,
      totalPages: 1,
    }));
    const router = createMemoryRouter({
      localOnly: false,
      provider: { profile, search, listDocuments, listMemories },
      controlPlane: controlPlane(),
      resolveOwner: async () => authorized,
    });

    await withRouter(router, async (baseUrl) => {
      const profileResponse = await fetch(`${baseUrl}/memory/profile?q=travel`);
      expect(profileResponse.status).toBe(200);
      expect(await json(profileResponse)).toMatchObject({
        ok: true,
        profileState: "ready",
        provider: "supermemory",
        profile: { static: ["Prefers concise answers"], dynamic: ["Planning a trip"] },
      });

      const searchResponse = await fetch(`${baseUrl}/memory/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          q: "seat preference",
          searchMode: "memories",
          containerTag: foreign.containerTag,
          ownerKey: foreign.ownerKey,
        }),
      });
      expect(searchResponse.status).toBe(200);

      const documentsResponse = await fetch(
        `${baseUrl}/memory/documents?page=1&limit=5`,
      );
      expect(documentsResponse.status).toBe(200);
      expect(await json(documentsResponse)).toMatchObject({
        ok: true,
        documents: [{ id: "document-1", customId: "turn-1", status: "done" }],
        page: 1,
        totalItems: 1,
      });

      const rejectedDocumentQuery = await fetch(
        `${baseUrl}/memory/documents?q=seat`,
      );
      expect(rejectedDocumentQuery.status).toBe(400);

      const entriesResponse = await fetch(
        `${baseUrl}/memory/entries?page=1&limit=5&order=desc&sort=updatedAt&containerTag=${encodeURIComponent(foreign.containerTag)}`,
      );
      expect(entriesResponse.status).toBe(200);
      expect(await json(entriesResponse)).toMatchObject({
        ok: true,
        entries: [
          {
            id: "memory-1",
            isLatest: true,
            isForgotten: false,
            history: [{ id: "memory-0", isLatest: false }],
          },
        ],
      });
    });

    expect(profile).toHaveBeenCalledWith(
      expect.objectContaining({ containerTag: authorized.containerTag, q: "travel" }),
    );
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        containerTag: authorized.containerTag,
        q: "seat preference",
        searchMode: "memories",
      }),
    );
    expect(listDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        containerTag: authorized.containerTag,
        page: 1,
        limit: 5,
      }),
    );
    expect(listMemories).toHaveBeenCalledWith(
      expect.objectContaining({
        containerTag: authorized.containerTag,
        page: 1,
        limit: 5,
        order: "desc",
        sort: "updatedAt",
      }),
    );
    expect(
      JSON.stringify([
        ...profile.mock.calls,
        ...search.mock.calls,
        ...listDocuments.mock.calls,
        ...listMemories.mock.calls,
      ]),
    ).not.toContain(foreign.containerTag);
  });

  it("retries only an exact job owned by the authorized container", async () => {
    const authorized = owner("user-a");
    const foreign = owner("user-b");
    const retryJob = vi.fn(
      async (input: {
        jobId: string;
        ownerKey: string;
        containerTag: string;
        expectedStatus: "failed" | "dead_letter";
      }) =>
        input.jobId === "owned-job"
          ? {
              retried: true,
              job: {
                jobId: input.jobId,
                ownerKey: authorized.ownerKey,
                containerTag: authorized.containerTag,
                status: "pending",
                attempts: 0,
                nextAttemptAt: 300,
                updatedAt: 301,
              },
            }
          : { retried: false, reason: "not_found", job: null },
    );
    const plane = controlPlane({
      retryJob,
    });
    const router = createMemoryRouter({
      localOnly: false,
      provider: null,
      controlPlane: plane,
      resolveOwner: async () => authorized,
    });

    await withRouter(router, async (baseUrl) => {
      const owned = await fetch(`${baseUrl}/memory/retry-job`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: "owned-job" }),
      });
      expect(owned.status).toBe(200);
      expect(await json(owned)).toMatchObject({
        ok: true,
        job: { jobId: "owned-job", status: "pending", attempts: 0 },
      });

      const blocked = await fetch(`${baseUrl}/memory/retry-job`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: "foreign-job" }),
      });
      expect(blocked.status).toBe(404);
      expect(await json(blocked)).toMatchObject({
        error: { code: "job_not_found" },
      });
    });

    expect(retryJob).toHaveBeenCalledTimes(2);
    expect(retryJob).toHaveBeenCalledWith({
      jobId: "owned-job",
      ownerKey: authorized.ownerKey,
      containerTag: authorized.containerTag,
      expectedStatus: "failed",
    });
  });

  it("retires embedding routes and returns aggregate migration verification", async () => {
    const router = createMemoryRouter({
      localOnly: false,
      provider: null,
      controlPlane: controlPlane(),
      resolveOwner: async () => owner("user-a"),
    });

    await withRouter(router, async (baseUrl) => {
      expect((await fetch(`${baseUrl}/memory/embedding-status`)).status).toBe(404);
      expect(
        (await fetch(`${baseUrl}/memory/reembed`, { method: "POST" })).status,
      ).toBe(404);
      const verification = await fetch(`${baseUrl}/memory/migration/verify`, {
        method: "POST",
      });
      expect(verification.status).toBe(200);
      expect(await json(verification)).toMatchObject({
        ok: true,
        ready: true,
        migration: { total: 10, migrated: 9, skipped: 1 },
        imageAnchors: { active: 2, released: 1 },
      });
    });
  });
});
