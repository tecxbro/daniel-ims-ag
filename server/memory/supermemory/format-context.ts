import type { MemorySearchResult } from "./types.js";

export const MEMORY_CONTEXT_MAX_CHARS = 8_000;
export const MEMORY_SEARCH_RESULT_LIMIT = 8;

const OPEN_TAG = "<daniel_memory_context>";
const CLOSE_TAG = "</daniel_memory_context>";
const ELLIPSIS = "\u2026";

export interface MemoryContextInput {
  profile: {
    static: readonly string[];
    dynamic: readonly string[];
  };
  results: readonly MemorySearchResult[];
}

interface ContextSection {
  heading: string;
  lines: string[];
}

/** Remove characters and structures that could escape the prompt section. */
function sanitizeText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  // The adapter already extracts provider fields. Refuse object-shaped strings
  // as a second guard against accidentally placing a raw response in a prompt.
  if (/^[{[]/.test(trimmed)) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null) return "";
    } catch {
      // This is ordinary text that happens to begin with punctuation.
    }
  }

  return trimmed
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/^(?:[-*\u2022]+|\d+[.)])\s*/, "")
    .replace(
      /\b(SUPERMEMORY_API_KEY|DANIEL_MEMORY_ID_SALT)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1=[redacted]",
    )
    .replace(
      /\b(authorization|api[-_ ]?key|access[-_ ]?token|secret|password)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1=[redacted]",
    )
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|sm_[A-Za-z0-9_-]{8,})\b/g, "[redacted]")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .trim();
}

function factKey(value: string): string {
  return value
    .replace(/&(?:amp|lt|gt);/g, " ")
    .toLocaleLowerCase("en-US")
    .replace(/^(?:the\s+)?user(?:'s)?\s+/, "")
    .replace(/[\p{P}\s]+/gu, " ")
    .trim();
}

function isForgotten(result: MemorySearchResult): boolean {
  const metadata = result.metadata;
  if (!metadata) return false;
  if (metadata.forgotten === true || metadata.isForgotten === true) return true;
  return typeof metadata.status === "string" &&
    ["forgotten", "deleted", "expired"].includes(metadata.status.toLowerCase());
}

function lineageKey(result: MemorySearchResult): string {
  const metadata = result.metadata;
  const rootId = metadata?.rootMemoryId ?? metadata?.root_memory_id;
  return typeof rootId === "string" && rootId ? `root:${rootId}` : `id:${result.id}`;
}

function timestamp(value: string | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/** A negative return value puts `left` before `right`. */
function compareResults(left: MemorySearchResult, right: MemorySearchResult): number {
  const similarityDifference = right.similarity - left.similarity;
  if (Number.isFinite(similarityDifference) && similarityDifference !== 0) {
    return similarityDifference;
  }

  const versionDifference = (right.version ?? -1) - (left.version ?? -1);
  if (versionDifference !== 0) return versionDifference;

  const updatedDifference = timestamp(right.updatedAt) - timestamp(left.updatedAt);
  if (Number.isFinite(updatedDifference) && updatedDifference !== 0) return updatedDifference;

  const idDifference = left.id.localeCompare(right.id, "en-US");
  if (idDifference !== 0) return idDifference;
  return left.content.localeCompare(right.content, "en-US");
}

function isNewer(left: MemorySearchResult, right: MemorySearchResult): boolean {
  const leftVersion = left.version ?? -1;
  const rightVersion = right.version ?? -1;
  if (leftVersion !== rightVersion) return leftVersion > rightVersion;

  const leftUpdatedAt = timestamp(left.updatedAt);
  const rightUpdatedAt = timestamp(right.updatedAt);
  if (leftUpdatedAt !== rightUpdatedAt) return leftUpdatedAt > rightUpdatedAt;

  if (left.similarity !== right.similarity) return left.similarity > right.similarity;
  return compareResults(left, right) < 0;
}

function currentResults(results: readonly MemorySearchResult[]): MemorySearchResult[] {
  const byLineage = new Map<string, MemorySearchResult>();
  for (const result of results) {
    if (isForgotten(result)) continue;
    const key = lineageKey(result);
    const current = byLineage.get(key);
    if (!current || isNewer(result, current)) byLineage.set(key, result);
  }
  return [...byLineage.values()].sort(compareResults);
}

function usefulSource(result: MemorySearchResult): string | undefined {
  const metadata = result.metadata;
  if (!metadata) return undefined;
  const candidate = metadata.source ?? metadata.sourceType ?? metadata.source_type ?? metadata.channel;
  if (typeof candidate !== "string" || candidate.length > 80) return undefined;
  const source = sanitizeText(candidate);
  return source && !/[{}[\]]/.test(source) ? source : undefined;
}

function resultSuffix(result: MemorySearchResult): string {
  const metadata: string[] = [];
  if (Number.isFinite(result.similarity) && result.similarity >= 0 && result.similarity <= 1) {
    metadata.push(`similarity: ${result.similarity.toFixed(2)}`);
  }
  const source = usefulSource(result);
  if (source) metadata.push(`source: ${source}`);
  return metadata.length ? ` [${metadata.join("; ")}]` : "";
}

function collectProfileLines(
  values: readonly string[],
  seen: Set<string>,
): string[] {
  const lines: string[] = [];
  for (const value of values) {
    const line = sanitizeText(value);
    const key = factKey(line);
    if (!line || !key || seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
  }
  return lines;
}

function collectResultLines(
  results: readonly MemorySearchResult[],
  seen: Set<string>,
): string[] {
  const lines: string[] = [];
  for (const result of currentResults(results)) {
    const content = sanitizeText(result.content);
    const key = factKey(content);
    if (!content || !key || seen.has(key)) continue;
    seen.add(key);
    lines.push(`${content}${resultSuffix(result)}`);
    if (lines.length === MEMORY_SEARCH_RESULT_LIMIT) break;
  }
  return lines;
}

function sliceWithoutBrokenSurrogate(value: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  let sliced = value.slice(0, maxLength);
  const finalCodeUnit = sliced.charCodeAt(sliced.length - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) sliced = sliced.slice(0, -1);
  return sliced;
}

function renderWithinLimit(sections: readonly ContextSection[]): string {
  const tokens: string[] = [OPEN_TAG];
  for (const section of sections) {
    tokens.push(section.heading);
    for (const line of section.lines) tokens.push(`- ${line}`);
  }

  const closingCost = 1 + CLOSE_TAG.length;
  const output: string[] = [];
  let used = 0;
  for (const token of tokens) {
    const separatorCost = output.length ? 1 : 0;
    const available = MEMORY_CONTEXT_MAX_CHARS - closingCost - used - separatorCost;
    if (available <= 0) break;
    if (token.length <= available) {
      output.push(token);
      used += separatorCost + token.length;
      continue;
    }

    // Only fact lines can realistically exceed the cap. Keep the XML wrapper,
    // the bullet marker, and an explicit truncation indicator intact.
    if (token.startsWith("- ") && available > 2 + ELLIPSIS.length) {
      output.push(`${sliceWithoutBrokenSurrogate(token, available - ELLIPSIS.length)}${ELLIPSIS}`);
    }
    break;
  }

  return `${output.join("\n")}\n${CLOSE_TAG}`;
}

/**
 * Format adapter-normalized profile and recall data for eventual prompt use.
 * Empty provider data deliberately produces no prompt text; operational code
 * records the distinction between an empty profile and a failed request.
 */
export function formatMemoryContext(input: MemoryContextInput): string {
  const seen = new Set<string>();
  const stable = collectProfileLines(input.profile.static, seen);
  const recent = collectProfileLines(input.profile.dynamic, seen);
  const relevant = collectResultLines(input.results, seen);

  if (stable.length === 0 && recent.length === 0 && relevant.length === 0) return "";

  return renderWithinLimit([
    { heading: "Stable user profile:", lines: stable },
    { heading: "Recent user context:", lines: recent },
    { heading: "Relevant past memories:", lines: relevant },
  ]);
}
