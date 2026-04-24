import type { IncomingHttpHeaders } from 'node:http';

import type { ManagedApiKeyLease } from '../key-manager/service.js';

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
  keyLease: ManagedApiKeyLease;
};

const DEFAULT_LOGGER: ProxyLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const REQUEST_HEADERS_TO_SKIP = new Set([
  'authorization',
  'connection',
  'content-length',
  'host',
  'transfer-encoding',
]);

const RESPONSE_HEADERS_TO_SKIP = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'transfer-encoding',
]);

function bindLoggerMethod(
  logger: Partial<ProxyLogger> | undefined,
  method: keyof ProxyLogger,
): ProxyLogger[keyof ProxyLogger] {
  const candidate = logger?.[method];

  if (typeof candidate !== 'function') {
    return DEFAULT_LOGGER[method];
  }

  return candidate.bind(logger);
}

function shouldForwardRequestBody(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD';
}

function shouldReadResponseBody(method: string): boolean {
  return method !== 'HEAD';
}

function normalizeRawUrl(rawUrl: string): string {
  return rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`;
}

function buildForwardHeaders(input: {
  incomingHeaders: IncomingHttpHeaders;
  keyLease: ManagedApiKeyLease;
  remoteAddress?: string | null;
}): Headers {
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
  headers.set(
    'x-forwarded-proto',
    (input.incomingHeaders['x-forwarded-proto'] as string | undefined) ??
      'http',
  );

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

function buildForwardBody(input: {
  method: string;
  body: unknown;
  headers: Headers;
}): Buffer | Uint8Array | string | undefined {
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
    return new Uint8Array(
      input.body.buffer,
      input.body.byteOffset,
      input.body.byteLength,
    );
  }

  if (!input.headers.has('content-type')) {
    input.headers.set('content-type', 'application/json');
  }

  return JSON.stringify(input.body);
}

function readResponseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};

  headers.forEach((value, name) => {
    if (RESPONSE_HEADERS_TO_SKIP.has(name.toLowerCase())) {
      return;
    }

    result[name] = value;
  });

  return result;
}

export class ClashApiProxyService {
  private readonly logger: ProxyLogger;
  private readonly fetchImplementation: FetchLike;

  constructor(
    private readonly input: {
      upstreamBaseUrl: string;
      upstreamTimeoutMs: number;
      keyManager: {
        acquireKey: () => Promise<ManagedApiKeyLease>;
        markKeyHealthy: (keyValue: string) => Promise<unknown>;
      };
      fetchImplementation?: FetchLike;
      logger?: Partial<ProxyLogger>;
    },
  ) {
    this.logger = {
      debug: bindLoggerMethod(input.logger, 'debug') as ProxyLogger['debug'],
      info: bindLoggerMethod(input.logger, 'info') as ProxyLogger['info'],
      warn: bindLoggerMethod(input.logger, 'warn') as ProxyLogger['warn'],
      error: bindLoggerMethod(input.logger, 'error') as ProxyLogger['error'],
    };
    this.fetchImplementation = input.fetchImplementation ?? fetch;
  }

  async forwardRequest(
    request: ForwardProxyRequestInput,
  ): Promise<ForwardProxyResponse> {
    const rawUrl = normalizeRawUrl(request.rawUrl);
    const upstreamUrl = new URL(rawUrl, this.input.upstreamBaseUrl).toString();
    const keyLease = await this.input.keyManager.acquireKey();
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
        ...(body ? { duplex: 'half' as const } : {}),
      });
      const responseBody = shouldReadResponseBody(request.method)
        ? Buffer.from(await response.arrayBuffer())
        : null;

      await this.input.keyManager.markKeyHealthy(keyLease.keyValue);

      this.logger.debug(
        {
          method: request.method,
          upstreamUrl,
          upstreamStatus: response.status,
          accountSlot: keyLease.accountSlot,
          apiKeyId: keyLease.apiKeyId,
        },
        'proxied request to Clash of Clans upstream',
      );

      return {
        status: response.status,
        headers: readResponseHeaders(response.headers),
        body: responseBody,
        upstreamUrl,
        keyLease,
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
