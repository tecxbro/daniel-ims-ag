/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agents from "../agents.js";
import type * as automations from "../automations.js";
import type * as codingEvents from "../codingEvents.js";
import type * as codingPendingInputs from "../codingPendingInputs.js";
import type * as codingPreferences from "../codingPreferences.js";
import type * as codingProjects from "../codingProjects.js";
import type * as codingSessions from "../codingSessions.js";
import type * as consolidation from "../consolidation.js";
import type * as conversations from "../conversations.js";
import type * as dashboard from "../dashboard.js";
import type * as demo from "../demo.js";
import type * as drafts from "../drafts.js";
import type * as memoryEvents from "../memoryEvents.js";
import type * as memoryRecords from "../memoryRecords.js";
import type * as messageDedup from "../messageDedup.js";
import type * as messages from "../messages.js";
import type * as settings from "../settings.js";
import type * as usageRecords from "../usageRecords.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agents: typeof agents;
  automations: typeof automations;
  codingEvents: typeof codingEvents;
  codingPendingInputs: typeof codingPendingInputs;
  codingPreferences: typeof codingPreferences;
  codingProjects: typeof codingProjects;
  codingSessions: typeof codingSessions;
  consolidation: typeof consolidation;
  conversations: typeof conversations;
  dashboard: typeof dashboard;
  demo: typeof demo;
  drafts: typeof drafts;
  memoryEvents: typeof memoryEvents;
  memoryRecords: typeof memoryRecords;
  messageDedup: typeof messageDedup;
  messages: typeof messages;
  settings: typeof settings;
  usageRecords: typeof usageRecords;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
