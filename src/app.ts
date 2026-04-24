import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
  type HTTPMethods,
} from 'fastify';

import { createSecretAuthHook } from './auth/guards.js';
import type { AppEnv } from './config/env.js';
import type { ClashApiKeyManager } from './key-manager/service.js';
import type { SqlitePersistence } from './persistence/database.js';
import {
  ClashApiProxyService,
  ProxyTransportError,
  ProxyUnavailableError,
} from './proxy/service.js';

type BuildAppInput = {
  env: Pick<
    AppEnv,
    | 'adminApiSecret'
    | 'cacheTtlSeconds'
    | 'clientApiSecret'
    | 'upstreamBaseUrl'
    | 'upstreamTimeoutMs'
    | 'upstreamMaxRetries'
  >;
  keyManager: Pick<
    ClashApiKeyManager,
    | 'acquireKey'
    | 'forceRefreshAllKeys'
    | 'getStatusSnapshot'
    | 'markKeyHealthy'
    | 'reportUpstreamFailure'
    | 'setAccountEnabled'
  >;
  persistence: Pick<SqlitePersistence, 'listAppState' | 'listLifecycleEvents'>;
} & FastifyServerOptions;

const PROXY_HTTP_METHODS = [
  'DELETE',
  'GET',
  'HEAD',
  'OPTIONS',
  'PATCH',
  'POST',
  'PUT',
] as const satisfies HTTPMethods[];

function getProxyBody(request: FastifyRequest): unknown {
  if (request.body === undefined) {
    return undefined;
  }

  return request.body;
}

function maskKeyValue(value: string): string {
  if (value.length <= 10) {
    return value;
  }

  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function parseJsonValue(value: string | null): unknown {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function sanitizeStatusSnapshot(
  snapshot: Awaited<ReturnType<ClashApiKeyManager['getStatusSnapshot']>>,
) {
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

function sendProxyResponse(
  reply: FastifyReply,
  response: Awaited<ReturnType<ClashApiProxyService['forwardRequest']>>,
): FastifyReply {
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

function parseAccountSlot(rawSlot: string): number | null {
  const slot = Number.parseInt(rawSlot, 10);
  return Number.isInteger(slot) && slot > 0 ? slot : null;
}

async function registerProxyRoutes(
  app: FastifyInstance,
  input: BuildAppInput,
): Promise<void> {
  app.addHook(
    'onRequest',
    createSecretAuthHook({
      scope: 'client',
      secret: input.env.clientApiSecret,
      logger: app.log,
    }),
  );

  const proxyService = new ClashApiProxyService({
    cacheTtlSeconds: input.env.cacheTtlSeconds,
    upstreamBaseUrl: input.env.upstreamBaseUrl,
    upstreamTimeoutMs: input.env.upstreamTimeoutMs,
    upstreamMaxRetries: input.env.upstreamMaxRetries,
    keyManager: input.keyManager,
    logger: app.log,
  });

  app.addContentTypeParser(
    '*',
    {
      parseAs: 'buffer',
    },
    (_request, body, done) => {
      done(null, body);
    },
  );

  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
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
    } catch (error) {
      request.log.error(
        {
          err: error,
          method: request.method,
          rawUrl,
        },
        'failed to proxy request to Clash of Clans upstream',
      );

      const statusCode =
        error instanceof ProxyUnavailableError ||
        (error instanceof Error &&
          error.message ===
            'No healthy managed Clash of Clans API keys are available.')
          ? 503
          : error instanceof ProxyTransportError
            ? error.statusCode
            : 502;

      return reply.code(statusCode).send({
        message:
          statusCode === 503
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

async function registerAdminRoutes(
  app: FastifyInstance,
  input: BuildAppInput,
): Promise<void> {
  app.addHook(
    'onRequest',
    createSecretAuthHook({
      scope: 'admin',
      secret: input.env.adminApiSecret,
      logger: app.log,
    }),
  );

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

  app.post<{
    Params: {
      slot: string;
    };
  }>('/admin/accounts/:slot/enable', async (request, reply) => {
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
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes(`Developer account slot ${slot} does not exist`)
      ) {
        return reply.code(404).send({
          statusCode: 404,
          message: `Developer account slot ${slot} was not found.`,
        });
      }

      throw error;
    }
  });

  app.post<{
    Params: {
      slot: string;
    };
  }>('/admin/accounts/:slot/disable', async (request, reply) => {
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
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes(`Developer account slot ${slot} does not exist`)
      ) {
        return reply.code(404).send({
          statusCode: 404,
          message: `Developer account slot ${slot} was not found.`,
        });
      }

      throw error;
    }
  });
}

export function buildApp(input: BuildAppInput) {
  const { env, keyManager, persistence, ...fastifyOptions } = input;
  const app = Fastify({
    logger: fastifyOptions.logger ?? true,
    ...fastifyOptions,
  });

  app.get('/', async () => {
    return {
      name: 'clashmate-proxy',
      status: 'ok',
    };
  });

  app.get('/health', async () => {
    return {
      status: 'ok',
    };
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
