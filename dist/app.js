"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildApp = buildApp;
const fastify_1 = __importDefault(require("fastify"));
const guards_js_1 = require("./auth/guards.js");
const service_js_1 = require("./proxy/service.js");
const PROXY_HTTP_METHODS = [
    'DELETE',
    'GET',
    'HEAD',
    'OPTIONS',
    'PATCH',
    'POST',
    'PUT',
];
const SENSITIVE_LOG_PATHS = [
    'req.headers.authorization',
    'req.headers.x-admin-secret',
    'req.headers.x-client-secret',
    'req.headers.x-clashmate-admin-secret',
    'req.headers.x-clashmate-client-secret',
];
function getProxyBody(request) {
    if (request.body === undefined) {
        return undefined;
    }
    return request.body;
}
function maskKeyValue(value) {
    if (value.length <= 10) {
        return value;
    }
    return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
function parseJsonValue(value) {
    if (!value) {
        return null;
    }
    try {
        return JSON.parse(value);
    }
    catch {
        return value;
    }
}
function sanitizeStatusSnapshot(snapshot) {
    return {
        eligibleKeyCount: snapshot.eligibleKeyCount,
        lastRotationCursor: snapshot.lastRotationCursor,
        lastValidationCompletedAt: snapshot.lastValidationCompletedAt,
        accounts: snapshot.accounts.map((account) => ({
            id: account.id,
            slot: account.slot,
            email: account.email,
            isEnabled: account.isEnabled,
            isHealthy: account.isHealthy,
            lastLoginAt: account.lastLoginAt,
            unhealthyUntil: account.unhealthyUntil,
            lastError: account.lastError,
            createdAt: account.createdAt,
            updatedAt: account.updatedAt,
            healthyManagedKeyCount: account.healthyManagedKeyCount,
            eligibleManagedKeyCount: account.eligibleManagedKeyCount,
            managedKeys: account.managedKeys.map((managedKey) => ({
                id: managedKey.id,
                developerAccountId: managedKey.developerAccountId,
                portalKeyId: managedKey.portalKeyId,
                keyName: managedKey.keyName,
                keyValueMasked: maskKeyValue(managedKey.keyValue),
                cidrRanges: managedKey.cidrRanges,
                isManaged: managedKey.isManaged,
                isActive: managedKey.isActive,
                isHealthy: managedKey.isHealthy,
                invalidReason: managedKey.invalidReason,
                lastUsedAt: managedKey.lastUsedAt,
                lastValidatedAt: managedKey.lastValidatedAt,
                lastSeenAt: managedKey.lastSeenAt,
                unhealthyUntil: managedKey.unhealthyUntil,
                createdAt: managedKey.createdAt,
                updatedAt: managedKey.updatedAt,
            })),
        })),
    };
}
function buildReadinessPayload(snapshot) {
    const enabledAccountCount = snapshot.accounts.filter((account) => account.isEnabled).length;
    const healthyAccountCount = snapshot.accounts.filter((account) => account.isEnabled && account.isHealthy).length;
    const ready = enabledAccountCount > 0 &&
        healthyAccountCount > 0 &&
        snapshot.eligibleKeyCount > 0 &&
        snapshot.lastValidationCompletedAt !== null;
    return {
        ready,
        checks: {
            hasEnabledAccounts: enabledAccountCount > 0,
            hasHealthyEnabledAccounts: healthyAccountCount > 0,
            hasEligibleManagedKeys: snapshot.eligibleKeyCount > 0,
            hasCompletedValidationSweep: snapshot.lastValidationCompletedAt !== null,
        },
        summary: {
            enabledAccountCount,
            healthyAccountCount,
            eligibleKeyCount: snapshot.eligibleKeyCount,
            lastValidationCompletedAt: snapshot.lastValidationCompletedAt,
        },
    };
}
function sendProxyResponse(reply, response) {
    reply.code(response.status);
    reply.header('x-clashmate-cache', response.cacheStatus);
    for (const [name, value] of Object.entries(response.headers)) {
        reply.header(name, value);
    }
    if (response.body === null) {
        return reply.send();
    }
    return reply.send(response.body);
}
function parseAccountSlot(rawSlot) {
    const slot = Number.parseInt(rawSlot, 10);
    return Number.isInteger(slot) && slot > 0 ? slot : null;
}
async function registerProxyRoutes(app, input) {
    app.addHook('onRequest', (0, guards_js_1.createSecretAuthHook)({
        scope: 'client',
        secret: input.env.clientApiSecret,
        logger: app.log,
    }));
    const proxyService = new service_js_1.ClashApiProxyService({
        cacheTtlSeconds: input.env.cacheTtlSeconds,
        upstreamBaseUrl: input.env.upstreamBaseUrl,
        upstreamTimeoutMs: input.env.upstreamTimeoutMs,
        upstreamMaxRetries: input.env.upstreamMaxRetries,
        keyManager: input.keyManager,
        logger: app.log,
    });
    app.addContentTypeParser('*', {
        parseAs: 'buffer',
    }, (_request, body, done) => {
        done(null, body);
    });
    const handler = async (request, reply) => {
        const rawUrl = request.raw.url ?? request.url;
        try {
            const response = await proxyService.forwardRequest({
                method: request.method,
                rawUrl,
                headers: request.headers,
                body: getProxyBody(request),
                remoteAddress: request.ip,
            });
            return sendProxyResponse(reply, response);
        }
        catch (error) {
            request.log.error({
                err: error,
                method: request.method,
                rawUrl,
            }, 'failed to proxy request to Clash of Clans upstream');
            const statusCode = error instanceof service_js_1.ProxyUnavailableError ||
                (error instanceof Error &&
                    error.message ===
                        'No healthy managed Clash of Clans API keys are available.')
                ? 503
                : error instanceof service_js_1.ProxyTransportError
                    ? error.statusCode
                    : 502;
            return reply.code(statusCode).send({
                message: statusCode === 503
                    ? 'No healthy upstream API keys are available.'
                    : 'Failed to reach Clash of Clans upstream API.',
                statusCode,
            });
        }
    };
    app.route({
        method: PROXY_HTTP_METHODS,
        url: '/v1',
        handler,
    });
    app.route({
        method: PROXY_HTTP_METHODS,
        url: '/v1/*',
        handler,
    });
}
async function registerAdminRoutes(app, input) {
    app.addHook('onRequest', (0, guards_js_1.createSecretAuthHook)({
        scope: 'admin',
        secret: input.env.adminApiSecret,
        logger: app.log,
    }));
    app.get('/admin', async () => {
        return {
            name: 'clashmate-proxy',
            scope: 'admin',
            status: 'ok',
            endpoints: {
                status: '/admin/status',
                debug: '/admin/debug',
                refresh: '/admin/refresh',
                enableAccount: '/admin/accounts/:slot/enable',
                disableAccount: '/admin/accounts/:slot/disable',
            },
        };
    });
    app.get('/admin/status', async () => {
        const snapshot = await input.keyManager.getStatusSnapshot();
        return {
            generatedAt: new Date().toISOString(),
            ...sanitizeStatusSnapshot(snapshot),
        };
    });
    app.get('/admin/debug', async () => {
        const [snapshot, appState, lifecycleEvents] = await Promise.all([
            input.keyManager.getStatusSnapshot(),
            Promise.resolve(input.persistence.listAppState()),
            Promise.resolve(input.persistence.listLifecycleEvents(50)),
        ]);
        return {
            generatedAt: new Date().toISOString(),
            status: sanitizeStatusSnapshot(snapshot),
            appState,
            lifecycleEvents: lifecycleEvents.map((event) => ({
                id: event.id,
                developerAccountId: event.developerAccountId,
                apiKeyId: event.apiKeyId,
                eventType: event.eventType,
                message: event.message,
                metadata: parseJsonValue(event.metadataJson),
                createdAt: event.createdAt,
            })),
        };
    });
    app.post('/admin/refresh', async (_request, reply) => {
        const summary = await input.keyManager.forceRefreshAllKeys();
        return reply.code(202).send({
            message: 'Managed key refresh completed.',
            summary,
        });
    });
    app.post('/admin/accounts/:slot/enable', async (request, reply) => {
        const slot = parseAccountSlot(request.params.slot);
        if (slot === null) {
            return reply.code(400).send({
                statusCode: 400,
                message: 'Account slot must be a positive integer.',
            });
        }
        try {
            const account = await input.keyManager.setAccountEnabled(slot, true);
            return reply.code(200).send({
                message: 'Developer account enabled.',
                account,
            });
        }
        catch (error) {
            if (error instanceof Error &&
                error.message.includes(`Developer account slot ${slot} does not exist`)) {
                return reply.code(404).send({
                    statusCode: 404,
                    message: `Developer account slot ${slot} was not found.`,
                });
            }
            throw error;
        }
    });
    app.post('/admin/accounts/:slot/disable', async (request, reply) => {
        const slot = parseAccountSlot(request.params.slot);
        if (slot === null) {
            return reply.code(400).send({
                statusCode: 400,
                message: 'Account slot must be a positive integer.',
            });
        }
        try {
            const account = await input.keyManager.setAccountEnabled(slot, false);
            return reply.code(200).send({
                message: 'Developer account disabled.',
                account,
            });
        }
        catch (error) {
            if (error instanceof Error &&
                error.message.includes(`Developer account slot ${slot} does not exist`)) {
                return reply.code(404).send({
                    statusCode: 404,
                    message: `Developer account slot ${slot} was not found.`,
                });
            }
            throw error;
        }
    });
}
function buildApp(input) {
    const { env, keyManager, persistence, ...fastifyOptions } = input;
    const requestTimings = new WeakMap();
    const loggerOptions = fastifyOptions.logger && typeof fastifyOptions.logger === 'object'
        ? {
            base: {
                service: 'clashmate-proxy',
                nodeEnv: env.nodeEnv,
            },
            redact: SENSITIVE_LOG_PATHS,
            ...fastifyOptions.logger,
        }
        : (fastifyOptions.logger ?? {
            level: 'info',
            base: {
                service: 'clashmate-proxy',
                nodeEnv: env.nodeEnv,
            },
            redact: SENSITIVE_LOG_PATHS,
        });
    const app = (0, fastify_1.default)({
        logger: loggerOptions,
        ...fastifyOptions,
    });
    app.addHook('onRequest', async (request) => {
        requestTimings.set(request, process.hrtime.bigint());
        request.log.debug({
            requestId: request.id,
            method: request.method,
            url: request.url,
            remoteAddress: request.ip,
        }, 'request started');
    });
    app.addHook('onError', async (request, reply, error) => {
        const startedAt = requestTimings.get(request);
        const durationMs = startedAt
            ? Number(process.hrtime.bigint() - startedAt) / 1_000_000
            : null;
        request.log.error({
            err: error,
            requestId: request.id,
            method: request.method,
            url: request.url,
            statusCode: reply.statusCode,
            durationMs,
        }, 'request failed');
    });
    app.addHook('onResponse', async (request, reply) => {
        const startedAt = requestTimings.get(request);
        const durationMs = startedAt
            ? Number(process.hrtime.bigint() - startedAt) / 1_000_000
            : null;
        requestTimings.delete(request);
        request.log.info({
            requestId: request.id,
            method: request.method,
            url: request.url,
            route: request.routeOptions.url,
            statusCode: reply.statusCode,
            durationMs,
        }, 'request completed');
    });
    app.get('/', async () => {
        return {
            name: 'clashmate-proxy',
            status: 'ok',
        };
    });
    app.get('/health', async () => {
        const appState = persistence.listAppState();
        return {
            name: 'clashmate-proxy',
            status: 'ok',
            timestamp: new Date().toISOString(),
            uptimeSeconds: Math.round(process.uptime()),
            checks: {
                process: 'ok',
                persistence: 'ok',
            },
            appStateCount: appState.length,
        };
    });
    app.get('/ready', async (request, reply) => {
        const snapshot = await keyManager.getStatusSnapshot();
        const readiness = buildReadinessPayload(snapshot);
        if (!readiness.ready) {
            request.log.warn({
                requestId: request.id,
                readiness,
            }, 'readiness check failed');
            return reply.code(503).send({
                status: 'not_ready',
                timestamp: new Date().toISOString(),
                ...readiness,
            });
        }
        return reply.code(200).send({
            status: 'ready',
            timestamp: new Date().toISOString(),
            ...readiness,
        });
    });
    void app.register(async (proxyApp) => {
        await registerProxyRoutes(proxyApp, {
            ...fastifyOptions,
            env,
            keyManager,
            persistence,
        });
    });
    void app.register(async (adminApp) => {
        await registerAdminRoutes(adminApp, {
            ...fastifyOptions,
            env,
            keyManager,
            persistence,
        });
    });
    return app;
}
//# sourceMappingURL=app.js.map