import { buildApp } from './app.js';
import { type AppEnv, loadEnv } from './config/env.js';
import { createKeyManager } from './key-manager/service.js';
import { initializePersistence } from './persistence/database.js';

const OUTBOUND_IP_LOOKUP_URLS = [
  'https://api.ipify.org',
  'https://ifconfig.me/ip',
  'https://icanhazip.com',
] as const;

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

function isPublicIpv4(value: string): boolean {
  const parts = value.trim().split('.');

  if (parts.length !== 4) {
    return false;
  }

  const octets = parts.map((part) => Number.parseInt(part, 10));

  if (
    octets.some(
      (octet, index) =>
        !Number.isInteger(octet) ||
        octet < 0 ||
        octet > 255 ||
        parts[index] !== String(octet),
    )
  ) {
    return false;
  }

  const [first, second] = octets as [number, number, number, number];

  return !(
    first === 10 ||
    first === 127 ||
    first === 0 ||
    first === 169 && second === 254 ||
    first === 172 && second >= 16 && second <= 31 ||
    first === 192 && second === 168 ||
    first >= 224
  );
}

async function detectOutboundIpv4(): Promise<string> {
  for (const url of OUTBOUND_IP_LOOKUP_URLS) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        continue;
      }

      const ip = (await response.text()).trim();

      if (isPublicIpv4(ip)) {
        return ip;
      }
    } catch {
      // Try the next lookup service.
    }
  }

  throw new Error(
    'Unable to auto-detect a public outbound IPv4 address. Set COC_MANAGED_KEY_ALLOWED_CIDRS manually, for example 203.0.113.10/32.',
  );
}

async function resolveManagedKeyAllowedCidrs(env: AppEnv): Promise<AppEnv> {
  if (env.managedKeyAllowedCidrs.length > 0) {
    return env;
  }

  const outboundIp = await detectOutboundIpv4();
  const cidr = outboundIp;
  console.info(
    `[clashmate-proxy] COC_MANAGED_KEY_ALLOWED_CIDRS not set; using detected outbound IP ${cidr}`,
  );

  return {
    ...env,
    managedKeyAllowedCidrs: [cidr],
  };
}

async function main() {
  let env = loadValidatedEnv();
  env = await resolveManagedKeyAllowedCidrs(env).catch((error) => {
    const message =
      error instanceof Error
        ? error.message
        : 'Unknown outbound IP lookup error';
    console.error(`[clashmate-proxy] ${message}`);
    process.exit(1);
  });
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
    persistence,
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

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

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

void main();
