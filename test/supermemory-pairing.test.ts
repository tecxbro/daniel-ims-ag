import { describe, expect, it } from "vitest";
import {
  PAIRING_CODE_TTL_MS,
  PairingCoordinator,
  createPairingCandidateToken,
  isPairingCandidateToken,
  maskPairingSenderLabel,
  parsePairingCommand,
} from "../server/memory/supermemory/pairing.js";

const FIRST_CODE = "ABCDEFGH";
const SECOND_CODE = "JKLMNPQR";

describe("in-memory primary-owner pairing", () => {
  it("issues an eight-character code for exactly ten minutes without exposing its digest", () => {
    let now = 1_000;
    const coordinator = new PairingCoordinator({
      now: () => now,
      generateCode: () => FIRST_CODE,
    });

    const issued = coordinator.rotate();
    expect(issued).toEqual({ code: FIRST_CODE, expiresAt: now + PAIRING_CODE_TTL_MS });
    expect(coordinator.status()).toEqual({
      active: true,
      expiresAt: now + PAIRING_CODE_TTL_MS,
    });
    expect(JSON.stringify(coordinator)).not.toContain(FIRST_CODE);
    expect(issued).not.toHaveProperty("digest");

    now += PAIRING_CODE_TTL_MS;
    expect(coordinator.status()).toEqual({ active: false, expiresAt: null });
  });

  it("accepts only the exact, case-sensitive PAIR command", () => {
    expect(parsePairingCommand(`PAIR ${FIRST_CODE}`)).toBe(FIRST_CODE);
    for (const malformed of [
      `pair ${FIRST_CODE}`,
      `PAIR  ${FIRST_CODE}`,
      `PAIR ${FIRST_CODE} `,
      `PAIR ${FIRST_CODE}\n`,
      `PAIR ABCDEFG`,
      `PAIR ABCDEFGI`,
      `hello PAIR ${FIRST_CODE}`,
    ]) {
      expect(parsePairingCommand(malformed)).toBeNull();
    }
  });

  it("consumes a matching code once and distinguishes malformed and invalid attempts", () => {
    const coordinator = new PairingCoordinator({ generateCode: () => FIRST_CODE });
    coordinator.rotate();

    expect(coordinator.consumeCommand("hello")).toEqual({ status: "not_pair_command" });
    expect(coordinator.consumeCommand(`PAIR ${SECOND_CODE}`)).toEqual({ status: "invalid" });
    expect(coordinator.consumeCommand(`PAIR ${FIRST_CODE}`)).toEqual({ status: "matched" });
    expect(coordinator.consumeCommand(`PAIR ${FIRST_CODE}`)).toEqual({ status: "inactive" });
  });

  it("rotation invalidates the prior code", () => {
    const generated = [FIRST_CODE, SECOND_CODE];
    const coordinator = new PairingCoordinator({
      generateCode: () => generated.shift()!,
    });

    coordinator.rotate();
    coordinator.rotate();
    expect(coordinator.consumeCommand(`PAIR ${FIRST_CODE}`)).toEqual({ status: "invalid" });
    expect(coordinator.consumeCommand(`PAIR ${SECOND_CODE}`)).toEqual({ status: "matched" });
  });

  it("invalidates the prior code even when rotation cannot issue a replacement", () => {
    let call = 0;
    const coordinator = new PairingCoordinator({
      generateCode: () => (++call === 1 ? FIRST_CODE : "invalid"),
    });

    coordinator.rotate();
    expect(() => coordinator.rotate()).toThrow(/generator/);
    expect(coordinator.consumeCommand(`PAIR ${FIRST_CODE}`)).toEqual({ status: "inactive" });
  });

  it("never accepts a correct code at or after its expiry", () => {
    let now = 5_000;
    const coordinator = new PairingCoordinator({
      now: () => now,
      generateCode: () => FIRST_CODE,
    });
    const { expiresAt } = coordinator.rotate();

    now = expiresAt;
    expect(coordinator.consumeCommand(`PAIR ${FIRST_CODE}`)).toEqual({ status: "expired" });
    now = expiresAt - 1;
    expect(coordinator.consumeCommand(`PAIR ${FIRST_CODE}`)).toEqual({ status: "inactive" });
  });

  it("uses injected digest logic without returning the digest", () => {
    const digested: string[] = [];
    const coordinator = new PairingCoordinator({
      generateCode: () => FIRST_CODE,
      digest: (code) => {
        digested.push(code);
        return `digest-${code.length}`;
      },
    });

    expect(coordinator.rotate()).toEqual({
      code: FIRST_CODE,
      expiresAt: expect.any(Number),
    });
    expect(coordinator.consumeCommand(`PAIR ${FIRST_CODE}`)).toEqual({ status: "matched" });
    expect(digested).toEqual([FIRST_CODE, FIRST_CODE]);
  });

  it("creates opaque candidate tokens and masks sender labels", () => {
    const token = createPairingCandidateToken(() => new Uint8Array(24).fill(7));
    expect(token).toBe("pair_candidate_BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH");
    expect(isPairingCandidateToken(token)).toBe(true);
    expect(isPairingCandidateToken("pair_candidate_short")).toBe(false);
    expect(maskPairingSenderLabel("+15551234567")).toBe("••••4567");
    expect(maskPairingSenderLabel("abc")).toBe("••••");
    expect(maskPairingSenderLabel("   ")).toBe("unknown sender");
  });
});
