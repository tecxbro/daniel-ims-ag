import { useEffect, useState } from "react";

export type MemoryProfileState = "ready" | "empty" | "unavailable";

export function profileStateFromResponse(value: unknown): MemoryProfileState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "unavailable";
  const state = (value as Record<string, unknown>).profileState;
  return state === "ready" || state === "empty" ? state : "unavailable";
}

export function useMemoryProfileState(): MemoryProfileState {
  const [state, setState] = useState<MemoryProfileState>("unavailable");
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/memory/profile", {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return "unavailable" as const;
        return profileStateFromResponse(await response.json());
      })
      .then(setState)
      .catch(() => {
        if (!controller.signal.aborted) setState("unavailable");
      });
    return () => controller.abort();
  }, []);
  return state;
}
