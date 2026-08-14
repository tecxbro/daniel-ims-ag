import {
  createContainerSettingsCoordinator,
  ensureContainerSettings as ensureConfiguredContainerSettings,
} from "./container.js";
import {
  createSupermemoryAdapter,
  readMemoryProviderConfiguration,
  SupermemoryProviderError,
  type SupermemoryContainerSettingsClient,
} from "./client.js";
import {
  MemorySyncPayloadError,
} from "./job-contract.js";
export { MemorySyncPayloadError } from "./job-contract.js";
export type { MemorySyncJobKind, MemorySyncPayloadByKind } from "./job-contract.js";
import {
  createMemorySyncDispatchHandlers,
  MemorySyncDispatcher,
  type MemorySyncDispatchHandlers,
  type MemorySyncProvider,
  type ProviderSubmission,
} from "./job-dispatcher.js";
export { createMemorySyncDispatchHandlers, MemorySyncDispatcher } from "./job-dispatcher.js";
export type {
  MemorySyncDispatchHandler,
  MemorySyncDispatchHandlers,
  MemorySyncProvider,
  ProviderSubmission,
} from "./job-dispatcher.js";
import { asObject, type MemorySyncJob } from "./job-parser.js";
export type {
  ClaimedMemorySyncJob,
  MemorySyncJob,
  MemorySyncJobStatus,
} from "./job-parser.js";
import {
  ConvexMemorySyncPersistence,
  type ConvexClient,
  type FencedMutationResult,
  type MemoryProviderStateWriter,
  type MemorySyncBacklogSummary,
  type MemorySyncJobsStore,
  type MemorySyncWorkerActivity,
} from "./convex-sync-store.js";
export { ConvexMemorySyncPersistence, normalizeBacklog } from "./convex-sync-store.js";
export type {
  ClaimDueJobInput,
  CompleteMemorySyncJobInput,
  ConvexClient,
  FencedMutationResult,
  MemoryProviderStateWriter,
  MemorySyncBacklogSummary,
  MemorySyncJobsStore,
  MemorySyncWorkerActivity,
  RecordMemorySyncFailureInput,
  RecordProviderFailureInput,
  RecordProviderSuccessInput,
  RecordSubmittedInput,
  RecordWorkerHeartbeatInput,
} from "./convex-sync-store.js";

export const MEMORY_SYNC_RETRY_DELAYS_MS = [
  10_000,
  60_000,
  5 * 60_000,
  30 * 60_000,
] as const;

/** Relative schedule for provider attempts 1-5 (attempt 1 is immediate). */
export const MEMORY_SYNC_ATTEMPT_DELAYS_MS = [
  0,
  ...MEMORY_SYNC_RETRY_DELAYS_MS,
] as const;

export const MEMORY_SYNC_MAX_PROVIDER_ATTEMPTS = 5;
export const DEFAULT_MEMORY_SYNC_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_MEMORY_SYNC_LEASE_MS = 2 * 60_000;
export const DEFAULT_MEMORY_SYNC_HEARTBEAT_INTERVAL_MS = 15_000;

function fencedMutationApplied(result: void | FencedMutationResult): boolean {
  return result === undefined || result.updated;
}

/** Delay before the next provider attempt, or null when the job dead-letters. */
export function retryDelayAfterAttempt(attempts: number): number | null {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError("attempts must be a positive integer");
  }
  return MEMORY_SYNC_RETRY_DELAYS_MS[attempts - 1] ?? null;
}

/** Relative delay assigned to an attempt, or null for the dead-letter outcome. */
export function delayForMemorySyncAttempt(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError("attempt must be a positive integer");
  }
  return MEMORY_SYNC_ATTEMPT_DELAYS_MS[attempt - 1] ?? null;
}

export interface NormalizedMemorySyncError {
  message: string;
  retryable: boolean;
}

const MAX_PERSISTED_ERROR_LENGTH = 1_000;

function redactErrorMessage(message: string): string {
  return message
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sm|sk)[_-][A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PERSISTED_ERROR_LENGTH);
}

function statusFromUnknown(error: unknown): number | undefined {
  const record = asObject(error);
  return typeof record?.status === "number" ? record.status : undefined;
}

export function normalizeMemorySyncError(error: unknown): NormalizedMemorySyncError {
  if (error instanceof SupermemoryProviderError) {
    return {
      message: redactErrorMessage(`${error.name}: ${error.message}`),
      retryable: error.retryable,
    };
  }
  if (error instanceof MemorySyncPayloadError) {
    return { message: redactErrorMessage(`${error.name}: ${error.message}`), retryable: false };
  }

  const record = asObject(error);
  const explicitRetryable =
    typeof record?.retryable === "boolean" ? record.retryable : undefined;
  const status = statusFromUnknown(error);
  const retryableStatus =
    status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500);
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  const configurationFailure = /configuration|identity/i.test(name);

  return {
    message: redactErrorMessage(`${name}: ${message}`) || "Unknown memory sync failure",
    // Unknown runtime/network failures are retried to preserve durable turns.
    // Typed payload/configuration failures and explicit 4xx provider failures are not.
    retryable:
      explicitRetryable ??
      (status !== undefined ? retryableStatus : !configurationFailure),
  };
}

export type MemorySyncSleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

function randomWorkerId(): string {
  return `memory-sync-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface MemorySyncWorkerDependencies {
  jobs: MemorySyncJobsStore;
  providerState: MemoryProviderStateWriter;
  provider: MemorySyncProvider;
  handlers?: Partial<MemorySyncDispatchHandlers>;
  ensureContainerSettings?: (containerTag: string) => Promise<unknown>;
  now?: () => number;
  sleep?: MemorySyncSleep;
  workerId?: string;
  pollIntervalMs?: number;
  leaseMs?: number;
  heartbeatIntervalMs?: number;
  onError?: (error: unknown) => void;
}

export class MemorySyncWorker {
  readonly workerId: string;

  private readonly dispatcher: MemorySyncDispatcher;
  private readonly ensureContainerSettings: (containerTag: string) => Promise<unknown>;
  private readonly now: () => number;
  private readonly sleep: MemorySyncSleep;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly onError: (error: unknown) => void;
  private abortController: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;
  private lastHeartbeatAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly dependencies: MemorySyncWorkerDependencies) {
    this.workerId = dependencies.workerId ?? randomWorkerId();
    this.dispatcher = new MemorySyncDispatcher(
      createMemorySyncDispatchHandlers(dependencies.provider, dependencies.handlers),
    );
    this.ensureContainerSettings =
      dependencies.ensureContainerSettings ?? ensureConfiguredContainerSettings;
    this.now = dependencies.now ?? Date.now;
    this.sleep = dependencies.sleep ?? abortableSleep;
    this.pollIntervalMs =
      dependencies.pollIntervalMs ?? DEFAULT_MEMORY_SYNC_POLL_INTERVAL_MS;
    this.leaseMs = dependencies.leaseMs ?? DEFAULT_MEMORY_SYNC_LEASE_MS;
    this.heartbeatIntervalMs =
      dependencies.heartbeatIntervalMs ?? DEFAULT_MEMORY_SYNC_HEARTBEAT_INTERVAL_MS;
    this.onError =
      dependencies.onError ??
      ((error) => console.error("[supermemory-sync] worker error", error));

    for (const [name, value] of [
      ["pollIntervalMs", this.pollIntervalMs],
      ["leaseMs", this.leaseMs],
      ["heartbeatIntervalMs", this.heartbeatIntervalMs],
    ] as const) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new RangeError(`${name} must be positive`);
      }
    }
  }

  get running(): boolean {
    return this.loopPromise !== null;
  }

  /** Starts one tracked polling loop. Repeated calls are idempotent. */
  start(): void {
    if (this.loopPromise) return;
    const controller = new AbortController();
    this.abortController = controller;
    this.loopPromise = this.runLoop(controller.signal).finally(() => {
      if (this.abortController === controller) this.abortController = null;
      this.loopPromise = null;
    });
  }

  /** Stops claiming new work and waits for the in-flight provider call. */
  async stop(): Promise<void> {
    const loop = this.loopPromise;
    if (!loop) return;
    this.abortController?.abort();
    await loop;
  }

  async waitForStop(): Promise<void> {
    await this.loopPromise;
  }

  /**
   * Claims and processes at most one job. Exposed for deterministic tests and
   * one-shot workers; the polling loop invokes the same path.
   */
  async runOnce(): Promise<boolean> {
    const claimedAt = this.now();
    const claimed = await this.dependencies.jobs.claimDue({
      now: claimedAt,
      leaseMs: this.leaseMs,
      workerId: this.workerId,
    });
    if (!claimed) {
      await this.heartbeat("idle", undefined, false);
      return false;
    }

    const { job, resumeFrom } = claimed;
    await this.heartbeat("processing", job.jobId, true);

    if (resumeFrom === "complete") {
      await this.completeSubmittedJob(job);
      return true;
    }

    let submission: ProviderSubmission;
    try {
      await this.ensureContainerSettings(job.containerTag);
      submission = await this.dispatcher.dispatch(job);
    } catch (error) {
      await this.handleProviderFailure(job, error);
      return true;
    }

    // The submitted state is the crash boundary. If the process exits after
    // this mutation, the next worker completes the job without re-ingesting.
    const recorded = await this.dependencies.jobs.recordSubmitted({
      jobId: job.jobId,
      expectedAttempt: job.attempts,
      expectedUpdatedAt: job.updatedAt,
      ...submission,
      now: this.now(),
    });
    if (!fencedMutationApplied(recorded)) return true;

    const completed = await this.dependencies.jobs.complete({
      jobId: job.jobId,
      expectedAttempt: job.attempts,
      expectedUpdatedAt: recorded?.job?.updatedAt ?? job.updatedAt,
      now: this.now(),
    });
    if (!fencedMutationApplied(completed)) return true;
    await this.safeProviderStateUpdate(() =>
      this.dependencies.providerState.recordSuccess({
        jobId: job.jobId,
        kind: job.kind,
        ...submission,
        at: this.now(),
      }),
    );
    await this.heartbeat("completed", job.jobId, true);
    return true;
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    await this.heartbeat("starting", undefined, true);
    while (!signal.aborted) {
      let processed = false;
      try {
        processed = await this.runOnce();
      } catch (error) {
        this.onError(error);
      }
      if (!processed && !signal.aborted) {
        await this.sleep(this.pollIntervalMs, signal);
      }
    }
    await this.heartbeat("stopped", undefined, true);
  }

  private async completeSubmittedJob(job: MemorySyncJob): Promise<void> {
    const completed = await this.dependencies.jobs.complete({
      jobId: job.jobId,
      expectedAttempt: job.attempts,
      expectedUpdatedAt: job.updatedAt,
      now: this.now(),
    });
    if (!fencedMutationApplied(completed)) return;
    const submission: ProviderSubmission = {
      providerDocumentId: job.providerDocumentId,
      providerMemoryIds: job.providerMemoryIds,
    };
    await this.safeProviderStateUpdate(() =>
      this.dependencies.providerState.recordSuccess({
        jobId: job.jobId,
        kind: job.kind,
        ...submission,
        at: this.now(),
      }),
    );
    await this.heartbeat("completed", job.jobId, true);
  }

  private async handleProviderFailure(job: MemorySyncJob, error: unknown): Promise<void> {
    const normalized = normalizeMemorySyncError(error);
    const delay = normalized.retryable ? retryDelayAfterAttempt(job.attempts) : null;
    const deadLetter = delay === null;
    const now = this.now();
    const recorded = await this.dependencies.jobs.recordFailure({
      jobId: job.jobId,
      expectedAttempt: job.attempts,
      expectedUpdatedAt: job.updatedAt,
      error: normalized.message,
      retryable: normalized.retryable,
      now,
      nextAttemptAt: delay === null ? undefined : now + delay,
      deadLetter,
    });
    if (!fencedMutationApplied(recorded)) return;
    await this.safeProviderStateUpdate(() =>
      this.dependencies.providerState.recordFailure({
        jobId: job.jobId,
        kind: job.kind,
        at: now,
        error: normalized.message,
        retryable: normalized.retryable,
        deadLetter,
      }),
    );
    await this.heartbeat(deadLetter ? "dead_letter" : "retry_scheduled", job.jobId, true);
  }

  private async heartbeat(
    activity: MemorySyncWorkerActivity,
    jobId: string | undefined,
    force: boolean,
  ): Promise<void> {
    const at = this.now();
    if (!force && at - this.lastHeartbeatAt < this.heartbeatIntervalMs) return;
    await this.safeProviderStateUpdate(() =>
      this.dependencies.providerState.heartbeat({
        workerId: this.workerId,
        at,
        activity,
        jobId,
      }),
    );
    this.lastHeartbeatAt = at;
  }

  private async safeProviderStateUpdate(operation: () => Promise<unknown>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      // Provider state is observational. A dashboard/heartbeat failure must
      // not turn an already-completed submission into a duplicate retry.
      this.onError(error);
    }
  }
}

export function createMemorySyncWorker(
  dependencies: MemorySyncWorkerDependencies,
): MemorySyncWorker {
  return new MemorySyncWorker(dependencies);
}

export function startMemorySyncWorker(
  dependencies: MemorySyncWorkerDependencies,
): MemorySyncWorker {
  const worker = createMemorySyncWorker(dependencies);
  worker.start();
  return worker;
}

type Environment = Record<string, string | undefined>;

export interface ConfiguredMemorySyncWorkerResult {
  worker: MemorySyncWorker | null;
  reason: "started" | "no_backlog" | "provider_unconfigured";
  backlog: MemorySyncBacklogSummary;
}

export interface StartConfiguredMemorySyncWorkerOptions {
  client: ConvexClient;
  env?: Environment;
  provider?: MemorySyncProvider;
  ensureContainerSettings?: (containerTag: string) => Promise<unknown>;
  pollIntervalMs?: number;
  leaseMs?: number;
  heartbeatIntervalMs?: number;
  workerId?: string;
  onError?: (error: unknown) => void;
}

/**
 * Starts capture when enabled, or drains already-durable work after write mode
 * is disabled. A missing key leaves the outbox untouched and records an
 * unconfigured health state; it never converts configuration into dead-letter.
 */
export async function startConfiguredMemorySyncWorker(
  options: StartConfiguredMemorySyncWorkerOptions,
): Promise<ConfiguredMemorySyncWorkerResult> {
  const env = options.env ?? process.env;
  const config = readMemoryProviderConfiguration(env);
  const persistence = new ConvexMemorySyncPersistence(options.client);
  const backlog = await persistence.getBacklog();
  const captureEnabled = config.writeMode !== "convex";
  const hasBacklog = backlog.pending + backlog.processing + backlog.submitted + backlog.failed > 0;

  if (!captureEnabled && !hasBacklog) {
    return { worker: null, reason: "no_backlog", backlog };
  }

  let provider = options.provider;
  if (!provider) {
    const apiKey = env.SUPERMEMORY_API_KEY?.trim();
    if (!apiKey) {
      const error = "SUPERMEMORY_API_KEY is required to drain the durable memory sync backlog";
      await persistence.markUnconfigured({
        error,
        readMode: config.readMode,
        writeMode: config.writeMode,
      });
      options.onError?.(new SupermemoryProviderError(error, {
        operation: "sync-worker-startup",
        code: "configuration",
      }));
      return { worker: null, reason: "provider_unconfigured", backlog };
    }
    provider = createSupermemoryAdapter({
      apiKey,
      timeoutMs: config.timeoutMs,
      defaultThreshold: config.threshold,
      defaultSearchLimit: config.searchLimit,
    });
  }

  let ensureContainerSettings = options.ensureContainerSettings;
  if (!ensureContainerSettings) {
    const settingsProvider = provider as MemorySyncProvider &
      Partial<SupermemoryContainerSettingsClient>;
    if (typeof settingsProvider.updateContainerSettings !== "function") {
      throw new TypeError(
        "configured memory sync provider must support updateContainerSettings",
      );
    }
    const coordinator = createContainerSettingsCoordinator({
      stateStore: persistence,
      provider: settingsProvider as SupermemoryContainerSettingsClient,
    });
    ensureContainerSettings = (containerTag) =>
      coordinator.ensureContainerSettings(containerTag);
  }
  const worker = startMemorySyncWorker({
    jobs: persistence,
    providerState: persistence,
    provider,
    ensureContainerSettings,
    pollIntervalMs: options.pollIntervalMs,
    leaseMs: options.leaseMs,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    workerId: options.workerId,
    onError: options.onError,
  });
  return { worker, reason: "started", backlog };
}
