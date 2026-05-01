"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClashDeveloperPortalService = exports.ClashDeveloperPortalClient = exports.DeveloperPortalError = void 0;
const DEFAULT_PORTAL_BASE_URL = 'https://developer.clashofclans.com/api';
const DEFAULT_PORTAL_TIMEOUT_MS = 10000;
const DEFAULT_KEY_DESCRIPTION = 'Managed by clashmate-proxy';
const DEFAULT_SESSION_TTL_MS = 10 * 60 * 1000;
class DeveloperPortalError extends Error {
    code;
    operation;
    status;
    retryable;
    details;
    constructor(input) {
        super(input.message, input.cause ? { cause: input.cause } : undefined);
        this.name = 'DeveloperPortalError';
        this.code = input.code;
        this.operation = input.operation;
        this.status = input.status ?? null;
        this.retryable = input.retryable ?? false;
        this.details = input.details ?? null;
    }
}
exports.DeveloperPortalError = DeveloperPortalError;
function isObject(value) {
    return typeof value === 'object' && value !== null;
}
function getErrorMessage(payload) {
    if (typeof payload === 'string' && payload.trim().length > 0) {
        return payload;
    }
    if (!isObject(payload)) {
        return null;
    }
    const candidates = ['message', 'reason', 'error'];
    for (const candidate of candidates) {
        const value = payload[candidate];
        if (typeof value === 'string' && value.trim().length > 0) {
            return value;
        }
    }
    return null;
}
function getErrorCode(operation, status, payload) {
    const message = getErrorMessage(payload)?.toLowerCase() ?? '';
    if (status === 401 || status === 403) {
        return operation === 'login' ? 'AUTHENTICATION_FAILED' : 'SESSION_INVALID';
    }
    if (status === 429) {
        return 'RATE_LIMITED';
    }
    if (message.includes('invalid credentials')) {
        return 'AUTHENTICATION_FAILED';
    }
    if (message.includes('login') || message.includes('session')) {
        return 'SESSION_INVALID';
    }
    if (message.includes('limit') || message.includes('maximum')) {
        return 'KEY_LIMIT_REACHED';
    }
    if (message.includes('not found')) {
        return 'KEY_NOT_FOUND';
    }
    return 'PORTAL_ERROR';
}
function isRetryableStatus(status) {
    return status === 429 || (status !== null && status >= 500);
}
async function parseJsonSafe(response) {
    const text = await response.text();
    if (text.length === 0) {
        return null;
    }
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
}
function normalizeStringArray(value) {
    return Array.isArray(value)
        ? value.filter((entry) => typeof entry === 'string')
        : [];
}
function normalizePortalKeyId(value) {
    if (typeof value === 'number' && Number.isInteger(value)) {
        return value;
    }
    if (typeof value === 'string' && /^\d+$/.test(value)) {
        return Number.parseInt(value, 10);
    }
    if (typeof value === 'string' && value.trim().length > 0) {
        return value;
    }
    return null;
}
function normalizePortalString(value) {
    return typeof value === 'string' ? value : null;
}
function buildSyntheticPortalKeyId() {
    return -Date.now();
}
function normalizePortalKey(payload, options = { requireKey: true }) {
    if (!isObject(payload)) {
        throw new DeveloperPortalError({
            code: 'INVALID_RESPONSE',
            message: 'Developer portal returned an invalid API key payload.',
            operation: 'normalizePortalKey',
            details: payload,
        });
    }
    const id = normalizePortalKeyId(payload.id);
    const name = normalizePortalString(payload.name);
    const description = normalizePortalString(payload.description) ?? '';
    const key = normalizePortalString(payload.key) ??
        normalizePortalString(payload.token) ??
        normalizePortalString(payload.value);
    if (id === null || name === null || (options.requireKey && key === null)) {
        throw new DeveloperPortalError({
            code: 'INVALID_RESPONSE',
            message: 'Developer portal API key payload is missing required fields.',
            operation: 'normalizePortalKey',
            details: payload,
        });
    }
    return {
        id,
        name,
        description,
        key: key ?? '',
        cidrRanges: normalizeStringArray(payload.cidrRanges),
        scopes: normalizeStringArray(payload.scopes),
    };
}
function normalizeCreatedPortalKey(payload, input) {
    if (isObject(payload)) {
        const nestedKey = payload.key ?? payload.apiKey;
        if (isObject(nestedKey)) {
            return normalizePortalKey(nestedKey);
        }
        const key = normalizePortalString(nestedKey) ??
            normalizePortalString(payload.token) ??
            normalizePortalString(payload.value);
        if (key) {
            return {
                id: normalizePortalKeyId(payload.id) ?? buildSyntheticPortalKeyId(),
                name: normalizePortalString(payload.name) ?? input.name ?? 'clashmate-proxy',
                description: normalizePortalString(payload.description) ?? input.description ?? '',
                key,
                cidrRanges: normalizeStringArray(payload.cidrRanges).length
                    ? normalizeStringArray(payload.cidrRanges)
                    : input.cidrRanges,
                scopes: normalizeStringArray(payload.scopes).length
                    ? normalizeStringArray(payload.scopes)
                    : (input.scopes ?? []),
            };
        }
    }
    const key = normalizePortalString(payload);
    if (key) {
        return {
            id: buildSyntheticPortalKeyId(),
            name: input.name ?? 'clashmate-proxy',
            description: input.description ?? '',
            key,
            cidrRanges: input.cidrRanges,
            scopes: input.scopes ?? [],
        };
    }
    return normalizePortalKey(payload);
}
function toPortalError(input) {
    const status = input.status ?? null;
    const code = getErrorCode(input.operation, status, input.payload);
    const message = getErrorMessage(input.payload) ??
        (status
            ? `Developer portal ${input.operation} request failed with status ${status}.`
            : `Developer portal ${input.operation} request failed.`);
    return new DeveloperPortalError({
        code,
        message,
        operation: input.operation,
        status,
        retryable: input.cause ? true : isRetryableStatus(status),
        details: input.payload,
        cause: input.cause,
    });
}
function buildManagedCookie(input) {
    const headers = input.response.headers;
    const setCookieValues = typeof headers.getSetCookie === 'function'
        ? headers.getSetCookie()
        : [input.response.headers.get('set-cookie')].filter((value) => typeof value === 'string');
    if (setCookieValues.length === 0) {
        throw new DeveloperPortalError({
            code: 'INVALID_RESPONSE',
            message: 'Developer portal login response did not include a session cookie.',
            operation: 'login',
            details: {
                swaggerUrl: input.swaggerUrl,
            },
        });
    }
    const cookieParts = setCookieValues.map((value) => value.split(';', 1)[0]);
    cookieParts.push(`game-api-url=${input.swaggerUrl}`);
    cookieParts.push(`game-api-token=${input.temporaryApiToken}`);
    return cookieParts.join('; ');
}
class ClashDeveloperPortalClient {
    baseUrl;
    timeoutMs;
    fetchImplementation;
    constructor(options = {}) {
        this.baseUrl = options.baseUrl ?? DEFAULT_PORTAL_BASE_URL;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_PORTAL_TIMEOUT_MS;
        this.fetchImplementation = options.fetchImplementation ?? fetch;
    }
    async login(credentials) {
        const createdAt = new Date();
        const response = await this.request({
            operation: 'login',
            path: '/login',
            body: {
                email: credentials.email,
                password: credentials.password,
            },
        });
        if (typeof response.payload.swaggerUrl !== 'string' ||
            typeof response.payload.temporaryAPIToken !== 'string') {
            throw new DeveloperPortalError({
                code: 'INVALID_RESPONSE',
                message: 'Developer portal login response is missing session details.',
                operation: 'login',
                details: response.payload,
            });
        }
        return {
            accountSlot: credentials.slot,
            accountEmail: credentials.email,
            cookie: buildManagedCookie({
                response: response.rawResponse,
                swaggerUrl: response.payload.swaggerUrl,
                temporaryApiToken: response.payload.temporaryAPIToken,
            }),
            swaggerUrl: response.payload.swaggerUrl,
            temporaryApiToken: response.payload.temporaryAPIToken,
            createdAt: createdAt.toISOString(),
            expiresAt: new Date(createdAt.getTime() + DEFAULT_SESSION_TTL_MS).toISOString(),
        };
    }
    async listKeys(session) {
        const response = await this.request({
            operation: 'listKeys',
            path: '/apikey/list',
            session,
            body: {},
        });
        if (!Array.isArray(response.payload.keys)) {
            throw new DeveloperPortalError({
                code: 'INVALID_RESPONSE',
                message: 'Developer portal list keys response is missing the keys array.',
                operation: 'listKeys',
                details: response.payload,
            });
        }
        return response.payload.keys.flatMap((key) => {
            try {
                return [normalizePortalKey(key, { requireKey: false })];
            }
            catch (error) {
                if (error instanceof DeveloperPortalError) {
                    return [];
                }
                throw error;
            }
        });
    }
    async createKey(session, input) {
        if (input.cidrRanges.length === 0) {
            throw new DeveloperPortalError({
                code: 'INVALID_RESPONSE',
                message: 'At least one CIDR range is required to create a developer portal key.',
                operation: 'createKey',
                details: input,
            });
        }
        const response = await this.request({
            operation: 'createKey',
            path: '/apikey/create',
            session,
            body: {
                name: input.name ?? `clashmate-proxy-${new Date().toISOString()}`,
                description: input.description ?? DEFAULT_KEY_DESCRIPTION,
                cidrRanges: input.cidrRanges,
                scopes: input.scopes ?? null,
            },
        });
        return normalizeCreatedPortalKey(response.payload, input);
    }
    async revokeKey(session, keyId) {
        await this.request({
            operation: 'revokeKey',
            path: '/apikey/revoke',
            session,
            body: {
                id: keyId,
            },
        });
    }
    async regenerateKey(session, input) {
        if (typeof input.revokeKeyId === 'number') {
            await this.revokeKey(session, input.revokeKeyId);
        }
        return this.createKey(session, input);
    }
    async request(input) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
            controller.abort();
        }, this.timeoutMs);
        try {
            const response = await this.fetchImplementation(`${this.baseUrl}${input.path}`, {
                method: 'POST',
                headers: {
                    accept: 'application/json, text/plain, */*',
                    'content-type': 'application/json',
                    origin: this.baseUrl.replace(/\/api$/, ''),
                    referer: `${this.baseUrl.replace(/\/api$/, '')}/`,
                    'x-requested-with': 'XMLHttpRequest',
                    ...(input.session ? { cookie: input.session.cookie } : {}),
                },
                body: JSON.stringify(input.body),
                signal: controller.signal,
            });
            const payload = await parseJsonSafe(response);
            if (!response.ok) {
                throw toPortalError({
                    operation: input.operation,
                    status: response.status,
                    payload,
                });
            }
            return {
                payload: payload,
                rawResponse: response,
            };
        }
        catch (error) {
            if (error instanceof DeveloperPortalError) {
                throw error;
            }
            throw new DeveloperPortalError({
                code: 'NETWORK_ERROR',
                message: `Developer portal ${input.operation} request failed due to a network error.`,
                operation: input.operation,
                retryable: true,
                cause: error,
            });
        }
        finally {
            clearTimeout(timeoutId);
        }
    }
}
exports.ClashDeveloperPortalClient = ClashDeveloperPortalClient;
class ClashDeveloperPortalService {
    client;
    sessionCache = new Map();
    sessionTtlMs;
    constructor(client = new ClashDeveloperPortalClient(), options = {}) {
        this.client = client;
        this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    }
    invalidateSession(accountEmail) {
        this.sessionCache.delete(accountEmail);
    }
    clearSessions() {
        this.sessionCache.clear();
    }
    getCachedSession(accountEmail) {
        const session = this.sessionCache.get(accountEmail);
        if (!session) {
            return null;
        }
        if (Date.parse(session.expiresAt) <= Date.now()) {
            this.sessionCache.delete(accountEmail);
            return null;
        }
        return session;
    }
    async loginAccount(credentials) {
        const cachedSession = this.getCachedSession(credentials.email);
        if (cachedSession) {
            return cachedSession;
        }
        const session = await this.client.login(credentials);
        session.expiresAt = new Date(Date.now() + this.sessionTtlMs).toISOString();
        this.sessionCache.set(credentials.email, session);
        return session;
    }
    async listKeysForAccount(credentials) {
        return this.withSession(credentials, (session) => this.client.listKeys(session));
    }
    async createKeyForAccount(credentials, input) {
        return this.withSession(credentials, (session) => this.client.createKey(session, input));
    }
    async revokeKeyForAccount(credentials, keyId) {
        await this.withSession(credentials, async (session) => {
            await this.client.revokeKey(session, keyId);
            return undefined;
        });
    }
    async regenerateKeyForAccount(credentials, input) {
        return this.withSession(credentials, (session) => this.client.regenerateKey(session, input));
    }
    async withSession(credentials, operation) {
        try {
            const session = await this.loginAccount(credentials);
            return await operation(session);
        }
        catch (error) {
            if (error instanceof DeveloperPortalError &&
                error.code === 'SESSION_INVALID') {
                this.invalidateSession(credentials.email);
                const session = await this.loginAccount(credentials);
                return operation(session);
            }
            throw error;
        }
    }
}
exports.ClashDeveloperPortalService = ClashDeveloperPortalService;
//# sourceMappingURL=client.js.map