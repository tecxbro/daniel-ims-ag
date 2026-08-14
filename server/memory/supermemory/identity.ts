import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { MemoryOwnerContext } from "./types.js";

const PROVIDER_IDENTIFIER_PATTERN = /^[a-zA-Z0-9_:-]+$/;
const MAX_PROVIDER_IDENTIFIER_LENGTH = 100;
const MAX_SOURCE_IDENTIFIER_LENGTH = 512;
const KEY_LENGTH = 32;
const SALT_FINGERPRINT_CONTEXT = "daniel-memory-id-salt-fingerprint-v1";

export class MemoryIdentityConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryIdentityConfigurationError";
  }
}

function requireSalt(explicitSalt?: string): string {
  const salt = explicitSalt ?? process.env.DANIEL_MEMORY_ID_SALT;
  if (!salt || salt.trim().length === 0) {
    throw new MemoryIdentityConfigurationError(
      "DANIEL_MEMORY_ID_SALT is required to derive private memory identifiers",
    );
  }
  return salt;
}

function normalizeSourceIdentifier(value: string, label: string, lowercase: boolean): string {
  if (typeof value !== "string") {
    throw new MemoryIdentityConfigurationError(`${label} must be a string`);
  }
  const normalized = value.normalize("NFKC").trim();
  if (!normalized) {
    throw new MemoryIdentityConfigurationError(`${label} must not be empty`);
  }
  if (normalized.length > MAX_SOURCE_IDENTIFIER_LENGTH) {
    throw new MemoryIdentityConfigurationError(
      `${label} must be ${MAX_SOURCE_IDENTIFIER_LENGTH} characters or fewer`,
    );
  }
  if (/\p{Cc}/u.test(normalized)) {
    throw new MemoryIdentityConfigurationError(`${label} must not contain control characters`);
  }
  return lowercase ? normalized.toLocaleLowerCase("en-US") : normalized;
}

export function normalizeMemoryOwnerId(memoryOwnerId: string): string {
  return normalizeSourceIdentifier(memoryOwnerId, "memoryOwnerId", true);
}

export function normalizeConversationId(conversationId: string): string {
  return normalizeSourceIdentifier(conversationId, "conversationId", false);
}

function hmacKey(salt: string, value: string): string {
  return createHmac("sha256", salt).update(value, "utf8").digest("hex").slice(0, KEY_LENGTH);
}

export function validateProviderIdentifier(value: string, label = "provider identifier"): string {
  if (!value || value.length > MAX_PROVIDER_IDENTIFIER_LENGTH) {
    throw new MemoryIdentityConfigurationError(
      `${label} must be between 1 and ${MAX_PROVIDER_IDENTIFIER_LENGTH} characters`,
    );
  }
  if (!PROVIDER_IDENTIFIER_PATTERN.test(value)) {
    throw new MemoryIdentityConfigurationError(
      `${label} may contain only alphanumeric characters, underscores, hyphens, and colons`,
    );
  }
  return value;
}

export function memoryIdSaltFingerprint(explicitSalt?: string): string {
  const salt = requireSalt(explicitSalt);
  return hmacKey(salt, SALT_FINGERPRINT_CONTEXT);
}

export function assertMemoryIdSaltStable(
  expectedFingerprint: string | undefined,
  explicitSalt?: string,
): string {
  const actualFingerprint = memoryIdSaltFingerprint(explicitSalt);
  if (!expectedFingerprint) return actualFingerprint;
  if (!/^[a-f0-9]{32}$/.test(expectedFingerprint)) {
    throw new MemoryIdentityConfigurationError("stored memory ID salt fingerprint is invalid");
  }
  const matches = timingSafeEqual(
    Buffer.from(expectedFingerprint, "utf8"),
    Buffer.from(actualFingerprint, "utf8"),
  );
  if (!matches) {
    throw new MemoryIdentityConfigurationError(
      "DANIEL_MEMORY_ID_SALT changed after memory identities were initialized; restore the previous deployment secret before continuing",
    );
  }
  return actualFingerprint;
}

export interface DeriveMemoryIdentityInput {
  memoryOwnerId: string;
  conversationId: string;
}

export interface DeriveMemoryIdentityOptions {
  salt?: string;
  expectedSaltFingerprint?: string;
}

export function deriveMemoryIdentity(
  input: DeriveMemoryIdentityInput,
  options: DeriveMemoryIdentityOptions = {},
): MemoryOwnerContext {
  const salt = requireSalt(options.salt);
  const memoryOwnerId = normalizeMemoryOwnerId(input.memoryOwnerId);
  const conversationId = normalizeConversationId(input.conversationId);
  const ownerKey = hmacKey(salt, memoryOwnerId);
  const conversationKey = hmacKey(salt, conversationId);
  const containerTag = validateProviderIdentifier(`daniel-user-${ownerKey}`, "containerTag");
  const customId = validateProviderIdentifier(`daniel-conv-${conversationKey}`, "customId");
  const saltFingerprint = assertMemoryIdSaltStable(options.expectedSaltFingerprint, salt);

  return {
    memoryOwnerId,
    ownerKey,
    containerTag,
    conversationId,
    conversationKey,
    customId,
    saltFingerprint,
  };
}
