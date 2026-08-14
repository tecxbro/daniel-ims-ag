import {
  readMemoryProviderConfiguration,
  SupermemoryProviderError,
} from "./client.js";
import {
  formatMemoryContext,
  MEMORY_SEARCH_RESULT_LIMIT,
} from "./format-context.js";
import { validateProviderIdentifier } from "./identity.js";
import type {
  DanielMemoryProvider,
  MemoryHydrationResult,
  MemoryOwnerContext,
  MemoryReadMode,
  MemorySearchResult,
} from "./types.js";

type Environment = Record<string, string | undefined>;

export interface MemoryContextConfiguration {
  timeoutMs: number;
  threshold: number;
  searchLimit: number;
  legacyFallback: boolean;
}

export type MemoryContextErrorCode =
  | "authentication"
  | "configuration"
  | "invalid_input"
  | "isolation"
  | "provider"
  | "rate_limit"
  | "timeout";

/** Sanitized error data that is safe to include in metrics or temporary logs. */
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
  mode: MemoryReadMode;
  status: MemoryContextStatus;
  latencyMs: number;
  resultCount: number;
  profileFactCount: number;
  fallbackEligible: boolean;
  errorCode?: MemoryContextErrorCode;
}

export type MemoryContextInstrumentationHook = (
  event: MemoryContextInstrumentationEvent,
) => void | Promise<void>;

export interface MemoryContextOperationOptions {
  provider: Pick<DanielMemoryProvider, "profile" | "search">;
  owner: MemoryOwnerContext;
  config?: Partial<MemoryContextConfiguration>;
  mode?: MemoryReadMode;
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
  mode: MemoryReadMode;
  hydration: MemoryHydrationResult;
  formattedContext: string;
  fallbackEligible: boolean;
  error?: MemoryContextError;
}

export interface MemoryRecallResult {
  status: MemoryContextStatus;
  mode: MemoryReadMode;
  results: MemorySearchResult[];
  latencyMs: number;
  fallbackEligible: boolean;
  error?: MemoryContextError;
}

interface ResolvedOperationSettings {
  config: MemoryContextConfiguration;
  mode: MemoryReadMode;
  fallbackEligible: boolean;
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

function assertFiniteInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new SupermemoryProviderError(`${label} must be a positive integer`, {
      operation: "configuration",
      code: "configuration",
    });
  }
}

function resolveSettings(
  input: Pick<MemoryContextOperationOptions, "config" | "env" | "mode">,
): ResolvedOperationSettings {
  const providerConfig = readMemoryProviderConfiguration(input.env ?? process.env);
  const timeoutMs = input.config?.timeoutMs ?? providerConfig.timeoutMs;
  const threshold = input.config?.threshold ?? providerConfig.threshold;
  const requestedLimit = input.config?.searchLimit ?? providerConfig.searchLimit;
  const legacyFallback = input.config?.legacyFallback ?? providerConfig.legacyFallback;

  assertFiniteInteger(timeoutMs, "DANIEL_SUPERMEMORY_TIMEOUT_MS");
  assertFiniteInteger(requestedLimit, "DANIEL_SUPERMEMORY_SEARCH_LIMIT");
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new SupermemoryProviderError(
      "DANIEL_SUPERMEMORY_THRESHOLD must be between 0 and 1",
      { operation: "configuration", code: "configuration" },
    );
  }

  const mode = input.mode ?? providerConfig.readMode;
  return {
    mode,
    config: {
      timeoutMs,
      threshold,
      searchLimit: Math.min(requestedLimit, MEMORY_SEARCH_RESULT_LIMIT),
      legacyFallback,
    },
    // Convex/shadow modes still have a legacy primary result. Supermemory mode
    // may use it only during the explicitly configured migration burn-in.
    fallbackEligible: mode !== "supermemory" || legacyFallback,
  };
}

/**
 * Proves that the caller supplied the already-derived private owner container.
 * Raw owner identifiers are deliberately not re-derived or sent to the provider
 * on this hot path.
 */
function assertOwnerContainer(owner: MemoryOwnerContext): void {
  try {
    validateProviderIdentifier(owner.ownerKey, "ownerKey");
    if (!/^[a-f0-9]{32}$/.test(owner.ownerKey)) {
      throw new MemoryContextIsolationError();
    }
    const expectedContainerTag = validateProviderIdentifier(
      `daniel-user-${owner.ownerKey}`,
      "containerTag",
    );
    validateProviderIdentifier(owner.containerTag, "containerTag");
    if (owner.containerTag !== expectedContainerTag) {
      throw new MemoryContextIsolationError();
    }
  } catch (error) {
    if (error instanceof MemoryContextIsolationError) throw error;
    throw new MemoryContextIsolationError();
  }
}

function assertQuery(query: string): void {
  if (typeof query !== "string" || !query.trim()) {
    throw new MemoryContextInputError();
  }
}

function elapsedMilliseconds(now: () => number, startedAt: number): number {
  return Math.max(0, Math.round(now() - startedAt));
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
  if (!hook) {
    if (event.name === "memory.recall.failed") {
      console.warn(event.name, event);
    }
    return;
  }
  try {
    const pending = hook(event);
    if (pending) void Promise.resolve(pending).catch(() => undefined);
  } catch {
    // Observability must never make memory hydration user-visible or blocking.
  }
}

function normalizeHydration(
  result: MemoryHydrationResult,
  resultLimit: number,
  latencyMs: number,
): MemoryHydrationResult {
  const compareRelevance = (left: MemorySearchResult, right: MemorySearchResult): number => {
    const similarity = right.similarity - left.similarity;
    if (Number.isFinite(similarity) && similarity !== 0) return similarity;
    return left.id.localeCompare(right.id, "en-US");
  };
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
      ? [...result.results].sort(compareRelevance).slice(0, resultLimit)
      : [],
    latencyMs,
  };
}

function preliminaryMode(input: MemoryContextOperationOptions): MemoryReadMode {
  if (input.mode) return input.mode;
  const rawMode = (input.env ?? process.env).DANIEL_MEMORY_READ_MODE
    ?.trim()
    .toLocaleLowerCase("en-US");
  return rawMode === "shadow" || rawMode === "supermemory" ? rawMode : "convex";
}

function preliminaryFallbackEligibility(input: MemoryContextOperationOptions): boolean {
  if (preliminaryMode(input) !== "supermemory") return true;
  if (input.config?.legacyFallback !== undefined) return input.config.legacyFallback;
  return (input.env ?? process.env).DANIEL_MEMORY_LEGACY_FALLBACK?.trim().toLowerCase() !== "false";
}

/**
 * Fetches stable profile, recent profile, and query-specific memories in the
 * provider's single profile call. It never reads Convex or changes read mode.
 */
export async function hydrateMemoryContext(
  input: HydrateMemoryContextInput,
): Promise<MemoryContextResult> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  let mode = preliminaryMode(input);
  let fallbackEligible = preliminaryFallbackEligibility(input);

  try {
    const settings = resolveSettings(input);
    mode = settings.mode;
    fallbackEligible = settings.fallbackEligible;
    assertOwnerContainer(input.owner);
    assertQuery(input.currentUserMessage);

    const providerResult = await withDeadline("hydrate", settings.config.timeoutMs, () =>
      input.provider.profile({
        containerTag: input.owner.containerTag,
        q: input.currentUserMessage,
        threshold: settings.config.threshold,
      }),
    );
    const latencyMs = elapsedMilliseconds(now, startedAt);
    const hydration = normalizeHydration(
      providerResult,
      settings.config.searchLimit,
      latencyMs,
    );
    const formattedContext = formatMemoryContext(hydration);
    const status: MemoryContextStatus = formattedContext ? "success" : "empty";

    emitInstrumentation(input.instrumentation, {
      name: "memory.recall.completed",
      operation: "hydrate",
      mode,
      status,
      latencyMs,
      resultCount: hydration.results.length,
      profileFactCount: hydration.profile.static.length + hydration.profile.dynamic.length,
      fallbackEligible,
    });
    return {
      status,
      mode,
      hydration,
      formattedContext,
      fallbackEligible,
    };
  } catch (cause) {
    const latencyMs = elapsedMilliseconds(now, startedAt);
    const error = sanitizeError(cause, "hydrate");
    emitInstrumentation(input.instrumentation, {
      name: "memory.recall.failed",
      operation: "hydrate",
      mode,
      status: "failed",
      latencyMs,
      resultCount: 0,
      profileFactCount: 0,
      fallbackEligible,
      errorCode: error.code,
    });
    return {
      status: "failed",
      mode,
      hydration: emptyMemoryHydration(latencyMs),
      formattedContext: "",
      fallbackEligible,
      error,
    };
  }
}

/**
 * Performs an independent, memory-only search for a narrow follow-up question.
 * The function is intentionally stateless so callers can issue different
 * recall queries throughout one dispatcher turn.
 */
export async function recallMemory(input: RecallMemoryInput): Promise<MemoryRecallResult> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  let mode = preliminaryMode(input);
  let fallbackEligible = preliminaryFallbackEligibility(input);

  try {
    const settings = resolveSettings(input);
    mode = settings.mode;
    fallbackEligible = settings.fallbackEligible;
    assertOwnerContainer(input.owner);
    assertQuery(input.q);

    const providerResults = await withDeadline("recall", settings.config.timeoutMs, () =>
      input.provider.search({
        q: input.q,
        containerTag: input.owner.containerTag,
        searchMode: "memories",
        limit: settings.config.searchLimit,
        threshold: settings.config.threshold,
      }),
    );
    const latencyMs = elapsedMilliseconds(now, startedAt);
    const results = providerResults.slice(0, settings.config.searchLimit);
    const status: MemoryContextStatus = results.length > 0 ? "success" : "empty";

    emitInstrumentation(input.instrumentation, {
      name: "memory.recall.completed",
      operation: "recall",
      mode,
      status,
      latencyMs,
      resultCount: results.length,
      profileFactCount: 0,
      fallbackEligible,
    });
    return { status, mode, results, latencyMs, fallbackEligible };
  } catch (cause) {
    const latencyMs = elapsedMilliseconds(now, startedAt);
    const error = sanitizeError(cause, "recall");
    emitInstrumentation(input.instrumentation, {
      name: "memory.recall.failed",
      operation: "recall",
      mode,
      status: "failed",
      latencyMs,
      resultCount: 0,
      profileFactCount: 0,
      fallbackEligible,
      errorCode: error.code,
    });
    return {
      status: "failed",
      mode,
      results: [],
      latencyMs,
      fallbackEligible,
      error,
    };
  }
}

export interface ShadowRecallValue {
  id?: string;
  content: string;
}

export interface ShadowExpectedFact {
  id?: string;
  text?: string;
  expectedPresence?: "present" | "absent";
}

export interface CompareShadowRecallInput {
  legacyResults: readonly (string | ShadowRecallValue)[];
  supermemory: Pick<MemoryHydrationResult, "profile" | "results" | "latencyMs">;
  expectedFacts?: readonly ShadowExpectedFact[];
  error?: unknown;
}

/** Aggregate-only comparison data; it intentionally contains no fact text or profile. */
export interface ShadowRecallComparison {
  latencyMs: number;
  legacyResultCount: number;
  supermemoryResultCount: number;
  overlapCount: number;
  overlapRate: number;
  expectedFactCount: number;
  expectedFactMatchCount: number;
  expectedFactCoverage: number;
  expectedAbsenceCount: number;
  expectedAbsenceViolationCount: number;
  error?: MemoryContextError;
}

function normalizeComparisonText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim();
}

function contentMatches(expected: string, actual: string): boolean {
  return expected === actual || actual.includes(expected) || expected.includes(actual);
}

/**
 * Computes shadow-read metrics without logging or returning raw profile data.
 * Callers choose the persistence boundary for this aggregate report.
 */
export function compareShadowRecall(input: CompareShadowRecallInput): ShadowRecallComparison {
  const legacyContent = new Set(
    input.legacyResults
      .map((result) => normalizeComparisonText(typeof result === "string" ? result : result.content))
      .filter(Boolean),
  );
  const allSupermemoryContent = [
    ...input.supermemory.profile.static,
    ...input.supermemory.profile.dynamic,
    ...input.supermemory.results.map((result) => result.content),
  ]
    .map(normalizeComparisonText)
    .filter(Boolean);
  const allSupermemoryContentSet = new Set(allSupermemoryContent);
  const supermemoryIds = new Set(input.supermemory.results.map((result) => result.id));

  let overlapCount = 0;
  for (const legacy of legacyContent) {
    if ([...allSupermemoryContentSet].some((current) => contentMatches(legacy, current))) {
      overlapCount += 1;
    }
  }
  const overlapUnionCount = legacyContent.size + allSupermemoryContentSet.size - overlapCount;

  const expectedPresent = (input.expectedFacts ?? []).filter(
    (fact) => fact.expectedPresence !== "absent",
  );
  const expectedAbsent = (input.expectedFacts ?? []).filter(
    (fact) => fact.expectedPresence === "absent",
  );
  const matchesExpected = (fact: ShadowExpectedFact): boolean => {
    if (fact.id && supermemoryIds.has(fact.id)) return true;
    if (!fact.text) return false;
    const expectedText = normalizeComparisonText(fact.text);
    return allSupermemoryContent.some((actual) => contentMatches(expectedText, actual));
  };
  const expectedFactMatchCount = expectedPresent.filter(matchesExpected).length;
  const expectedAbsenceViolationCount = expectedAbsent.filter(matchesExpected).length;

  return {
    latencyMs: input.supermemory.latencyMs,
    legacyResultCount: input.legacyResults.length,
    supermemoryResultCount: input.supermemory.results.length,
    overlapCount,
    overlapRate: overlapUnionCount === 0 ? 1 : overlapCount / overlapUnionCount,
    expectedFactCount: expectedPresent.length,
    expectedFactMatchCount,
    expectedFactCoverage:
      expectedPresent.length === 0 ? 1 : expectedFactMatchCount / expectedPresent.length,
    expectedAbsenceCount: expectedAbsent.length,
    expectedAbsenceViolationCount,
    error: input.error ? sanitizeError(input.error, "hydrate") : undefined,
  };
}
