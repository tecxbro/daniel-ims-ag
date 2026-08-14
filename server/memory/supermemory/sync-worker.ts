import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../../convex/_generated/api.js";
import {
  createContainerSettingsCoordinator,
  ensureContainerSettings as ensureConfiguredContainerSettings,
  type MemoryProviderContainerState,
} from "./container.js";
import {
  createSupermemoryAdapter,
  readMemoryProviderConfiguration,
  SupermemoryProviderError,
  type SupermemoryContainerSettingsClient,
} from "./client.js";
import type {
  CaptureTurnInput,
  CreateExactMemoryInput,
  DanielMemoryProvider,
  ForgetMemoryInput,
  ProviderDocumentResult,
  ProviderMemoryResult,
  UpdateMemoryInput,
} from "./types.js";

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

export type MemorySyncJobKind =
  | "conversation_turn"
  | "explicit_memory"
  | "image"
  | "memory_update"
  | "memory_forget";

export type MemorySyncJobStatus =
  | "pending"
  | "processing"
  | "submitted"
  | "completed"
  | "failed"
  | "dead_letter";

export interface MemorySyncJob {
  jobId: string;
  kind: MemorySyncJobKind;
  ownerKey: string;
  containerTag: string;
  customId?: string;
  conversationId?: string;
  turnId?: string;
  payload: string;
  payloadHash: string;
  status: MemorySyncJobStatus;
  providerDocumentId?: string;
  providerMemoryIds?: string[];
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * `complete` resumes a job that reached Supermemory and was durably marked
 * submitted before the server stopped. It must not call the provider again.
 */
export interface ClaimedMemorySyncJob {
  job: MemorySyncJob;
  resumeFrom: "dispatch" | "complete";
}

export interface ProviderSubmission {
  providerDocumentId?: string;
  providerMemoryIds?: string[];
}

export interface ClaimDueJobInput {
  now: number;
  leaseMs: number;
  workerId: string;
}

export interface RecordSubmittedInput extends ProviderSubmission {
  jobId: string;
  expectedAttempt: number;
  expectedUpdatedAt: number;
  now: number;
}

export interface CompleteMemorySyncJobInput {
  jobId: string;
  expectedAttempt: number;
  expectedUpdatedAt: number;
  now: number;
}

export interface RecordMemorySyncFailureInput {
  jobId: string;
  expectedAttempt: number;
  expectedUpdatedAt: number;
  error: string;
  retryable: boolean;
  now: number;
  nextAttemptAt?: number;
  deadLetter: boolean;
}

export interface FencedMutationResult {
  updated: boolean;
  job?: MemorySyncJob | null;
}

function fencedMutationApplied(result: void | FencedMutationResult): boolean {
  return result === undefined || result.updated;
}

export interface MemorySyncJobsStore {
  claimDue(input: ClaimDueJobInput): Promise<ClaimedMemorySyncJob | null>;
  recordSubmitted(input: RecordSubmittedInput): Promise<void | FencedMutationResult>;
  complete(input: CompleteMemorySyncJobInput): Promise<void | FencedMutationResult>;
  recordFailure(input: RecordMemorySyncFailureInput): Promise<void | FencedMutationResult>;
}

export type MemorySyncWorkerActivity =
  | "starting"
  | "idle"
  | "processing"
  | "completed"
  | "retry_scheduled"
  | "dead_letter"
  | "stopped";

export interface RecordProviderSuccessInput extends ProviderSubmission {
  jobId: string;
  kind: MemorySyncJobKind;
  at: number;
}

export interface RecordProviderFailureInput {
  jobId: string;
  kind: MemorySyncJobKind;
  at: number;
  error: string;
  retryable: boolean;
  deadLetter: boolean;
}

export interface RecordWorkerHeartbeatInput {
  workerId: string;
  at: number;
  activity: MemorySyncWorkerActivity;
  jobId?: string;
}

export interface MemoryProviderStateWriter {
  recordSuccess(input: RecordProviderSuccessInput): Promise<void>;
  recordFailure(input: RecordProviderFailureInput): Promise<void | FencedMutationResult>;
  heartbeat(input: RecordWorkerHeartbeatInput): Promise<void>;
}

export interface MemorySyncPayloadByKind {
  conversation_turn: CaptureTurnInput;
  explicit_memory: CreateExactMemoryInput;
  image: CaptureTurnInput;
  memory_update: UpdateMemoryInput;
  memory_forget: ForgetMemoryInput;
}

export type MemorySyncDispatchHandler<K extends MemorySyncJobKind> = (
  payload: MemorySyncPayloadByKind[K],
  job: MemorySyncJob,
) => Promise<ProviderSubmission>;

export type MemorySyncDispatchHandlers = {
  [K in MemorySyncJobKind]: MemorySyncDispatchHandler<K>;
};

export class MemorySyncPayloadError extends Error {
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "MemorySyncPayloadError";
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parsePayload<K extends MemorySyncJobKind>(
  job: MemorySyncJob,
  expectedKind: K,
): MemorySyncPayloadByKind[K] {
  if (job.kind !== expectedKind) {
    throw new MemorySyncPayloadError(
      `memory sync job ${job.jobId} changed kind while dispatching`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(job.payload);
  } catch {
    throw new MemorySyncPayloadError(`memory sync job ${job.jobId} contains invalid JSON`);
  }
  const envelope = asObject(parsed);
  if (!envelope) {
    throw new MemorySyncPayloadError(`memory sync job ${job.jobId} payload must be an object`);
  }
  if (
    job.kind === "conversation_turn" &&
    (envelope.ingestionStrategy !== "delta_turn_v1" || envelope.schemaVersion !== 1)
  ) {
    throw new MemorySyncPayloadError(
      `memory sync conversation job ${job.jobId} must use delta_turn_v1`,
    );
  }
  const providerInput = asObject(envelope.providerInput) ?? envelope;
  validatePayloadForKind(job, providerInput);
  return providerInput as unknown as MemorySyncPayloadByKind[K];
}

function requireStringField(
  payload: Record<string, unknown>,
  field: string,
  job: MemorySyncJob,
): void {
  if (typeof payload[field] !== "string" || !(payload[field] as string).trim()) {
    throw new MemorySyncPayloadError(
      `memory sync ${job.kind} job ${job.jobId} requires ${field}`,
    );
  }
}

function validatePayloadForKind(
  job: MemorySyncJob,
  payload: Record<string, unknown>,
): void {
  switch (job.kind) {
    case "conversation_turn":
    case "image":
      requireStringField(payload, "content", job);
      if (
        payload.taskType !== undefined &&
        payload.taskType !== "memory" &&
        payload.taskType !== "superrag"
      ) {
        throw new MemorySyncPayloadError(
          `memory sync ${job.kind} job ${job.jobId} has an invalid taskType`,
        );
      }
      if (payload.customId !== undefined && payload.customId !== job.customId) {
        throw new MemorySyncPayloadError(
          `memory sync ${job.kind} job ${job.jobId} customId does not match its durable identity`,
        );
      }
      if (
        payload.containerTag !== undefined &&
        payload.containerTag !== job.containerTag
      ) {
        throw new MemorySyncPayloadError(
          `memory sync ${job.kind} job ${job.jobId} containerTag does not match its durable identity`,
        );
      }
      return;
    case "explicit_memory":
      if (!Array.isArray(payload.memories) || payload.memories.length < 1) {
        throw new MemorySyncPayloadError(
          `memory sync explicit_memory job ${job.jobId} requires memories`,
        );
      }
      for (const memory of payload.memories) {
        const value = asObject(memory);
        if (!value || typeof value.content !== "string" || !value.content.trim()) {
          throw new MemorySyncPayloadError(
            `memory sync explicit_memory job ${job.jobId} contains an invalid memory`,
          );
        }
      }
      return;
    case "memory_update":
      requireStringField(payload, "newContent", job);
      if (
        (typeof payload.id !== "string" || !payload.id) &&
        (typeof payload.content !== "string" || !payload.content)
      ) {
        throw new MemorySyncPayloadError(
          `memory sync memory_update job ${job.jobId} requires id or content`,
        );
      }
      return;
    case "memory_forget":
      if (
        (typeof payload.id !== "string" || !payload.id) &&
        (typeof payload.content !== "string" || !payload.content)
      ) {
        throw new MemorySyncPayloadError(
          `memory sync memory_forget job ${job.jobId} requires id or content`,
        );
      }
      return;
    default:
      assertNever(job.kind);
  }
}

function requireCustomId(job: MemorySyncJob): string {
  if (!job.customId) {
    throw new MemorySyncPayloadError(
      `memory sync ${job.kind} job ${job.jobId} is missing its stable customId`,
    );
  }
  return job.customId;
}

function documentSubmission(result: ProviderDocumentResult): ProviderSubmission {
  return { providerDocumentId: result.id };
}

function memorySubmission(results: ProviderMemoryResult[]): ProviderSubmission {
  return { providerMemoryIds: results.map((result) => result.id) };
}

/**
 * Builds the provider dispatch boundary without importing agent, image, or UI
 * modules. Implementation 6 can replace individual handlers at construction.
 */
export function createMemorySyncDispatchHandlers(
  provider: Pick<
    DanielMemoryProvider,
    "captureTurn" | "createExact" | "update" | "forget"
  >,
  overrides: Partial<MemorySyncDispatchHandlers> = {},
): MemorySyncDispatchHandlers {
  const defaults: MemorySyncDispatchHandlers = {
    conversation_turn: async (payload, job) =>
      documentSubmission(
        await provider.captureTurn({
          ...payload,
          containerTag: job.containerTag,
          customId: requireCustomId(job),
        }),
      ),
    explicit_memory: async (payload, job) =>
      memorySubmission(
        await provider.createExact({
          ...payload,
          containerTag: job.containerTag,
        }),
      ),
    image: async (payload, job) =>
      documentSubmission(
        await provider.captureTurn({
          ...payload,
          containerTag: job.containerTag,
          customId: requireCustomId(job),
        }),
      ),
    memory_update: async (payload, job) =>
      memorySubmission([
        await provider.update({
          ...payload,
          containerTag: job.containerTag,
        }),
      ]),
    memory_forget: async (payload, job) => {
      await provider.forget({
        ...payload,
        containerTag: job.containerTag,
      });
      return {};
    },
  };

  return { ...defaults, ...overrides };
}

export class MemorySyncDispatcher {
  constructor(private readonly handlers: MemorySyncDispatchHandlers) {}

  dispatch(job: MemorySyncJob): Promise<ProviderSubmission> {
    switch (job.kind) {
      case "conversation_turn":
        return this.handlers.conversation_turn(parsePayload(job, "conversation_turn"), job);
      case "explicit_memory":
        return this.handlers.explicit_memory(parsePayload(job, "explicit_memory"), job);
      case "image":
        return this.handlers.image(parsePayload(job, "image"), job);
      case "memory_update":
        return this.handlers.memory_update(parsePayload(job, "memory_update"), job);
      case "memory_forget":
        return this.handlers.memory_forget(parsePayload(job, "memory_forget"), job);
      default:
        return assertNever(job.kind);
    }
  }
}

function assertNever(value: never): never {
  throw new MemorySyncPayloadError(`unsupported memory sync job kind: ${String(value)}`);
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
  provider: Pick<
    DanielMemoryProvider,
    "captureTurn" | "createExact" | "update" | "forget"
  >;
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

type MemorySyncProvider = Pick<
  DanielMemoryProvider,
  "captureTurn" | "createExact" | "update" | "forget"
>;

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

type ConvexClient = Pick<ConvexHttpClient, "query" | "mutation">;

interface ConvexMemorySyncApi {
  memorySyncJobs: {
    claimDue: unknown;
    recordSubmitted: unknown;
    complete: unknown;
    recordFailure: unknown;
    backlog: unknown;
  };
  memoryProviderState: {
    ensureIdentitySaltFingerprint: unknown;
    getContainerState: unknown;
    markContainerInitialized: unknown;
    updateHealth: unknown;
    recordSuccess: unknown;
    recordFailure: unknown;
    heartbeat: unknown;
    getBacklogSummary: unknown;
  };
}

const memorySyncApi = api as unknown as ConvexMemorySyncApi;

export interface MemorySyncBacklogSummary {
  pending: number;
  processing: number;
  submitted: number;
  failed: number;
  deadLetter: number;
  total: number;
}

function numberField(record: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    if (typeof record[key] === "number") return record[key] as number;
  }
  return 0;
}

function normalizeBacklog(value: unknown): MemorySyncBacklogSummary {
  const record = asObject(value) ?? {};
  const counts = asObject(record.counts) ?? record;
  const count = (...keys: string[]): number => {
    for (const key of keys) {
      const value = counts[key];
      if (typeof value === "number") return value;
      const entry = asObject(value);
      if (typeof entry?.count === "number") return entry.count;
    }
    return 0;
  };
  const pending = count("pending");
  const processing = count("processing");
  const submitted = count("submitted");
  const failed = count("failed");
  const deadLetter = count("deadLetter", "dead_letter");
  return {
    pending,
    processing,
    submitted,
    failed,
    deadLetter,
    total:
      numberField(record, "total", "active") + deadLetter ||
      pending + processing + submitted + failed + deadLetter,
  };
}

function isJobKind(value: unknown): value is MemorySyncJobKind {
  return (
    value === "conversation_turn" ||
    value === "explicit_memory" ||
    value === "image" ||
    value === "memory_update" ||
    value === "memory_forget"
  );
}

function isJobStatus(value: unknown): value is MemorySyncJobStatus {
  return (
    value === "pending" ||
    value === "processing" ||
    value === "submitted" ||
    value === "completed" ||
    value === "failed" ||
    value === "dead_letter"
  );
}

function normalizeClaimedJob(value: unknown): ClaimedMemorySyncJob | null {
  if (value === null || value === undefined) return null;
  const wrapper = asObject(value);
  const rawJob = wrapper && asObject(wrapper.job) ? asObject(wrapper.job) : wrapper;
  if (!rawJob) throw new Error("memorySyncJobs.claimDue returned an invalid job");
  if (
    typeof rawJob.jobId !== "string" ||
    !isJobKind(rawJob.kind) ||
    typeof rawJob.ownerKey !== "string" ||
    typeof rawJob.containerTag !== "string" ||
    typeof rawJob.payload !== "string" ||
    typeof rawJob.payloadHash !== "string" ||
    !isJobStatus(rawJob.status) ||
    typeof rawJob.attempts !== "number" ||
    typeof rawJob.nextAttemptAt !== "number" ||
    typeof rawJob.createdAt !== "number" ||
    typeof rawJob.updatedAt !== "number"
  ) {
    throw new Error("memorySyncJobs.claimDue returned an invalid job");
  }

  const job = rawJob as unknown as MemorySyncJob;
  const explicitResume = wrapper?.resumeFrom;
  const resumeFrom =
    explicitResume === "complete" || rawJob.status === "submitted"
      ? "complete"
      : "dispatch";
  return { job, resumeFrom };
}

/**
 * ConvexHttpClient-backed durable state adapter. It deliberately owns no
 * timers or provider objects, so tests can substitute an in-memory store.
 */
export class ConvexMemorySyncPersistence
  implements MemorySyncJobsStore, MemoryProviderStateWriter
{
  constructor(private readonly client: ConvexClient) {}

  async claimDue(input: ClaimDueJobInput): Promise<ClaimedMemorySyncJob | null> {
    const result = await this.mutation(memorySyncApi.memorySyncJobs.claimDue, {
      now: input.now,
      leaseMs: input.leaseMs,
      workerId: input.workerId,
    });
    return normalizeClaimedJob(result);
  }

  async recordSubmitted(input: RecordSubmittedInput): Promise<FencedMutationResult> {
    return this.fencedResult(
      await this.mutation(memorySyncApi.memorySyncJobs.recordSubmitted, input),
    );
  }

  async complete(input: CompleteMemorySyncJobInput): Promise<FencedMutationResult> {
    return this.fencedResult(
      await this.mutation(memorySyncApi.memorySyncJobs.complete, input),
    );
  }

  recordFailure(input: RecordMemorySyncFailureInput): Promise<FencedMutationResult>;
  recordFailure(input: RecordProviderFailureInput): Promise<void>;
  async recordFailure(
    input: RecordMemorySyncFailureInput | RecordProviderFailureInput,
  ): Promise<void | FencedMutationResult> {
    if ("now" in input) {
      return this.fencedResult(
        await this.mutation(memorySyncApi.memorySyncJobs.recordFailure, input),
      );
    }
    await this.mutation(memorySyncApi.memoryProviderState.recordFailure, input);
  }

  async recordSuccess(input: RecordProviderSuccessInput): Promise<void> {
    await this.mutation(memorySyncApi.memoryProviderState.recordSuccess, input);
  }

  async heartbeat(input: RecordWorkerHeartbeatInput): Promise<void> {
    await this.mutation(memorySyncApi.memoryProviderState.heartbeat, input);
  }

  async ensureIdentitySaltFingerprint(saltFingerprint: string): Promise<string> {
    const value = await this.mutation(
      memorySyncApi.memoryProviderState.ensureIdentitySaltFingerprint,
      { saltFingerprint },
    );
    if (typeof value !== "string") {
      throw new Error("memoryProviderState returned an invalid salt fingerprint");
    }
    return value;
  }

  async getContainerState(
    containerTag: string,
  ): Promise<MemoryProviderContainerState | null> {
    const value = await this.query(memorySyncApi.memoryProviderState.getContainerState, {
      containerTag,
    });
    if (value === null) return null;
    const record = asObject(value);
    if (!record || typeof record.containerTag !== "string") {
      throw new Error("memoryProviderState returned an invalid container state");
    }
    return {
      containerTag: record.containerTag,
      initializedAt:
        typeof record.initializedAt === "number" ? record.initializedAt : undefined,
      saltFingerprint:
        typeof record.saltFingerprint === "string" ? record.saltFingerprint : undefined,
    };
  }

  async markContainerInitialized(input: {
    containerTag: string;
    initializedAt: number;
    saltFingerprint: string;
  }): Promise<void> {
    await this.mutation(
      memorySyncApi.memoryProviderState.markContainerInitialized,
      input,
    );
  }

  async markUnconfigured(input: {
    error: string;
    readMode: "convex" | "shadow" | "supermemory";
    writeMode: "convex" | "dual" | "supermemory";
  }): Promise<void> {
    await this.mutation(memorySyncApi.memoryProviderState.updateHealth, {
      healthStatus: "unconfigured",
      ...input,
    });
  }

  async getBacklog(): Promise<MemorySyncBacklogSummary> {
    return normalizeBacklog(
      await this.query(memorySyncApi.memorySyncJobs.backlog, {}),
    );
  }

  async getBacklogSummary(): Promise<MemorySyncBacklogSummary> {
    return normalizeBacklog(
      await this.query(memorySyncApi.memoryProviderState.getBacklogSummary, {}),
    );
  }

  private mutation(reference: unknown, args: unknown): Promise<unknown> {
    const mutation = this.client.mutation as unknown as (
      functionReference: unknown,
      functionArgs: unknown,
    ) => Promise<unknown>;
    return mutation.call(this.client, reference, args);
  }

  private query(reference: unknown, args: unknown): Promise<unknown> {
    const query = this.client.query as unknown as (
      functionReference: unknown,
      functionArgs: unknown,
    ) => Promise<unknown>;
    return query.call(this.client, reference, args);
  }

  private fencedResult(value: unknown): FencedMutationResult {
    const record = asObject(value);
    const rawJob = record?.job;
    const job =
      rawJob === null
        ? null
        : rawJob === undefined
          ? undefined
          : normalizeClaimedJob(rawJob)?.job;
    return { updated: record?.updated !== false, job };
  }
}
