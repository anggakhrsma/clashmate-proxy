import { buildApp } from './app.js';
import { type AppEnv, loadEnv } from './config/env.js';

function loadValidatedEnv(): AppEnv {
  try {
    return loadEnv();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown configuration error';
    console.error(`[clashmate-proxy] ${message}`);
    process.exit(1);
  }
}

const env = loadValidatedEnv();
const app = buildApp({
  logger: {
    level: env.logLevel,
  },
});

async function shutdown(signal: NodeJS.Signals) {
  app.log.info({ signal }, 'shutting down clashmate-proxy');

  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error, signal }, 'graceful shutdown failed');
    process.exit(1);
  }
}

async function start() {
  try {
    await app.listen({
      host: env.host,
      port: env.port,
    });

    app.log.info(
      {
        host: env.host,
        port: env.port,
        nodeEnv: env.nodeEnv,
        sqlitePath: env.sqlitePath,
        configuredAccounts: env.cocDeveloperAccounts.length,
      },
      'clashmate-proxy started',
    );
  } catch (error) {
    app.log.error({ err: error }, 'failed to start clashmate-proxy');
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

void start();
