import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  ClashApiKeyManager,
  type ValidationSweepSummary,
} from '../src/key-manager/service.ts';
import { initializePersistence } from '../src/persistence/database.ts';
import { createTempDirectory, waitFor } from './helpers.ts';

type FakePortalKey = {
  id: number;
  name: string;
  description: string;
  key: string;
  cidrRanges: string[];
  scopes: string[];
};

class FakePortalService {
  readonly createdKeys: FakePortalKey[] = [];
  readonly revokedKeyIds: number[] = [];

  constructor(
    private readonly accounts = new Map<
      string,
      {
        keys: FakePortalKey[];
        nextId: number;
      }
    >(),
  ) {}

  async listKeysForAccount(credentials: { email: string }) {
    const account = this.getAccount(credentials.email);
    return structuredClone(account.keys);
  }

  async createKeyForAccount(
    credentials: { email: string; slot: number },
    input: {
      cidrRanges: string[];
      description?: string;
      name?: string;
      scopes?: string[] | null;
    },
  ) {
    const account = this.getAccount(credentials.email);
    const createdKey: FakePortalKey = {
      id: account.nextId,
      name: input.name ?? `managed-${credentials.slot}-${account.nextId}`,
      description: input.description ?? 'Managed by tests',
      key: `generated-key-${credentials.slot}-${account.nextId}`,
      cidrRanges: [...input.cidrRanges],
      scopes: [...(input.scopes ?? [])],
    };

    account.nextId += 1;
    account.keys.push(createdKey);
    this.createdKeys.push(createdKey);
    return structuredClone(createdKey);
  }

  async revokeKeyForAccount(credentials: { email: string }, keyId: number) {
    const account = this.getAccount(credentials.email);
    account.keys = account.keys.filter((key) => key.id !== keyId);
    this.revokedKeyIds.push(keyId);
  }

  private getAccount(email: string) {
    const account = this.accounts.get(email);

    if (!account) {
      throw new Error(`Missing fake portal state for ${email}.`);
    }

    return account;
  }
}

function createTestKeyManager(
  testDatabasePath: string,
  fakePortalService: FakePortalService,
) {
  const { persistence } = initializePersistence({
    sqlitePath: testDatabasePath,
    developerAccounts: [
      {
        slot: 1,
        email: 'one@example.com',
        password: 'password-one',
      },
      {
        slot: 2,
        email: 'two@example.com',
        password: 'password-two',
      },
    ],
  });

  const keyManager = new ClashApiKeyManager({
    env: {
      validationSweepIntervalMinutes: 15,
      keyUnhealthyCooldownSeconds: 60,
      accountUnhealthyCooldownSeconds: 60,
      managedKeyAllowedCidrs: ['203.0.113.10/32'],
      managedKeyNamePrefix: 'clashmate-proxy',
      managedKeyDescription: 'Managed by clashmate-proxy',
      managedKeyScopes: null,
      cocDeveloperAccounts: [
        {
          slot: 1,
          email: 'one@example.com',
          password: 'password-one',
        },
        {
          slot: 2,
          email: 'two@example.com',
          password: 'password-two',
        },
      ],
    },
    persistence,
    portalService: fakePortalService as never,
    logger: {
      debug: () => {},
      error: () => {},
      info: () => {},
      warn: () => {},
    },
  });

  return {
    keyManager,
    persistence,
  };
}

test('key manager rotates healthy keys and skips unhealthy ones', async (t) => {
  const testDirectory = createTempDirectory();
  const fakePortalService = new FakePortalService(
    new Map([
      [
        'one@example.com',
        {
          nextId: 2,
          keys: [
            {
              id: 1,
              name: 'clashmate-proxy-slot-1',
              description: 'Managed by clashmate-proxy',
              key: 'managed-key-1',
              cidrRanges: ['203.0.113.10/32'],
              scopes: [],
            },
          ],
        },
      ],
      [
        'two@example.com',
        {
          nextId: 2,
          keys: [
            {
              id: 1,
              name: 'clashmate-proxy-slot-2',
              description: 'Managed by clashmate-proxy',
              key: 'managed-key-2',
              cidrRanges: ['203.0.113.10/32'],
              scopes: [],
            },
          ],
        },
      ],
    ]),
  );
  const { keyManager, persistence } = createTestKeyManager(
    join(testDirectory, 'rotation.sqlite'),
    fakePortalService,
  );

  t.after(async () => {
    await keyManager.stop();
    persistence.close();
    rmSync(testDirectory, {
      force: true,
      recursive: true,
    });
  });

  await keyManager.start();

  const firstLease = await keyManager.acquireKey();
  const secondLease = await keyManager.acquireKey();

  assert.equal(firstLease.accountSlot, 1);
  assert.equal(secondLease.accountSlot, 2);

  const failureResult = await keyManager.reportUpstreamFailure({
    keyValue: firstLease.keyValue,
    category: 'UNKNOWN',
    message: 'timeout',
  });

  assert.equal(failureResult.markedKeyUnhealthy, true);
  assert.equal(failureResult.scheduledValidationSweep, false);

  const nextLease = await keyManager.acquireKey();
  assert.equal(nextLease.accountSlot, 2);

  const statusSnapshot = await keyManager.getStatusSnapshot();
  assert.equal(statusSnapshot.eligibleKeyCount, 1);
});

test('key manager regenerates a replacement key after invalid key failures', async (t) => {
  const testDirectory = createTempDirectory();
  const fakePortalService = new FakePortalService(
    new Map([
      [
        'one@example.com',
        {
          nextId: 2,
          keys: [
            {
              id: 1,
              name: 'clashmate-proxy-slot-1',
              description: 'Managed by clashmate-proxy',
              key: 'managed-key-1',
              cidrRanges: ['203.0.113.10/32'],
              scopes: [],
            },
          ],
        },
      ],
      ['two@example.com', { nextId: 1, keys: [] }],
    ]),
  );
  const { keyManager, persistence } = createTestKeyManager(
    join(testDirectory, 'regeneration.sqlite'),
    fakePortalService,
  );

  t.after(async () => {
    await keyManager.stop();
    persistence.close();
    rmSync(testDirectory, {
      force: true,
      recursive: true,
    });
  });

  const validationSummaries: ValidationSweepSummary[] = [];

  await keyManager.start();
  validationSummaries.push(await keyManager.forceRefreshAllKeys());

  const initialLease = await keyManager.acquireKey();
  assert.equal(initialLease.keyValue, 'managed-key-1');

  const failureResult = await keyManager.reportUpstreamFailure({
    keyValue: initialLease.keyValue,
    category: 'INVALID_KEY',
    message: 'invalid key',
  });

  assert.equal(failureResult.scheduledRegeneration, true);

  await waitFor(
    async () => {
      const snapshot = await keyManager.getStatusSnapshot();
      return snapshot.accounts
        .flatMap((account) => account.managedKeys)
        .some((managedKey) => managedKey.keyValue === 'generated-key-1-2');
    },
    {
      message: 'Expected regenerated key to be persisted.',
    },
  );

  const statusSnapshot = await keyManager.getStatusSnapshot();
  const slotOneKeys = statusSnapshot.accounts
    .find((account) => account.slot === 1)
    ?.managedKeys.map((managedKey) => ({
      keyValue: managedKey.keyValue,
      isActive: managedKey.isActive,
      isHealthy: managedKey.isHealthy,
    }));

  assert.deepEqual(fakePortalService.revokedKeyIds, [1]);
  assert.ok(
    fakePortalService.createdKeys.some(
      (createdKey) => createdKey.key === 'generated-key-1-2',
    ),
  );
  assert.ok(
    slotOneKeys?.some(
      (managedKey) =>
        managedKey.keyValue === 'managed-key-1' &&
        managedKey.isActive === false &&
        managedKey.isHealthy === false,
    ),
  );
  assert.ok(
    slotOneKeys?.some(
      (managedKey) =>
        managedKey.keyValue === 'generated-key-1-2' &&
        managedKey.isActive === true &&
        managedKey.isHealthy === true,
    ),
  );
  assert.ok(
    validationSummaries.every((summary) => summary.accountsChecked >= 1),
  );
});
