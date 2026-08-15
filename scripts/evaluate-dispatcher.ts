import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { deflateSync } from "node:zlib";
import ts from "typescript";
import { z } from "zod";
import {
  DISPATCHER_EVALUATION_CATEGORIES,
  DISPATCHER_EVALUATION_CORPUS,
  type DispatcherEvaluationCase,
  type DispatcherEvaluationCategory,
  type DispatcherRoute,
  type DispatcherToolName,
} from "../evaluation/dispatcher-corpus.js";
import type { RuntimeConfig } from "../server/runtime-config.js";
import type {
  RuntimePrompt,
  RuntimeReasoningEffort,
  RuntimeTool,
  RuntimeToolResult,
} from "../server/runtimes/types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_INTEGRATIONS = [
  "gmail",
  "googlecalendar",
  "slack",
  "notion",
  "browser",
];
const DISPATCHER_ALLOWED_TOOLS = [
  "mcp__daniel-memory__remember_memory",
  "mcp__daniel-memory__recall",
  "mcp__daniel-memory__update_memory",
  "mcp__daniel-memory__forget_memory",
  "mcp__daniel-memory__remember_image",
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
  "mcp__daniel-self__search_composio_catalog",
  "mcp__daniel-self__inspect_toolkit",
] as const;
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
const PRODUCTION_TURN_SOURCE = readFileSync(
  new URL("../server/dispatcher/turn.ts", import.meta.url),
  "utf8",
);
const PRODUCTION_POLICY_SOURCE = readFileSync(
  new URL("../server/dispatcher/policy.ts", import.meta.url),
  "utf8",
);
const PRODUCTION_TOOLS_SOURCE = readFileSync(
  new URL("../server/dispatcher/tools.ts", import.meta.url),
  "utf8",
);

interface CliOptions {
  runtime?: "claude" | "codex";
  model?: string;
  reasoningEffort?: RuntimeReasoningEffort;
  caseIds: string[];
  categories: DispatcherEvaluationCategory[];
  repeat: number;
  timeoutMs: number;
  outputPath?: string;
  json: boolean;
  list: boolean;
  dryRun: boolean;
  strict: boolean;
  help: boolean;
}

interface ToolCallMeasurement {
  name: string;
  fullName: string;
  atMs: number;
}

interface DispatcherCaseResult {
  caseId: string;
  category: DispatcherEvaluationCategory;
  iteration: number;
  status: "ok" | "timeout" | "error";
  expectedRoute: DispatcherRoute;
  route: DispatcherRoute;
  toolsCalled: string[];
  toolCalls: ToolCallMeasurement[];
  inputTokens: number | null;
  outputTokens: number | null;
  acknowledgementTimeMs: number | null;
  firstResponseTimeMs: number | null;
  firstModelTextTimeMs: number | null;
  totalResponseTimeMs: number;
  routeMatched: boolean;
  toolExpectationMatched: boolean;
  acknowledgementMatched: boolean;
  pendingAnswerMatched: boolean | null;
  passed: boolean;
  violations: string[];
  error?: string;
}

interface DispatcherEvaluationReport {
  schemaVersion: 1;
  runId: string;
  generatedAt: string;
  runtime: string;
  model: string;
  reasoningEffort: RuntimeReasoningEffort | null;
  corpus: {
    totalCaseCount: number;
    selectedCaseCount: number;
    categoryCount: number;
    repeat: number;
  };
  metrics: {
    measurementCount: number;
    passedCount: number;
    errorCount: number;
    usageUnavailableCount: number;
    routeAccuracy: number;
    toolExpectationAccuracy: number;
    acknowledgementAccuracy: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    meanAcknowledgementTimeMs: number | null;
    p50FirstResponseTimeMs: number | null;
    p95FirstResponseTimeMs: number | null;
    p50FirstModelTextTimeMs: number | null;
    p95FirstModelTextTimeMs: number | null;
    p50TotalResponseTimeMs: number;
    p95TotalResponseTimeMs: number;
  };
  passed: boolean;
  results: DispatcherCaseResult[];
}

interface Harness {
  buildInteractionSystemPrompt: typeof import("../server/interaction-agent.js").buildInteractionSystemPrompt;
  composePreloadedMemoryPrompt: typeof import("../server/interaction-agent.js").composePreloadedMemoryPrompt;
  runAgentRuntime: typeof import("../server/runtimes/index.js").runAgentRuntime;
  createMemoryTools: typeof import("../server/memory/tools.js").createMemoryTools;
  createAutomationTools: typeof import("../server/automation-tools.js").createAutomationTools;
  createDraftDecisionTools: typeof import("../server/draft-tools.js").createDraftDecisionTools;
  createSelfTools: typeof import("../server/self-tools.js").createSelfTools;
  defineRuntimeTool: typeof import("../server/runtimes/tool.js").defineRuntimeTool;
  parsePendingInputAnswer: typeof import("../server/coding-agent.js").parsePendingInputAnswer;
  resolveSimpleSelfConfigurationRequest: typeof import("../server/dispatcher/gates.js").resolveSimpleSelfConfigurationRequest;
  resolveDispatcherToolScope: typeof import("../server/dispatcher/scope.js").resolveDispatcherToolScope;
  createDispatcherTools: typeof import("../server/dispatcher/tools.js").createDispatcherTools;
  dispatcherAllowedTools: typeof import("../server/dispatcher/tools.js").dispatcherAllowedTools;
}

function usage(): string {
  return `Dispatcher routing evaluation

Usage:
  npm run evaluate:dispatcher [options]

Options:
  --runtime claude|codex       Runtime override (default: DANIEL_RUNTIME or claude).
  --model <model>              Model override for the selected runtime.
  --reasoning-effort <level>   Codex effort: minimal, low, medium, high, xhigh.
  --case <id>                  Run one case; repeat to select more cases.
  --category <category>        Run one category; repeat to select more categories.
  --repeat <n>                 Measurements per selected case (default: 1).
  --timeout-ms <n>             Per-case timeout (default: ${DEFAULT_TIMEOUT_MS}).
  --output <path>              Write the schema-versioned JSON report to a file.
  --json                       Print the JSON report instead of the text summary.
  --list                       List corpus cases without calling a model.
  --dry-run                    Validate selection and tool expectations only.
  --strict                     Exit 1 when any model result misses an expectation.
  --help                       Show this help.

Safety and measurement semantics:
  The runner uses the production dispatcher system prompt and runtime adapter,
  but every dispatcher tool is replaced with an inert fixture handler. It does
  not call Convex, integrations, memory, drafts, automations, or workers.

  acknowledgementTimeMs is measured when the shadow send_ack handler runs.
  firstResponseTimeMs is the first user-visible response equivalent: the ack,
  or completion of the final reply when no ack is sent. firstModelTextTimeMs is
  provider text latency (debug thinking in production), and is not comparable
  to iMessage delivery. totalResponseTimeMs covers the full model run.
  Failed runs use null token fields when the provider emitted no usage record.

  Pending coding answers use the production answer parser and a canned code
  route; proactive notices are also measured without a model. Neither route
  resumes Codex, mutates production state, or calls the dispatcher model.
  Runtime/model defaults come from CLI/environment, not persisted settings.`;
}

function parsePositiveInteger(raw: string | undefined, flag: string): number {
  if (raw === undefined) throw new Error(`${flag} requires a value`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    caseIds: [],
    categories: [],
    repeat: 1,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    json: false,
    list: false,
    dryRun: false,
    strict: false,
    help: false,
  };
  const categories = new Set<string>(DISPATCHER_EVALUATION_CATEGORIES);
  const efforts = new Set<RuntimeReasoningEffort>([
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--runtime") {
      const value = argv[++index];
      if (value !== "claude" && value !== "codex") {
        throw new Error("--runtime must be claude or codex");
      }
      options.runtime = value;
    } else if (arg === "--model") {
      const value = argv[++index];
      if (!value?.trim()) throw new Error("--model requires a non-empty value");
      options.model = value.trim();
    } else if (arg === "--reasoning-effort") {
      const value = argv[++index] as RuntimeReasoningEffort | undefined;
      if (!value || !efforts.has(value)) {
        throw new Error(
          "--reasoning-effort must be minimal, low, medium, high, or xhigh",
        );
      }
      options.reasoningEffort = value;
    } else if (arg === "--case") {
      const value = argv[++index];
      if (!value?.trim()) throw new Error("--case requires a case ID");
      options.caseIds.push(value.trim());
    } else if (arg === "--category") {
      const value = argv[++index];
      if (!value || !categories.has(value)) {
        throw new Error(
          `--category must be one of: ${DISPATCHER_EVALUATION_CATEGORIES.join(", ")}`,
        );
      }
      options.categories.push(value as DispatcherEvaluationCategory);
    } else if (arg === "--repeat") {
      options.repeat = parsePositiveInteger(argv[++index], "--repeat");
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = parsePositiveInteger(argv[++index], "--timeout-ms");
    } else if (arg === "--output") {
      const value = argv[++index];
      if (!value?.trim()) throw new Error("--output requires a path");
      options.outputPath = value.trim();
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--list") {
      options.list = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--strict") {
      options.strict = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.repeat > 20) throw new Error("--repeat cannot exceed 20");
  if (options.timeoutMs < 1_000)
    throw new Error("--timeout-ms must be at least 1000");
  return options;
}

function validateCorpus(corpus: readonly DispatcherEvaluationCase[]): void {
  const ids = new Set<string>();
  const categories = new Set<DispatcherEvaluationCategory>();

  for (const evaluationCase of corpus) {
    if (!evaluationCase.id.trim())
      throw new Error("Corpus case ID must not be empty");
    if (ids.has(evaluationCase.id)) {
      throw new Error(`Duplicate corpus case ID: ${evaluationCase.id}`);
    }
    ids.add(evaluationCase.id);
    categories.add(evaluationCase.category);

    const hasImages = (evaluationCase.context?.images?.length ?? 0) > 0;
    if (!evaluationCase.message.trim() && !hasImages) {
      throw new Error(
        `Corpus case ${evaluationCase.id} has no message or image`,
      );
    }
    const pending = evaluationCase.context?.pendingCodingQuestion;
    if (evaluationCase.category === "pending_coding_question" && !pending) {
      throw new Error(
        `Corpus case ${evaluationCase.id} is missing pending coding state`,
      );
    }
    if (
      pending &&
      evaluationCase.expected.route !== "pending_coding_question"
    ) {
      throw new Error(
        `Corpus case ${evaluationCase.id} has pending state but the wrong route`,
      );
    }
    if (
      evaluationCase.context?.kind === "proactive" &&
      evaluationCase.expected.requiredTools.length > 0
    ) {
      throw new Error(
        `Proactive case ${evaluationCase.id} cannot require tools`,
      );
    }
    if (
      evaluationCase.expected.acknowledgement === "required" &&
      !evaluationCase.expected.requiredTools.includes("send_ack")
    ) {
      throw new Error(
        `Corpus case ${evaluationCase.id} requires an ack but not send_ack`,
      );
    }
  }

  const missingCategories = DISPATCHER_EVALUATION_CATEGORIES.filter(
    (category) => !categories.has(category),
  );
  if (missingCategories.length > 0) {
    throw new Error(
      `Dispatcher corpus is missing categories: ${missingCategories.join(", ")}`,
    );
  }
}

function validateProductionSourceContract(): void {
  const proactiveRoute = PRODUCTION_TURN_SOURCE.indexOf(
    'if (opts.kind === "proactive")',
  );
  const pendingCall = PRODUCTION_TURN_SOURCE.indexOf(
    "const codingResult = await continueCodingAgentWithAnswer",
  );
  const configurationRoute = PRODUCTION_TURN_SOURCE.indexOf(
    "const directConfiguration = await handleDeterministicConfiguration",
    pendingCall,
  );
  const normalPath = PRODUCTION_TURN_SOURCE.indexOf(
    "enabledIntegrations,",
    configurationRoute,
  );
  if (
    proactiveRoute < 0 ||
    pendingCall < 0 ||
    proactiveRoute > pendingCall ||
    configurationRoute < pendingCall ||
    normalPath < configurationRoute
  ) {
    throw new Error(
      "Production deterministic-route ordering changed; update dispatcher fixtures",
    );
  }

  const disallowedBlock = PRODUCTION_POLICY_SOURCE.match(
    /(?:const|export const) DISPATCHER_DISALLOWED_TOOLS = \[([\s\S]*?)\];/,
  )?.[1];
  if (!disallowedBlock) {
    throw new Error(
      "Production dispatcher disallowed-tool contract was not found",
    );
  }
  const productionDisallowed = [...disallowedBlock.matchAll(/"([^"]+)"/g)].map(
    (match) => match[1],
  );
  if (
    JSON.stringify(productionDisallowed) !==
    JSON.stringify(DISPATCHER_DISALLOWED_TOOLS)
  ) {
    throw new Error("Production dispatcher disallowed-tool contract drifted");
  }
}

function validateInlineToolContracts(tools: readonly RuntimeTool[]): void {
  const sourceFile = ts.createSourceFile(
    "dispatcher-tools.ts",
    PRODUCTION_TOOLS_SOURCE,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const production = new Map<
    string,
    { description: string; schemaKeys: string[] }
  >();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "defineRuntimeTool"
    ) {
      const [namespaceNode, nameNode, descriptionNode, schemaNode] =
        node.arguments;
      if (
        namespaceNode &&
        nameNode &&
        descriptionNode &&
        schemaNode &&
        ts.isStringLiteralLike(namespaceNode) &&
        ts.isStringLiteralLike(nameNode) &&
        ts.isStringLiteralLike(descriptionNode) &&
        ts.isObjectLiteralExpression(schemaNode)
      ) {
        const schemaKeys = schemaNode.properties.flatMap((property) => {
          if (!property.name) return [];
          if (
            ts.isIdentifier(property.name) ||
            ts.isStringLiteralLike(property.name)
          ) {
            return [property.name.text];
          }
          return [];
        });
        production.set(`${namespaceNode.text}:${nameNode.text}`, {
          description: descriptionNode.text,
          schemaKeys,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  for (const key of [
    "daniel-ack:send_ack",
    "daniel-coding:spawn_coding_agent",
    "daniel-spawn:spawn_agent",
  ]) {
    const expected = production.get(key);
    const [namespace, name] = key.split(":");
    const actual = tools.find(
      (tool) => tool.namespace === namespace && tool.name === name,
    );
    if (!expected || !actual) {
      throw new Error(`Dispatcher inline tool contract missing: ${key}`);
    }
    const actualSchemaKeys = Object.keys(actual.inputSchema);
    if (
      expected.description !== actual.description ||
      JSON.stringify(expected.schemaKeys) !== JSON.stringify(actualSchemaKeys)
    ) {
      throw new Error(`Dispatcher inline tool contract drifted: ${key}`);
    }
  }
}

function selectCases(options: CliOptions): DispatcherEvaluationCase[] {
  const knownIds = new Set(DISPATCHER_EVALUATION_CORPUS.map(({ id }) => id));
  const unknownIds = options.caseIds.filter((id) => !knownIds.has(id));
  if (unknownIds.length > 0) {
    throw new Error(`Unknown dispatcher case IDs: ${unknownIds.join(", ")}`);
  }

  const caseIds = new Set(options.caseIds);
  const categories = new Set(options.categories);
  const selected = DISPATCHER_EVALUATION_CORPUS.filter((evaluationCase) => {
    const caseMatches = caseIds.size === 0 || caseIds.has(evaluationCase.id);
    const categoryMatches =
      categories.size === 0 || categories.has(evaluationCase.category);
    return caseMatches && categoryMatches;
  });
  if (selected.length === 0)
    throw new Error("No corpus cases matched the selection");
  return [...selected];
}

async function loadHarness(): Promise<Harness> {
  const [
    interaction,
    runtime,
    memory,
    automations,
    drafts,
    self,
    tools,
    coding,
    gates,
    dispatcherScope,
    dispatcherTools,
  ] = await Promise.all([
    import("../server/interaction-agent.js"),
    import("../server/runtimes/index.js"),
    import("../server/memory/tools.js"),
    import("../server/automation-tools.js"),
    import("../server/draft-tools.js"),
    import("../server/self-tools.js"),
    import("../server/runtimes/tool.js"),
    import("../server/coding-agent.js"),
    import("../server/dispatcher/gates.js"),
    import("../server/dispatcher/scope.js"),
    import("../server/dispatcher/tools.js"),
  ]);

  return {
    buildInteractionSystemPrompt: interaction.buildInteractionSystemPrompt,
    composePreloadedMemoryPrompt: interaction.composePreloadedMemoryPrompt,
    runAgentRuntime: runtime.runAgentRuntime,
    createMemoryTools: memory.createMemoryTools,
    createAutomationTools: automations.createAutomationTools,
    createDraftDecisionTools: drafts.createDraftDecisionTools,
    createSelfTools: self.createSelfTools,
    defineRuntimeTool: tools.defineRuntimeTool,
    parsePendingInputAnswer: coding.parsePendingInputAnswer,
    resolveSimpleSelfConfigurationRequest:
      gates.resolveSimpleSelfConfigurationRequest,
    resolveDispatcherToolScope: dispatcherScope.resolveDispatcherToolScope,
    createDispatcherTools: dispatcherTools.createDispatcherTools,
    dispatcherAllowedTools: dispatcherTools.dispatcherAllowedTools,
  };
}

function runtimeConfig(options: CliOptions): RuntimeConfig {
  const configuredRuntime =
    options.runtime ?? process.env.DANIEL_RUNTIME ?? "claude";
  if (configuredRuntime !== "claude" && configuredRuntime !== "codex") {
    throw new Error(`Unsupported DANIEL_RUNTIME: ${configuredRuntime}`);
  }
  if (configuredRuntime === "codex") {
    return {
      runtime: "codex",
      model: options.model ?? process.env.DANIEL_CODEX_MODEL ?? "gpt-5.5",
      reasoningEffort:
        options.reasoningEffort ??
        parseReasoningEffort(process.env.DANIEL_CODEX_REASONING_EFFORT),
      billingMode: "codex-subscription",
    };
  }
  return {
    runtime: "claude",
    model: options.model ?? process.env.DANIEL_MODEL ?? "claude-sonnet-4-6",
    billingMode: "api",
  };
}

function parseReasoningEffort(
  value: string | undefined,
): RuntimeReasoningEffort {
  if (
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  return "medium";
}

function shortToolName(fullName: string): string {
  return fullName.split("__").at(-1) ?? fullName;
}

function fullToolName(tool: RuntimeTool): string {
  return `mcp__${tool.namespace}__${tool.name}`;
}

function dispatcherAllowedTools(memoryEnabled: boolean): string[] {
  return DISPATCHER_ALLOWED_TOOLS.filter(
    (toolName) => memoryEnabled || !toolName.startsWith("mcp__daniel-memory__"),
  );
}

function deriveRoute(
  toolsCalled: readonly string[],
  pendingCodingQuestion: boolean,
): DispatcherRoute {
  if (pendingCodingQuestion) return "pending_coding_question";
  if (toolsCalled.includes("spawn_coding_agent")) return "spawn_coding_agent";
  if (toolsCalled.includes("spawn_agent")) return "spawn_agent";
  return "direct";
}

function isOrderedSubsequence(
  required: readonly string[],
  actual: readonly string[],
): boolean {
  let requiredIndex = 0;
  for (const item of actual) {
    if (item === required[requiredIndex]) requiredIndex += 1;
  }
  return requiredIndex === required.length;
}

function cannedToolResult(
  name: string,
  args: Record<string, unknown>,
): RuntimeToolResult {
  switch (name) {
    case "send_ack":
      return { text: "Acknowledgement sent to the evaluation user." };
    case "spawn_agent":
      return {
        text: "[agent fixture_agent completed]\n\nSynthetic worker result: the requested current or integrated information was retrieved successfully.",
      };
    case "spawn_coding_agent":
      return {
        text: "[coding fixture_project completed]\nRewrite this result in Daniel's voice.\n\nSynthetic coding result: the requested coding work and verification completed.",
      };
    case "remember_memory":
      return { text: "Remembered exact Supermemory fixture_memory_1." };
    case "recall":
      return {
        text: "• [relevance=0.94] fixture_memory_1: The project name is Atlas.",
      };
    case "update_memory":
      return args.memoryId
        ? { text: "Updated fixture_memory_1 with a new exact version." }
        : {
            text: "• [relevance=0.96] fixture_memory_1: The user's preferred name is River.",
          };
    case "forget_memory":
      return args.confirm
        ? { text: "Forgot the selected fixture memory." }
        : {
            text: "Preview: forget fixture_memory_1.\n\nPending operation: fixture_forget_1",
          };
    case "remember_image":
      return { text: "Remembered durable image fixture_image_memory." };
    case "create_automation":
      return {
        text: "Created automation fixture_auto_weather; next run is 8:00 AM America/Los_Angeles.",
      };
    case "list_automations":
      return {
        text: [
          "• [fixture_auto_weather] ● Weekday weather digest — 0 8 * * 1-5",
          "• [fixture_auto_summary] ● Weekly project summary — 0 17 * * 5",
        ].join("\n"),
      };
    case "toggle_automation":
      return { text: "Set fixture_auto_weather enabled=false." };
    case "delete_automation":
      return { text: "Deleted fixture_auto_summary." };
    case "list_drafts":
      return {
        text: "• [fixture_draft_1] (gmail.new) Send the prepared project update.",
      };
    case "send_draft":
      return { text: "Draft fixture_draft_1 executed successfully." };
    case "reject_draft":
      return { text: "Draft fixture_draft_1 rejected." };
    case "get_config":
      return {
        text: JSON.stringify({
          runtime: "fixture",
          model: "fixture-model",
          userTimezone: "America/Los_Angeles",
          currentLocalTime: "2026-08-14 09:00 PDT",
          integrationsLoaded: DEFAULT_INTEGRATIONS,
        }),
      };
    case "list_integrations":
      return {
        text: JSON.stringify(
          DEFAULT_INTEGRATIONS.map((slug) => ({
            slug,
            status: "active",
            account: "fixture-account",
          })),
        ),
      };
    case "search_composio_catalog":
      return { text: '[{"slug":"fixture","name":"Fixture toolkit"}]' };
    case "inspect_toolkit":
      return { text: '{"slug":"fixture","availableForSpawn":true}' };
    case "set_runtime":
    case "set_model":
    case "set_codex_reasoning_effort":
    case "set_timezone":
      return { text: `${name} accepted for the evaluation fixture.` };
    default:
      return { text: `Evaluation fixture completed ${name}.` };
  }
}

function shadowTools(
  tools: readonly RuntimeTool[],
  markAcknowledged: () => void,
): RuntimeTool[] {
  return tools.map((tool) => {
    const parser = z.object(tool.inputSchema);
    return {
      ...tool,
      handle: async (rawArgs: Record<string, unknown>) => {
        const args = parser.parse(rawArgs);
        if (tool.name === "send_ack") markAcknowledged();
        return cannedToolResult(tool.name, args);
      },
    };
  });
}

function buildEvaluationTools(args: {
  harness: Harness;
  evaluationCase: DispatcherEvaluationCase;
  config: RuntimeConfig;
  markAcknowledged: () => void;
}): RuntimeTool[] {
  const integrations = [
    ...(args.evaluationCase.context?.integrations ?? DEFAULT_INTEGRATIONS),
  ];
  const memoryEnabled = args.evaluationCase.context?.memoryEnabled ?? true;
  const imageStorageIds =
    args.evaluationCase.context?.images?.map(({ storageId }) => storageId) ??
    [];
  const scope = args.harness.resolveDispatcherToolScope(
    args.evaluationCase.message,
    integrations,
  );
  const tools = args.harness.createDispatcherTools({
    conversationId: "dispatcher-evaluation",
    content: args.evaluationCase.message,
    kind: args.evaluationCase.context?.kind,
    integrations,
    inboundImageStorageIds: imageStorageIds,
    spawnableImageStorageIds: imageStorageIds,
    memoryService: memoryEnabled ? ({} as never) : null,
    runtimeConfig: args.config,
    codingResponseStyle: "daniel_summary",
    toolFamilies: scope.families,
    persistAcknowledgement: async () => undefined,
    log: () => undefined,
  }).tools;
  validateInlineToolContracts(tools);
  return shadowTools(tools, args.markAcknowledged);
}

/** Legacy full-surface fixture retained for source-contract comparison. */
function buildLegacyEvaluationTools(args: {
  harness: Harness;
  evaluationCase: DispatcherEvaluationCase;
  config: RuntimeConfig;
  markAcknowledged: () => void;
}): RuntimeTool[] {
  const { harness, evaluationCase, config } = args;
  const memoryEnabled = evaluationCase.context?.memoryEnabled ?? true;
  const imageStorageIds =
    evaluationCase.context?.images?.map(({ storageId }) => storageId) ?? [];
  const integrations = [
    ...(evaluationCase.context?.integrations ?? DEFAULT_INTEGRATIONS),
  ];
  const automationTools = harness
    .createAutomationTools("dispatcher-evaluation")
    .map((tool) =>
      tool.name === "create_automation"
        ? {
            ...tool,
            description: tool.description.replace(
              /Integrations available: .*$/,
              `Integrations available: ${integrations.join(", ") || "(none configured)"}`,
            ),
          }
        : tool,
    );

  const tools: RuntimeTool[] = [
    ...(memoryEnabled
      ? harness.createMemoryTools({
          // Handlers are replaced below before the runtime can invoke them.
          service: {} as never,
          imageStorageIds,
        })
      : []),
    ...automationTools,
    ...harness.createDraftDecisionTools("dispatcher-evaluation", config),
    ...harness.createSelfTools(),
    harness.defineRuntimeTool(
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
      async () => cannedToolResult("send_ack", {}),
    ),
    harness.defineRuntimeTool(
      "daniel-coding",
      "spawn_coding_agent",
      "Spawn Daniel's full Codex coding bridge for software work: build apps, edit/debug code, generate files, connect repos, run tests, deploy, create PRs, build landing pages/backends/databases, or build Photon/Spectrum/iMessage agents. Do not use for normal non-coding personal-assistant tasks.",
      {
        task: z
          .string()
          .describe(
            "Specific coding task to plan, build, edit, debug, test, or deploy.",
          ),
        projectHint: z
          .string()
          .optional()
          .describe("Short project/app name if the user provided one."),
        repoUrl: z
          .string()
          .optional()
          .describe(
            "Git repository URL to clone or continue from, if provided.",
          ),
        mode: z
          .enum(["auto", "plan", "build", "debug"])
          .optional()
          .describe(
            "auto is default. Use plan for new apps/major features, debug for bug fixes, build for small direct edits.",
          ),
        attachments: z
          .array(z.string())
          .optional()
          .describe(
            "Attachment identifiers or names relevant to the coding task.",
          ),
      },
      async () => cannedToolResult("spawn_coding_agent", {}),
    ),
    harness.defineRuntimeTool(
      "daniel-spawn",
      "spawn_agent",
      "Spawn a focused sub-agent to do real work using external tools. Returns the agent's final answer. Use for integrations, world actions, file/system access, or lookups that need live/current information. Do not spawn for questions answerable from knowledge unless the answer would go stale without a fresh lookup. If the current user message includes images and the sub-agent's task depends on them, pass the relevant storage IDs in imageRefs. On image turns, Daniel attaches all current-turn images by default; a non-empty imageRefs list can narrow to a subset.",
      {
        task: z
          .string()
          .describe(
            "Crisp task description — what to find/draft/do, not the raw user message.",
          ),
        integrations: z
          .array(z.string())
          .describe(
            `Which integrations to give the agent. Available: ${integrations.join(", ") || "(none)"}`,
          ),
        name: z.string().optional().describe("Short label for the agent."),
        imageRefs: z
          .array(z.string())
          .optional()
          .describe(
            "Convex storage IDs from the user's current message. Available in this turn: " +
              (imageStorageIds.length > 0
                ? imageStorageIds.join(", ")
                : "(none)"),
          ),
      },
      async () => cannedToolResult("spawn_agent", {}),
    ),
  ];

  const expectedToolNames = new Set(dispatcherAllowedTools(memoryEnabled));
  const actualToolNames = new Set(tools.map(fullToolName));
  const missing = [...expectedToolNames].filter(
    (name) => !actualToolNames.has(name),
  );
  const unexpected = [...actualToolNames].filter(
    (name) => !expectedToolNames.has(name),
  );
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Dispatcher tool contract drifted (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"})`,
    );
  }
  validateInlineToolContracts(tools);

  return shadowTools(tools, args.markAcknowledged);
}

type Rgba = readonly [number, number, number, number?];

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

/** Builds distinct, valid synthetic PNGs without adding image libraries. */
function fixturePngBase64(storageId: string): string {
  const width = 96;
  const height = 96;
  const pixels = Buffer.alloc(width * height * 4);
  const setPixel = (x: number, y: number, color: Rgba): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = (y * width + x) * 4;
    pixels[offset] = color[0];
    pixels[offset + 1] = color[1];
    pixels[offset + 2] = color[2];
    pixels[offset + 3] = color[3] ?? 255;
  };
  const rectangle = (
    x: number,
    y: number,
    rectangleWidth: number,
    rectangleHeight: number,
    color: Rgba,
  ): void => {
    for (let row = y; row < y + rectangleHeight; row += 1) {
      for (let column = x; column < x + rectangleWidth; column += 1) {
        setPixel(column, row, color);
      }
    }
  };
  const ellipse = (
    centerX: number,
    centerY: number,
    radiusX: number,
    radiusY: number,
    color: Rgba,
  ): void => {
    for (let y = centerY - radiusY; y <= centerY + radiusY; y += 1) {
      for (let x = centerX - radiusX; x <= centerX + radiusX; x += 1) {
        const normalizedX = (x - centerX) / radiusX;
        const normalizedY = (y - centerY) / radiusY;
        if (normalizedX * normalizedX + normalizedY * normalizedY <= 1) {
          setPixel(x, y, color);
        }
      }
    }
  };
  const line = (
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    color: Rgba,
    thickness = 1,
  ): void => {
    let x = startX;
    let y = startY;
    const deltaX = Math.abs(endX - startX);
    const stepX = startX < endX ? 1 : -1;
    const deltaY = -Math.abs(endY - startY);
    const stepY = startY < endY ? 1 : -1;
    let error = deltaX + deltaY;
    for (;;) {
      rectangle(
        x - Math.floor(thickness / 2),
        y - Math.floor(thickness / 2),
        thickness,
        thickness,
        color,
      );
      if (x === endX && y === endY) break;
      const doubled = 2 * error;
      if (doubled >= deltaY) {
        error += deltaY;
        x += stepX;
      }
      if (doubled <= deltaX) {
        error += deltaX;
        y += stepY;
      }
    }
  };

  rectangle(0, 0, width, height, [247, 247, 244]);
  if (storageId.includes("error")) {
    rectangle(8, 12, 80, 70, [255, 255, 255]);
    rectangle(8, 12, 80, 10, [70, 76, 86]);
    ellipse(25, 43, 10, 10, [210, 48, 48]);
    line(20, 38, 30, 48, [255, 255, 255], 3);
    line(30, 38, 20, 48, [255, 255, 255], 3);
    rectangle(42, 34, 34, 4, [58, 63, 72]);
    rectangle(42, 43, 29, 3, [125, 130, 138]);
    rectangle(18, 62, 60, 3, [160, 164, 170]);
    rectangle(18, 69, 45, 3, [160, 164, 170]);
  } else if (storageId.includes("plant")) {
    rectangle(0, 70, width, 26, [224, 214, 190]);
    line(49, 70, 49, 31, [56, 112, 63], 4);
    ellipse(37, 38, 17, 8, [73, 154, 84]);
    ellipse(60, 30, 16, 8, [53, 132, 71]);
    ellipse(36, 55, 14, 7, [44, 126, 66]);
    ellipse(61, 50, 17, 8, [82, 165, 89]);
    rectangle(34, 69, 30, 18, [169, 99, 62]);
    rectangle(30, 66, 38, 6, [190, 116, 70]);
  } else if (storageId.includes("memory")) {
    rectangle(10, 18, 28, 20, [81, 126, 214]);
    rectangle(58, 18, 28, 20, [91, 174, 126]);
    rectangle(34, 62, 28, 20, [174, 108, 198]);
    line(38, 28, 57, 28, [54, 59, 69], 3);
    line(72, 39, 56, 62, [54, 59, 69], 3);
    line(40, 62, 24, 39, [54, 59, 69], 3);
  } else {
    rectangle(0, 0, width, height, [238, 232, 221]);
    ellipse(30, 34, 22, 18, [222, 98, 98]);
    rectangle(49, 18, 30, 49, [72, 134, 204]);
    line(12, 78, 84, 58, [238, 184, 68], 8);
  }

  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let row = 0; row < height; row += 1) {
    const rawOffset = row * (1 + width * 4);
    raw[rawOffset] = 0;
    pixels.copy(raw, rawOffset + 1, row * width * 4, (row + 1) * width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return png.toString("base64");
}

function buildEvaluationPrompt(
  evaluationCase: DispatcherEvaluationCase,
  composePreloadedMemoryPrompt: Harness["composePreloadedMemoryPrompt"],
): RuntimePrompt {
  const context = evaluationCase.context;
  const userText = evaluationCase.message;
  let conversationPrompt: string;

  if (context?.kind === "proactive") {
    conversationPrompt = `Standalone proactive notice. Write a concise user-facing iMessage from this notice only. Do not research, spawn agents, or continue any prior conversation.\n\n${userText}`;
  } else if (context?.priorTurns?.length) {
    const history = context.priorTurns
      .map(({ role, content }) => `${role.toUpperCase()}: ${content}`)
      .join("\n");
    conversationPrompt = `Prior turns:\n${history}\n\nCurrent message:\n${userText || "(image)"}`;
  } else {
    conversationPrompt = userText || "(image)";
  }

  const text = composePreloadedMemoryPrompt(
    conversationPrompt,
    context?.preloadedMemory,
  );
  if (!context?.images?.length || context.kind === "proactive") return text;

  return [
    ...context.images.map((image) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: image.mediaType,
        data: fixturePngBase64(image.storageId),
      },
    })),
    { type: "text" as const, text },
  ];
}

function expectationResult(args: {
  evaluationCase: DispatcherEvaluationCase;
  route: DispatcherRoute;
  toolsCalled: readonly string[];
  acknowledgementTimeMs: number | null;
  pendingAnswerMatched?: boolean | null;
}): Pick<
  DispatcherCaseResult,
  | "routeMatched"
  | "toolExpectationMatched"
  | "acknowledgementMatched"
  | "pendingAnswerMatched"
  | "passed"
  | "violations"
> {
  const expected = args.evaluationCase.expected;
  const routeMatched = args.route === expected.route;
  const requiredMatched = isOrderedSubsequence(
    expected.requiredTools,
    args.toolsCalled,
  );
  const forbiddenCalled = (expected.forbiddenTools ?? []).filter((tool) =>
    args.toolsCalled.includes(tool),
  );
  const unexpectedTools =
    expected.requiredTools.length === 0 ? [...args.toolsCalled] : [];
  const toolExpectationMatched =
    requiredMatched &&
    forbiddenCalled.length === 0 &&
    unexpectedTools.length === 0;
  const acknowledged = args.acknowledgementTimeMs !== null;
  const acknowledgementMatched =
    expected.acknowledgement === "optional" ||
    (expected.acknowledgement === "required" ? acknowledged : !acknowledged);
  const pendingAnswerMatched = args.pendingAnswerMatched ?? null;
  const pendingMatched = pendingAnswerMatched ?? true;
  const violations: string[] = [];

  if (!routeMatched)
    violations.push(`expected route ${expected.route}, got ${args.route}`);
  if (!requiredMatched) {
    violations.push(
      `missing ordered tools: ${expected.requiredTools.join(" -> ") || "(none)"}`,
    );
  }
  if (forbiddenCalled.length > 0) {
    violations.push(`called forbidden tools: ${forbiddenCalled.join(", ")}`);
  }
  if (unexpectedTools.length > 0) {
    violations.push(`expected no tools, got: ${unexpectedTools.join(", ")}`);
  }
  if (!acknowledgementMatched) {
    violations.push(
      `acknowledgement was ${acknowledged ? "sent" : "not sent"}`,
    );
  }
  if (!pendingMatched)
    violations.push("pending coding answer parse did not match");

  return {
    routeMatched,
    toolExpectationMatched,
    acknowledgementMatched,
    pendingAnswerMatched,
    passed:
      routeMatched &&
      toolExpectationMatched &&
      acknowledgementMatched &&
      pendingMatched,
    violations,
  };
}

async function runPendingCodingCase(args: {
  harness: Harness;
  evaluationCase: DispatcherEvaluationCase;
  iteration: number;
}): Promise<DispatcherCaseResult> {
  const startedAt = performance.now();
  const fixture = args.evaluationCase.context?.pendingCodingQuestion;
  if (!fixture)
    throw new Error(
      `Missing pending coding fixture: ${args.evaluationCase.id}`,
    );
  const parsed = args.harness.parsePendingInputAnswer({
    content: args.evaluationCase.message,
    options: [...fixture.options],
    allowFreeform: fixture.allowFreeform,
  });
  const accepted = parsed.ok;
  const pendingAnswerMatched =
    args.evaluationCase.expected.pendingAnswer === undefined ||
    accepted === (args.evaluationCase.expected.pendingAnswer === "accepted");
  const totalResponseTimeMs = performance.now() - startedAt;
  const route: DispatcherRoute = "pending_coding_question";
  const expectation = expectationResult({
    evaluationCase: args.evaluationCase,
    route,
    toolsCalled: [],
    acknowledgementTimeMs: null,
    pendingAnswerMatched,
  });

  return {
    caseId: args.evaluationCase.id,
    category: args.evaluationCase.category,
    iteration: args.iteration,
    status: "ok",
    expectedRoute: args.evaluationCase.expected.route,
    route,
    toolsCalled: [],
    toolCalls: [],
    inputTokens: 0,
    outputTokens: 0,
    acknowledgementTimeMs: null,
    firstResponseTimeMs: totalResponseTimeMs,
    firstModelTextTimeMs: null,
    totalResponseTimeMs,
    ...expectation,
  };
}

function runProactiveCase(args: {
  evaluationCase: DispatcherEvaluationCase;
  iteration: number;
}): DispatcherCaseResult {
  const startedAt = performance.now();
  const route: DispatcherRoute = "direct";
  const expectation = expectationResult({
    evaluationCase: args.evaluationCase,
    route,
    toolsCalled: [],
    acknowledgementTimeMs: null,
  });
  const totalResponseTimeMs = performance.now() - startedAt;
  return {
    caseId: args.evaluationCase.id,
    category: args.evaluationCase.category,
    iteration: args.iteration,
    status: "ok",
    expectedRoute: args.evaluationCase.expected.route,
    route,
    toolsCalled: [],
    toolCalls: [],
    inputTokens: 0,
    outputTokens: 0,
    acknowledgementTimeMs: null,
    firstResponseTimeMs: totalResponseTimeMs,
    firstModelTextTimeMs: null,
    totalResponseTimeMs,
    ...expectation,
  };
}

function errorSummary(error: unknown): string {
  if (error instanceof Error)
    return `${error.name}: ${error.message}`.slice(0, 500);
  return String(error).slice(0, 500);
}

async function runModelCase(args: {
  harness: Harness;
  config: RuntimeConfig;
  evaluationCase: DispatcherEvaluationCase;
  iteration: number;
  timeoutMs: number;
}): Promise<DispatcherCaseResult> {
  const startedAt = performance.now();
  const toolCalls: ToolCallMeasurement[] = [];
  let acknowledgementTimeMs: number | null = null;
  let firstModelTextTimeMs: number | null = null;
  const abortController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, args.timeoutMs);
  const markAcknowledged = (): void => {
    if (acknowledgementTimeMs === null) {
      acknowledgementTimeMs = performance.now() - startedAt;
    }
  };
  const tools = buildEvaluationTools({
    harness: args.harness,
    evaluationCase: args.evaluationCase,
    config: args.config,
    markAcknowledged,
  });
  const memoryEnabled = args.evaluationCase.context?.memoryEnabled ?? true;
  const integrations = [
    ...(args.evaluationCase.context?.integrations ?? DEFAULT_INTEGRATIONS),
  ];
  const toolScope = args.harness.resolveDispatcherToolScope(
    args.evaluationCase.message,
    integrations,
  );
  const proactive = args.evaluationCase.context?.kind === "proactive";
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let status: DispatcherCaseResult["status"] = "ok";
  let error: string | undefined;

  try {
    const result = await args.harness.runAgentRuntime(args.config, {
      prompt: buildEvaluationPrompt(
        args.evaluationCase,
        args.harness.composePreloadedMemoryPrompt,
      ),
      systemPrompt: args.harness.buildInteractionSystemPrompt({
        integrations,
        codingResponseStyle: "daniel_summary",
        memoryEnabled,
        toolFamilies: toolScope.families,
      }),
      tools,
      mode: "dispatcher",
      allowedTools: proactive ? [] : args.harness.dispatcherAllowedTools(tools),
      disallowedTools: DISPATCHER_DISALLOWED_TOOLS,
      abortController,
      onText: () => {
        if (firstModelTextTimeMs === null) {
          firstModelTextTimeMs = performance.now() - startedAt;
        }
      },
      onToolUse: (toolName) => {
        toolCalls.push({
          name: shortToolName(toolName),
          fullName: toolName,
          atMs: performance.now() - startedAt,
        });
      },
      onUsage: (usage) => {
        inputTokens = usage.inputTokens;
        outputTokens = usage.outputTokens;
      },
    });
    inputTokens = result.usage.inputTokens;
    outputTokens = result.usage.outputTokens;
    if (firstModelTextTimeMs === null && result.text.trim()) {
      firstModelTextTimeMs = performance.now() - startedAt;
    }
  } catch (caught) {
    status = timedOut ? "timeout" : "error";
    error = errorSummary(caught);
  } finally {
    clearTimeout(timer);
  }

  const totalResponseTimeMs = performance.now() - startedAt;
  const firstResponseTimeMs =
    acknowledgementTimeMs ?? (status === "ok" ? totalResponseTimeMs : null);
  const toolsCalled = toolCalls.map(({ name }) => name);
  const route = deriveRoute(toolsCalled, false);
  const expectation = expectationResult({
    evaluationCase: args.evaluationCase,
    route,
    toolsCalled,
    acknowledgementTimeMs,
  });
  if (status !== "ok") {
    expectation.passed = false;
    expectation.violations.push(`runtime status: ${status}`);
  }

  return {
    caseId: args.evaluationCase.id,
    category: args.evaluationCase.category,
    iteration: args.iteration,
    status,
    expectedRoute: args.evaluationCase.expected.route,
    route,
    toolsCalled,
    toolCalls,
    inputTokens,
    outputTokens,
    acknowledgementTimeMs,
    firstResponseTimeMs,
    firstModelTextTimeMs,
    totalResponseTimeMs,
    ...expectation,
    error,
  };
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: readonly number[], value: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(value * sorted.length) - 1);
  return sorted[index];
}

function rate(count: number, total: number): number {
  return total === 0 ? 1 : count / total;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function buildReport(args: {
  config: RuntimeConfig;
  selectedCases: readonly DispatcherEvaluationCase[];
  repeat: number;
  results: DispatcherCaseResult[];
}): DispatcherEvaluationReport {
  const now = new Date();
  const acknowledgementTimes = args.results.flatMap(
    ({ acknowledgementTimeMs }) =>
      acknowledgementTimeMs === null ? [] : [acknowledgementTimeMs],
  );
  const firstResponseTimes = args.results.flatMap(({ firstResponseTimeMs }) =>
    firstResponseTimeMs === null ? [] : [firstResponseTimeMs],
  );
  const firstModelTextTimes = args.results.flatMap(
    ({ firstModelTextTimeMs }) =>
      firstModelTextTimeMs === null ? [] : [firstModelTextTimeMs],
  );
  const totalTimes = args.results.map(
    ({ totalResponseTimeMs }) => totalResponseTimeMs,
  );
  const measurementCount = args.results.length;
  const passedCount = args.results.filter(({ passed }) => passed).length;
  const meanAcknowledgement = mean(acknowledgementTimes);
  const p50FirstResponse = percentile(firstResponseTimes, 0.5);
  const p95FirstResponse = percentile(firstResponseTimes, 0.95);
  const p50FirstModelText = percentile(firstModelTextTimes, 0.5);
  const p95FirstModelText = percentile(firstModelTextTimes, 0.95);

  return {
    schemaVersion: 1,
    runId: `dispatcher-${now.toISOString().replace(/[:.]/g, "-")}`,
    generatedAt: now.toISOString(),
    runtime: args.config.runtime,
    model: args.config.model,
    reasoningEffort: args.config.reasoningEffort ?? null,
    corpus: {
      totalCaseCount: DISPATCHER_EVALUATION_CORPUS.length,
      selectedCaseCount: args.selectedCases.length,
      categoryCount: new Set(args.selectedCases.map(({ category }) => category))
        .size,
      repeat: args.repeat,
    },
    metrics: {
      measurementCount,
      passedCount,
      errorCount: args.results.filter(({ status }) => status !== "ok").length,
      usageUnavailableCount: args.results.filter(
        ({ inputTokens, outputTokens }) =>
          inputTokens === null || outputTokens === null,
      ).length,
      routeAccuracy: rate(
        args.results.filter(({ routeMatched }) => routeMatched).length,
        measurementCount,
      ),
      toolExpectationAccuracy: rate(
        args.results.filter(
          ({ toolExpectationMatched }) => toolExpectationMatched,
        ).length,
        measurementCount,
      ),
      acknowledgementAccuracy: rate(
        args.results.filter(
          ({ acknowledgementMatched }) => acknowledgementMatched,
        ).length,
        measurementCount,
      ),
      totalInputTokens: args.results.reduce(
        (sum, result) => sum + (result.inputTokens ?? 0),
        0,
      ),
      totalOutputTokens: args.results.reduce(
        (sum, result) => sum + (result.outputTokens ?? 0),
        0,
      ),
      meanAcknowledgementTimeMs:
        meanAcknowledgement === null ? null : round(meanAcknowledgement),
      p50FirstResponseTimeMs:
        p50FirstResponse === null ? null : round(p50FirstResponse),
      p95FirstResponseTimeMs:
        p95FirstResponse === null ? null : round(p95FirstResponse),
      p50FirstModelTextTimeMs:
        p50FirstModelText === null ? null : round(p50FirstModelText),
      p95FirstModelTextTimeMs:
        p95FirstModelText === null ? null : round(p95FirstModelText),
      p50TotalResponseTimeMs: round(percentile(totalTimes, 0.5) ?? 0),
      p95TotalResponseTimeMs: round(percentile(totalTimes, 0.95) ?? 0),
    },
    passed: passedCount === measurementCount,
    results: args.results.map((result) => ({
      ...result,
      acknowledgementTimeMs:
        result.acknowledgementTimeMs === null
          ? null
          : round(result.acknowledgementTimeMs),
      firstResponseTimeMs:
        result.firstResponseTimeMs === null
          ? null
          : round(result.firstResponseTimeMs),
      firstModelTextTimeMs:
        result.firstModelTextTimeMs === null
          ? null
          : round(result.firstModelTextTimeMs),
      totalResponseTimeMs: round(result.totalResponseTimeMs),
      toolCalls: result.toolCalls.map((call) => ({
        ...call,
        atMs: round(call.atMs),
      })),
    })),
  };
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatMilliseconds(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(0)}ms`;
}

function formatTokens(input: number | null, output: number | null): string {
  return input === null || output === null ? "n/a" : `${input}/${output}`;
}

function formatTextReport(report: DispatcherEvaluationReport): string {
  const lines = [
    "Dispatcher routing evaluation",
    `Run: ${report.runId}`,
    `Runtime: ${report.runtime} / ${report.model}${report.reasoningEffort ? ` / ${report.reasoningEffort}` : ""}`,
    `Corpus: ${report.corpus.selectedCaseCount}/${report.corpus.totalCaseCount} cases, ${report.metrics.measurementCount} measurements`,
    "",
  ];

  for (const result of report.results) {
    lines.push(
      `${result.passed ? "PASS" : "MISS"}  ${result.caseId} [${result.expectedRoute} -> ${result.route}]`,
      `      tools=${result.toolsCalled.join(" -> ") || "(none)"} tokens=${formatTokens(result.inputTokens, result.outputTokens)} ack=${formatMilliseconds(result.acknowledgementTimeMs)} first=${formatMilliseconds(result.firstResponseTimeMs)} model-text=${formatMilliseconds(result.firstModelTextTimeMs)} total=${formatMilliseconds(result.totalResponseTimeMs)}`,
    );
    if (result.violations.length > 0) {
      lines.push(`      ${result.violations.join("; ")}`);
    }
    if (result.error) lines.push(`      ${result.error}`);
  }

  lines.push(
    "",
    `Expectation matches: ${report.metrics.passedCount}/${report.metrics.measurementCount}`,
    `Route accuracy: ${formatPercent(report.metrics.routeAccuracy)}`,
    `Tool expectation accuracy: ${formatPercent(report.metrics.toolExpectationAccuracy)}`,
    `Acknowledgement accuracy: ${formatPercent(report.metrics.acknowledgementAccuracy)}`,
    `Input/output tokens: ${report.metrics.totalInputTokens}/${report.metrics.totalOutputTokens}`,
    `Measurements without usage data: ${report.metrics.usageUnavailableCount}`,
    `Mean acknowledgement: ${formatMilliseconds(report.metrics.meanAcknowledgementTimeMs)}`,
    `p50/p95 first response: ${formatMilliseconds(report.metrics.p50FirstResponseTimeMs)} / ${formatMilliseconds(report.metrics.p95FirstResponseTimeMs)}`,
    `p50/p95 first model text: ${formatMilliseconds(report.metrics.p50FirstModelTextTimeMs)} / ${formatMilliseconds(report.metrics.p95FirstModelTextTimeMs)}`,
    `p50/p95 total response: ${formatMilliseconds(report.metrics.p50TotalResponseTimeMs)} / ${formatMilliseconds(report.metrics.p95TotalResponseTimeMs)}`,
    "",
    `BASELINE EXPECTATIONS: ${report.passed ? "MATCH" : "MISSES RECORDED"}`,
  );
  return lines.join("\n");
}

function formatList(selected: readonly DispatcherEvaluationCase[]): string {
  return [
    `Dispatcher corpus: ${selected.length} cases`,
    ...selected.map(
      (evaluationCase) =>
        `${evaluationCase.id}\t${evaluationCase.category}\t${evaluationCase.expected.route}\t${evaluationCase.expected.requiredTools.join(" -> ") || "(no tools)"}`,
    ),
  ].join("\n");
}

async function writeReport(
  path: string,
  report: DispatcherEvaluationReport,
): Promise<void> {
  const outputPath = resolve(process.cwd(), path);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  validateCorpus(DISPATCHER_EVALUATION_CORPUS);
  validateProductionSourceContract();
  const selectedCases = selectCases(options);
  if (options.list) {
    console.log(formatList(selectedCases));
    return;
  }
  if (options.dryRun) {
    const summary = {
      valid: true,
      totalCaseCount: DISPATCHER_EVALUATION_CORPUS.length,
      selectedCaseCount: selectedCases.length,
      categories: [...new Set(selectedCases.map(({ category }) => category))],
      caseIds: selectedCases.map(({ id }) => id),
    };
    console.log(
      options.json
        ? JSON.stringify(summary, null, 2)
        : formatList(selectedCases),
    );
    return;
  }

  // Load .env.local before importing modules that initialize the Convex client.
  // No Convex method is called by this evaluation harness.
  await import("../server/env-setup.js");
  const config = runtimeConfig(options);
  const harness = await loadHarness();
  const results: DispatcherCaseResult[] = [];
  if (!options.json) {
    console.error(
      `Evaluating with ${config.runtime}/${config.model}${config.reasoningEffort ? ` (${config.reasoningEffort})` : ""}; configuration source: CLI/environment`,
    );
  }

  for (let iteration = 1; iteration <= options.repeat; iteration += 1) {
    for (const evaluationCase of selectedCases) {
      const result = evaluationCase.context?.pendingCodingQuestion
        ? await runPendingCodingCase({
            harness,
            evaluationCase,
            iteration,
          })
        : evaluationCase.context?.kind === "proactive"
          ? runProactiveCase({ evaluationCase, iteration })
          : harness.resolveSimpleSelfConfigurationRequest(
                evaluationCase.message,
              ) !== null
            ? runProactiveCase({ evaluationCase, iteration })
            : await runModelCase({
                harness,
                config,
                evaluationCase,
                iteration,
                timeoutMs: options.timeoutMs,
              });
      results.push(result);
      if (!options.json) {
        console.error(
          `[${results.length}/${selectedCases.length * options.repeat}] ${result.caseId}: ${result.passed ? "match" : "miss"}`,
        );
      }
    }
  }

  const report = buildReport({
    config,
    selectedCases,
    repeat: options.repeat,
    results,
  });
  if (options.outputPath) await writeReport(options.outputPath, report);
  console.log(
    options.json ? JSON.stringify(report, null, 2) : formatTextReport(report),
  );
  if (report.metrics.errorCount > 0) process.exitCode = 2;
  else if (options.strict && !report.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Dispatcher evaluation failed: ${errorSummary(error)}`);
  process.exitCode = 2;
});
