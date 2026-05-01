"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClashApiProxyService = exports.ProxyTransportError = exports.ProxyUnavailableError = void 0;
const memory_js_1 = require("../cache/memory.js");
const DEFAULT_LOGGER = {
    debug: () => { },
    info: () => { },
    warn: () => { },
    error: () => { },
};
const REQUEST_HEADERS_TO_SKIP = new Set([
    'authorization',
    'connection',
    'content-length',
    'host',
    'transfer-encoding',
    'x-admin-secret',
    'x-client-secret',
    'x-clashmate-admin-secret',
    'x-clashmate-client-secret',
]);
const RESPONSE_HEADERS_TO_SKIP = new Set([
    'connection',
    'content-encoding',
    'content-length',
    'keep-alive',
    'transfer-encoding',
]);
function bindLoggerMethod(logger, method) {
    const candidate = logger?.[method];
    if (typeof candidate !== 'function') {
        return DEFAULT_LOGGER[method];
    }
    return candidate.bind(logger);
}
function shouldForwardRequestBody(method) {
    return method !== 'GET' && method !== 'HEAD';
}
function shouldReadResponseBody(method) {
    return method !== 'HEAD';
}
function shouldCacheRequest(method) {
    return method === 'GET';
}
function shouldCacheResponseStatus(status) {
    return status >= 200 && status < 300;
}
function normalizeRawUrl(rawUrl) {
    return rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`;
}
function buildUpstreamUrl(upstreamBaseUrl, rawUrl) {
    const normalizedRawUrl = normalizeRawUrl(rawUrl);
    const baseUrl = new URL(upstreamBaseUrl);
    const basePath = baseUrl.pathname.replace(/\/$/, '');
    const rawPathAndQuery = new URL(normalizedRawUrl, baseUrl.origin);
    const normalizedRawPath = rawPathAndQuery.pathname;
    const shouldUseRawPath = basePath.length === 0 ||
        normalizedRawPath === basePath ||
        normalizedRawPath.startsWith(`${basePath}/`);
    const upstreamPath = shouldUseRawPath
        ? normalizedRawPath
        : `${basePath}${normalizedRawPath}`;
    return new URL(`${upstreamPath}${rawPathAndQuery.search}`, baseUrl.origin).toString();
}
function buildCacheKey(method, rawUrl) {
    return `${method.toUpperCase()}:${normalizeRawUrl(rawUrl)}`;
}
function buildForwardHeaders(input) {
    const headers = new Headers();
    for (const [name, value] of Object.entries(input.incomingHeaders)) {
        if (value === undefined) {
            continue;
        }
        const normalizedName = name.toLowerCase();
        if (REQUEST_HEADERS_TO_SKIP.has(normalizedName)) {
            continue;
        }
        if (Array.isArray(value)) {
            for (const item of value) {
                headers.append(name, item);
            }
            continue;
        }
        headers.set(name, value);
    }
    headers.set('authorization', `Bearer ${input.keyLease.keyValue}`);
    headers.set('x-forwarded-host', input.incomingHeaders.host ?? 'unknown');
    headers.set('x-forwarded-proto', input.incomingHeaders['x-forwarded-proto'] ??
        'http');
    const priorForwardedFor = input.incomingHeaders['x-forwarded-for'];
    const remoteAddress = input.remoteAddress?.trim();
    if (remoteAddress) {
        const forwardedForValue = Array.isArray(priorForwardedFor)
            ? [...priorForwardedFor, remoteAddress].join(', ')
            : typeof priorForwardedFor === 'string' && priorForwardedFor.length > 0
                ? `${priorForwardedFor}, ${remoteAddress}`
                : remoteAddress;
        headers.set('x-forwarded-for', forwardedForValue);
    }
    return headers;
}
function buildForwardBody(input) {
    if (!shouldForwardRequestBody(input.method) || input.body === undefined) {
        return undefined;
    }
    if (input.body === null) {
        return undefined;
    }
    if (Buffer.isBuffer(input.body)) {
        return input.body;
    }
    if (input.body instanceof Uint8Array) {
        return input.body;
    }
    if (typeof input.body === 'string') {
        return input.body;
    }
    if (input.body instanceof ArrayBuffer) {
        return new Uint8Array(input.body);
    }
    if (ArrayBuffer.isView(input.body)) {
        return new Uint8Array(input.body.buffer, input.body.byteOffset, input.body.byteLength);
    }
    if (!input.headers.has('content-type')) {
        input.headers.set('content-type', 'application/json');
    }
    return JSON.stringify(input.body);
}
function readResponseHeaders(headers) {
    const result = {};
    headers.forEach((value, name) => {
        if (RESPONSE_HEADERS_TO_SKIP.has(name.toLowerCase())) {
            return;
        }
        result[name] = value;
    });
    return result;
}
function extractBodyText(body) {
    if (!body || body.length === 0) {
        return null;
    }
    return body.toString('utf8');
}
function normalizeUpstreamErrorText(bodyText) {
    return (bodyText ?? '').toLowerCase();
}
function classifyRetryableUpstreamFailure(input) {
    const errorText = normalizeUpstreamErrorText(input.bodyText);
    if (input.status === 401) {
        return {
            category: 'AUTHENTICATION',
            statusCode: input.status,
            bodyText: input.bodyText,
        };
    }
    if (input.status === 403) {
        const category = errorText.includes('invalidip') ||
            errorText.includes('invalid ip') ||
            (errorText.includes('ip') && errorText.includes('accessdenied'))
            ? 'INVALID_IP'
            : errorText.includes('key') ||
                errorText.includes('token') ||
                errorText.includes('authorization') ||
                errorText.includes('credential')
                ? 'INVALID_KEY'
                : 'AUTHENTICATION';
        return {
            category,
            statusCode: input.status,
            bodyText: input.bodyText,
        };
    }
    if (input.status === 429) {
        return {
            category: 'RATE_LIMITED',
            statusCode: input.status,
            bodyText: input.bodyText,
        };
    }
    if (input.status >= 500) {
        return {
            category: 'SERVER_ERROR',
            statusCode: input.status,
            bodyText: input.bodyText,
        };
    }
    return null;
}
function maskKeyValue(value) {
    if (value.length <= 10) {
        return value;
    }
    return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
function toErrorMessage(error) {
    if (error instanceof Error) {
        return error.message;
    }
    return 'Unknown upstream error';
}
function getFailureStatusCode(failure) {
    return failure.statusCode;
}
class ProxyUnavailableError extends Error {
    statusCode = 503;
    failures;
    constructor(message, failures) {
        super(message);
        this.name = 'ProxyUnavailableError';
        this.failures = failures;
    }
}
exports.ProxyUnavailableError = ProxyUnavailableError;
class ProxyTransportError extends Error {
    statusCode = 502;
    constructor(message, cause) {
        super(message, cause ? { cause } : undefined);
        this.name = 'ProxyTransportError';
    }
}
exports.ProxyTransportError = ProxyTransportError;
class ClashApiProxyService {
    input;
    logger;
    fetchImplementation;
    responseCache;
    constructor(input) {
        this.input = input;
        this.logger = {
            debug: bindLoggerMethod(input.logger, 'debug'),
            info: bindLoggerMethod(input.logger, 'info'),
            warn: bindLoggerMethod(input.logger, 'warn'),
            error: bindLoggerMethod(input.logger, 'error'),
        };
        this.fetchImplementation = input.fetchImplementation ?? fetch;
        this.responseCache =
            input.responseCache ??
                new memory_js_1.ProxyResponseCache(input.cacheTtlSeconds * 1000);
    }
    async forwardRequest(request) {
        const rawUrl = normalizeRawUrl(request.rawUrl);
        const upstreamUrl = buildUpstreamUrl(this.input.upstreamBaseUrl, rawUrl);
        const cacheKey = buildCacheKey(request.method, rawUrl);
        const failures = [];
        const maximumAttempts = this.input.upstreamMaxRetries + 1;
        if (shouldCacheRequest(request.method)) {
            const cachedResponse = this.responseCache.get(cacheKey);
            if (cachedResponse) {
                this.logger.debug({
                    method: request.method,
                    rawUrl,
                    upstreamUrl: cachedResponse.upstreamUrl,
                    cachedAt: cachedResponse.cachedAt,
                }, 'serving proxied response from GET cache');
                return {
                    status: cachedResponse.status,
                    headers: cachedResponse.headers,
                    body: cachedResponse.body,
                    upstreamUrl: cachedResponse.upstreamUrl,
                    keyLease: null,
                    cacheStatus: 'HIT',
                    cachedAt: cachedResponse.cachedAt,
                };
            }
        }
        for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
            let keyLease;
            try {
                keyLease = await this.input.keyManager.acquireKey();
            }
            catch (error) {
                if (failures.length > 0) {
                    throw new ProxyUnavailableError('No healthy upstream API keys are available after retry exhaustion.', failures);
                }
                throw error;
            }
            const forwardHeaders = buildForwardHeaders({
                incomingHeaders: request.headers,
                keyLease,
                remoteAddress: request.remoteAddress,
            });
            const body = buildForwardBody({
                method: request.method,
                body: request.body,
                headers: forwardHeaders,
            });
            const controller = new AbortController();
            const timeoutHandle = setTimeout(() => {
                controller.abort();
            }, this.input.upstreamTimeoutMs);
            try {
                const response = await this.fetchImplementation(upstreamUrl, {
                    method: request.method,
                    headers: forwardHeaders,
                    body,
                    signal: controller.signal,
                    ...(body ? { duplex: 'half' } : {}),
                });
                const responseBody = shouldReadResponseBody(request.method)
                    ? Buffer.from(await response.arrayBuffer())
                    : null;
                const bodyText = extractBodyText(responseBody);
                const retryableFailure = classifyRetryableUpstreamFailure({
                    status: response.status,
                    bodyText,
                });
                if (retryableFailure) {
                    failures.push({
                        category: retryableFailure.category,
                        statusCode: retryableFailure.statusCode,
                        keyValue: keyLease.keyValue,
                        accountSlot: keyLease.accountSlot,
                    });
                    const handledFailure = await this.input.keyManager.reportUpstreamFailure({
                        keyValue: keyLease.keyValue,
                        category: retryableFailure.category,
                        statusCode: retryableFailure.statusCode,
                        message: bodyText,
                        metadata: {
                            upstreamUrl,
                            method: request.method,
                        },
                    });
                    this.logger.warn({
                        attempt,
                        maximumAttempts,
                        method: request.method,
                        upstreamUrl,
                        upstreamStatus: response.status,
                        failureCategory: retryableFailure.category,
                        accountSlot: keyLease.accountSlot,
                        apiKeyId: keyLease.apiKeyId,
                        handledFailure,
                    }, 'retryable upstream failure detected; rotating to the next key');
                    if (attempt >= maximumAttempts) {
                        throw new ProxyUnavailableError('No healthy upstream API keys are available after retry exhaustion.', failures);
                    }
                    continue;
                }
                await this.input.keyManager.markKeyHealthy(keyLease.keyValue);
                const responseHeaders = readResponseHeaders(response.headers);
                const cacheStatus = shouldCacheRequest(request.method)
                    ? 'MISS'
                    : 'BYPASS';
                const cachedResponse = shouldCacheRequest(request.method) &&
                    shouldCacheResponseStatus(response.status)
                    ? this.responseCache.set(cacheKey, {
                        status: response.status,
                        headers: responseHeaders,
                        body: responseBody,
                        upstreamUrl,
                    })
                    : null;
                this.logger.debug({
                    attempt,
                    method: request.method,
                    upstreamUrl,
                    upstreamStatus: response.status,
                    accountSlot: keyLease.accountSlot,
                    apiKeyId: keyLease.apiKeyId,
                    cacheStatus,
                }, 'proxied request to Clash of Clans upstream');
                return {
                    status: response.status,
                    headers: responseHeaders,
                    body: responseBody,
                    upstreamUrl,
                    keyLease,
                    cacheStatus,
                    cachedAt: cachedResponse?.cachedAt ?? null,
                };
            }
            catch (error) {
                if (error instanceof ProxyUnavailableError) {
                    throw error;
                }
                const category = error instanceof Error && error.name === 'AbortError'
                    ? 'TIMEOUT'
                    : 'NETWORK_ERROR';
                const statusCode = null;
                failures.push({
                    category,
                    statusCode,
                    keyValue: keyLease.keyValue,
                    accountSlot: keyLease.accountSlot,
                });
                const handledFailure = await this.input.keyManager.reportUpstreamFailure({
                    keyValue: keyLease.keyValue,
                    category,
                    statusCode,
                    message: toErrorMessage(error),
                    metadata: {
                        upstreamUrl,
                        method: request.method,
                    },
                });
                this.logger.warn({
                    attempt,
                    maximumAttempts,
                    method: request.method,
                    upstreamUrl,
                    failureCategory: category,
                    accountSlot: keyLease.accountSlot,
                    apiKeyId: keyLease.apiKeyId,
                    handledFailure,
                    err: error,
                }, 'upstream transport failure detected; rotating to the next key');
                if (attempt >= maximumAttempts) {
                    throw new ProxyUnavailableError('No healthy upstream API keys are available after retry exhaustion.', failures);
                }
            }
            finally {
                clearTimeout(timeoutHandle);
            }
        }
        throw new ProxyTransportError('Failed to complete proxy request due to an unexpected retry state.');
    }
}
exports.ClashApiProxyService = ClashApiProxyService;
//# sourceMappingURL=service.js.map