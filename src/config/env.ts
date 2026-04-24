import dotenv from 'dotenv';

dotenv.config();

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_NODE_ENV = 'development';
const DEFAULT_LOG_LEVEL = 'info';
const DEFAULT_CACHE_TTL_SECONDS = 10;
const DEFAULT_VALIDATION_SWEEP_INTERVAL_MINUTES = 15;
const DEFAULT_UPSTREAM_BASE_URL = 'https://api.clashofclans.com/v1';
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10000;
const MAX_COC_ACCOUNTS = 10;

const allowedNodeEnvironments = ['development', 'test', 'production'] as const;
const allowedLogLevels = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;

type NodeEnvironment = (typeof allowedNodeEnvironments)[number];
type LogLevel = (typeof allowedLogLevels)[number];

export type CocDeveloperAccount = {
  slot: number;
  email: string;
  password: string;
};

export type AppEnv = {
  host: string;
  port: number;
  nodeEnv: NodeEnvironment;
  logLevel: LogLevel;
  clientApiSecret: string;
  adminApiSecret: string;
  sqlitePath: string;
  cacheTtlSeconds: number;
  validationSweepIntervalMinutes: number;
  upstreamBaseUrl: string;
  upstreamTimeoutMs: number;
  cocDeveloperAccounts: CocDeveloperAccount[];
};

function readEnvValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function parsePort(value: string | undefined, errors: string[]): number {
  if (!value) {
    return DEFAULT_PORT;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    errors.push(
      `PORT must be an integer between 1 and 65535. Received: ${value}`,
    );
    return DEFAULT_PORT;
  }

  return parsed;
}

function parsePositiveInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  errors: string[],
): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    errors.push(`${name} must be a positive integer. Received: ${value}`);
    return fallback;
  }

  return parsed;
}

function parseRequiredString(name: string, errors: string[]): string {
  const value = readEnvValue(name);

  if (!value) {
    errors.push(`${name} is required.`);
    return '';
  }

  return value;
}

function parseEnumValue<T extends readonly string[]>(
  name: string,
  value: string | undefined,
  allowedValues: T,
  fallback: T[number],
  errors: string[],
): T[number] {
  if (!value) {
    return fallback;
  }

  if (allowedValues.includes(value)) {
    return value as T[number];
  }

  errors.push(
    `${name} must be one of: ${allowedValues.join(', ')}. Received: ${value}`,
  );
  return fallback;
}

function parseUrl(
  name: string,
  value: string | undefined,
  fallback: string,
  errors: string[],
): string {
  const nextValue = value ?? fallback;

  try {
    const url = new URL(nextValue);
    return url.toString().replace(/\/$/, '');
  } catch {
    errors.push(`${name} must be a valid URL. Received: ${nextValue}`);
    return fallback;
  }
}

function parseCocDeveloperAccounts(errors: string[]): CocDeveloperAccount[] {
  const accounts: CocDeveloperAccount[] = [];
  const seenEmails = new Set<string>();

  for (let slot = 1; slot <= MAX_COC_ACCOUNTS; slot += 1) {
    const email = readEnvValue(`COC_ACCOUNT_${slot}_EMAIL`);
    const password = readEnvValue(`COC_ACCOUNT_${slot}_PASSWORD`);

    if (!email && !password) {
      continue;
    }

    if (!email || !password) {
      errors.push(
        `COC_ACCOUNT_${slot}_EMAIL and COC_ACCOUNT_${slot}_PASSWORD must both be provided together.`,
      );
      continue;
    }

    if (!email.includes('@')) {
      errors.push(
        `COC_ACCOUNT_${slot}_EMAIL must be a valid email address. Received: ${email}`,
      );
      continue;
    }

    if (seenEmails.has(email)) {
      errors.push(`Duplicate Clash of Clans developer account email: ${email}`);
      continue;
    }

    seenEmails.add(email);
    accounts.push({
      slot,
      email,
      password,
    });
  }

  if (accounts.length === 0) {
    errors.push('At least one Clash of Clans developer account is required.');
  }

  return accounts;
}

export function loadEnv(): AppEnv {
  const errors: string[] = [];

  const host = readEnvValue('HOST') ?? DEFAULT_HOST;
  const port = parsePort(readEnvValue('PORT'), errors);
  const nodeEnv = parseEnumValue(
    'NODE_ENV',
    readEnvValue('NODE_ENV'),
    allowedNodeEnvironments,
    DEFAULT_NODE_ENV,
    errors,
  );
  const logLevel = parseEnumValue(
    'LOG_LEVEL',
    readEnvValue('LOG_LEVEL'),
    allowedLogLevels,
    DEFAULT_LOG_LEVEL,
    errors,
  );
  const clientApiSecret = parseRequiredString('CLIENT_API_SECRET', errors);
  const adminApiSecret = parseRequiredString('ADMIN_API_SECRET', errors);
  const sqlitePath = parseRequiredString('SQLITE_PATH', errors);
  const cacheTtlSeconds = parsePositiveInteger(
    'CACHE_TTL_SECONDS',
    readEnvValue('CACHE_TTL_SECONDS'),
    DEFAULT_CACHE_TTL_SECONDS,
    errors,
  );
  const validationSweepIntervalMinutes = parsePositiveInteger(
    'VALIDATION_SWEEP_INTERVAL_MINUTES',
    readEnvValue('VALIDATION_SWEEP_INTERVAL_MINUTES'),
    DEFAULT_VALIDATION_SWEEP_INTERVAL_MINUTES,
    errors,
  );
  const upstreamBaseUrl = parseUrl(
    'UPSTREAM_BASE_URL',
    readEnvValue('UPSTREAM_BASE_URL'),
    DEFAULT_UPSTREAM_BASE_URL,
    errors,
  );
  const upstreamTimeoutMs = parsePositiveInteger(
    'UPSTREAM_TIMEOUT_MS',
    readEnvValue('UPSTREAM_TIMEOUT_MS'),
    DEFAULT_UPSTREAM_TIMEOUT_MS,
    errors,
  );
  const cocDeveloperAccounts = parseCocDeveloperAccounts(errors);

  if (clientApiSecret && adminApiSecret && clientApiSecret === adminApiSecret) {
    errors.push(
      'CLIENT_API_SECRET and ADMIN_API_SECRET must be different values.',
    );
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n- ${errors.join('\n- ')}`,
    );
  }

  return {
    host,
    port,
    nodeEnv,
    logLevel,
    clientApiSecret,
    adminApiSecret,
    sqlitePath,
    cacheTtlSeconds,
    validationSweepIntervalMinutes,
    upstreamBaseUrl,
    upstreamTimeoutMs,
    cocDeveloperAccounts,
  };
}
