import { useCallback, useEffect, useState } from "react";

type IdentityStatus = "ready" | "unconfigured" | "recovery_required";

interface PairingStatus {
  paired: boolean;
  identityStatus: IdentityStatus;
  codeActive: boolean;
  codeExpiresAt: number | null;
}

interface PairingCandidate {
  token: string;
  label: string;
  lastInboundAt: number;
  expiresAt: number;
}

interface GeneratedCode {
  code: string;
  expiresAt: number;
}

type RequestState = "idle" | "status" | "code" | "candidates" | "confirm";

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || body.ok !== true) {
    throw new Error(
      typeof body.error === "string"
        ? body.error
        : `Pairing request failed (${response.status})`,
    );
  }
  return body;
}

function parseStatus(body: Record<string, unknown>): PairingStatus {
  const identityStatus = body.identityStatus;
  if (
    typeof body.paired !== "boolean" ||
    typeof body.codeActive !== "boolean" ||
    (identityStatus !== "ready" &&
      identityStatus !== "unconfigured" &&
      identityStatus !== "recovery_required")
  ) {
    throw new Error("Pairing status is unavailable.");
  }
  return {
    paired: body.paired,
    identityStatus,
    codeActive: body.codeActive,
    codeExpiresAt: typeof body.codeExpiresAt === "number" ? body.codeExpiresAt : null,
  };
}

function parseCandidates(body: Record<string, unknown>): PairingCandidate[] {
  if (!Array.isArray(body.candidates)) {
    throw new Error("Pairing candidates are unavailable.");
  }
  return body.candidates.flatMap((candidate) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !("token" in candidate) ||
      !("label" in candidate) ||
      !("lastInboundAt" in candidate) ||
      !("expiresAt" in candidate) ||
      typeof candidate.token !== "string" ||
      typeof candidate.label !== "string" ||
      typeof candidate.lastInboundAt !== "number" ||
      typeof candidate.expiresAt !== "number"
    ) {
      return [];
    }
    return [candidate as PairingCandidate];
  });
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function PrimaryOwnerPairing({ isDark }: { isDark: boolean }) {
  const [status, setStatus] = useState<PairingStatus | null>(null);
  const [candidates, setCandidates] = useState<PairingCandidate[]>([]);
  const [generatedCode, setGeneratedCode] = useState<GeneratedCode | null>(null);
  const [requestState, setRequestState] = useState<RequestState>("status");
  const [message, setMessage] = useState("Checking pairing status…");
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    const body = await readJson(await fetch("/api/memory/pairing/status"));
    const next = parseStatus(body);
    setStatus(next);
    if (next.paired) {
      setCandidates([]);
      setGeneratedCode(null);
      setMessage("Primary owner paired.");
    } else if (next.identityStatus === "ready") {
      setMessage("Ready to pair a primary owner.");
    } else if (next.identityStatus === "recovery_required") {
      setMessage("Memory identity recovery is required before pairing.");
    } else {
      setMessage("Memory identity is unconfigured. Complete local setup before pairing.");
    }
    return next;
  }, []);

  const refreshCandidates = useCallback(async () => {
    const body = await readJson(await fetch("/api/memory/pairing/candidates"));
    const next = parseCandidates(body);
    setCandidates(next);
    setMessage(
      next.length === 0
        ? "No recent inbound SMS conversations are available."
        : `${next.length} recent inbound ${next.length === 1 ? "conversation" : "conversations"} available.`,
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    refreshStatus()
      .then((next) => {
        if (!cancelled && !next.paired && next.identityStatus === "ready") {
          return refreshCandidates();
        }
        return undefined;
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setMessage("Pairing controls are unavailable.");
        }
      })
      .finally(() => {
        if (!cancelled) setRequestState("idle");
      });
    return () => {
      cancelled = true;
    };
  }, [refreshCandidates, refreshStatus]);

  async function rotateCode() {
    setRequestState("code");
    setError(null);
    try {
      const body = await readJson(
        await fetch("/api/memory/pairing/code", { method: "POST" }),
      );
      if (typeof body.code !== "string" || typeof body.expiresAt !== "number") {
        throw new Error("Pairing code is unavailable.");
      }
      setGeneratedCode({ code: body.code, expiresAt: body.expiresAt });
      setStatus((current) =>
        current ? { ...current, codeActive: true, codeExpiresAt: body.expiresAt as number } : current,
      );
      setMessage("A new pairing code is ready and expires in ten minutes.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setMessage("Pairing code could not be generated.");
    } finally {
      setRequestState("idle");
    }
  }

  async function reloadCandidates() {
    setRequestState("candidates");
    setError(null);
    try {
      await refreshCandidates();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setMessage("Recent inbound conversations could not be loaded.");
    } finally {
      setRequestState("idle");
    }
  }

  async function confirmCandidate(token: string) {
    setRequestState("confirm");
    setError(null);
    try {
      const body = await readJson(
        await fetch("/api/memory/pairing/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        }),
      );
      if (body.status !== "registered" && body.status !== "existing") {
        throw new Error("The primary owner could not be paired.");
      }
      setMessage(
        body.status === "registered"
          ? "Primary owner paired successfully."
          : "This conversation is already the primary owner.",
      );
      setStatus((current) => ({
        paired: true,
        identityStatus: current?.identityStatus ?? "ready",
        codeActive: false,
        codeExpiresAt: null,
      }));
      setCandidates([]);
      setGeneratedCode(null);
      await refreshStatus().catch(() => undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setMessage("The primary owner could not be paired.");
    } finally {
      setRequestState("idle");
    }
  }

  const ready = status?.identityStatus === "ready" && !status.paired;
  const busy = requestState !== "idle";
  const secondaryButton = isDark
    ? "border-white/10 bg-white/5 text-zinc-200 hover:bg-white/10"
    : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50";
  const primaryButton = isDark
    ? "bg-zinc-100 text-zinc-950 hover:bg-white"
    : "bg-zinc-950 text-white hover:bg-zinc-800";
  const muted = isDark ? "text-zinc-400" : "text-zinc-500";
  const candidateSurface = isDark
    ? "border-white/10 bg-white/[0.035]"
    : "border-zinc-200 bg-zinc-50/80";

  return (
    <section aria-label="Primary memory owner pairing" aria-busy={busy}>
      <div className="flex flex-col gap-3 lg:min-w-[390px]">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span
            className={`status-badge mono ${
              status?.paired
                ? "border-emerald-500/30 text-emerald-500"
                : status?.identityStatus === "recovery_required"
                  ? "border-amber-500/30 text-amber-500"
                  : ""
            }`}
          >
            {status === null
              ? "Checking"
              : status.paired
                ? "Paired"
                : status.identityStatus === "ready"
                  ? "Unpaired"
                  : status.identityStatus === "recovery_required"
                    ? "Recovery required"
                    : "Unconfigured"}
          </span>
          {ready && (
            <button
              type="button"
              onClick={rotateCode}
              disabled={busy}
              className={`min-h-11 rounded-xl px-3 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-50 ${primaryButton}`}
            >
              {requestState === "code"
                ? "Generating…"
                : status?.codeActive
                  ? "Rotate pairing code"
                  : "Generate pairing code"}
            </button>
          )}
        </div>

        {generatedCode && ready && (
          <div className={`rounded-xl border p-3 ${candidateSurface}`}>
            <p className={`text-xs leading-relaxed ${muted}`}>
              From the intended owner’s phone, text this exact command before {formatTime(generatedCode.expiresAt)}:
            </p>
            <output
              aria-label="Temporary pairing command"
              className="mt-2 block select-all break-words text-base font-semibold tracking-[0.08em] mono"
            >
              PAIR {generatedCode.code}
            </output>
          </div>
        )}

        {ready && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-semibold">
                Recent inbound SMS conversations
              </div>
              <button
                type="button"
                onClick={reloadCandidates}
                disabled={busy}
                className={`min-h-11 rounded-xl border px-3 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-50 ${secondaryButton}`}
              >
                {requestState === "candidates" ? "Refreshing…" : "Refresh conversations"}
              </button>
            </div>
            {candidates.length === 0 ? (
              <p className={`text-xs leading-relaxed ${muted}`}>
                No recent inbound conversations are available yet.
              </p>
            ) : (
              <ul className="space-y-2" aria-label="Recent inbound SMS conversations">
                {candidates.map((candidate) => (
                  <li
                    key={candidate.token}
                    className={`flex flex-col gap-2 rounded-xl border p-3 sm:flex-row sm:items-center sm:justify-between ${candidateSurface}`}
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{candidate.label}</div>
                      <time
                        className={`mt-0.5 block text-[11px] mono ${muted}`}
                        dateTime={new Date(candidate.lastInboundAt).toISOString()}
                      >
                        Last inbound {formatTime(candidate.lastInboundAt)}
                      </time>
                    </div>
                    <button
                      type="button"
                      onClick={() => confirmCandidate(candidate.token)}
                      disabled={busy}
                      className={`min-h-11 shrink-0 rounded-xl px-3 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-50 ${primaryButton}`}
                    >
                      {requestState === "confirm" ? "Pairing…" : "Pair this conversation"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <p className={`text-xs leading-relaxed ${muted}`} role="status" aria-live="polite">
          {message}
        </p>
        {error && (
          <p className="text-xs text-rose-500" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
