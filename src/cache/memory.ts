type CachedProxyResponse = {
  status: number;
  headers: Record<string, string>;
  body: Buffer | null;
  upstreamUrl: string;
  cachedAt: string;
  expiresAt: string;
};

function cloneBody(body: Buffer | null): Buffer | null {
  return body ? Buffer.from(body) : null;
}

function cloneResponse(response: CachedProxyResponse): CachedProxyResponse {
  return {
    status: response.status,
    headers: { ...response.headers },
    body: cloneBody(response.body),
    upstreamUrl: response.upstreamUrl,
    cachedAt: response.cachedAt,
    expiresAt: response.expiresAt,
  };
}

export class ProxyResponseCache {
  private readonly entries = new Map<string, CachedProxyResponse>();

  constructor(private readonly ttlMs: number) {}

  get(key: string): CachedProxyResponse | null {
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

  set(
    key: string,
    response: Omit<CachedProxyResponse, 'cachedAt' | 'expiresAt'>,
  ): CachedProxyResponse {
    const cachedAt = new Date().toISOString();
    const entry: CachedProxyResponse = {
      ...response,
      body: cloneBody(response.body),
      headers: { ...response.headers },
      cachedAt,
      expiresAt: new Date(Date.now() + this.ttlMs).toISOString(),
    };

    this.entries.set(key, entry);
    return cloneResponse(entry);
  }

  clear(): void {
    this.entries.clear();
  }
}
