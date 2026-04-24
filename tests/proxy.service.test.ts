import assert from 'node:assert/strict';
import test from 'node:test';

import { ClashApiProxyService } from '../src/proxy/service.ts';

test('proxy forwards representative routes, retries, and caches GET responses', async () => {
  const acquiredKeys: string[] = [];
  const healthyKeys: string[] = [];
  const reportedFailures: Array<Record<string, unknown>> = [];
  const fetchCalls: Array<Record<string, unknown>> = [];
  const leases = [
    {
      apiKeyId: 1,
      portalKeyId: 101,
      accountId: 1,
      accountSlot: 1,
      accountEmail: 'one@example.com',
      keyName: 'managed-one',
      keyValue: 'managed-key-one',
      cidrRanges: ['203.0.113.10/32'],
      selectedAt: new Date().toISOString(),
    },
    {
      apiKeyId: 2,
      portalKeyId: 202,
      accountId: 2,
      accountSlot: 2,
      accountEmail: 'two@example.com',
      keyName: 'managed-two',
      keyValue: 'managed-key-two',
      cidrRanges: ['203.0.113.10/32'],
      selectedAt: new Date().toISOString(),
    },
  ];

  const proxyService = new ClashApiProxyService({
    cacheTtlSeconds: 10,
    upstreamBaseUrl: 'https://api.clashofclans.com/v1',
    upstreamTimeoutMs: 1_000,
    upstreamMaxRetries: 1,
    keyManager: {
      acquireKey: async () => {
        const nextLease = leases.shift();

        if (!nextLease) {
          throw new Error('No more test leases available.');
        }

        acquiredKeys.push(nextLease.keyValue);
        return nextLease;
      },
      markKeyHealthy: async (keyValue) => {
        healthyKeys.push(keyValue);
        return null;
      },
      reportUpstreamFailure: async (input) => {
        reportedFailures.push(input);
        return {
          handled: true,
          markedAccountUnhealthy: true,
          markedKeyUnhealthy: true,
          scheduledRegeneration: true,
          scheduledValidationSweep: false,
        };
      },
    },
    fetchImplementation: async (input, init) => {
      fetchCalls.push({
        url: input.toString(),
        method: init?.method ?? 'GET',
        authorization: new Headers(init?.headers).get('authorization'),
        clientSecret: new Headers(init?.headers).get(
          'x-clashmate-client-secret',
        ),
      });

      if (fetchCalls.length === 1) {
        return new Response(JSON.stringify({ message: 'invalid key' }), {
          status: 403,
          headers: {
            'content-type': 'application/json',
          },
        });
      }

      return new Response(JSON.stringify({ items: ['ok'] }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-upstream-test': 'yes',
        },
      });
    },
  });

  const firstResponse = await proxyService.forwardRequest({
    method: 'GET',
    rawUrl: '/v1/clans/%23TEST/warlog?limit=10',
    headers: {
      host: 'proxy.example.com',
      'x-clashmate-client-secret': 'proxy-secret',
      'x-forwarded-proto': 'https',
    },
    body: undefined,
    remoteAddress: '198.51.100.10',
  });

  assert.equal(firstResponse.status, 200);
  assert.equal(
    firstResponse.upstreamUrl,
    'https://api.clashofclans.com/v1/clans/%23TEST/warlog?limit=10',
  );
  assert.equal(firstResponse.keyLease?.accountSlot, 2);
  assert.equal(firstResponse.cacheStatus, 'MISS');
  assert.deepEqual(JSON.parse(firstResponse.body?.toString('utf8') ?? '{}'), {
    items: ['ok'],
  });
  assert.equal(fetchCalls.length, 2);
  assert.deepEqual(acquiredKeys, ['managed-key-one', 'managed-key-two']);
  assert.equal(fetchCalls[0]?.authorization, 'Bearer managed-key-one');
  assert.equal(fetchCalls[0]?.clientSecret, null);
  assert.equal(fetchCalls[1]?.authorization, 'Bearer managed-key-two');
  assert.equal(reportedFailures.length, 1);
  assert.equal(reportedFailures[0]?.category, 'INVALID_KEY');
  assert.deepEqual(healthyKeys, ['managed-key-two']);

  const cachedResponse = await proxyService.forwardRequest({
    method: 'GET',
    rawUrl: '/v1/clans/%23TEST/warlog?limit=10',
    headers: {
      host: 'proxy.example.com',
      'x-clashmate-client-secret': 'proxy-secret',
    },
    body: undefined,
    remoteAddress: '198.51.100.10',
  });

  assert.equal(cachedResponse.status, 200);
  assert.equal(cachedResponse.cacheStatus, 'HIT');
  assert.equal(cachedResponse.keyLease, null);
  assert.equal(fetchCalls.length, 2);
});
