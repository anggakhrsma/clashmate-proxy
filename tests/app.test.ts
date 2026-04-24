import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApp } from '../src/app.ts';

function createTestApp(options: { ready: boolean }) {
  return buildApp({
    env: {
      adminApiSecret: 'admin-secret',
      cacheTtlSeconds: 10,
      clientApiSecret: 'client-secret',
      nodeEnv: 'test',
      upstreamBaseUrl: 'https://api.clashofclans.com/v1',
      upstreamTimeoutMs: 1_000,
      upstreamMaxRetries: 1,
    },
    keyManager: {
      acquireKey: async () => {
        throw new Error('acquireKey should not be called in auth tests');
      },
      forceRefreshAllKeys: async () => ({
        reason: 'manual',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        accountsChecked: 1,
        accountsRecovered: 0,
        accountsFailed: 0,
        keysValidated: 1,
        keysCreated: 0,
        keysInvalidated: 0,
      }),
      getStatusSnapshot: async () => ({
        eligibleKeyCount: options.ready ? 1 : 0,
        lastRotationCursor: 1,
        lastValidationCompletedAt: options.ready
          ? new Date().toISOString()
          : null,
        accounts: [
          {
            id: 1,
            slot: 1,
            email: 'one@example.com',
            isEnabled: true,
            isHealthy: options.ready,
            lastLoginAt: null,
            unhealthyUntil: null,
            lastError: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            healthyManagedKeyCount: options.ready ? 1 : 0,
            eligibleManagedKeyCount: options.ready ? 1 : 0,
            managedKeys: [
              {
                id: 1,
                developerAccountId: 1,
                portalKeyId: 101,
                keyName: 'managed-one',
                keyValue: 'managed-key-1234567890',
                cidrRanges: ['203.0.113.10/32'],
                isManaged: true,
                isActive: true,
                isHealthy: options.ready,
                invalidReason: null,
                lastUsedAt: null,
                lastValidatedAt: null,
                lastSeenAt: null,
                unhealthyUntil: null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
          },
        ],
      }),
      markKeyHealthy: async () => null,
      reportUpstreamFailure: async () => ({
        handled: true,
        markedAccountUnhealthy: true,
        markedKeyUnhealthy: true,
        scheduledRegeneration: false,
        scheduledValidationSweep: true,
      }),
      setAccountEnabled: async () => ({
        id: 1,
        slot: 1,
        email: 'one@example.com',
        isEnabled: true,
        isHealthy: true,
        lastLoginAt: null,
        unhealthyUntil: null,
        lastError: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    },
    persistence: {
      listAppState: () => [],
      listLifecycleEvents: () => [],
    },
    logger: false,
  });
}

test('app exposes health and ready endpoints and protects admin/proxy routes', async (t) => {
  const app = createTestApp({ ready: true });

  t.after(async () => {
    await app.close();
  });

  const healthResponse = await app.inject({
    method: 'GET',
    url: '/health',
  });
  assert.equal(healthResponse.statusCode, 200);

  const readinessResponse = await app.inject({
    method: 'GET',
    url: '/ready',
  });
  assert.equal(readinessResponse.statusCode, 200);
  assert.equal(readinessResponse.json().status, 'ready');

  const unauthorizedAdminResponse = await app.inject({
    method: 'GET',
    url: '/admin/status',
  });
  assert.equal(unauthorizedAdminResponse.statusCode, 401);

  const authorizedAdminResponse = await app.inject({
    method: 'GET',
    url: '/admin/status',
    headers: {
      'x-clashmate-admin-secret': 'admin-secret',
    },
  });
  assert.equal(authorizedAdminResponse.statusCode, 200);
  assert.match(authorizedAdminResponse.body, /"keyValueMasked":"manage…7890"/);

  const unauthorizedProxyResponse = await app.inject({
    method: 'GET',
    url: '/v1/clans/%23TEST',
  });
  assert.equal(unauthorizedProxyResponse.statusCode, 401);

  const refreshResponse = await app.inject({
    method: 'POST',
    url: '/admin/refresh',
    headers: {
      'x-clashmate-admin-secret': 'admin-secret',
    },
  });
  assert.equal(refreshResponse.statusCode, 202);
});

test('app reports not-ready state when no healthy eligible keys exist', async (t) => {
  const app = createTestApp({ ready: false });

  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: 'GET',
    url: '/ready',
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().status, 'not_ready');
});
