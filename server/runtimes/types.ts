import type { z } from "zod";
import type { UsageTotals } from "../usage.js";

export type RuntimeName = "claude" | "codex";
export type RuntimeReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type RuntimeMode = "dispatcher" | "execution" | "background" | "coding";
export type CodexRunnerProfile = "daniel-safe" | "daniel-full";

export type RuntimeImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
};
export type RuntimeTextBlock = { type: "text"; text: string };
export type RuntimePrompt = string | Array<RuntimeImageBlock | RuntimeTextBlock>;

export interface RuntimeTool {
  namespace: string;
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  jsonSchema: Record<string, unknown>;
  handle: (args: Record<string, unknown>) => Promise<RuntimeToolResult>;
}

export interface RuntimeToolResult {
  text: string;
  success?: boolean;
}

export interface RuntimeRunRequest {
  prompt: RuntimePrompt;
  systemPrompt: string;
  model: string;
  reasoningEffort?: RuntimeReasoningEffort;
  tools: RuntimeTool[];
  claudeMcpServers?: Record<string, unknown>;
  allowedTools?: string[];
  disallowedTools?: string[];
  cwd?: string;
  abortController?: AbortController;
  mode: RuntimeMode;
  codexProfile?: CodexRunnerProfile;
  codexThreadId?: string;
  codexCollaborationMode?: "plan" | "default";
  onText?: (text: string) => void | Promise<void>;
  onToolUse?: (toolName: string, input: unknown) => void | Promise<void>;
  onToolResult?: (toolName: string, text: string) => void | Promise<void>;
  onUsage?: (usage: UsageTotals) => void | Promise<void>;
  onThreadStart?: (threadId: string) => void | Promise<void>;
  onPlanDelta?: (event: {
    threadId: string;
    turnId: string;
    itemId: string;
    delta: string;
  }) => void | Promise<void>;
  onPlanUpdate?: (event: {
    threadId: string;
    turnId: string;
    explanation: string | null;
    plan: Array<{ step: string; status: string }>;
  }) => void | Promise<void>;
  onUserInputRequest?: (event: {
    requestId: string;
    threadId: string;
    turnId: string;
    itemId: string;
    questions: Array<{
      id: string;
      header: string;
      question: string;
      isOther: boolean;
      isSecret: boolean;
      options: Array<{ label: string; description: string }> | null;
    }>;
  }) => Promise<{ answers: Record<string, { answers: string[] }> } | null>;
  onRuntimeEvent?: (type: "file_change" | "diff", payload: unknown) => void | Promise<void>;
}

export interface RuntimeRunResult {
  text: string;
  usage: UsageTotals;
}

export function runtimeText(text: string, success = true): RuntimeToolResult {
  return { text, success };
}
