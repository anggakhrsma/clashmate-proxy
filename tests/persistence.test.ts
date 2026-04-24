import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { initializePersistence } from '../src/persistence/database.ts';
import { createTempDirectory } from './helpers.ts';

test('sqlite persistence survives restart with account and key state intact', (t) => {
  const testDirectory = createTempDirectory();
  const databasePath = join(testDirectory, 'restart.sqlite');

  const initial = initializePersistence({
    sqlitePath: databasePath,
    developerAccounts: [
      {
        slot: 1,
        email: 'one@example.com',
        password: 'password-one',
      },
    ],
  });

  initial.persistence.updateDeveloperAccountStatus({
    slot: 1,
    isEnabled: false,
  });
  initial.persistence.saveApiKey({
    accountSlot: 1,
    portalKeyId: 100,
    keyName: 'clashmate-proxy-slot-1',
    keyValue: 'persisted-managed-key',
    cidrRanges: ['203.0.113.10/32'],
    isManaged: true,
    isActive: true,
    isHealthy: true,
  });
  initial.persistence.setAppState('validation.last', 'done');
  initial.persistence.close();

  const restarted = initializePersistence({
    sqlitePath: databasePath,
    developerAccounts: [
      {
        slot: 1,
        email: 'one@example.com',
        password: 'password-one',
      },
    ],
  });

  t.after(() => {
    restarted.persistence.close();
    rmSync(testDirectory, {
      force: true,
      recursive: true,
    });
  });

  const restartedAccount = restarted.persistence.getDeveloperAccountBySlot(1);
  const restartedKey = restarted.persistence.getApiKeyByValue(
    'persisted-managed-key',
  );
  const restartedState = restarted.persistence.getAppState('validation.last');

  assert.equal(restartedAccount?.isEnabled, false);
  assert.equal(restartedKey?.portalKeyId, 100);
  assert.equal(restartedState?.value, 'done');
});
