export interface DispatcherHistoryTurn {
  turnId: string;
  user: { content: string };
  assistant: { content: string };
}

export type DispatcherTurnKind = "user" | "proactive";

/**
 * Formats complete, query-budgeted turns in chronological order.
 */
export function buildHistoryBlock(
  history: readonly DispatcherHistoryTurn[],
): string {
  return history
    .map(
      (turn) =>
        `USER: ${turn.user.content}\nASSISTANT: ${turn.assistant.content}`,
    )
    .join("\n\n");
}

export function buildTurnUserText(
  content: string,
  mediaError: string | undefined,
): string {
  return mediaError
    ? `[user sent images but they couldn't be downloaded: ${mediaError}]\n${content}`
    : content;
}

export function buildConversationPrompt(input: {
  kind: DispatcherTurnKind;
  historyBlock: string;
  userText: string;
}): string {
  if (input.kind === "proactive") {
    return `Standalone proactive notice. Write a concise user-facing iMessage from this notice only. Do not research, spawn agents, or continue any prior conversation.\n\n${input.userText}`;
  }
  return input.historyBlock
    ? `Prior turns:\n${input.historyBlock}\n\nCurrent message:\n${input.userText}`
    : input.userText;
}

export function composePreloadedMemoryPrompt(
  conversationPrompt: string,
  memoryContext: string | undefined,
): string {
  const context = memoryContext?.trim();
  return context ? `${context}\n\n${conversationPrompt}` : conversationPrompt;
}
