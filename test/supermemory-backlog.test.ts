import { describe, expect, it } from "vitest";
import { normalizeBacklog as normalizeRouteBacklog } from "../server/memory/supermemory/routes.js";
import { normalizeBacklog as normalizeWorkerBacklog } from "../server/memory/supermemory/sync-worker.js";

describe("Supermemory backlog accounting", () => {
  it("uses a supplied total unchanged even when dead letters are present", () => {
    expect(normalizeWorkerBacklog({ total: 6, deadLetter: 2 }).total).toBe(6);
    expect(normalizeRouteBacklog({ total: 6, deadLetter: 2 })?.total).toBe(6);
  });

  it("preserves valid all-zero counts", () => {
    expect(normalizeWorkerBacklog({ total: 0, active: 0, deadLetter: 0 }).total).toBe(0);
    expect(normalizeRouteBacklog({ total: 0, active: 0, deadLetter: 0 })?.total).toBe(0);
  });

  it("sums mutually exclusive statuses once when totals are absent", () => {
    const value = {
      pending: 1,
      processing: 2,
      submitted: 3,
      completed: 4,
      failed: 5,
      dead_letter: 6,
    };
    expect(normalizeWorkerBacklog(value).total).toBe(21);
    expect(normalizeRouteBacklog(value)?.total).toBe(21);
  });
});
