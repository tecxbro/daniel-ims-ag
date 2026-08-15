export const DISPATCHER_TOOL_FAMILIES = [
  "coding",
  "spawn",
  "memory",
  "draft",
  "automation",
  "self",
] as const;

export type DispatcherToolFamily = (typeof DISPATCHER_TOOL_FAMILIES)[number];

export interface DispatcherToolScope {
  families: DispatcherToolFamily[];
  fallback: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionsAvailableIntegration(
  content: string,
  integrations: readonly string[],
): boolean {
  return integrations.some((integration) => {
    const words = integration
      .replace(/[_-]+/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2");
    return new RegExp(`\\b${escapeRegExp(words)}\\b`, "i").test(content);
  });
}

function isExplicitMemoryOperation(content: string): boolean {
  return (
    /\b(?:remember|retain|save) (?:that |this |these |my |the )?.+\b(?:for later|in (?:your )?memory|long[- ]term)\b/i.test(
      content,
    ) ||
    /^(?:please\s+)?remember\b/i.test(content) ||
    /\b(?:update|correct|change) (?:your |the )?(?:saved )?memor(?:y|ies)\b/i.test(
      content,
    ) ||
    /\bforget\b.*\b(?:saved|memory|memories|preference|fact|detail|image)\b/i.test(
      content,
    ) ||
    /\b(?:recall|search) (?:your |the )?(?:saved )?memor(?:y|ies)\b/i.test(
      content,
    ) ||
    /\b(?:what|which) (?:did|do) (?:we|you) (?:decide|agree|choose|call|name|save|remember)\b/i.test(
      content,
    ) ||
    /\bdo you remember\b/i.test(content)
  );
}

function isCodingRequest(content: string): boolean {
  const softwareObject =
    /\b(?:agent|app|application|backend|code|codebase|component|database|endpoint|frontend|function|landing page|migration|package|pull request|readme|repo(?:sitory)?|schema|script|site|test suite|tests?|webhook|website|worker)\b/i;
  const softwareAction =
    /\b(?:build|create|debug|deploy|draft|edit|fix|implement|migrate|optimi[sz]e|refactor|review|run|test|troubleshoot|update|write)\b/i;
  const technicalContext =
    /\b(?:typescript|javascript|python|rust|swift|react|vite|convex|github|git|npm|api endpoint|bug|compile|lint|stack trace|failing test|test failure|type error)\b/i;
  return (
    (softwareAction.test(content) || /^(?:please\s+)?code\b/i.test(content)) &&
    (softwareObject.test(content) || technicalContext.test(content))
  );
}

function isAutomationRequest(content: string): boolean {
  return (
    /\b(?:create|list|show|pause|resume|enable|disable|toggle|delete|remove|what|which)\b.*\bautomations?\b/i.test(
      content,
    ) ||
    /\bautomations?\b.*\b(?:running|active|paused|create|list|show|pause|resume|enable|disable|toggle|delete|remove)\b/i.test(
      content,
    ) ||
    /\b(?:remind me|recurring|repeats?|digest)\b/i.test(content) ||
    /\b(?:every|each)\s+(?:day|morning|afternoon|evening|night|weekday|weekend|week|month|hour|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(
      content,
    )
  );
}

function isDraftDecision(content: string): boolean {
  const normalized = content
    .trim()
    .replace(/[.!?]+$/g, "")
    .toLowerCase();
  return (
    /^(?:please\s+)?send it$/.test(normalized) ||
    /\b(?:pending|waiting|approve|approval|reject|cancel|discard|send|list|show)\b.*\bdrafts?\b/i.test(
      content,
    ) ||
    /\bdrafts?\b.*\b(?:pending|waiting|approve|approval|reject|cancel|discard|send|list|show)\b/i.test(
      content,
    )
  );
}

function isSelfRequest(content: string): boolean {
  return (
    /\b(?:your|daniel'?s|agent)\s+(?:config(?:uration)?|settings?|runtime|provider|model|reasoning|time ?zone|capabilit(?:y|ies)|tools?)\b/i.test(
      content,
    ) ||
    /\b(?:connected|available|active)\s+(?:integrations?|accounts?|toolkits?)\b/i.test(
      content,
    ) ||
    /\b(?:search|inspect|check|show|list)\b.*\b(?:integration|toolkit|composio|catalog)\b/i.test(
      content,
    )
  );
}

function isSpawnRequest(
  content: string,
  integrations: readonly string[],
): boolean {
  return (
    /https?:\/\/\S+/i.test(content) ||
    /\b(?:browse|google|look up|search (?:for|the web)|web search|open (?:the )?(?:url|link|page)|visit)\b/i.test(
      content,
    ) ||
    /\b(?:today|right now|currently|latest|newest)\b/i.test(content) ||
    /\b(?:current|currently|latest|newest|live|right now|today'?s)\b.*\b(?:price|score|status|weather|news|rate|result|schedule|availability|version)\b/i.test(
      content,
    ) ||
    /\b(?:weather|forecast)\b.*\b(?:today|tomorrow|this week|in )\b/i.test(
      content,
    ) ||
    /\b(?:inbox|unread email|my calendar|my drive|my files?|my account|my messages?)\b/i.test(
      content,
    ) ||
    /\b(?:email|message|upload|download|book|reserve|purchase|post)\b.*\b(?:my|the|this|that|to|from|on|for)\b/i.test(
      content,
    ) ||
    /\b(?:send|reply|forward|schedule|create|add|move|cancel|delete|update|book|reserve|post|upload|download)\b.*\b(?:email|message|event|meeting|appointment|calendar|file|document|reservation|booking|post)\b/i.test(
      content,
    ) ||
    mentionsAvailableIntegration(content, integrations)
  );
}

function needsAutomationConfig(content: string): boolean {
  return /\b(?:at\s+\d|a\.?m\.?|p\.?m\.?|morning|afternoon|evening|night|local time|time ?zone)\b/i.test(
    content,
  );
}

function isUncertainAction(content: string): boolean {
  const normalized = content.trim().replace(/[.!?]+$/g, "");
  return (
    /^(?:please\s+)?(?:do|handle|continue|proceed|finish|take care of|set up|make)\s+(?:it|this|that|the thing)\b/i.test(
      normalized,
    ) ||
    /^(?:please\s+)?help me(?: with)?(?: it| this| that)?$/i.test(normalized)
  );
}

/**
 * Selects only high-confidence tool families. Ambiguous action requests retain
 * the legacy full-tool behavior so routing never becomes a silent refusal.
 */
export function resolveDispatcherToolScope(
  content: string,
  integrations: readonly string[] = [],
): DispatcherToolScope {
  const families = new Set<DispatcherToolFamily>();

  if (isCodingRequest(content)) families.add("coding");
  if (isSpawnRequest(content, integrations)) families.add("spawn");
  if (isExplicitMemoryOperation(content)) families.add("memory");
  if (isDraftDecision(content)) families.add("draft");
  if (isAutomationRequest(content)) {
    families.add("automation");
    if (needsAutomationConfig(content)) families.add("self");
  }
  if (isSelfRequest(content)) families.add("self");

  if (families.size === 0 && isUncertainAction(content)) {
    return { families: [...DISPATCHER_TOOL_FAMILIES], fallback: true };
  }

  return {
    families: DISPATCHER_TOOL_FAMILIES.filter((family) => families.has(family)),
    fallback: false,
  };
}
