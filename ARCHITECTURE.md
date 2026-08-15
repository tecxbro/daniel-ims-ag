# Architecture

daniel-agent is a single-server personal agent with a strict
dispatcher/worker split. The interaction agent owns routing and user-facing
wording; workers do tool-heavy execution.

## System Map

```text
Photon Spectrum / POST /chat
          |
          v
server/interaction-agent.ts
  facade for server/dispatcher/turn.ts
  deterministic gates, then Daniel voice / SuperMemory / model routing
          |
          +--> answer directly
          |
          +--> spawn_agent
          |      server/execution-agent.ts
          |      Composio / local browser / draft staging
          |
          +--> spawn_coding_agent
          |      server/coding-agent.ts
          |      Codex daniel-full workspace
          |
          +--> Convex
          |      transcript, application state, conversation-turn outbox,
          |      image anchors, provider health and activity
          |
          +--> server/memory/supermemory/
                 profile, search, documents, exact operations
```

Convex is Daniel's application database and realtime coordination layer. It
stores the raw transcript, recent prompt history, files, agents, coding state,
drafts, automations, settings, usage, and memory synchronization control
state. SuperMemory is the only semantic-memory provider.

## Interaction Agent

`server/interaction-agent.ts` is the stable facade; `server/dispatcher/turn.ts`
is the front door for each user turn.

- Handles trusted proactive notices, pending coding answers, explicit runtime /
  model / timezone changes, disabled-browser requests, and simple configuration
  reads in code before loading history, hydrating memory, constructing tools, or
  calling the dispatcher model.
- For remaining turns, loads runtime settings, enabled integrations, bounded
  SuperMemory context, and recent history in parallel. History contains up to
  ten complete user/assistant turns before the current inbound message, is
  capped at 16,000 characters, truncates unusually large prior messages, and
  excludes acknowledgements, proactive notices, incomplete turns, and later
  concurrent turns.
- Uses the shared Daniel voice prompt from `server/prompts/daniel-voice.ts`.
- Can call memory tools, normal worker spawn, coding worker spawn, automation
  tools, draft decision tools, and self-inspection tools.
- Cannot directly use shell, files, web browsing, or third-party integrations.
  Those capabilities live behind workers.
- Rewrites newly spawned worker output into Daniel voice by default unless the
  user explicitly chooses `raw_codex`; pending coding continuations return the
  coding worker's already-final response directly.

Tool surface:

| Tool family | Purpose |
|---|---|
| `daniel-memory` | `recall`, `remember_memory`, `update_memory`, `forget_memory`, `remember_image` |
| `daniel-spawn` | `spawn_agent` for normal work |
| `daniel-coding` | `spawn_coding_agent` for software work |
| `daniel-automations` | create/list/toggle/delete recurring work |
| `daniel-draft-decisions` | list/send/reject staged external actions |
| `daniel-self` | runtime/model/timezone/integration self-inspection |
| `daniel-ack` | explicit progress acknowledgements |

## Normal Workers

`server/execution-agent.ts` runs focused non-coding tasks.

- Receives the task written by the interaction agent, not the raw user
  message.
- Loads only the requested integration modules.
- Gets Composio toolkits through `server/composio.ts` and optional local
  browser tools through `server/browser/`.
- Stages external writes with `save_draft`; only the interaction agent's
  `send_draft` path commits.
- Logs tool use, tool results, text, runtime, usage, and status into Convex.

## Coding Bridge

`server/coding-agent.ts` treats Codex as a worker for build, debug, and
follow-up work.

- Creates or reuses a project workspace under `DANIEL_PROJECTS_ROOT` through
  `server/coding/workspace.ts`.
- Stores project, session, event, and pending-input state in Convex.
- Runs Codex with `codexProfile: "daniel-full"` so coding work has
  workspace-write and network access inside the managed workspace.
- Uses plan collaboration mode only for an initial automatic plan. Approved
  builds, direct work, debugging, and pending-answer follow-ups use default
  collaboration mode.
- Formats coding questions as Daniel asking for a decision, not as raw Codex.

Coding response style lives in `server/coding/response-style.ts` and is stored
in `convex/codingPreferences.ts` under `coding_response_style`.

| Style | Behavior |
|---|---|
| `daniel_summary` | Default. Daniel summarizes the worker result in user-facing language. |
| `detailed` | Daniel keeps his voice but includes more technical detail. |
| `raw_codex` | Opt-in only. Returns captured Codex output directly. |

## Runtime Profiles

`server/runtimes/` adapts Daniel's common runtime contract to the Claude Agent
SDK and Codex app-server.

- Dispatcher and background Codex turns use the safe read-only profile.
- Normal execution runs are worker-scoped and still go through the dispatcher
  gate.
- Coding runs use the `daniel-full` profile with `workspace-write` because
  code edits are the point of that worker.
- Codex local browser tools are exposed internally as `local_browser` to
  avoid reserved browser namespaces.

## SuperMemory And Images

`server/memory/supermemory/service.ts` is a small typed façade over focused
context, provider, identity, capture, and explicit-operation modules. Routes,
tools, workers, and the dashboard use that boundary rather than importing the
SuperMemory SDK or calling provider endpoints directly. The API key stays
server-only.

### Configuration and isolation

- Each normalized sender maps to one private SuperMemory container shared
  across that sender's conversations. A conversation never becomes a user
  container.
- `memoryOwnerId` and `conversationId` stay separate. Source identifiers are
  HMAC-SHA256-derived with `DANIEL_MEMORY_ID_SALT` into opaque owner and
  conversation keys. Raw phone numbers are never provider identifiers.
- Convex stores a salt fingerprint. Setup generates a new salt only when no
  persisted fingerprint or primary owner exists. A missing or changed salt
  after identity state exists produces `recovery_required`; Daniel still
  persists and replies to messages, but makes no provider request and creates
  no memory job.
- Without `SUPERMEMORY_API_KEY`, memory is `unconfigured`: Daniel makes no
  provider request, exposes no provider tools, creates no memory job, and
  otherwise handles the turn normally.

### Read path

1. Convex persists the inbound message and supplies recent prompt history.
2. Daniel validates the private owner identity and container.
3. One SuperMemory profile request returns static facts, recent context, and
   memories relevant to the current message.
4. Daniel bounds and formats that result before injecting it into the prompt.
   Provider timeouts and errors fail open so the turn continues.
5. The optional `recall` tool performs a narrower semantic search.

### Capture and exact operations

1. Convex remains the authoritative raw transcript store.
2. After a completed normal user/assistant exchange is delivered, Daniel
   builds only that turn's normalized `delta_turn_v1` payload.
3. Daniel atomically persists the assistant reply and, when memory is ready,
   exactly one `conversation_turn` job in `memorySyncJobs`.
4. The worker claims jobs with a lease, initializes the container, records a
   submitted provider ID before completion, and applies bounded retries,
   fencing, recovery journaling, or dead-lettering.
5. A submitted job resumes at Convex completion without sending the document
   twice. A provider outage never blocks the reply; the durable job retries.

Explicit operations remain synchronous. `remember_memory` creates an exact
memory, while `update_memory` creates a provider version for an exact selected
ID. Broad forgetting is two-stage: preview stores exact IDs in
`memoryPendingOperations`, and confirmation forgets only those stored IDs
without repeating the search. Pairing command turns persist normally but do
not enter semantic memory.

### Primary-owner pairing

Every sender can chat and, when memory is configured, use an isolated
SuperMemory container. Dashboard memory and proactive Gmail notices require a
separate one-time primary-owner pairing; no phone-number environment variable
chooses that owner.

- The local dashboard can generate an eight-character code valid for ten
  minutes. The intended sender texts `PAIR <code>`.
- Alternatively, the local dashboard lists bounded recent inbound SMS
  conversations with masked labels and opaque candidate tokens. Confirmation
  revalidates that the selected conversation has an inbound user message.
- Pairing code state exists only in server memory as a digest and expiry.
- Convex stores the opaque primary owner/container, normalized SMS
  conversation, registration time, and a server-only authority proof derived
  from the existing salt.
- Registration is idempotent and never replaces a different owner. Until it
  succeeds, owner-scoped dashboard routes are unavailable and Gmail notices
  stop before classification or sending.
- Browser responses never reveal the salt, fingerprint, authority proof,
  opaque owner keys, container tag, or raw primary conversation.

### Images

Image ingestion and cleanup live in `server/imessage.ts` and
`server/images/`.

- Spectrum attachments are MIME and size checked before Convex storage.
- Runtime content-block helpers convert stored images for Claude and Codex.
- `DANIEL_IMAGE_RETENTION_DAYS` and
  `DANIEL_IMAGE_CLEANUP_INTERVAL_MS` control raw image cleanup.
- Ordinary images are not uploaded to semantic memory. Explicit image-memory
  operations are synchronous.
- `memoryImageAnchors` retain Convex bytes while an upload is pending or a
  provider document is active. An anchor becomes `released` only after
  provider deletion is confirmed, and only then may retention cleanup remove
  the file.

## iMessage Routing

Daniel configures Spectrum with `imessage.config()`.

- Inbound identity is `message.sender.id`.
- Replies and progress acknowledgements reuse the inbound `Space`, which
  keeps shared-line routing attached to the same conversation.
- Proactive direct messages resolve with `im.space(user)`.
- No configured line or phone-number override participates in routing or
  semantic-memory ownership.

## Automations And Proactive Email

Automations are created by `server/automation-tools.ts` and run by
`server/automations.ts`.

- `create_automation` stores five-field cron schedules.
- Schedules use the user's saved IANA timezone.
- Due automations spawn normal execution agents and can push results through
  Photon Spectrum.

Proactive Gmail surfacing uses verified Composio webhooks. Before
classification or sending, `server/proactive-email.ts` resolves the paired
primary SMS conversation and opaque SuperMemory scope. When no primary owner
is paired, it skips the notice cleanly.

## Integrations And Browser

Composio integration state is handled by `server/composio.ts`,
`server/composio-routes.ts`, and
`server/integrations/composio-loader.ts`.

- `COMPOSIO_API_KEY` enables hosted OAuth and toolkit sessions.
- `COMPOSIO_USER_ID` defaults to `daniel-default`.
- Each worker spawn receives only the requested toolkit servers.

Local browser use is separate from Composio.

- The `browser` integration appears only when enabled in Settings.
- Browser state falls back to `DANIEL_BROWSER_*` environment variables when
  no dashboard setting is stored.
- Local browser HTTP routes reject public tunnel requests before launching or
  controlling Chrome.
- Typed values are redacted before tool-use logs are persisted.

## Data Model

Read `convex/schema.ts` for exact validators and indexes.

| Table | Role |
|---|---|
| `messages` | iMessage/chat transcript, image refs, media errors |
| `conversations` | Per-thread metadata |
| `memorySyncJobs` | Durable `conversation_turn` outbox, retries, dead letters, provider IDs |
| `memoryProviderState` | Provider health, identity fingerprint, pairing state, worker activity |
| `memoryPendingOperations` | Exact IDs and status for two-stage confirmed forget flows |
| `memoryImageAnchors` | Convex image-retention state tied to provider documents |
| `memoryProviderMetrics` | Bounded provider latency and outcome metrics |
| `memoryProviderEvents` | Bounded provider and synchronization activity events |
| `executionAgents` | Normal worker runs |
| `codingProjects` | Coding project/workspace state |
| `codingSessions` | Per-Codex coding turn state |
| `codingEvents` | Plans, diffs, questions, and final coding responses |
| `codingPendingInputs` | Pending user decisions for coding sessions |
| `codingPreferences` | Per-conversation coding preferences |
| `usageRecords` | Per-call usage and cost records |
| `agentLogs` | Normal worker audit trail |
| `automations` | Scheduled recurring tasks, including timezone |
| `automationRuns` | Execution history for automations |
| `messageDedup` | Inbound Spectrum dedup keys |
| `drafts` | Staged external actions |
| `settings` | Runtime, model, browser, timezone, and proactive settings |

## Message Lifecycle

Normal work:

```text
1. Spectrum yields an inbound iMessage.
2. server/imessage.ts deduplicates it, stores images, and persists the user turn.
3. Daniel validates memory configuration and loads recent Convex history.
4. When ready, Daniel hydrates bounded SuperMemory context; failures return empty context.
5. The interaction agent answers directly or delegates to a scoped worker.
6. server/imessage.ts sends the reply through the inbound Space.
7. Convex persists the assistant reply, with an optional conversation_turn job.
8. The sync worker completes or retries that job without duplicating documents.
```

Coding work:

```text
1. interaction-agent routes software work to spawn_coding_agent.
2. coding-agent creates or reuses a workspace and records project/session rows.
3. Codex runs in plan mode only for the first automatic planning turn.
4. Build, debug, and follow-up turns use default collaboration mode.
5. Pending questions are persisted and resumed by the user's answer.
6. interaction-agent applies the response style and writes the final reply.
```

## Why This Shape

**Daniel voice stays centralized.** Workers can be technical and terse because
the interaction agent owns the final user-facing wording.

**Tool access is intentional.** The dispatcher cannot directly mutate the
outside world or filesystem. External actions go through workers and drafts;
coding writes go through the coding bridge.

**Convex is the coordination layer.** It stores ordinary application data and
the durable synchronization controls. SuperMemory is the semantic-memory
system, not the application database.

**Provider adapters stay replaceable.** Claude and Codex share Daniel's
runtime contract, while provider-specific details stay in `server/runtimes/`.

**Memory provider calls stay centralized.** SuperMemory-specific details stay
behind focused modules under `server/memory/supermemory/`; no UI or unrelated
module calls the provider directly.

## What's Intentionally Missing

- Multi-user dashboard authentication. Daniel is still a local personal-agent
  template, and owner control is local-only pairing.
- Distributed scheduler locks. Multiple server instances can double-fire
  automations without an added lock.
- General unrestricted agent filesystem access. Workspace writes are reserved
  for the coding bridge.
