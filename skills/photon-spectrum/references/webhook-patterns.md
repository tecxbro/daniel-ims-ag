# Webhook And Event Patterns

Spectrum message streams should hand work to the app backend quickly and keep
transport concerns separate from product logic.

Recommended flow:

```txt
Spectrum inbound message
  -> dedupe by stable message id
  -> normalize sender/conversation id
  -> persist inbound message
  -> enqueue or call app workflow
  -> send concise reply through space.send()
```

Implementation notes:

- Dedupe inbound events before creating work.
- Keep a durable conversation id that maps back to the Photon/Spectrum space.
- Store pending user decisions in the backend so numeric iMessage replies can
  resume the right workflow.
- For long-running agent work, send only meaningful user-facing messages:
  clarifying questions, final plans, approvals, and final results.
- Never log or echo Photon secrets, message tokens, or user secrets.
