import { MemorySyncPayloadError } from "./job-contract.js";
import { parseMemorySyncPayloadForKind, type MemorySyncJob } from "./job-parser.js";
import type { CaptureTurnInput, DanielMemoryProvider } from "./types.js";

export interface ProviderSubmission {
  providerDocumentId?: string;
  providerMemoryIds?: string[];
}

export type MemorySyncProvider = Pick<DanielMemoryProvider, "captureTurn">;

export type MemorySyncDispatchHandler = (
  payload: CaptureTurnInput,
  job: MemorySyncJob,
) => Promise<ProviderSubmission>;

export interface MemorySyncDispatchHandlers {
  conversation_turn: MemorySyncDispatchHandler;
}

function requireCustomId(job: MemorySyncJob): string {
  if (!job.customId) {
    throw new MemorySyncPayloadError(
      `memory sync conversation_turn job ${job.jobId} is missing its stable customId`,
    );
  }
  return job.customId;
}

export function createMemorySyncDispatchHandlers(
  provider: MemorySyncProvider,
  overrides: Partial<MemorySyncDispatchHandlers> = {},
): MemorySyncDispatchHandlers {
  return {
    conversation_turn: async (payload, job) => {
      const result = await provider.captureTurn({
        ...payload,
        containerTag: job.containerTag,
        customId: requireCustomId(job),
      });
      return { providerDocumentId: result.id };
    },
    ...overrides,
  };
}

export class MemorySyncDispatcher {
  constructor(private readonly handlers: MemorySyncDispatchHandlers) {}

  dispatch(job: MemorySyncJob): Promise<ProviderSubmission> {
    return this.handlers.conversation_turn(
      parseMemorySyncPayloadForKind(job, "conversation_turn"),
      job,
    );
  }
}
