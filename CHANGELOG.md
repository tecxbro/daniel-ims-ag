# Changelog

All notable changes to Daniel are documented here. Entries marked
`[BREAKING]` include an upgrade path that `/upgrade-daniel` surfaces during
updates.

## Unreleased

- Dispatcher now answers stable questions itself and only spawns a web/tool
  worker when the request needs a live lookup or a real-world action.
- Added the staged Convex-to-SuperMemory semantic-memory migration. Convex
  remains the owner of transcripts, application state, the durable sync
  outbox, migration ledger, image anchors, and provider health; SuperMemory
  owns profile hydration, semantic recall, exact/versioned memories, and
  forgetting.
- Added private per-user container identities derived with HMAC, automatic
  pre-dispatch profile hydration, per-turn delta capture, bounded retries and
  dead letters, exact-memory migration reconciliation, two-stage confirmed
  forget, and durable-image retention anchors.
- Added independent `convex`/`shadow`/`supermemory` read modes and
  `convex`/`dual`/`supermemory` write modes for staged cutover and rollback.
  Legacy tiered memory data is historical migration state after write cutover;
  it is retained read-only for 30 days and is not deleted by this change.
- Replaced the debug dashboard's legacy tier, embedding, graph, and local
  consolidation views with provider health, profile/search/documents,
  synchronization jobs and retries, migration reconciliation, and image-anchor
  status.

## 0.1.0 — 2026-07-25

- Initial Daniel release.
- Added Claude Agent SDK and Codex app-server runtime support.
- Added Photon Spectrum iMessage messaging, attachment ingestion, typing
  status, outbound replies, and message deduplication.
- Added dispatcher and execution-worker architecture with managed coding
  workspaces.
- Added persistent Convex conversations, settings, usage, coding state,
  scheduled automations, and draft state.
- Added the original, now-legacy tiered memory, vector recall, consolidation,
  image retention, and cleanup workflows.
- Added scheduled automations, timezone-aware execution, and proactive email
  notifications.
- Added Composio integrations with per-worker scoping and connection
  management.
- Added optional local browser workflows with isolated profiles and manual
  login handoff.
- Added the Daniel operations dashboard for agents, memory, automations,
  events, consolidation, integrations, settings, and usage.
- Added the `/upgrade-daniel` update workflow with preview, rollback branches
  and tags, merge, cherry-pick, optional rebase, conflict handling,
  breaking-change discovery, environment-variable reporting, tests, and build
  validation.
