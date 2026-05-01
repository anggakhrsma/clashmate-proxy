"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClashApiKeyManager = void 0;
exports.createKeyManager = createKeyManager;
const client_js_1 = require("../portal/client.js");
const DEFAULT_LOGGER = {
    info: () => { },
    warn: () => { },
    error: () => { },
    debug: () => { },
};
const ROTATION_CURSOR_STATE_KEY = 'key_manager.rotation.last_api_key_id';
const LAST_VALIDATION_COMPLETED_AT_STATE_KEY = 'key_manager.validation.last_completed_at';
const LAST_VALIDATION_STARTED_AT_STATE_KEY = 'key_manager.validation.last_started_at';
class SerialTaskQueue {
    queue = Promise.resolve();
    run(task) {
        const nextTask = this.queue.then(() => task());
        this.queue = nextTask.then(() => undefined, () => undefined);
        return nextTask;
    }
}
function timestamp() {
    return new Date().toISOString();
}
function addMilliseconds(value, ms) {
    return new Date(Date.parse(value) + ms).toISOString();
}
function isInCooldown(until) {
    return until !== null && Date.parse(until) > Date.now();
}
function parseStateNumber(value) {
    if (!value) {
        return null;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) ? parsed : null;
}
function maskKeyValue(value) {
    if (value.length <= 10) {
        return value;
    }
    return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
function toErrorMetadata(error) {
    if (error instanceof client_js_1.DeveloperPortalError) {
        return {
            name: error.name,
            code: error.code,
            operation: error.operation,
            status: error.status,
            retryable: error.retryable,
            message: error.message,
            detailsShape: describeDetailsShape(error.details),
        };
    }
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
        };
    }
    return {
        message: 'Unknown error',
    };
}
function describeDetailsShape(value) {
    if (Array.isArray(value)) {
        return value.map((entry) => describeDetailsShape(entry));
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
            key,
            Array.isArray(entry) ? 'array' : typeof entry,
        ]));
    }
    return typeof value;
}
function compareCandidates(left, right) {
    if (left.account.slot !== right.account.slot) {
        return left.account.slot - right.account.slot;
    }
    return left.key.id - right.key.id;
}
function mapUpstreamFailureCategoryToReason(category) {
    switch (category) {
        case 'AUTHENTICATION':
            return 'UPSTREAM_AUTH_FAILURE';
        case 'INVALID_IP':
            return 'UPSTREAM_INVALID_IP';
        case 'INVALID_KEY':
            return 'UPSTREAM_KEY_REVOKED';
        case 'NETWORK_ERROR':
            return 'UPSTREAM_NETWORK_ERROR';
        case 'RATE_LIMITED':
            return 'UPSTREAM_RATE_LIMITED';
        case 'SERVER_ERROR':
            return 'UPSTREAM_SERVER_ERROR';
        case 'TIMEOUT':
            return 'UPSTREAM_TIMEOUT';
        case 'UNKNOWN':
            return 'UNKNOWN_FAILURE';
    }
}
function shouldRegenerateForUpstreamFailure(category) {
    return (category === 'AUTHENTICATION' ||
        category === 'INVALID_IP' ||
        category === 'INVALID_KEY');
}
function shouldMarkAccountUnhealthyForUpstreamFailure(category) {
    return shouldRegenerateForUpstreamFailure(category);
}
function shouldScheduleValidationForUpstreamFailure(category) {
    return (category === 'NETWORK_ERROR' ||
        category === 'RATE_LIMITED' ||
        category === 'SERVER_ERROR' ||
        category === 'TIMEOUT');
}
function bindLoggerMethod(logger, method) {
    const candidate = logger?.[method];
    if (typeof candidate !== 'function') {
        return DEFAULT_LOGGER[method];
    }
    return candidate.bind(logger);
}
class ClashApiKeyManager {
    input;
    queue = new SerialTaskQueue();
    logger;
    credentialsBySlot = new Map();
    validationSweepIntervalMs;
    keyUnhealthyCooldownMs;
    accountUnhealthyCooldownMs;
    portalService;
    intervalHandle = null;
    constructor(input) {
        this.input = input;
        this.logger = {
            info: bindLoggerMethod(input.logger, 'info'),
            warn: bindLoggerMethod(input.logger, 'warn'),
            error: bindLoggerMethod(input.logger, 'error'),
            debug: bindLoggerMethod(input.logger, 'debug'),
        };
        this.portalService =
            input.portalService ?? new client_js_1.ClashDeveloperPortalService();
        this.validationSweepIntervalMs =
            input.env.validationSweepIntervalMinutes * 60 * 1000;
        this.keyUnhealthyCooldownMs = input.env.keyUnhealthyCooldownSeconds * 1000;
        this.accountUnhealthyCooldownMs =
            input.env.accountUnhealthyCooldownSeconds * 1000;
        for (const account of input.env.cocDeveloperAccounts) {
            this.credentialsBySlot.set(account.slot, {
                slot: account.slot,
                email: account.email,
                password: account.password,
            });
        }
    }
    async start() {
        if (this.intervalHandle) {
            return;
        }
        try {
            await this.runValidationSweep('startup');
        }
        catch (error) {
            this.logger.error({
                err: error,
                metadata: toErrorMetadata(error),
            }, 'initial key manager validation sweep failed');
        }
        this.intervalHandle = setInterval(() => {
            void this.runValidationSweep('interval').catch((error) => {
                this.logger.error({
                    err: error,
                    metadata: toErrorMetadata(error),
                }, 'scheduled key manager validation sweep failed');
            });
        }, this.validationSweepIntervalMs);
        this.intervalHandle.unref?.();
    }
    async stop() {
        if (!this.intervalHandle) {
            return;
        }
        clearInterval(this.intervalHandle);
        this.intervalHandle = null;
    }
    async acquireKey() {
        return this.queue.run(async () => {
            let status = this.getStatusSnapshotUnlocked();
            let candidate = this.selectCandidateUnlocked(status);
            if (!candidate) {
                await this.runValidationSweepUnlocked('acquire-repair');
                status = this.getStatusSnapshotUnlocked();
                candidate = this.selectCandidateUnlocked(status);
            }
            if (!candidate) {
                throw new Error('No healthy managed Clash of Clans API keys are available.');
            }
            const selectedAt = timestamp();
            const updatedKey = this.input.persistence.updateApiKeyStatus({
                keyValue: candidate.key.keyValue,
                lastUsedAt: selectedAt,
            });
            this.input.persistence.setAppState(ROTATION_CURSOR_STATE_KEY, String(updatedKey.id));
            this.logger.debug({
                accountSlot: candidate.account.slot,
                apiKeyId: updatedKey.id,
                portalKeyId: updatedKey.portalKeyId,
                keyValue: maskKeyValue(updatedKey.keyValue),
            }, 'managed API key selected');
            return {
                apiKeyId: updatedKey.id,
                portalKeyId: updatedKey.portalKeyId,
                accountId: candidate.account.id,
                accountSlot: candidate.account.slot,
                accountEmail: candidate.account.email,
                keyName: updatedKey.keyName,
                keyValue: updatedKey.keyValue,
                cidrRanges: updatedKey.cidrRanges,
                selectedAt,
            };
        });
    }
    async markKeyHealthy(keyValue) {
        return this.queue.run(() => {
            const existingKey = this.input.persistence.getApiKeyByValue(keyValue);
            if (!existingKey) {
                return null;
            }
            return this.input.persistence.updateApiKeyStatus({
                keyValue,
                isActive: true,
                isHealthy: true,
                invalidReason: null,
                unhealthyUntil: null,
                lastValidatedAt: timestamp(),
            });
        });
    }
    async reportUpstreamFailure(input) {
        return this.queue.run(() => this.reportUpstreamFailureUnlocked(input));
    }
    async regenerateKey(input) {
        return this.queue.run(() => this.regenerateKeyUnlocked(input));
    }
    async runValidationSweep(reason = 'manual') {
        return this.queue.run(() => this.runValidationSweepUnlocked(reason));
    }
    async forceRefreshAllKeys() {
        return this.runValidationSweep('force-refresh');
    }
    async setAccountEnabled(slot, isEnabled) {
        return this.queue.run(async () => {
            const updatedAccount = this.input.persistence.updateDeveloperAccountStatus({
                slot,
                isEnabled,
            });
            this.input.persistence.recordLifecycleEvent({
                eventType: isEnabled ? 'account.enabled' : 'account.disabled',
                accountSlot: slot,
                message: isEnabled
                    ? 'Developer account enabled by admin request.'
                    : 'Developer account disabled by admin request.',
                metadata: {
                    isEnabled,
                },
            });
            if (isEnabled) {
                await this.runValidationSweepUnlocked('admin-enable-account');
                const reloadedAccount = this.input.persistence.getDeveloperAccountBySlot(slot);
                if (!reloadedAccount) {
                    throw new Error(`Developer account slot ${slot} disappeared after enable operation.`);
                }
                return reloadedAccount;
            }
            return updatedAccount;
        });
    }
    async getStatusSnapshot() {
        return this.queue.run(() => this.getStatusSnapshotUnlocked());
    }
    runDetachedQueuedTask(label, task) {
        void this.queue.run(task).catch((error) => {
            this.logger.error({
                err: error,
                label,
                metadata: toErrorMetadata(error),
            }, 'detached key manager task failed');
        });
    }
    getCredentialsForSlot(slot) {
        const credentials = this.credentialsBySlot.get(slot);
        if (!credentials) {
            throw new Error(`Missing developer portal credentials for account slot ${slot}.`);
        }
        return credentials;
    }
    getStatusSnapshotUnlocked() {
        const accounts = this.input.persistence.listDeveloperAccounts();
        const apiKeys = this.input.persistence
            .listApiKeys()
            .filter((apiKey) => apiKey.isManaged);
        const rotationCursorState = this.input.persistence.getAppState(ROTATION_CURSOR_STATE_KEY);
        const lastValidationCompletedAtState = this.input.persistence.getAppState(LAST_VALIDATION_COMPLETED_AT_STATE_KEY);
        const accountsWithKeys = accounts.map((account) => {
            const managedKeys = apiKeys.filter((apiKey) => apiKey.developerAccountId === account.id);
            const eligibleManagedKeys = managedKeys.filter((apiKey) => this.isEligibleKeyCandidate(account, apiKey));
            return {
                ...account,
                managedKeys,
                healthyManagedKeyCount: managedKeys.filter((apiKey) => apiKey.isActive && apiKey.isHealthy).length,
                eligibleManagedKeyCount: eligibleManagedKeys.length,
            };
        });
        return {
            accounts: accountsWithKeys,
            eligibleKeyCount: accountsWithKeys.reduce((total, account) => total + account.eligibleManagedKeyCount, 0),
            lastRotationCursor: parseStateNumber(rotationCursorState?.value ?? null),
            lastValidationCompletedAt: lastValidationCompletedAtState?.value ?? null,
        };
    }
    selectCandidateUnlocked(status) {
        const eligibleKeys = status.accounts
            .flatMap((account) => account.managedKeys
            .filter((apiKey) => this.isEligibleKeyCandidate(account, apiKey))
            .map((apiKey) => ({
            account,
            key: apiKey,
        })))
            .sort(compareCandidates);
        if (eligibleKeys.length === 0) {
            return null;
        }
        if (status.lastRotationCursor === null) {
            return eligibleKeys[0] ?? null;
        }
        const rotationCursor = status.lastRotationCursor;
        return (eligibleKeys.find((candidate) => candidate.key.id > rotationCursor) ??
            eligibleKeys[0] ??
            null);
    }
    isEligibleKeyCandidate(account, apiKey) {
        return (account.isEnabled &&
            account.isHealthy &&
            !isInCooldown(account.unhealthyUntil) &&
            apiKey.isActive &&
            apiKey.isHealthy &&
            !isInCooldown(apiKey.unhealthyUntil));
    }
    async runValidationSweepUnlocked(reason) {
        const startedAt = timestamp();
        const summary = {
            reason,
            startedAt,
            completedAt: startedAt,
            accountsChecked: 0,
            accountsRecovered: 0,
            accountsFailed: 0,
            keysValidated: 0,
            keysCreated: 0,
            keysInvalidated: 0,
        };
        this.input.persistence.setAppState(LAST_VALIDATION_STARTED_AT_STATE_KEY, startedAt);
        const enabledAccounts = this.input.persistence
            .listDeveloperAccounts()
            .filter((account) => account.isEnabled);
        for (const account of enabledAccounts) {
            await this.synchronizeAccountUnlocked(account, reason, summary);
        }
        summary.completedAt = timestamp();
        this.input.persistence.setAppState(LAST_VALIDATION_COMPLETED_AT_STATE_KEY, summary.completedAt);
        this.input.persistence.recordLifecycleEvent({
            eventType: 'key_manager.validation.completed',
            message: `Key validation sweep completed (${reason}).`,
            metadata: summary,
        });
        this.logger.info(summary, 'key validation sweep completed');
        return summary;
    }
    async synchronizeAccountUnlocked(account, reason, summary) {
        summary.accountsChecked += 1;
        try {
            const credentials = this.getCredentialsForSlot(account.slot);
            const portalKeys = await this.portalService.listKeysForAccount(credentials);
            const validatedAt = timestamp();
            const persistedManagedKeys = this.input.persistence
                .listApiKeys()
                .filter((apiKey) => apiKey.developerAccountId === account.id && apiKey.isManaged);
            const knownManagedKeyValues = new Set(persistedManagedKeys.map((apiKey) => apiKey.keyValue));
            const allManagedPortalKeys = portalKeys.filter((portalKey) => this.isManagedPortalKey(portalKey, knownManagedKeyValues));
            let managedPortalKeys = allManagedPortalKeys;
            managedPortalKeys = managedPortalKeys.filter((portalKey) => portalKey.key.length > 0);
            if (managedPortalKeys.length === 0) {
                for (const staleManagedPortalKey of allManagedPortalKeys) {
                    await this.portalService.revokeKeyForAccount(credentials, staleManagedPortalKey.id);
                    summary.keysInvalidated += 1;
                    this.input.persistence.recordLifecycleEvent({
                        eventType: 'key.portal.stale_managed_revoked',
                        accountSlot: account.slot,
                        message: 'Stale managed API key was revoked before creating a replacement.',
                        metadata: {
                            reason,
                            portalKeyId: staleManagedPortalKey.id,
                            keyName: staleManagedPortalKey.name,
                        },
                    });
                }
                const createdKey = await this.createManagedKeyUnlocked({
                    account,
                    reason: `${reason}:missing-managed-key`,
                });
                managedPortalKeys = [
                    {
                        id: createdKey.portalKeyId ?? createdKey.id,
                        name: createdKey.keyName ?? this.buildManagedKeyName(account.slot),
                        description: this.input.env.managedKeyDescription,
                        key: createdKey.keyValue,
                        cidrRanges: createdKey.cidrRanges,
                        scopes: this.input.env.managedKeyScopes ?? [],
                    },
                ];
                summary.keysCreated += 1;
            }
            const seenManagedKeyValues = new Set();
            for (const portalKey of managedPortalKeys) {
                this.input.persistence.saveApiKey({
                    accountSlot: account.slot,
                    portalKeyId: portalKey.id,
                    keyName: portalKey.name,
                    keyValue: portalKey.key,
                    cidrRanges: portalKey.cidrRanges,
                    isManaged: true,
                    isActive: true,
                    isHealthy: true,
                    invalidReason: null,
                    lastValidatedAt: validatedAt,
                    lastSeenAt: validatedAt,
                    unhealthyUntil: null,
                });
                seenManagedKeyValues.add(portalKey.key);
                summary.keysValidated += 1;
            }
            for (const persistedKey of persistedManagedKeys) {
                if (seenManagedKeyValues.has(persistedKey.keyValue)) {
                    continue;
                }
                this.input.persistence.updateApiKeyStatus({
                    keyValue: persistedKey.keyValue,
                    isActive: false,
                    isHealthy: false,
                    invalidReason: 'KEY_NOT_FOUND_IN_PORTAL',
                    lastValidatedAt: validatedAt,
                    lastSeenAt: null,
                    unhealthyUntil: null,
                });
                summary.keysInvalidated += 1;
                this.input.persistence.recordLifecycleEvent({
                    eventType: 'key.portal.missing',
                    accountSlot: account.slot,
                    apiKeyId: persistedKey.id,
                    message: 'Managed API key is no longer present in the developer portal.',
                    metadata: {
                        reason,
                        keyValue: maskKeyValue(persistedKey.keyValue),
                        portalKeyId: persistedKey.portalKeyId,
                    },
                });
            }
            this.input.persistence.updateDeveloperAccountStatus({
                slot: account.slot,
                isHealthy: true,
                lastLoginAt: validatedAt,
                unhealthyUntil: null,
                lastError: null,
            });
            if (!account.isHealthy || account.unhealthyUntil !== null) {
                summary.accountsRecovered += 1;
            }
        }
        catch (error) {
            summary.accountsFailed += 1;
            await this.handleAccountFailureUnlocked(account, error, {
                reason,
                eventType: 'account.validation.failed',
                message: 'Developer account validation failed.',
            });
        }
    }
    isManagedPortalKey(portalKey, knownManagedKeyValues) {
        return (portalKey.name.startsWith(this.input.env.managedKeyNamePrefix) ||
            portalKey.description === this.input.env.managedKeyDescription ||
            knownManagedKeyValues.has(portalKey.key));
    }
    buildManagedKeyName(slot) {
        return `${this.input.env.managedKeyNamePrefix}-slot-${slot}-${Date.now()}`;
    }
    async createManagedKeyUnlocked(input) {
        const createdAt = timestamp();
        const credentials = this.getCredentialsForSlot(input.account.slot);
        const createdPortalKey = await this.portalService.createKeyForAccount(credentials, {
            cidrRanges: this.input.env.managedKeyAllowedCidrs,
            name: this.buildManagedKeyName(input.account.slot),
            description: this.input.env.managedKeyDescription,
            scopes: this.input.env.managedKeyScopes,
        });
        const savedKey = this.input.persistence.saveApiKey({
            accountSlot: input.account.slot,
            portalKeyId: createdPortalKey.id,
            keyName: createdPortalKey.name,
            keyValue: createdPortalKey.key,
            cidrRanges: createdPortalKey.cidrRanges,
            isManaged: true,
            isActive: true,
            isHealthy: true,
            invalidReason: null,
            lastValidatedAt: createdAt,
            lastSeenAt: createdAt,
            unhealthyUntil: null,
        });
        this.input.persistence.recordLifecycleEvent({
            eventType: 'key.created',
            accountSlot: input.account.slot,
            apiKeyId: savedKey.id,
            message: 'Managed API key created.',
            metadata: {
                reason: input.reason,
                portalKeyId: savedKey.portalKeyId,
                keyValue: maskKeyValue(savedKey.keyValue),
            },
        });
        this.logger.info({
            accountSlot: input.account.slot,
            apiKeyId: savedKey.id,
            portalKeyId: savedKey.portalKeyId,
            keyValue: maskKeyValue(savedKey.keyValue),
            reason: input.reason,
        }, 'managed API key created');
        return savedKey;
    }
    reportUpstreamFailureUnlocked(input) {
        const existingKey = this.input.persistence.getApiKeyByValue(input.keyValue);
        if (!existingKey) {
            this.logger.warn({
                keyValue: maskKeyValue(input.keyValue),
                category: input.category,
                statusCode: input.statusCode ?? null,
            }, 'cannot record upstream failure for unknown managed API key');
            return {
                handled: false,
                markedAccountUnhealthy: false,
                markedKeyUnhealthy: false,
                scheduledRegeneration: false,
                scheduledValidationSweep: false,
            };
        }
        const account = this.input.persistence
            .listDeveloperAccounts()
            .find((developerAccount) => developerAccount.id === existingKey.developerAccountId);
        if (!account) {
            throw new Error(`Developer account ${existingKey.developerAccountId} does not exist for API key ${existingKey.keyValue}.`);
        }
        const occurredAt = timestamp();
        const failureReason = mapUpstreamFailureCategoryToReason(input.category);
        const shouldRegenerate = shouldRegenerateForUpstreamFailure(input.category);
        const shouldMarkAccountUnhealthy = shouldMarkAccountUnhealthyForUpstreamFailure(input.category);
        const shouldScheduleValidation = shouldScheduleValidationForUpstreamFailure(input.category);
        this.input.persistence.updateApiKeyStatus({
            keyValue: existingKey.keyValue,
            isActive: shouldRegenerate ? false : existingKey.isActive,
            isHealthy: false,
            invalidReason: failureReason,
            lastValidatedAt: occurredAt,
            unhealthyUntil: addMilliseconds(occurredAt, this.keyUnhealthyCooldownMs),
        });
        if (shouldMarkAccountUnhealthy) {
            this.input.persistence.updateDeveloperAccountStatus({
                slot: account.slot,
                isHealthy: false,
                unhealthyUntil: addMilliseconds(occurredAt, this.accountUnhealthyCooldownMs),
                lastError: input.message ?? failureReason,
            });
        }
        this.input.persistence.recordLifecycleEvent({
            eventType: 'key.upstream.failure',
            accountSlot: account.slot,
            apiKeyId: existingKey.id,
            message: 'Managed API key failed while calling the upstream API.',
            metadata: {
                category: input.category,
                reason: failureReason,
                statusCode: input.statusCode ?? null,
                keyValue: maskKeyValue(existingKey.keyValue),
                portalKeyId: existingKey.portalKeyId,
                ...input.metadata,
            },
        });
        this.logger.warn({
            accountSlot: account.slot,
            apiKeyId: existingKey.id,
            portalKeyId: existingKey.portalKeyId,
            keyValue: maskKeyValue(existingKey.keyValue),
            category: input.category,
            statusCode: input.statusCode ?? null,
        }, 'managed API key marked unhealthy after upstream failure');
        if (shouldRegenerate) {
            this.runDetachedQueuedTask('upstream-regeneration', async () => {
                await this.regenerateKeyUnlocked({
                    keyValue: existingKey.keyValue,
                    reason: failureReason,
                    metadata: {
                        upstreamFailureCategory: input.category,
                        upstreamStatusCode: input.statusCode ?? null,
                        ...input.metadata,
                    },
                });
            });
        }
        else if (shouldScheduleValidation) {
            this.runDetachedQueuedTask('upstream-validation-sweep', async () => {
                await this.runValidationSweepUnlocked(`upstream:${input.category}`);
            });
        }
        return {
            handled: true,
            markedAccountUnhealthy: shouldMarkAccountUnhealthy,
            markedKeyUnhealthy: true,
            scheduledRegeneration: shouldRegenerate,
            scheduledValidationSweep: !shouldRegenerate && shouldScheduleValidation,
        };
    }
    async regenerateKeyUnlocked(input) {
        const existingKey = this.input.persistence.getApiKeyByValue(input.keyValue);
        if (!existingKey) {
            this.logger.warn({
                keyValue: maskKeyValue(input.keyValue),
                reason: input.reason,
            }, 'cannot regenerate unknown managed API key');
            return null;
        }
        const account = this.input.persistence
            .listDeveloperAccounts()
            .find((developerAccount) => developerAccount.id === existingKey.developerAccountId);
        if (!account) {
            throw new Error(`Developer account ${existingKey.developerAccountId} does not exist for API key ${existingKey.keyValue}.`);
        }
        const markedAt = timestamp();
        this.input.persistence.updateApiKeyStatus({
            keyValue: existingKey.keyValue,
            isActive: false,
            isHealthy: false,
            invalidReason: input.reason,
            lastValidatedAt: markedAt,
            unhealthyUntil: addMilliseconds(markedAt, this.keyUnhealthyCooldownMs),
        });
        this.input.persistence.recordLifecycleEvent({
            eventType: 'key.regeneration.requested',
            accountSlot: account.slot,
            apiKeyId: existingKey.id,
            message: 'Managed API key regeneration requested.',
            metadata: {
                reason: input.reason,
                keyValue: maskKeyValue(existingKey.keyValue),
                portalKeyId: existingKey.portalKeyId,
                ...input.metadata,
            },
        });
        try {
            const credentials = this.getCredentialsForSlot(account.slot);
            if (input.revokeExistingPortalKey !== false &&
                typeof existingKey.portalKeyId === 'number') {
                try {
                    await this.portalService.revokeKeyForAccount(credentials, existingKey.portalKeyId);
                }
                catch (error) {
                    if (!(error instanceof client_js_1.DeveloperPortalError) ||
                        error.code !== 'KEY_NOT_FOUND') {
                        throw error;
                    }
                    this.logger.debug({
                        accountSlot: account.slot,
                        portalKeyId: existingKey.portalKeyId,
                        keyValue: maskKeyValue(existingKey.keyValue),
                    }, 'managed API key already missing from portal during regeneration');
                }
            }
            const replacementKey = await this.createManagedKeyUnlocked({
                account,
                reason: `regenerate:${input.reason}`,
            });
            this.input.persistence.recordLifecycleEvent({
                eventType: 'key.regenerated',
                accountSlot: account.slot,
                apiKeyId: replacementKey.id,
                message: 'Managed API key regenerated.',
                metadata: {
                    reason: input.reason,
                    replacedApiKeyId: existingKey.id,
                    replacedPortalKeyId: existingKey.portalKeyId,
                    replacedKeyValue: maskKeyValue(existingKey.keyValue),
                    replacementApiKeyId: replacementKey.id,
                    replacementPortalKeyId: replacementKey.portalKeyId,
                    replacementKeyValue: maskKeyValue(replacementKey.keyValue),
                    ...input.metadata,
                },
            });
            this.input.persistence.updateDeveloperAccountStatus({
                slot: account.slot,
                isHealthy: true,
                unhealthyUntil: null,
                lastError: null,
            });
            return replacementKey;
        }
        catch (error) {
            await this.handleAccountFailureUnlocked(account, error, {
                reason: `regenerate:${input.reason}`,
                eventType: 'account.regeneration.failed',
                message: 'Developer account failed while regenerating a managed API key.',
            });
            return null;
        }
    }
    async handleAccountFailureUnlocked(account, error, context) {
        const failedAt = timestamp();
        const errorMetadata = toErrorMetadata(error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown developer portal error';
        this.input.persistence.updateDeveloperAccountStatus({
            slot: account.slot,
            isHealthy: false,
            unhealthyUntil: addMilliseconds(failedAt, this.accountUnhealthyCooldownMs),
            lastError: errorMessage,
        });
        this.input.persistence.recordLifecycleEvent({
            eventType: context.eventType,
            accountSlot: account.slot,
            message: context.message,
            metadata: {
                reason: context.reason,
                ...errorMetadata,
            },
        });
        this.logger.warn({
            accountSlot: account.slot,
            email: account.email,
            reason: context.reason,
            metadata: errorMetadata,
        }, context.message);
    }
}
exports.ClashApiKeyManager = ClashApiKeyManager;
function createKeyManager(input) {
    return new ClashApiKeyManager({
        env: {
            validationSweepIntervalMinutes: input.env.validationSweepIntervalMinutes,
            keyUnhealthyCooldownSeconds: input.env.keyUnhealthyCooldownSeconds,
            accountUnhealthyCooldownSeconds: input.env.accountUnhealthyCooldownSeconds,
            managedKeyAllowedCidrs: input.env.managedKeyAllowedCidrs,
            managedKeyNamePrefix: input.env.managedKeyNamePrefix,
            managedKeyDescription: input.env.managedKeyDescription,
            managedKeyScopes: input.env.managedKeyScopes,
            cocDeveloperAccounts: input.env.cocDeveloperAccounts,
        },
        persistence: input.persistence,
        portalService: input.portalService,
        logger: input.logger,
    });
}
//# sourceMappingURL=service.js.map