import { buildApp } from './app.js';
import { type AppEnv, loadEnv } from './config/env.js';
import { createKeyManager } from './key-manager/service.js';
import { initializePersistence } from './persistence/database.js';

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

function initializeValidatedPersistence(env: AppEnv) {
  try {
    return initializePersistence({
      sqlitePath: env.sqlitePath,
      developerAccounts: env.cocDeveloperAccounts,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown persistence error';
    console.error(
      `[clashmate-proxy] Failed to initialize persistence: ${message}`,
    );
    process.exit(1);
  }
}

const env = loadValidatedEnv();
const { persistence, bootstrap } = initializeValidatedPersistence(env);

persistence.setAppState(
  'service.bootstrap.last_started_at',
  new Date().toISOString(),
);
persistence.recordLifecycleEvent({
  eventType: 'service.bootstrap',
  message: 'Persistence bootstrap completed.',
  metadata: {
    databasePath: bootstrap.databasePath,
    appliedMigrations: bootstrap.appliedMigrations,
    syncedAccounts: bootstrap.syncedAccounts,
  },
});

const keyManager = createKeyManager({
  env,
  persistence,
  logger: console,
});
const app = buildApp({
  env,
  keyManager,
  logger: {
    level: env.logLevel,
  },
});

async function shutdown(signal: NodeJS.Signals) {
  app.log.info({ signal }, 'shutting down clashmate-proxy');

  try {
    await keyManager.stop();
    await app.close();
    persistence.close();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error, signal }, 'graceful shutdown failed');
    process.exit(1);
  }
}

async function start() {
  try {
    await keyManager.start();

    await app.listen({
      host: env.host,
      port: env.port,
    });

    app.log.info(
      {
        host: env.host,
        port: env.port,
        nodeEnv: env.nodeEnv,
        sqlitePath: bootstrap.databasePath,
        configuredAccounts: env.cocDeveloperAccounts.length,
        managedKeyCidrs: env.managedKeyAllowedCidrs,
        syncedAccounts: bootstrap.syncedAccounts,
        appliedMigrations: bootstrap.appliedMigrations,
      },
      'clashmate-proxy started',
    );
  } catch (error) {
    persistence.close();
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
