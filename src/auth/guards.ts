import { timingSafeEqual } from 'node:crypto';

import type {
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from 'fastify';

type AuthScope = 'admin' | 'client';

type AuthLogger = {
  warn: (...args: unknown[]) => void;
};

const DEFAULT_LOGGER: AuthLogger = {
  warn: () => {},
};

const SCOPE_HEADER_NAMES: Record<AuthScope, string[]> = {
  client: ['x-clashmate-client-secret', 'x-client-secret'],
  admin: ['x-clashmate-admin-secret', 'x-admin-secret'],
};

function bindWarnLogger(logger: Partial<AuthLogger> | undefined) {
  if (typeof logger?.warn !== 'function') {
    return DEFAULT_LOGGER.warn;
  }

  return logger.warn.bind(logger);
}

function getHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0]?.trim() || null;
  }

  return value?.trim() || null;
}

function extractBearerToken(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1]?.trim() || null;
}

function secretsMatch(expected: string, provided: string | null): boolean {
  if (!provided) {
    return false;
  }

  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);

  return (
    expectedBuffer.length === providedBuffer.length &&
    timingSafeEqual(expectedBuffer, providedBuffer)
  );
}

function extractScopedSecret(
  request: FastifyRequest,
  scope: AuthScope,
): { source: string; value: string } | null {
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

function buildUnauthorizedPayload(scope: AuthScope) {
  return {
    statusCode: 401,
    error: 'Unauthorized',
    message: `Invalid or missing ${scope} credentials.`,
  };
}

async function sendUnauthorized(
  reply: FastifyReply,
  scope: AuthScope,
): Promise<FastifyReply> {
  reply.header('www-authenticate', `Bearer realm="clashmate-proxy-${scope}"`);
  return reply.code(401).send(buildUnauthorizedPayload(scope));
}

export function createSecretAuthHook(input: {
  scope: AuthScope;
  secret: string;
  logger?: Partial<AuthLogger>;
}): onRequestHookHandler {
  const logWarn = bindWarnLogger(input.logger);

  return async (request: FastifyRequest, reply: FastifyReply) => {
    const providedSecret = extractScopedSecret(request, input.scope);

    if (secretsMatch(input.secret, providedSecret?.value ?? null)) {
      return;
    }

    logWarn(
      {
        scope: input.scope,
        method: request.method,
        url: request.url,
        remoteAddress: request.ip,
        providedSecretSource: providedSecret?.source ?? null,
        hasAuthorizationHeader:
          typeof request.headers.authorization === 'string',
      },
      'request authentication failed',
    );

    return sendUnauthorized(reply, input.scope);
  };
}
