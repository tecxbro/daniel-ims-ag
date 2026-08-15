import {
  CODEX_MODEL_ALIASES,
  KNOWN_CODEX_MODELS,
  KNOWN_MODELS,
  MODEL_ALIASES,
  resolveReasoningEffortInput,
  resolveRuntimeInput,
} from "../runtime-config.js";
import type { RuntimeReasoningEffort } from "../runtimes/types.js";

function normalizeCommand(content: string): string {
  return content
    .trim()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ");
}

function commandPrefix(): string {
  return "(?:please |pls |can you )?";
}

function hasCompoundTail(content: string): boolean {
  return /;|\b(?:and|then)\b|,(?!\s*please$)/i.test(content);
}

export function runtimeLabel(runtime: "claude" | "codex"): string {
  return runtime === "codex" ? "Codex" : "Claude";
}

export function resolveDirectRuntimeSwitch(content: string): "claude" | "codex" | null {
  const normalized = normalizeCommand(content).toLowerCase();
  const match = normalized.match(
    /^(?:please |pls |can you )?(?:switch|change|set|use|move|flip)(?: me| daniel)?(?: (?:runtime|provider))?(?: back| over)?(?: to)? (?<runtime>claude agent sdk|chatgpt codex|anthropic|claude|codex|chatgpt)(?: runtime| provider)?(?: for (?:the )?next turn)?(?: please)?$/,
  );
  if (!match?.groups?.runtime) return null;
  return resolveRuntimeInput(match.groups.runtime);
}

const MODEL_INPUTS = [
  ...KNOWN_MODELS,
  ...Object.keys(MODEL_ALIASES),
  ...KNOWN_CODEX_MODELS,
  ...Object.keys(CODEX_MODEL_ALIASES),
].sort((a, b) => b.length - a.length);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MODEL_INPUT_PATTERN = MODEL_INPUTS.map(escapeRegExp).join("|");
const DIRECT_MODEL_PATTERN = new RegExp(
  `^${commandPrefix()}(?:switch|change|set|use)(?: me| daniel)?(?: (?:the|my|your))?(?: model(?: override)?(?: to| as)?| to)? (?:(?:claude|codex) )?(?<model>${MODEL_INPUT_PATTERN})(?: model)?(?: for (?:the )?next turn)?(?: please)?$`,
  "i",
);
const EXPLICIT_MODEL_PATTERN = new RegExp(
  `^${commandPrefix()}(?:switch|change|set)(?: me| daniel)?(?: (?:the|my|your))? model(?: override)?(?: to| as)? (?<model>.+?)(?: for (?:the )?next turn)?(?: please)?$`,
  "i",
);

/** Returns the requested model token only for a complete, explicit command. */
export function resolveDirectModelSwitch(content: string): string | null {
  const normalized = normalizeCommand(content);
  if (hasCompoundTail(normalized)) return null;
  const match =
    normalized.match(DIRECT_MODEL_PATTERN) ??
    normalized.match(EXPLICIT_MODEL_PATTERN);
  return match?.groups?.model?.trim() || null;
}

export function resolveDirectTimezoneSwitch(content: string): string | null {
  const normalized = normalizeCommand(content);
  if (hasCompoundTail(normalized)) return null;
  const command = normalized.match(
    new RegExp(
      `^${commandPrefix()}(?:switch|change|set)(?: me| daniel)?(?: (?:the|my|your))? time ?zone(?: to| as)? (?<timezone>.+?)(?: please)?$`,
      "i",
    ),
  );
  if (command?.groups?.timezone) return command.groups.timezone.trim();

  const useTime = normalized.match(
    new RegExp(
      `^${commandPrefix()}use (?<timezone>.+?)(?: as (?:my|the) time ?zone|(?= please$)|$)(?: please)?$`,
      "i",
    ),
  );
  if (useTime?.groups?.timezone) {
    const timezone = useTime.groups.timezone.trim();
    if (
      /(?:\btime$|\/|^(?:utc|gmt|et|est|edt|ct|cst|cdt|mt|mst|mdt|pt|pst|pdt|bst|cet|jst|ist)$)/i.test(
        timezone,
      ) ||
      /\bas (?:my|the) time ?zone\b/i.test(normalized)
    ) {
      return timezone;
    }
  }

  const location = normalized.match(
    /^(?:i am|i'm|i live|i'm based|i am based) in (?<timezone>[\p{L} ._+\-/]+)$/iu,
  );
  return location?.groups?.timezone?.trim() || null;
}

export function resolveDirectReasoningEffortSwitch(
  content: string,
): RuntimeReasoningEffort | null {
  const normalized = normalizeCommand(content).toLowerCase();
  if (hasCompoundTail(normalized)) return null;
  const match = normalized.match(
    /^(?:please |pls |can you )?(?:set|change|use|make)(?: the| my| your)?(?: codex)? reasoning(?: effort| level)?(?: to| as)? (?<effort>minimal|low|medium|high|xhigh)(?: for codex)?(?: please)?$/,
  );
  return match?.groups?.effort
    ? resolveReasoningEffortInput(match.groups.effort)
    : null;
}

export type SimpleSelfConfigurationRequest =
  | "config"
  | "integrations"
  | "model"
  | "runtime"
  | "time"
  | "timezone";

/**
 * Matches only self-contained configuration reads. Requests whose answer needs
 * conversation context or an external capability remain with the dispatcher.
 */
export function resolveSimpleSelfConfigurationRequest(
  content: string,
): SimpleSelfConfigurationRequest | null {
  const normalized = normalizeCommand(content).toLowerCase();
  if (
    /^(?:what|which)(?:'s| is| are)? (?:your|the|my)? ?(?:current |active )?(?:runtime|provider)(?: are you using| is active| is configured| right now)?$/.test(
      normalized,
    )
  ) {
    return "runtime";
  }
  if (
    /^(?:what|which)(?:'s| is)? (?:your|the)? ?(?:current |active )?model(?: are you using| is active| is configured| right now)?$/.test(
      normalized,
    )
  ) {
    return "model";
  }
  if (
    /^(?:what|which)(?:'s| is)? (?:my|your|the)? ?(?:current |active |saved )?time ?zone(?: are you using| is active| is configured| right now)?$/.test(
      normalized,
    )
  ) {
    return "timezone";
  }
  if (/^(?:what time is it|what(?:'s| is) (?:my|your|the) (?:local )?time)(?: right now)?$/.test(normalized)) {
    return "time";
  }
  if (
    /^(?:show|tell|give)(?: me)? (?:your|the)? ?(?:current )?(?:config|configuration|runtime config|runtime configuration)$/.test(
      normalized,
    ) ||
    /^(?:what(?:'s| is) (?:your|the) (?:current )?(?:config|configuration|setup))$/.test(
      normalized,
    )
  ) {
    return "config";
  }
  if (
    /^(?:what|which|list|show)(?: are| me)? (?:my|the)? ?(?:connected |active )?(?:integrations|accounts|tools)(?: and accounts)?(?: are connected| do i have connected)?(?: right now)?$/.test(
      normalized,
    )
  ) {
    return "integrations";
  }
  return null;
}

export function proactiveNoticeReply(content: string): string {
  const stripped = content.replace(/^\s*\[proactive notice\]\s*/i, "").trim();
  return stripped || "You have a new proactive notice.";
}

export function explicitlyRequestsBrowser(content: string): boolean {
  const normalized = content.toLowerCase().replace(/\s+/g, " ");
  if (
    /\b(?:don'?t|do not|never|without) (?:use |open |launch |spawn )?(?:the )?(?:local )?(?:browser|chrome)\b/.test(
      normalized,
    ) ||
    /^(?:what|which|is|are|how|why)\b.*\b(?:patchright|browser integration|local browser|local chrome)\b/.test(
      normalized.trim(),
    )
  ) {
    return false;
  }
  const directBrowserIntent =
    /\blocal browser\b/.test(normalized) ||
    /\blocal chrome\b/.test(normalized) ||
    /\bpatchright\b/.test(normalized) ||
    /\bbrowser integration\b/.test(normalized) ||
    /\bchrome instance\b/.test(normalized) ||
    /\bbrowser instance\b/.test(normalized) ||
    /\bchrome on (?:my|your|the user'?s) machine\b/.test(normalized) ||
    /\bbrowser on (?:my|your|the user'?s) machine\b/.test(normalized) ||
    /\bspawn (?:a |the )?(?:chrome|browser)\b/.test(normalized);
  const antiNative =
    /\b(?:not|without|don'?t use|do not use) composio\b/.test(normalized) ||
    /\b(?:not|without|don'?t use|do not use) (?:the )?(?:native |api )?integrations?\b/.test(
      normalized,
    );
  const browserMention = /\b(?:browser|chrome)\b/.test(normalized);
  const actionIntent =
    /\b(?:browse|check|click|go to|launch|look up|navigate|open|run|search|spawn|use|visit)\b/.test(
      normalized,
    );
  return (directBrowserIntent && actionIntent) ||
    (antiNative && browserMention && actionIntent);
}

export function resolveSpawnIntegrations(
  requested: string[],
  available: string[],
  content: string,
): string[] {
  if (available.includes("browser") && explicitlyRequestsBrowser(content)) {
    return ["browser"];
  }
  return requested;
}
