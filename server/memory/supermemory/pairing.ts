import { createHash, randomBytes as cryptoRandomBytes, timingSafeEqual } from "node:crypto";

export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1_000;

// Exactly 32 unambiguous characters lets each random byte contribute five
// unbiased bits without rejection sampling.
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_PATTERN = new RegExp(
  `^PAIR ([${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}})$`,
);
const PAIRING_DIGEST_CONTEXT = "daniel-primary-owner-pairing-v1\0";
const CANDIDATE_TOKEN_BYTES = 24;
const CANDIDATE_TOKEN_PREFIX = "pair_candidate_";

type RandomBytes = (size: number) => Uint8Array;

export interface PairingCoordinatorDependencies {
  now?: () => number;
  generateCode?: () => string;
  digest?: (code: string) => string;
}

export interface IssuedPairingCode {
  code: string;
  expiresAt: number;
}

export type PairingCommandResult =
  | { status: "not_pair_command" }
  | { status: "inactive" }
  | { status: "expired" }
  | { status: "invalid" }
  | { status: "matched" };

export interface PairingCoordinatorStatus {
  active: boolean;
  expiresAt: number | null;
}

interface ActivePairingCode {
  digest: string;
  expiresAt: number;
}

function defaultRandomBytes(size: number): Uint8Array {
  return cryptoRandomBytes(size);
}

function generatePairingCode(randomBytes: RandomBytes = defaultRandomBytes): string {
  const bytes = randomBytes(PAIRING_CODE_LENGTH);
  if (bytes.length !== PAIRING_CODE_LENGTH) {
    throw new Error(`pairing random source must return ${PAIRING_CODE_LENGTH} bytes`);
  }
  return Array.from(
    bytes,
    (byte) => PAIRING_CODE_ALPHABET[byte & (PAIRING_CODE_ALPHABET.length - 1)],
  ).join("");
}

function defaultDigest(code: string): string {
  return createHash("sha256").update(PAIRING_DIGEST_CONTEXT).update(code).digest("hex");
}

function validGeneratedCode(code: string): boolean {
  return PAIRING_CODE_PATTERN.test(`PAIR ${code}`);
}

function equalDigest(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/** Parses only the exact, case-sensitive `PAIR <code>` wire format. */
export function parsePairingCommand(content: string): string | null {
  if (typeof content !== "string") return null;
  return PAIRING_CODE_PATTERN.exec(content)?.[1] ?? null;
}

/**
 * Holds at most one pairing-code digest in process memory. Codes are one-time:
 * successful consumption, explicit invalidation, rotation, or expiry clears
 * the active state.
 */
export class PairingCoordinator {
  #activeCode: ActivePairingCode | null = null;
  private readonly now: () => number;
  private readonly generateCode: () => string;
  private readonly digest: (code: string) => string;

  constructor(dependencies: PairingCoordinatorDependencies = {}) {
    this.now = dependencies.now ?? Date.now;
    this.generateCode = dependencies.generateCode ?? (() => generatePairingCode());
    this.digest = dependencies.digest ?? defaultDigest;
  }

  /** Issues a fresh code and invalidates any previously issued code first. */
  rotate(): IssuedPairingCode {
    this.#activeCode = null;
    const code = this.generateCode();
    if (!validGeneratedCode(code)) {
      throw new Error(
        `pairing code generator must return ${PAIRING_CODE_LENGTH} allowed characters`,
      );
    }
    const expiresAt = this.now() + PAIRING_CODE_TTL_MS;
    this.#activeCode = { digest: this.digest(code), expiresAt };
    return { code, expiresAt };
  }

  invalidate(): void {
    this.#activeCode = null;
  }

  status(): PairingCoordinatorStatus {
    if (this.expireIfNeeded()) return { active: false, expiresAt: null };
    return this.#activeCode
      ? { active: true, expiresAt: this.#activeCode.expiresAt }
      : { active: false, expiresAt: null };
  }

  consumeCommand(content: string): PairingCommandResult {
    const code = parsePairingCommand(content);
    if (!code) return { status: "not_pair_command" };
    if (this.expireIfNeeded()) return { status: "expired" };
    if (!this.#activeCode) return { status: "inactive" };
    if (!equalDigest(this.#activeCode.digest, this.digest(code))) {
      return { status: "invalid" };
    }
    this.#activeCode = null;
    return { status: "matched" };
  }

  private expireIfNeeded(): boolean {
    if (!this.#activeCode || this.now() < this.#activeCode.expiresAt) return false;
    this.#activeCode = null;
    return true;
  }
}

/** Shared process-local coordinator used by the dashboard and inbound bridge. */
export const pairingCoordinator = new PairingCoordinator();

/** Creates an opaque capability suitable for referring to a pairing candidate. */
export function createPairingCandidateToken(
  randomBytes: RandomBytes = defaultRandomBytes,
): string {
  const bytes = randomBytes(CANDIDATE_TOKEN_BYTES);
  if (bytes.length !== CANDIDATE_TOKEN_BYTES) {
    throw new Error(`candidate token random source must return ${CANDIDATE_TOKEN_BYTES} bytes`);
  }
  return `${CANDIDATE_TOKEN_PREFIX}${Buffer.from(bytes).toString("base64url")}`;
}

export function isPairingCandidateToken(value: string): boolean {
  return /^pair_candidate_[A-Za-z0-9_-]{32}$/.test(value);
}

/** Produces a non-identifying label while retaining a short disambiguating suffix. */
export function maskPairingSenderLabel(senderId: string): string {
  const normalized = senderId.normalize("NFKC").trim();
  if (!normalized) return "unknown sender";
  const visible = Array.from(normalized).slice(-4).join("");
  return normalized.length <= 4 ? "••••" : `••••${visible}`;
}
