export type CodingResponseStyle = "daniel_summary" | "detailed" | "raw_codex";

export const DEFAULT_CODING_RESPONSE_STYLE: CodingResponseStyle = "daniel_summary";
export const CODING_RESPONSE_STYLE_KEY = "coding_response_style";

const VALID_STYLES = new Set<CodingResponseStyle>([
  "daniel_summary",
  "detailed",
  "raw_codex",
]);

const DURABLE_PATTERN =
  /\b(?:from now on|going forward|always|by default|default to|make (?:that|this|it)? ?(?:my )?default|prefer(?:red|ence)?|set (?:my )?(?:coding )?(?:reply |response )?style|remember (?:this|that))\b/i;

const RAW_PATTERNS = [
  /\braw\s+(?:codex|coding|worker|agent)\s+output\b/i,
  /\b(?:codex|coding worker|coding agent)\s+(?:raw|verbatim|unmodified)\s+output\b/i,
  /\bverbatim\s+(?:codex|coding|worker|agent)\b/i,
  /\bunmodified\s+(?:codex|coding|worker|agent)\b/i,
  /\bdon'?t\s+(?:rewrite|summarize|paraphrase)\s+(?:codex|coding|worker|agent)\b/i,
];

const DETAILED_PATTERNS = [
  /\bmore\s+(?:technical\s+)?detail(?:ed)?\b/i,
  /\bdetailed\s+(?:coding|technical|implementation)\s+(?:reply|replies|response|responses|summary|summaries)\b/i,
  /\btechnical\s+detail\b/i,
  /\binclude\s+more\s+(?:technical|implementation)\s+detail\b/i,
  /\bverbose\s+(?:coding|technical)\s+(?:reply|replies|response|responses)\b/i,
];

const DANIEL_SUMMARY_PATTERNS = [
  /\bdaniel[_ -]?summary\b/i,
  /\bsummary\s+in\s+daniel'?s?\s+voice\b/i,
  /\bconcise\s+daniel\s+(?:summary|voice|reply|replies)\b/i,
  /\bnormal\s+daniel\s+(?:summary|voice|reply|replies)\b/i,
  /\brewrite\s+coding\s+(?:output|results?|replies)\b/i,
  /\bnot\s+raw\s+codex\b/i,
];

export interface CodingResponseStyleParseResult {
  style: CodingResponseStyle | null;
  durableUpdate: CodingResponseStyle | null;
}

export interface CodingResponseStyleResolution {
  style: CodingResponseStyle;
  durableUpdate: CodingResponseStyle | null;
}

export function normalizeCodingResponseStyle(value: unknown): CodingResponseStyle {
  return typeof value === "string" && VALID_STYLES.has(value as CodingResponseStyle)
    ? (value as CodingResponseStyle)
    : DEFAULT_CODING_RESPONSE_STYLE;
}

export function parseCodingResponseStylePreference(
  content: string,
): CodingResponseStyleParseResult {
  const style = detectStyle(content);
  if (!style) return { style: null, durableUpdate: null };
  return {
    style,
    durableUpdate: DURABLE_PATTERN.test(content) ? style : null,
  };
}

export function resolveCodingResponseStyle(input: {
  storedValue?: string | null;
  content?: string | null;
}): CodingResponseStyleResolution {
  const storedStyle = normalizeCodingResponseStyle(input.storedValue);
  const parsed = input.content
    ? parseCodingResponseStylePreference(input.content)
    : { style: null, durableUpdate: null };
  return {
    style: parsed.style ?? storedStyle,
    durableUpdate: parsed.durableUpdate,
  };
}

function detectStyle(content: string): CodingResponseStyle | null {
  if (RAW_PATTERNS.some((pattern) => pattern.test(content))) return "raw_codex";
  if (DETAILED_PATTERNS.some((pattern) => pattern.test(content))) return "detailed";
  if (DANIEL_SUMMARY_PATTERNS.some((pattern) => pattern.test(content))) {
    return "daniel_summary";
  }
  return null;
}
