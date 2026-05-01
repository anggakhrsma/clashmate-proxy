"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const app_js_1 = require("./app.js");
const env_js_1 = require("./config/env.js");
const service_js_1 = require("./key-manager/service.js");
const database_js_1 = require("./persistence/database.js");
function loadValidatedEnv() {
    try {
        return (0, env_js_1.loadEnv)();
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown configuration error';
        console.error(`[clashmate-proxy] ${message}`);
        process.exit(1);
    }
}
function initializeValidatedPersistence(env) {
    try {
        return (0, database_js_1.initializePersistence)({
            sqlitePath: env.sqlitePath,
            developerAccounts: env.cocDeveloperAccounts,
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown persistence error';
        console.error(`[clashmate-proxy] Failed to initialize persistence: ${message}`);
        process.exit(1);
    }
}
const env = loadValidatedEnv();
const { persistence, bootstrap } = initializeValidatedPersistence(env);
persistence.setAppState('service.bootstrap.last_started_at', new Date().toISOString());
persistence.recordLifecycleEvent({
    eventType: 'service.bootstrap',
    message: 'Persistence bootstrap completed.',
    metadata: {
        databasePath: bootstrap.databasePath,
        appliedMigrations: bootstrap.appliedMigrations,
        syncedAccounts: bootstrap.syncedAccounts,
    },
});
const keyManager = (0, service_js_1.createKeyManager)({
    env,
    persistence,
    logger: console,
});
const app = (0, app_js_1.buildApp)({
    env,
    keyManager,
    persistence,
    logger: {
        level: env.logLevel,
    },
});
async function shutdown(signal) {
    app.log.info({ signal }, 'shutting down clashmate-proxy');
    try {
        await keyManager.stop();
        await app.close();
        persistence.close();
        process.exit(0);
    }
    catch (error) {
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
        app.log.info({
            host: env.host,
            port: env.port,
            nodeEnv: env.nodeEnv,
            sqlitePath: bootstrap.databasePath,
            configuredAccounts: env.cocDeveloperAccounts.length,
            managedKeyCidrs: env.managedKeyAllowedCidrs,
            syncedAccounts: bootstrap.syncedAccounts,
            appliedMigrations: bootstrap.appliedMigrations,
        }, 'clashmate-proxy started');
    }
    catch (error) {
        persistence.close();
        app.log.error({ err: error }, 'failed to start clashmate-proxy');
        process.exit(1);
    }
}
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        void shutdown(signal);
    });
}
void start();
//# sourceMappingURL=index.js.map