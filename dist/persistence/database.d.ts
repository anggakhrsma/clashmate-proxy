import type { CocDeveloperAccount } from '../config/env.js';
export type DeveloperAccountRecord = {
    id: number;
    slot: number;
    email: string;
    isEnabled: boolean;
    isHealthy: boolean;
    lastLoginAt: string | null;
    unhealthyUntil: string | null;
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
};
export type ApiKeyRecord = {
    id: number;
    developerAccountId: number;
    portalKeyId: string | number | null;
    keyName: string | null;
    keyValue: string;
    cidrRanges: string[];
    isManaged: boolean;
    isActive: boolean;
    isHealthy: boolean;
    invalidReason: string | null;
    lastUsedAt: string | null;
    lastValidatedAt: string | null;
    lastSeenAt: string | null;
    unhealthyUntil: string | null;
    createdAt: string;
    updatedAt: string;
};
export type LifecycleEventRecord = {
    id: number;
    developerAccountId: number | null;
    apiKeyId: number | null;
    eventType: string;
    message: string | null;
    metadataJson: string | null;
    createdAt: string;
};
export type AppStateRecord = {
    key: string;
    value: string;
    updatedAt: string;
};
export type PersistenceBootstrapResult = {
    databasePath: string;
    appliedMigrations: string[];
    syncedAccounts: number;
};
export type SaveApiKeyInput = {
    accountSlot: number;
    portalKeyId?: string | number | null;
    keyName?: string | null;
    keyValue: string;
    cidrRanges?: string[];
    isManaged?: boolean;
    isActive?: boolean;
    isHealthy?: boolean;
    invalidReason?: string | null;
    lastUsedAt?: string | null;
    lastValidatedAt?: string | null;
    lastSeenAt?: string | null;
    unhealthyUntil?: string | null;
};
export type UpdateDeveloperAccountStatusInput = {
    slot: number;
    isEnabled?: boolean;
    isHealthy?: boolean;
    lastLoginAt?: string | null;
    unhealthyUntil?: string | null;
    lastError?: string | null;
};
export type UpdateApiKeyStatusInput = {
    keyValue: string;
    portalKeyId?: string | number | null;
    keyName?: string | null;
    cidrRanges?: string[];
    isManaged?: boolean;
    isActive?: boolean;
    isHealthy?: boolean;
    invalidReason?: string | null;
    lastUsedAt?: string | null;
    lastValidatedAt?: string | null;
    lastSeenAt?: string | null;
    unhealthyUntil?: string | null;
};
export type RecordLifecycleEventInput = {
    eventType: string;
    message?: string;
    accountSlot?: number;
    apiKeyId?: number;
    metadata?: Record<string, unknown>;
};
export declare class SqlitePersistence {
    readonly databasePath: string;
    readonly appliedMigrations: string[];
    private readonly database;
    constructor(databasePath: string);
    close(): void;
    syncConfiguredDeveloperAccounts(accounts: CocDeveloperAccount[]): DeveloperAccountRecord[];
    listDeveloperAccounts(): DeveloperAccountRecord[];
    updateDeveloperAccountStatus(input: UpdateDeveloperAccountStatusInput): DeveloperAccountRecord;
    getDeveloperAccountBySlot(slot: number): DeveloperAccountRecord | null;
    saveApiKey(input: SaveApiKeyInput): ApiKeyRecord;
    getApiKeyByValue(keyValue: string): ApiKeyRecord | null;
    getApiKeyByAccountAndPortalKeyId(developerAccountId: number, portalKeyId: string | number): ApiKeyRecord | null;
    listApiKeys(): ApiKeyRecord[];
    updateApiKeyStatus(input: UpdateApiKeyStatusInput): ApiKeyRecord;
    recordLifecycleEvent(input: RecordLifecycleEventInput): LifecycleEventRecord;
    setAppState(key: string, value: string): void;
    listLifecycleEvents(limit?: number): LifecycleEventRecord[];
    listAppState(): AppStateRecord[];
    getAppState(key: string): AppStateRecord | null;
}
export declare function initializePersistence(input: {
    sqlitePath: string;
    developerAccounts: CocDeveloperAccount[];
}): {
    persistence: SqlitePersistence;
    bootstrap: PersistenceBootstrapResult;
};
