import { api } from "../../convex/_generated/api.js";
import { displayNameFor, listConnectedToolkits } from "../composio.js";
import { convex } from "../convex-client.js";
import {
  CODING_RESPONSE_STYLE_KEY,
  parseCodingResponseStylePreference,
  type CodingResponseStyle,
} from "../coding/response-style.js";
import { listEnabledIntegrations } from "../integrations/registry.js";
import {
  getBrowserSettings,
  getRuntimeConfig,
  resolveModelInput,
  setCodexReasoningEffort,
  setRuntimeModel,
  setRuntimeProvider,
} from "../runtime-config.js";
import {
  describeUserNow,
  resolveTimezoneInput,
  setUserTimezone,
} from "../timezone-config.js";
import {
  resolveDirectModelSwitch,
  resolveDirectReasoningEffortSwitch,
  resolveDirectRuntimeSwitch,
  resolveDirectTimezoneSwitch,
  resolveSimpleSelfConfigurationRequest,
  runtimeLabel,
  type SimpleSelfConfigurationRequest,
} from "./gates.js";

export type DeterministicConfigurationRoute =
  | "coding_response_style"
  | "model"
  | "reasoning_effort"
  | "runtime"
  | "self_config"
  | "timezone";

export interface DeterministicConfigurationResult {
  route: DeterministicConfigurationRoute;
  reply: string;
}

function codingStyleReply(style: CodingResponseStyle): string {
  switch (style) {
    case "raw_codex":
      return "Coding replies will use raw Codex output by default.";
    case "detailed":
      return "Coding replies will include detailed technical output by default.";
    case "daniel_summary":
      return "Coding replies will use concise Daniel summaries by default.";
  }
}

async function describeConnectedIntegrations(): Promise<string> {
  const connected = await listConnectedToolkits();
  if (connected.length === 0) {
    return "No integrations are connected right now. You can add one from Connections in Settings.";
  }
  const lines = connected.map((connection) => {
    const account =
      connection.accountLabel ??
      connection.accountEmail ??
      connection.accountName ??
      connection.alias;
    return `• ${displayNameFor(connection.slug)}${account ? ` — ${account}` : ""} (${connection.status.toLowerCase()})`;
  });
  return ["Connected integrations:", ...lines].join("\n");
}

async function describeSimpleConfiguration(
  request: SimpleSelfConfigurationRequest,
): Promise<string> {
  if (request === "integrations") return describeConnectedIntegrations();

  if (request === "time" || request === "timezone") {
    const timezone = await describeUserNow();
    if (request === "time") {
      return `It’s ${timezone.now} in ${timezone.timezone}.`;
    }
    return timezone.isExplicit
      ? `Your saved timezone is ${timezone.timezone}. Local time there is ${timezone.now}.`
      : `No timezone is saved yet. I’m falling back to ${timezone.timezone}, where it’s ${timezone.now}.`;
  }

  const runtime = await getRuntimeConfig();
  if (request === "runtime") {
    return `I’m using the ${runtimeLabel(runtime.runtime)} runtime (${runtime.billingMode}).`;
  }
  if (request === "model") {
    const effort = runtime.reasoningEffort
      ? ` with ${runtime.reasoningEffort} reasoning`
      : "";
    return `I’m using ${runtime.model} on ${runtimeLabel(runtime.runtime)}${effort}.`;
  }

  const [timezone, browser, integrations] = await Promise.all([
    describeUserNow(),
    getBrowserSettings(),
    listEnabledIntegrations(),
  ]);
  return [
    `Runtime: ${runtimeLabel(runtime.runtime)}`,
    `Model: ${runtime.model}${runtime.reasoningEffort ? ` (${runtime.reasoningEffort} reasoning)` : ""}`,
    `Billing: ${runtime.billingMode}`,
    `Timezone: ${timezone.timezone}${timezone.isExplicit ? "" : " (fallback)"}`,
    `Local time: ${timezone.now}`,
    `Local browser: ${browser.enabled ? "on" : "off"}`,
    `Available integrations: ${integrations.map((item) => item.name).join(", ") || "none"}`,
  ].join("\n");
}

/**
 * Executes only complete, high-confidence self-configuration messages. A null
 * result means the normal dispatcher should handle the turn.
 */
export async function handleDeterministicConfiguration(input: {
  conversationId: string;
  content: string;
}): Promise<DeterministicConfigurationResult | null> {
  const runtimeSwitch = resolveDirectRuntimeSwitch(input.content);
  if (runtimeSwitch) {
    const before = await getRuntimeConfig();
    await setRuntimeProvider(runtimeSwitch);
    const after = await getRuntimeConfig();
    const label = runtimeLabel(runtimeSwitch);
    return {
      route: "runtime",
      reply:
        before.runtime === runtimeSwitch
          ? `Already on ${label}. Next turn will use ${after.model}.`
          : `Switched to ${label}. Next turn will use ${after.model}.`,
    };
  }

  const modelInput = resolveDirectModelSwitch(input.content);
  if (modelInput) {
    const before = await getRuntimeConfig();
    const explicitRuntimeMatch = input.content.match(
      /\b(?<runtime>claude|codex)\s+(?:model\s+)?(?:opus|sonnet|haiku|mini|gpt[ -]?\d|\d)/i,
    );
    const targetRuntime =
      explicitRuntimeMatch?.groups?.runtime?.toLowerCase() === "codex"
        ? "codex"
        : explicitRuntimeMatch?.groups?.runtime?.toLowerCase() === "claude"
          ? "claude"
          : before.runtime;
    const model = resolveModelInput(modelInput, targetRuntime);
    if (!model) {
      return {
        route: "model",
        reply: `“${modelInput}” isn’t a recognized ${runtimeLabel(targetRuntime)} model.`,
      };
    }
    await setRuntimeModel(model, targetRuntime);
    if (targetRuntime !== before.runtime) {
      await setRuntimeProvider(targetRuntime);
    }
    return {
      route: "model",
      reply: targetRuntime !== before.runtime
        ? `Switched to ${runtimeLabel(targetRuntime)} with model ${model}. It takes effect next turn.`
        : before.model === model
          ? `Already using ${model} on ${runtimeLabel(before.runtime)}.`
          : `Switched the ${runtimeLabel(before.runtime)} model to ${model}. It takes effect next turn.`,
    };
  }

  const timezoneInput = resolveDirectTimezoneSwitch(input.content);
  if (timezoneInput) {
    const timezone = resolveTimezoneInput(timezoneInput);
    if (!timezone) {
      if (/^(?:i am|i'm|i live|i'm based|i am based) in\b/i.test(input.content.trim())) {
        return null;
      }
      return {
        route: "timezone",
        reply: `“${timezoneInput}” isn’t a recognized timezone. Try an IANA zone like America/Chicago or a name like Pacific, London, or Tokyo.`,
      };
    }
    await setUserTimezone(timezone);
    const now = await describeUserNow();
    return {
      route: "timezone",
      reply: `Timezone set to ${timezone}. Local time there is ${now.now}.`,
    };
  }

  const effort = resolveDirectReasoningEffortSwitch(input.content);
  if (effort) {
    await setCodexReasoningEffort(effort);
    return {
      route: "reasoning_effort",
      reply: `Codex reasoning effort set to ${effort}. It takes effect on the next Codex turn.`,
    };
  }

  const style = parseCodingResponseStylePreference(input.content);
  const compoundStyleRequest =
    /(?:[,;]|\b(?:and|then)\b).*\b(?:build|change|create|debug|deploy|edit|fix|implement|run|test|write)\b/i.test(
      input.content,
    );
  if (style.durableUpdate && !compoundStyleRequest) {
    await convex.mutation(api.codingPreferences.storePreference, {
      conversationId: input.conversationId,
      key: CODING_RESPONSE_STYLE_KEY,
      value: style.durableUpdate,
    });
    return {
      route: "coding_response_style",
      reply: codingStyleReply(style.durableUpdate),
    };
  }

  const selfRequest = resolveSimpleSelfConfigurationRequest(input.content);
  if (selfRequest) {
    return {
      route: "self_config",
      reply: await describeSimpleConfiguration(selfRequest),
    };
  }

  return null;
}
