# Image Viewing — Design

**Date:** 2026-05-13\
**Status:** Implemented; updated for current Photon Spectrum architecture on 2026-05-31\
**Topic:** Let Daniel view images sent over iMessage.

---

## 1. Goals

Let Daniel see images the user texts it. The interaction agent sees image content directly, can pass relevant images to spawned execution agents, and can store image-linked memory records when the image is worth remembering.

## 2. Non-goals

- Sending images outbound from Daniel.
- Image generation.
- Multi-modal documents such as PDF or video.

## 3. Architecture Overview

```
iMessage -> Photon Spectrum SDK -> server/imessage.ts
                                          |
                                          v
                                  Convex file storage
                                          |
                                          v
                                  Interaction Agent
                                  (text + image)
                                          |
                 +------------------------+------------------------+
                 v                        v                        v
          spawn_agent with         memory extraction          direct reply
          imageRefs[]              image description
                 |
                 v
          Execution Agent
          (receives image content blocks)
```

Photon Spectrum is a long-lived SDK stream, not an inbound HTTP webhook. `server/imessage.ts` handles inbound messages, typing indicators, outbound sends, dedupe, and attachment ingestion.

## 4. Configuration

| Env var | Values | Default | Meaning |
|---|---|---|---|
| `DANIEL_IMAGE_RETENTION_DAYS` | integer | `3` | TTL for raw image bytes in Convex storage. `0` disables cleanup. |
| `DANIEL_IMAGE_CLEANUP_INTERVAL_MS` | integer | `43200000` (12h) | How often the cleanup sweep runs. |

Raw image cleanup is controlled by `DANIEL_IMAGE_RETENTION_DAYS` and `DANIEL_IMAGE_CLEANUP_INTERVAL_MS`.

## 5. Image Pipeline

### 5.1 Ingest (`server/imessage.ts`)

- Photon Spectrum message content can contain image attachments.
- Daniel reads the attachment bytes through Spectrum, then validates:
  - size cap before buffering unbounded content
  - MIME allowlist: `image/jpeg`, `image/png`, `image/webp`, `image/gif`
- Valid images are uploaded to Convex file storage.
- Returned `Id<"_storage">` values are stored on the `messages.imageStorageIds` field.
- On failure, the message remains text-only with `mediaError` set so the dispatcher can still answer.

### 5.2 Dispatcher Consumption (`server/interaction-agent.ts`)

When a user turn has `imageStorageIds`:

- Daniel fetches the stored image bytes from Convex storage.
- `server/images/content-blocks.ts` builds provider-specific image content blocks.
- The dispatcher prompt includes both text and image content.
- If stored image bytes cannot be retrieved, the turn falls back to text-only handling with a note.

### 5.3 Propagation To Execution Agents (`server/execution-agent.ts`)

- `spawn_agent` accepts optional `imageRefs`.
- If the model omits image refs during an image turn, Daniel attaches all current-turn images by default.
- Non-empty `imageRefs` can narrow the set.
- The dispatcher filters image refs against images attached to the current inbound turn.
- Execution agents receive image content blocks when the task depends on those images.

### 5.4 Memory Extraction (`server/memory/extract.ts`)

- Image turns are available to the post-turn extraction pass.
- If the image is worth remembering, extraction can write a description-style memory with `imageStorageIds`.
- That makes requests like "remember that photo I sent" searchable through memory recall.

### 5.5 Schema (`convex/schema.ts`)

`messages` includes:

- `imageStorageIds?: v.array(v.id("_storage"))`
- `mediaError?: v.string()`
- `by_createdAt` index for cleanup scans

`memoryRecords` includes:

- `imageStorageIds?: v.array(v.id("_storage"))`

## 6. Retention And Cleanup

Raw image bytes are deleted after `DANIEL_IMAGE_RETENTION_DAYS` unless a memory record still references the storage id.

`server/images/clean.ts` runs a bounded, idempotent sweep:

```
for each page of old messages with imageStorageIds:
  for each storageId:
    if no memoryRecords row references storageId:
      delete bytes from Convex storage
      remove storageId from messages.imageStorageIds
```

`DANIEL_IMAGE_RETENTION_DAYS=0` disables cleanup for debugging.

## 7. Dashboard

- Dashboard metrics include image storage count.
- Memory records can show image-linked markers.
- No manual image purge control exists in this design.

## 8. Error Handling

| Failure | Behavior |
|---|---|
| Spectrum attachment missing or unreadable | Store message text-only, set/log `mediaError` when available |
| Image download/read timeout or HTTP error | Store message text-only with a short media error |
| Image exceeds size cap | Reject that image and keep the text turn |
| Unsupported MIME type | Reject that image and keep the text turn |
| Convex storage upload fails | Drop bytes, keep the text turn |
| Dispatcher SDK call rejects images | Retry without images and include a text-only note |
| `spawn_agent({ imageRefs })` references a missing id | Tool result reports a structured error; dispatcher can retry without the image |
| Memory extraction fails on image turn | Log failure and do not block the user reply |

## 9. Testing Strategy

Vitest is now part of the repo. High-value coverage should focus on:

1. MIME and size validation in `server/images/mime.ts`.
2. Content-block conversion in `server/images/content-blocks.ts`.
3. Fallback behavior when storage reads fail.
4. Cleanup behavior for memory-anchored versus unanchored images.

Run with:

```bash
npm test
```

## 10. Manual Smoke Test Checklist

1. Text Daniel a single PNG with caption "what's in this photo?" and verify the reply describes it.
2. Text a JPEG with no caption and verify the reply is contextually appropriate.
3. Text two images in one message and verify both ids are stored on `messages.imageStorageIds`.
4. Text an oversized image and verify graceful text-only handling.
5. Text a PDF and verify graceful rejection.
6. Send a photo and ask Daniel to search for the product; verify `spawn_agent` receives image refs.
7. Ask later about the photo and verify memory recall can surface the image description.
8. Verify unanchored images are cleaned after the retention window.
9. Verify memory-referenced images survive past the retention window.

## 11. Schema Migration Notes

All schema additions are optional. No backfill is required for existing rows. The `by_createdAt` index on `messages` is additive.
