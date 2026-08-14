# Architecture

daniel-agent is a single-server personal agent with a strict dispatcher/worker split. The interaction agent owns routing and user-facing wording; workers do tool-heavy execution.

## System Map

```
Photon Spectrum / POST /chat
          |
          v
server/interaction-agent.ts
  Daniel voice, automatic memory hydration, routing, draft/automation/self tools
          |
          +--> answer directly
          |
          +--> spawn_agent
          |      server/execution-agent.ts
          |      Composio / local browser / draft staging
          |
          +--> spawn_coding_agent
                 server/coding-agent.ts
                 Codex daniel-full workspace

          +--> Convex
          |      transcript, application state, durable memory outbox,
          |      migration ledger, image anchors, provider status
          |
          +--> server/memory/supermemory/ (server-only adapter)
                 SuperMemory profile, search, documents, exact operations
```

Convex stores application state and synchronization state. SuperMemory stores
and retrieves long-term semantic memory.

Convex remains Daniel's durable database and realtime coordination layer; it
is not replaced by this migration. The raw transcript, recent prompt history,
files, agents, coding state, drafts, automations, settings, usage, and all
memory synchronization control state remain in Convex. SuperMemory owns user
profiles, semantic retrieval, extracted memories, versions, contradiction
handling, forgetting, deduplication, consolidation, and memory relationships.

## Interaction Agent

`server/interaction-agent.ts` is the front door for each user turn.

- Reads the inbound message, recent history, current images, and relevant runtime settings.
- Uses the shared Daniel voice prompt from `server/prompts/daniel-voice.ts`.
- Can call memory tools, normal worker spawn, coding worker spawn, automation tools, draft decision tools, and self-inspection tools.
- Cannot directly use shell, files, web browsing, or third-party integrations. Those capabilities live behind workers.
- Rewrites worker output into Daniel voice by default, including coding results unless the user explicitly chooses `raw_codex`.

Tool surface:

| Tool family | Purpose |
|---|---|
| `daniel-memory` | `recall`, `write_memory`, `update_memory`, `forget_memory`, `remember_image` |
| `daniel-spawn` | `spawn_agent` for normal work |
| `daniel-coding` | `spawn_coding_agent` for software work |
| `daniel-automations` | create/list/toggle/delete recurring work |
| `daniel-draft-decisions` | list/send/reject staged external actions |
| `daniel-self` | runtime/model/timezone/integration self-inspection |
| `daniel-ack` | explicit progress acknowledgements |

## Normal Workers

`server/execution-agent.ts` runs focused non-coding tasks.

- Receives the task written by the interaction agent, not the raw user message.
- Loads only the requested integration modules.
- Gets Composio toolkits through `server/composio.ts` and optional local browser tools through `server/browser/`.
- Stages external writes with `save_draft`; only the interaction agent's `send_draft` path commits.
- Logs tool use, tool results, text, runtime, usage, and status into Convex.

## Coding Bridge

`server/coding-agent.ts` treats Codex as a worker for build/debug/follow-up work.

- Creates or reuses a project workspace under `DANIEL_PROJECTS_ROOT` through `server/coding/workspace.ts`.
- Stores project/session/event/pending-input state in Convex.
- Runs Codex with `codexProfile: "daniel-full"` so coding work has workspace-write access and network access inside the project workspace.
- Passes explicit Codex collaboration mode on every coding turn:
  - initial auto-plan: `plan`
  - plan-approved build: `default`
  - direct build/debug: `default`
  - pending-answer follow-up: `default`
- Uses explicit Daniel developer instructions for both `plan` and `default` collaboration modes through `buildCodexCollaborationMode()` in `server/runtimes/codex-app-server.ts`.
- Formats coding questions as Daniel asking for a decision, not as raw Codex.

Coding response style lives in `server/coding/response-style.ts` and is stored in `convex/codingPreferences.ts` under `coding_response_style`.

| Style | Behavior |
|---|---|
| `daniel_summary` | Default. Daniel summarizes the worker result in user-facing language. |
| `detailed` | Daniel keeps his voice but includes more technical detail. |
| `raw_codex` | Opt-in only. Returns captured Codex output directly. |

## Runtime Profiles

`server/runtimes/` adapts Daniel's common runtime contract to Claude Agent SDK and Codex app-server.

- Dispatcher/background Codex turns use the safe read-only profile.
- Normal execution runs are worker-scoped and still go through the dispatcher gate.
- Coding runs use the `daniel-full` Codex profile with `workspace-write` because code edits are the point of that worker.
- Codex local browser tools are exposed internally as `local_browser` to avoid reserved browser namespaces.

## Memory And Images

`server/memory/supermemory/` is the only provider boundary. `client.ts` owns
the SDK client and normalized profile/search/capture methods;
`operations.ts` owns typed direct create, versioned update, exact forget, and
image/document operations. Routes, tools, workers, migration scripts, and the
dashboard do not import the SuperMemory SDK or call provider endpoints
directly. The API key stays server-only.

Identity and isolation:

- One memory owner maps to one SuperMemory container shared across that
  owner's conversations; a conversation never gets its own user container.
- `memoryOwnerId` and `conversationId` stay separate. Normalized source IDs
  are HMAC-SHA256-derived with `DANIEL_MEMORY_ID_SALT` into a 32-character
  `ownerKey` and `conversationKey`.
- Provider identifiers are private and deterministic:
  `daniel-user-${ownerKey}` for the container and
  `daniel-conv-${conversationKey}` for the conversation document key. A raw
  phone number is never sent as a provider identifier.
- Convex stores a salt fingerprint. Changing the salt after initialization is
  treated as a deployment-breaking configuration error, not as a new empty
  user.

Read path:

In `shadow` and `supermemory` read modes:

1. Convex persists the inbound message and supplies the recent ten-message
   prompt history.
2. Before the dispatcher runs, Daniel derives and validates the private owner
   container.
3. A single SuperMemory profile call hydrates static profile facts,
   recent/dynamic context, and query-relevant memories for the current
   message.
4. Daniel bounds and formats the result before injecting it into the prompt.
   Provider timeouts and errors fail open so the turn can continue.
5. The optional `recall` tool performs a second, narrower provider search.

Write path:

In `dual` and `supermemory` write modes:

1. Convex remains the authoritative raw transcript store.
2. After a completed user/assistant exchange is delivered, Daniel builds only
   that turn's normalized delta (`delta_turn_v1`), never a growing full
   transcript document.
3. The delta is inserted into the durable Convex `memorySyncJobs` outbox with
   a stable conversation key and SHA-256 payload hash.
4. The sync worker claims the job with a lease, initializes the owner
   container, submits through the adapter, records provider IDs before final
   completion, and applies bounded retries or dead-lettering.
5. A job already recorded as submitted resumes at Convex completion without
   another provider call.

Explicit memory operations use the same owner scope. `write_memory` creates an
exact provider memory, and `update_memory` selects an exact provider ID and
creates a new provider version. Broad forgetting is deliberately two-stage:
the first call previews semantic candidates and stores the exact IDs in
`memoryPendingOperations`; after user confirmation, the second call forgets
only those stored IDs without rerunning the semantic query.

Image ingestion and cleanup live in `server/imessage.ts` and `server/images/`.

- Photon Spectrum attachments are MIME/size checked before upload to Convex storage.
- Runtime content-block helpers convert stored images for Claude and Codex.
- `DANIEL_IMAGE_RETENTION_DAYS` and `DANIEL_IMAGE_CLEANUP_INTERVAL_MS` control raw image cleanup.
- Ordinary images are not uploaded to long-term memory. A durable image must
  be explicitly requested, identified as a durable object, or selected by the
  `remember_image` tool.
- `memoryImageAnchors` retain Convex bytes while an upload is pending or its
  provider document is active. Provider errors fail safe by retaining bytes.
  An anchor becomes `released` only after provider deletion is confirmed, and
  only then may normal retention cleanup remove the file.

## Migration Modes And Rollback

Read and write modes are intentionally independent:

| Setting | Value | Behavior |
|---|---|---|
| `DANIEL_MEMORY_READ_MODE` | `convex` | Legacy Convex recall is user-facing. |
|  | `shadow` | Convex remains user-facing while SuperMemory hydration runs for comparison. |
|  | `supermemory` | SuperMemory profile/search is user-facing. Optional legacy fallback is limited to provider failures during burn-in. |
| `DANIEL_MEMORY_WRITE_MODE` | `convex` | Legacy Convex memory writes only. |
|  | `dual` | Legacy writes stay current while completed turn deltas also enter the SuperMemory outbox. |
|  | `supermemory` | SuperMemory capture and exact operations only; the legacy semantic store is frozen. |

The staged rollout and rollback posture is:

1. **Before migration:** `convex` reads and `convex` writes. Rollback is a flag
   reset to the same state.
2. **Shadow evaluation:** `shadow` reads and `dual` writes. SuperMemory is
   measured while Convex remains user-facing; rollback uses `convex`/`dual`.
3. **Seven-day read burn-in:** `supermemory` reads and `dual` writes. The
   legacy store remains current, so immediate read rollback is still
   `convex`/`dual`.
4. **Write cutover:** `supermemory` reads and `supermemory` writes, with legacy
   fallback disabled. Legacy tables are frozen and become stale; recovery
   should repair SuperMemory or replay/reconcile completed outbox jobs.
5. **Thirty-day retention:** keep the frozen legacy tables and the immutable,
   checksummed export for at least 30 days. Do not delete legacy rows during
   dashboard rollout.
6. **After decommission:** rollback requires reverting the decommission
   change, restoring the legacy schema/functions from the immutable export,
   and replaying or reconciling data. It is no longer a feature-flag-only
   operation.

Legacy memory migration exports `memoryRecords`, `memoryEvents`, and
`consolidationRuns` with row counts and SHA-256 checksums. Only active legacy
facts are created as exact SuperMemory memories; archived and pruned facts
remain export-only. Each active fact is mapped through `memoryMigrationRows`
using its content hash and returned provider ID, while legacy image references
create image anchors. Optional transcript backfill is disabled by default.
Migration verification must reconcile every active row as migrated or
explicitly skipped, report zero failed/pending/missing rows, verify anchors,
and prove selected facts are searchable without cross-user leakage before
cutover.

After the 30-day gate, legacy row deletion has one allowed order:

1. Delete all `memoryRecords` rows.
2. Delete all `memoryEvents` rows.
3. Delete all `consolidationRuns` rows.
4. Verify all three tables are empty.
5. Remove their Convex functions.
6. Remove their schema definitions.
7. Regenerate Convex types, deploy, and only then delete retired server files.

Convex and the new control-plane tables remain permanent application
infrastructure after legacy semantic tables are removed.

## Automations And Proactive Email

Automations are created by `server/automation-tools.ts` and run by `server/automations.ts`.

- `create_automation` stores 5-field cron schedules.
- Schedules are evaluated in the user's saved IANA timezone from `server/timezone-config.ts`.
- Pre-timezone rows fall back to the current user timezone at run time.
- Due automations spawn normal execution agents and can push results through Photon Spectrum.

Proactive email surfacing uses Composio webhooks.

- `server/composio-webhook.ts` manages Composio webhook subscription state.
- `server/proactive-email.ts` classifies Gmail events, checks `proactive_enabled`, uses the user's timezone, and dispatches selected notices to iMessage.
- `DANIEL_USER_PHONE` is the outbound target env var for proactive notices.

## Integrations And Browser

Composio integration state is handled by `server/composio.ts`, `server/composio-routes.ts`, and `server/integrations/composio-loader.ts`.

- `COMPOSIO_API_KEY` enables hosted OAuth and toolkit sessions.
- `COMPOSIO_USER_ID` defaults to `daniel-default`.
- Each worker spawn receives only the requested toolkit servers.

Local browser use is separate from Composio.

- The `browser` integration appears only when enabled in Settings.
- Browser state falls back to `DANIEL_BROWSER_*` env vars when no dashboard setting is stored.
- Local browser HTTP routes reject public tunnel requests before launching or controlling Chrome.
- Typed values are redacted before tool-use logs are persisted.

## Data Model

Read `convex/schema.ts` for exact validators and indexes.

| Table | Role |
|---|---|
| `messages` | iMessage/chat transcript, image refs, media errors |
| `conversations` | Per-thread metadata |
| `memorySyncJobs` | Durable provider outbox, retries, dead letters, provider IDs |
| `memoryProviderState` | Provider health, current modes, salt fingerprint, worker activity |
| `memoryMigrationRows` | Exact legacy-fact migration ledger and reconciliation state |
| `memoryPendingOperations` | Exact IDs and status for confirmed forget/update flows |
| `memoryImageAnchors` | Convex image-retention state tied to provider documents |
| `executionAgents` | Normal worker runs |
| `codingProjects` | Coding project/workspace state |
| `codingSessions` | Per-Codex coding turn state |
| `codingEvents` | Coding event log: plans, diffs, questions, final responses |
| `codingPendingInputs` | Pending user decisions for coding sessions |
| `codingPreferences` | Per-conversation coding prefs such as `coding_response_style` |
| `usageRecords` | Per-call usage/cost records, including historical legacy extraction/consolidation values |
| `agentLogs` | Normal worker audit trail |
| `automations` | Scheduled recurring tasks, including timezone |
| `automationRuns` | Execution history for automations |
| `messageDedup` | Inbound Photon/Spectrum dedup keys |
| `drafts` | Staged external actions |
| `settings` | Runtime/model/browser/timezone/proactive settings |

The following tables are **legacy migration data**, not current SuperMemory
state: `memoryRecords` (tiered facts and embeddings), `memoryEvents` (legacy
memory events), and `consolidationRuns` (legacy local consolidation). They are
kept read-only for the 30-day rollback window and removed only by the ordered
decommission procedure above.

## Message Lifecycle

Normal work:

```
1. Photon Spectrum yields an inbound iMessage.
2. server/imessage.ts dedupes, stores images, and calls handleUserMessage().
3. interaction-agent stores the user message and loads the recent Convex transcript.
4. Daniel automatically hydrates the owner's SuperMemory profile and relevant memory.
5. execution-agent runs with scoped tools and returns a technical result.
6. interaction-agent writes Daniel's final reply.
7. imessage.ts sends the reply and Convex stores/broadcasts it.
8. Convex enqueues the completed turn delta in `memorySyncJobs`.
9. The sync worker submits it to SuperMemory and records completion or retry state.
```

Coding work:

```
1. interaction-agent routes software work to spawn_coding_agent.
2. coding-agent creates/reuses a workspace and records coding project/session rows.
3. Codex runs in plan mode only for the first auto-plan turn.
4. Build/debug/follow-up turns run Codex in default collaboration mode.
5. Pending Codex questions are persisted and resumed by user answer.
6. interaction-agent applies the coding response style and writes the final user-facing reply.
```

## Why This Shape

**Daniel voice stays centralized.** Workers can be technical and terse because the interaction agent owns the final user-facing wording.

**Tool access is intentional.** The dispatcher cannot directly mutate the outside world or the filesystem. External actions go through workers and drafts; coding writes go through the coding bridge.

**Convex is the coordination layer.** It stores transcripts, runtime settings,
worker logs, coding state, drafts, automations, files, the memory outbox,
migration state, anchors, and dashboard health. SuperMemory is the semantic
memory system, not the application database.

**Provider adapters stay replaceable.** Claude and Codex share Daniel's runtime contract, while provider-specific details stay in `server/runtimes/`.

**Memory provider calls stay centralized.** SuperMemory-specific SDK and HTTP
details stay behind `server/memory/supermemory/`; no route, UI, tool, or
unrelated server module calls the provider directly.

## What's Intentionally Missing

- Multi-user auth. This is still a single-user template.
- Distributed scheduler locks. Multiple deployed server instances can double-fire automations without an added lock.
- General unrestricted agent filesystem access. Workspace writes are reserved for the coding bridge.
