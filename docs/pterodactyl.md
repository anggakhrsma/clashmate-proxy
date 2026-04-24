# Pterodactyl / MonkeyBytes deployment

This project is packaged to run as a custom container on Pterodactyl-based hosting.

## Recommended image workflow

1. Build the image from this repository.
2. Push it to a registry accessible by your panel/node.
3. Configure the Pterodactyl server to use that image.
4. Set the startup command to an absolute path so it does not depend on the panel working directory.

## Startup command

Use this startup command in the panel:

```bash
node /app/dist/index.js
```

Why this command:
- the compiled app is baked into the image under `/app/dist`
- it does not rely on `/home/container` being the working directory
- it matches the container `CMD`

## Persistent SQLite storage

Use a persistent path under the panel-managed server filesystem:

```env
SQLITE_PATH=/home/container/data/clashmate-proxy.sqlite
```

Notes:
- `/app` is part of the container image and should be treated as immutable
- `/home/container` is the correct place for persistent runtime data on Pterodactyl
- the application automatically creates the parent directory if it does not exist

## Required environment variables

At minimum, configure these variables in the panel:

```env
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
CLIENT_API_SECRET=<shared-client-secret>
ADMIN_API_SECRET=<admin-secret>
SQLITE_PATH=/home/container/data/clashmate-proxy.sqlite
COC_MANAGED_KEY_ALLOWED_CIDRS=<your-static-egress-ip-or-cidr>
COC_ACCOUNT_1_EMAIL=<developer-account-email>
COC_ACCOUNT_1_PASSWORD=<developer-account-password>
```

Also configure any optional tuning values you need, for example:
- `CACHE_TTL_SECONDS`
- `VALIDATION_SWEEP_INTERVAL_MINUTES`
- `UPSTREAM_MAX_RETRIES`
- `KEY_UNHEALTHY_COOLDOWN_SECONDS`
- `ACCOUNT_UNHEALTHY_COOLDOWN_SECONDS`
- `COC_MANAGED_KEY_NAME_PREFIX`
- `COC_MANAGED_KEY_DESCRIPTION`

## MonkeyBytes / Pterodactyl checklist

- Confirm the node has the expected static outbound IP.
- Put that IP/CIDR in `COC_MANAGED_KEY_ALLOWED_CIDRS`.
- Use `HOST=0.0.0.0` so the service binds correctly inside the container.
- Match `PORT` to the server allocation/port exposed by the panel.
- Store the SQLite database under `/home/container/data`.
- Add all Clash developer account credentials through the panel environment settings.
- Keep `CLIENT_API_SECRET` and `ADMIN_API_SECRET` different.

## Health endpoints

Useful operational endpoints after deployment:

- `GET /health` — process/persistence health
- `GET /ready` — readiness based on enabled healthy accounts and eligible keys
- `GET /admin/status` — masked account/key status snapshot
- `GET /admin/debug` — app state and recent lifecycle events

## Example deployment flow

Build locally:

```bash
docker build -t clashmate-proxy:latest .
```

Push to your registry, then point the Pterodactyl server image at that tag.

After the server starts:
- verify `/health` returns `200`
- verify `/ready` returns `200` once keys are validated/generated
- use `/admin/status` to confirm accounts and managed keys are healthy
