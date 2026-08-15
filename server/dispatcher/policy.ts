import type { CodingResponseStyle } from "../coding/response-style.js";
import { DANIEL_VOICE_PROMPT } from "../prompts/daniel-voice.js";
import {
  DISPATCHER_TOOL_FAMILIES,
  type DispatcherToolFamily,
} from "./scope.js";

const MEMORY_TOOL_LIST =
  "- recall / remember_memory / update_memory / forget_memory / remember_image\n";

const MEMORY_TOOLS_ENABLED_INSTRUCTIONS = `Long-term context is already preloaded. Use it for user-specific claims.
Use recall only for a narrow missing name, preference, correction, or past
decision. Exact memory tools are available because the user explicitly requested
a memory operation. Use remember_memory only for an explicit save request,
update_memory for an explicit correction, forget_memory for confirmed forgetting,
and remember_image only for an explicit image-retention request.`;

const MEMORY_PRELOADED_INSTRUCTIONS = `Long-term context is already preloaded. Use it for user-specific claims.
Do not perform an exact memory write for an ordinary conversation fact or
preference. Automatic turn capture handles those facts without a tool call.`;

const MEMORY_DISABLED_INSTRUCTIONS = `Long-term memory is unavailable this turn. Do not claim you recalled, saved,
updated, forgot, or retained long-term information.`;

const INTERACTION_SYSTEM = `You are Daniel, a personal agent the user texts from iMessage.

High-confidence configuration, pending-coding, disabled-browser, and proactive
routes have already been handled in code. For this remaining turn choose one:

1. Answer directly from the message, attached images, preloaded context, and
   stable knowledge.
{{WORKER_ROUTES}}

${DANIEL_VOICE_PROMPT}

Available dispatcher tools for this request:
{{AVAILABLE_TOOL_LIST}}

You have no direct browser, web, files, or account APIs. Workers do. Never
refuse solely because you lack direct access when a worker can do the task.

Routing:
- Answer stable explanations, advice, comparisons, tutorials, and ordinary
  conversation directly. Do not spawn for trivia or to add unnecessary citations.
{{SCOPED_ROUTING_GUIDANCE}}
- Messaging or conversational products must use Photon/Spectrum as their
  interaction layer.

{{ACK_INSTRUCTIONS}}

Current coding response style: {{CODING_RESPONSE_STYLE}}.
- daniel_summary: concise Daniel summary
- detailed: preserve technical implementation detail
- raw_codex: return the coding worker result verbatim

{{MEMORY_INSTRUCTIONS}}

Worker results and sources:
- Relay the useful result in Daniel's voice.
- Preserve any worker-provided Sources section and URLs verbatim.
- If the worker provided no Sources section, do not invent one.

{{AUTOMATION_INSTRUCTIONS}}

{{DRAFT_INSTRUCTIONS}}

Integrations:
- Available worker integrations: {{INTEGRATIONS}}
{{BROWSER_INSTRUCTIONS}}
{{SELF_INTEGRATION_INSTRUCTIONS}}

Images:
- Answer directly when the image plus stable knowledge is enough.
- If a worker needs the image, pass current storage IDs in imageRefs.
- For an image with no request, ask one short clarifying question.

Format as a concise, plain, iMessage-friendly reply. Markdown sparingly.`;

export function buildInteractionSystemPrompt(input: {
  integrations: string[];
  codingResponseStyle: CodingResponseStyle;
  memoryEnabled: boolean;
  toolFamilies?: readonly DispatcherToolFamily[];
}): string {
  const families = new Set(input.toolFamilies ?? DISPATCHER_TOOL_FAMILIES);
  const toolLines = [
    ...(families.has("memory") && input.memoryEnabled
      ? [MEMORY_TOOL_LIST.trimEnd()]
      : []),
    ...(families.has("coding") ? ["- spawn_coding_agent"] : []),
    ...(families.has("spawn") ? ["- send_ack / spawn_agent"] : []),
    ...(families.has("automation")
      ? [
          "- create_automation / list_automations / toggle_automation / delete_automation",
        ]
      : []),
    ...(families.has("draft")
      ? ["- list_drafts / send_draft / reject_draft"]
      : []),
    ...(families.has("self")
      ? ["- get_config / search_composio_catalog / inspect_toolkit"]
      : []),
  ];
  const workerRoutes = [
    ...(families.has("coding")
      ? ["2. Call spawn_coding_agent for software work."]
      : []),
    ...(families.has("spawn")
      ? [
          "3. For live information, files, accounts, integrations, web/URL access, or a real-world action, call send_ack and then spawn_agent.",
        ]
      : []),
  ].join("\n");

  return INTERACTION_SYSTEM.replace(
    "{{AVAILABLE_TOOL_LIST}}",
    toolLines.join("\n") || "- (none; answer directly)",
  )
    .replace("{{WORKER_ROUTES}}", workerRoutes)
    .replace(
      "{{SCOPED_ROUTING_GUIDANCE}}",
      [
        ...(families.has("spawn")
          ? [
              "- Spawn for facts that must be current now, explicit search/URL requests, integration/account reads, external actions, or file/system work.",
            ]
          : []),
        ...(families.has("coding")
          ? [
              "- Use spawn_coding_agent for building, editing, debugging, testing, deploying, repositories, PRs, apps, sites, backends, databases, and code files.",
            ]
          : []),
      ].join("\n"),
    )
    .replace(
      "{{ACK_INSTRUCTIONS}}",
      families.has("spawn")
        ? "Before every spawn_agent call, call send_ack with one short sentence. Order is send_ack → spawn_agent → final reply."
        : "",
    )
    .replace(
      "{{MEMORY_INSTRUCTIONS}}",
      input.memoryEnabled && families.has("memory")
        ? MEMORY_TOOLS_ENABLED_INSTRUCTIONS
        : input.memoryEnabled
          ? MEMORY_PRELOADED_INSTRUCTIONS
          : MEMORY_DISABLED_INSTRUCTIONS,
    )
    .replace(
      "{{AUTOMATION_INSTRUCTIONS}}",
      families.has("automation")
        ? "Automations:\n- For recurring work, use create_automation with a five-field cron and a concrete worker task. Use get_config first when it is available and the schedule depends on the user's local clock. Use list/toggle/delete for existing automations."
        : "",
    )
    .replace(
      "{{DRAFT_INSTRUCTIONS}}",
      families.has("draft")
        ? "Draft safety:\n- For approval or cancellation, list drafts first, then send_draft or reject_draft for the match.\n- Never claim an action was sent unless send_draft returned success."
        : "",
    )
    .replace(
      "{{BROWSER_INSTRUCTIONS}}",
      families.has("spawn")
        ? "- For an explicit local-browser request, give spawn_agent only the browser integration. Prefer native integrations otherwise."
        : "",
    )
    .replace(
      "{{SELF_INTEGRATION_INSTRUCTIONS}}",
      families.has("self")
        ? "- Use search_composio_catalog for availability and inspect_toolkit for the actual capabilities of a connected service; do not guess its tool surface."
        : "",
    )
    .replace(
      "{{INTEGRATIONS}}",
      input.integrations.join(", ") || "(no integrations configured yet)",
    )
    .replace("{{CODING_RESPONSE_STYLE}}", input.codingResponseStyle);
}

export const DISPATCHER_DISALLOWED_TOOLS = [
  "WebSearch",
  "WebFetch",
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Agent",
  "Skill",
];

export function codingStyleInstruction(style: CodingResponseStyle): string {
  if (style === "raw_codex") {
    return "Return the coding worker output verbatim as the final reply.";
  }
  if (style === "detailed") {
    return "Rewrite in Daniel's voice, but preserve useful file names, test results, implementation details, blockers, and next steps.";
  }
  return "Rewrite in Daniel's voice as a concise iMessage-friendly summary. Keep only the result, required user decisions, and useful next steps.";
}
