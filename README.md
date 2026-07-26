# Daniel

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/tecxbro/daniel-ims-ag)

Daniel is a self-hosted personal agent that lives in iMessage. It can run on
either a Claude Code subscription through the Claude Agent SDK or a
Codex/ChatGPT subscription through the local Codex app-server runtime.

Daniel is a complete agent system rather than a chat wrapper: a dispatcher
routes work to focused execution workers, Convex stores durable state, Photon
Spectrum carries iMessages, and the operations dashboard exposes memory,
automations, integrations, coding workspaces, browser controls, and usage.

## What Daniel Includes

- **iMessage transport** through Photon Spectrum, including attachment
  ingestion, typing state, outbound replies, and message deduplication.
- **Claude and Codex runtimes** selected during setup or switched at runtime.
- **Dispatcher and worker architecture** that keeps the conversation agent
  small while delegated workers receive the tools needed for each task.
- **Coding agents** with managed workspaces, plan/build/debug modes, pending
  questions, follow-up turns, and persisted coding events.
- **Tiered memory** with short-, long-, and permanent-memory records, semantic
  recall, extraction, decay, cleanup, and adversarial consolidation.
- **Image understanding and retention** across the dispatcher and execution
  workers, with size/MIME validation and configurable cleanup.
- **Scheduled automations** with timezone-aware cron evaluation and proactive
  iMessage delivery.
- **Proactive email workflows** using verified Composio webhooks, user
  preferences, warmup safeguards, and deterministic self-send filtering.
- **Draft-before-send behavior** for external actions that need user approval.
- **External integrations** through Composio, scoped to the worker that needs
  them. The curated dashboard includes Gmail, Calendar, Drive, Sheets, Docs,
  Slack, GitHub, Linear, Notion, HubSpot, Discord, and more.
- **Optional local browser use** through a Patchright-backed Chrome profile
  with local-only routes, explicit enablement, and manual login handoff.
- **Persistent Convex state** for messages, settings, memory, usage, coding
  sessions, automations, drafts, and execution status.
- **Operations dashboard** for live health, usage, agents, automations, memory,
  events, consolidation, connections, browser controls, and settings.
- **Upgrade and rollback workflows** through `/upgrade-daniel`, including
  previews, conflict detection, rollback branches/tags, merge, cherry-pick,
  optional rebase, breaking-change discovery, and validation.

## Operations Dashboard

The dashboard is a React/Vite application backed by live Convex queries and
the local Daniel server.

## System Map

```text
iMessage
   │
   ▼
Photon Spectrum SDK
   │
   ▼
Interaction agent (dispatcher)
   ├── memory recall / writes
   ├── settings and self-tools
   ├── automation and draft tools
   ├── execution workers + scoped integrations
   └── coding worker + managed workspace
            │
            ▼
       Claude or Codex

Convex persists conversations, memory, agents, automations, drafts,
coding state, settings, image references, and usage.
```

The dispatcher does not receive every powerful tool. It interprets the
conversation, recalls relevant memory, and spawns a worker when the task needs
web access, files, integrations, browser actions, or deeper execution. That
separation keeps the main conversation responsive and limits tool scope.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the detailed runtime and data-flow
model.

## Requirements

| Service | Purpose | Required |
|---|---|---:|
| Node.js 20+ | Server, scripts, dashboard, tests | Yes |
| Claude Code or Codex CLI | Agent runtime and subscription authentication | Yes, choose one |
| Photon Spectrum | iMessage transport | Yes for iMessage |
| Convex | Persistent data and realtime dashboard state | Yes |
| Composio | Hosted integrations and proactive email webhooks | Optional |
| ngrok or another public URL | Composio webhook delivery when no stable URL exists | Optional |
| Chrome/Chromium via Patchright | Local visual/login browser workflows | Optional |

Subscription authentication means Daniel does not require an Anthropic or
OpenAI API key for its main agent runtime. Provider API keys remain optional
for embeddings or other explicitly configured services.

## Quickstart

```bash
# 1. Clone the canonical repository and install dependencies
git clone https://github.com/tecxbro/daniel-ims-ag.git
cd daniel-ims-ag
npm install

# 2. Install one runtime globally and sign in
npm install -g @anthropic-ai/claude-code
claude

# or:
npm install -g @openai/codex
codex login

# 3. Configure Daniel
npm run setup

# 4. Start the server, Convex watcher, dashboard, and optional tunnel
npm run dev
```

The setup flow:

1. Creates or updates `.env.local`.
2. Selects Claude or Codex and its model settings.
3. Collects Photon credentials.
4. Creates or reuses a Convex deployment and generates Convex clients.
5. Configures optional embeddings, integrations, public URL, and browser use.
6. Runs readiness checks without committing local secrets.

After startup:

- Server health: `http://localhost:3456/health`
- Debug dashboard: `http://localhost:5173`
- WebSocket events: `ws://localhost:3456/ws`

Photon Spectrum consumes an SDK stream, so inbound iMessage delivery does not
need a public webhook. A tunnel or stable public URL is only needed for
webhook-based integrations such as proactive Composio events.

For an abbreviated startup checklist, see [START.md](START.md).

## Runtime Choice

### Claude

The Claude runtime uses `@anthropic-ai/claude-agent-sdk` and the local Claude
Code login. `DANIEL_MODEL` defines the default model. A model stored in the
Convex settings table takes precedence and can be changed from a conversation.

### Codex

The Codex runtime starts the local `codex app-server` protocol and uses the
credentials created by `codex login`. Daniel creates an isolated Codex home
inside each managed coding workspace while reusing the authenticated
`auth.json`. Model and reasoning defaults come from `DANIEL_CODEX_MODEL` and
`DANIEL_CODEX_REASONING_EFFORT`.

The generated protocol types in
`server/runtimes/codex-app-server-protocol/` are retained so runtime requests,
notifications, approvals, tools, threads, and usage remain strongly typed.

## Photon Spectrum and iMessage

Daniel starts the Spectrum SDK bridge during server boot when
`PHOTON_PROJECT_ID` and `PHOTON_PROJECT_SECRET` are configured.

Inbound processing:

1. Spectrum streams the message event.
2. Daniel normalizes the sender and conversation identity.
3. Message IDs are deduplicated in Convex.
4. Supported attachments are downloaded with size and MIME limits.
5. Images are stored in Convex and converted to runtime-specific content
   blocks.
6. The interaction agent recalls memory, responds directly, or spawns a
   worker.
7. The final answer is sent through Spectrum and persisted.

`PHOTON_IMESSAGE_PHONE` optionally pins outbound direct messages to a
dedicated line. `PHOTON_LLMS_URL` can cache current Photon documentation into
managed coding workspaces when needed.

See [aboutphoton.md](aboutphoton.md) and the bundled
[`skills/photon-spectrum`](skills/photon-spectrum/) skill for implementation
and integration guidance.

## Memory and Images

Memory records are divided into short, long, and permanent tiers and labeled
by segment, such as preference, identity, project, context, or correction.
Daniel recalls before making claims about user-specific facts.

Semantic recall tries providers in this order:

1. Voyage when `VOYAGE_API_KEY` is configured.
2. OpenAI when `OPENAI_API_KEY` is configured.
3. Local `Xenova/bge-large-en-v1.5` through Transformers.js.

All providers produce vectors compatible with the Convex memory index.
Without a paid provider, Daniel downloads the local model once and preloads it
in the background.

Consolidation uses a proposer, adversary, and judge pipeline to merge
duplicates, resolve contradictions, and remove noise. Runs and intermediate
reasoning are persisted for the dashboard.

Inbound images can flow through both the interaction agent and spawned
workers. Raw image bytes expire according to
`DANIEL_IMAGE_RETENTION_DAYS` unless a memory record anchors them.

## Automations and Proactive Work

Daniel turns schedules such as “every weekday at 8, summarize my calendar”
into persisted automations. Cron evaluation uses the user’s IANA timezone, and
the timezone is stored with each automation so later global changes do not
silently move existing jobs.

Proactive Gmail events use a verified Composio webhook. Daniel:

- keeps the signing secret in Convex settings;
- filters self-sent mail before model classification;
- uses relevant preference memories when deciding importance;
- skips event warmup immediately after a process restart;
- reports usage separately from interactive turns;
- sends the final notice through the same interaction-agent voice and memory
  rules.

External actions can be staged as drafts so the user confirms before Daniel
commits them.

## Coding Workspaces

`spawn_coding_agent` creates or reuses workspaces under
`DANIEL_PROJECTS_ROOT` (default `~/daniel-projects`). Coding state includes:

- project metadata and workspace path;
- active session/thread identity;
- plan, build, debug, and follow-up turns;
- response-style preference;
- pending questions and answers;
- runtime events and summaries.

The workspace helper validates project keys, ignores secrets and Daniel’s
local config directory, and can clone a requested repository/branch. Claude
and Codex share Daniel’s coding developer guidance while keeping
provider-specific protocol handling.

## Integrations

Set `COMPOSIO_API_KEY`, then connect toolkits from the dashboard. Connected
toolkits are keyed under `COMPOSIO_USER_ID` or the Daniel default user ID.
Workers receive only the integrations named for their delegated task.

The curated catalog covers common services, but it is not a capability limit.
Add another toolkit to `CURATED_TOOLKITS` or register a local integration in
`server/integrations/registry.ts`.

See [INTEGRATIONS.md](INTEGRATIONS.md) for auth modes, scoping, webhooks,
tool naming, and custom integration patterns.

## Optional Local Browser

Local browser use is disabled by default. When enabled, Daniel launches a
Patchright-backed Chrome/Chromium profile for login-required sites,
JavaScript-heavy visual work, or pages that reject ordinary HTTP automation.

Safety properties:

- the integration is absent from worker tool lists until enabled;
- browser-control and configuration routes remain local;
- profile and executable paths are validated;
- unsafe Chrome flags are rejected;
- typed values are redacted from persisted tool logs;
- visible login handoff is a separate explicit setting;
- installation of the browser binary is opt-in.

The dashboard exposes enable/disable, show UI, profile, start URL, channel,
executable, additional arguments, install, launch, login handoff, close, and
status controls.

## Environment Variables

`.env.example` is the authoritative template. Daniel-owned runtime
configuration uses the `DANIEL_` namespace.

| Variable | Purpose |
|---|---|
| `DANIEL_RUNTIME` | `claude` or `codex` |
| `DANIEL_MODEL` | Default Claude model |
| `DANIEL_CODEX_MODEL` | Default Codex model |
| `DANIEL_CODEX_REASONING_EFFORT` | Codex reasoning effort |
| `DANIEL_CODEX_AUTH_HOME` | Alternate Codex credential directory |
| `DANIEL_CLASSIFIER_MODEL` | Optional Claude proactive classifier model |
| `DANIEL_CODEX_CLASSIFIER_MODEL` | Optional Codex proactive classifier model |
| `DANIEL_ADVERSARY_MODEL` | Optional Claude consolidation adversary model |
| `DANIEL_CODEX_ADVERSARY_MODEL` | Optional Codex consolidation adversary model |
| `DANIEL_PROJECTS_ROOT` | Managed coding workspace root |
| `DANIEL_USER_PHONE` | iMessage destination for proactive notices |
| `DANIEL_BROWSER_*` | Optional local-browser configuration |
| `DANIEL_IMAGE_RETENTION_DAYS` | Raw image retention period |
| `DANIEL_IMAGE_CLEANUP_INTERVAL_MS` | Image cleanup interval |
| `DANIEL_UPSTREAM_CHECK` | Enable the non-blocking upstream check |
| `DANIEL_GITHUB_REPO` | Optional changelog repository override |
| `DANIEL_GITHUB_BRANCH` | Optional changelog branch override |
| `CONVEX_DEPLOYMENT` | Convex CLI deployment identifier |
| `VITE_CONVEX_URL` / `CONVEX_URL` | Convex client/server URL |
| `PHOTON_PROJECT_ID` / `PHOTON_PROJECT_SECRET` | Spectrum credentials |
| `PHOTON_IMESSAGE_PHONE` | Optional dedicated outbound line |
| `PHOTON_LLMS_URL` | Optional Photon documentation source |
| `COMPOSIO_API_KEY` | External integrations |
| `COMPOSIO_USER_ID` | Optional connection owner override |
| `COMPOSIO_AUTO_WEBHOOK` | Automatic proactive webhook registration |
| `VOYAGE_API_KEY` / `OPENAI_API_KEY` | Optional paid embeddings |
| `PUBLIC_URL` / `NGROK_DOMAIN` | Public integration webhook URL |
| `PORT` | Local server port |
| `GITHUB_TOKEN` | Optional authenticated changelog fetches |

Setup writes Daniel variables only. A fresh installation has no dependency on
earlier configuration namespaces.

## Development Commands

| Command | Purpose |
|---|---|
| `npm run setup` | Interactive local configuration |
| `npm run preflight` | Validate local readiness |
| `npm run dev` | Run server, Convex, dashboard, tunnel, and upstream check |
| `npm run dev:server` | Run the watched server |
| `npm run dev:convex` | Run the Convex watcher |
| `npm run dev:debug` | Run the dashboard |
| `npm run build:debug` | Build the dashboard |
| `npm run typecheck` | Type-check server, scripts, and dashboard |
| `npm test` | Run the Vitest suite |
| `npm run check:branding` | Scan paths and contents for prohibited legacy identity |
| `npm run validate` | Run branding, types, tests, and dashboard build |
| `npm run codex:protocol` | Regenerate Codex app-server protocol types |

## Project Layout

```text
.
├── .agents/skills/              # Codex developer and upgrade skills
├── .claude/skills/              # Claude developer and upgrade skills
├── .github/workflows/           # CI validation
├── assets/                      # Daniel-native documentation assets
├── convex/                      # Schema, queries, mutations, and persistence
├── debug/                       # React/Vite operations dashboard
├── docs/                        # Product design and implementation notes
├── scripts/                     # Setup, development, checks, and webhooks
├── server/
│   ├── browser/                 # Local browser launcher and tools
│   ├── coding/                  # Workspace and coding guidance
│   ├── images/                  # Image validation and retention
│   ├── integrations/            # Integration registry and loaders
│   ├── memory/                  # Recall, extraction, cleanup, and types
│   ├── prompts/                 # Shared Daniel voice policy
│   └── runtimes/                # Claude/Codex adapters and protocol types
├── skills/photon-spectrum/      # Bundled Photon implementation skill
├── test/                        # Runtime, coding, image, browser, and transport tests
├── project-metadata.json        # Canonical name, repository, command, and defaults
└── package.json
```

## Upgrading Customized Installations

For a customized installation, use:

```text
origin   → your Daniel repository
upstream → https://github.com/tecxbro/daniel-ims-ag.git
```

Add the canonical source once:

```bash
git remote add upstream https://github.com/tecxbro/daniel-ims-ag.git
git fetch upstream --prune
```

Then open Claude or Codex in the repository and run:

```text
/upgrade-daniel
```

The mirrored skills at
`.agents/skills/upgrade-daniel/SKILL.md` and
`.claude/skills/upgrade-daniel/SKILL.md`:

1. refuse to update a dirty working tree;
2. fetch the canonical remote with a timeout;
3. preview incoming commits and categorize affected capabilities;
4. create a timestamped rollback branch and tag;
5. preview conflicts before changing the current branch;
6. support full merge, selected cherry-picks, or explicit rebase;
7. resolve conflicts while preserving local customizations;
8. install dependencies;
9. report new environment variables;
10. detect `[BREAKING]` changelog entries and migration skills;
11. run branding, type, test, and dashboard-build validation;
12. print rollback instructions and the final update summary.

`scripts/check-upstream.mjs` runs in parallel with development startup. It is
silent when current, disabled, offline, or running from the canonical
repository itself. A customized installation with an `upstream` remote gets a
commit-count banner and a `/upgrade-daniel` reminder.

## Operational Notes

- Review external permissions and connected accounts before enabling
  integrations.
- Treat `.env.local`, Convex deployment state, local browser profiles, and
  coding workspaces as private machine data.
- Keep dashboard and browser-control routes local.
- Use the draft flow for external writes that need confirmation.
- Configure usage budgets appropriate to the selected runtime and
  integrations.
- The server starts without optional Composio or browser credentials and
  reports which capabilities are ready.

## Troubleshooting

### Convex types are missing

```bash
npx convex dev --once
```

Then restart `npm run dev`.

### Claude cannot authenticate

Run `claude` once in a terminal, complete sign-in, exit, and restart Daniel.
If using an API key instead, set `ANTHROPIC_API_KEY`.

### Codex cannot authenticate

Run `codex login`. If credentials are stored outside the normal Codex home,
set `DANIEL_CODEX_AUTH_HOME`.

### iMessage is not starting

Confirm `PHOTON_PROJECT_ID` and `PHOTON_PROJECT_SECRET`, then check the server
logs for Spectrum lifecycle and bridge readiness messages.

### Memory recall is slow on first boot

Without Voyage or OpenAI keys, the local embedding model downloads once and
then loads from cache. `npm run setup` can preload it before normal use.

### Dashboard is disconnected

Verify the server health endpoint, the configured port, and Vite’s `/ws`
proxy. Restart `npm run dev` after Convex schema changes.

### Browser tools are unavailable

Enable Local browser use in Settings, install the optional Patchright browser
when prompted, and verify the configured channel or executable path.

### An update fails

Use the rollback tag printed by `/upgrade-daniel`, or reset to the matching
`backup/pre-upgrade-*` branch. Resolve local environment or external-service
failures before retrying.

## Documentation

- [Architecture](ARCHITECTURE.md)
- [Integrations](INTEGRATIONS.md)
- [Startup guide](START.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)
- [Photon background](aboutphoton.md)

## License

Daniel is distributed under [The Intern License](LICENSE).
Required incorporated-source notices are isolated in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
