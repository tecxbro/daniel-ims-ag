import { api } from "../convex/_generated/api.js";
import type { Doc, Id } from "../convex/_generated/dataModel.js";
import { convex } from "./convex-client.js";
import { getCodexRuntimeConfig, type RuntimeConfig } from "./runtime-config.js";
import { runAgentRuntime } from "./runtimes/index.js";
import {
  isCodexUserInputRequiredError,
} from "./runtimes/codex-app-server.js";
import { EMPTY_USAGE, type UsageTotals } from "./usage.js";
import { DANIEL_CODING_DEVELOPER_PROMPT } from "./coding/developer-prompt.js";
import {
  inferProjectTitle,
  randomProjectKey,
  setupCodingWorkspace,
  workspacePathForProjectKey,
} from "./coding/workspace.js";

export type SpawnCodingMode = "auto" | "plan" | "build" | "debug";
export type ResolvedCodingMode = "plan" | "build" | "debug";
export type CodingTurnMode = "plan" | "build" | "debug" | "followup";
export type CodingCollaborationMode = "plan" | "default";

type CodingProjectDoc = Doc<"codingProjects">;

export interface SpawnCodingAgentOptions {
  task: string;
  conversationId: string;
  projectHint?: string;
  repoUrl?: string;
  branch?: string;
  mode: SpawnCodingMode;
  runtimeConfig?: RuntimeConfig;
}

export interface SpawnCodingAgentResult {
  projectId: string;
  sessionId: string;
  codexThreadId: string;
  status: "completed" | "failed" | "waiting_for_user";
  result: string;
}

export interface ContinueCodingAgentResult {
  projectId?: string;
  sessionId?: string;
  codexThreadId?: string;
  status: "completed" | "failed" | "waiting_for_user";
  result: string;
}

interface CodingTurnResult {
  status: "completed" | "failed" | "waiting_for_user";
  text: string;
  codexThreadId: string;
  usage: UsageTotals;
}

export function resolveCodingMode(
  task: string,
  requested: SpawnCodingMode = "auto",
): ResolvedCodingMode {
  if (requested === "plan" || requested === "build" || requested === "debug") {
    return requested;
  }

  const normalized = task.toLowerCase();
  if (/\b(fix|debug|error|failing|broken|bug|webhook|stack trace|test failure)\b/.test(normalized)) {
    return "debug";
  }
  if (
    /\b(build|create|make|scaffold|new app|from scratch|set up|setup|architecture|major feature|landing page|dashboard|backend|auth|database|deploy)\b/.test(
      normalized,
    )
  ) {
    return "plan";
  }
  return "build";
}

export function codexCollaborationModeForCodingTurn(
  mode: CodingTurnMode,
): CodingCollaborationMode {
  return mode === "plan" ? "plan" : "default";
}

export function formatPlanMessage(plan: {
  explanation: string | null;
  plan: Array<{ step: string; status: string }>;
}): string {
  const lines = ["Plan:"];
  if (plan.explanation?.trim()) lines.push("", plan.explanation.trim());
  for (const step of plan.plan) {
    lines.push(`- ${step.step}`);
  }
  return lines.join("\n").trim();
}

export function formatCodingQuestionForMessage(input: {
  questions: Array<{
    id: string;
    header: string;
    question: string;
    isOther: boolean;
    options: Array<{ label: string; description: string }> | null;
  }>;
}): { message: string; question: string; options?: string[]; allowFreeform: boolean } {
  const first = input.questions[0];
  if (!first) {
    return {
      message: "I need one decision. Reply with the missing detail.",
      question: "I need one decision.",
      allowFreeform: true,
    };
  }
  const options = first.options?.map((option) => option.label).filter(Boolean);
  const lines = ["I need one decision:", "", first.question.trim()];
  if (options?.length) {
    lines.push("");
    options.forEach((option, index) => lines.push(`${index + 1}. ${option}`));
    lines.push("", "Reply with a number, or write your own answer.");
  } else {
    lines.push("", "Reply with your answer.");
  }
  return {
    message: lines.join("\n"),
    question: first.question,
    options: options?.length ? options : undefined,
    allowFreeform: first.isOther || !options?.length,
  };
}

export function parsePendingInputAnswer(input: {
  content: string;
  options?: string[];
  allowFreeform: boolean;
}): { ok: true; answer: string } | { ok: false; message: string } {
  const trimmed = input.content.trim();
  if (!trimmed) {
    return { ok: false, message: "Reply with an answer so I can continue." };
  }

  const numeric = trimmed.match(/^\d+$/);
  if (numeric && input.options?.length) {
    const index = Number(trimmed) - 1;
    if (index >= 0 && index < input.options.length) {
      return { ok: true, answer: input.options[index] };
    }
  }

  const exact = input.options?.find(
    (option) => option.toLowerCase() === trimmed.toLowerCase(),
  );
  if (exact) return { ok: true, answer: exact };
  if (input.allowFreeform) return { ok: true, answer: trimmed };

  return {
    ok: false,
    message: `Reply with ${input.options?.map((_, i) => i + 1).join(", ") || "one of the choices"}.`,
  };
}

function jsonPayload(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > 12_000 ? `${text.slice(0, 12_000)}...` : text;
}

async function appendCodingEvent(args: {
  projectId: Id<"codingProjects">;
  sessionId: Id<"codingSessions">;
  type:
    | "codex_thread_started"
    | "plan_delta"
    | "plan_final"
    | "question_requested"
    | "user_answered"
    | "tool_event"
    | "file_change"
    | "diff"
    | "final_response"
    | "error";
  payload: unknown;
}): Promise<void> {
  await convex.mutation(api.codingEvents.appendCodingEvent, {
    projectId: args.projectId,
    sessionId: args.sessionId,
    type: args.type,
    payload: jsonPayload(args.payload),
  });
}

async function getOrCreateProject(opts: SpawnCodingAgentOptions): Promise<CodingProjectDoc> {
  const existing = await convex.query(api.codingProjects.getActiveProjectForConversation, {
    conversationId: opts.conversationId,
    repoUrl: opts.repoUrl,
  });
  if (existing) {
    await setupCodingWorkspace({
      projectKey: existing.projectKey,
      repoUrl: existing.repoUrl,
      branch: existing.branch,
    });
    return existing;
  }

  const projectKey = randomProjectKey();
  const title = inferProjectTitle({
    task: opts.task,
    projectHint: opts.projectHint,
    repoUrl: opts.repoUrl,
  });
  const workspacePath = workspacePathForProjectKey(projectKey);
  const projectId = await convex.mutation(api.codingProjects.createProject, {
    projectKey,
    conversationId: opts.conversationId,
    title,
    repoUrl: opts.repoUrl,
    branch: opts.branch,
    workspacePath,
  });
  await setupCodingWorkspace({
    projectKey,
    repoUrl: opts.repoUrl,
    branch: opts.branch,
  });
  const project = await convex.query(api.codingProjects.get, { projectId });
  if (!project) throw new Error(`Created coding project missing: ${projectId}`);
  return project;
}

async function recordCodingUsage(args: {
  conversationId: string;
  sessionId: string;
  runtimeConfig: RuntimeConfig;
  usage: UsageTotals;
  durationMs: number;
}): Promise<void> {
  if (args.usage.costUsd === 0 && args.usage.inputTokens === 0) return;
  await convex.mutation(api.usageRecords.record, {
    source: "coding",
    conversationId: args.conversationId,
    agentId: args.sessionId,
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

async function runCodingTurn(args: {
  project: CodingProjectDoc;
  sessionId: Id<"codingSessions">;
  prompt: string;
  codexThreadId?: string;
  collaborationMode: CodingCollaborationMode;
}): Promise<CodingTurnResult> {
  const runtimeConfig = await getCodexRuntimeConfig();
  const startedAt = Date.now();
  let threadId = args.codexThreadId ?? args.project.lastCodexThreadId ?? "";
  let latestPlanText = "";
  let waitingMessage = "";
  let usage: UsageTotals = { ...EMPTY_USAGE, model: runtimeConfig.model };

  try {
    const result = await runAgentRuntime(runtimeConfig, {
      prompt: args.prompt,
      systemPrompt: DANIEL_CODING_DEVELOPER_PROMPT,
      mode: "coding",
      cwd: args.project.workspacePath,
      tools: [],
      codexProfile: "daniel-full",
      codexThreadId: threadId || undefined,
      codexCollaborationMode: args.collaborationMode,
      onThreadStart: async (nextThreadId) => {
        threadId = nextThreadId;
        await convex.mutation(api.codingSessions.updateSessionStatus, {
          sessionId: args.sessionId,
          codexThreadId: nextThreadId,
        });
        await convex.mutation(api.codingProjects.updateProjectStatus, {
          projectId: args.project._id,
          lastCodexThreadId: nextThreadId,
        });
        await appendCodingEvent({
          projectId: args.project._id,
          sessionId: args.sessionId,
          type: "codex_thread_started",
          payload: { codexThreadId: nextThreadId },
        });
      },
      onPlanDelta: async (event) => {
        await appendCodingEvent({
          projectId: args.project._id,
          sessionId: args.sessionId,
          type: "plan_delta",
          payload: event,
        });
      },
      onPlanUpdate: async (event) => {
        latestPlanText = formatPlanMessage(event);
        await appendCodingEvent({
          projectId: args.project._id,
          sessionId: args.sessionId,
          type: "plan_final",
          payload: event,
        });
      },
      onUserInputRequest: async (event) => {
        const formatted = formatCodingQuestionForMessage({
          questions: event.questions,
        });
        waitingMessage = formatted.message;
        await convex.mutation(api.codingPendingInputs.createPendingInput, {
          projectId: args.project._id,
          sessionId: args.sessionId,
          conversationId: args.project.conversationId,
          codexRequestId: event.requestId,
          codexQuestionId: event.questions[0]?.id,
          question: formatted.question,
          questionsJson: jsonPayload(event.questions),
          options: formatted.options,
          allowFreeform: formatted.allowFreeform,
        });
        await convex.mutation(api.codingSessions.updateSessionStatus, {
          sessionId: args.sessionId,
          status: "waiting_for_user",
        });
        await convex.mutation(api.codingProjects.updateProjectStatus, {
          projectId: args.project._id,
          status: "waiting_for_user",
        });
        await appendCodingEvent({
          projectId: args.project._id,
          sessionId: args.sessionId,
          type: "question_requested",
          payload: { message: waitingMessage, request: event },
        });
        return null;
      },
      onToolUse: async (toolName, input) => {
        await appendCodingEvent({
          projectId: args.project._id,
          sessionId: args.sessionId,
          type: "tool_event",
          payload: { toolName, input },
        });
      },
      onRuntimeEvent: async (type, payload) => {
        await appendCodingEvent({
          projectId: args.project._id,
          sessionId: args.sessionId,
          type,
          payload,
        });
      },
      onUsage: (nextUsage) => {
        usage = nextUsage;
      },
    });
    usage = result.usage;
    const text = result.text.trim() || latestPlanText || "Done.";
    await recordCodingUsage({
      conversationId: args.project.conversationId,
      sessionId: String(args.sessionId),
      runtimeConfig,
      usage,
      durationMs: Date.now() - startedAt,
    });
    return { status: "completed", text, codexThreadId: threadId, usage };
  } catch (err) {
    await recordCodingUsage({
      conversationId: args.project.conversationId,
      sessionId: String(args.sessionId),
      runtimeConfig,
      usage,
      durationMs: Date.now() - startedAt,
    });
    if (isCodexUserInputRequiredError(err)) {
      return {
        status: "waiting_for_user",
        text: waitingMessage || "I need one decision before I can continue.",
        codexThreadId: threadId,
        usage,
      };
    }
    await appendCodingEvent({
      projectId: args.project._id,
      sessionId: args.sessionId,
      type: "error",
      payload: { error: String(err) },
    });
    return {
      status: "failed",
      text: `Coding run failed: ${String(err)}`,
      codexThreadId: threadId,
      usage,
    };
  }
}

async function createCodingSession(args: {
  project: CodingProjectDoc;
  mode: CodingTurnMode;
  codexThreadId?: string;
}): Promise<Id<"codingSessions">> {
  return await convex.mutation(api.codingSessions.createSession, {
    projectId: args.project._id,
    conversationId: args.project.conversationId,
    mode: args.mode,
    workspacePath: args.project.workspacePath,
    codexThreadId: args.codexThreadId,
  });
}

function planPrompt(task: string): string {
  return [
    "Create a concise implementation plan for this coding task.",
    "Use plan mode. Ask user-input questions only when a decision materially changes the implementation.",
    "Default to Convex for database/state unless the user asked otherwise.",
    "For conversational or messaging interactions, use Photon/Spectrum.",
    "",
    `Task: ${task}`,
  ].join("\n");
}

function buildPrompt(task: string, plan?: string): string {
  return [
    plan
      ? "Implement the approved plan below end to end. Keep the final answer concise."
      : "Implement this coding task end to end. Keep the final answer concise.",
    "Run focused verification before finishing when the project supports it.",
    "",
    plan ? `Plan:\n${plan}\n` : "",
    `Task: ${task}`,
  ].join("\n");
}

export async function spawnCodingAgent(
  opts: SpawnCodingAgentOptions,
): Promise<SpawnCodingAgentResult> {
  const project = await getOrCreateProject(opts);
  const mode = resolveCodingMode(opts.task, opts.mode);
  await convex.mutation(api.codingProjects.updateProjectStatus, {
    projectId: project._id,
    status: mode === "plan" ? "planning" : "building",
  });

  if (mode === "plan") {
    const planSessionId = await createCodingSession({ project, mode: "plan" });
    const planResult = await runCodingTurn({
      project,
      sessionId: planSessionId,
      prompt: planPrompt(opts.task),
      collaborationMode: codexCollaborationModeForCodingTurn("plan"),
    });
    if (planResult.status === "waiting_for_user") {
      return {
        projectId: String(project._id),
        sessionId: String(planSessionId),
        codexThreadId: planResult.codexThreadId,
        status: "waiting_for_user",
        result: planResult.text,
      };
    }
    if (planResult.status === "failed") {
      await convex.mutation(api.codingSessions.updateSessionStatus, {
        sessionId: planSessionId,
        status: "failed",
        error: planResult.text,
      });
      await convex.mutation(api.codingProjects.updateProjectStatus, {
        projectId: project._id,
        status: "failed",
      });
      return {
        projectId: String(project._id),
        sessionId: String(planSessionId),
        codexThreadId: planResult.codexThreadId,
        status: "failed",
        result: planResult.text,
      };
    }
    await convex.mutation(api.codingSessions.updateSessionStatus, {
      sessionId: planSessionId,
      status: "completed",
      finalSummary: planResult.text,
    });

    const buildSessionId = await createCodingSession({
      project,
      mode: "build",
      codexThreadId: planResult.codexThreadId,
    });
    await convex.mutation(api.codingProjects.updateProjectStatus, {
      projectId: project._id,
      status: "building",
    });
    const buildResult = await runCodingTurn({
      project,
      sessionId: buildSessionId,
      codexThreadId: planResult.codexThreadId,
      prompt: buildPrompt(opts.task, planResult.text),
      collaborationMode: codexCollaborationModeForCodingTurn("build"),
    });
    const finalStatus = buildResult.status === "completed" ? "completed" : buildResult.status;
    await convex.mutation(api.codingSessions.updateSessionStatus, {
      sessionId: buildSessionId,
      status: finalStatus,
      finalSummary: buildResult.status === "completed" ? buildResult.text : undefined,
      error: buildResult.status === "failed" ? buildResult.text : undefined,
    });
    await convex.mutation(api.codingProjects.updateProjectStatus, {
      projectId: project._id,
      status:
        buildResult.status === "waiting_for_user"
          ? "waiting_for_user"
          : buildResult.status === "completed"
            ? "completed"
            : "failed",
    });
    await appendCodingEvent({
      projectId: project._id,
      sessionId: buildSessionId,
      type: "final_response",
      payload: { result: buildResult.text },
    });
    return {
      projectId: String(project._id),
      sessionId: String(buildSessionId),
      codexThreadId: buildResult.codexThreadId,
      status: buildResult.status,
      result:
        buildResult.status === "completed"
          ? `Plan:\n${planResult.text}\n\nResult:\n${buildResult.text}`
          : buildResult.text,
    };
  }

  const sessionId = await createCodingSession({ project, mode });
  const result = await runCodingTurn({
    project,
    sessionId,
    prompt: buildPrompt(opts.task),
    collaborationMode: codexCollaborationModeForCodingTurn(mode),
  });
  await convex.mutation(api.codingSessions.updateSessionStatus, {
    sessionId,
    status: result.status,
    finalSummary: result.status === "completed" ? result.text : undefined,
    error: result.status === "failed" ? result.text : undefined,
  });
  await convex.mutation(api.codingProjects.updateProjectStatus, {
    projectId: project._id,
    status:
      result.status === "waiting_for_user"
        ? "waiting_for_user"
        : result.status === "completed"
          ? "completed"
          : "failed",
  });
  await appendCodingEvent({
    projectId: project._id,
    sessionId,
    type: "final_response",
    payload: { result: result.text },
  });
  return {
    projectId: String(project._id),
    sessionId: String(sessionId),
    codexThreadId: result.codexThreadId,
    status: result.status,
    result: result.text,
  };
}

export async function continueCodingAgentWithAnswer(opts: {
  conversationId: string;
  content: string;
}): Promise<ContinueCodingAgentResult | null> {
  const pending = await convex.query(
    api.codingPendingInputs.getPendingForConversation,
    { conversationId: opts.conversationId },
  );
  if (!pending) return null;

  const parsed = parsePendingInputAnswer({
    content: opts.content,
    options: pending.options,
    allowFreeform: pending.allowFreeform,
  });
  if (!parsed.ok) {
    return {
      status: "waiting_for_user",
      result: parsed.message,
    };
  }

  const previous = await convex.mutation(api.codingPendingInputs.answerPendingInput, {
    pendingInputId: pending._id,
    answer: parsed.answer,
  });
  if (!previous) return null;

  const project = await convex.query(api.codingProjects.get, {
    projectId: pending.projectId,
  });
  const session = await convex.query(api.codingSessions.get, {
    sessionId: pending.sessionId,
  });
  if (!project || !session) {
    return {
      status: "failed",
      result: "That coding session is no longer available.",
    };
  }

  await appendCodingEvent({
    projectId: pending.projectId,
    sessionId: pending.sessionId,
    type: "user_answered",
    payload: { answer: parsed.answer },
  });

  const followupSessionId = await createCodingSession({
    project,
    mode: "followup",
    codexThreadId: session.codexThreadId ?? project.lastCodexThreadId,
  });
  await convex.mutation(api.codingProjects.updateProjectStatus, {
    projectId: project._id,
    status: "building",
  });
  const result = await runCodingTurn({
    project,
    sessionId: followupSessionId,
    codexThreadId: session.codexThreadId ?? project.lastCodexThreadId,
    prompt: [
      "The user answered the pending planning/build question.",
      `Question: ${pending.question}`,
      `Answer: ${parsed.answer}`,
      "",
      "Continue the coding task from the same thread and finish the work.",
    ].join("\n"),
    collaborationMode: codexCollaborationModeForCodingTurn("followup"),
  });

  await convex.mutation(api.codingSessions.updateSessionStatus, {
    sessionId: followupSessionId,
    status: result.status,
    finalSummary: result.status === "completed" ? result.text : undefined,
    error: result.status === "failed" ? result.text : undefined,
  });
  await convex.mutation(api.codingProjects.updateProjectStatus, {
    projectId: project._id,
    status:
      result.status === "waiting_for_user"
        ? "waiting_for_user"
        : result.status === "completed"
          ? "completed"
          : "failed",
  });
  await appendCodingEvent({
    projectId: project._id,
    sessionId: followupSessionId,
    type: "final_response",
    payload: { result: result.text },
  });
  return {
    projectId: String(project._id),
    sessionId: String(followupSessionId),
    codexThreadId: result.codexThreadId,
    status: result.status,
    result: result.text,
  };
}
