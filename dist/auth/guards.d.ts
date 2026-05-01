import type { onRequestHookHandler } from 'fastify';
type AuthScope = 'admin' | 'client';
type AuthLogger = {
    warn: (...args: unknown[]) => void;
};
export declare function createSecretAuthHook(input: {
    scope: AuthScope;
    secret: string;
    logger?: Partial<AuthLogger>;
}): onRequestHookHandler;
export {};
