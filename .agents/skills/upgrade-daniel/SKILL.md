---
name: upgrade-daniel
description: Update a customized Daniel installation from the canonical repository. Previews, backs up, merges with conflict-aware resolution, validates, and surfaces breaking changes.
---

# About

A customized Daniel installation can fall behind the canonical Daniel repository. This skill previews and applies Daniel updates while preserving local customizations such as tuned prompts, new automations, and memory settings.

Run `/upgrade-daniel` inside the repo from `Codex`. This is the supported upgrade path: the agent previews the diff, creates rollback points, performs the merge, resolves conflicts when needed, and runs referenced migration skills.

## How it works

**Preflight:** refuses to touch anything with a dirty working tree. If the `upstream` remote is missing, adds it (default: `https://github.com/tecxbro/daniel-ims-ag.git` — the skill will ask).

**Backup:** creates a timestamped rollback branch + tag before doing anything. Printed at the end so you can `git reset --hard` back.

**Preview:** buckets upstream changes into categories so you know what's about to land:
- **Core agent runtime** (`server/interaction-agent.ts`, `server/execution-agent.ts`, `server/runtimes/`, `server/prompts/`) — dispatcher, worker routing, runtime adapters, and shared voice/prompt policy. High conflict risk if you edited prompts.
- **Coding bridge** (`server/coding-agent.ts`, `server/coding/`, `convex/coding*.ts`) — Codex workspaces, plan/build/debug/follow-up behavior, coding response style, pending questions, and coding state.
- **Memory / images / proactive** (`server/memory/`, `server/images/`, `server/consolidation.ts`, `server/proactive-email.ts`) — recall, extraction, image attachments, consolidation, and proactive email surfacing.
- **Integrations** (`server/composio*`, `server/integrations/`, `server/browser/`, `server/browser-routes.ts`) — Composio wiring and optional local browser use.
- **UI** (`debug/`) — debug dashboard.
- **Schema** (`convex/`) — Convex tables + functions. Pushes happen on next `convex dev`.
- **Scripts / config** (`scripts/`, `package.json`, `tsconfig.json`, `.env.example`) — env vars + deps might need attention.
- **Docs / skills** (`README.md`, `ARCHITECTURE.md`, `INTEGRATIONS.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `docs/`, `skills/`, `.agents/skills/`, `.claude/skills/`).

**Choice:** you pick merge (one-pass), cherry-pick (specific commits), rebase (linear history), or abort.

**Conflict preview:** dry-run merge to show which files would conflict before you commit.

**Validation:** dependency installation, branding validation, type checking, tests, and dashboard build after the update.

**Breaking changes:** parses the CHANGELOG.md diff for `[BREAKING]` entries and surfaces each one. Many breaking changes will reference a migration skill (`/<skill-name>`) — the skill offers to run those for you.

**Summary:** prints rollback tag, new/upstream HEADs, and any env-var additions from `.env.example` you should copy into `.env.local`.

---

# Operating principles

- Never proceed with a dirty working tree.
- Always create a rollback point (backup branch + tag) before touching anything.
- Prefer git-native operations. Do not rewrite files manually except to resolve conflict markers.
- Default to MERGE (one-pass conflict resolution). Offer REBASE only if the user explicitly asks.
- Keep token usage low: use `git status`, `git log`, `git diff`, and only open files that actually have conflicts.

---

# Step 0: Preflight

Run:
- `git status --porcelain`

If output is non-empty:
- Tell the user to commit or stash first. Stop.

Confirm remotes with `git remote -v`. If `upstream` is missing:
- Ask the user for the upstream repo URL (default: `https://github.com/tecxbro/daniel-ims-ag.git`).
- `git remote add upstream <url>`
- `git fetch upstream --prune`

Detect the upstream branch:
- `git branch -r | grep upstream/`
- Prefer `upstream/main`. Fall back to `upstream/master`. If neither, ask.
- Store as `UPSTREAM_BRANCH`. All commands below that reference `upstream/main` use `upstream/$UPSTREAM_BRANCH` instead.

Fetch fresh:
- `git fetch upstream --prune`

# Step 1: Safety net

```
HASH=$(git rev-parse --short HEAD)
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
git branch backup/pre-upgrade-$HASH-$TIMESTAMP
git tag pre-upgrade-$HASH-$TIMESTAMP
```

Save the tag name. You'll print it in Step 7 for rollback.

# Step 2: Preview

Compute base:
- `BASE=$(git merge-base HEAD upstream/$UPSTREAM_BRANCH)`

Show what's coming:
- `git log --oneline $BASE..upstream/$UPSTREAM_BRANCH`

Show local drift:
- `git log --oneline $BASE..HEAD`

File-level impact:
- `git diff --name-only $BASE..upstream/$UPSTREAM_BRANCH`

Bucket files into the categories listed in **How it works** (Core, Integrations, UI, Schema, Scripts/config, Docs). Call out high-risk buckets specifically.

**Large-drift check:** if upstream has many commits and the user has heavy local drift, mention that starting fresh and reapplying customizations might be cleaner than merging. Don't push — offer.

Ask the user with the active agent's user-question mechanism:
- A) **Full update** — merge all upstream changes (default)
- B) **Selective** — cherry-pick specific commits
- C) **Abort** — preview only
- D) **Rebase** — linear history, resolves conflicts per commit

If Abort: print rollback info and stop.

# Step 3: Conflict preview (no commits yet)

If Full update or Rebase, dry-run:
```
git merge --no-commit --no-ff upstream/$UPSTREAM_BRANCH; git diff --name-only --diff-filter=U; git merge --abort
```

Show the conflict list. If empty, say "clean" and proceed. If non-empty, let the user bail.

# Step 4A: Full update (MERGE — default)

- `git merge upstream/$UPSTREAM_BRANCH --no-edit`

If conflicts:
- `git status` → list conflicted files.
- For each file:
  - Open it.
  - Resolve only conflict markers.
  - Preserve intentional local customizations.
  - Incorporate upstream improvements.
  - Do not refactor surrounding code.
  - `git add <file>`
- When done: `git commit --no-edit` (if merge didn't auto-commit).

# Step 4B: Selective (CHERRY-PICK)

- `git log --oneline $BASE..upstream/$UPSTREAM_BRANCH`
- Ask which hashes.
- `git cherry-pick <hash1> <hash2> …`

On conflict:
- Resolve markers, `git add`, `git cherry-pick --continue`.
- `git cherry-pick --abort` to stop.

# Step 4C: Rebase (opt-in)

- `git rebase upstream/$UPSTREAM_BRANCH`

On conflict: resolve, `git add`, `git rebase --continue`. If > 3 rounds of conflicts, `git rebase --abort` and recommend merge.

# Step 5: Validation

Run in order:
- `npm install` — picks up any new dependencies while preserving the lockfile.
- `npm run check:branding` — verifies Daniel-native paths and content.
- `npm run typecheck` — verifies the TypeScript source.
- `npm test` — runs the complete test suite.
- `npm run build:debug` — verifies the operations dashboard build.

If validation fails, stop before presenting the update as complete. Explain
whether the failure came from the update delta, missing local credentials, or
an external service that is unavailable.

**Note:** Convex schema changes (`convex/schema.ts`, `convex/*.ts`) take effect the next time `convex dev` runs. Mention this to the user — they need to restart `npm run dev` for the schema to push.

**Note:** If `.env.example` changed, diff it against `.env.local`:
- `diff <(grep -o '^[A-Z_]*=' .env.example | sort) <(grep -o '^[A-Z_]*=' .env.local | sort)`
- List any new keys the user should add to `.env.local`.

# Step 6: Breaking changes check

Read the CHANGELOG delta:
- `git diff pre-upgrade-$HASH-$TIMESTAMP..HEAD -- CHANGELOG.md`

Parse new lines containing `[BREAKING]`. Format is:
```
[BREAKING] <description>. Run `/<skill-name>` to <action>.
```

If none: proceed silently.

If any:
- Display a warning header: "This update introduces breaking changes that may need action:"
- Show each `[BREAKING]` line in full.
- Collect referenced skills.
- Ask the user with the active agent's user-question mechanism (multi-select when available):
  - One option per referenced skill
  - "Skip — I'll handle these manually"
- For each selected skill, invoke via the Skill tool.

# Step 7: Summary + rollback

Print:
- **Rollback tag:** `pre-upgrade-<HASH>-<TIMESTAMP>`
- **New HEAD:** `git rev-parse --short HEAD`
- **Upstream HEAD:** `git rev-parse --short upstream/$UPSTREAM_BRANCH`
- **Conflicts resolved:** list, if any
- **New env vars to add to .env.local:** list from Step 5
- **Breaking changes applied:** list skills run

Tell the user:
- Rollback: `git reset --hard pre-upgrade-<HASH>-<TIMESTAMP>`
- Backup branch also exists: `backup/pre-upgrade-<HASH>-<TIMESTAMP>`
- Restart `npm run dev` to pick up code + Convex schema changes.
