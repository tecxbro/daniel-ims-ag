import {
  MemorySyncPayloadError,
  parseMemorySyncJobPayload,
  type MemorySyncJobKind,
  type MemorySyncPayloadByKind,
} from "./job-contract.js";

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

export interface ClaimedMemorySyncJob {
  job: MemorySyncJob;
  resumeFrom: "dispatch" | "complete";
}

export function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseMemorySyncPayloadForKind(
  job: MemorySyncJob,
  expectedKind: "conversation_turn",
): MemorySyncPayloadByKind["conversation_turn"];
export function parseMemorySyncPayloadForKind(
  job: MemorySyncJob,
  expectedKind: "explicit_memory",
): MemorySyncPayloadByKind["explicit_memory"];
export function parseMemorySyncPayloadForKind(
  job: MemorySyncJob,
  expectedKind: "image",
): MemorySyncPayloadByKind["image"];
export function parseMemorySyncPayloadForKind(
  job: MemorySyncJob,
  expectedKind: "memory_update",
): MemorySyncPayloadByKind["memory_update"];
export function parseMemorySyncPayloadForKind(
  job: MemorySyncJob,
  expectedKind: "memory_forget",
): MemorySyncPayloadByKind["memory_forget"];
export function parseMemorySyncPayloadForKind(
  job: MemorySyncJob,
  expectedKind: MemorySyncJobKind,
): MemorySyncPayloadByKind[MemorySyncJobKind] {
  if (job.kind !== expectedKind) {
    throw new MemorySyncPayloadError(
      `memory sync job ${job.jobId} changed kind while dispatching`,
    );
  }
  const envelope = parseMemorySyncJobPayload(
    job.payload,
    {
      kind: expectedKind,
      containerTag: job.containerTag,
      customId: job.customId,
    },
    { allowLegacy: true },
  );
  return envelope.providerInput;
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

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function normalizeClaimedMemorySyncJob(value: unknown): ClaimedMemorySyncJob | null {
  if (value === null || value === undefined) return null;
  const wrapper = asObject(value);
  const nested = wrapper ? asObject(wrapper.job) : null;
  const rawJob = nested ?? wrapper;
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
  if (
    rawJob.providerMemoryIds !== undefined &&
    (!Array.isArray(rawJob.providerMemoryIds) ||
      !rawJob.providerMemoryIds.every((id) => typeof id === "string"))
  ) {
    throw new Error("memorySyncJobs.claimDue returned invalid provider memory IDs");
  }

  const job: MemorySyncJob = {
    jobId: rawJob.jobId,
    kind: rawJob.kind,
    ownerKey: rawJob.ownerKey,
    containerTag: rawJob.containerTag,
    customId: optionalString(rawJob.customId),
    conversationId: optionalString(rawJob.conversationId),
    turnId: optionalString(rawJob.turnId),
    payload: rawJob.payload,
    payloadHash: rawJob.payloadHash,
    status: rawJob.status,
    providerDocumentId: optionalString(rawJob.providerDocumentId),
    providerMemoryIds: Array.isArray(rawJob.providerMemoryIds)
      ? rawJob.providerMemoryIds.filter((id): id is string => typeof id === "string")
      : undefined,
    attempts: rawJob.attempts,
    nextAttemptAt: rawJob.nextAttemptAt,
    lastError: optionalString(rawJob.lastError),
    createdAt: rawJob.createdAt,
    updatedAt: rawJob.updatedAt,
  };
  const resumeFrom =
    wrapper?.resumeFrom === "complete" || rawJob.status === "submitted"
      ? "complete"
      : "dispatch";
  return { job, resumeFrom };
}
