import type { AppEnv } from '../config/env.js';
import type { ApiKeyRecord, DeveloperAccountRecord, SqlitePersistence } from '../persistence/database.js';
import { ClashDeveloperPortalService } from '../portal/client.js';
type KeyManagerLogger = {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
};
export type ManagedApiKeyLease = {
    apiKeyId: number;
    portalKeyId: string | number | null;
    accountId: number;
    accountSlot: number;
    accountEmail: string;
    keyName: string | null;
    keyValue: string;
    cidrRanges: string[];
    selectedAt: string;
};
export type KeyFailureReason = 'UPSTREAM_AUTH_FAILURE' | 'UPSTREAM_FORBIDDEN' | 'UPSTREAM_INVALID_IP' | 'UPSTREAM_KEY_REVOKED' | 'UPSTREAM_NETWORK_ERROR' | 'UPSTREAM_RATE_LIMITED' | 'UPSTREAM_SERVER_ERROR' | 'UPSTREAM_TIMEOUT' | 'VALIDATION_FAILED' | 'MANUAL_REGENERATION' | 'UNKNOWN_FAILURE';
export type UpstreamFailureCategory = 'AUTHENTICATION' | 'INVALID_IP' | 'INVALID_KEY' | 'NETWORK_ERROR' | 'RATE_LIMITED' | 'SERVER_ERROR' | 'TIMEOUT' | 'UNKNOWN';
export type ReportUpstreamFailureInput = {
    keyValue: string;
    category: UpstreamFailureCategory;
    statusCode?: number | null;
    message?: string | null;
    metadata?: Record<string, unknown>;
};
export type ReportUpstreamFailureResult = {
    handled: boolean;
    markedAccountUnhealthy: boolean;
    markedKeyUnhealthy: boolean;
    scheduledRegeneration: boolean;
    scheduledValidationSweep: boolean;
};
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
    accounts: Array<DeveloperAccountRecord & {
        managedKeys: ApiKeyRecord[];
        healthyManagedKeyCount: number;
        eligibleManagedKeyCount: number;
    }>;
    eligibleKeyCount: number;
    lastRotationCursor: number | null;
    lastValidationCompletedAt: string | null;
};
export declare class ClashApiKeyManager {
    private readonly input;
    private readonly queue;
    private readonly logger;
    private readonly credentialsBySlot;
    private readonly validationSweepIntervalMs;
    private readonly keyUnhealthyCooldownMs;
    private readonly accountUnhealthyCooldownMs;
    private readonly portalService;
    private intervalHandle;
    constructor(input: {
        env: Pick<AppEnv, 'validationSweepIntervalMinutes' | 'keyUnhealthyCooldownSeconds' | 'accountUnhealthyCooldownSeconds' | 'managedKeyAllowedCidrs' | 'managedKeyNamePrefix' | 'managedKeyDescription' | 'managedKeyScopes' | 'cocDeveloperAccounts'>;
        persistence: SqlitePersistence;
        portalService?: ClashDeveloperPortalService;
        logger?: Partial<KeyManagerLogger>;
    });
    start(): Promise<void>;
    stop(): Promise<void>;
    acquireKey(): Promise<ManagedApiKeyLease>;
    markKeyHealthy(keyValue: string): Promise<ApiKeyRecord | null>;
    reportUpstreamFailure(input: ReportUpstreamFailureInput): Promise<ReportUpstreamFailureResult>;
    regenerateKey(input: {
        keyValue: string;
        reason: KeyFailureReason;
        revokeExistingPortalKey?: boolean;
        metadata?: Record<string, unknown>;
    }): Promise<ApiKeyRecord | null>;
    runValidationSweep(reason?: string): Promise<ValidationSweepSummary>;
    forceRefreshAllKeys(): Promise<ValidationSweepSummary>;
    setAccountEnabled(slot: number, isEnabled: boolean): Promise<DeveloperAccountRecord>;
    getStatusSnapshot(): Promise<KeyManagerStatusSnapshot>;
    private runDetachedQueuedTask;
    private getCredentialsForSlot;
    private getStatusSnapshotUnlocked;
    private selectCandidateUnlocked;
    private isEligibleKeyCandidate;
    private runValidationSweepUnlocked;
    private synchronizeAccountUnlocked;
    private isManagedPortalKey;
    private buildManagedKeyName;
    private createManagedKeyUnlocked;
    private reportUpstreamFailureUnlocked;
    private regenerateKeyUnlocked;
    private handleAccountFailureUnlocked;
}
export declare function createKeyManager(input: {
    env: AppEnv;
    persistence: SqlitePersistence;
    portalService?: ClashDeveloperPortalService;
    logger?: Partial<KeyManagerLogger>;
}): ClashApiKeyManager;
export {};
