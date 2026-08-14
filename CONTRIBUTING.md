# Contributing

Daniel is a small personal-agent template. The codebase stays tight because that's the whole point — it should be small enough to read cover-to-cover in an afternoon and fork without fear.

## What lands in source

- Bug fixes
- Security fixes
- Simplifications (less code doing the same thing)
- Clear improvements to core behavior — memory hydration, durable capture,
  synchronization reliability, dispatcher policy, cost tracking, etc.
- New channels, integrations, or runtime skills if they fit the template spirit (small, opinionated, well-scoped)

Keep the diff focused — one concern per PR. A feature PR and a refactor PR should be two PRs.

## Memory architecture guardrails

Convex stores application state and synchronization state. SuperMemory stores
and retrieves long-term semantic memory.

Memory changes must preserve these boundaries:

- Keep the raw transcript, recent prompt history, durable outbox, migration
  ledger, pending operations, image anchors, and provider health in Convex.
- Use one SuperMemory container per memory owner across conversations. Keep
  `memoryOwnerId` separate from `conversationId`, and derive provider
  identifiers with the stable HMAC salt; never send a raw phone number as a
  container tag or custom ID.
- Hydrate the profile and query-relevant context before dispatcher execution,
  but fail open when the provider is unavailable.
- Capture completed turns as `delta_turn_v1` jobs in `memorySyncJobs`. Do not
  replace the stable conversation document with an ever-growing transcript or
  bypass the durable outbox.
- Put every SuperMemory SDK or direct HTTP call behind the server-only adapter
  in `server/memory/supermemory/`. UI, routes, tools, and unrelated server code
  use the adapter or normalized server APIs; the browser must never receive
  `SUPERMEMORY_API_KEY`.
- Use exact creation for explicit and migrated facts, provider versions for
  corrections, and the two-stage forget flow. Forget confirmation must apply
  the exact IDs saved during preview and must not rerun the semantic query.
- Upload images only when the durable-image policy allows it. Pending and
  active `memoryImageAnchors` retain Convex bytes; release an anchor only after
  provider deletion is confirmed.

The legacy `memoryRecords`, `memoryEvents`, and `consolidationRuns` APIs and
data may appear in migration code only when explicitly labeled **legacy**.
They remain read-only for 30 days after SuperMemory-only write cutover. A PR
must not delete them unless it is the final decommission change and proves the
retention and reconciliation gates. That change must delete rows in this
order—`memoryRecords`, `memoryEvents`, `consolidationRuns`—verify all three are
empty, then remove functions, schema definitions, generated references, and
retired server files.

Migration PRs must test each mode they touch. During shadow evaluation use
`shadow` reads with `dual` writes; during the seven-day user-facing read
burn-in use `supermemory` reads with `dual` writes. After SuperMemory-only
write cutover, the frozen Convex legacy store is stale: rollback favors
provider repair or outbox replay. After legacy schema retirement, recovery
requires reverting the decommission and restoring the immutable checksummed
export, not only changing flags.

## Bug-fix PRs

- One fix per PR.
- Update `CHANGELOG.md` under **Unreleased** with a one-line entry.
- If the fix changes external behavior (env vars, Convex schema, HTTP routes, webhook shapes), mark the CHANGELOG entry `[BREAKING]` — see conventions below.

## CHANGELOG conventions

- Entries live under **Unreleased** until a release cut.
- Prefix user-actionable changes with `[BREAKING]`.
- If a breaking change needs a migration (backfill, env var rename, schema transform), ship a **migration skill** in both runtime skill trees so Claude and Codex users get the same upgrade path:

  - `.claude/skills/<name>/SKILL.md`
  - `.agents/skills/<name>/SKILL.md`

  Reference it in the CHANGELOG:

  ```
  [BREAKING] <description>. Run `/<skill-name>` to <action>.
  ```

  `/upgrade-daniel` parses this format and offers to run the referenced skill during agent-assisted upgrades. The format is the only coupling; without a migration, just write `[BREAKING] <description>.` without the skill reference.

## Skills

Two kinds of provider-loaded skills live in the project skill trees:

**Migration skills** — instruction-only `SKILL.md` files triggered by `[BREAKING]` CHANGELOG entries during `/upgrade-daniel`. Pure markdown, no branch, no supporting code. Mirror them in `.claude/skills/` and `.agents/skills/` unless the migration is explicitly provider-specific. Example: `/upgrade-daniel` itself is this shape.

**Runtime skills** — `SKILL.md` loaded into the execution agent at spawn time. Claude loads `.claude/skills/` via the Claude Agent SDK's `settingSources`; Codex uses `.agents/skills/` for the same project-facing playbooks. The model autonomously invokes a skill when a task matches the skill's `description`. Example: `.claude/skills/youtube-script-writer/` plus `.agents/skills/youtube-script-writer/`. See the **Skills** section in the README for wiring details.

Both are just Markdown under `.claude/skills/<name>/SKILL.md` and/or `.agents/skills/<name>/SKILL.md` with YAML frontmatter. No branching model, no maintainer-owned sibling branches — features land directly on `main` like any normal project.

The repo may also include helper playbooks outside those provider-loaded trees. For example, `skills/photon-spectrum/` is a source-controlled reference/playbook asset for Photon Spectrum work; it is not automatically loaded by Claude or Codex unless it is installed or mirrored into `.claude/skills/` or `.agents/skills/`.

## Writing a migration skill

1. Fork, branch from `main`.
2. Create mirrored skill files:
   - `.claude/skills/<name>/SKILL.md`
   - `.agents/skills/<name>/SKILL.md`

   Each file uses the same frontmatter:
   ```yaml
   ---
   name: <name>
   description: One-line trigger description for when `/upgrade-daniel` should offer this.
   ---
   ```
3. Body: numbered operating steps the agent should execute. Lean on `git`, `npm`, file edits. Make the skill idempotent — a user running it twice should be safe.
4. Add the matching `[BREAKING]` line to `CHANGELOG.md` under **Unreleased**.
5. Open a PR with the code change + both `SKILL.md` files + the CHANGELOG entry in one commit.

## Writing a runtime skill

1. Create `.claude/skills/<name>/SKILL.md` and `.agents/skills/<name>/SKILL.md` with a specific, trigger-rich `description` so both runtimes route to it reliably.
2. Body: the playbook the execution agent should follow when it invokes this skill.
3. That's it — no server code changes needed unless the behavior requires real tools or prompt/runtime changes.
