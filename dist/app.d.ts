import { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { AppEnv } from './config/env.js';
import type { ClashApiKeyManager } from './key-manager/service.js';
import type { SqlitePersistence } from './persistence/database.js';
type BuildAppInput = {
    env: Pick<AppEnv, 'adminApiSecret' | 'cacheTtlSeconds' | 'clientApiSecret' | 'nodeEnv' | 'upstreamBaseUrl' | 'upstreamTimeoutMs' | 'upstreamMaxRetries'>;
    keyManager: Pick<ClashApiKeyManager, 'acquireKey' | 'forceRefreshAllKeys' | 'getStatusSnapshot' | 'markKeyHealthy' | 'reportUpstreamFailure' | 'setAccountEnabled'>;
    persistence: Pick<SqlitePersistence, 'listAppState' | 'listLifecycleEvents'>;
} & FastifyServerOptions;
export declare function buildApp(input: BuildAppInput): FastifyInstance<import("fastify").RawServerDefault, import("http").IncomingMessage, import("http").ServerResponse<import("http").IncomingMessage>, import("fastify").FastifyBaseLogger, import("fastify").FastifyTypeProviderDefault> & PromiseLike<FastifyInstance<import("fastify").RawServerDefault, import("http").IncomingMessage, import("http").ServerResponse<import("http").IncomingMessage>, import("fastify").FastifyBaseLogger, import("fastify").FastifyTypeProviderDefault>> & {
    __linterBrands: "SafePromiseLike";
};
export {};
