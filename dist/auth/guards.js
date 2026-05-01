"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSecretAuthHook = createSecretAuthHook;
const node_crypto_1 = require("node:crypto");
const DEFAULT_LOGGER = {
    warn: () => { },
};
const SCOPE_HEADER_NAMES = {
    client: ['x-clashmate-client-secret', 'x-client-secret'],
    admin: ['x-clashmate-admin-secret', 'x-admin-secret'],
};
function bindWarnLogger(logger) {
    if (typeof logger?.warn !== 'function') {
        return DEFAULT_LOGGER.warn;
    }
    return logger.warn.bind(logger);
}
function getHeaderValue(value) {
    if (Array.isArray(value)) {
        return value[0]?.trim() || null;
    }
    return value?.trim() || null;
}
function extractBearerToken(value) {
    if (!value) {
        return null;
    }
    const match = /^Bearer\s+(.+)$/i.exec(value);
    return match?.[1]?.trim() || null;
}
function secretsMatch(expected, provided) {
    if (!provided) {
        return false;
    }
    const expectedBuffer = Buffer.from(expected);
    const providedBuffer = Buffer.from(provided);
    return (expectedBuffer.length === providedBuffer.length &&
        (0, node_crypto_1.timingSafeEqual)(expectedBuffer, providedBuffer));
}
function extractScopedSecret(request, scope) {
    const headers = request.headers;
    for (const headerName of SCOPE_HEADER_NAMES[scope]) {
        const value = getHeaderValue(headers[headerName]);
        if (value) {
            return {
                source: headerName,
                value,
            };
        }
    }
    const authorizationHeader = getHeaderValue(headers.authorization);
    const bearerToken = extractBearerToken(authorizationHeader);
    if (bearerToken) {
        return {
            source: 'authorization',
            value: bearerToken,
        };
    }
    return null;
}
function buildUnauthorizedPayload(scope) {
    return {
        statusCode: 401,
        error: 'Unauthorized',
        message: `Invalid or missing ${scope} credentials.`,
    };
}
async function sendUnauthorized(reply, scope) {
    reply.header('www-authenticate', `Bearer realm="clashmate-proxy-${scope}"`);
    return reply.code(401).send(buildUnauthorizedPayload(scope));
}
function createSecretAuthHook(input) {
    const logWarn = bindWarnLogger(input.logger);
    return async (request, reply) => {
        const providedSecret = extractScopedSecret(request, input.scope);
        if (secretsMatch(input.secret, providedSecret?.value ?? null)) {
            return;
        }
        logWarn({
            scope: input.scope,
            method: request.method,
            url: request.url,
            remoteAddress: request.ip,
            providedSecretSource: providedSecret?.source ?? null,
            hasAuthorizationHeader: typeof request.headers.authorization === 'string',
        }, 'request authentication failed');
        return sendUnauthorized(reply, input.scope);
    };
}
//# sourceMappingURL=guards.js.map