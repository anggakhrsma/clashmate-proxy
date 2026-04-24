import type { IncomingHttpHeaders } from 'node:http';

import { ProxyResponseCache } from '../cache/memory.js';
import type {
  ManagedApiKeyLease,
  ReportUpstreamFailureResult,
  UpstreamFailureCategory,
} from '../key-manager/service.js';

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
  keyLease: ManagedApiKeyLease | null;
  cacheStatus: 'BYPASS' | 'HIT' | 'MISS';
  cachedAt: string | null;
};

type RetryableUpstreamFailure = {
  category: UpstreamFailureCategory;
  statusCode: number | null;
  bodyText: string | null;
};

type UpstreamAttemptFailure = {
  category: UpstreamFailureCategory;
  statusCode: number | null;
  keyValue: string;
  accountSlot: number;
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

function shouldCacheRequest(method: string): boolean {
  return method === 'GET';
}

function shouldCacheResponseStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function normalizeRawUrl(rawUrl: string): string {
  return rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`;
}

function buildUpstreamUrl(upstreamBaseUrl: string, rawUrl: string): string {
  const normalizedRawUrl = normalizeRawUrl(rawUrl);
  const baseUrl = new URL(upstreamBaseUrl);
  const basePath = baseUrl.pathname.replace(/\/$/, '');
  const rawPathAndQuery = new URL(normalizedRawUrl, baseUrl.origin);
  const normalizedRawPath = rawPathAndQuery.pathname;
  const shouldUseRawPath =
    basePath.length === 0 ||
    normalizedRawPath === basePath ||
    normalizedRawPath.startsWith(`${basePath}/`);
  const upstreamPath = shouldUseRawPath
    ? normalizedRawPath
    : `${basePath}${normalizedRawPath}`;

  return new URL(
    `${upstreamPath}${rawPathAndQuery.search}`,
    baseUrl.origin,
  ).toString();
}

function buildCacheKey(method: string, rawUrl: string): string {
  return `${method.toUpperCase()}:${normalizeRawUrl(rawUrl)}`;
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

function extractBodyText(body: Buffer | null): string | null {
  if (!body || body.length === 0) {
    return null;
  }

  return body.toString('utf8');
}

function normalizeUpstreamErrorText(bodyText: string | null): string {
  return (bodyText ?? '').toLowerCase();
}

function classifyRetryableUpstreamFailure(input: {
  status: number;
  bodyText: string | null;
}): RetryableUpstreamFailure | null {
  const errorText = normalizeUpstreamErrorText(input.bodyText);

  if (input.status === 401) {
    return {
      category: 'AUTHENTICATION',
      statusCode: input.status,
      bodyText: input.bodyText,
    };
  }

  if (input.status === 403) {
    const category =
      errorText.includes('invalidip') ||
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

function maskKeyValue(value: string): string {
  if (value.length <= 10) {
    return value;
  }

  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown upstream error';
}

function getFailureStatusCode(failure: UpstreamAttemptFailure): number | null {
  return failure.statusCode;
}

export class ProxyUnavailableError extends Error {
  readonly statusCode = 503;
  readonly failures: UpstreamAttemptFailure[];

  constructor(message: string, failures: UpstreamAttemptFailure[]) {
    super(message);
    this.name = 'ProxyUnavailableError';
    this.failures = failures;
  }
}

export class ProxyTransportError extends Error {
  readonly statusCode = 502;

  constructor(message: string, cause?: unknown) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ProxyTransportError';
  }
}

export class ClashApiProxyService {
  private readonly logger: ProxyLogger;
  private readonly fetchImplementation: FetchLike;
  private readonly responseCache: ProxyResponseCache;

  constructor(
    private readonly input: {
      upstreamBaseUrl: string;
      upstreamTimeoutMs: number;
      upstreamMaxRetries: number;
      cacheTtlSeconds: number;
      keyManager: {
        acquireKey: () => Promise<ManagedApiKeyLease>;
        markKeyHealthy: (keyValue: string) => Promise<unknown>;
        reportUpstreamFailure: (input: {
          keyValue: string;
          category: UpstreamFailureCategory;
          statusCode?: number | null;
          message?: string | null;
          metadata?: Record<string, unknown>;
        }) => Promise<ReportUpstreamFailureResult>;
      };
      responseCache?: ProxyResponseCache;
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
    this.responseCache =
      input.responseCache ??
      new ProxyResponseCache(input.cacheTtlSeconds * 1000);
  }

  async forwardRequest(
    request: ForwardProxyRequestInput,
  ): Promise<ForwardProxyResponse> {
    const rawUrl = normalizeRawUrl(request.rawUrl);
    const upstreamUrl = buildUpstreamUrl(this.input.upstreamBaseUrl, rawUrl);
    const cacheKey = buildCacheKey(request.method, rawUrl);
    const failures: UpstreamAttemptFailure[] = [];
    const maximumAttempts = this.input.upstreamMaxRetries + 1;

    if (shouldCacheRequest(request.method)) {
      const cachedResponse = this.responseCache.get(cacheKey);

      if (cachedResponse) {
        this.logger.debug(
          {
            method: request.method,
            rawUrl,
            upstreamUrl: cachedResponse.upstreamUrl,
            cachedAt: cachedResponse.cachedAt,
          },
          'serving proxied response from GET cache',
        );

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
      let keyLease: ManagedApiKeyLease;

      try {
        keyLease = await this.input.keyManager.acquireKey();
      } catch (error) {
        if (failures.length > 0) {
          throw new ProxyUnavailableError(
            'No healthy upstream API keys are available after retry exhaustion.',
            failures,
          );
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
          ...(body ? { duplex: 'half' as const } : {}),
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

          const handledFailure =
            await this.input.keyManager.reportUpstreamFailure({
              keyValue: keyLease.keyValue,
              category: retryableFailure.category,
              statusCode: retryableFailure.statusCode,
              message: bodyText,
              metadata: {
                upstreamUrl,
                method: request.method,
              },
            });

          this.logger.warn(
            {
              attempt,
              maximumAttempts,
              method: request.method,
              upstreamUrl,
              upstreamStatus: response.status,
              failureCategory: retryableFailure.category,
              accountSlot: keyLease.accountSlot,
              apiKeyId: keyLease.apiKeyId,
              handledFailure,
            },
            'retryable upstream failure detected; rotating to the next key',
          );

          if (attempt >= maximumAttempts) {
            throw new ProxyUnavailableError(
              'No healthy upstream API keys are available after retry exhaustion.',
              failures,
            );
          }

          continue;
        }

        await this.input.keyManager.markKeyHealthy(keyLease.keyValue);

        const responseHeaders = readResponseHeaders(response.headers);
        const cacheStatus = shouldCacheRequest(request.method)
          ? 'MISS'
          : 'BYPASS';
        const cachedResponse =
          shouldCacheRequest(request.method) &&
          shouldCacheResponseStatus(response.status)
            ? this.responseCache.set(cacheKey, {
                status: response.status,
                headers: responseHeaders,
                body: responseBody,
                upstreamUrl,
              })
            : null;

        this.logger.debug(
          {
            attempt,
            method: request.method,
            upstreamUrl,
            upstreamStatus: response.status,
            accountSlot: keyLease.accountSlot,
            apiKeyId: keyLease.apiKeyId,
            cacheStatus,
          },
          'proxied request to Clash of Clans upstream',
        );

        return {
          status: response.status,
          headers: responseHeaders,
          body: responseBody,
          upstreamUrl,
          keyLease,
          cacheStatus,
          cachedAt: cachedResponse?.cachedAt ?? null,
        };
      } catch (error) {
        if (error instanceof ProxyUnavailableError) {
          throw error;
        }

        const category: UpstreamFailureCategory =
          error instanceof Error && error.name === 'AbortError'
            ? 'TIMEOUT'
            : 'NETWORK_ERROR';
        const statusCode = null;

        failures.push({
          category,
          statusCode,
          keyValue: keyLease.keyValue,
          accountSlot: keyLease.accountSlot,
        });

        const handledFailure =
          await this.input.keyManager.reportUpstreamFailure({
            keyValue: keyLease.keyValue,
            category,
            statusCode,
            message: toErrorMessage(error),
            metadata: {
              upstreamUrl,
              method: request.method,
            },
          });

        this.logger.warn(
          {
            attempt,
            maximumAttempts,
            method: request.method,
            upstreamUrl,
            failureCategory: category,
            accountSlot: keyLease.accountSlot,
            apiKeyId: keyLease.apiKeyId,
            handledFailure,
            err: error,
          },
          'upstream transport failure detected; rotating to the next key',
        );

        if (attempt >= maximumAttempts) {
          throw new ProxyUnavailableError(
            'No healthy upstream API keys are available after retry exhaustion.',
            failures,
          );
        }
      } finally {
        clearTimeout(timeoutHandle);
      }
    }

    throw new ProxyTransportError(
      'Failed to complete proxy request due to an unexpected retry state.',
    );
  }
}
