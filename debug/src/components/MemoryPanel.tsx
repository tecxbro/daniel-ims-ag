import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import MemorySourceExplorer, {
  type MemoryExplorerItem,
  type MemoryVersionSummary,
} from "./MemoryGraphView.js";
import { SupermemoryStatusBanner } from "./EmbeddingBanner.js";
import { SegmentedControl } from "./GlassPrimitives.js";
import {
  EmptyState,
  HeaderPill,
  PanelPage,
  panelCardClass,
  subtlePanelClass,
} from "./PanelPrimitives.js";

type MemoryView = "profile" | "search" | "documents";
type UnknownRecord = Record<string, unknown>;

interface ProfileSnapshot {
  state: "ready" | "empty";
  stable: string[];
  recent: string[];
  relevant: MemoryExplorerItem[];
  latencyMs?: number;
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function lines(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean);
  }
  const single = text(value);
  return single ? single.split("\n").map((line) => line.trim()).filter(Boolean) : [];
}

function history(value: unknown): MemoryVersionSummary[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const versions = value.map((entry) => {
    const raw = record(entry);
    return {
      id: text(raw.id ?? raw.memoryId),
      version: numberValue(raw.version) ?? text(raw.version),
      content: text(raw.content ?? raw.memory ?? raw.text),
      status: text(raw.status),
      createdAt: timestamp(raw.createdAt),
      updatedAt: timestamp(raw.updatedAt),
    };
  });
  return versions.length > 0 ? versions : undefined;
}

function explorerItem(value: unknown, index: number, kind: "memory" | "document"): MemoryExplorerItem {
  const raw = record(value);
  const metadata = record(raw.metadata);
  const id =
    text(raw.id ?? raw.memoryId ?? raw.documentId ?? raw.providerDocumentId) ??
    `${kind}:${index}`;
  const forgotten =
    raw.forgotten === true ||
    raw.isForgotten === true ||
    metadata.forgotten === true ||
    text(raw.status)?.toLowerCase() === "forgotten" ||
    text(metadata.status)?.toLowerCase() === "forgotten" ||
    Boolean(text(raw.forgetReason));
  const currentValue =
    raw.current ?? raw.isCurrent ?? raw.latest ?? raw.isLatest ?? metadata.current ?? metadata.isCurrent;
  return {
    id,
    title: text(raw.title ?? raw.name ?? raw.filename),
    content: text(raw.content ?? raw.memory ?? raw.text ?? raw.summary ?? raw.excerpt),
    status: text(raw.status ?? raw.processingStatus),
    current: typeof currentValue === "boolean" ? currentValue : forgotten ? false : undefined,
    forgotten,
    similarity: numberValue(raw.similarity ?? raw.score),
    version:
      numberValue(raw.version ?? metadata.version) ?? text(raw.version ?? metadata.version),
    providerDocumentId: text(
      raw.providerDocumentId ?? metadata.providerDocumentId ?? raw.documentId ?? (kind === "document" ? raw.id : undefined),
    ),
    providerMemoryId: text(
      raw.providerMemoryId ?? metadata.providerMemoryId ?? raw.memoryId ?? (kind === "memory" ? raw.id : undefined),
    ),
    updatedAt: timestamp(raw.updatedAt),
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    history: history(raw.history ?? raw.versions ?? raw.versionHistory ?? metadata.history),
  };
}

function normalizeProfile(value: unknown): ProfileSnapshot {
  const raw = record(value);
  const profile = record(raw.profile);
  const relevantValues = raw.results ?? raw.memories ?? profile.memories;
  return {
    state: raw.profileState === "ready" ? "ready" : "empty",
    stable: lines(profile.static ?? raw.staticProfile ?? raw.static),
    recent: lines(profile.dynamic ?? raw.dynamicProfile ?? raw.recentContext ?? raw.dynamic),
    relevant: Array.isArray(relevantValues)
      ? relevantValues.map((entry, index) => explorerItem(entry, index, "memory"))
      : [],
    latencyMs: numberValue(raw.latencyMs),
  };
}

function normalizeList(value: unknown, kind: "memory" | "document"): MemoryExplorerItem[] {
  const raw = record(value);
  const candidates =
    kind === "memory"
      ? raw.results ?? raw.memories ?? raw.items ?? value
      : raw.documents ?? raw.results ?? raw.items ?? value;
  return Array.isArray(candidates)
    ? candidates.map((entry, index) => explorerItem(entry, index, kind))
    : [];
}

async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { headers: { Accept: "application/json" }, signal });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return await response.json();
}

const VIEWS: { id: MemoryView; label: string }[] = [
  { id: "profile", label: "Profile" },
  { id: "search", label: "Search" },
  { id: "documents", label: "Documents" },
];

export function MemoryPanel({ isDark }: { isDark: boolean }) {
  const [view, setView] = useState<MemoryView>("profile");
  const [profile, setProfile] = useState<ProfileSnapshot | null>(null);
  const [documents, setDocuments] = useState<MemoryExplorerItem[]>([]);
  const [entries, setEntries] = useState<MemoryExplorerItem[]>([]);
  const [searchResults, setSearchResults] = useState<MemoryExplorerItem[]>([]);
  const [query, setQuery] = useState("");
  const [documentQuery, setDocumentQuery] = useState("");
  const [loadingProfile, setLoadingProfile] = useState(true);
  const [loadingDocuments, setLoadingDocuments] = useState(false);
  const [searching, setSearching] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [documentsError, setDocumentsError] = useState<string | null>(null);
  const [entriesError, setEntriesError] = useState<string | null>(null);
  const [documentsMessage, setDocumentsMessage] = useState("Enter a query to find source documents.");
  const [searchMessage, setSearchMessage] = useState("Enter a question to search provider memory.");
  const searchId = useId();

  const loadProfile = useCallback(async (signal?: AbortSignal) => {
    setLoadingProfile(true);
    try {
      setProfile(normalizeProfile(await getJson("/api/memory/profile", signal)));
      setProfileError(null);
    } catch (cause) {
      if (!signal?.aborted) setProfileError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!signal?.aborted) setLoadingProfile(false);
    }
  }, []);

  const loadDocuments = useCallback(async (requestedQuery = "", signal?: AbortSignal) => {
    const normalizedQuery = requestedQuery.trim();
    setLoadingDocuments(true);
    try {
      const response = normalizedQuery
        ? await fetch("/api/memory/search", {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({ q: normalizedQuery, limit: 50, searchMode: "documents" }),
            signal,
          }).then(async (result) => {
            if (!result.ok) throw new Error(`Document search failed (${result.status})`);
            return await result.json();
          })
        : await getJson("/api/memory/documents?page=1&limit=50", signal);
      const results = normalizeList(
        response,
        "document",
      );
      setDocuments(results);
      setDocumentsError(null);
      setDocumentsMessage(
        `${results.length} ${results.length === 1 ? "document" : "documents"} ${normalizedQuery ? "found" : "browsed"}.`,
      );
    } catch (cause) {
      if (!signal?.aborted) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setDocumentsError(message);
        setDocumentsMessage(message);
      }
    } finally {
      if (!signal?.aborted) setLoadingDocuments(false);
    }
  }, []);

  const loadEntries = useCallback(async (signal?: AbortSignal) => {
    try {
      const value = await getJson(
        "/api/memory/entries?page=1&limit=50&order=desc&sort=updatedAt",
        signal,
      );
      setEntries(normalizeList(record(value).entries ?? value, "memory"));
      setEntriesError(null);
    } catch (cause) {
      if (!signal?.aborted) {
        setEntriesError(cause instanceof Error ? cause.message : String(cause));
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadProfile(controller.signal);
    void loadEntries(controller.signal);
    void loadDocuments("", controller.signal);
    return () => controller.abort();
  }, [loadDocuments, loadEntries, loadProfile]);

  async function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      setSearchMessage("Enter a question before searching.");
      return;
    }
    setSearching(true);
    setSearchMessage("Searching provider memory…");
    try {
      const response = await fetch("/api/memory/search", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ q: normalizedQuery, searchMode: "hybrid" }),
      });
      if (!response.ok) throw new Error(`Search failed (${response.status})`);
      const results = normalizeList(await response.json(), "memory");
      setSearchResults(results);
      setSearchMessage(`${results.length} ${results.length === 1 ? "result" : "results"} found.`);
    } catch (cause) {
      setSearchResults([]);
      setSearchMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSearching(false);
    }
  }

  function submitDocumentSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDocumentsError(null);
    void loadDocuments(documentQuery);
  }

  const profileCount = (profile?.stable.length ?? 0) + (profile?.recent.length ?? 0);
  const displayedCount =
    view === "profile" ? profileCount : view === "search" ? searchResults.length : documents.length;
  return (
    <PanelPage
      eyebrow="Supermemory"
      title="Memory"
      description="Inspect the current profile, semantic results, source documents, and provider fields returned by the server."
      stat={<HeaderPill isDark={isDark}>{displayedCount} shown</HeaderPill>}
      maxWidth="max-w-[1120px]"
    >
      <SupermemoryStatusBanner isDark={isDark} />

      <div className={panelCardClass(isDark, "flex flex-wrap items-center justify-between gap-3 px-3 py-3")}>
        <SegmentedControl
          lensId="memory-explorer-view"
          label="Memory explorer views"
          value={view}
          options={VIEWS.map((item) => ({
            value: item.id,
            label: item.label,
            controls: `memory-panel-${item.id}`,
          }))}
          onChange={setView}
        />
        <p className={`text-xs ${isDark ? "text-zinc-500" : "text-zinc-500"}`}>
          Provider identifiers are shown only for local debugging.
        </p>
      </div>

      {view === "profile" && (
        <div id="memory-panel-profile" role="tabpanel" className="space-y-4">
          {loadingProfile ? (
            <div className="grid gap-4 lg:grid-cols-2" aria-label="Loading profile">
              <div className={subtlePanelClass(isDark, "h-40 shimmer")} />
              <div className={subtlePanelClass(isDark, "h-40 shimmer")} />
            </div>
          ) : profileError ? (
            <ErrorState message={`Profile unavailable: ${profileError}`} onRetry={() => void loadProfile()} isDark={isDark} />
          ) : profile && profileCount === 0 ? (
            <EmptyState isDark={isDark}>
              No profile facts yet. Supermemory will build stable and recent context from completed conversations.
            </EmptyState>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              <ProfileSection title="Static profile" lines={profile?.stable ?? []} empty="No static profile facts." isDark={isDark} />
              <ProfileSection title="Recent context" lines={profile?.recent ?? []} empty="No recent context." isDark={isDark} />
            </div>
          )}

          {profile && profile.relevant.length > 0 && (
            <section className={panelCardClass(isDark, "overflow-hidden")}>
              <div className={`border-b px-5 py-3 ${isDark ? "border-white/10" : "border-zinc-200"}`}>
                <h2 className={`text-sm font-semibold ${isDark ? "text-zinc-100" : "text-zinc-950"}`}>Profile-linked results</h2>
                <p className={`mt-0.5 text-xs ${isDark ? "text-zinc-500" : "text-zinc-500"}`}>
                  Returned with the profile{profile.latencyMs !== undefined ? ` in ${Math.round(profile.latencyMs)} ms` : ""}.
                </p>
              </div>
              <MemorySourceExplorer items={profile.relevant} isDark={isDark} emptyMessage="No linked results." />
            </section>
          )}

          <section className={panelCardClass(isDark, "overflow-hidden")}>
            <div className={`border-b px-5 py-3 ${isDark ? "border-white/10" : "border-zinc-200"}`}>
              <h2 className={`text-sm font-semibold ${isDark ? "text-zinc-100" : "text-zinc-950"}`}>
                Current and historical memory entries
              </h2>
              <p className={`mt-0.5 text-xs ${isDark ? "text-zinc-500" : "text-zinc-500"}`}>
                Current, forgotten, and version-history state comes from the provider history endpoint.
              </p>
            </div>
            {entriesError ? (
              <ErrorState message={`Memory history unavailable: ${entriesError}`} onRetry={() => void loadEntries()} isDark={isDark} />
            ) : (
              <MemorySourceExplorer items={entries} isDark={isDark} emptyMessage="No memory entries yet." />
            )}
          </section>
        </div>
      )}

      {view === "search" && (
        <div id="memory-panel-search" role="tabpanel" className="space-y-4">
          <form onSubmit={submitSearch} role="search" className={panelCardClass(isDark, "p-4")}>
            <label htmlFor={searchId} className={`block text-xs font-medium ${isDark ? "text-zinc-300" : "text-zinc-700"}`}>
              Semantic memory search
            </label>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input
                id={searchId}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="What does the user prefer for launch briefs?"
                className={`min-h-10 min-w-0 flex-1 rounded-xl border px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                  isDark
                    ? "border-white/10 bg-[#17171a] text-zinc-100 placeholder:text-zinc-600"
                    : "border-zinc-200 bg-white text-zinc-900 placeholder:text-zinc-400"
                }`}
              />
              <button
                type="submit"
                aria-busy={searching}
                className={`min-h-10 rounded-xl px-4 text-sm font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                  isDark ? "bg-zinc-100 text-zinc-950 hover:bg-white" : "bg-zinc-950 text-white hover:bg-zinc-800"
                }`}
              >
                {searching ? "Searching…" : "Search"}
              </button>
            </div>
            <p role="status" aria-live="polite" className={`mt-2 text-xs ${isDark ? "text-zinc-500" : "text-zinc-500"}`}>
              {searchMessage}
            </p>
          </form>
          <section className={panelCardClass(isDark, "overflow-hidden")} aria-label="Search results">
            <MemorySourceExplorer
              items={searchResults}
              isDark={isDark}
              emptyMessage="No search results to show."
            />
          </section>
        </div>
      )}

      {view === "documents" && (
        <div id="memory-panel-documents" role="tabpanel">
          <section className={panelCardClass(isDark, "overflow-hidden")} aria-label="Source documents">
            <div className={`border-b px-5 py-3 ${isDark ? "border-white/10" : "border-zinc-200"}`}>
              <div>
                <h2 className={`text-sm font-semibold ${isDark ? "text-zinc-100" : "text-zinc-950"}`}>Source documents</h2>
                <p className={`mt-0.5 text-xs ${isDark ? "text-zinc-500" : "text-zinc-500"}`}>
                  Semantic document matches and source metadata. Processing, version, and history appear only when the server supplies them.
                </p>
              </div>
              <form onSubmit={submitDocumentSearch} role="search" className="mt-3 flex flex-col gap-2 sm:flex-row">
                <label htmlFor={`${searchId}-documents`} className="sr-only">Search source documents</label>
                <input
                  id={`${searchId}-documents`}
                  type="search"
                  value={documentQuery}
                  onChange={(event) => setDocumentQuery(event.target.value)}
                  placeholder="Search source documents"
                  className={`min-h-10 min-w-0 flex-1 rounded-xl border px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                    isDark
                      ? "border-white/10 bg-[#17171a] text-zinc-100 placeholder:text-zinc-600"
                      : "border-zinc-200 bg-white text-zinc-900 placeholder:text-zinc-400"
                  }`}
                />
                <button
                  type="submit"
                  aria-busy={loadingDocuments}
                  className={`min-h-10 rounded-xl px-4 text-sm font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                    isDark ? "bg-zinc-100 text-zinc-950 hover:bg-white" : "bg-zinc-950 text-white hover:bg-zinc-800"
                  }`}
                >
                  {loadingDocuments ? "Loading…" : documentQuery.trim() ? "Search documents" : "Browse documents"}
                </button>
              </form>
              <p role="status" aria-live="polite" className={`mt-2 text-xs ${isDark ? "text-zinc-500" : "text-zinc-500"}`}>
                {documentsMessage}
              </p>
            </div>
            {loadingDocuments ? (
              <div className="space-y-3 p-5" aria-label="Loading documents">
                <div className={subtlePanelClass(isDark, "h-20 shimmer")} />
                <div className={subtlePanelClass(isDark, "h-20 shimmer")} />
              </div>
            ) : documentsError ? (
              <ErrorState message={`Documents unavailable: ${documentsError}`} onRetry={() => void loadDocuments(documentQuery)} isDark={isDark} />
            ) : (
              <MemorySourceExplorer items={documents} isDark={isDark} emptyMessage="No source documents yet." />
            )}
          </section>
        </div>
      )}
    </PanelPage>
  );
}

function ProfileSection({
  title,
  lines: profileLines,
  empty,
  isDark,
}: {
  title: string;
  lines: string[];
  empty: string;
  isDark: boolean;
}) {
  return (
    <section className={panelCardClass(isDark, "p-5")}>
      <h2 className={`text-sm font-semibold ${isDark ? "text-zinc-100" : "text-zinc-950"}`}>{title}</h2>
      {profileLines.length === 0 ? (
        <p className={`mt-3 text-sm ${isDark ? "text-zinc-500" : "text-zinc-500"}`}>{empty}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {profileLines.map((line, index) => (
            <li key={`${line}:${index}`} dir="auto" className={`rounded-xl px-3 py-2 text-sm leading-relaxed ${isDark ? "bg-white/5 text-zinc-300" : "bg-zinc-50 text-zinc-700"}`}>
              {line}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ErrorState({ message, onRetry, isDark }: { message: string; onRetry: () => void; isDark: boolean }) {
  return (
    <div role="alert" className={panelCardClass(isDark, "flex flex-wrap items-center justify-between gap-3 p-5")}>
      <p className="break-words text-sm text-rose-400">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className={`min-h-9 rounded-xl border px-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
          isDark ? "border-white/10 bg-white/5 text-zinc-300" : "border-zinc-200 bg-white text-zinc-700"
        }`}
      >
        Try again
      </button>
    </div>
  );
}
