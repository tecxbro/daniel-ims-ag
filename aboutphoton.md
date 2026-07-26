## Photon Spectrum in daniel-agent

Photon Spectrum is the iMessage bridge. Daniel uses the `spectrum-ts` cloud
SDK with `imessage.config()` so inbound messages arrive from a long-lived SDK
stream instead of an HTTP webhook.

### Relevant Files

| File | Role |
|---|---|
| `server/imessage.ts` | Core integration: Spectrum app singleton, inbound stream, outbound sends, typing indicators, image ingestion |
| `convex/messageDedup.ts` | Deduplication guard for inbound transport message IDs |
| `server/index.ts` | Starts the Photon Spectrum bridge on boot |
| `scripts/setup.ts` | Interactive setup: prompts for Photon project ID, project secret, and optional dedicated line |
| `scripts/dev.mjs` | Dev runner: starts server, Convex, debug UI, and optional ngrok for Composio webhooks |
| `convex/schema.ts` | Defines the `messageDedup` table |
| `.env.example` | Documents the Photon env vars |

### How It Works End-to-End

```mermaid
graph TD
    "User texts Photon iMessage line" --> "Photon Spectrum"
    "Photon Spectrum SDK stream" --> "server/imessage.ts"
    "server/imessage.ts" --> "Dedup check (convex/messageDedup)"
    "Dedup check (convex/messageDedup)" --> "handleUserMessage()"
    "handleUserMessage()" --> "Agent reply"
    "Agent reply" --> "space.send()"
    "space.send()" --> "iMessage delivered to user"
```

### Environment Variables

| Variable | Purpose |
|---|---|
| `PHOTON_PROJECT_ID` | Photon project ID from project settings |
| `PHOTON_PROJECT_SECRET` | Photon project secret from project settings |
| `PHOTON_IMESSAGE_PHONE` | Optional dedicated iMessage line for outbound routing |

### Current Scope

- Cloud SDK mode only.
- Direct messages only for v1; group chats are skipped.
- Existing `sms:+E164` conversation IDs are preserved for memory,
  automations, drafts, and proactive notices.
- Image attachments are read from Spectrum content, MIME/size checked, and
  uploaded into Convex storage before the interaction agent sees them.
- Replies are markdown-stripped and chunked to 2900 characters before sending.
