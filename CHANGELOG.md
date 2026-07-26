# Changelog

All notable changes to Daniel are documented here. Entries marked
`[BREAKING]` include an upgrade path that `/upgrade-daniel` surfaces during
updates.

## Unreleased

## 0.1.0 — 2026-07-25

- Initial Daniel release.
- Added Claude Agent SDK and Codex app-server runtime support.
- Added Photon Spectrum iMessage messaging, attachment ingestion, typing
  status, outbound replies, and message deduplication.
- Added dispatcher and execution-worker architecture with managed coding
  workspaces.
- Added persistent Convex conversations, settings, usage, coding state,
  scheduled automations, and draft state.
- Added tiered memory, vector recall, consolidation, image retention, and
  cleanup workflows.
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
