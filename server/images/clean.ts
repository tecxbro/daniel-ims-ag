import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";

const DEFAULT_RETENTION_DAYS = 3;
const DEFAULT_INTERVAL_MS = 12 * 60 * 60 * 1000;

function parseEnvNumber(
  name: string,
  fallback: number,
  opts: { min: number; integer?: boolean } = { min: 0 },
): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < opts.min) {
    console.warn(`[image-cleanup] ignoring invalid ${name}="${raw}", using ${fallback}`);
    return fallback;
  }
  return opts.integer ? Math.floor(n) : n;
}

export function getImageRetentionDays(): number {
  return parseEnvNumber("DANIEL_IMAGE_RETENTION_DAYS", DEFAULT_RETENTION_DAYS, {
    min: 0,
    integer: true,
  });
}

// Hard cap on how many expired rows we scan in one cleanup invocation.
// If more pages are available, the next interval resumes from a fresh scan.
const MAX_SCAN_PAGES = 50;
const ANCHOR_LOOKUP_BATCH_SIZE = 200;

async function findAnchoredStorageIds(storageIds: string[]): Promise<Set<string>> {
  const wanted = [...new Set(storageIds)];
  const found = new Set<string>();
  if (wanted.length === 0) return found;
  for (let offset = 0; offset < wanted.length; offset += ANCHOR_LOOKUP_BATCH_SIZE) {
    const batch = wanted.slice(offset, offset + ANCHOR_LOOKUP_BATCH_SIZE);
    const result = (await convex.query(api.memoryImageAnchors.findRetainedStorageIds, {
      storageIds: batch as never,
    })) as string[];
    for (const id of result) found.add(id);
  }
  return found;
}

export interface ImageCleanupDependencies {
  now: () => number;
  retentionDays: () => number;
  listExpired(input: {
    olderThanMs: number;
    cursor: string | null;
    scanLimit: number;
  }): Promise<{
    rows: Array<{ _id: string; imageStorageIds?: string[] }>;
    isDone: boolean;
    continueCursor: string | null;
  }>;
  findRetainedStorageIds(storageIds: string[]): Promise<Set<string>>;
  clearMessageImage(messageId: string, storageId: string): Promise<void>;
  deleteStorageIfUnretained(storageId: string): Promise<{ deleted: boolean; reason?: string }>;
}

const defaultCleanupDependencies: ImageCleanupDependencies = {
  now: Date.now,
  retentionDays: getImageRetentionDays,
  async listExpired(input) {
    return (await convex.query(api.messages.expiredWithImages, {
      olderThanMs: input.olderThanMs,
      cursor: input.cursor,
      scanLimit: input.scanLimit,
    } as never)) as {
      rows: Array<{ _id: string; imageStorageIds?: string[] }>;
      isDone: boolean;
      continueCursor: string | null;
    };
  },
  findRetainedStorageIds: findAnchoredStorageIds,
  async clearMessageImage(messageId, storageId) {
    await convex.mutation(api.messages.clearMessageImage, {
      messageId: messageId as never,
      storageId: storageId as never,
    });
  },
  async deleteStorageIfUnretained(storageId) {
    return (await convex.mutation(api.memoryImageAnchors.deleteStorageIfUnretained, {
      storageId: storageId as never,
    })) as { deleted: boolean; reason?: string };
  },
};

export async function runImageCleanupWithDependencies(
  dependencies: ImageCleanupDependencies,
): Promise<{ deleted: number; kept: number }> {
  const retention = dependencies.retentionDays();
  if (retention === 0) return { deleted: 0, kept: 0 };

  const olderThanMs = dependencies.now() - retention * 24 * 60 * 60 * 1000;
  let deleted = 0;
  let kept = 0;
  let cursor: string | null = null;

  for (let page = 0; page < MAX_SCAN_PAGES; page++) {
    const result = await dependencies.listExpired({
      olderThanMs,
      cursor,
      scanLimit: 200,
    });

    const pairs = result.rows.flatMap((msg) =>
      (msg.imageStorageIds ?? []).map((storageId) => ({ messageId: msg._id, storageId })),
    );
    let anchoredStorageIds: Set<string>;
    try {
      anchoredStorageIds = await dependencies.findRetainedStorageIds(
        pairs.map((p) => p.storageId),
      );
    } catch (err) {
      console.warn("[image-cleanup] anchor scan failed; keeping page", err);
      kept += pairs.length;
      if (result.isDone) break;
      if (result.continueCursor === cursor) break;
      cursor = result.continueCursor;
      continue;
    }
    const toDelete = pairs.filter((p) => !anchoredStorageIds.has(p.storageId));
    kept += pairs.length - toDelete.length;
    const refsByStorageId = new Map<string, typeof toDelete>();
    for (const ref of toDelete) {
      refsByStorageId.set(ref.storageId, [
        ...(refsByStorageId.get(ref.storageId) ?? []),
        ref,
      ]);
    }
    await Promise.all(
      [...refsByStorageId].map(async ([storageId, refs]) => {
        let failedRefs = 0;
        for (const p of refs) {
          try {
            await dependencies.clearMessageImage(p.messageId, storageId);
          } catch (err) {
            failedRefs += 1;
            console.warn(`[image-cleanup] failed to clear message ref ${storageId}`, err);
          }
        }
        if (failedRefs > 0) {
          kept += refs.length;
          return;
        }
        try {
          const result = await dependencies.deleteStorageIfUnretained(storageId);
          if (result.deleted) deleted += 1;
          else kept += refs.length;
        } catch (err) {
          kept += refs.length;
          console.warn(`[image-cleanup] failed to delete image bytes ${storageId}`, err);
        }
      }),
    );

    if (result.isDone) break;
    if (result.continueCursor === cursor) break;
    cursor = result.continueCursor;
  }

  return { deleted, kept };
}

export function runImageCleanup(): Promise<{ deleted: number; kept: number }> {
  return runImageCleanupWithDependencies(defaultCleanupDependencies);
}

export function startImageCleanup(): () => void {
  if (getImageRetentionDays() === 0) {
    console.log("[image-cleanup] disabled (DANIEL_IMAGE_RETENTION_DAYS=0)");
    return () => undefined;
  }
  const intervalMs = parseEnvNumber("DANIEL_IMAGE_CLEANUP_INTERVAL_MS", DEFAULT_INTERVAL_MS, {
    min: 1,
  });
  console.log(
    `[image-cleanup] enabled (retention=${getImageRetentionDays()}d, interval=${intervalMs}ms)`,
  );
  // In-flight guard so a slow cleanup can't race against the next tick.
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runImageCleanup();
      if (r.deleted > 0 || r.kept > 0) {
        console.log(`[image-cleanup] deleted=${r.deleted} kept=${r.kept}`);
      }
    } catch (err) {
      console.warn("[image-cleanup] tick failed", err);
    } finally {
      running = false;
    }
  };
  void tick();
  const handle = setInterval(tick, intervalMs);
  return () => clearInterval(handle);
}
