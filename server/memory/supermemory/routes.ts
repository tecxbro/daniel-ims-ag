import express from "express";
import type { NextFunction, Request, Response } from "express";
import { api } from "../../../convex/_generated/api.js";
import { convex } from "../../convex-client.js";
import {
  getSupermemoryProvider,
  readMemoryProviderConfiguration,
  SupermemoryProviderError,
} from "./client.js";
import {
  inspectCaptureRecoveryJournal,
  type CaptureRecoveryStatus,
} from "./capture-recovery.js";
import {
  deriveMemoryIdentity,
  MemoryIdentityConfigurationError,
  validateProviderIdentifier,
} from "./identity.js";
import type {
  DanielMemoryProvider,
  MemoryHydrationResult,
  MemoryOwnerContext,
  MemorySearchResult,
} from "./types.js";
import {
  recordProviderRead,
  type ProviderReadOperation,
} from "./provider-observability.js";

type Environment = Record<string, string | undefined>;
type RetryableJobStatus = "failed" | "dead_letter";

interface MemoryRouteProvider
  extends Pick<
    DanielMemoryProvider,
    "profile" | "search" | "listDocuments" | "listMemories"
  > {}

export interface MemoryRouteControlPlane {
  getProviderState(): Promise<unknown>;
  getBacklog(): Promise<unknown>;
  retryJob(input: {
    jobId: string;
    ownerKey: string;
    containerTag: string;
    expectedStatus: RetryableJobStatus;
  }): Promise<unknown>;
  verifyMigration(input: {
    ownerKey: string;
    containerTag: string;
  }): Promise<unknown>;
  getImageAnchorSummary(ownerKey: string): Promise<unknown>;
}

export interface CreateSupermemoryRouterOptions {
  env?: Environment;
  provider?: MemoryRouteProvider | null;
  getProvider?: () => MemoryRouteProvider | null;
  controlPlane?: MemoryRouteControlPlane;
  resolveOwner?: (request: Request) => Promise<MemoryOwnerContext>;
  /** Tests and a future authenticated parent router may provide an equivalent boundary. */
  localOnly?: boolean;
  now?: () => number;
  getRecoveryStatus?: () => Promise<CaptureRecoveryStatus>;
  recordProviderRead?: typeof recordProviderRead;
}

const MAX_QUERY_LENGTH = 8_000;
const MAX_JOB_ID_LENGTH = 256;

class MemoryRouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = "MemoryRouteError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstHeaderValue(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(",")[0]?.trim() ?? "";
}

function headerValues(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value.join(",") : value;
  return raw
    ? raw
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
    : [];
}

function hostWithoutPort(value: string): string {
  const host = value.trim().toLowerCase();
  if (!host) return "";
  if (host.startsWith("[") && host.includes("]")) {
    return host.slice(1, host.indexOf("]"));
  }
  if ((host.match(/:/g) ?? []).length > 1) return host;
  return host.split(":")[0] ?? "";
}

function isLocalHost(value: string): boolean {
  const host = hostWithoutPort(value);
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "0:0:0:0:0:0:0:1" ||
    /^127\./.test(host)
  );
}

function isLocalAddress(value: string): boolean {
  return isLocalHost(firstHeaderValue(value).replace(/^::ffff:/, ""));
}

function hasLocalOrigin(value: string | string[] | undefined): boolean {
  const origin = firstHeaderValue(value);
  if (!origin) return true;
  try {
    return isLocalHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** These administrative routes are intentionally unavailable through a public URL. */
export function isLocalMemoryRouteRequest(
  headers: Record<string, string | string[] | undefined>,
  remoteAddress?: string,
): boolean {
  if (remoteAddress !== undefined && !isLocalAddress(remoteAddress)) return false;
  if (!hasLocalOrigin(headers.origin)) return false;
  if (!headerValues(headers["x-forwarded-for"]).every(isLocalAddress)) return false;
  if (!headerValues(headers["x-forwarded-host"]).every(isLocalHost)) return false;
  const host = firstHeaderValue(headers.host);
  return !host || isLocalHost(host);
}

function requireLocalRequest(req: Request, res: Response, next: NextFunction): void {
  if (isLocalMemoryRouteRequest(req.headers, req.socket.remoteAddress ?? "")) {
    next();
    return;
  }
  res.status(403).json({
    ok: false,
    error: { code: "forbidden", message: "Memory administration is only available locally." },
  });
}

function createDefaultControlPlane(): MemoryRouteControlPlane {
  return {
    getProviderState: () =>
      convex.query(api.memoryProviderState.getDeploymentState, {}),
    getBacklog: () =>
      convex.query(api.memoryProviderState.getBacklogSummary, {}),
    retryJob: (input) =>
      convex.mutation(api.memorySyncJobs.retryOwned, input),
    verifyMigration: (input) =>
      convex.query(api.memoryMigration.verifyOwnerCutover, input),
    getImageAnchorSummary: (ownerKey) =>
      convex.query(api.memoryImageAnchors.getOwnerSummary, { ownerKey }),
  };
}

function assertOwnerScope(owner: MemoryOwnerContext): void {
  try {
    validateProviderIdentifier(owner.ownerKey, "ownerKey");
    validateProviderIdentifier(owner.containerTag, "containerTag");
  } catch {
    throw new MemoryRouteError(503, "owner_unavailable", "Memory owner is unavailable.");
  }
  if (!/^[a-f0-9]{32}$/.test(owner.ownerKey)) {
    throw new MemoryRouteError(503, "owner_unavailable", "Memory owner is unavailable.");
  }
  if (owner.containerTag !== `daniel-user-${owner.ownerKey}`) {
    throw new MemoryRouteError(503, "owner_unavailable", "Memory owner is unavailable.");
  }
}

async function resolveConfiguredOwner(
  env: Environment,
  controlPlane: MemoryRouteControlPlane,
): Promise<MemoryOwnerContext> {
  const memoryOwnerId = env.DANIEL_USER_PHONE?.trim();
  if (!memoryOwnerId) {
    throw new MemoryRouteError(
      503,
      "owner_not_configured",
      "The dashboard memory owner is not configured.",
    );
  }
  let providerState: Record<string, unknown> | null;
  try {
    providerState = asRecord(await controlPlane.getProviderState());
  } catch {
    throw new MemoryRouteError(503, "owner_unavailable", "Memory owner is unavailable.");
  }
  const expectedSaltFingerprint = providerState?.saltFingerprint;
  if (typeof expectedSaltFingerprint !== "string") {
    throw new MemoryRouteError(503, "owner_unavailable", "Memory owner is unavailable.");
  }
  try {
    return deriveMemoryIdentity(
      { memoryOwnerId, conversationId: "memory-dashboard" },
      {
        salt: env.DANIEL_MEMORY_ID_SALT,
        expectedSaltFingerprint,
      },
    );
  } catch {
    throw new MemoryRouteError(503, "owner_unavailable", "Memory owner is unavailable.");
  }
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new MemoryRouteError(400, "invalid_request", `${label} is required.`);
  }
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > maxLength || /\p{Cc}/u.test(normalized)) {
    throw new MemoryRouteError(400, "invalid_request", `${label} is invalid.`);
  }
  return normalized;
}

function optionalString(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label, maxLength);
}

function optionalNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  integer = false,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new MemoryRouteError(400, "invalid_request", `${label} is invalid.`);
  }
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < minimum ||
    parsed > maximum ||
    (integer && !Number.isInteger(parsed))
  ) {
    throw new MemoryRouteError(400, "invalid_request", `${label} is invalid.`);
  }
  return parsed;
}

function normalizeSearchResult(value: MemorySearchResult): MemorySearchResult | null {
  if (
    typeof value?.id !== "string" ||
    typeof value.content !== "string" ||
    (value.kind !== "memory" && value.kind !== "chunk") ||
    typeof value.similarity !== "number"
  ) {
    return null;
  }
  return {
    id: value.id,
    content: value.content,
    kind: value.kind,
    similarity: value.similarity,
    metadata: asRecord(value.metadata),
    ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
    ...(typeof value.version === "number" || value.version === null
      ? { version: value.version }
      : {}),
  };
}

function normalizeResults(values: readonly MemorySearchResult[]): MemorySearchResult[] {
  return values
    .map(normalizeSearchResult)
    .filter((value): value is MemorySearchResult => value !== null);
}

function normalizeProfile(result: MemoryHydrationResult): MemoryHydrationResult {
  return {
    provider: "supermemory",
    profile: {
      static: Array.isArray(result.profile?.static)
        ? result.profile.static.filter((value): value is string => typeof value === "string")
        : [],
      dynamic: Array.isArray(result.profile?.dynamic)
        ? result.profile.dynamic.filter((value): value is string => typeof value === "string")
        : [],
    },
    results: Array.isArray(result.results) ? normalizeResults(result.results) : [],
    latencyMs:
      typeof result.latencyMs === "number" && Number.isFinite(result.latencyMs)
        ? Math.max(0, result.latencyMs)
        : 0,
  };
}

function nonNegativeCount(value: unknown): number {
  const nested = asRecord(value);
  const candidate = typeof value === "number" ? value : nested?.count;
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? Math.max(0, Math.floor(candidate))
    : 0;
}

export function normalizeBacklog(value: unknown): Record<string, number | boolean> | null {
  const backlog = asRecord(value);
  if (!backlog) return null;
  const counts = asRecord(backlog.counts) ?? backlog;
  const pending = nonNegativeCount(counts.pending);
  const processing = nonNegativeCount(counts.processing);
  const submitted = nonNegativeCount(counts.submitted);
  const completed = nonNegativeCount(counts.completed);
  const failed = nonNegativeCount(counts.failed);
  const deadLetter = Math.max(
    nonNegativeCount(counts.deadLetter),
    nonNegativeCount(counts.dead_letter),
  );
  const suppliedTotal =
    typeof backlog.total === "number" && Number.isFinite(backlog.total)
      ? Math.max(0, Math.floor(backlog.total))
      : undefined;
  const suppliedActive =
    typeof backlog.active === "number" && Number.isFinite(backlog.active)
      ? Math.max(0, Math.floor(backlog.active))
      : undefined;
  return {
    pending,
    processing,
    submitted,
    completed,
    failed,
    deadLetter,
    active: suppliedActive ?? pending + processing + submitted + failed,
    total:
      suppliedTotal ??
      (suppliedActive !== undefined
        ? suppliedActive + deadLetter
        : pending + processing + submitted + completed + failed + deadLetter),
    truncated: backlog.truncated === true,
  };
}

function publicError(error: unknown): MemoryRouteError {
  if (error instanceof MemoryRouteError) return error;
  if (error instanceof SupermemoryProviderError) {
    const status = error.code === "timeout" ? 504 : 503;
    return new MemoryRouteError(status, "provider_unavailable", "Memory provider is unavailable.");
  }
  if (error instanceof MemoryIdentityConfigurationError) {
    return new MemoryRouteError(503, "owner_unavailable", "Memory owner is unavailable.");
  }
  return new MemoryRouteError(500, "internal_error", "Memory request failed.");
}

function route(
  handler: (request: Request, response: Response) => Promise<void>,
): (request: Request, response: Response) => Promise<void> {
  return async (request, response) => {
    try {
      await handler(request, response);
    } catch (error) {
      const safe = publicError(error);
      response.status(safe.status).json({
        ok: false,
        error: { code: safe.code, message: safe.publicMessage },
      });
    }
  };
}

function providerHealth(
  configured: boolean,
  readMode: string,
  writeMode: string,
  providerState: Record<string, unknown> | null,
): "disabled" | "unconfigured" | "healthy" | "degraded" | "unavailable" {
  if (readMode === "convex" && writeMode === "convex") return "disabled";
  if (!configured) return "unconfigured";
  const value = providerState?.healthStatus;
  return value === "healthy" || value === "degraded" || value === "unavailable"
    ? value
    : "unavailable";
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function createSupermemoryRouter(
  options: CreateSupermemoryRouterOptions = {},
): express.Router {
  const router = express.Router();
  const env = options.env ?? process.env;
  const controlPlane = options.controlPlane ?? createDefaultControlPlane();
  const now = options.now ?? Date.now;
  const getRecoveryStatus = options.getRecoveryStatus ?? inspectCaptureRecoveryJournal;
  const resolveOwner =
    options.resolveOwner ?? (() => resolveConfiguredOwner(env, controlPlane));
  const getProvider =
    options.getProvider ??
    (() => (options.provider === undefined ? getSupermemoryProvider() : options.provider));
  const recordRead =
    options.recordProviderRead ??
    (options.provider === undefined && options.getProvider === undefined
      ? recordProviderRead
      : async () => undefined);

  if (options.localOnly !== false) router.use(requireLocalRequest);

  const ownerFor = async (request: Request): Promise<MemoryOwnerContext> => {
    const owner = await resolveOwner(request);
    assertOwnerScope(owner);
    return owner;
  };

  const providerForRequest = (): MemoryRouteProvider => {
    const provider = getProvider();
    if (!provider) {
      throw new MemoryRouteError(503, "provider_unavailable", "Memory provider is unavailable.");
    }
    return provider;
  };

  const observedProviderRead = async <T>(
    operation: ProviderReadOperation,
    run: () => Promise<T>,
  ): Promise<T> => {
    const startedAt = now();
    try {
      const result = await run();
      await recordRead({ operation, startedAt, finishedAt: now() });
      return result;
    } catch (error) {
      await recordRead({ operation, startedAt, finishedAt: now(), error });
      throw error;
    }
  };

  router.get(
    "/provider-status",
    route(async (_request, response) => {
      const config = readMemoryProviderConfiguration(env);
      const [providerStateResult, backlogResult, recoveryResult] = await Promise.allSettled([
        controlPlane.getProviderState(),
        controlPlane.getBacklog(),
        getRecoveryStatus(),
      ]);
      const state =
        providerStateResult.status === "fulfilled"
          ? asRecord(providerStateResult.value)
          : null;
      const backlog =
        backlogResult.status === "fulfilled" ? normalizeBacklog(backlogResult.value) : null;
      response.json({
        ok: true,
        provider: "supermemory",
        configured: config.apiKeyConfigured,
        readMode: config.readMode,
        writeMode: config.writeMode,
        legacyFallback: config.legacyFallback,
        health: {
          status: providerHealth(
            config.apiKeyConfigured,
            config.readMode,
            config.writeMode,
            state,
          ),
          lastSuccessAt: numberOrNull(state?.lastSuccessfulSubmissionAt),
          lastFailureAt: numberOrNull(state?.lastFailedSubmissionAt),
          lastWorkerActivityAt: numberOrNull(state?.lastWorkerActivityAt),
          updatedAt: numberOrNull(state?.updatedAt),
          hasError: typeof state?.lastError === "string" && state.lastError.length > 0,
        },
        backlog,
        recoveryJournal:
          recoveryResult.status === "fulfilled"
            ? recoveryResult.value
            : { unresolvedCount: null, oldestCreatedAt: null, oldestAgeMs: null },
        availability: {
          providerState: providerStateResult.status === "fulfilled",
          backlog: backlogResult.status === "fulfilled",
          recoveryJournal: recoveryResult.status === "fulfilled",
        },
        checkedAt: now(),
      });
    }),
  );

  router.get(
    "/profile",
    route(async (request, response) => {
      const owner = await ownerFor(request);
      const q = optionalString(request.query.q, "q", MAX_QUERY_LENGTH);
      const threshold = optionalNumber(request.query.threshold, "threshold", 0, 1);
      const profile = normalizeProfile(
        await observedProviderRead("profile", () => providerForRequest().profile({
          containerTag: owner.containerTag,
          ...(q ? { q } : {}),
          ...(threshold === undefined ? {} : { threshold }),
        })),
      );
      const factCount = profile.profile.static.length + profile.profile.dynamic.length;
      response.json({
        ok: true,
        profileState: factCount > 0 ? "ready" : "empty",
        ...profile,
      });
    }),
  );

  router.post(
    "/search",
    route(async (request, response) => {
      const owner = await ownerFor(request);
      const body = asRecord(request.body) ?? {};
      const q = requiredString(body.q, "q", MAX_QUERY_LENGTH);
      const threshold = optionalNumber(body.threshold, "threshold", 0, 1);
      const limit = optionalNumber(body.limit, "limit", 1, 100, true);
      const searchMode = body.searchMode ?? "hybrid";
      if (
        searchMode !== "memories" &&
        searchMode !== "hybrid" &&
        searchMode !== "documents"
      ) {
        throw new MemoryRouteError(400, "invalid_request", "searchMode is invalid.");
      }
      const results = normalizeResults(
        await observedProviderRead("search", () => providerForRequest().search({
          containerTag: owner.containerTag,
          q,
          searchMode,
          ...(threshold === undefined ? {} : { threshold }),
          ...(limit === undefined ? {} : { limit }),
        })),
      );
      response.json({ ok: true, provider: "supermemory", searchMode, results });
    }),
  );

  router.get(
    "/documents",
    route(async (request, response) => {
      if (request.query.q !== undefined) {
        throw new MemoryRouteError(
          400,
          "invalid_request",
          "Document browse does not accept q; use memory search with searchMode documents.",
        );
      }
      const owner = await ownerFor(request);
      const page = optionalNumber(request.query.page, "page", 1, 100_000, true);
      const limit = optionalNumber(request.query.limit, "limit", 1, 100, true);
      const result = await observedProviderRead("documents", () =>
        providerForRequest().listDocuments({
        containerTag: owner.containerTag,
        ...(page === undefined ? {} : { page }),
        ...(limit === undefined ? {} : { limit }),
        }),
      );
      response.json({
        ok: true,
        provider: "supermemory",
        ...result,
      });
    }),
  );

  router.get(
    "/entries",
    route(async (request, response) => {
      const owner = await ownerFor(request);
      const page = optionalNumber(request.query.page, "page", 1, 100_000, true);
      const limit = optionalNumber(request.query.limit, "limit", 1, 100, true);
      const order = request.query.order ?? "desc";
      const sort = request.query.sort ?? "updatedAt";
      if (order !== "asc" && order !== "desc") {
        throw new MemoryRouteError(400, "invalid_request", "order is invalid.");
      }
      if (sort !== "createdAt" && sort !== "updatedAt") {
        throw new MemoryRouteError(400, "invalid_request", "sort is invalid.");
      }
      const provider = providerForRequest();
      if (!provider.listMemories) {
        throw new MemoryRouteError(
          503,
          "provider_unavailable",
          "Memory history is unavailable from the configured provider.",
        );
      }
      const result = await observedProviderRead("entries", () => provider.listMemories!({
        containerTag: owner.containerTag,
        ...(page === undefined ? {} : { page }),
        ...(limit === undefined ? {} : { limit }),
        order,
        sort,
      }));
      response.json({ ok: true, provider: "supermemory", ...result });
    }),
  );

  const retryHandler = (status: RetryableJobStatus) =>
    route(async (request, response) => {
      const owner = await ownerFor(request);
      const body = asRecord(request.body) ?? {};
      const jobId = requiredString(body.jobId, "jobId", MAX_JOB_ID_LENGTH);
      const result = asRecord(
        await controlPlane.retryJob({
          jobId,
          ownerKey: owner.ownerKey,
          containerTag: owner.containerTag,
          expectedStatus: status,
        }),
      );
      const job = asRecord(result?.job);
      if (result?.retried !== true) {
        const reason = result?.reason === "not_found" ? "job_not_found" : "job_not_retryable";
        throw new MemoryRouteError(
          reason === "job_not_found" ? 404 : 409,
          reason,
          reason === "job_not_found"
            ? "Retryable memory job was not found."
            : "Memory job is not retryable.",
        );
      }
      if (
        job?.jobId !== jobId ||
        job.ownerKey !== owner.ownerKey ||
        job.containerTag !== owner.containerTag
      ) {
        throw new MemoryRouteError(500, "internal_error", "Memory request failed.");
      }
      response.json({
        ok: true,
        job: {
          jobId,
          status: job.status === "pending" ? "pending" : "queued",
          attempts: typeof job.attempts === "number" ? job.attempts : 0,
          nextAttemptAt: numberOrNull(job.nextAttemptAt),
          updatedAt: numberOrNull(job.updatedAt),
        },
      });
    });

  router.post("/retry-job", retryHandler("failed"));
  router.post("/retry-dead-letter", retryHandler("dead_letter"));

  router.post(
    "/migration/verify",
    route(async (request, response) => {
      const owner = await ownerFor(request);
      const [migrationValue, imageAnchorValue] = await Promise.all([
        controlPlane.verifyMigration({
          ownerKey: owner.ownerKey,
          containerTag: owner.containerTag,
        }),
        controlPlane.getImageAnchorSummary(owner.ownerKey),
      ]);
      const migration = asRecord(migrationValue);
      const imageAnchors = asRecord(imageAnchorValue);
      if (!migration || !imageAnchors) {
        throw new MemoryRouteError(503, "verification_unavailable", "Migration verification is unavailable.");
      }
      const ready =
        migration.reconciled === true &&
        migration.truncated !== true &&
        imageAnchors.truncated !== true &&
        nonNegativeCount(imageAnchors.activeWithoutProviderId) === 0;
      response.status(ready ? 200 : 409).json({
        ok: ready,
        ready,
        migration: {
          total: nonNegativeCount(migration.total),
          pending: nonNegativeCount(migration.pending),
          migrated: nonNegativeCount(migration.migrated),
          failed: nonNegativeCount(migration.failed),
          skipped: nonNegativeCount(migration.skipped),
          migratedWithoutProviderId: nonNegativeCount(
            migration.migratedWithoutProviderId,
          ),
          truncated: migration.truncated === true,
        },
        imageAnchors: {
          pending: nonNegativeCount(imageAnchors.pending),
          active: nonNegativeCount(imageAnchors.active),
          released: nonNegativeCount(imageAnchors.released),
          activeWithoutProviderId: nonNegativeCount(
            imageAnchors.activeWithoutProviderId,
          ),
          truncated: imageAnchors.truncated === true,
        },
      });
    }),
  );

  return router;
}
