import type { AppEnv } from '../config/env.js';
import type {
  ApiKeyRecord,
  DeveloperAccountRecord,
  SqlitePersistence,
} from '../persistence/database.js';
import {
  ClashDeveloperPortalService,
  type DeveloperPortalAccountCredentials,
  DeveloperPortalError,
  type DeveloperPortalKey,
} from '../portal/client.js';

type KeyManagerLogger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
};

type ManagedKeyCandidate = {
  account: DeveloperAccountRecord;
  key: ApiKeyRecord;
};

export type ManagedApiKeyLease = {
  apiKeyId: number;
  portalKeyId: number | null;
  accountId: number;
  accountSlot: number;
  accountEmail: string;
  keyName: string | null;
  keyValue: string;
  cidrRanges: string[];
  selectedAt: string;
};

export type KeyFailureReason =
  | 'UPSTREAM_AUTH_FAILURE'
  | 'UPSTREAM_FORBIDDEN'
  | 'UPSTREAM_KEY_REVOKED'
  | 'VALIDATION_FAILED'
  | 'MANUAL_REGENERATION'
  | 'UNKNOWN_FAILURE';

export type ValidationSweepSummary = {
  reason: string;
  startedAt: string;
  completedAt: string;
  accountsChecked: number;
  accountsRecovered: number;
  accountsFailed: number;
  keysValidated: number;
  keysCreated: number;
  keysInvalidated: number;
};

export type KeyManagerStatusSnapshot = {
  accounts: Array<
    DeveloperAccountRecord & {
      managedKeys: ApiKeyRecord[];
      healthyManagedKeyCount: number;
      eligibleManagedKeyCount: number;
    }
  >;
  eligibleKeyCount: number;
  lastRotationCursor: number | null;
  lastValidationCompletedAt: string | null;
};

const DEFAULT_LOGGER: KeyManagerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const ROTATION_CURSOR_STATE_KEY = 'key_manager.rotation.last_api_key_id';
const LAST_VALIDATION_COMPLETED_AT_STATE_KEY =
  'key_manager.validation.last_completed_at';
const LAST_VALIDATION_STARTED_AT_STATE_KEY =
  'key_manager.validation.last_started_at';

class SerialTaskQueue {
  private queue: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T> | T): Promise<T> {
    const nextTask = this.queue.then(task, task);
    this.queue = nextTask.then(
      () => undefined,
      () => undefined,
    );
    return nextTask;
  }
}

function timestamp(): string {
  return new Date().toISOString();
}

function addMilliseconds(value: string, ms: number): string {
  return new Date(Date.parse(value) + ms).toISOString();
}

function isInCooldown(until: string | null): boolean {
  return until !== null && Date.parse(until) > Date.now();
}

function parseStateNumber(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function maskKeyValue(value: string): string {
  if (value.length <= 10) {
    return value;
  }

  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function toErrorMetadata(error: unknown): Record<string, unknown> {
  if (error instanceof DeveloperPortalError) {
    return {
      name: error.name,
      code: error.code,
      operation: error.operation,
      status: error.status,
      retryable: error.retryable,
      message: error.message,
    };
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    message: 'Unknown error',
  };
}

function compareCandidates(
  left: ManagedKeyCandidate,
  right: ManagedKeyCandidate,
): number {
  if (left.account.slot !== right.account.slot) {
    return left.account.slot - right.account.slot;
  }

  return left.key.id - right.key.id;
}

function bindLoggerMethod(
  logger: Partial<KeyManagerLogger> | undefined,
  method: keyof KeyManagerLogger,
): KeyManagerLogger[keyof KeyManagerLogger] {
  const candidate = logger?.[method];

  if (typeof candidate !== 'function') {
    return DEFAULT_LOGGER[method];
  }

  return candidate.bind(logger);
}

export class ClashApiKeyManager {
  private readonly queue = new SerialTaskQueue();
  private readonly logger: KeyManagerLogger;
  private readonly credentialsBySlot = new Map<
    number,
    DeveloperPortalAccountCredentials
  >();
  private readonly validationSweepIntervalMs: number;
  private readonly keyUnhealthyCooldownMs: number;
  private readonly accountUnhealthyCooldownMs: number;
  private readonly portalService: ClashDeveloperPortalService;
  private intervalHandle: NodeJS.Timeout | null = null;

  constructor(
    private readonly input: {
      env: Pick<
        AppEnv,
        | 'validationSweepIntervalMinutes'
        | 'keyUnhealthyCooldownSeconds'
        | 'accountUnhealthyCooldownSeconds'
        | 'managedKeyAllowedCidrs'
        | 'managedKeyNamePrefix'
        | 'managedKeyDescription'
        | 'managedKeyScopes'
        | 'cocDeveloperAccounts'
      >;
      persistence: SqlitePersistence;
      portalService?: ClashDeveloperPortalService;
      logger?: Partial<KeyManagerLogger>;
    },
  ) {
    this.logger = {
      info: bindLoggerMethod(input.logger, 'info') as KeyManagerLogger['info'],
      warn: bindLoggerMethod(input.logger, 'warn') as KeyManagerLogger['warn'],
      error: bindLoggerMethod(
        input.logger,
        'error',
      ) as KeyManagerLogger['error'],
      debug: bindLoggerMethod(
        input.logger,
        'debug',
      ) as KeyManagerLogger['debug'],
    };
    this.portalService =
      input.portalService ?? new ClashDeveloperPortalService();
    this.validationSweepIntervalMs =
      input.env.validationSweepIntervalMinutes * 60 * 1000;
    this.keyUnhealthyCooldownMs = input.env.keyUnhealthyCooldownSeconds * 1000;
    this.accountUnhealthyCooldownMs =
      input.env.accountUnhealthyCooldownSeconds * 1000;

    for (const account of input.env.cocDeveloperAccounts) {
      this.credentialsBySlot.set(account.slot, {
        slot: account.slot,
        email: account.email,
        password: account.password,
      });
    }
  }

  async start(): Promise<void> {
    if (this.intervalHandle) {
      return;
    }

    try {
      await this.runValidationSweep('startup');
    } catch (error) {
      this.logger.error(
        {
          err: error,
          metadata: toErrorMetadata(error),
        },
        'initial key manager validation sweep failed',
      );
    }

    this.intervalHandle = setInterval(() => {
      void this.runValidationSweep('interval').catch((error: unknown) => {
        this.logger.error(
          {
            err: error,
            metadata: toErrorMetadata(error),
          },
          'scheduled key manager validation sweep failed',
        );
      });
    }, this.validationSweepIntervalMs);

    this.intervalHandle.unref?.();
  }

  async stop(): Promise<void> {
    if (!this.intervalHandle) {
      return;
    }

    clearInterval(this.intervalHandle);
    this.intervalHandle = null;
  }

  async acquireKey(): Promise<ManagedApiKeyLease> {
    return this.queue.run(async () => {
      let status = this.getStatusSnapshotUnlocked();
      let candidate = this.selectCandidateUnlocked(status);

      if (!candidate) {
        await this.runValidationSweepUnlocked('acquire-repair');
        status = this.getStatusSnapshotUnlocked();
        candidate = this.selectCandidateUnlocked(status);
      }

      if (!candidate) {
        throw new Error(
          'No healthy managed Clash of Clans API keys are available.',
        );
      }

      const selectedAt = timestamp();
      const updatedKey = this.input.persistence.updateApiKeyStatus({
        keyValue: candidate.key.keyValue,
        lastUsedAt: selectedAt,
      });

      this.input.persistence.setAppState(
        ROTATION_CURSOR_STATE_KEY,
        String(updatedKey.id),
      );

      this.logger.debug(
        {
          accountSlot: candidate.account.slot,
          apiKeyId: updatedKey.id,
          portalKeyId: updatedKey.portalKeyId,
          keyValue: maskKeyValue(updatedKey.keyValue),
        },
        'managed API key selected',
      );

      return {
        apiKeyId: updatedKey.id,
        portalKeyId: updatedKey.portalKeyId,
        accountId: candidate.account.id,
        accountSlot: candidate.account.slot,
        accountEmail: candidate.account.email,
        keyName: updatedKey.keyName,
        keyValue: updatedKey.keyValue,
        cidrRanges: updatedKey.cidrRanges,
        selectedAt,
      };
    });
  }

  async markKeyHealthy(keyValue: string): Promise<ApiKeyRecord | null> {
    return this.queue.run(() => {
      const existingKey = this.input.persistence.getApiKeyByValue(keyValue);

      if (!existingKey) {
        return null;
      }

      return this.input.persistence.updateApiKeyStatus({
        keyValue,
        isActive: true,
        isHealthy: true,
        invalidReason: null,
        unhealthyUntil: null,
        lastValidatedAt: timestamp(),
      });
    });
  }

  async regenerateKey(input: {
    keyValue: string;
    reason: KeyFailureReason;
    revokeExistingPortalKey?: boolean;
    metadata?: Record<string, unknown>;
  }): Promise<ApiKeyRecord | null> {
    return this.queue.run(() => this.regenerateKeyUnlocked(input));
  }

  async runValidationSweep(reason = 'manual'): Promise<ValidationSweepSummary> {
    return this.queue.run(() => this.runValidationSweepUnlocked(reason));
  }

  async forceRefreshAllKeys(): Promise<ValidationSweepSummary> {
    return this.runValidationSweep('force-refresh');
  }

  async getStatusSnapshot(): Promise<KeyManagerStatusSnapshot> {
    return this.queue.run(() => this.getStatusSnapshotUnlocked());
  }

  private getCredentialsForSlot(
    slot: number,
  ): DeveloperPortalAccountCredentials {
    const credentials = this.credentialsBySlot.get(slot);

    if (!credentials) {
      throw new Error(
        `Missing developer portal credentials for account slot ${slot}.`,
      );
    }

    return credentials;
  }

  private getStatusSnapshotUnlocked(): KeyManagerStatusSnapshot {
    const accounts = this.input.persistence.listDeveloperAccounts();
    const apiKeys = this.input.persistence
      .listApiKeys()
      .filter((apiKey) => apiKey.isManaged);
    const rotationCursorState = this.input.persistence.getAppState(
      ROTATION_CURSOR_STATE_KEY,
    );
    const lastValidationCompletedAtState = this.input.persistence.getAppState(
      LAST_VALIDATION_COMPLETED_AT_STATE_KEY,
    );

    const accountsWithKeys = accounts.map((account) => {
      const managedKeys = apiKeys.filter(
        (apiKey) => apiKey.developerAccountId === account.id,
      );
      const eligibleManagedKeys = managedKeys.filter((apiKey) =>
        this.isEligibleKeyCandidate(account, apiKey),
      );

      return {
        ...account,
        managedKeys,
        healthyManagedKeyCount: managedKeys.filter(
          (apiKey) => apiKey.isActive && apiKey.isHealthy,
        ).length,
        eligibleManagedKeyCount: eligibleManagedKeys.length,
      };
    });

    return {
      accounts: accountsWithKeys,
      eligibleKeyCount: accountsWithKeys.reduce(
        (total, account) => total + account.eligibleManagedKeyCount,
        0,
      ),
      lastRotationCursor: parseStateNumber(rotationCursorState?.value ?? null),
      lastValidationCompletedAt: lastValidationCompletedAtState?.value ?? null,
    };
  }

  private selectCandidateUnlocked(
    status: KeyManagerStatusSnapshot,
  ): ManagedKeyCandidate | null {
    const eligibleKeys = status.accounts
      .flatMap((account) =>
        account.managedKeys
          .filter((apiKey) => this.isEligibleKeyCandidate(account, apiKey))
          .map((apiKey) => ({
            account,
            key: apiKey,
          })),
      )
      .sort(compareCandidates);

    if (eligibleKeys.length === 0) {
      return null;
    }

    if (status.lastRotationCursor === null) {
      return eligibleKeys[0] ?? null;
    }

    const rotationCursor = status.lastRotationCursor;

    return (
      eligibleKeys.find((candidate) => candidate.key.id > rotationCursor) ??
      eligibleKeys[0] ??
      null
    );
  }

  private isEligibleKeyCandidate(
    account: Pick<
      DeveloperAccountRecord,
      'isEnabled' | 'isHealthy' | 'unhealthyUntil'
    >,
    apiKey: Pick<ApiKeyRecord, 'isActive' | 'isHealthy' | 'unhealthyUntil'>,
  ): boolean {
    return (
      account.isEnabled &&
      account.isHealthy &&
      !isInCooldown(account.unhealthyUntil) &&
      apiKey.isActive &&
      apiKey.isHealthy &&
      !isInCooldown(apiKey.unhealthyUntil)
    );
  }

  private async runValidationSweepUnlocked(
    reason: string,
  ): Promise<ValidationSweepSummary> {
    const startedAt = timestamp();
    const summary: ValidationSweepSummary = {
      reason,
      startedAt,
      completedAt: startedAt,
      accountsChecked: 0,
      accountsRecovered: 0,
      accountsFailed: 0,
      keysValidated: 0,
      keysCreated: 0,
      keysInvalidated: 0,
    };

    this.input.persistence.setAppState(
      LAST_VALIDATION_STARTED_AT_STATE_KEY,
      startedAt,
    );

    const enabledAccounts = this.input.persistence
      .listDeveloperAccounts()
      .filter((account) => account.isEnabled);

    for (const account of enabledAccounts) {
      await this.synchronizeAccountUnlocked(account, reason, summary);
    }

    summary.completedAt = timestamp();
    this.input.persistence.setAppState(
      LAST_VALIDATION_COMPLETED_AT_STATE_KEY,
      summary.completedAt,
    );
    this.input.persistence.recordLifecycleEvent({
      eventType: 'key_manager.validation.completed',
      message: `Key validation sweep completed (${reason}).`,
      metadata: summary,
    });

    this.logger.info(summary, 'key validation sweep completed');
    return summary;
  }

  private async synchronizeAccountUnlocked(
    account: DeveloperAccountRecord,
    reason: string,
    summary: ValidationSweepSummary,
  ): Promise<void> {
    summary.accountsChecked += 1;

    try {
      const credentials = this.getCredentialsForSlot(account.slot);
      const portalKeys =
        await this.portalService.listKeysForAccount(credentials);
      const validatedAt = timestamp();
      const persistedManagedKeys = this.input.persistence
        .listApiKeys()
        .filter(
          (apiKey) =>
            apiKey.developerAccountId === account.id && apiKey.isManaged,
        );
      const knownManagedKeyValues = new Set(
        persistedManagedKeys.map((apiKey) => apiKey.keyValue),
      );

      let managedPortalKeys = portalKeys.filter((portalKey) =>
        this.isManagedPortalKey(portalKey, knownManagedKeyValues),
      );

      if (managedPortalKeys.length === 0) {
        const createdKey = await this.createManagedKeyUnlocked({
          account,
          reason: `${reason}:missing-managed-key`,
        });

        managedPortalKeys = [
          {
            id: createdKey.portalKeyId ?? createdKey.id,
            name: createdKey.keyName ?? this.buildManagedKeyName(account.slot),
            description: this.input.env.managedKeyDescription,
            key: createdKey.keyValue,
            cidrRanges: createdKey.cidrRanges,
            scopes: this.input.env.managedKeyScopes ?? [],
          },
        ];
        summary.keysCreated += 1;
      }

      const seenManagedKeyValues = new Set<string>();

      for (const portalKey of managedPortalKeys) {
        this.input.persistence.saveApiKey({
          accountSlot: account.slot,
          portalKeyId: portalKey.id,
          keyName: portalKey.name,
          keyValue: portalKey.key,
          cidrRanges: portalKey.cidrRanges,
          isManaged: true,
          isActive: true,
          isHealthy: true,
          invalidReason: null,
          lastValidatedAt: validatedAt,
          lastSeenAt: validatedAt,
          unhealthyUntil: null,
        });
        seenManagedKeyValues.add(portalKey.key);
        summary.keysValidated += 1;
      }

      for (const persistedKey of persistedManagedKeys) {
        if (seenManagedKeyValues.has(persistedKey.keyValue)) {
          continue;
        }

        this.input.persistence.updateApiKeyStatus({
          keyValue: persistedKey.keyValue,
          isActive: false,
          isHealthy: false,
          invalidReason: 'KEY_NOT_FOUND_IN_PORTAL',
          lastValidatedAt: validatedAt,
          lastSeenAt: null,
          unhealthyUntil: null,
        });
        summary.keysInvalidated += 1;
        this.input.persistence.recordLifecycleEvent({
          eventType: 'key.portal.missing',
          accountSlot: account.slot,
          apiKeyId: persistedKey.id,
          message:
            'Managed API key is no longer present in the developer portal.',
          metadata: {
            reason,
            keyValue: maskKeyValue(persistedKey.keyValue),
            portalKeyId: persistedKey.portalKeyId,
          },
        });
      }

      this.input.persistence.updateDeveloperAccountStatus({
        slot: account.slot,
        isHealthy: true,
        lastLoginAt: validatedAt,
        unhealthyUntil: null,
        lastError: null,
      });

      if (!account.isHealthy || account.unhealthyUntil !== null) {
        summary.accountsRecovered += 1;
      }
    } catch (error) {
      summary.accountsFailed += 1;
      await this.handleAccountFailureUnlocked(account, error, {
        reason,
        eventType: 'account.validation.failed',
        message: 'Developer account validation failed.',
      });
    }
  }

  private isManagedPortalKey(
    portalKey: DeveloperPortalKey,
    knownManagedKeyValues: Set<string>,
  ): boolean {
    return (
      portalKey.name.startsWith(this.input.env.managedKeyNamePrefix) ||
      portalKey.description === this.input.env.managedKeyDescription ||
      knownManagedKeyValues.has(portalKey.key)
    );
  }

  private buildManagedKeyName(slot: number): string {
    return `${this.input.env.managedKeyNamePrefix}-slot-${slot}-${Date.now()}`;
  }

  private async createManagedKeyUnlocked(input: {
    account: DeveloperAccountRecord;
    reason: string;
  }): Promise<ApiKeyRecord> {
    const createdAt = timestamp();
    const credentials = this.getCredentialsForSlot(input.account.slot);
    const createdPortalKey = await this.portalService.createKeyForAccount(
      credentials,
      {
        cidrRanges: this.input.env.managedKeyAllowedCidrs,
        name: this.buildManagedKeyName(input.account.slot),
        description: this.input.env.managedKeyDescription,
        scopes: this.input.env.managedKeyScopes,
      },
    );

    const savedKey = this.input.persistence.saveApiKey({
      accountSlot: input.account.slot,
      portalKeyId: createdPortalKey.id,
      keyName: createdPortalKey.name,
      keyValue: createdPortalKey.key,
      cidrRanges: createdPortalKey.cidrRanges,
      isManaged: true,
      isActive: true,
      isHealthy: true,
      invalidReason: null,
      lastValidatedAt: createdAt,
      lastSeenAt: createdAt,
      unhealthyUntil: null,
    });

    this.input.persistence.recordLifecycleEvent({
      eventType: 'key.created',
      accountSlot: input.account.slot,
      apiKeyId: savedKey.id,
      message: 'Managed API key created.',
      metadata: {
        reason: input.reason,
        portalKeyId: savedKey.portalKeyId,
        keyValue: maskKeyValue(savedKey.keyValue),
      },
    });

    this.logger.info(
      {
        accountSlot: input.account.slot,
        apiKeyId: savedKey.id,
        portalKeyId: savedKey.portalKeyId,
        keyValue: maskKeyValue(savedKey.keyValue),
        reason: input.reason,
      },
      'managed API key created',
    );

    return savedKey;
  }

  private async regenerateKeyUnlocked(input: {
    keyValue: string;
    reason: KeyFailureReason;
    revokeExistingPortalKey?: boolean;
    metadata?: Record<string, unknown>;
  }): Promise<ApiKeyRecord | null> {
    const existingKey = this.input.persistence.getApiKeyByValue(input.keyValue);

    if (!existingKey) {
      this.logger.warn(
        {
          keyValue: maskKeyValue(input.keyValue),
          reason: input.reason,
        },
        'cannot regenerate unknown managed API key',
      );
      return null;
    }

    const account = this.input.persistence
      .listDeveloperAccounts()
      .find(
        (developerAccount) =>
          developerAccount.id === existingKey.developerAccountId,
      );

    if (!account) {
      throw new Error(
        `Developer account ${existingKey.developerAccountId} does not exist for API key ${existingKey.keyValue}.`,
      );
    }

    const markedAt = timestamp();
    this.input.persistence.updateApiKeyStatus({
      keyValue: existingKey.keyValue,
      isActive: false,
      isHealthy: false,
      invalidReason: input.reason,
      lastValidatedAt: markedAt,
      unhealthyUntil: addMilliseconds(markedAt, this.keyUnhealthyCooldownMs),
    });
    this.input.persistence.recordLifecycleEvent({
      eventType: 'key.regeneration.requested',
      accountSlot: account.slot,
      apiKeyId: existingKey.id,
      message: 'Managed API key regeneration requested.',
      metadata: {
        reason: input.reason,
        keyValue: maskKeyValue(existingKey.keyValue),
        portalKeyId: existingKey.portalKeyId,
        ...input.metadata,
      },
    });

    try {
      const credentials = this.getCredentialsForSlot(account.slot);

      if (
        input.revokeExistingPortalKey !== false &&
        typeof existingKey.portalKeyId === 'number'
      ) {
        try {
          await this.portalService.revokeKeyForAccount(
            credentials,
            existingKey.portalKeyId,
          );
        } catch (error) {
          if (
            !(error instanceof DeveloperPortalError) ||
            error.code !== 'KEY_NOT_FOUND'
          ) {
            throw error;
          }

          this.logger.debug(
            {
              accountSlot: account.slot,
              portalKeyId: existingKey.portalKeyId,
              keyValue: maskKeyValue(existingKey.keyValue),
            },
            'managed API key already missing from portal during regeneration',
          );
        }
      }

      const replacementKey = await this.createManagedKeyUnlocked({
        account,
        reason: `regenerate:${input.reason}`,
      });

      this.input.persistence.recordLifecycleEvent({
        eventType: 'key.regenerated',
        accountSlot: account.slot,
        apiKeyId: replacementKey.id,
        message: 'Managed API key regenerated.',
        metadata: {
          reason: input.reason,
          replacedApiKeyId: existingKey.id,
          replacedPortalKeyId: existingKey.portalKeyId,
          replacedKeyValue: maskKeyValue(existingKey.keyValue),
          replacementApiKeyId: replacementKey.id,
          replacementPortalKeyId: replacementKey.portalKeyId,
          replacementKeyValue: maskKeyValue(replacementKey.keyValue),
          ...input.metadata,
        },
      });

      this.input.persistence.updateDeveloperAccountStatus({
        slot: account.slot,
        isHealthy: true,
        unhealthyUntil: null,
        lastError: null,
      });

      return replacementKey;
    } catch (error) {
      await this.handleAccountFailureUnlocked(account, error, {
        reason: `regenerate:${input.reason}`,
        eventType: 'account.regeneration.failed',
        message:
          'Developer account failed while regenerating a managed API key.',
      });
      return null;
    }
  }

  private async handleAccountFailureUnlocked(
    account: DeveloperAccountRecord,
    error: unknown,
    context: {
      reason: string;
      eventType: string;
      message: string;
    },
  ): Promise<void> {
    const failedAt = timestamp();
    const errorMetadata = toErrorMetadata(error);
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown developer portal error';

    this.input.persistence.updateDeveloperAccountStatus({
      slot: account.slot,
      isHealthy: false,
      unhealthyUntil: addMilliseconds(
        failedAt,
        this.accountUnhealthyCooldownMs,
      ),
      lastError: errorMessage,
    });
    this.input.persistence.recordLifecycleEvent({
      eventType: context.eventType,
      accountSlot: account.slot,
      message: context.message,
      metadata: {
        reason: context.reason,
        ...errorMetadata,
      },
    });

    this.logger.warn(
      {
        accountSlot: account.slot,
        email: account.email,
        reason: context.reason,
        metadata: errorMetadata,
      },
      context.message,
    );
  }
}

export function createKeyManager(input: {
  env: AppEnv;
  persistence: SqlitePersistence;
  portalService?: ClashDeveloperPortalService;
  logger?: Partial<KeyManagerLogger>;
}): ClashApiKeyManager {
  return new ClashApiKeyManager({
    env: {
      validationSweepIntervalMinutes: input.env.validationSweepIntervalMinutes,
      keyUnhealthyCooldownSeconds: input.env.keyUnhealthyCooldownSeconds,
      accountUnhealthyCooldownSeconds:
        input.env.accountUnhealthyCooldownSeconds,
      managedKeyAllowedCidrs: input.env.managedKeyAllowedCidrs,
      managedKeyNamePrefix: input.env.managedKeyNamePrefix,
      managedKeyDescription: input.env.managedKeyDescription,
      managedKeyScopes: input.env.managedKeyScopes,
      cocDeveloperAccounts: input.env.cocDeveloperAccounts,
    },
    persistence: input.persistence,
    portalService: input.portalService,
    logger: input.logger,
  });
}
