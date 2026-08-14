import { api } from "../../../convex/_generated/api.js";
import { convex } from "../../convex-client.js";
import {
  deriveMemoryIdentity,
  isValidMemoryIdSalt,
  memoryIdSaltFingerprint,
  memoryPairingAuthorityProof,
} from "./identity.js";
import {
  createPairingCandidateToken,
  maskPairingSenderLabel,
  pairingCoordinator,
  type PairingCommandResult,
} from "./pairing.js";

const CANDIDATE_TTL_MS = 10 * 60 * 1_000;
const MAX_CANDIDATES = 25;

export type IdentityRuntimeStatus = "ready" | "unconfigured" | "recovery_required";
export type PrimaryOwnerRegistrationStatus =
  | "registered"
  | "existing"
  | "conflict"
  | "recovery_required";

export interface PrimaryOwnerScope {
  ownerKey: string;
  containerTag: string;
  conversationId: string;
  registeredAt: number;
}

interface CandidateEntry {
  conversationId: string;
  expiresAt: number;
}

const candidates = new Map<string, CandidateEntry>();

function currentSalt(): string | undefined {
  const value = process.env.DANIEL_MEMORY_ID_SALT?.trim();
  return isValidMemoryIdSalt(value) ? value : undefined;
}

function identityMaterial(salt: string): {
  saltFingerprint: string;
  pairingAuthorityProof: string;
} {
  return {
    saltFingerprint: memoryIdSaltFingerprint(salt),
    pairingAuthorityProof: memoryPairingAuthorityProof(salt),
  };
}

export async function ensureMemoryIdentityRuntime(): Promise<{
  status: IdentityRuntimeStatus;
  saltFingerprint?: string;
  pairingAuthorityProof?: string;
}> {
  const presence = await convex.query(api.memoryProviderState.getIdentityPresence, {});
  const salt = currentSalt();
  if (!salt) {
    return {
      status:
        presence.hasSaltFingerprint ||
        presence.hasPairingAuthority ||
        presence.hasPrimaryOwner ||
        presence.recoveryRequired
          ? "recovery_required"
          : "unconfigured",
    };
  }
  try {
    const material = identityMaterial(salt);
    const result = await convex.mutation(
      api.memoryProviderState.verifyIdentityConfiguration,
      material,
    );
    return result.status === "ready"
      ? { status: "ready", ...material }
      : { status: result.status };
  } catch {
    return { status: "recovery_required" };
  }
}

export async function getPrimaryOwnerScope(): Promise<PrimaryOwnerScope | null> {
  const identity = await ensureMemoryIdentityRuntime();
  if (identity.status !== "ready" || !identity.pairingAuthorityProof) return null;
  return await convex.query(api.memoryProviderState.getPrimaryOwnerForServer, {
    pairingAuthorityProof: identity.pairingAuthorityProof,
  });
}

async function registerConversation(
  conversationId: string,
): Promise<PrimaryOwnerRegistrationStatus> {
  const identityState = await ensureMemoryIdentityRuntime();
  if (
    identityState.status !== "ready" ||
    !identityState.saltFingerprint ||
    !identityState.pairingAuthorityProof
  ) {
    return "recovery_required";
  }
  const sender = conversationId.slice("sms:".length);
  const owner = deriveMemoryIdentity(
    { memoryOwnerId: sender, conversationId },
    {
      expectedSaltFingerprint: identityState.saltFingerprint,
    },
  );
  const result = await convex.mutation(api.memoryProviderState.registerPrimaryOwner, {
    ownerKey: owner.ownerKey,
    containerTag: owner.containerTag,
    conversationId,
    saltFingerprint: identityState.saltFingerprint,
    pairingAuthorityProof: identityState.pairingAuthorityProof,
  });
  return result.status;
}

export async function consumePrimaryOwnerPairingCommand(input: {
  content: string;
  conversationId: string;
}): Promise<
  | PairingCommandResult
  | { status: PrimaryOwnerRegistrationStatus }
> {
  const result = pairingCoordinator.consumeCommand(input.content);
  if (result.status !== "matched") return result;
  return { status: await registerConversation(input.conversationId) };
}

export async function rotatePrimaryOwnerPairingCode() {
  const identity = await ensureMemoryIdentityRuntime();
  if (identity.status !== "ready") return { status: identity.status } as const;
  if (await getPrimaryOwnerScope()) {
    pairingCoordinator.invalidate();
    return { status: "paired" as const };
  }
  return { status: "ready" as const, ...pairingCoordinator.rotate() };
}

function purgeCandidates(now: number): void {
  for (const [token, candidate] of candidates) {
    if (candidate.expiresAt <= now) candidates.delete(token);
  }
}

export async function listPrimaryOwnerCandidates(now = Date.now()): Promise<
  Array<{ token: string; label: string; lastInboundAt: number; expiresAt: number }>
> {
  purgeCandidates(now);
  const identity = await ensureMemoryIdentityRuntime();
  if (identity.status !== "ready" || !identity.pairingAuthorityProof) return [];
  // Only the most recently displayed bounded candidate set remains valid.
  candidates.clear();
  const rows = await convex.query(api.messages.recentInboundSms, {
    pairingAuthorityProof: identity.pairingAuthorityProof,
    limit: 100,
  });
  const seen = new Set<string>();
  const result: Array<{
    token: string;
    label: string;
    lastInboundAt: number;
    expiresAt: number;
  }> = [];
  for (const row of rows) {
    if (seen.has(row.conversationId)) continue;
    seen.add(row.conversationId);
    const token = createPairingCandidateToken();
    const expiresAt = now + CANDIDATE_TTL_MS;
    candidates.set(token, { conversationId: row.conversationId, expiresAt });
    result.push({
      token,
      label: maskPairingSenderLabel(row.conversationId.slice("sms:".length)),
      lastInboundAt: row.createdAt,
      expiresAt,
    });
    if (result.length >= MAX_CANDIDATES) break;
  }
  return result;
}

export async function confirmPrimaryOwnerCandidate(
  token: string,
  now = Date.now(),
): Promise<PrimaryOwnerRegistrationStatus | "invalid_candidate"> {
  purgeCandidates(now);
  const candidate = candidates.get(token);
  if (!candidate) return "invalid_candidate";
  candidates.delete(token);
  const identity = await ensureMemoryIdentityRuntime();
  if (identity.status !== "ready" || !identity.pairingAuthorityProof) {
    return "recovery_required";
  }
  const valid = await convex.query(api.messages.hasInboundUserMessage, {
    pairingAuthorityProof: identity.pairingAuthorityProof,
    conversationId: candidate.conversationId,
  });
  if (!valid) return "invalid_candidate";
  const status = await registerConversation(candidate.conversationId);
  if (status === "registered" || status === "existing") {
    pairingCoordinator.invalidate();
  }
  return status;
}

export async function primaryOwnerPairingStatus() {
  const [identity, owner] = await Promise.all([
    ensureMemoryIdentityRuntime(),
    getPrimaryOwnerScope(),
  ]);
  if (owner) pairingCoordinator.invalidate();
  const code = pairingCoordinator.status();
  return {
    paired: owner !== null,
    identityStatus: identity.status,
    codeActive: code.active,
    codeExpiresAt: code.expiresAt,
  };
}
