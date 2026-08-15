/**
 * Synthetic, production-secret-free corpus for measuring dispatcher routing.
 *
 * The runner evaluates the current dispatcher prompt with inert tools. Cases
 * may describe images and pending state, but never contain real conversations,
 * account identifiers, provider responses, or credentials.
 */
export const DISPATCHER_EVALUATION_CATEGORIES = [
  "direct_chat",
  "stable_question",
  "live_lookup",
  "integration",
  "coding",
  "memory",
  "draft",
  "automation",
  "image",
  "proactive_notice",
  "pending_coding_question",
] as const;

export type DispatcherEvaluationCategory =
  (typeof DISPATCHER_EVALUATION_CATEGORIES)[number];

/**
 * The production prompt has three routes. Pending coding input is included as
 * an evaluator-only route because production intercepts it before the model.
 */
export type DispatcherRoute =
  | "direct"
  | "spawn_agent"
  | "spawn_coding_agent"
  | "pending_coding_question";

export type DispatcherToolName =
  | "remember_memory"
  | "recall"
  | "update_memory"
  | "forget_memory"
  | "remember_image"
  | "spawn_agent"
  | "spawn_coding_agent"
  | "create_automation"
  | "list_automations"
  | "toggle_automation"
  | "delete_automation"
  | "list_drafts"
  | "send_draft"
  | "reject_draft"
  | "send_ack"
  | "get_config"
  | "set_runtime"
  | "set_model"
  | "set_codex_reasoning_effort"
  | "set_timezone"
  | "list_integrations"
  | "search_composio_catalog"
  | "inspect_toolkit";

export interface DispatcherPriorTurn {
  role: "user" | "assistant";
  content: string;
}

export interface DispatcherImageFixture {
  storageId: string;
  mediaType: "image/png";
  /** Review-only label. The runner does not add this description to the prompt. */
  description: string;
}

export interface PendingCodingQuestionFixture {
  options: readonly string[];
  allowFreeform: boolean;
}

export interface DispatcherEvaluationContext {
  kind?: "user" | "proactive";
  priorTurns?: readonly DispatcherPriorTurn[];
  integrations?: readonly string[];
  memoryEnabled?: boolean;
  preloadedMemory?: string;
  images?: readonly DispatcherImageFixture[];
  pendingCodingQuestion?: PendingCodingQuestionFixture;
}

export interface DispatcherExpectation {
  route: DispatcherRoute;
  /** Required ordered subsequence; extra dispatcher-local tools are recorded. */
  requiredTools: readonly DispatcherToolName[];
  forbiddenTools?: readonly DispatcherToolName[];
  acknowledgement: "required" | "forbidden" | "optional";
  pendingAnswer?: "accepted" | "rejected";
}

export interface DispatcherEvaluationCase {
  id: string;
  category: DispatcherEvaluationCategory;
  message: string;
  context?: DispatcherEvaluationContext;
  expected: DispatcherExpectation;
}

const NO_WORKER_TOOLS = ["spawn_agent", "spawn_coding_agent"] as const;
const DEFAULT_INTEGRATIONS = [
  "gmail",
  "googlecalendar",
  "slack",
  "notion",
  "browser",
] as const;

function evaluationCase(
  id: string,
  category: DispatcherEvaluationCategory,
  message: string,
  expected: DispatcherExpectation,
  context?: DispatcherEvaluationContext,
): DispatcherEvaluationCase {
  return { id, category, message, expected, context };
}

export const DISPATCHER_EVALUATION_CORPUS = [
  evaluationCase(
    "direct-greeting-01",
    "direct_chat",
    "Hey Daniel, how's it going?",
    {
      route: "direct",
      requiredTools: [],
      forbiddenTools: NO_WORKER_TOOLS,
      acknowledgement: "forbidden",
    },
  ),
  evaluationCase(
    "direct-thanks-02",
    "direct_chat",
    "Thanks, that's all for now.",
    {
      route: "direct",
      requiredTools: [],
      forbiddenTools: NO_WORKER_TOOLS,
      acknowledgement: "forbidden",
    },
  ),
  evaluationCase(
    "direct-ordinary-fact-03",
    "direct_chat",
    "I prefer aisle seats on flights.",
    {
      route: "direct",
      requiredTools: [],
      forbiddenTools: [
        "remember_memory",
        "update_memory",
        "forget_memory",
        ...NO_WORKER_TOOLS,
      ],
      acknowledgement: "forbidden",
    },
    { memoryEnabled: true },
  ),

  evaluationCase(
    "stable-networking-01",
    "stable_question",
    "Explain the difference between TCP and UDP in plain language.",
    {
      route: "direct",
      requiredTools: [],
      forbiddenTools: NO_WORKER_TOOLS,
      acknowledgement: "forbidden",
    },
  ),
  evaluationCase(
    "stable-science-02",
    "stable_question",
    "Why do leaves change color in autumn?",
    {
      route: "direct",
      requiredTools: [],
      forbiddenTools: NO_WORKER_TOOLS,
      acknowledgement: "forbidden",
    },
  ),
  evaluationCase(
    "stable-howto-03",
    "stable_question",
    "Give me a simple framework for writing a useful meeting agenda.",
    {
      route: "direct",
      requiredTools: [],
      forbiddenTools: NO_WORKER_TOOLS,
      acknowledgement: "forbidden",
    },
  ),

  evaluationCase(
    "live-weather-01",
    "live_lookup",
    "What's the weather in Seattle today?",
    {
      route: "spawn_agent",
      requiredTools: ["send_ack", "spawn_agent"],
      forbiddenTools: ["spawn_coding_agent"],
      acknowledgement: "required",
    },
    { integrations: DEFAULT_INTEGRATIONS },
  ),
  evaluationCase(
    "live-market-02",
    "live_lookup",
    "Look up Bitcoin's current price and today's percentage change.",
    {
      route: "spawn_agent",
      requiredTools: ["send_ack", "spawn_agent"],
      forbiddenTools: ["spawn_coding_agent"],
      acknowledgement: "required",
    },
    { integrations: DEFAULT_INTEGRATIONS },
  ),
  evaluationCase(
    "live-url-03",
    "live_lookup",
    "Open https://example.com and tell me what the page currently says.",
    {
      route: "spawn_agent",
      requiredTools: ["send_ack", "spawn_agent"],
      forbiddenTools: ["spawn_coding_agent"],
      acknowledgement: "required",
    },
    { integrations: DEFAULT_INTEGRATIONS },
  ),

  evaluationCase(
    "integration-email-01",
    "integration",
    "What's the newest unread email in my Gmail inbox?",
    {
      route: "spawn_agent",
      requiredTools: ["send_ack", "spawn_agent"],
      forbiddenTools: ["spawn_coding_agent"],
      acknowledgement: "required",
    },
    { integrations: DEFAULT_INTEGRATIONS },
  ),
  evaluationCase(
    "integration-calendar-02",
    "integration",
    "Check my calendar for tomorrow and summarize the busy periods.",
    {
      route: "spawn_agent",
      requiredTools: ["send_ack", "spawn_agent"],
      forbiddenTools: ["spawn_coding_agent"],
      acknowledgement: "required",
    },
    { integrations: DEFAULT_INTEGRATIONS },
  ),
  evaluationCase(
    "integration-list-03",
    "integration",
    "Which integrations and accounts are connected right now?",
    {
      route: "direct",
      requiredTools: [],
      forbiddenTools: NO_WORKER_TOOLS,
      acknowledgement: "forbidden",
    },
    { integrations: DEFAULT_INTEGRATIONS },
  ),

  evaluationCase(
    "coding-debug-01",
    "coding",
    "Fix the failing webhook tests in my repo and run the test suite.",
    {
      route: "spawn_coding_agent",
      requiredTools: ["spawn_coding_agent"],
      forbiddenTools: ["spawn_agent", "send_ack"],
      acknowledgement: "forbidden",
    },
  ),
  evaluationCase(
    "coding-build-02",
    "coding",
    "Build me an iMessage appointment-booking agent.",
    {
      route: "spawn_coding_agent",
      requiredTools: ["spawn_coding_agent"],
      forbiddenTools: ["spawn_agent", "send_ack"],
      acknowledgement: "forbidden",
    },
  ),
  evaluationCase(
    "coding-deploy-03",
    "coding",
    "Deploy the landing page in my repository and give me the preview URL.",
    {
      route: "spawn_coding_agent",
      requiredTools: ["spawn_coding_agent"],
      forbiddenTools: ["spawn_agent", "send_ack"],
      acknowledgement: "forbidden",
    },
  ),

  evaluationCase(
    "memory-remember-01",
    "memory",
    "Remember that I prefer aisle seats on flights.",
    {
      route: "direct",
      requiredTools: ["remember_memory"],
      forbiddenTools: NO_WORKER_TOOLS,
      acknowledgement: "forbidden",
    },
    { memoryEnabled: true },
  ),
  evaluationCase(
    "memory-recall-02",
    "memory",
    "What did we decide to call Project Atlas?",
    {
      route: "direct",
      requiredTools: ["recall"],
      forbiddenTools: NO_WORKER_TOOLS,
      acknowledgement: "forbidden",
    },
    { memoryEnabled: true },
  ),
  evaluationCase(
    "memory-update-03",
    "memory",
    "Update your memory: I go by Rowan now, not River.",
    {
      route: "direct",
      requiredTools: ["update_memory", "update_memory"],
      forbiddenTools: NO_WORKER_TOOLS,
      acknowledgement: "forbidden",
    },
    { memoryEnabled: true },
  ),
  evaluationCase(
    "memory-forget-04",
    "memory",
    "Forget my saved aisle-seat preference.",
    {
      route: "direct",
      requiredTools: ["forget_memory"],
      forbiddenTools: NO_WORKER_TOOLS,
      acknowledgement: "forbidden",
    },
    { memoryEnabled: true },
  ),

  evaluationCase(
    "draft-send-01",
    "draft",
    "Send it.",
    {
      route: "direct",
      requiredTools: ["list_drafts", "send_draft"],
      forbiddenTools: NO_WORKER_TOOLS,
      acknowledgement: "optional",
    },
    {
      priorTurns: [
        { role: "user", content: "Draft a short project update for the team." },
        {
          role: "assistant",
          content: "The project update draft is ready for approval.",
        },
      ],
      integrations: DEFAULT_INTEGRATIONS,
    },
  ),
  evaluationCase(
    "draft-reject-02",
    "draft",
    "Never mind, cancel that draft.",
    {
      route: "direct",
      requiredTools: ["list_drafts", "reject_draft"],
      forbiddenTools: NO_WORKER_TOOLS,
      acknowledgement: "forbidden",
    },
    {
      priorTurns: [
        {
          role: "assistant",
          content: "I prepared the calendar-event draft for approval.",
        },
      ],
      integrations: DEFAULT_INTEGRATIONS,
    },
  ),
  evaluationCase(
    "draft-list-03",
    "draft",
    "What drafts are waiting for my approval?",
    {
      route: "direct",
      requiredTools: ["list_drafts"],
      forbiddenTools: NO_WORKER_TOOLS,
      acknowledgement: "forbidden",
    },
  ),

  evaluationCase(
    "automation-create-01",
    "automation",
    "Every weekday at 8 AM, send me a weather summary.",
    {
      route: "direct",
      requiredTools: ["get_config", "create_automation"],
      forbiddenTools: NO_WORKER_TOOLS,
      acknowledgement: "optional",
    },
    { integrations: DEFAULT_INTEGRATIONS },
  ),
  evaluationCase(
    "automation-list-02",
    "automation",
    "What automations are running?",
    {
      route: "direct",
      requiredTools: ["list_automations"],
      forbiddenTools: NO_WORKER_TOOLS,
      acknowledgement: "forbidden",
    },
  ),
  evaluationCase(
    "automation-pause-03",
    "automation",
    "Pause my weekday weather digest.",
    {
      route: "direct",
      requiredTools: ["list_automations", "toggle_automation"],
      forbiddenTools: NO_WORKER_TOOLS,
      acknowledgement: "forbidden",
    },
  ),
  evaluationCase(
    "automation-delete-04",
    "automation",
    "Delete my weekly project-summary automation.",
    {
      route: "direct",
      requiredTools: ["list_automations", "delete_automation"],
      forbiddenTools: NO_WORKER_TOOLS,
      acknowledgement: "forbidden",
    },
  ),

  evaluationCase(
    "image-direct-01",
    "image",
    "What does this error message mean?",
    {
      route: "direct",
      requiredTools: [],
      forbiddenTools: NO_WORKER_TOOLS,
      acknowledgement: "forbidden",
    },
    {
      images: [
        {
          storageId: "fixture_image_error",
          mediaType: "image/png",
          description:
            "A synthetic screenshot reading: Connection timed out after 30 seconds.",
        },
      ],
    },
  ),
  evaluationCase(
    "image-no-caption-02",
    "image",
    "",
    {
      route: "direct",
      requiredTools: [],
      forbiddenTools: NO_WORKER_TOOLS,
      acknowledgement: "forbidden",
    },
    {
      images: [
        {
          storageId: "fixture_image_uncaptioned",
          mediaType: "image/png",
          description:
            "An intentionally ambiguous synthetic photo with no caption.",
        },
      ],
    },
  ),
  evaluationCase(
    "image-live-03",
    "image",
    "Look up whether this pictured plant is toxic to cats.",
    {
      route: "spawn_agent",
      requiredTools: ["send_ack", "spawn_agent"],
      forbiddenTools: ["spawn_coding_agent"],
      acknowledgement: "required",
    },
    {
      integrations: DEFAULT_INTEGRATIONS,
      images: [
        {
          storageId: "fixture_image_plant",
          mediaType: "image/png",
          description:
            "A synthetic houseplant photo labeled as a peace lily fixture.",
        },
      ],
    },
  ),
  evaluationCase(
    "image-remember-04",
    "image",
    "Remember this image for later.",
    {
      route: "direct",
      requiredTools: ["remember_image"],
      forbiddenTools: NO_WORKER_TOOLS,
      acknowledgement: "forbidden",
    },
    {
      memoryEnabled: true,
      images: [
        {
          storageId: "fixture_image_memory",
          mediaType: "image/png",
          description:
            "A synthetic diagram the user explicitly wants retained.",
        },
      ],
    },
  ),

  evaluationCase(
    "proactive-deadline-01",
    "proactive_notice",
    "[proactive notice] A reply from the venue needs an answer by 3 PM.",
    {
      route: "direct",
      requiredTools: [],
      forbiddenTools: ["send_ack", ...NO_WORKER_TOOLS],
      acknowledgement: "forbidden",
    },
    { kind: "proactive", memoryEnabled: false },
  ),
  evaluationCase(
    "proactive-travel-02",
    "proactive_notice",
    "[proactive notice] Your flight schedule changed; departure is now 6:40 PM.",
    {
      route: "direct",
      requiredTools: [],
      forbiddenTools: ["send_ack", ...NO_WORKER_TOOLS],
      acknowledgement: "forbidden",
    },
    { kind: "proactive", memoryEnabled: false },
  ),

  evaluationCase(
    "pending-coding-number-01",
    "pending_coding_question",
    "2",
    {
      route: "pending_coding_question",
      requiredTools: [],
      forbiddenTools: ["send_ack", ...NO_WORKER_TOOLS],
      acknowledgement: "forbidden",
      pendingAnswer: "accepted",
    },
    {
      pendingCodingQuestion: {
        options: ["Convex", "Supabase"],
        allowFreeform: false,
      },
    },
  ),
  evaluationCase(
    "pending-coding-label-02",
    "pending_coding_question",
    "Convex",
    {
      route: "pending_coding_question",
      requiredTools: [],
      forbiddenTools: ["send_ack", ...NO_WORKER_TOOLS],
      acknowledgement: "forbidden",
      pendingAnswer: "accepted",
    },
    {
      pendingCodingQuestion: {
        options: ["Convex", "Supabase"],
        allowFreeform: false,
      },
    },
  ),
  evaluationCase(
    "pending-coding-invalid-03",
    "pending_coding_question",
    "4",
    {
      route: "pending_coding_question",
      requiredTools: [],
      forbiddenTools: ["send_ack", ...NO_WORKER_TOOLS],
      acknowledgement: "forbidden",
      pendingAnswer: "rejected",
    },
    {
      pendingCodingQuestion: {
        options: ["Convex", "Supabase"],
        allowFreeform: false,
      },
    },
  ),
] as const satisfies readonly DispatcherEvaluationCase[];
