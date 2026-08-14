# Changelog

All notable changes to Daniel are documented here. Entries marked
`[BREAKING]` include an upgrade path that `/upgrade-daniel` surfaces during
updates.

## Unreleased

- Dispatcher now answers stable questions itself and only spawns a web/tool
  worker when the request needs a live lookup or a real-world action.
- Made SuperMemory Daniel's only semantic-memory provider while keeping Convex
  as the application database and durable synchronization control plane.
- Reduced durable memory jobs to one idempotent `conversation_turn` contract;
  explicit remember, update, confirmed forget, and image operations are direct
  and synchronous.
- Added fail-open unconfigured and identity-recovery states so messages and
  assistant replies persist normally when credentials, identity material, or
  the provider are unavailable.
- Added one-time primary-owner pairing through a local temporary code or a
  masked recent inbound conversation. Dashboard memory and proactive Gmail
  notices remain unavailable until pairing succeeds.
- Updated shared-line iMessage routing to reuse inbound Spectrum Spaces and to
  resolve proactive direct messages without a configured phone-line override.
- Preserved the operational SuperMemory dashboard, durable capture recovery,
  retry/fencing/dead-letter controls, rendered UI coverage, and Liquid Glass
  accessibility behavior while removing inactive cutover controls.

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
