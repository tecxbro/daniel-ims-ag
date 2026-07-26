---
name: photon-spectrum
description: Build conversational products and agents through Photon Spectrum, especially iMessage-based apps, reminder flows, onboarding flows, and notification agents.
---

# Photon Spectrum

Use this skill whenever a coding task involves conversational, messaging-based,
agentic, onboarding, reminder, or notification interactions.

Daniel's rule is strict: end-user conversational interaction goes through
Photon/Spectrum. Do not create a custom chat UI or switch to another messaging
provider unless the user explicitly asks for a non-conversational interface.

## Workflow

1. Read `references/spectrum-basics.md` for the integration shape.
2. Use `references/webhook-patterns.md` when connecting inbound events to an app
   backend or queue.
3. Start from a template in `templates/` when the project stack matches it.
4. If more Photon docs are needed and `PHOTON_LLMS_URL` is set, run:

   ```bash
   node --import tsx skills/photon-spectrum/scripts/fetch-photon-docs.ts
   ```

5. Keep Photon credentials in env vars and examples, never hardcoded.

## Defaults

- Use Convex for durable project/session state unless the user asked otherwise.
- Preserve iMessage-friendly output: concise text, no markdown-heavy UI copy.
- Treat Spectrum as the user-interaction layer and the app backend as the
  state/workflow layer.
