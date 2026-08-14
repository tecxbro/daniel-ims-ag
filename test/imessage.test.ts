import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chunk,
  conversationIdForPhone,
  ingestSpectrumAttachment,
  messageDedupKey,
  normalizeE164,
  sendImessage,
  stripMarkdown,
  type SpectrumAttachmentLike,
} from "../server/imessage.js";

describe("Photon iMessage bridge helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes phone numbers and preserves sms conversation IDs", () => {
    expect(normalizeE164("+15551234567")).toBe("+15551234567");
    expect(normalizeE164("(555) 123-4567")).toBe("+15551234567");
    expect(normalizeE164("15551234567")).toBe("+15551234567");
    expect(normalizeE164("not-a-phone")).toBeUndefined();
    expect(conversationIdForPhone("+15551234567")).toBe("sms:+15551234567");
  });

  it("builds stable Photon message dedup keys", () => {
    expect(messageDedupKey({ platform: "iMessage", id: "p:0/ABC" })).toBe(
      "photon:iMessage:p:0/ABC",
    );
  });

  it("strips markdown and chunks long messages for iMessage sends", () => {
    expect(stripMarkdown("**Hello** [site](https://example.com)")).toBe(
      "Hello site (https://example.com)",
    );
    expect(chunk(["a".repeat(10), "b".repeat(10)].join("\n"), 12)).toEqual([
      "aaaaaaaaaa",
      "bbbbbbbbbb",
    ]);
  });

  it("ingests valid Spectrum image attachments", async () => {
    const attachment: SpectrumAttachmentLike = {
      type: "attachment",
      name: "photo.png",
      mimeType: "image/png",
      size: 3,
      read: async () => Buffer.from([1, 2, 3]),
    };
    const upload = vi.fn(async () => "storage_123");

    await expect(ingestSpectrumAttachment(attachment, upload)).resolves.toEqual({
      ok: true,
      image: { storageId: "storage_123", mediaType: "image/png" },
    });
    expect(upload).toHaveBeenCalledWith(Buffer.from([1, 2, 3]), "image/png");
  });

  it("rejects non-image Spectrum attachments before upload", async () => {
    const attachment: SpectrumAttachmentLike = {
      type: "attachment",
      name: "doc.pdf",
      mimeType: "application/pdf",
      size: 3,
      read: async () => Buffer.from([1, 2, 3]),
    };
    const upload = vi.fn(async () => "storage_123");

    const result = await ingestSpectrumAttachment(attachment, upload);
    expect(result).toMatchObject({ ok: false });
    expect(upload).not.toHaveBeenCalled();
  });

  it("no-ops outbound sends when Photon credentials are missing", async () => {
    const oldProjectId = process.env.PHOTON_PROJECT_ID;
    const oldProjectSecret = process.env.PHOTON_PROJECT_SECRET;
    delete process.env.PHOTON_PROJECT_ID;
    delete process.env.PHOTON_PROJECT_SECRET;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(sendImessage("+15551234567", "hello")).resolves.toBe(false);
      expect(warn).toHaveBeenCalledWith("[imessage] missing Photon credentials - not sending");
    } finally {
      if (oldProjectId === undefined) delete process.env.PHOTON_PROJECT_ID;
      else process.env.PHOTON_PROJECT_ID = oldProjectId;
      if (oldProjectSecret === undefined) delete process.env.PHOTON_PROJECT_SECRET;
      else process.env.PHOTON_PROJECT_SECRET = oldProjectSecret;
    }
  });

  it("reports whether every outbound chunk was delivered", async () => {
    const deliveredSpace = { send: vi.fn(async () => undefined) };
    await expect(sendImessage("+15551234567", "hello", {
      space: deliveredSpace as never,
    })).resolves.toBe(true);

    const failedSpace = {
      send: vi.fn(async () => {
        throw new Error("transport unavailable");
      }),
    };
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(sendImessage("+15551234567", "hello", {
      space: failedSpace as never,
    })).resolves.toBe(false);
  });
});
