import { randomUUID } from "node:crypto";
import { api } from "../../../convex/_generated/api.js";
import { convex } from "../../convex-client.js";

export type ProviderReadOperation =
  | "hydration"
  | "profile"
  | "search"
  | "documents"
  | "entries";

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = String((error as { code?: unknown }).code ?? "").trim();
  return /^[a-z0-9_-]{1,80}$/i.test(code) ? code : undefined;
}

/** Persists only bounded operational fields; prompts and provider responses never cross this boundary. */
export async function recordProviderRead(input: {
  operation: ProviderReadOperation;
  startedAt: number;
  finishedAt?: number;
  error?: unknown;
}): Promise<void> {
  const finishedAt = input.finishedAt ?? Date.now();
  const latencyMs = Math.max(0, finishedAt - input.startedAt);
  const failed = input.error !== undefined;
  const writes: Promise<unknown>[] = [
    convex.mutation(api.memoryProviderEvents.record, {
      eventId: `provider-read-${randomUUID()}`,
      operation: input.operation,
      outcome: failed ? "failure" : "success",
      latencyMs,
      errorCode: errorCode(input.error),
      createdAt: finishedAt,
    }),
  ];
  if (input.operation === "hydration") {
    writes.push(
      convex.mutation(api.memoryProviderMetrics.recordHydration, {
        at: finishedAt,
        failed,
        latencyMs,
      }),
    );
  }
  const results = await Promise.allSettled(writes);
  if (results.some((result) => result.status === "rejected")) {
    console.warn("[memory] provider observability write unavailable", {
      operation: input.operation,
      failedWrites: results.filter((result) => result.status === "rejected").length,
    });
  }
}
