export { handleUserMessage } from "./dispatcher/turn.js";
export type { HandleOpts } from "./dispatcher/turn.js";

// Compatibility re-exports for existing tests, evaluation tooling, and callers.
export { buildInteractionSystemPrompt } from "./dispatcher/policy.js";
export { composePreloadedMemoryPrompt } from "./dispatcher/history.js";
export {
  resolveDirectRuntimeSwitch,
  resolveSpawnIntegrations,
} from "./dispatcher/gates.js";
export { resolveSpawnImageRefs } from "./dispatcher/tools.js";
