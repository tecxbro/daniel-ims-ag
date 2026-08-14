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
  customId: string;
  conversationId: string;
  turnId: string;
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
  expectedKind: MemorySyncJobKind,
): MemorySyncPayloadByKind["conversation_turn"] {
  if (job.kind !== expectedKind) {
    throw new MemorySyncPayloadError(
      `memory sync job ${job.jobId} changed kind while dispatching`,
    );
  }
  return parseMemorySyncJobPayload(job.payload, {
    kind: "conversation_turn",
    containerTag: job.containerTag,
    customId: job.customId,
  }).providerInput;
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
    rawJob.kind !== "conversation_turn" ||
    typeof rawJob.ownerKey !== "string" ||
    typeof rawJob.containerTag !== "string" ||
    typeof rawJob.customId !== "string" ||
    typeof rawJob.conversationId !== "string" ||
    typeof rawJob.turnId !== "string" ||
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
    kind: "conversation_turn",
    ownerKey: rawJob.ownerKey,
    containerTag: rawJob.containerTag,
    customId: rawJob.customId,
    conversationId: rawJob.conversationId,
    turnId: rawJob.turnId,
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
  return {
    job,
    resumeFrom:
      wrapper?.resumeFrom === "complete" || rawJob.status === "submitted"
        ? "complete"
        : "dispatch",
  };
}
