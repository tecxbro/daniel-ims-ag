import { afterEach, describe, expect, it } from "vitest";
import {
  assertMemoryIdSaltStable,
  deriveMemoryIdentity,
  isValidMemoryIdSalt,
  memoryIdSaltFingerprint,
  normalizeMemoryOwnerId,
  validateProviderIdentifier,
} from "../server/memory/supermemory/identity.js";

const SALT_A = "1".repeat(64);
const SALT_B = "2".repeat(64);

describe("Supermemory identity derivation", () => {
  const originalSalt = process.env.DANIEL_MEMORY_ID_SALT;

  afterEach(() => {
    if (originalSalt === undefined) delete process.env.DANIEL_MEMORY_ID_SALT;
    else process.env.DANIEL_MEMORY_ID_SALT = originalSalt;
  });

  it("derives deterministic owner and conversation identifiers", () => {
    const first = deriveMemoryIdentity(
      { memoryOwnerId: "  USER@example.com ", conversationId: "sms:+15551234567" },
      { salt: SALT_A },
    );
    const second = deriveMemoryIdentity(
      { memoryOwnerId: "user@example.com", conversationId: "sms:+15551234567" },
      { salt: SALT_A },
    );

    expect(first).toEqual(second);
    expect(first.memoryOwnerId).toBe("user@example.com");
    expect(first.ownerKey).toMatch(/^[a-f0-9]{32}$/);
    expect(first.conversationKey).toMatch(/^[a-f0-9]{32}$/);
    expect(first.containerTag).toMatch(/^daniel-user-[a-f0-9]{32}$/);
    expect(first.customId).toMatch(/^daniel-conv-[a-f0-9]{32}$/);
  });

  it("isolates different users while keeping one container per owner", () => {
    const firstConversation = deriveMemoryIdentity(
      { memoryOwnerId: "+15551234567", conversationId: "sms:+15551234567" },
      { salt: SALT_A },
    );
    const sameOwnerOtherConversation = deriveMemoryIdentity(
      { memoryOwnerId: "+15551234567", conversationId: "sms:group-example" },
      { salt: SALT_A },
    );
    const otherUser = deriveMemoryIdentity(
      { memoryOwnerId: "+15557654321", conversationId: "sms:+15557654321" },
      { salt: SALT_A },
    );

    expect(sameOwnerOtherConversation.containerTag).toBe(firstConversation.containerTag);
    expect(sameOwnerOtherConversation.customId).not.toBe(firstConversation.customId);
    expect(otherUser.containerTag).not.toBe(firstConversation.containerTag);
  });

  it("never places raw phone numbers in provider identifiers", () => {
    const phone = "+15551234567";
    const identity = deriveMemoryIdentity(
      { memoryOwnerId: phone, conversationId: `sms:${phone}` },
      { salt: SALT_A },
    );

    for (const providerIdentifier of [
      identity.ownerKey,
      identity.conversationKey,
      identity.containerTag,
      identity.customId,
    ]) {
      expect(providerIdentifier).not.toContain(phone);
      expect(providerIdentifier).not.toContain(phone.replace(/\D/g, ""));
    }
  });

  it("rejects invalid source and provider identifiers", () => {
    expect(() => normalizeMemoryOwnerId("   ")).toThrow(/must not be empty/);
    expect(() => normalizeMemoryOwnerId(`user\u0000id`)).toThrow(/control characters/);
    expect(() => validateProviderIdentifier("contains a space")).toThrow(/may contain only/);
    expect(() => validateProviderIdentifier("a".repeat(101))).toThrow(/100 characters/);
    expect(() =>
      deriveMemoryIdentity(
        { memoryOwnerId: "user", conversationId: "x".repeat(513) },
        { salt: SALT_A },
      ),
    ).toThrow(/conversationId must be 512 characters or fewer/);
  });

  it("fails clearly when the salt is missing", () => {
    delete process.env.DANIEL_MEMORY_ID_SALT;
    expect(() =>
      deriveMemoryIdentity({ memoryOwnerId: "user", conversationId: "conversation" }),
    ).toThrow(/DANIEL_MEMORY_ID_SALT is required/);
  });

  it("rejects malformed or weak salts", () => {
    expect(isValidMemoryIdSalt("a".repeat(64))).toBe(true);
    expect(isValidMemoryIdSalt("x")).toBe(false);
    expect(() =>
      deriveMemoryIdentity(
        { memoryOwnerId: "user", conversationId: "conversation" },
        { salt: "x" },
      ),
    ).toThrow(/32-byte lowercase hexadecimal value/);
  });

  it("detects salt drift as a deployment-breaking error", () => {
    const persistedFingerprint = memoryIdSaltFingerprint(SALT_A);
    expect(assertMemoryIdSaltStable(persistedFingerprint, SALT_A)).toBe(persistedFingerprint);
    expect(() => assertMemoryIdSaltStable(persistedFingerprint, SALT_B)).toThrow(
      /changed after memory identities were initialized/,
    );
  });
});
