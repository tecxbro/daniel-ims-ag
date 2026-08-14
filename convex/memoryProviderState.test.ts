// @vitest-environment edge-runtime
/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");
const saltFingerprint = "a".repeat(32);
const pairingAuthorityProof = "b".repeat(64);
const ownerKey = "c".repeat(32);
const owner = {
  ownerKey,
  containerTag: `daniel-user-${ownerKey}`,
  conversationId: "sms:+15555550123",
  saltFingerprint,
  pairingAuthorityProof,
};

describe("primary memory owner state", () => {
  it("registers once, is idempotent, and never replaces another sender", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(internal.memoryProviderState.initializeIdentityConfiguration, {
        saltFingerprint,
        pairingAuthorityProof,
        now: 10,
      }),
    ).resolves.toEqual({ status: "ready" });
    await expect(
      t.mutation(api.memoryProviderState.registerPrimaryOwner, { ...owner, now: 20 }),
    ).resolves.toEqual({ status: "registered" });
    await expect(
      t.mutation(api.memoryProviderState.registerPrimaryOwner, { ...owner, now: 30 }),
    ).resolves.toEqual({ status: "existing" });

    const otherOwnerKey = "d".repeat(32);
    await expect(
      t.mutation(api.memoryProviderState.registerPrimaryOwner, {
        ...owner,
        ownerKey: otherOwnerKey,
        containerTag: `daniel-user-${otherOwnerKey}`,
        conversationId: "sms:+15555550456",
        now: 40,
      }),
    ).resolves.toEqual({ status: "conflict" });
    await expect(
      t.query(api.memoryProviderState.getPrimaryOwnerForServer, {
        pairingAuthorityProof,
      }),
    ).resolves.toMatchObject({
      ownerKey,
      containerTag: owner.containerTag,
      conversationId: owner.conversationId,
      registeredAt: 20,
    });
  });

  it("protects the owner scope and browser status from identity material", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.memoryProviderState.initializeIdentityConfiguration, {
      saltFingerprint,
      pairingAuthorityProof,
    });
    await t.mutation(api.memoryProviderState.registerPrimaryOwner, owner);

    await expect(
      t.query(api.memoryProviderState.getPrimaryOwnerForServer, {
        pairingAuthorityProof: "e".repeat(64),
      }),
    ).resolves.toBeNull();
    const publicState = await t.query(api.memoryProviderState.getDeploymentState, {});
    expect(publicState).toMatchObject({ primaryOwnerRegistered: true });
    expect(publicState).not.toHaveProperty("primaryOwnerKey");
    expect(publicState).not.toHaveProperty("primaryContainerTag");
    expect(publicState).not.toHaveProperty("primaryConversationId");
    expect(publicState).not.toHaveProperty("saltFingerprint");
    expect(publicState).not.toHaveProperty("pairingAuthorityProof");
  });

  it("requires recovery when persisted identity and runtime material drift", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.memoryProviderState.initializeIdentityConfiguration, {
      saltFingerprint,
      pairingAuthorityProof,
    });
    await expect(
      t.mutation(api.memoryProviderState.verifyIdentityConfiguration, {
        saltFingerprint: "f".repeat(32),
        pairingAuthorityProof,
      }),
    ).resolves.toEqual({ status: "recovery_required" });
    await expect(
      t.mutation(api.memoryProviderState.registerPrimaryOwner, owner),
    ).resolves.toEqual({ status: "recovery_required" });
    await expect(
      t.mutation(api.memoryProviderState.verifyIdentityConfiguration, {
        saltFingerprint,
        pairingAuthorityProof,
      }),
    ).resolves.toEqual({ status: "ready" });
    await expect(
      t.mutation(api.memoryProviderState.registerPrimaryOwner, owner),
    ).resolves.toEqual({ status: "registered" });
  });

  it("rejects an owner/container mismatch and non-SMS destination", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.memoryProviderState.initializeIdentityConfiguration, {
      saltFingerprint,
      pairingAuthorityProof,
    });
    await expect(
      t.mutation(api.memoryProviderState.registerPrimaryOwner, {
        ...owner,
        containerTag: "daniel-user-wrong",
      }),
    ).rejects.toThrow(/registration is invalid/);
    await expect(
      t.mutation(api.memoryProviderState.registerPrimaryOwner, {
        ...owner,
        conversationId: "local:random",
      }),
    ).rejects.toThrow(/registration is invalid/);
  });

  it("keeps initialization off the public API and ignores foreign proofs", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.memoryProviderState.verifyIdentityConfiguration, {
        saltFingerprint,
        pairingAuthorityProof,
      }),
    ).resolves.toEqual({ status: "unconfigured" });
    await expect(
      t.query(api.memoryProviderState.getDeploymentState, {}),
    ).resolves.toBeNull();

    await t.mutation(internal.memoryProviderState.initializeIdentityConfiguration, {
      saltFingerprint,
      pairingAuthorityProof,
    });
    await expect(
      t.mutation(api.memoryProviderState.verifyIdentityConfiguration, {
        saltFingerprint: "f".repeat(32),
        pairingAuthorityProof: "e".repeat(64),
      }),
    ).resolves.toEqual({ status: "recovery_required" });
    await expect(
      t.query(api.memoryProviderState.getDeploymentState, {}),
    ).resolves.not.toMatchObject({ healthStatus: "recovery_required" });
  });

  it("protects container identity state with the server-only proof", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.memoryProviderState.initializeIdentityConfiguration, {
      saltFingerprint,
      pairingAuthorityProof,
    });
    await expect(
      t.mutation(api.memoryProviderState.markContainerInitialized, {
        containerTag: owner.containerTag,
        initializedAt: 50,
        saltFingerprint,
        pairingAuthorityProof: "e".repeat(64),
      }),
    ).rejects.toThrow(/server authority is invalid/);
    await t.mutation(api.memoryProviderState.markContainerInitialized, {
      containerTag: owner.containerTag,
      initializedAt: 50,
      saltFingerprint,
      pairingAuthorityProof,
    });
    await expect(
      t.query(api.memoryProviderState.getContainerState, {
        containerTag: owner.containerTag,
        pairingAuthorityProof: "e".repeat(64),
      }),
    ).resolves.toBeNull();
    await expect(
      t.query(api.memoryProviderState.getContainerState, {
        containerTag: owner.containerTag,
        pairingAuthorityProof,
      }),
    ).resolves.toMatchObject({
      containerTag: owner.containerTag,
      saltFingerprint,
      initializedAt: 50,
    });
  });
});
