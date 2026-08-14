import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../../convex/_generated/api.js";
import type { MemoryProviderContainerState } from "./container.js";
import {
  asObject,
  normalizeClaimedMemorySyncJob,
  type ClaimedMemorySyncJob,
  type MemorySyncJob,
} from "./job-parser.js";
import type { MemorySyncJobKind } from "./job-contract.js";
import type { ProviderSubmission } from "./job-dispatcher.js";

export type ConvexClient = Pick<ConvexHttpClient, "query" | "mutation">;

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

export interface MemorySyncBacklogSummary {
  pending: number;
  processing: number;
  submitted: number;
  completed: number;
  failed: number;
  deadLetter: number;
  total: number;
}

function optionalNumberField(
  record: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, value);
    }
  }
  return undefined;
}

export function normalizeBacklog(value: unknown): MemorySyncBacklogSummary {
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
  const completed = count("completed");
  const failed = count("failed");
  const deadLetter = count("deadLetter", "dead_letter");
  const suppliedTotal = optionalNumberField(record, "total");
  const suppliedActive = optionalNumberField(record, "active");
  return {
    pending,
    processing,
    submitted,
    completed,
    failed,
    deadLetter,
    total:
      suppliedTotal ??
      (suppliedActive !== undefined
        ? suppliedActive + deadLetter
        : pending + processing + submitted + completed + failed + deadLetter),
  };
}

export class ConvexMemorySyncPersistence
  implements MemorySyncJobsStore, MemoryProviderStateWriter
{
  constructor(private readonly client: ConvexClient) {}

  async claimDue(input: ClaimDueJobInput): Promise<ClaimedMemorySyncJob | null> {
    return normalizeClaimedMemorySyncJob(
      await this.client.mutation(api.memorySyncJobs.claimDue, input),
    );
  }

  async recordSubmitted(input: RecordSubmittedInput): Promise<FencedMutationResult> {
    return this.fencedResult(
      await this.client.mutation(api.memorySyncJobs.recordSubmitted, input),
    );
  }

  async complete(input: CompleteMemorySyncJobInput): Promise<FencedMutationResult> {
    return this.fencedResult(await this.client.mutation(api.memorySyncJobs.complete, input));
  }

  recordFailure(input: RecordMemorySyncFailureInput): Promise<FencedMutationResult>;
  recordFailure(input: RecordProviderFailureInput): Promise<void>;
  async recordFailure(
    input: RecordMemorySyncFailureInput | RecordProviderFailureInput,
  ): Promise<void | FencedMutationResult> {
    if ("now" in input) {
      return this.fencedResult(
        await this.client.mutation(api.memorySyncJobs.recordFailure, input),
      );
    }
    await this.client.mutation(api.memoryProviderState.recordFailure, input);
  }

  async recordSuccess(input: RecordProviderSuccessInput): Promise<void> {
    await this.client.mutation(api.memoryProviderState.recordSuccess, input);
  }

  async heartbeat(input: RecordWorkerHeartbeatInput): Promise<void> {
    await this.client.mutation(api.memoryProviderState.heartbeat, input);
  }

  async ensureIdentitySaltFingerprint(saltFingerprint: string): Promise<string> {
    return await this.client.mutation(
      api.memoryProviderState.ensureIdentitySaltFingerprint,
      { saltFingerprint },
    );
  }

  async getContainerState(
    containerTag: string,
  ): Promise<MemoryProviderContainerState | null> {
    const value = await this.client.query(api.memoryProviderState.getContainerState, {
      containerTag,
    });
    if (value === null) return null;
    return {
      containerTag: value.containerTag,
      initializedAt: value.initializedAt,
      saltFingerprint: value.saltFingerprint,
    };
  }

  async markContainerInitialized(input: {
    containerTag: string;
    initializedAt: number;
    saltFingerprint: string;
  }): Promise<void> {
    await this.client.mutation(api.memoryProviderState.markContainerInitialized, input);
  }

  async markUnconfigured(input: {
    error: string;
    readMode: "convex" | "shadow" | "supermemory";
    writeMode: "convex" | "dual" | "supermemory";
  }): Promise<void> {
    await this.client.mutation(api.memoryProviderState.updateHealth, {
      healthStatus: "unconfigured",
      ...input,
    });
  }

  async getBacklog(): Promise<MemorySyncBacklogSummary> {
    return normalizeBacklog(await this.client.query(api.memorySyncJobs.backlog, {}));
  }

  async getBacklogSummary(): Promise<MemorySyncBacklogSummary> {
    return normalizeBacklog(
      await this.client.query(api.memoryProviderState.getBacklogSummary, {}),
    );
  }

  private fencedResult(value: unknown): FencedMutationResult {
    const record = asObject(value);
    const rawJob = record?.job;
    const job =
      rawJob === null
        ? null
        : rawJob === undefined
          ? undefined
          : normalizeClaimedMemorySyncJob(rawJob)?.job;
    return { updated: record?.updated !== false, job };
  }
}
