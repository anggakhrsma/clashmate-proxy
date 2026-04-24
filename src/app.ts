import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
  type HTTPMethods,
} from 'fastify';

import type { AppEnv } from './config/env.js';
import type { ClashApiKeyManager } from './key-manager/service.js';
import { ClashApiProxyService } from './proxy/service.js';

type BuildAppInput = {
  env: Pick<AppEnv, 'upstreamBaseUrl' | 'upstreamTimeoutMs'>;
  keyManager: Pick<ClashApiKeyManager, 'acquireKey' | 'markKeyHealthy'>;
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

function sendProxyResponse(
  reply: FastifyReply,
  response: Awaited<ReturnType<ClashApiProxyService['forwardRequest']>>,
): FastifyReply {
  reply.code(response.status);

  for (const [name, value] of Object.entries(response.headers)) {
    reply.header(name, value);
  }

  if (response.body === null) {
    return reply.send();
  }

  return reply.send(response.body);
}

async function registerProxyRoutes(
  app: FastifyInstance,
  input: BuildAppInput,
): Promise<void> {
  const proxyService = new ClashApiProxyService({
    upstreamBaseUrl: input.env.upstreamBaseUrl,
    upstreamTimeoutMs: input.env.upstreamTimeoutMs,
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
        error instanceof Error &&
        error.message ===
          'No healthy managed Clash of Clans API keys are available.'
          ? 503
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

export function buildApp(input: BuildAppInput) {
  const { env, keyManager, ...fastifyOptions } = input;
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
    });
  });

  return app;
}
