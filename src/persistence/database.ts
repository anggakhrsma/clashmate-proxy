import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { CocDeveloperAccount } from '../config/env.js';

const initialSchemaMigration = {
  name: '001_initial_schema',
  sql: `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      executed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS developer_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slot INTEGER NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
      is_healthy INTEGER NOT NULL DEFAULT 1 CHECK (is_healthy IN (0, 1)),
      last_login_at TEXT,
      unhealthy_until TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      developer_account_id INTEGER NOT NULL REFERENCES developer_accounts(id) ON DELETE CASCADE,
      key_name TEXT,
      key_value TEXT NOT NULL UNIQUE,
      cidr_ranges_json TEXT,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      is_healthy INTEGER NOT NULL DEFAULT 1 CHECK (is_healthy IN (0, 1)),
      invalid_reason TEXT,
      last_used_at TEXT,
      last_validated_at TEXT,
      unhealthy_until TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_api_keys_account_id
      ON api_keys (developer_account_id);

    CREATE INDEX IF NOT EXISTS idx_api_keys_active_health
      ON api_keys (is_active, is_healthy);

    CREATE TABLE IF NOT EXISTS lifecycle_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      developer_account_id INTEGER REFERENCES developer_accounts(id) ON DELETE SET NULL,
      api_key_id INTEGER REFERENCES api_keys(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL,
      message TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_lifecycle_events_created_at
      ON lifecycle_events (created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_lifecycle_events_event_type
      ON lifecycle_events (event_type);

    CREATE TABLE IF NOT EXISTS app_state (
      state_key TEXT PRIMARY KEY,
      state_value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `,
};

const apiKeysMetadataMigration = {
  name: '002_api_keys_metadata',
  sql: `
    ALTER TABLE api_keys ADD COLUMN portal_key_id INTEGER;
    ALTER TABLE api_keys ADD COLUMN is_managed INTEGER NOT NULL DEFAULT 1 CHECK (is_managed IN (0, 1));
    ALTER TABLE api_keys ADD COLUMN last_seen_at TEXT;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_account_portal_key_id
      ON api_keys (developer_account_id, portal_key_id)
      WHERE portal_key_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_api_keys_managed_active_health
      ON api_keys (is_managed, is_active, is_healthy);
  `,
};

const migrations = [initialSchemaMigration, apiKeysMetadataMigration] as const;

type BooleanInteger = 0 | 1;

type DeveloperAccountRow = {
  id: number;
  slot: number;
  email: string;
  is_enabled: BooleanInteger;
  is_healthy: BooleanInteger;
  last_login_at: string | null;
  unhealthy_until: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type ApiKeyRow = {
  id: number;
  developer_account_id: number;
  portal_key_id: string | number | null;
  key_name: string | null;
  key_value: string;
  cidr_ranges_json: string | null;
  is_managed: BooleanInteger;
  is_active: BooleanInteger;
  is_healthy: BooleanInteger;
  invalid_reason: string | null;
  last_used_at: string | null;
  last_validated_at: string | null;
  last_seen_at: string | null;
  unhealthy_until: string | null;
  created_at: string;
  updated_at: string;
};

type AppStateRow = {
  state_key: string;
  state_value: string;
  updated_at: string;
};

type LifecycleEventRow = {
  id: number;
  developer_account_id: number | null;
  api_key_id: number | null;
  event_type: string;
  message: string | null;
  metadata_json: string | null;
  created_at: string;
};

export type DeveloperAccountRecord = {
  id: number;
  slot: number;
  email: string;
  isEnabled: boolean;
  isHealthy: boolean;
  lastLoginAt: string | null;
  unhealthyUntil: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ApiKeyRecord = {
  id: number;
  developerAccountId: number;
  portalKeyId: string | number | null;
  keyName: string | null;
  keyValue: string;
  cidrRanges: string[];
  isManaged: boolean;
  isActive: boolean;
  isHealthy: boolean;
  invalidReason: string | null;
  lastUsedAt: string | null;
  lastValidatedAt: string | null;
  lastSeenAt: string | null;
  unhealthyUntil: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LifecycleEventRecord = {
  id: number;
  developerAccountId: number | null;
  apiKeyId: number | null;
  eventType: string;
  message: string | null;
  metadataJson: string | null;
  createdAt: string;
};

export type AppStateRecord = {
  key: string;
  value: string;
  updatedAt: string;
};

export type PersistenceBootstrapResult = {
  databasePath: string;
  appliedMigrations: string[];
  syncedAccounts: number;
};

export type SaveApiKeyInput = {
  accountSlot: number;
  portalKeyId?: string | number | null;
  keyName?: string | null;
  keyValue: string;
  cidrRanges?: string[];
  isManaged?: boolean;
  isActive?: boolean;
  isHealthy?: boolean;
  invalidReason?: string | null;
  lastUsedAt?: string | null;
  lastValidatedAt?: string | null;
  lastSeenAt?: string | null;
  unhealthyUntil?: string | null;
};

export type UpdateDeveloperAccountStatusInput = {
  slot: number;
  isEnabled?: boolean;
  isHealthy?: boolean;
  lastLoginAt?: string | null;
  unhealthyUntil?: string | null;
  lastError?: string | null;
};

export type UpdateApiKeyStatusInput = {
  keyValue: string;
  portalKeyId?: string | number | null;
  keyName?: string | null;
  cidrRanges?: string[];
  isManaged?: boolean;
  isActive?: boolean;
  isHealthy?: boolean;
  invalidReason?: string | null;
  lastUsedAt?: string | null;
  lastValidatedAt?: string | null;
  lastSeenAt?: string | null;
  unhealthyUntil?: string | null;
};

export type RecordLifecycleEventInput = {
  eventType: string;
  message?: string;
  accountSlot?: number;
  apiKeyId?: number;
  metadata?: Record<string, unknown>;
};

function timestamp(): string {
  return new Date().toISOString();
}

function toBoolean(value: BooleanInteger): boolean {
  return value === 1;
}

function toBooleanInteger(value: boolean): BooleanInteger {
  return value ? 1 : 0;
}

function hasOwnKey<TObject extends object, TKey extends keyof TObject>(
  object: TObject,
  key: TKey,
): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function parseJsonArray(value: string | null): string[] {
  if (!value) {
    return [];
  }

  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function mapDeveloperAccountRow(
  row: DeveloperAccountRow,
): DeveloperAccountRecord {
  return {
    id: row.id,
    slot: row.slot,
    email: row.email,
    isEnabled: toBoolean(row.is_enabled),
    isHealthy: toBoolean(row.is_healthy),
    lastLoginAt: row.last_login_at,
    unhealthyUntil: row.unhealthy_until,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapApiKeyRow(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    developerAccountId: row.developer_account_id,
    portalKeyId: row.portal_key_id,
    keyName: row.key_name,
    keyValue: row.key_value,
    cidrRanges: parseJsonArray(row.cidr_ranges_json),
    isManaged: toBoolean(row.is_managed),
    isActive: toBoolean(row.is_active),
    isHealthy: toBoolean(row.is_healthy),
    invalidReason: row.invalid_reason,
    lastUsedAt: row.last_used_at,
    lastValidatedAt: row.last_validated_at,
    lastSeenAt: row.last_seen_at,
    unhealthyUntil: row.unhealthy_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function resolveDatabasePath(sqlitePath: string): string {
  const resolvedPath = resolve(sqlitePath);
  mkdirSync(dirname(resolvedPath), { recursive: true });
  return resolvedPath;
}

function applyMigrations(database: DatabaseSync): string[] {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      executed_at TEXT NOT NULL
    );
  `);

  const appliedMigrations: string[] = [];
  const getMigration = database.prepare(
    'SELECT name FROM schema_migrations WHERE name = :name',
  );
  const insertMigration = database.prepare(`
    INSERT INTO schema_migrations (name, executed_at)
    VALUES (:name, :executedAt)
  `);

  for (const migration of migrations) {
    const existing = getMigration.get({ name: migration.name }) as
      | { name: string }
      | undefined;

    if (existing) {
      continue;
    }

    database.exec('BEGIN');

    try {
      database.exec(migration.sql);
      insertMigration.run({
        name: migration.name,
        executedAt: timestamp(),
      });
      database.exec('COMMIT');
      appliedMigrations.push(migration.name);
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  return appliedMigrations;
}

export class SqlitePersistence {
  readonly databasePath: string;
  readonly appliedMigrations: string[];
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    this.databasePath = resolveDatabasePath(databasePath);
    this.database = new DatabaseSync(this.databasePath);
    this.appliedMigrations = applyMigrations(this.database);
  }

  close() {
    this.database.close();
  }

  syncConfiguredDeveloperAccounts(
    accounts: CocDeveloperAccount[],
  ): DeveloperAccountRecord[] {
    const now = timestamp();
    const upsertAccount = this.database.prepare(`
      INSERT INTO developer_accounts (
        slot,
        email,
        is_enabled,
        is_healthy,
        created_at,
        updated_at
      )
      VALUES (
        :slot,
        :email,
        1,
        1,
        :createdAt,
        :updatedAt
      )
      ON CONFLICT(slot) DO UPDATE SET
        email = excluded.email,
        updated_at = excluded.updated_at
    `);

    this.database.exec('BEGIN');

    try {
      for (const account of accounts) {
        upsertAccount.run({
          slot: account.slot,
          email: account.email,
          createdAt: now,
          updatedAt: now,
        });
      }

      const disabledAt = timestamp();
      const slotList = accounts.map((account) => account.slot);

      if (slotList.length > 0) {
        this.database.exec(`
          UPDATE developer_accounts
          SET is_enabled = 0,
              updated_at = '${disabledAt}'
          WHERE slot NOT IN (${slotList.join(', ')})
        `);
      }

      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }

    return this.listDeveloperAccounts();
  }

  listDeveloperAccounts(): DeveloperAccountRecord[] {
    const statement = this.database.prepare(`
      SELECT
        id,
        slot,
        email,
        is_enabled,
        is_healthy,
        last_login_at,
        unhealthy_until,
        last_error,
        created_at,
        updated_at
      FROM developer_accounts
      ORDER BY slot ASC
    `);

    return (statement.all() as DeveloperAccountRow[]).map(
      mapDeveloperAccountRow,
    );
  }

  updateDeveloperAccountStatus(
    input: UpdateDeveloperAccountStatusInput,
  ): DeveloperAccountRecord {
    const account = this.getDeveloperAccountBySlot(input.slot);

    if (!account) {
      throw new Error(`Developer account slot ${input.slot} does not exist.`);
    }

    const statement = this.database.prepare(`
      UPDATE developer_accounts
      SET is_enabled = :isEnabled,
          is_healthy = :isHealthy,
          last_login_at = :lastLoginAt,
          unhealthy_until = :unhealthyUntil,
          last_error = :lastError,
          updated_at = :updatedAt
      WHERE slot = :slot
    `);

    statement.run({
      slot: input.slot,
      isEnabled: toBooleanInteger(
        hasOwnKey(input, 'isEnabled')
          ? (input.isEnabled ?? account.isEnabled)
          : account.isEnabled,
      ),
      isHealthy: toBooleanInteger(
        hasOwnKey(input, 'isHealthy')
          ? (input.isHealthy ?? account.isHealthy)
          : account.isHealthy,
      ),
      lastLoginAt: hasOwnKey(input, 'lastLoginAt')
        ? (input.lastLoginAt ?? null)
        : account.lastLoginAt,
      unhealthyUntil: hasOwnKey(input, 'unhealthyUntil')
        ? (input.unhealthyUntil ?? null)
        : account.unhealthyUntil,
      lastError: hasOwnKey(input, 'lastError')
        ? (input.lastError ?? null)
        : account.lastError,
      updatedAt: timestamp(),
    });

    const updatedAccount = this.getDeveloperAccountBySlot(input.slot);

    if (!updatedAccount) {
      throw new Error(
        `Developer account slot ${input.slot} disappeared after update.`,
      );
    }

    return updatedAccount;
  }

  getDeveloperAccountBySlot(slot: number): DeveloperAccountRecord | null {
    const statement = this.database.prepare(`
      SELECT
        id,
        slot,
        email,
        is_enabled,
        is_healthy,
        last_login_at,
        unhealthy_until,
        last_error,
        created_at,
        updated_at
      FROM developer_accounts
      WHERE slot = :slot
      LIMIT 1
    `);

    const row = statement.get({ slot }) as DeveloperAccountRow | undefined;
    return row ? mapDeveloperAccountRow(row) : null;
  }

  saveApiKey(input: SaveApiKeyInput): ApiKeyRecord {
    const account = this.getDeveloperAccountBySlot(input.accountSlot);

    if (!account) {
      throw new Error(
        `Cannot save API key because developer account slot ${input.accountSlot} does not exist.`,
      );
    }

    const now = timestamp();
    const existingByPortalKeyId =
      input.portalKeyId !== undefined && input.portalKeyId !== null
        ? this.getApiKeyByAccountAndPortalKeyId(account.id, input.portalKeyId)
        : null;

    if (existingByPortalKeyId) {
      const updateStatement = this.database.prepare(`
        UPDATE api_keys
        SET key_name = :keyName,
            key_value = :keyValue,
            cidr_ranges_json = :cidrRangesJson,
            is_managed = :isManaged,
            is_active = :isActive,
            is_healthy = :isHealthy,
            invalid_reason = :invalidReason,
            last_used_at = :lastUsedAt,
            last_validated_at = :lastValidatedAt,
            last_seen_at = :lastSeenAt,
            unhealthy_until = :unhealthyUntil,
            updated_at = :updatedAt
        WHERE id = :id
      `);

      updateStatement.run({
        id: existingByPortalKeyId.id,
        keyName: input.keyName ?? null,
        keyValue: input.keyValue,
        cidrRangesJson: JSON.stringify(input.cidrRanges ?? []),
        isManaged: toBooleanInteger(input.isManaged ?? true),
        isActive: toBooleanInteger(input.isActive ?? true),
        isHealthy: toBooleanInteger(input.isHealthy ?? true),
        invalidReason: input.invalidReason ?? null,
        lastUsedAt: input.lastUsedAt ?? existingByPortalKeyId.lastUsedAt,
        lastValidatedAt: input.lastValidatedAt ?? null,
        lastSeenAt: input.lastSeenAt ?? null,
        unhealthyUntil: input.unhealthyUntil ?? null,
        updatedAt: now,
      });
    } else {
      const statement = this.database.prepare(`
        INSERT INTO api_keys (
          developer_account_id,
          portal_key_id,
          key_name,
          key_value,
          cidr_ranges_json,
          is_managed,
          is_active,
          is_healthy,
          invalid_reason,
          last_used_at,
          last_validated_at,
          last_seen_at,
          unhealthy_until,
          created_at,
          updated_at
        )
        VALUES (
          :developerAccountId,
          :portalKeyId,
          :keyName,
          :keyValue,
          :cidrRangesJson,
          :isManaged,
          :isActive,
          :isHealthy,
          :invalidReason,
          :lastUsedAt,
          :lastValidatedAt,
          :lastSeenAt,
          :unhealthyUntil,
          :createdAt,
          :updatedAt
        )
        ON CONFLICT(key_value) DO UPDATE SET
          developer_account_id = excluded.developer_account_id,
          portal_key_id = excluded.portal_key_id,
          key_name = excluded.key_name,
          cidr_ranges_json = excluded.cidr_ranges_json,
          is_managed = excluded.is_managed,
          is_active = excluded.is_active,
          is_healthy = excluded.is_healthy,
          invalid_reason = excluded.invalid_reason,
          last_used_at = excluded.last_used_at,
          last_validated_at = excluded.last_validated_at,
          last_seen_at = excluded.last_seen_at,
          unhealthy_until = excluded.unhealthy_until,
          updated_at = excluded.updated_at
      `);

      statement.run({
        developerAccountId: account.id,
        portalKeyId: input.portalKeyId ?? null,
        keyName: input.keyName ?? null,
        keyValue: input.keyValue,
        cidrRangesJson: JSON.stringify(input.cidrRanges ?? []),
        isManaged: toBooleanInteger(input.isManaged ?? true),
        isActive: toBooleanInteger(input.isActive ?? true),
        isHealthy: toBooleanInteger(input.isHealthy ?? true),
        invalidReason: input.invalidReason ?? null,
        lastUsedAt: input.lastUsedAt ?? null,
        lastValidatedAt: input.lastValidatedAt ?? null,
        lastSeenAt: input.lastSeenAt ?? null,
        unhealthyUntil: input.unhealthyUntil ?? null,
        createdAt: now,
        updatedAt: now,
      });
    }

    const savedKey = this.getApiKeyByValue(input.keyValue);

    if (!savedKey) {
      throw new Error(`API key ${input.keyValue} disappeared after save.`);
    }

    return savedKey;
  }

  getApiKeyByValue(keyValue: string): ApiKeyRecord | null {
    const statement = this.database.prepare(`
      SELECT
        id,
        developer_account_id,
        portal_key_id,
        key_name,
        key_value,
        cidr_ranges_json,
        is_managed,
        is_active,
        is_healthy,
        invalid_reason,
        last_used_at,
        last_validated_at,
        last_seen_at,
        unhealthy_until,
        created_at,
        updated_at
      FROM api_keys
      WHERE key_value = :keyValue
      LIMIT 1
    `);

    const row = statement.get({ keyValue }) as ApiKeyRow | undefined;
    return row ? mapApiKeyRow(row) : null;
  }

  getApiKeyByAccountAndPortalKeyId(
    developerAccountId: number,
    portalKeyId: string | number,
  ): ApiKeyRecord | null {
    const statement = this.database.prepare(`
      SELECT
        id,
        developer_account_id,
        portal_key_id,
        key_name,
        key_value,
        cidr_ranges_json,
        is_managed,
        is_active,
        is_healthy,
        invalid_reason,
        last_used_at,
        last_validated_at,
        last_seen_at,
        unhealthy_until,
        created_at,
        updated_at
      FROM api_keys
      WHERE developer_account_id = :developerAccountId
        AND portal_key_id = :portalKeyId
      LIMIT 1
    `);

    const row = statement.get({
      developerAccountId,
      portalKeyId,
    }) as ApiKeyRow | undefined;

    return row ? mapApiKeyRow(row) : null;
  }

  listApiKeys(): ApiKeyRecord[] {
    const statement = this.database.prepare(`
      SELECT
        id,
        developer_account_id,
        portal_key_id,
        key_name,
        key_value,
        cidr_ranges_json,
        is_managed,
        is_active,
        is_healthy,
        invalid_reason,
        last_used_at,
        last_validated_at,
        last_seen_at,
        unhealthy_until,
        created_at,
        updated_at
      FROM api_keys
      ORDER BY id ASC
    `);

    return (statement.all() as ApiKeyRow[]).map(mapApiKeyRow);
  }

  updateApiKeyStatus(input: UpdateApiKeyStatusInput): ApiKeyRecord {
    const apiKey = this.getApiKeyByValue(input.keyValue);

    if (!apiKey) {
      throw new Error(`API key ${input.keyValue} does not exist.`);
    }

    const statement = this.database.prepare(`
      UPDATE api_keys
      SET portal_key_id = :portalKeyId,
          key_name = :keyName,
          cidr_ranges_json = :cidrRangesJson,
          is_managed = :isManaged,
          is_active = :isActive,
          is_healthy = :isHealthy,
          invalid_reason = :invalidReason,
          last_used_at = :lastUsedAt,
          last_validated_at = :lastValidatedAt,
          last_seen_at = :lastSeenAt,
          unhealthy_until = :unhealthyUntil,
          updated_at = :updatedAt
      WHERE key_value = :keyValue
    `);

    statement.run({
      keyValue: input.keyValue,
      portalKeyId: hasOwnKey(input, 'portalKeyId')
        ? (input.portalKeyId ?? null)
        : apiKey.portalKeyId,
      keyName: hasOwnKey(input, 'keyName')
        ? (input.keyName ?? null)
        : apiKey.keyName,
      cidrRangesJson: JSON.stringify(
        hasOwnKey(input, 'cidrRanges')
          ? (input.cidrRanges ?? [])
          : apiKey.cidrRanges,
      ),
      isManaged: toBooleanInteger(
        hasOwnKey(input, 'isManaged')
          ? (input.isManaged ?? apiKey.isManaged)
          : apiKey.isManaged,
      ),
      isActive: toBooleanInteger(
        hasOwnKey(input, 'isActive')
          ? (input.isActive ?? apiKey.isActive)
          : apiKey.isActive,
      ),
      isHealthy: toBooleanInteger(
        hasOwnKey(input, 'isHealthy')
          ? (input.isHealthy ?? apiKey.isHealthy)
          : apiKey.isHealthy,
      ),
      invalidReason: hasOwnKey(input, 'invalidReason')
        ? (input.invalidReason ?? null)
        : apiKey.invalidReason,
      lastUsedAt: hasOwnKey(input, 'lastUsedAt')
        ? (input.lastUsedAt ?? null)
        : apiKey.lastUsedAt,
      lastValidatedAt: hasOwnKey(input, 'lastValidatedAt')
        ? (input.lastValidatedAt ?? null)
        : apiKey.lastValidatedAt,
      lastSeenAt: hasOwnKey(input, 'lastSeenAt')
        ? (input.lastSeenAt ?? null)
        : apiKey.lastSeenAt,
      unhealthyUntil: hasOwnKey(input, 'unhealthyUntil')
        ? (input.unhealthyUntil ?? null)
        : apiKey.unhealthyUntil,
      updatedAt: timestamp(),
    });

    const updatedKey = this.getApiKeyByValue(input.keyValue);

    if (!updatedKey) {
      throw new Error(`API key ${input.keyValue} disappeared after update.`);
    }

    return updatedKey;
  }

  recordLifecycleEvent(input: RecordLifecycleEventInput): LifecycleEventRecord {
    const account = input.accountSlot
      ? this.getDeveloperAccountBySlot(input.accountSlot)
      : null;
    const statement = this.database.prepare(`
      INSERT INTO lifecycle_events (
        developer_account_id,
        api_key_id,
        event_type,
        message,
        metadata_json,
        created_at
      )
      VALUES (
        :developerAccountId,
        :apiKeyId,
        :eventType,
        :message,
        :metadataJson,
        :createdAt
      )
      RETURNING
        id,
        developer_account_id,
        api_key_id,
        event_type,
        message,
        metadata_json,
        created_at
    `);

    const row = statement.get({
      developerAccountId: account?.id ?? null,
      apiKeyId: input.apiKeyId ?? null,
      eventType: input.eventType,
      message: input.message ?? null,
      metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
      createdAt: timestamp(),
    }) as {
      id: number;
      developer_account_id: number | null;
      api_key_id: number | null;
      event_type: string;
      message: string | null;
      metadata_json: string | null;
      created_at: string;
    };

    return {
      id: row.id,
      developerAccountId: row.developer_account_id,
      apiKeyId: row.api_key_id,
      eventType: row.event_type,
      message: row.message,
      metadataJson: row.metadata_json,
      createdAt: row.created_at,
    };
  }

  setAppState(key: string, value: string): void {
    const statement = this.database.prepare(`
      INSERT INTO app_state (state_key, state_value, updated_at)
      VALUES (:key, :value, :updatedAt)
      ON CONFLICT(state_key) DO UPDATE SET
        state_value = excluded.state_value,
        updated_at = excluded.updated_at
    `);

    statement.run({
      key,
      value,
      updatedAt: timestamp(),
    });
  }

  listLifecycleEvents(limit = 50): LifecycleEventRecord[] {
    const safeLimit = Math.max(1, Math.min(limit, 200));
    const statement = this.database.prepare(`
      SELECT
        id,
        developer_account_id,
        api_key_id,
        event_type,
        message,
        metadata_json,
        created_at
      FROM lifecycle_events
      ORDER BY created_at DESC, id DESC
      LIMIT :limit
    `);

    return (statement.all({ limit: safeLimit }) as LifecycleEventRow[]).map(
      (row) => ({
        id: row.id,
        developerAccountId: row.developer_account_id,
        apiKeyId: row.api_key_id,
        eventType: row.event_type,
        message: row.message,
        metadataJson: row.metadata_json,
        createdAt: row.created_at,
      }),
    );
  }

  listAppState(): AppStateRecord[] {
    const statement = this.database.prepare(`
      SELECT state_key, state_value, updated_at
      FROM app_state
      ORDER BY state_key ASC
    `);

    return (statement.all() as AppStateRow[]).map((row) => ({
      key: row.state_key,
      value: row.state_value,
      updatedAt: row.updated_at,
    }));
  }

  getAppState(key: string): AppStateRecord | null {
    const statement = this.database.prepare(`
      SELECT state_key, state_value, updated_at
      FROM app_state
      WHERE state_key = :key
      LIMIT 1
    `);

    const row = statement.get({ key }) as AppStateRow | undefined;

    if (!row) {
      return null;
    }

    return {
      key: row.state_key,
      value: row.state_value,
      updatedAt: row.updated_at,
    };
  }
}

export function initializePersistence(input: {
  sqlitePath: string;
  developerAccounts: CocDeveloperAccount[];
}): {
  persistence: SqlitePersistence;
  bootstrap: PersistenceBootstrapResult;
} {
  const persistence = new SqlitePersistence(input.sqlitePath);
  const syncedAccounts = persistence.syncConfiguredDeveloperAccounts(
    input.developerAccounts,
  ).length;

  return {
    persistence,
    bootstrap: {
      databasePath: persistence.databasePath,
      appliedMigrations: persistence.appliedMigrations,
      syncedAccounts,
    },
  };
}
