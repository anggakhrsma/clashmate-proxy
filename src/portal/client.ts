import type { CocDeveloperAccount } from '../config/env.js';

const DEFAULT_PORTAL_BASE_URL = 'https://developer.clashofclans.com/api';
const DEFAULT_PORTAL_TIMEOUT_MS = 10000;
const DEFAULT_KEY_DESCRIPTION = 'Managed by clashmate-proxy';
const DEFAULT_SESSION_TTL_MS = 10 * 60 * 1000;

type FetchLike = typeof fetch;

type LoginResponsePayload = {
  swaggerUrl?: string;
  temporaryAPIToken?: string;
};

type PortalListKeysResponse = {
  keys?: unknown[];
};

type PortalCreateKeyResponse = {
  key?: unknown;
};

export type DeveloperPortalErrorCode =
  | 'AUTHENTICATION_FAILED'
  | 'SESSION_INVALID'
  | 'RATE_LIMITED'
  | 'NETWORK_ERROR'
  | 'INVALID_RESPONSE'
  | 'KEY_LIMIT_REACHED'
  | 'KEY_NOT_FOUND'
  | 'PORTAL_ERROR';

export type DeveloperPortalSession = {
  accountSlot: number;
  accountEmail: string;
  cookie: string;
  swaggerUrl: string;
  temporaryApiToken: string;
  createdAt: string;
  expiresAt: string;
};

export type DeveloperPortalAccountCredentials = Pick<
  CocDeveloperAccount,
  'slot' | 'email' | 'password'
>;

export type DeveloperPortalKey = {
  id: number;
  name: string;
  description: string;
  key: string;
  cidrRanges: string[];
  scopes: string[];
};

export type CreateDeveloperPortalKeyInput = {
  cidrRanges: string[];
  name?: string;
  description?: string;
  scopes?: string[] | null;
};

export type RegenerateDeveloperPortalKeyInput =
  CreateDeveloperPortalKeyInput & {
    revokeKeyId?: number;
  };

export class DeveloperPortalError extends Error {
  readonly code: DeveloperPortalErrorCode;
  readonly operation: string;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly details: unknown;

  constructor(input: {
    code: DeveloperPortalErrorCode;
    message: string;
    operation: string;
    status?: number | null;
    retryable?: boolean;
    details?: unknown;
    cause?: unknown;
  }) {
    super(input.message, input.cause ? { cause: input.cause } : undefined);
    this.name = 'DeveloperPortalError';
    this.code = input.code;
    this.operation = input.operation;
    this.status = input.status ?? null;
    this.retryable = input.retryable ?? false;
    this.details = input.details ?? null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getErrorMessage(payload: unknown): string | null {
  if (typeof payload === 'string' && payload.trim().length > 0) {
    return payload;
  }

  if (!isObject(payload)) {
    return null;
  }

  const candidates = ['message', 'reason', 'error'];

  for (const candidate of candidates) {
    const value = payload[candidate];

    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }

  return null;
}

function getErrorCode(
  operation: string,
  status: number | null,
  payload: unknown,
): DeveloperPortalErrorCode {
  const message = getErrorMessage(payload)?.toLowerCase() ?? '';

  if (status === 401 || status === 403) {
    return operation === 'login' ? 'AUTHENTICATION_FAILED' : 'SESSION_INVALID';
  }

  if (status === 429) {
    return 'RATE_LIMITED';
  }

  if (message.includes('invalid credentials')) {
    return 'AUTHENTICATION_FAILED';
  }

  if (message.includes('login') || message.includes('session')) {
    return 'SESSION_INVALID';
  }

  if (message.includes('limit') || message.includes('maximum')) {
    return 'KEY_LIMIT_REACHED';
  }

  if (message.includes('not found')) {
    return 'KEY_NOT_FOUND';
  }

  return 'PORTAL_ERROR';
}

function isRetryableStatus(status: number | null): boolean {
  return status === 429 || (status !== null && status >= 500);
}

async function parseJsonSafe(response: Response): Promise<unknown> {
  const text = await response.text();

  if (text.length === 0) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function normalizePortalKey(payload: unknown): DeveloperPortalKey {
  if (!isObject(payload)) {
    throw new DeveloperPortalError({
      code: 'INVALID_RESPONSE',
      message: 'Developer portal returned an invalid API key payload.',
      operation: 'normalizePortalKey',
      details: payload,
    });
  }

  const id = payload.id;
  const name = payload.name;
  const description = payload.description;
  const key = payload.key;

  if (
    typeof id !== 'number' ||
    typeof name !== 'string' ||
    typeof description !== 'string' ||
    typeof key !== 'string'
  ) {
    throw new DeveloperPortalError({
      code: 'INVALID_RESPONSE',
      message: 'Developer portal API key payload is missing required fields.',
      operation: 'normalizePortalKey',
      details: payload,
    });
  }

  return {
    id,
    name,
    description,
    key,
    cidrRanges: normalizeStringArray(payload.cidrRanges),
    scopes: normalizeStringArray(payload.scopes),
  };
}

function toPortalError(input: {
  operation: string;
  status?: number | null;
  payload?: unknown;
  cause?: unknown;
}): DeveloperPortalError {
  const status = input.status ?? null;
  const code = getErrorCode(input.operation, status, input.payload);
  const message =
    getErrorMessage(input.payload) ??
    (status
      ? `Developer portal ${input.operation} request failed with status ${status}.`
      : `Developer portal ${input.operation} request failed.`);

  return new DeveloperPortalError({
    code,
    message,
    operation: input.operation,
    status,
    retryable: input.cause ? true : isRetryableStatus(status),
    details: input.payload,
    cause: input.cause,
  });
}

function buildManagedCookie(input: {
  response: Response;
  swaggerUrl: string;
  temporaryApiToken: string;
}): string {
  const headers = input.response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const setCookieValues =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [input.response.headers.get('set-cookie')].filter(
          (value): value is string => typeof value === 'string',
        );

  if (setCookieValues.length === 0) {
    throw new DeveloperPortalError({
      code: 'INVALID_RESPONSE',
      message:
        'Developer portal login response did not include a session cookie.',
      operation: 'login',
      details: {
        swaggerUrl: input.swaggerUrl,
      },
    });
  }

  const cookieParts = setCookieValues.map((value) => value.split(';', 1)[0]);
  cookieParts.push(`game-api-url=${input.swaggerUrl}`);
  cookieParts.push(`game-api-token=${input.temporaryApiToken}`);
  return cookieParts.join('; ');
}

export class ClashDeveloperPortalClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: FetchLike;

  constructor(
    options: {
      baseUrl?: string;
      timeoutMs?: number;
      fetchImplementation?: FetchLike;
    } = {},
  ) {
    this.baseUrl = options.baseUrl ?? DEFAULT_PORTAL_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PORTAL_TIMEOUT_MS;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async login(
    credentials: DeveloperPortalAccountCredentials,
  ): Promise<DeveloperPortalSession> {
    const createdAt = new Date();

    const response = await this.request<LoginResponsePayload>({
      operation: 'login',
      path: '/login',
      body: {
        email: credentials.email,
        password: credentials.password,
      },
    });

    if (
      typeof response.payload.swaggerUrl !== 'string' ||
      typeof response.payload.temporaryAPIToken !== 'string'
    ) {
      throw new DeveloperPortalError({
        code: 'INVALID_RESPONSE',
        message: 'Developer portal login response is missing session details.',
        operation: 'login',
        details: response.payload,
      });
    }

    return {
      accountSlot: credentials.slot,
      accountEmail: credentials.email,
      cookie: buildManagedCookie({
        response: response.rawResponse,
        swaggerUrl: response.payload.swaggerUrl,
        temporaryApiToken: response.payload.temporaryAPIToken,
      }),
      swaggerUrl: response.payload.swaggerUrl,
      temporaryApiToken: response.payload.temporaryAPIToken,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(
        createdAt.getTime() + DEFAULT_SESSION_TTL_MS,
      ).toISOString(),
    };
  }

  async listKeys(
    session: DeveloperPortalSession,
  ): Promise<DeveloperPortalKey[]> {
    const response = await this.request<PortalListKeysResponse>({
      operation: 'listKeys',
      path: '/apikey/list',
      session,
      body: {},
    });

    if (!Array.isArray(response.payload.keys)) {
      throw new DeveloperPortalError({
        code: 'INVALID_RESPONSE',
        message:
          'Developer portal list keys response is missing the keys array.',
        operation: 'listKeys',
        details: response.payload,
      });
    }

    return response.payload.keys.map((key) => normalizePortalKey(key));
  }

  async createKey(
    session: DeveloperPortalSession,
    input: CreateDeveloperPortalKeyInput,
  ): Promise<DeveloperPortalKey> {
    if (input.cidrRanges.length === 0) {
      throw new DeveloperPortalError({
        code: 'INVALID_RESPONSE',
        message:
          'At least one CIDR range is required to create a developer portal key.',
        operation: 'createKey',
        details: input,
      });
    }

    const response = await this.request<PortalCreateKeyResponse>({
      operation: 'createKey',
      path: '/apikey/create',
      session,
      body: {
        name: input.name ?? `clashmate-proxy-${new Date().toISOString()}`,
        description: input.description ?? DEFAULT_KEY_DESCRIPTION,
        cidrRanges: input.cidrRanges,
        scopes: input.scopes ?? null,
      },
    });

    return normalizePortalKey(response.payload.key);
  }

  async revokeKey(
    session: DeveloperPortalSession,
    keyId: number,
  ): Promise<void> {
    await this.request({
      operation: 'revokeKey',
      path: '/apikey/revoke',
      session,
      body: {
        id: keyId,
      },
    });
  }

  async regenerateKey(
    session: DeveloperPortalSession,
    input: RegenerateDeveloperPortalKeyInput,
  ): Promise<DeveloperPortalKey> {
    if (typeof input.revokeKeyId === 'number') {
      await this.revokeKey(session, input.revokeKeyId);
    }

    return this.createKey(session, input);
  }

  private async request<TPayload>(input: {
    operation: string;
    path: string;
    body: Record<string, unknown>;
    session?: DeveloperPortalSession;
  }): Promise<{ payload: TPayload; rawResponse: Response }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetchImplementation(
        `${this.baseUrl}${input.path}`,
        {
          method: 'POST',
          headers: {
            accept: 'application/json, text/plain, */*',
            'content-type': 'application/json',
            origin: this.baseUrl.replace(/\/api$/, ''),
            referer: `${this.baseUrl.replace(/\/api$/, '')}/`,
            'x-requested-with': 'XMLHttpRequest',
            ...(input.session ? { cookie: input.session.cookie } : {}),
          },
          body: JSON.stringify(input.body),
          signal: controller.signal,
        },
      );

      const payload = await parseJsonSafe(response);

      if (!response.ok) {
        throw toPortalError({
          operation: input.operation,
          status: response.status,
          payload,
        });
      }

      return {
        payload: payload as TPayload,
        rawResponse: response,
      };
    } catch (error) {
      if (error instanceof DeveloperPortalError) {
        throw error;
      }

      throw new DeveloperPortalError({
        code: 'NETWORK_ERROR',
        message: `Developer portal ${input.operation} request failed due to a network error.`,
        operation: input.operation,
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

export class ClashDeveloperPortalService {
  private readonly sessionCache = new Map<string, DeveloperPortalSession>();
  private readonly sessionTtlMs: number;

  constructor(
    private readonly client = new ClashDeveloperPortalClient(),
    options: {
      sessionTtlMs?: number;
    } = {},
  ) {
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  }

  invalidateSession(accountEmail: string): void {
    this.sessionCache.delete(accountEmail);
  }

  clearSessions(): void {
    this.sessionCache.clear();
  }

  getCachedSession(accountEmail: string): DeveloperPortalSession | null {
    const session = this.sessionCache.get(accountEmail);

    if (!session) {
      return null;
    }

    if (Date.parse(session.expiresAt) <= Date.now()) {
      this.sessionCache.delete(accountEmail);
      return null;
    }

    return session;
  }

  async loginAccount(
    credentials: DeveloperPortalAccountCredentials,
  ): Promise<DeveloperPortalSession> {
    const cachedSession = this.getCachedSession(credentials.email);

    if (cachedSession) {
      return cachedSession;
    }

    const session = await this.client.login(credentials);
    session.expiresAt = new Date(Date.now() + this.sessionTtlMs).toISOString();
    this.sessionCache.set(credentials.email, session);
    return session;
  }

  async listKeysForAccount(
    credentials: DeveloperPortalAccountCredentials,
  ): Promise<DeveloperPortalKey[]> {
    return this.withSession(credentials, (session) =>
      this.client.listKeys(session),
    );
  }

  async createKeyForAccount(
    credentials: DeveloperPortalAccountCredentials,
    input: CreateDeveloperPortalKeyInput,
  ): Promise<DeveloperPortalKey> {
    return this.withSession(credentials, (session) =>
      this.client.createKey(session, input),
    );
  }

  async revokeKeyForAccount(
    credentials: DeveloperPortalAccountCredentials,
    keyId: number,
  ): Promise<void> {
    await this.withSession(credentials, async (session) => {
      await this.client.revokeKey(session, keyId);
      return undefined;
    });
  }

  async regenerateKeyForAccount(
    credentials: DeveloperPortalAccountCredentials,
    input: RegenerateDeveloperPortalKeyInput,
  ): Promise<DeveloperPortalKey> {
    return this.withSession(credentials, (session) =>
      this.client.regenerateKey(session, input),
    );
  }

  private async withSession<TResult>(
    credentials: DeveloperPortalAccountCredentials,
    operation: (session: DeveloperPortalSession) => Promise<TResult>,
  ): Promise<TResult> {
    try {
      const session = await this.loginAccount(credentials);
      return await operation(session);
    } catch (error) {
      if (
        error instanceof DeveloperPortalError &&
        error.code === 'SESSION_INVALID'
      ) {
        this.invalidateSession(credentials.email);
        const session = await this.loginAccount(credentials);
        return operation(session);
      }

      throw error;
    }
  }
}
