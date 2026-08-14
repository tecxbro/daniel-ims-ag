# Spectrum Basics

Daniel uses Photon Spectrum as the messaging transport and UI layer.

Current Daniel integration:

```ts
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

const app = await Spectrum({
  projectId: process.env.PHOTON_PROJECT_ID!,
  projectSecret: process.env.PHOTON_PROJECT_SECRET!,
  providers: [imessage.config()],
});

for await (const [space, message] of app.messages) {
  if (!imessage.is(space) || !imessage.is(message)) continue;
  if (space.type !== "dm" || message.direction !== "inbound") continue;
  await space.send("Got it.");
}
```

Required env vars:

- `PHOTON_PROJECT_ID`
- `PHOTON_PROJECT_SECRET`

Design rules:

- Use Spectrum spaces/messages as the conversation surface.
- Keep direct messages as the v1 default.
- Reuse the inbound Space for replies and progress acknowledgements.
- Resolve proactive direct messages with `im.space(user)`; do not select a
  phone-line override.
- Store durable workflow state in the app backend, not in the message text.
- Strip or simplify markdown before sending to iMessage.
- Chunk long outbound text to stay below iMessage/Spectrum transport limits.
