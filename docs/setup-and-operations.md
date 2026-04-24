# Setup and operations guide

This guide covers initial setup, runtime configuration, deployment notes, and day-2 operations for `clashmate-proxy`.

## What this service does

`clashmate-proxy` sits in front of the official Clash of Clans API.

Clients such as Discord bots call the proxy instead of calling `https://api.clashofclans.com/v1` directly.
The proxy then:

- preserves the official `/v1/...` route structure
- authenticates clients with a shared client secret
- selects a managed Clash developer API key
- rotates keys across configured developer accounts
- retries with another healthy key when possible
- regenerates invalid keys when needed
- stores operational state in SQLite

## Prerequisites

Before setup, make sure you have:

- Node.js 22+
- at least 1 Clash of Clans developer account
- the static outbound IP or CIDR of your deployment host
- a place to persist the SQLite database
- a shared client secret for bots/projects
- a separate admin secret for admin endpoints

## Initial setup

### 1. Clone and install

```bash
npm install
```

### 2. Create the environment file

Copy `.env.example` to `.env` and fill in all required values.

### 3. Configure developer accounts

At least one account is required:

```env
COC_ACCOUNT_1_EMAIL=developer1@example.com
COC_ACCOUNT_1_PASSWORD=replace-with-password-1
```

You can configure up to 10 accounts.

### 4. Configure allowed IP/CIDR

Set the CIDR list used for managed Clash developer keys:

```env
COC_MANAGED_KEY_ALLOWED_CIDRS=203.0.113.10/32
```

This should match the static outbound IP/CIDR of your host.

### 5. Configure storage

For local use:

```env
SQLITE_PATH=./data/clashmate-proxy.sqlite
```

For Pterodactyl:

```env
SQLITE_PATH=/home/container/data/clashmate-proxy.sqlite
```

### 6. Start the service

Development:

```bash
npm run dev
```

Production build:

```bash
npm run build
npm run start
```

## Environment variable reference

See also: [`docs/environment.md`](./environment.md)

### Core network/runtime

- `HOST` — bind host, usually `0.0.0.0`
- `PORT` — listen port
- `NODE_ENV` — `development`, `test`, or `production`
- `LOG_LEVEL` — Fastify/Pino log level

### Client/admin authentication

- `CLIENT_API_SECRET` — shared secret used by bots/projects
- `ADMIN_API_SECRET` — separate secret for admin endpoints

Use different values.

### Persistence

- `SQLITE_PATH` — SQLite file path

### Proxy behavior

- `CACHE_TTL_SECONDS` — GET cache TTL
- `VALIDATION_SWEEP_INTERVAL_MINUTES` — scheduled validation sweep interval
- `UPSTREAM_BASE_URL` — normally `https://api.clashofclans.com/v1`
- `UPSTREAM_TIMEOUT_MS` — upstream timeout per attempt
- `UPSTREAM_MAX_RETRIES` — bounded retries after the first failed attempt
- `KEY_UNHEALTHY_COOLDOWN_SECONDS` — temporary key cooldown after failures
- `ACCOUNT_UNHEALTHY_COOLDOWN_SECONDS` — temporary account cooldown after failures

### Managed key settings

- `COC_MANAGED_KEY_ALLOWED_CIDRS` — allowed IP/CIDR list for created keys
- `COC_MANAGED_KEY_NAME_PREFIX` — prefix used to identify managed keys
- `COC_MANAGED_KEY_DESCRIPTION` — description used for managed keys
- `COC_MANAGED_KEY_SCOPES` — optional portal scopes

### Developer accounts

- `COC_ACCOUNT_<N>_EMAIL`
- `COC_ACCOUNT_<N>_PASSWORD`

where `<N>` is `1` through `10`.

## Health and readiness

### `GET /health`

Use this to check whether the process is up and basic persistence is available.

### `GET /ready`

Use this to check whether the service is operational for client traffic.

Readiness currently depends on:

- at least one enabled account
- at least one healthy enabled account
- at least one eligible managed key
- at least one completed validation sweep

If those conditions are not met, `/ready` returns `503`.

## Admin operations

All admin routes require `ADMIN_API_SECRET`.

### `GET /admin/status`

Use this for the normal operational snapshot:

- account health
- key health
- cooldown state
- last validation timing
- masked key values

### `GET /admin/debug`

Use this for deeper troubleshooting:

- status snapshot
- app state
- recent lifecycle events

### `POST /admin/refresh`

Forces an immediate validation sweep across accounts.

Use this when:

- you changed account credentials
- you changed allowed CIDRs
- you want to immediately repair the key pool
- you suspect portal state drift

### `POST /admin/accounts/:slot/enable`

Re-enables a configured account and triggers validation.

### `POST /admin/accounts/:slot/disable`

Disables a configured account so rotation will stop using it.

## Key lifecycle and recovery flows

### Normal rotation flow

Under normal operation:

1. the key manager validates configured accounts and managed keys
2. healthy managed keys become eligible for selection
3. each proxied request acquires the next healthy key in round-robin order
4. successful usage updates last-used/last-validated timing

### Validation sweep flow

Validation sweeps run:

- on startup
- every `VALIDATION_SWEEP_INTERVAL_MINUTES`
- after manual admin refresh
- in some failure-recovery paths

During a sweep, the proxy:

1. lists keys in the developer portal for each enabled account
2. matches keys that belong to `clashmate-proxy`
3. creates a managed key if none exists
4. marks missing portal keys inactive/unhealthy in SQLite
5. clears healthy account state when validation succeeds
6. marks accounts unhealthy when portal actions fail

### Invalid key / auth failure flow

If upstream responses indicate an invalid key, bad auth, or invalid IP:

1. the failing key is marked unhealthy
2. the account may also be marked unhealthy temporarily
3. the request pipeline retries with the next healthy candidate if available
4. background regeneration is scheduled
5. the old key may be revoked and a replacement key is created
6. the replacement key is persisted and becomes eligible after validation state is updated

### Transient failure flow

For network, timeout, rate-limit, or server-side upstream failures:

1. the failing key is marked temporarily unhealthy
2. the request is retried with the next healthy key when possible
3. background validation may be scheduled
4. the key becomes usable again after cooldown or successful validation

### Recovery after restart

On restart, the service rebuilds in-memory state from SQLite and then runs a validation sweep.

Persisted state includes:

- configured accounts
- key metadata
- health/cooldown state
- lifecycle events
- app state values such as validation timing

## Operational playbooks

### Proxy is up but `/ready` is `503`

Check in order:

1. `GET /admin/status`
2. `GET /admin/debug`
3. service logs
4. whether `COC_MANAGED_KEY_ALLOWED_CIDRS` matches the real outbound IP
5. whether developer account credentials are still valid

Common causes:

- no healthy accounts
- no eligible keys
- validation sweep has not completed yet
- portal login failure
- keys were revoked or no longer match allowed IPs

### All requests return `401`

Likely causes:

- bot/client is not sending `CLIENT_API_SECRET`
- bot is accidentally still sending the old official API token instead
- admin secret is being sent to client routes

### Many requests return `503`

Likely causes:

- all keys are unhealthy or cooling down
- all accounts are unhealthy
- invalid host IP/CIDR configuration
- Clash developer portal errors are blocking regeneration

Recommended actions:

1. inspect `/admin/status`
2. inspect `/admin/debug`
3. run `POST /admin/refresh`
4. verify outbound IP/CIDR
5. temporarily disable one broken account if needed
6. fix credentials or CIDR config and refresh again

### One account is bad but others are healthy

Recommended action:

1. disable the bad account via `POST /admin/accounts/:slot/disable`
2. keep serving traffic from remaining healthy accounts
3. repair the bad account credentials or portal state
4. re-enable the account with `POST /admin/accounts/:slot/enable`

## Deployment notes

For Docker and Pterodactyl packaging details, see:

- [`README.md`](../README.md)
- [`docs/pterodactyl.md`](./pterodactyl.md)

Recommended production settings:

```env
NODE_ENV=production
HOST=0.0.0.0
LOG_LEVEL=info
CACHE_TTL_SECONDS=10
VALIDATION_SWEEP_INTERVAL_MINUTES=15
UPSTREAM_MAX_RETRIES=2
```

## Validation and testing

Run the validation suite with:

```bash
npm run test
```

Current automated coverage includes:

- proxy forwarding and retries
- GET cache hits
- key rotation and unhealthy-key skip behavior
- regeneration after invalid key failures
- app auth, health, and readiness behavior
- SQLite restart persistence

## V1 limitations

Current v1 intentionally does **not** include:

- multi-instance coordination
- distributed locking or leader election
- multi-region deployment
- metrics endpoint
- web dashboard
- per-client quotas
- analytics or billing
- distributed job queues

Because v1 is single-instance, SQLite-backed state and in-process scheduling are acceptable.

## Future multi-instance considerations

The current code is structured so it can evolve later, but true multi-instance support will require additional work.

Likely future changes:

- replace or supplement SQLite with shared storage
- add distributed locking around validation/regeneration jobs
- centralize rotation cursor state
- coordinate unhealthy cooldown state across instances
- move background regeneration/validation into a queue or worker model
- add metrics for fleet-wide operational visibility

## Recommended document map

- project overview: [`README.md`](../README.md)
- environment reference: [`docs/environment.md`](./environment.md)
- Pterodactyl deployment: [`docs/pterodactyl.md`](./pterodactyl.md)
- bot migration: [`docs/bot-integration.md`](./bot-integration.md)
