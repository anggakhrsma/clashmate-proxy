type CachedProxyResponse = {
    status: number;
    headers: Record<string, string>;
    body: Buffer | null;
    upstreamUrl: string;
    cachedAt: string;
    expiresAt: string;
};
export declare class ProxyResponseCache {
    private readonly ttlMs;
    private readonly entries;
    constructor(ttlMs: number);
    get(key: string): CachedProxyResponse | null;
    set(key: string, response: Omit<CachedProxyResponse, 'cachedAt' | 'expiresAt'>): CachedProxyResponse;
    clear(): void;
}
export {};
