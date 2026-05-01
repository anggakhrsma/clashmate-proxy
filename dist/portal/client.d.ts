import type { CocDeveloperAccount } from '../config/env.js';
type FetchLike = typeof fetch;
export type DeveloperPortalErrorCode = 'AUTHENTICATION_FAILED' | 'SESSION_INVALID' | 'RATE_LIMITED' | 'NETWORK_ERROR' | 'INVALID_RESPONSE' | 'KEY_LIMIT_REACHED' | 'KEY_NOT_FOUND' | 'PORTAL_ERROR';
export type DeveloperPortalSession = {
    accountSlot: number;
    accountEmail: string;
    cookie: string;
    swaggerUrl: string;
    temporaryApiToken: string;
    createdAt: string;
    expiresAt: string;
};
export type DeveloperPortalAccountCredentials = Pick<CocDeveloperAccount, 'slot' | 'email' | 'password'>;
export type DeveloperPortalKey = {
    id: number;
    name: string;
    description: string;
    key: string;
    cidrRanges: string[];
    scopes: string[];
};
export type CreateDeveloperPortalKeyInput = {
    cidrRanges: string[];
    name?: string;
    description?: string;
    scopes?: string[] | null;
};
export type RegenerateDeveloperPortalKeyInput = CreateDeveloperPortalKeyInput & {
    revokeKeyId?: number;
};
export declare class DeveloperPortalError extends Error {
    readonly code: DeveloperPortalErrorCode;
    readonly operation: string;
    readonly status: number | null;
    readonly retryable: boolean;
    readonly details: unknown;
    constructor(input: {
        code: DeveloperPortalErrorCode;
        message: string;
        operation: string;
        status?: number | null;
        retryable?: boolean;
        details?: unknown;
        cause?: unknown;
    });
}
export declare class ClashDeveloperPortalClient {
    private readonly baseUrl;
    private readonly timeoutMs;
    private readonly fetchImplementation;
    constructor(options?: {
        baseUrl?: string;
        timeoutMs?: number;
        fetchImplementation?: FetchLike;
    });
    login(credentials: DeveloperPortalAccountCredentials): Promise<DeveloperPortalSession>;
    listKeys(session: DeveloperPortalSession): Promise<DeveloperPortalKey[]>;
    createKey(session: DeveloperPortalSession, input: CreateDeveloperPortalKeyInput): Promise<DeveloperPortalKey>;
    revokeKey(session: DeveloperPortalSession, keyId: number): Promise<void>;
    regenerateKey(session: DeveloperPortalSession, input: RegenerateDeveloperPortalKeyInput): Promise<DeveloperPortalKey>;
    private request;
}
export declare class ClashDeveloperPortalService {
    private readonly client;
    private readonly sessionCache;
    private readonly sessionTtlMs;
    constructor(client?: ClashDeveloperPortalClient, options?: {
        sessionTtlMs?: number;
    });
    invalidateSession(accountEmail: string): void;
    clearSessions(): void;
    getCachedSession(accountEmail: string): DeveloperPortalSession | null;
    loginAccount(credentials: DeveloperPortalAccountCredentials): Promise<DeveloperPortalSession>;
    listKeysForAccount(credentials: DeveloperPortalAccountCredentials): Promise<DeveloperPortalKey[]>;
    createKeyForAccount(credentials: DeveloperPortalAccountCredentials, input: CreateDeveloperPortalKeyInput): Promise<DeveloperPortalKey>;
    revokeKeyForAccount(credentials: DeveloperPortalAccountCredentials, keyId: number): Promise<void>;
    regenerateKeyForAccount(credentials: DeveloperPortalAccountCredentials, input: RegenerateDeveloperPortalKeyInput): Promise<DeveloperPortalKey>;
    private withSession;
}
export {};
