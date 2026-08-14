import { readMemoryProviderConfiguration, SupermemoryProviderError } from "./client.js";
import { formatMemoryContext, MEMORY_SEARCH_RESULT_LIMIT } from "./format-context.js";
import { validateProviderIdentifier } from "./identity.js";
import type {
  DanielMemoryProvider,
  MemoryHydrationResult,
  MemoryOwnerContext,
  MemorySearchResult,
} from "./types.js";

type Environment = Record<string, string | undefined>;

export interface MemoryContextConfiguration {
  timeoutMs: number;
  threshold: number;
  searchLimit: number;
}

export type MemoryContextErrorCode =
  | "authentication"
  | "configuration"
  | "invalid_input"
  | "isolation"
  | "provider"
  | "rate_limit"
  | "timeout";

export interface MemoryContextError {
  name: "MemoryContextError";
  code: MemoryContextErrorCode;
  message: string;
  retryable: boolean;
}

export type MemoryContextStatus = "success" | "empty" | "failed";
export type MemoryContextOperation = "hydrate" | "recall";

export interface MemoryContextInstrumentationEvent {
  name: "memory.recall.completed" | "memory.recall.failed";
  operation: MemoryContextOperation;
  status: MemoryContextStatus;
  latencyMs: number;
  resultCount: number;
  profileFactCount: number;
  errorCode?: MemoryContextErrorCode;
}

export type MemoryContextInstrumentationHook = (
  event: MemoryContextInstrumentationEvent,
) => void | Promise<void>;

export interface MemoryContextOperationOptions {
  provider: Pick<DanielMemoryProvider, "profile" | "search">;
  owner: MemoryOwnerContext;
  config?: Partial<MemoryContextConfiguration>;
  instrumentation?: MemoryContextInstrumentationHook;
  env?: Environment;
  now?: () => number;
}

export interface HydrateMemoryContextInput extends MemoryContextOperationOptions {
  currentUserMessage: string;
}

export interface RecallMemoryInput extends MemoryContextOperationOptions {
  q: string;
}

export interface MemoryContextResult {
  status: MemoryContextStatus;
  hydration: MemoryHydrationResult;
  formattedContext: string;
  error?: MemoryContextError;
}

export interface MemoryRecallResult {
  status: MemoryContextStatus;
  results: MemorySearchResult[];
  latencyMs: number;
  error?: MemoryContextError;
}

class MemoryContextTimeoutError extends Error {
  constructor(readonly operation: MemoryContextOperation) {
    super(`Supermemory ${operation} exceeded Daniel's internal deadline`);
    this.name = "MemoryContextTimeoutError";
  }
}

class MemoryContextIsolationError extends Error {
  constructor() {
    super("The memory owner context does not match its private container");
    this.name = "MemoryContextIsolationError";
  }
}

class MemoryContextInputError extends Error {
  constructor() {
    super("The memory query must be a non-empty string");
    this.name = "MemoryContextInputError";
  }
}

export function emptyMemoryHydration(latencyMs = 0): MemoryHydrationResult {
  return {
    provider: "supermemory",
    profile: { static: [], dynamic: [] },
    results: [],
    latencyMs,
  };
}

function resolveSettings(
  input: Pick<MemoryContextOperationOptions, "config" | "env">,
): MemoryContextConfiguration {
  const providerConfig = readMemoryProviderConfiguration(input.env ?? process.env);
  const timeoutMs = input.config?.timeoutMs ?? providerConfig.timeoutMs;
  const threshold = input.config?.threshold ?? providerConfig.threshold;
  const requestedLimit = input.config?.searchLimit ?? providerConfig.searchLimit;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new SupermemoryProviderError(
      "DANIEL_SUPERMEMORY_TIMEOUT_MS must be a positive integer",
      { operation: "configuration", code: "configuration" },
    );
  }
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
    throw new SupermemoryProviderError(
      "DANIEL_SUPERMEMORY_SEARCH_LIMIT must be a positive integer",
      { operation: "configuration", code: "configuration" },
    );
  }
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new SupermemoryProviderError(
      "DANIEL_SUPERMEMORY_THRESHOLD must be between 0 and 1",
      { operation: "configuration", code: "configuration" },
    );
  }
  return {
    timeoutMs,
    threshold,
    searchLimit: Math.min(requestedLimit, MEMORY_SEARCH_RESULT_LIMIT),
  };
}

function assertOwnerContainer(owner: MemoryOwnerContext): void {
  try {
    validateProviderIdentifier(owner.ownerKey, "ownerKey");
    validateProviderIdentifier(owner.containerTag, "containerTag");
    if (
      !/^[a-f0-9]{32}$/.test(owner.ownerKey) ||
      owner.containerTag !== `daniel-user-${owner.ownerKey}`
    ) {
      throw new MemoryContextIsolationError();
    }
  } catch (error) {
    if (error instanceof MemoryContextIsolationError) throw error;
    throw new MemoryContextIsolationError();
  }
}

function assertQuery(query: string): void {
  if (typeof query !== "string" || !query.trim()) throw new MemoryContextInputError();
}

async function withDeadline<T>(
  operation: MemoryContextOperation,
  timeoutMs: number,
  run: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new MemoryContextTimeoutError(operation)), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(run), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function sanitizeError(error: unknown, operation: MemoryContextOperation): MemoryContextError {
  if (error instanceof MemoryContextTimeoutError) {
    return {
      name: "MemoryContextError",
      code: "timeout",
      message: `Supermemory ${operation} timed out`,
      retryable: true,
    };
  }
  if (error instanceof MemoryContextIsolationError) {
    return {
      name: "MemoryContextError",
      code: "isolation",
      message: "Memory owner container validation failed",
      retryable: false,
    };
  }
  if (error instanceof MemoryContextInputError) {
    return {
      name: "MemoryContextError",
      code: "invalid_input",
      message: "Memory recall requires a non-empty query",
      retryable: false,
    };
  }
  if (error instanceof SupermemoryProviderError) {
    return {
      name: "MemoryContextError",
      code: error.code,
      message:
        error.code === "timeout"
          ? `Supermemory ${operation} timed out`
          : error.code === "configuration"
            ? "Supermemory memory context is not configured correctly"
            : `Supermemory ${operation} failed`,
      retryable: error.retryable,
    };
  }
  return {
    name: "MemoryContextError",
    code: "provider",
    message: `Supermemory ${operation} failed`,
    retryable: error instanceof TypeError,
  };
}

function emitInstrumentation(
  hook: MemoryContextInstrumentationHook | undefined,
  event: MemoryContextInstrumentationEvent,
): void {
  if (!hook) return;
  try {
    const result = hook(event);
    if (result) void Promise.resolve(result).catch(() => undefined);
  } catch {
    // Observability is never user-visible.
  }
}

function elapsed(now: () => number, startedAt: number): number {
  return Math.max(0, Math.round(now() - startedAt));
}

function normalizeHydration(
  result: MemoryHydrationResult,
  resultLimit: number,
  latencyMs: number,
): MemoryHydrationResult {
  return {
    provider: "supermemory",
    profile: {
      static: Array.isArray(result.profile?.static)
        ? result.profile.static.filter((fact): fact is string => typeof fact === "string")
        : [],
      dynamic: Array.isArray(result.profile?.dynamic)
        ? result.profile.dynamic.filter((fact): fact is string => typeof fact === "string")
        : [],
    },
    results: Array.isArray(result.results)
      ? [...result.results]
          .sort((left, right) => right.similarity - left.similarity || left.id.localeCompare(right.id))
          .slice(0, resultLimit)
      : [],
    latencyMs,
  };
}

export async function hydrateMemoryContext(
  input: HydrateMemoryContextInput,
): Promise<MemoryContextResult> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  try {
    const settings = resolveSettings(input);
    assertOwnerContainer(input.owner);
    assertQuery(input.currentUserMessage);
    const providerResult = await withDeadline("hydrate", settings.timeoutMs, () =>
      input.provider.profile({
        containerTag: input.owner.containerTag,
        q: input.currentUserMessage,
        threshold: settings.threshold,
      }),
    );
    const latencyMs = elapsed(now, startedAt);
    const hydration = normalizeHydration(providerResult, settings.searchLimit, latencyMs);
    const formattedContext = formatMemoryContext(hydration);
    const status: MemoryContextStatus = formattedContext ? "success" : "empty";
    emitInstrumentation(input.instrumentation, {
      name: "memory.recall.completed",
      operation: "hydrate",
      status,
      latencyMs,
      resultCount: hydration.results.length,
      profileFactCount: hydration.profile.static.length + hydration.profile.dynamic.length,
    });
    return { status, hydration, formattedContext };
  } catch (cause) {
    const latencyMs = elapsed(now, startedAt);
    const error = sanitizeError(cause, "hydrate");
    emitInstrumentation(input.instrumentation, {
      name: "memory.recall.failed",
      operation: "hydrate",
      status: "failed",
      latencyMs,
      resultCount: 0,
      profileFactCount: 0,
      errorCode: error.code,
    });
    return {
      status: "failed",
      hydration: emptyMemoryHydration(latencyMs),
      formattedContext: "",
      error,
    };
  }
}

export async function recallMemory(input: RecallMemoryInput): Promise<MemoryRecallResult> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  try {
    const settings = resolveSettings(input);
    assertOwnerContainer(input.owner);
    assertQuery(input.q);
    const results = (
      await withDeadline("recall", settings.timeoutMs, () =>
        input.provider.search({
          q: input.q,
          containerTag: input.owner.containerTag,
          searchMode: "memories",
          limit: settings.searchLimit,
          threshold: settings.threshold,
        }),
      )
    ).slice(0, settings.searchLimit);
    const latencyMs = elapsed(now, startedAt);
    const status: MemoryContextStatus = results.length > 0 ? "success" : "empty";
    emitInstrumentation(input.instrumentation, {
      name: "memory.recall.completed",
      operation: "recall",
      status,
      latencyMs,
      resultCount: results.length,
      profileFactCount: 0,
    });
    return { status, results, latencyMs };
  } catch (cause) {
    const latencyMs = elapsed(now, startedAt);
    const error = sanitizeError(cause, "recall");
    emitInstrumentation(input.instrumentation, {
      name: "memory.recall.failed",
      operation: "recall",
      status: "failed",
      latencyMs,
      resultCount: 0,
      profileFactCount: 0,
      errorCode: error.code,
    });
    return { status: "failed", results: [], latencyMs, error };
  }
}
