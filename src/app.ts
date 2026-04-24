import Fastify, { type FastifyServerOptions } from 'fastify';

export function buildApp(options: FastifyServerOptions = {}) {
  const app = Fastify({
    logger: options.logger ?? true,
    ...options,
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

  return app;
}
