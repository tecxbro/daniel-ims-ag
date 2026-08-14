import {
  MemorySyncPayloadError,
  type ImageJobInput,
  type MemoryForgetJobInput,
  type MemorySyncJobKind,
  type MemorySyncPayloadByKind,
} from "./job-contract.js";
import {
  parseMemorySyncPayloadForKind,
  type MemorySyncJob,
} from "./job-parser.js";
import type {
  DanielMemoryProvider,
  ProviderDocumentResult,
  ProviderMemoryResult,
} from "./types.js";

export interface ProviderSubmission {
  providerDocumentId?: string;
  providerMemoryIds?: string[];
}

export type MemorySyncProvider = Pick<
  DanielMemoryProvider,
  "captureTurn" | "createExact" | "update" | "forget"
> & {
  uploadImageJob?: (input: ImageJobInput) => Promise<ProviderDocumentResult>;
  forgetMany?: (input: MemoryForgetJobInput) => Promise<void>;
};

export type MemorySyncDispatchHandler<K extends MemorySyncJobKind> = (
  payload: MemorySyncPayloadByKind[K],
  job: MemorySyncJob,
) => Promise<ProviderSubmission>;

export type MemorySyncDispatchHandlers = {
  [K in MemorySyncJobKind]: MemorySyncDispatchHandler<K>;
};

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

export function createMemorySyncDispatchHandlers(
  provider: MemorySyncProvider,
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
    image: async (payload, job) => {
      if (!provider.uploadImageJob) {
        throw new MemorySyncPayloadError(
          `memory sync image job ${job.jobId} has no image upload handler`,
        );
      }
      return documentSubmission(
        await provider.uploadImageJob({
          ...payload,
          containerTag: job.containerTag,
          customId: requireCustomId(job),
        }),
      );
    },
    memory_update: async (payload, job) =>
      memorySubmission([
        await provider.update({
          ...payload,
          containerTag: job.containerTag,
        }),
      ]),
    memory_forget: async (payload, job) => {
      if (!provider.forgetMany) {
        throw new MemorySyncPayloadError(
          `memory sync memory_forget job ${job.jobId} has no bulk forget handler`,
        );
      }
      await provider.forgetMany({ ...payload, containerTag: job.containerTag });
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
        return this.handlers.conversation_turn(
          parseMemorySyncPayloadForKind(job, "conversation_turn"),
          job,
        );
      case "explicit_memory":
        return this.handlers.explicit_memory(
          parseMemorySyncPayloadForKind(job, "explicit_memory"),
          job,
        );
      case "image":
        return this.handlers.image(parseMemorySyncPayloadForKind(job, "image"), job);
      case "memory_update":
        return this.handlers.memory_update(
          parseMemorySyncPayloadForKind(job, "memory_update"),
          job,
        );
      case "memory_forget":
        return this.handlers.memory_forget(
          parseMemorySyncPayloadForKind(job, "memory_forget"),
          job,
        );
      default:
        return assertNever(job.kind);
    }
  }
}

function assertNever(value: never): never {
  throw new MemorySyncPayloadError(`unsupported memory sync job kind: ${String(value)}`);
}
