# Architecture

daniel-agent is a single-server personal agent with a strict dispatcher/worker split. The interaction agent owns routing and user-facing wording; workers do tool-heavy execution.

## System Map

```
Photon Spectrum / POST /chat
          |
          v
server/interaction-agent.ts
  Daniel voice, memory recall, routing, draft/automation/self tools
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

Convex stores transcripts, memory, runs, drafts, automations, settings,
usage, coding sessions, coding events, and pending coding questions.
```

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
| `daniel-memory` | `recall`, `write_memory` |
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

Memory lives in `server/memory/` and Convex.

- `tools.ts` exposes `recall` and `write_memory`.
- `extract.ts` runs after user turns and stores durable facts.
- `clean.ts` decays, archives, and prunes memories.
- `embeddings.ts` chooses Voyage, OpenAI, or local Transformers embeddings; all paths produce 1024-dimensional vectors for the Convex vector index.
- `consolidation.ts` runs proposer, adversary, and judge phases to merge, supersede, and prune active memories.
- Image turns attach `imageStorageIds` to messages and, when memory extraction keeps the image, to memory records.

Image ingestion and cleanup live in `server/imessage.ts` and `server/images/`.

- Photon Spectrum attachments are MIME/size checked before upload to Convex storage.
- Runtime content-block helpers convert stored images for Claude and Codex.
- `DANIEL_IMAGE_RETENTION_DAYS` and `DANIEL_IMAGE_CLEANUP_INTERVAL_MS` control raw image cleanup.
- Memory-anchored images survive cleanup.

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
| `memoryRecords` | Durable facts, embeddings, image anchors |
| `executionAgents` | Normal worker runs |
| `codingProjects` | Coding project/workspace state |
| `codingSessions` | Per-Codex coding turn state |
| `codingEvents` | Coding event log: plans, diffs, questions, final responses |
| `codingPendingInputs` | Pending user decisions for coding sessions |
| `codingPreferences` | Per-conversation coding prefs such as `coding_response_style` |
| `usageRecords` | Per-call usage/cost records across dispatcher, workers, coding, extraction, consolidation, proactive |
| `agentLogs` | Normal worker audit trail |
| `memoryEvents` | Memory/debug event stream |
| `automations` | Scheduled recurring tasks, including timezone |
| `automationRuns` | Execution history for automations |
| `messageDedup` | Inbound Photon/Spectrum dedup keys |
| `drafts` | Staged external actions |
| `consolidationRuns` | Consolidation run state and details |
| `settings` | Runtime/model/browser/timezone/proactive settings |

## Message Lifecycle

Normal work:

```
1. Photon Spectrum yields an inbound iMessage.
2. server/imessage.ts dedupes, stores images, and calls handleUserMessage().
3. interaction-agent stores the user message and builds the prompt.
4. interaction-agent recalls memory and either answers or calls spawn_agent.
5. execution-agent runs with scoped tools and returns a technical result.
6. interaction-agent writes Daniel's final reply.
7. imessage.ts sends the reply and Convex stores/broadcasts it.
8. Background extraction writes durable memories.
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

**Convex is the coordination layer.** It stores messages, memory, runtime settings, worker logs, coding state, drafts, automations, and dashboard data in one place.

**Provider adapters stay replaceable.** Claude and Codex share Daniel's runtime contract, while provider-specific details stay in `server/runtimes/`.

## What's Intentionally Missing

- Multi-user auth. This is still a single-user template.
- Distributed scheduler locks. Multiple deployed server instances can double-fire automations without an added lock.
- General unrestricted agent filesystem access. Workspace writes are reserved for the coding bridge.
