"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProxyResponseCache = void 0;
function cloneBody(body) {
    return body ? Buffer.from(body) : null;
}
function cloneResponse(response) {
    return {
        status: response.status,
        headers: { ...response.headers },
        body: cloneBody(response.body),
        upstreamUrl: response.upstreamUrl,
        cachedAt: response.cachedAt,
        expiresAt: response.expiresAt,
    };
}
class ProxyResponseCache {
    ttlMs;
    entries = new Map();
    constructor(ttlMs) {
        this.ttlMs = ttlMs;
    }
    get(key) {
        const entry = this.entries.get(key);
        if (!entry) {
            return null;
        }
        if (Date.parse(entry.expiresAt) <= Date.now()) {
            this.entries.delete(key);
            return null;
        }
        return cloneResponse(entry);
    }
    set(key, response) {
        const cachedAt = new Date().toISOString();
        const entry = {
            ...response,
            body: cloneBody(response.body),
            headers: { ...response.headers },
            cachedAt,
            expiresAt: new Date(Date.now() + this.ttlMs).toISOString(),
        };
        this.entries.set(key, entry);
        return cloneResponse(entry);
    }
    clear() {
        this.entries.clear();
    }
}
exports.ProxyResponseCache = ProxyResponseCache;
//# sourceMappingURL=memory.js.map