# clashmate-proxy

Foundation for a Clash of Clans API proxy built with Fastify, TypeScript, and SQLite.

## Runtime requirement

- Node.js 22+

## Scripts

- `npm run dev` - start in watch mode
- `npm run build` - compile TypeScript to `dist/`
- `npm run start` - run the compiled server
- `npm run lint` - run Biome checks
- `npm run format` - format the repository with Biome
- `npm run typecheck` - run TypeScript without emitting files

## Environment

Copy `.env.example` to `.env` and update the values.

Required configuration includes:
- `CLIENT_API_SECRET`
- `ADMIN_API_SECRET`
- `SQLITE_PATH`
- `COC_MANAGED_KEY_ALLOWED_CIDRS`
- at least one `COC_ACCOUNT_<N>_EMAIL` + `COC_ACCOUNT_<N>_PASSWORD` pair

If required values are missing or invalid, the app fails fast during startup.
The SQLite database file and parent directory are created automatically if they do not already exist.

Managed key settings:
- `COC_MANAGED_KEY_ALLOWED_CIDRS` should contain the static outbound IP/CIDR that Clash developer keys must allow.
- `COC_MANAGED_KEY_NAME_PREFIX` and `COC_MANAGED_KEY_DESCRIPTION` control how managed portal keys are identified.
- `KEY_UNHEALTHY_COOLDOWN_SECONDS` and `ACCOUNT_UNHEALTHY_COOLDOWN_SECONDS` control temporary skip windows after failures.

Key manager behavior:
- runs a validation sweep on startup, then every `VALIDATION_SWEEP_INTERVAL_MINUTES`
- persists account/key health, validation timestamps, and lifecycle events in SQLite
- rotates eligible managed keys in round-robin order
- can regenerate a failed key and mark unhealthy accounts/keys on portal or upstream auth failures

## Local startup

1. Copy `.env.example` to `.env`
2. Install dependencies: `npm install`
3. Start dev server: `npm run dev`

## Docker / Pterodactyl

Build:

```bash
docker build -t clashmate-proxy .
```

Run:

```bash
docker run --rm -p 3000:3000 --env-file .env clashmate-proxy
```
