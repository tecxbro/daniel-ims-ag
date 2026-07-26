import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  messages: defineTable({
    conversationId: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant"), v.literal("system")),
    content: v.string(),
    agentId: v.optional(v.string()),
    turnId: v.optional(v.string()),
    createdAt: v.number(),
    imageStorageIds: v.optional(v.array(v.id("_storage"))),
    mediaError: v.optional(v.string()),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_conversation_turn", ["conversationId", "turnId"])
    .index("by_createdAt", ["createdAt"]),

  conversations: defineTable({
    conversationId: v.string(),
    title: v.optional(v.string()),
    summary: v.optional(v.string()),
    messageCount: v.number(),
    lastActivityAt: v.number(),
  }).index("by_conversation", ["conversationId"]),

  memoryRecords: defineTable({
    memoryId: v.string(),
    content: v.string(),
    tier: v.union(v.literal("short"), v.literal("long"), v.literal("permanent")),
    segment: v.union(
      v.literal("identity"),
      v.literal("preference"),
      v.literal("correction"),
      v.literal("relationship"),
      v.literal("project"),
      v.literal("knowledge"),
      v.literal("context"),
    ),
    importance: v.number(),
    decayRate: v.number(),
    accessCount: v.number(),
    lastAccessedAt: v.number(),
    sourceTurn: v.optional(v.string()),
    lifecycle: v.union(v.literal("active"), v.literal("archived"), v.literal("pruned")),
    supersedes: v.optional(v.array(v.string())),
    embedding: v.optional(v.array(v.float64())),
    // Structured sidecar data (JSON blob). Currently used to carry
    // `corrects` text on correction-segment memories. Intentionally loose
    // so extraction prompts can stash provider-specific hints without
    // schema churn.
    metadata: v.optional(v.string()),
    createdAt: v.number(),
    imageStorageIds: v.optional(v.array(v.id("_storage"))),
  })
    .index("by_memory_id", ["memoryId"])
    .index("by_tier", ["tier"])
    .index("by_segment", ["segment"])
    .index("by_lifecycle", ["lifecycle"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1024,
      filterFields: ["lifecycle"],
    }),

  executionAgents: defineTable({
    agentId: v.string(),
    conversationId: v.optional(v.string()),
    name: v.string(),
    task: v.string(),
    runtime: v.optional(v.union(v.literal("claude"), v.literal("codex"))),
    model: v.optional(v.string()),
    reasoningEffort: v.optional(v.string()),
    billingMode: v.optional(v.union(v.literal("api"), v.literal("codex-subscription"))),
    status: v.union(
      v.literal("spawned"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled"),
      v.literal("paused"),
    ),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    mcpServers: v.array(v.string()),
    inputTokens: v.number(),
    outputTokens: v.number(),
    cacheReadTokens: v.optional(v.number()),
    cacheCreationTokens: v.optional(v.number()),
    costUsd: v.number(),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_agent_id", ["agentId"])
    .index("by_status", ["status"])
    .index("by_conversation", ["conversationId"]),

  codingProjects: defineTable({
    projectKey: v.string(),
    conversationId: v.string(),
    userId: v.optional(v.string()),
    title: v.string(),
    status: v.union(
      v.literal("planning"),
      v.literal("building"),
      v.literal("waiting_for_user"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    repoUrl: v.optional(v.string()),
    branch: v.optional(v.string()),
    workspacePath: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    lastCodexThreadId: v.optional(v.string()),
  })
    .index("by_projectKey", ["projectKey"])
    .index("by_conversation_and_updatedAt", ["conversationId", "updatedAt"])
    .index("by_conversation_and_status", ["conversationId", "status"]),

  codingSessions: defineTable({
    projectId: v.id("codingProjects"),
    conversationId: v.string(),
    codexThreadId: v.optional(v.string()),
    mode: v.union(
      v.literal("plan"),
      v.literal("build"),
      v.literal("debug"),
      v.literal("followup"),
    ),
    status: v.union(
      v.literal("running"),
      v.literal("waiting_for_user"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    workspacePath: v.string(),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
    finalSummary: v.optional(v.string()),
    error: v.optional(v.string()),
  })
    .index("by_project_and_startedAt", ["projectId", "startedAt"])
    .index("by_conversation_and_status", ["conversationId", "status"])
    .index("by_codexThreadId", ["codexThreadId"]),

  codingEvents: defineTable({
    projectId: v.id("codingProjects"),
    sessionId: v.id("codingSessions"),
    type: v.union(
      v.literal("codex_thread_started"),
      v.literal("plan_delta"),
      v.literal("plan_final"),
      v.literal("question_requested"),
      v.literal("user_answered"),
      v.literal("tool_event"),
      v.literal("file_change"),
      v.literal("diff"),
      v.literal("final_response"),
      v.literal("error"),
    ),
    payload: v.string(),
    createdAt: v.number(),
  })
    .index("by_project_and_createdAt", ["projectId", "createdAt"])
    .index("by_session_and_createdAt", ["sessionId", "createdAt"])
    .index("by_type", ["type"]),

  codingPendingInputs: defineTable({
    projectId: v.id("codingProjects"),
    sessionId: v.id("codingSessions"),
    conversationId: v.string(),
    codexRequestId: v.string(),
    codexQuestionId: v.optional(v.string()),
    question: v.string(),
    questionsJson: v.optional(v.string()),
    options: v.optional(v.array(v.string())),
    allowFreeform: v.boolean(),
    status: v.union(
      v.literal("pending"),
      v.literal("answered"),
      v.literal("expired"),
      v.literal("cancelled"),
    ),
    answer: v.optional(v.string()),
    createdAt: v.number(),
    answeredAt: v.optional(v.number()),
  })
    .index("by_conversation_and_status", ["conversationId", "status"])
    .index("by_session_and_status", ["sessionId", "status"])
    .index("by_codexRequestId", ["codexRequestId"]),

  codingPreferences: defineTable({
    conversationId: v.string(),
    key: v.string(),
    value: v.string(),
    updatedAt: v.number(),
  }).index("by_conversation_and_key", ["conversationId", "key"]),

  // Append-only LLM usage log. Every model call (dispatcher, execution,
  // extract, consolidation) writes a row here so you can query total cost
  // by source, conversation, or time range.
  usageRecords: defineTable({
    source: v.union(
      v.literal("dispatcher"),
      v.literal("execution"),
      v.literal("extract"),
      v.literal("consolidation-proposer"),
      v.literal("consolidation-adversary"),
      v.literal("consolidation-judge"),
      v.literal("proactive"),
      v.literal("coding"),
    ),
    conversationId: v.optional(v.string()),
    turnId: v.optional(v.string()),
    agentId: v.optional(v.string()),
    runId: v.optional(v.string()),
    runtime: v.optional(v.union(v.literal("claude"), v.literal("codex"))),
    billingMode: v.optional(v.union(v.literal("api"), v.literal("codex-subscription"))),
    model: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    cacheReadTokens: v.number(),
    cacheCreationTokens: v.number(),
    costUsd: v.number(),
    durationMs: v.number(),
    createdAt: v.number(),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_agent", ["agentId"])
    .index("by_source", ["source"]),

  agentLogs: defineTable({
    agentId: v.string(),
    logType: v.union(
      v.literal("thinking"),
      v.literal("tool_use"),
      v.literal("tool_result"),
      v.literal("text"),
      v.literal("error"),
    ),
    toolName: v.optional(v.string()),
    // Composio account aliases targeted by this tool call (e.g. ["gmail_charry-fusc"]).
    // Populated when the input names a specific connected account, so multi-account
    // toolkits make it visible which inbox / workspace was actually hit.
    accounts: v.optional(v.array(v.string())),
    content: v.string(),
    createdAt: v.number(),
  }).index("by_agent", ["agentId"]),

  memoryEvents: defineTable({
    eventType: v.string(),
    conversationId: v.optional(v.string()),
    memoryId: v.optional(v.string()),
    agentId: v.optional(v.string()),
    data: v.string(),
    createdAt: v.number(),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_type", ["eventType"]),

  automations: defineTable({
    automationId: v.string(),
    name: v.string(),
    task: v.string(),
    integrations: v.array(v.string()),
    schedule: v.string(),
    // IANA timezone the cron expression is evaluated in. Stored at create
    // time so changing the user's global timezone later doesn't shift
    // existing automations. Optional for backwards compatibility — pre-TZ
    // automations fall back to the user's current setting at run time.
    timezone: v.optional(v.string()),
    enabled: v.boolean(),
    conversationId: v.optional(v.string()),
    notifyConversationId: v.optional(v.string()),
    lastRunAt: v.optional(v.number()),
    nextRunAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_automation_id", ["automationId"])
    .index("by_enabled", ["enabled"]),

  messageDedup: defineTable({
    key: v.string(),
    claimedAt: v.number(),
  }).index("by_key", ["key"]),

  drafts: defineTable({
    draftId: v.string(),
    conversationId: v.string(),
    kind: v.string(),
    summary: v.string(),
    payload: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("sent"),
      v.literal("rejected"),
      v.literal("expired"),
    ),
    createdAt: v.number(),
    decidedAt: v.optional(v.number()),
  })
    .index("by_draft_id", ["draftId"])
    .index("by_conversation_status", ["conversationId", "status"]),

  consolidationRuns: defineTable({
    runId: v.string(),
    trigger: v.string(),
    status: v.union(
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    proposalsCount: v.number(),
    mergedCount: v.number(),
    prunedCount: v.number(),
    notes: v.optional(v.string()),
    // JSON blob: { proposals: [...], decisions: [...], applied: [...] }
    // Captured so you can inspect the reasoning for any historical run.
    details: v.optional(v.string()),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_run_id", ["runId"])
    .index("by_status", ["status"]),

  // Runtime overrides for things normally pinned by env vars (e.g. the Claude
  // model). Lets the user say "use opus" via iMessage and have the next agent
  // run respect it without a redeploy.
  settings: defineTable({
    key: v.string(),
    value: v.string(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  automationRuns: defineTable({
    runId: v.string(),
    automationId: v.string(),
    status: v.union(
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    agentId: v.optional(v.string()),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_automation", ["automationId"])
    .index("by_run_id", ["runId"]),
});
