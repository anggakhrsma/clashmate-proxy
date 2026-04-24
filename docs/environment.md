# Environment reference

This file documents every environment variable used by `clashmate-proxy`.

## Network and runtime

### `HOST`

- default: `0.0.0.0`
- purpose: bind address for the Fastify server
- recommended:
  - local: `0.0.0.0`
  - Docker/Pterodactyl: `0.0.0.0`

### `PORT`

- default: `3000`
- purpose: HTTP listen port

### `NODE_ENV`

- default: `development`
- allowed values: `development`, `test`, `production`
- purpose: runtime environment label used in config and logs

### `LOG_LEVEL`

- default: `info`
- allowed values: `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`
- purpose: structured logging verbosity

## Client and admin authentication

### `CLIENT_API_SECRET`

- required: yes
- purpose: shared secret used by bots/projects for `/v1/*` routes
- notes:
  - do not reuse the admin secret
  - send via `x-clashmate-client-secret`, `x-client-secret`, or `Authorization: Bearer ...`

### `ADMIN_API_SECRET`

- required: yes
- purpose: admin secret used for `/admin*` routes
- notes:
  - must be different from `CLIENT_API_SECRET`
  - do not expose this to bots or public clients

## Storage

### `SQLITE_PATH`

- required: yes
- purpose: SQLite database location
- examples:
  - local: `./data/clashmate-proxy.sqlite`
  - Pterodactyl: `/home/container/data/clashmate-proxy.sqlite`
- notes:
  - parent directories are created automatically
  - use persistent storage in production

## Proxy behavior

### `CACHE_TTL_SECONDS`

- default: `10`
- purpose: TTL for GET response caching
- notes:
  - only applies to GET requests
  - admin and key-management flows are not cached

### `VALIDATION_SWEEP_INTERVAL_MINUTES`

- default: `15`
- purpose: interval between scheduled key/account validation sweeps

### `UPSTREAM_BASE_URL`

- default: `https://api.clashofclans.com/v1`
- purpose: official upstream Clash of Clans API base URL
- notes:
  - normally leave this unchanged

### `UPSTREAM_TIMEOUT_MS`

- default: `10000`
- purpose: timeout per upstream attempt

### `UPSTREAM_MAX_RETRIES`

- default: `2`
- purpose: number of retries after the first failed upstream attempt
- notes:
  - total attempts = `1 + UPSTREAM_MAX_RETRIES`

### `KEY_UNHEALTHY_COOLDOWN_SECONDS`

- default: `60`
- purpose: how long a failed key is skipped before it may become eligible again

### `ACCOUNT_UNHEALTHY_COOLDOWN_SECONDS`

- default: `300`
- purpose: how long a failed account is skipped before it may become eligible again

## Managed key settings

### `COC_MANAGED_KEY_ALLOWED_CIDRS`

- required: yes
- purpose: CIDR list applied to managed Clash developer keys
- format: comma-separated CIDR values
- example:

```env
COC_MANAGED_KEY_ALLOWED_CIDRS=203.0.113.10/32,203.0.113.11/32
```

- notes:
  - must match the actual static outbound IP/CIDR of the host
  - wrong values commonly cause upstream `403` / invalid IP behavior

### `COC_MANAGED_KEY_NAME_PREFIX`

- default: `clashmate-proxy`
- purpose: prefix used to identify managed portal keys

### `COC_MANAGED_KEY_DESCRIPTION`

- default: `Managed by clashmate-proxy`
- purpose: description used to identify managed portal keys

### `COC_MANAGED_KEY_SCOPES`

- default: empty / unset
- purpose: optional comma-separated scope list for created portal keys
- notes:
  - leave empty to use the portal default/full access behavior

## Developer accounts

The service supports up to 10 developer accounts.

### `COC_ACCOUNT_<N>_EMAIL`
### `COC_ACCOUNT_<N>_PASSWORD`

- required: at least one complete pair
- `<N>` range: `1` through `10`
- purpose: credentials used to log into the Clash developer portal and manage keys
- notes:
  - email and password must be provided together
  - duplicate emails are rejected during startup validation
  - these credentials are never exposed to proxy clients

Example:

```env
COC_ACCOUNT_1_EMAIL=developer1@example.com
COC_ACCOUNT_1_PASSWORD=replace-with-password-1
COC_ACCOUNT_2_EMAIL=developer2@example.com
COC_ACCOUNT_2_PASSWORD=replace-with-password-2
```

## Recommended production baseline

```env
HOST=0.0.0.0
PORT=3000
NODE_ENV=production
LOG_LEVEL=info
CLIENT_API_SECRET=replace-with-a-long-random-client-secret
ADMIN_API_SECRET=replace-with-a-different-long-random-admin-secret
SQLITE_PATH=/home/container/data/clashmate-proxy.sqlite
CACHE_TTL_SECONDS=10
VALIDATION_SWEEP_INTERVAL_MINUTES=15
UPSTREAM_BASE_URL=https://api.clashofclans.com/v1
UPSTREAM_TIMEOUT_MS=10000
UPSTREAM_MAX_RETRIES=2
KEY_UNHEALTHY_COOLDOWN_SECONDS=60
ACCOUNT_UNHEALTHY_COOLDOWN_SECONDS=300
COC_MANAGED_KEY_ALLOWED_CIDRS=203.0.113.10/32
COC_MANAGED_KEY_NAME_PREFIX=clashmate-proxy
COC_MANAGED_KEY_DESCRIPTION=Managed by clashmate-proxy
COC_MANAGED_KEY_SCOPES=
COC_ACCOUNT_1_EMAIL=developer1@example.com
COC_ACCOUNT_1_PASSWORD=replace-with-password-1
```
