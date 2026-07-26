import { z } from "zod";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { createMemoryTools } from "./memory/tools.js";
import { extractAndStore } from "./memory/extract.js";
import { spawnExecutionAgent } from "./execution-agent.js";
import {
  continueCodingAgentWithAnswer,
  spawnCodingAgent,
  type ContinueCodingAgentResult,
  type SpawnCodingAgentResult,
} from "./coding-agent.js";
import { listEnabledIntegrations } from "./integrations/registry.js";
import { createAutomationTools } from "./automation-tools.js";
import { createDraftDecisionTools } from "./draft-tools.js";
import { createSelfTools } from "./self-tools.js";
import {
  getRuntimeConfig,
  resolveRuntimeInput,
  setRuntimeProvider,
  type RuntimeConfig,
} from "./runtime-config.js";
import { broadcast } from "./broadcast.js";
import { sendImessage } from "./imessage.js";
import { defineRuntimeTool } from "./runtimes/tool.js";
import { runAgentRuntime } from "./runtimes/index.js";
import { runtimeText } from "./runtimes/types.js";
import { EMPTY_USAGE, type UsageTotals } from "./usage.js";
import {
  buildPromptWithImagesOrTextFallback,
  fetchStoredBytes,
} from "./images/content-blocks.js";
import { DANIEL_VOICE_PROMPT } from "./prompts/daniel-voice.js";
import {
  CODING_RESPONSE_STYLE_KEY,
  DEFAULT_CODING_RESPONSE_STYLE,
  resolveCodingResponseStyle,
  type CodingResponseStyle,
} from "./coding/response-style.js";

const INTERACTION_SYSTEM = `You are Daniel, a personal agent the user texts from iMessage.

You are a DISPATCHER, not a doer. Your job:
1. Understand what the user wants.
2. Decide: answer directly (quick facts, chit-chat, anything you already know), spawn_agent (normal work that needs tools like email, calendar, web, etc.), OR spawn_coding_agent (software work).
3. When you spawn, give the agent a crisp, specific task — not the raw user message.
4. When the agent returns, relay the result in YOUR voice, tightened for iMessage.

${DANIEL_VOICE_PROMPT}

Your only tools:
- recall / write_memory (durable memory for this user)
- spawn_agent (dispatches a sub-agent that CAN touch the world)
- spawn_coding_agent (dispatches Daniel's full Codex coding bridge)
- create_automation / list_automations / toggle_automation / delete_automation
- list_drafts / send_draft / reject_draft
- get_config / set_runtime / set_model / set_codex_reasoning_effort / set_timezone / list_integrations / search_composio_catalog / inspect_toolkit (self-inspection)

You cannot answer factual questions from your own knowledge. Not allowed.
You have NO browser, NO WebSearch, NO WebFetch, NO file access, NO APIs.
You are not allowed to recite facts about places, events, people, prices,
news, URLs, statistics, or anything "in the world." Your training data does
not count as a source.

Hard rule: if the user asks for information, research, a lookup, a
recommendation that requires real-world data, a current event, a comparison,
a tutorial, a how-to, any URL, or anything you'd be tempted to "just know" —
spawn_agent. No exceptions. Even if you're 99% sure. The sub-agent has
WebSearch/WebFetch and will return real citations; you don't and won't.
Never tell the user you cannot help because you lack browser, web, file, or
API access. That lack of access is the signal to call send_ack, then
spawn_agent. Refusing or suggesting the user use another tool is a failure
unless the spawned agent already tried and could not complete the task.

Coding route:
For anything code-related, call spawn_coding_agent instead of spawn_agent.
This includes building apps, creating apps, editing code, debugging errors,
generating files, connecting repos, running tests, deploying, opening PRs,
creating landing pages, building backends, setting up databases, and building
Photon/Spectrum/iMessage agents. Daniel is marketed as a coding agent; route
software work to the coding bridge even if the normal execution agent might
have a related integration.

For conversational apps, agents, reminders, onboarding, notifications, or
messaging products, the coding bridge must use Photon/Spectrum as the
interaction layer. Do not route those to generic integrations.

Acknowledgment rule (iMessage UX):
BEFORE every spawn_agent call, you MUST call send_ack first with a short
1-sentence message. The user otherwise sees nothing for 10-30 seconds while
the sub-agent works. Examples of good acks:
  "On it — one sec."
  "Checking your calendar."
  "Drafting that email now."
  "Checking Slack."
Order: send_ack → spawn_agent → (wait) → final reply with the result.
For spawn_coding_agent, do not send noisy progress acks by default. The coding
agent is a worker; its output is raw technical material, not automatically the
user-facing answer.
Current coding response style: {{CODING_RESPONSE_STYLE}}.
- daniel_summary: rewrite coding worker output into a concise Daniel reply.
- detailed: keep Daniel's voice, but include more technical implementation detail.
- raw_codex: return the coding worker output verbatim.
Skip the ack ONLY for things you'll answer in under 2 seconds (chit-chat,
simple memory recall, single automation toggle).

Memory — recall is MANDATORY before any claim about the user:
Your context does NOT auto-load saved memories. You must call recall()
explicitly. Conversation history is NOT memory — anything older than the
last few turns is gone, and even visible history may not be saved.

Hard rule: BEFORE making ANY statement about the user — names, contacts,
phone numbers, addresses, schedule, preferences, projects, history, who
they know, what they're working on — you MUST call recall() first.

This applies to NEGATIVE claims TOO. Saying "I don't have a phone number
for Alex" without first calling recall() is a CRITICAL FAILURE: that fact
might be in memory and you'd be lying to the user. If you're about to say
"I don't have X stored" or "I don't know that" about something user-
specific, STOP and call recall() first.

Recall is cheap. Overuse is correct. Underuse is a bug. Multiple recalls
per turn are fine and encouraged — different segments, different angles.

write_memory() — call aggressively for durable facts. Err on the side of
saving. If the user reveals anything personal, factual, or preferential,
write it down in the same turn.

Safe to answer directly without recall (a SHORT list):
- Greetings, acknowledgments, conversational filler ("thanks", "lol", "ok").
- Explaining what you just did, confirming a draft, relaying a sub-agent.
- Clarifying your own abilities or asking the user a clarifying question.
- Anything in the same conversation turn the user JUST told you (echo
  back is fine; persistent facts still need write_memory).

Everything else about the user — SPAWN or RECALL FIRST.

Never fabricate URLs, site names, "sources", statistics, news, quotes, prices,
dates, or any external fact. "Sources: [vague site names]" is fabrication.

When relaying a sub-agent's answer:
- Pass through the Sources section the sub-agent included, VERBATIM. Don't
  add, remove, paraphrase, or summarize URLs.
- If the sub-agent did NOT include a Sources section, YOU DO NOT ADD ONE.
  Do not write "Sources: Lonely Planet, etc." No exceptions.
- You may tighten the body for iMessage (shorter bullets, fewer emojis),
  but the URLs are ground truth — don't touch them.

Automations:
When the user wants something to happen on a recurring schedule — daily,
weekly, before/after some recurring event, anything that should fire more
than once — use create_automation with a 5-field cron expression and a
concrete task description for the sub-agent. Don't just promise to
remember and do it later; if there's a schedule, there's a cron.

When the user wants to inspect, change, pause, resume, or remove
automations they've already set up, use list_automations /
toggle_automation / delete_automation. Route by intent — the user may
phrase it as "what's running", "kill the morning thing", "pause that
weekly digest", etc.

Drafts:
External actions (email, calendar event, Slack message, etc.) go through a
draft flow — execution agents SAVE drafts; only send_draft actually commits.

When the user signals they want a previously-prepared action to go through —
ANY phrasing — call list_drafts to see what's pending, then send_draft on
the matching ones. The intent ("execute the thing we just talked about") is
what matters; don't try to match specific words. If a message could either
be a confirm OR a fresh request, and there are pending drafts in this
conversation, check list_drafts FIRST — the user almost always means
"finalize what we already drafted," not "start a new one."

When the user signals they want to back out (cancel, scrap it, different
version, never mind, etc.), call reject_draft.

Never claim something was sent unless send_draft returned success.

Integration capabilities — IMPORTANT:
You only know integration NAMES, not their actual tool surface. Composio's
toolkits don't always expose the tools you'd expect from the brand (e.g. the
LinkedIn toolkit has no inbox/DM tools). If the user asks what you can do
with a specific integration, spawn_agent against it — the sub-agent has
COMPOSIO_SEARCH_TOOLS and will return the real tool list. Never describe
integration capabilities from training-data knowledge of the product.

Local browser fallback:
The optional "browser" integration is a local Patchright Chrome profile. It is
available only when the user has enabled Local browser use in Settings. Force
["browser"] only for explicit local-browser intent: "local browser", "local
Chrome", "Patchright", "browser integration", "Chrome instance", or a
browser/Chrome request combined with "not Composio" / "not native integration".
If "browser" is not available, tell the user to turn on Local browser use in
Settings. Otherwise, prefer native integrations when they fit. Use browser for
login-only services, sites with no native toolkit, visual workflows, JS-heavy
apps, or sites that are likely to detect bots. If the user must log in, the
sub-agent can open a visible Chrome handoff window with browser_request_login.

Self-inspection (no spawn needed — answer instantly):
When the user asks about Daniel itself, pick the tool by intent:
- Wants to know what model / config / time is currently in effect → get_config
- Wants to switch providers/runtimes (Claude vs Codex) → set_runtime
- Wants to switch models or change speed/quality tradeoff → set_model
  (takes effect next turn; this turn finishes on the current model)
- Wants to tune Codex depth/speed specifically → set_codex_reasoning_effort
- Wants to know which integrations or accounts are connected → list_integrations
- Wondering whether some service is connectable at all → search_composio_catalog
- Probing the actual capabilities of a specific connected integration
  (does Slack expose DMs? does Notion let me create databases?) → inspect_toolkit
- Telling Daniel where they are or what timezone they want → set_timezone
  (accepts IANA IDs or natural names like "central time" or city names)

These are cheap and synchronous — no ack required. The user's phrasing
will vary; route by what they're trying to accomplish, not by keyword
matching.

Time / timezone:
The user has a saved timezone in get_config.userTimezone. Whenever your reply
or a sub-agent's task depends on local time (deadlines, "today", "9am
tomorrow", RSVP windows, scheduling, "in N hours"), call get_config first to
read it. If userTimezone is null, the system is currently using
timezoneFallback (the server's local zone, which may be wrong) — ASK the
user once ("what timezone are you in?") and call set_timezone with their
answer. Don't silently guess from city names mentioned in passing — confirm
before saving.

Available integrations for spawn_agent: {{INTEGRATIONS}}

Images:
When the user texts a photo or screenshot, you'll see it directly as
input — treat it as part of the message. Describe it, answer questions
about it, or extract info from it the same way you'd handle text. Answer
directly only when the request can be satisfied from the message and image
alone. If satisfying the request requires any external source, current
information, integration action, file/system access, or verification beyond
what you can see in the image, call spawn_agent and pass the relevant storage
IDs to its imageRefs parameter so the sub-agent can see the image too. If the
user sends a photo with no caption, ask a short clarifying question rather
than guessing what they want.

Format: Plain iMessage-friendly text. Markdown sparingly. Keep replies under ~400 chars when you can.`;

interface HandleOpts {
  conversationId: string;
  content: string;
  turnTag?: string;
  onThinking?: (chunk: string) => void;
  // "proactive" persists the inbound message with role=system instead of
  // role=user, so the synthetic notice the IA receives doesn't pollute the
  // user-message history. Defaults to "user".
  kind?: "user" | "proactive";
  // The iMessage/proactive callers persist the delivered final message after
  // transport succeeds. Local chat callers still need the assistant turn in
  // Convex so conversation views reflect the full exchange.
  persistAssistantReply?: boolean;
  images?: Array<{ storageId: string; mediaType: string }>;
  mediaError?: string;
}

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function runtimeLabel(runtime: "claude" | "codex"): string {
  return runtime === "codex" ? "Codex" : "Claude";
}

export function resolveDirectRuntimeSwitch(content: string): "claude" | "codex" | null {
  const normalized = content
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ");
  const match = normalized.match(
    /^(?:please |pls |can you )?(?:switch|change|set|use|move|flip)(?: me| daniel)?(?: (?:runtime|provider))?(?: back| over)?(?: to)? (?<runtime>claude agent sdk|chatgpt codex|anthropic|claude|codex|chatgpt)(?: runtime| provider)?(?: for (?:the )?next turn)?(?: please)?$/,
  );
  if (!match?.groups?.runtime) return null;
  return resolveRuntimeInput(match.groups.runtime);
}

export function resolveSpawnImageRefs(
  requestedRefs: string[] | undefined,
  inboundImageStorageIds: string[],
): string[] | undefined {
  if (inboundImageStorageIds.length === 0) return undefined;
  const selected = requestedRefs?.filter((id) =>
    inboundImageStorageIds.includes(id),
  );
  return selected && selected.length > 0 ? selected : inboundImageStorageIds;
}

function explicitlyRequestsBrowser(content: string): boolean {
  const normalized = content.toLowerCase().replace(/\s+/g, " ");
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
  return directBrowserIntent || (antiNative && browserMention);
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

const DISPATCHER_DISALLOWED_TOOLS = [
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

async function resolveCodingResponseStyleForTurn(
  conversationId: string,
  content: string,
): Promise<CodingResponseStyle> {
  let storedValue: string | null = null;
  try {
    const stored = await convex.query(api.codingPreferences.getPreference, {
      conversationId,
      key: CODING_RESPONSE_STYLE_KEY,
    });
    storedValue = typeof stored?.value === "string" ? stored.value : null;
  } catch (err) {
    console.warn("[interaction] coding response style lookup failed", err);
  }

  const resolved = resolveCodingResponseStyle({ storedValue, content });
  if (resolved.durableUpdate) {
    try {
      await convex.mutation(api.codingPreferences.storePreference, {
        conversationId,
        key: CODING_RESPONSE_STYLE_KEY,
        value: resolved.durableUpdate,
      });
    } catch (err) {
      console.warn("[interaction] coding response style store failed", err);
    }
  }
  return resolved.style;
}

function codingStyleInstruction(style: CodingResponseStyle): string {
  if (style === "raw_codex") {
    return "Return the coding worker output verbatim as the final reply.";
  }
  if (style === "detailed") {
    return "Rewrite in Daniel's voice, but preserve useful file names, test results, implementation details, blockers, and next steps.";
  }
  return "Rewrite in Daniel's voice as a concise iMessage-friendly summary. Keep only the result, required user decisions, and useful next steps.";
}

function formatCodingToolResult(
  result: SpawnCodingAgentResult,
  style: CodingResponseStyle,
): string {
  return [
    `[coding ${result.projectId} ${result.status}]`,
    codingStyleInstruction(style),
    "",
    result.result,
  ].join("\n");
}

function codingWorkerReplySystem(style: CodingResponseStyle): string {
  return `You are Daniel, rewriting output from Daniel's coding worker for the user.

${DANIEL_VOICE_PROMPT}

The coding worker output is raw technical material. Compose the user-facing reply in Daniel's voice.
${codingStyleInstruction(style)}
If the worker is asking for a decision, preserve the question and numbered choices clearly.
If the worker failed, be direct about the failure and include the useful error detail.
Return only the final user-facing message.`;
}

function codingWorkerReplyPrompt(args: {
  userMessage: string;
  codingResult: ContinueCodingAgentResult | SpawnCodingAgentResult;
  style: CodingResponseStyle;
}): string {
  return [
    `User message: ${args.userMessage}`,
    `Coding status: ${args.codingResult.status}`,
    `Coding response style: ${args.style}`,
    "",
    "Coding worker output:",
    args.codingResult.result,
  ].join("\n");
}

function fallbackCodingReply(
  result: ContinueCodingAgentResult | SpawnCodingAgentResult,
): string {
  if (result.status === "waiting_for_user") return result.result.trim();
  if (result.status === "failed") {
    const detail = result.result.trim().split(/\r?\n/).find(Boolean);
    return detail ? `I hit an error on that coding run: ${detail}` : "I hit an error on that coding run.";
  }
  return "Done — the coding run finished.";
}

async function composeCodingWorkerReply(args: {
  runtimeConfig: RuntimeConfig;
  conversationId: string;
  turnId: string;
  turnStart: number;
  userMessage: string;
  codingResult: ContinueCodingAgentResult | SpawnCodingAgentResult;
  style: CodingResponseStyle;
  log: (msg: string) => void;
}): Promise<string> {
  if (args.style === "raw_codex") return args.codingResult.result.trim();

  try {
    const result = await runAgentRuntime(args.runtimeConfig, {
      prompt: codingWorkerReplyPrompt({
        userMessage: args.userMessage,
        codingResult: args.codingResult,
        style: args.style,
      }),
      systemPrompt: codingWorkerReplySystem(args.style),
      tools: [],
      mode: "dispatcher",
      allowedTools: [],
      disallowedTools: DISPATCHER_DISALLOWED_TOOLS,
    });
    await recordDispatcherUsage({
      conversationId: args.conversationId,
      turnId: args.turnId,
      runtimeConfig: args.runtimeConfig,
      usage: result.usage,
      durationMs: Date.now() - args.turnStart,
      log: args.log,
    });
    return result.text.trim() || fallbackCodingReply(args.codingResult);
  } catch (err) {
    console.error("[interaction] coding reply composition failed", err);
    return fallbackCodingReply(args.codingResult);
  }
}

async function recordDispatcherUsage(args: {
  conversationId: string;
  turnId: string;
  runtimeConfig: RuntimeConfig;
  usage: UsageTotals;
  durationMs: number;
  log: (msg: string) => void;
}): Promise<void> {
  if (args.usage.costUsd === 0 && args.usage.inputTokens === 0) return;
  args.log(
    `cost: in/out ${args.usage.inputTokens}/${args.usage.outputTokens}, cache r/w ${args.usage.cacheReadTokens}/${args.usage.cacheCreationTokens}, $${args.usage.costUsd.toFixed(4)}`,
  );
  await convex.mutation(api.usageRecords.record, {
    source: "dispatcher",
    conversationId: args.conversationId,
    turnId: args.turnId,
    runtime: args.runtimeConfig.runtime,
    billingMode: args.runtimeConfig.billingMode,
    model: args.usage.model,
    inputTokens: args.usage.inputTokens,
    outputTokens: args.usage.outputTokens,
    cacheReadTokens: args.usage.cacheReadTokens,
    cacheCreationTokens: args.usage.cacheCreationTokens,
    costUsd: args.usage.costUsd,
    durationMs: args.durationMs,
  });
}

export async function handleUserMessage(opts: HandleOpts): Promise<string> {
  const turnId = randomId("turn");
  const integrations = (await listEnabledIntegrations()).map((i) => i.name);

  const inboundRole = opts.kind === "proactive" ? "system" : "user";
  const inboundImageStorageIds = (opts.images ?? []).map((i) => i.storageId);
  await convex.mutation(api.messages.send, {
    conversationId: opts.conversationId,
    role: inboundRole,
    content: opts.content,
    turnId,
    // TODO(codegen): drop cast once schema push regenerates Convex API.
    imageStorageIds: inboundImageStorageIds.length > 0
      ? (inboundImageStorageIds as never)
      : undefined,
    mediaError: opts.mediaError,
  });
  broadcast(opts.kind === "proactive" ? "proactive_notice" : "user_message", {
    conversationId: opts.conversationId,
    content: opts.content,
  });

  const history =
    opts.kind === "proactive"
      ? []
      : await convex.query(api.messages.recent, {
          conversationId: opts.conversationId,
          limit: 10,
        });
  const historyBlock = history
    .slice(0, -1)
    .map((m: any) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n");

  const userText = opts.mediaError
    ? `[user sent images but they couldn't be downloaded: ${opts.mediaError}]\n${opts.content}`
    : opts.content;
  const promptText =
    opts.kind === "proactive"
      ? `Standalone proactive notice. Write a concise user-facing iMessage from this notice only. Do not research, spawn agents, or continue any prior conversation.\n\n${userText}`
      : historyBlock
        ? `Prior turns:\n${historyBlock}\n\nCurrent message:\n${userText}`
        : userText;

  const tag = opts.turnTag ?? turnId.slice(-6);
  const log = (msg: string) => console.log(`[turn ${tag}] ${msg}`);
  const turnStart = Date.now();
  // Snapshot runtime for this top-level turn so same-turn set_runtime/set_model
  // changes do not split the dispatcher and any spawned execution agent.
  const runtimeConfig = await getRuntimeConfig();
  const codingResponseStyle =
    opts.kind === "proactive"
      ? DEFAULT_CODING_RESPONSE_STYLE
      : await resolveCodingResponseStyleForTurn(opts.conversationId, opts.content);
  const systemPrompt = INTERACTION_SYSTEM.replace(
    "{{INTEGRATIONS}}",
    integrations.join(", ") || "(no integrations configured yet)",
  ).replace("{{CODING_RESPONSE_STYLE}}", codingResponseStyle);

  if (opts.kind !== "proactive") {
    const codingResult = await continueCodingAgentWithAnswer({
      conversationId: opts.conversationId,
      content: opts.content,
    });
    if (codingResult !== null) {
      log("coding pending input handled");
      const codingReply = await composeCodingWorkerReply({
        runtimeConfig,
        conversationId: opts.conversationId,
        turnId,
        turnStart,
        userMessage: opts.content,
        codingResult,
        style: codingResponseStyle,
        log,
      });
      broadcast("assistant_message", {
        conversationId: opts.conversationId,
        content: codingReply,
      });
      if (opts.persistAssistantReply) {
        await convex.mutation(api.messages.send, {
          conversationId: opts.conversationId,
          role: "assistant",
          content: codingReply,
          turnId,
        });
      }
      return codingReply;
    }
  }

  const directRuntimeSwitch =
    opts.kind === "proactive" ? null : resolveDirectRuntimeSwitch(opts.content);
  if (directRuntimeSwitch) {
    await setRuntimeProvider(directRuntimeSwitch);
    const nextConfig = await getRuntimeConfig();
    const label = runtimeLabel(directRuntimeSwitch);
    const reply =
      runtimeConfig.runtime === directRuntimeSwitch
        ? `Already on ${label}. Next turn will use ${nextConfig.model}.`
        : `Switched to ${label}. Next turn will use ${nextConfig.model}.`;
    log(`runtime switch: ${runtimeConfig.runtime} -> ${directRuntimeSwitch}`);
    broadcast("assistant_message", { conversationId: opts.conversationId, content: reply });
    if (opts.persistAssistantReply) {
      await convex.mutation(api.messages.send, {
        conversationId: opts.conversationId,
        role: "assistant",
        content: reply,
        turnId,
      });
    }
    return reply;
  }

  if (
    opts.kind !== "proactive" &&
    explicitlyRequestsBrowser(opts.content) &&
    !integrations.includes("browser")
  ) {
    const reply =
      "Local browser use is off right now. Turn it on in Settings → Local browser use, then resend this and I can use Chrome on your machine.";
    log("browser requested but disabled");
    broadcast("assistant_message", { conversationId: opts.conversationId, content: reply });
    if (opts.persistAssistantReply) {
      await convex.mutation(api.messages.send, {
        conversationId: opts.conversationId,
        role: "assistant",
        content: reply,
        turnId,
      });
    }
    return reply;
  }

  const sendAck = async (message: string): Promise<void> => {
    const text = message.trim();
    if (!text) return;
    if (opts.conversationId.startsWith("sms:") && opts.kind !== "proactive") {
      const number = opts.conversationId.slice(4);
      await sendImessage(number, text);
    }
    await convex.mutation(api.messages.send, {
      conversationId: opts.conversationId,
      role: "assistant",
      content: text,
      turnId,
    });
    broadcast("assistant_ack", {
      conversationId: opts.conversationId,
      content: text,
    });
    log(`→ ack: ${text}`);
  };

  const promptBuild =
    opts.kind === "proactive"
      ? { prompt: promptText, imageStorageIds: [] }
      : await buildPromptWithImagesOrTextFallback({
          text: promptText,
          imageStorageIds: inboundImageStorageIds,
          fetchBytes: fetchStoredBytes,
        });
  if (promptBuild.imageError) {
    log(`image fetch fallback: ${promptBuild.imageError}`);
  }
  const spawnableImageStorageIds = promptBuild.imageStorageIds;
  const lastCodingResult: { current: SpawnCodingAgentResult | null } = { current: null };

  const tools = [
    ...createMemoryTools(opts.conversationId),
    ...createAutomationTools(opts.conversationId),
    ...createDraftDecisionTools(opts.conversationId, runtimeConfig),
    ...createSelfTools(),
    defineRuntimeTool(
      "daniel-ack",
      "send_ack",
      `Send a short acknowledgment message to the user IMMEDIATELY, before a slow operation. Use this BEFORE spawn_agent so the user knows you heard them and are working on it. Keep it to ONE short sentence (ideally under 60 chars) with tone that matches the task. Examples: "On it — one sec.", "Checking now.", "Drafting that.", "Let me check your calendar."`,
      {
        message: z
          .string()
          .describe(
            "1 short sentence ack. No markdown. Emojis only if the user used emojis recently.",
          ),
      },
      async (args) => {
        const text = args.message.trim();
        if (!text) return runtimeText("Empty ack skipped.");
        await sendAck(text);
        return runtimeText("Ack sent to user.");
      },
    ),
    defineRuntimeTool(
      "daniel-coding",
      "spawn_coding_agent",
      "Spawn Daniel's full Codex coding bridge for software work: build apps, edit/debug code, generate files, connect repos, run tests, deploy, create PRs, build landing pages/backends/databases, or build Photon/Spectrum/iMessage agents. Do not use for normal non-coding personal-assistant tasks.",
      {
        task: z
          .string()
          .describe("Specific coding task to plan, build, edit, debug, test, or deploy."),
        projectHint: z
          .string()
          .optional()
          .describe("Short project/app name if the user provided one."),
        repoUrl: z
          .string()
          .optional()
          .describe("Git repository URL to clone or continue from, if provided."),
        mode: z
          .enum(["auto", "plan", "build", "debug"])
          .optional()
          .describe("auto is default. Use plan for new apps/major features, debug for bug fixes, build for small direct edits."),
        attachments: z
          .array(z.string())
          .optional()
          .describe("Attachment identifiers or names relevant to the coding task."),
      },
      async (args) => {
        const res = await spawnCodingAgent({
          task: args.task,
          conversationId: opts.conversationId,
          projectHint: args.projectHint,
          repoUrl: args.repoUrl,
          mode: args.mode ?? "auto",
          runtimeConfig,
        });
        lastCodingResult.current = res;
        return runtimeText(formatCodingToolResult(res, codingResponseStyle));
      },
    ),
    defineRuntimeTool(
      "daniel-spawn",
      "spawn_agent",
      "Spawn a focused sub-agent to do real work using external tools. Returns the agent's final answer. Use whenever the user's request needs external sources, current information, integrations, file/system access, or verification beyond the visible message context. If the current user message includes images and the sub-agent's task depends on them, pass the relevant storage IDs in imageRefs. On image turns, Daniel attaches all current-turn images by default; a non-empty imageRefs list can narrow to a subset.",
      {
        task: z
          .string()
          .describe("Crisp task description — what to find/draft/do, not the raw user message."),
        integrations: z
          .array(z.string())
          .describe(`Which integrations to give the agent. Available: ${integrations.join(", ") || "(none)"}`),
        name: z.string().optional().describe("Short label for the agent."),
        imageRefs: z
          .array(z.string())
          .optional()
          .describe(
            "Convex storage IDs from the user's current message. Available in this turn: " +
              (spawnableImageStorageIds.length > 0
                ? spawnableImageStorageIds.join(", ")
                : "(none)"),
          ),
      },
      async (args) => {
        const imageStorageIds = resolveSpawnImageRefs(
          args.imageRefs,
          spawnableImageStorageIds,
        );
        const selectedIntegrations = resolveSpawnIntegrations(
          args.integrations,
          integrations,
          opts.content,
        ).filter((name) => integrations.includes(name));
        const browserForced =
          selectedIntegrations.length === 1 &&
          selectedIntegrations[0] === "browser" &&
          !args.integrations.includes("browser");
        if (browserForced) {
          log(
            `forcing browser integration for explicit browser request (model requested: ${args.integrations.join(",") || "none"})`,
          );
        }
        const res = await spawnExecutionAgent({
          task: args.task,
          integrations: selectedIntegrations,
          conversationId: opts.conversationId,
          name: args.name,
          runtimeConfig,
          imageStorageIds,
        });
        return runtimeText(`[agent ${res.agentId} ${res.status}]\n\n${res.result}`);
      },
    ),
  ];
  let reply = "";
  let usage: UsageTotals = { ...EMPTY_USAGE };
  try {
    const result = await runAgentRuntime(runtimeConfig, {
      prompt: promptBuild.prompt,
      systemPrompt,
      tools,
      mode: "dispatcher",
      allowedTools:
        opts.kind === "proactive"
          ? []
          : [
              "mcp__daniel-memory__write_memory",
              "mcp__daniel-memory__recall",
              "mcp__daniel-spawn__spawn_agent",
              "mcp__daniel-coding__spawn_coding_agent",
              "mcp__daniel-automations__create_automation",
              "mcp__daniel-automations__list_automations",
              "mcp__daniel-automations__toggle_automation",
              "mcp__daniel-automations__delete_automation",
              "mcp__daniel-draft-decisions__list_drafts",
              "mcp__daniel-draft-decisions__send_draft",
              "mcp__daniel-draft-decisions__reject_draft",
              "mcp__daniel-ack__send_ack",
              "mcp__daniel-self__get_config",
              "mcp__daniel-self__set_runtime",
              "mcp__daniel-self__set_model",
              "mcp__daniel-self__set_codex_reasoning_effort",
              "mcp__daniel-self__set_timezone",
              "mcp__daniel-self__list_integrations",
              "mcp__daniel-self__search_composio_catalog",
              "mcp__daniel-self__inspect_toolkit",
            ],
      // Belt-and-suspenders: even with bypassPermissions the SDK can leak
      // its built-ins if we only whitelist. Explicitly block them on the
      // dispatcher so it MUST spawn a sub-agent for external work.
      disallowedTools: DISPATCHER_DISALLOWED_TOOLS,
      onText: (chunk) => opts.onThinking?.(chunk),
      onToolUse: (toolName, input) => {
        const name = toolName.replace(/^mcp__daniel-[a-z-]+__/, "");
        const inputPreview = JSON.stringify(input);
        log(
          `tool: ${name}(${inputPreview.length > 90 ? inputPreview.slice(0, 90) + "…" : inputPreview})`,
        );
      },
    });
    reply = result.text;
    usage = result.usage;
  } catch (err) {
    console.error(`[turn ${tag}] query failed`, err);
    reply = "Sorry — I hit an error processing that. Try again in a moment.";
  }
  if (codingResponseStyle === "raw_codex" && lastCodingResult.current) {
    reply = lastCodingResult.current.result;
  }

  // Sometimes the model produces a placeholder string like "(no output)" or
  // "(no reply)" instead of composing a real reply — usually after a tool
  // call cycle where it lost the thread of what to say. Treat those as
  // empty so the user gets a real fallback they can act on.
  reply = reply.trim();
  // Match "(no output)" / "no reply." / "(No Response)" etc. Parens are
  // matched as a balanced pair (or omitted) — alternation prevents `(no
  // output` or `no output)` with one stray paren from sneaking through.
  const placeholder =
    /^(?:\(\s*no (?:output|reply|response|content)\s*\)|no (?:output|reply|response|content))\.?$/i;
  if (!reply || placeholder.test(reply)) {
    console.warn(`[turn ${tag}] empty/placeholder reply (${JSON.stringify(reply)}) — using fallback`);
    // Frame as model-side hiccup, not user error — the placeholder fires
    // when the model loses the thread mid-tool-call, the user's phrasing
    // is fine.
    reply = "Hmm — got tangled up there. Want to try that again?";
  }

  await recordDispatcherUsage({
    conversationId: opts.conversationId,
    turnId,
    runtimeConfig,
    usage,
    durationMs: Date.now() - turnStart,
    log,
  });

  broadcast("assistant_message", { conversationId: opts.conversationId, content: reply });

  if (opts.persistAssistantReply) {
    await convex.mutation(api.messages.send, {
      conversationId: opts.conversationId,
      role: "assistant",
      content: reply,
      turnId,
    });
  }

  // Background extraction — fire-and-forget; don't block the reply.
  // Skip on proactive turns: the "user message" is a synthetic
  // [proactive notice] derived from email content, not something the user
  // said. Letting extractAndStore run on it would persist email-derived
  // facts ("Alice asked about Q4 report") as user preferences/memory — the
  // same store the classifier reads on the next event, creating a feedback
  // loop where surfaced emails reshape future classification.
  if (opts.kind !== "proactive") {
    extractAndStore({
      conversationId: opts.conversationId,
      userMessage: opts.content,
      assistantReply: reply,
      turnId,
      runtimeConfig,
      imageStorageIds: inboundImageStorageIds,
    }).catch((err) => console.error("[interaction] extraction error", err));
  }

  return reply;
}
