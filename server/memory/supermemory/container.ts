import type { SupermemoryContainerSettingsClient } from "./client.js";
import {
  assertMemoryIdSaltStable,
  MemoryIdentityConfigurationError,
  validateProviderIdentifier,
} from "./identity.js";

export const DANIEL_ENTITY_CONTEXT = `This container belongs to one user speaking with the Daniel personal agent.

Build a coherent profile from the user's own statements and confirmed
interactions. Prioritize durable identity, preferences, relationships,
corrections, recurring workflows, ongoing projects, and meaningful episodes.

Treat one-off task instructions as episodic rather than permanent preferences.
Do not treat Daniel's guesses, web research, worker output, tool output, or
synthetic proactive notices as user facts unless the user explicitly confirms
them.`;

if (DANIEL_ENTITY_CONTEXT.length > 1_500) {
  throw new Error("Daniel's Supermemory entityContext exceeds 1500 characters");
}

export interface MemoryProviderContainerState {
  containerTag: string;
  initializedAt?: number;
  saltFingerprint?: string;
}

/** Narrow persistence boundary implemented by Convex in Implementation 2. */
export interface MemoryProviderStateStore {
  /**
   * Atomically create the deployment-wide fingerprint if absent, never
   * overwrite it, and return the fingerprint that is persisted.
   */
  ensureIdentitySaltFingerprint(saltFingerprint: string): Promise<string>;
  getContainerState(containerTag: string): Promise<MemoryProviderContainerState | null>;
  markContainerInitialized(input: {
    containerTag: string;
    initializedAt: number;
    saltFingerprint: string;
  }): Promise<void>;
}

export interface ContainerSettingsDependencies {
  stateStore: MemoryProviderStateStore;
  provider: SupermemoryContainerSettingsClient;
  now?: () => number;
  memoryIdSalt?: string;
}

export interface EnsureContainerSettingsResult {
  initialized: boolean;
  initializedAt: number;
}

export class ContainerSettingsCoordinator {
  private readonly inFlight = new Map<string, Promise<EnsureContainerSettingsResult>>();

  constructor(private readonly dependencies: ContainerSettingsDependencies) {}

  async ensureContainerSettings(containerTag: string): Promise<EnsureContainerSettingsResult> {
    validateProviderIdentifier(containerTag, "containerTag");
    const existing = this.inFlight.get(containerTag);
    if (existing) return existing;

    const operation = this.ensureOnce(containerTag).finally(() => {
      this.inFlight.delete(containerTag);
    });
    this.inFlight.set(containerTag, operation);
    return operation;
  }

  private async ensureOnce(containerTag: string): Promise<EnsureContainerSettingsResult> {
    const { stateStore, provider, memoryIdSalt } = this.dependencies;
    const currentSaltFingerprint = assertMemoryIdSaltStable(undefined, memoryIdSalt);
    const persistedSaltFingerprint = await stateStore.ensureIdentitySaltFingerprint(
      currentSaltFingerprint,
    );
    const saltFingerprint = assertMemoryIdSaltStable(
      persistedSaltFingerprint,
      memoryIdSalt,
    );
    const state = await stateStore.getContainerState(containerTag);
    assertMemoryIdSaltStable(state?.saltFingerprint, memoryIdSalt);
    if (state?.initializedAt) {
      return { initialized: false, initializedAt: state.initializedAt };
    }

    await provider.updateContainerSettings(containerTag, DANIEL_ENTITY_CONTEXT);
    const initializedAt = (this.dependencies.now ?? Date.now)();
    await stateStore.markContainerInitialized({
      containerTag,
      initializedAt,
      saltFingerprint,
    });
    return { initialized: true, initializedAt };
  }
}

export function createContainerSettingsCoordinator(
  dependencies: ContainerSettingsDependencies,
): ContainerSettingsCoordinator {
  return new ContainerSettingsCoordinator(dependencies);
}

let defaultCoordinator: ContainerSettingsCoordinator | undefined;

/**
 * Installs the narrow persistence/provider dependencies once the Convex state
 * table exists. Foundation code does not configure or call this by default.
 */
export function configureContainerSettings(dependencies: ContainerSettingsDependencies): void {
  defaultCoordinator = createContainerSettingsCoordinator(dependencies);
}

export async function ensureContainerSettings(
  containerTag: string,
): Promise<EnsureContainerSettingsResult> {
  if (!defaultCoordinator) {
    throw new MemoryIdentityConfigurationError(
      "container settings persistence is not configured; complete the memoryProviderState integration before enabling Supermemory writes",
    );
  }
  return defaultCoordinator.ensureContainerSettings(containerTag);
}
