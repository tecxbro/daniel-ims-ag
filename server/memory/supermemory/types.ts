export type MemoryProviderMode = "convex" | "shadow" | "dual" | "supermemory";

export type MemoryReadMode = Extract<MemoryProviderMode, "convex" | "shadow" | "supermemory">;
export type MemoryWriteMode = Extract<MemoryProviderMode, "convex" | "dual" | "supermemory">;

export type MemoryProviderName = "convex" | "supermemory";

export type ProviderMetadataValue = string | number | boolean | string[];
export type ProviderMetadata = Record<string, ProviderMetadataValue>;

export interface MemoryOwnerContext {
  memoryOwnerId: string;
  ownerKey: string;
  containerTag: string;
  conversationId: string;
  conversationKey: string;
  customId: string;
  saltFingerprint: string;
}

/**
 * Shared target shape for turn handlers. The owner and conversation remain
 * distinct even when today's direct-message transport derives both from the
 * same phone number.
 */
export interface HandleOpts {
  conversationId: string;
  memoryOwnerId: string;
  content: string;
  /** Caller-supplied when post-delivery capture must share the persisted turn. */
  turnId?: string;
}

export interface MemorySearchResult {
  id: string;
  content: string;
  kind: "memory" | "chunk";
  similarity: number;
  metadata: Record<string, unknown> | null;
  updatedAt?: string;
  version?: number | null;
}

export interface MemoryHydrationResult {
  provider: "supermemory";
  profile: {
    static: string[];
    dynamic: string[];
  };
  results: MemorySearchResult[];
  latencyMs: number;
}

export interface MemorySyncPayload {
  turnId: string;
  owner: MemoryOwnerContext;
  content: string;
  metadata?: ProviderMetadata;
  taskType?: "memory" | "superrag";
}

export interface MemoryProviderHealth {
  provider: "supermemory";
  configured: boolean;
  readMode: MemoryReadMode;
  writeMode: MemoryWriteMode;
  status: "disabled" | "unconfigured" | "healthy" | "degraded" | "unavailable";
  checkedAt: number;
  latencyMs?: number;
  error?: string;
}

export interface ProfileInput {
  containerTag: string;
  q?: string;
  threshold?: number;
}

export interface SearchInput {
  containerTag: string;
  q: string;
  threshold?: number;
  limit?: number;
  searchMode?: "memories" | "hybrid" | "documents";
}

export interface CaptureTurnInput {
  content: string;
  containerTag: string;
  customId: string;
  entityContext?: string;
  metadata?: ProviderMetadata;
  taskType?: "memory" | "superrag";
}

export interface ExactMemory {
  content: string;
  isStatic?: boolean;
  metadata?: ProviderMetadata;
  forgetAfter?: string;
  forgetReason?: string;
}

export interface CreateExactMemoryInput {
  containerTag: string;
  memories: ExactMemory[];
}

export interface UpdateMemoryInput {
  containerTag: string;
  newContent: string;
  id?: string;
  content?: string;
  metadata?: ProviderMetadata;
  forgetAfter?: string | null;
  forgetReason?: string | null;
}

export interface ForgetMemoryInput {
  containerTag: string;
  id?: string;
  content?: string;
  reason?: string;
}

export interface ProviderDocumentResult {
  id: string;
  status: string;
}

export interface ProviderDocumentSummary {
  id: string;
  status: string;
  customId?: string | null;
  title?: string | null;
  summary?: string | null;
  type?: string;
  metadata: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ProviderDocumentPage {
  documents: ProviderDocumentSummary[];
  page: number;
  totalItems: number;
  totalPages: number;
}

export interface ListDocumentsInput {
  containerTag: string;
  page?: number;
  limit?: number;
}

export interface MemoryVersionHistoryItem {
  id: string;
  content: string;
  version: number;
  createdAt?: string;
  updatedAt?: string;
  parentMemoryId: string | null;
  rootMemoryId: string | null;
  isLatest: boolean;
  isForgotten: boolean;
}

export interface ProviderMemoryEntry extends MemoryVersionHistoryItem {
  isStatic: boolean;
  isInference: boolean;
  sourceCount: number;
  forgetAfter: string | null;
  forgetReason: string | null;
  metadata: Record<string, unknown> | null;
  history: MemoryVersionHistoryItem[];
  documentIds: string[];
}

export interface ProviderMemoryEntryPage {
  entries: ProviderMemoryEntry[];
  page: number;
  limit: number;
  totalItems: number;
  totalPages: number;
}

export interface ListMemoryEntriesInput {
  containerTag: string;
  page?: number;
  limit?: number;
  order?: "asc" | "desc";
  sort?: "createdAt" | "updatedAt";
}

export interface ProviderMemoryResult {
  id: string;
  content: string;
  isStatic?: boolean;
  createdAt?: string;
  metadata?: Record<string, unknown> | null;
  version?: number;
  parentMemoryId?: string | null;
  rootMemoryId?: string | null;
  forgetAfter?: string | null;
  forgetReason?: string | null;
}

export interface DanielMemoryProvider {
  profile(input: ProfileInput): Promise<MemoryHydrationResult>;
  search(input: SearchInput): Promise<MemorySearchResult[]>;
  listDocuments(input: ListDocumentsInput): Promise<ProviderDocumentPage>;
  listMemories?(input: ListMemoryEntriesInput): Promise<ProviderMemoryEntryPage>;
  captureTurn(input: CaptureTurnInput): Promise<ProviderDocumentResult>;
  createExact(input: CreateExactMemoryInput): Promise<ProviderMemoryResult[]>;
  update(input: UpdateMemoryInput): Promise<ProviderMemoryResult>;
  forget(input: ForgetMemoryInput): Promise<void>;
}

export interface MemoryProviderConfiguration {
  readMode: MemoryReadMode;
  writeMode: MemoryWriteMode;
  timeoutMs: number;
  threshold: number;
  searchLimit: number;
  dreaming: string;
  historyBackfillDays: number;
  legacyFallback: boolean;
  apiKeyConfigured: boolean;
}
