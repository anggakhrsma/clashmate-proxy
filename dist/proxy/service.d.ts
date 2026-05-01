import type { IncomingHttpHeaders } from 'node:http';
import { ProxyResponseCache } from '../cache/memory.js';
import type { ManagedApiKeyLease, ReportUpstreamFailureResult, UpstreamFailureCategory } from '../key-manager/service.js';
type ProxyLogger = {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
};
type FetchLike = typeof fetch;
type ForwardProxyRequestInput = {
    method: string;
    rawUrl: string;
    headers: IncomingHttpHeaders;
    body: unknown;
    remoteAddress?: string | null;
};
export type ForwardProxyResponse = {
    status: number;
    headers: Record<string, string>;
    body: Buffer | null;
    upstreamUrl: string;
    keyLease: ManagedApiKeyLease | null;
    cacheStatus: 'BYPASS' | 'HIT' | 'MISS';
    cachedAt: string | null;
};
type UpstreamAttemptFailure = {
    category: UpstreamFailureCategory;
    statusCode: number | null;
    keyValue: string;
    accountSlot: number;
};
export declare class ProxyUnavailableError extends Error {
    readonly statusCode = 503;
    readonly failures: UpstreamAttemptFailure[];
    constructor(message: string, failures: UpstreamAttemptFailure[]);
}
export declare class ProxyTransportError extends Error {
    readonly statusCode = 502;
    constructor(message: string, cause?: unknown);
}
export declare class ClashApiProxyService {
    private readonly input;
    private readonly logger;
    private readonly fetchImplementation;
    private readonly responseCache;
    constructor(input: {
        upstreamBaseUrl: string;
        upstreamTimeoutMs: number;
        upstreamMaxRetries: number;
        cacheTtlSeconds: number;
        keyManager: {
            acquireKey: () => Promise<ManagedApiKeyLease>;
            markKeyHealthy: (keyValue: string) => Promise<unknown>;
            reportUpstreamFailure: (input: {
                keyValue: string;
                category: UpstreamFailureCategory;
                statusCode?: number | null;
                message?: string | null;
                metadata?: Record<string, unknown>;
            }) => Promise<ReportUpstreamFailureResult>;
        };
        responseCache?: ProxyResponseCache;
        fetchImplementation?: FetchLike;
        logger?: Partial<ProxyLogger>;
    });
    forwardRequest(request: ForwardProxyRequestInput): Promise<ForwardProxyResponse>;
}
export {};
