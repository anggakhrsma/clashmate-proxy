# Discord bot integration

This document explains how an existing Discord bot should switch from the official Clash of Clans API to `clashmate-proxy`.

## What changes in the bot

The integration change is intentionally small:

1. change the API base URL
2. stop sending the official Clash of Clans developer API key
3. send the shared proxy client secret instead

Everything else should stay the same:
- keep the same `/v1/...` paths
- keep the same query parameters
- keep the same request methods
- keep the same request bodies
- keep the same response parsing logic

## Old vs new configuration

### Before

```env
CLASH_API_BASE_URL=https://api.clashofclans.com/v1
CLASH_API_TOKEN=<official-clash-developer-api-key>
```

### After

```env
CLASH_API_BASE_URL=https://your-proxy.example.com
CLASH_API_CLIENT_SECRET=<shared-client-secret>
```

Important:
- use the proxy origin as the base URL
- do **not** append `/v1` twice if your bot already adds `/v1/...` in request paths
- do **not** send the admin secret from the bot
- do **not** send Clash developer account credentials from the bot

## Request compatibility

The proxy preserves the official Clash of Clans route structure under `/v1/*`.

Examples:

| Official API request | Proxy request |
| --- | --- |
| `https://api.clashofclans.com/v1/clans/%23ABCD1234` | `https://your-proxy.example.com/v1/clans/%23ABCD1234` |
| `https://api.clashofclans.com/v1/players/%23PLAYER` | `https://your-proxy.example.com/v1/players/%23PLAYER` |
| `https://api.clashofclans.com/v1/clans/%23TAG/warlog?limit=10` | `https://your-proxy.example.com/v1/clans/%23TAG/warlog?limit=10` |

The request path still starts with `/v1/...`.

## Authentication options for the bot

The bot must authenticate to the proxy with the shared client secret.

Supported request formats:

### Option A: dedicated client header

```http
x-clashmate-client-secret: <shared-client-secret>
```

### Option B: short client header

```http
x-client-secret: <shared-client-secret>
```

### Option C: bearer token

```http
Authorization: Bearer <shared-client-secret>
```

Recommended for bots:
- use `x-clashmate-client-secret` for clarity
- reserve `Authorization` for cases where your existing HTTP client already standardizes on bearer auth

## Example bot request changes

### fetch example

Before:

```ts
const response = await fetch(
  `https://api.clashofclans.com/v1/clans/${encodeURIComponent('#ABCD1234')}`,
  {
    headers: {
      Authorization: `Bearer ${process.env.CLASH_API_TOKEN}`,
    },
  },
);
```

After:

```ts
const baseUrl = process.env.CLASH_API_BASE_URL!;
const clientSecret = process.env.CLASH_API_CLIENT_SECRET!;

const response = await fetch(
  `${baseUrl}/v1/clans/${encodeURIComponent('#ABCD1234')}`,
  {
    headers: {
      'x-clashmate-client-secret': clientSecret,
    },
  },
);
```

### axios example

Before:

```ts
const clash = axios.create({
  baseURL: 'https://api.clashofclans.com/v1',
  headers: {
    Authorization: `Bearer ${process.env.CLASH_API_TOKEN}`,
  },
});
```

After:

```ts
const clash = axios.create({
  baseURL: process.env.CLASH_API_BASE_URL,
  headers: {
    'x-clashmate-client-secret': process.env.CLASH_API_CLIENT_SECRET,
  },
});
```

If your axios instance already includes `/v1` in the base URL, that is also fine:

```ts
const clash = axios.create({
  baseURL: `${process.env.CLASH_API_BASE_URL}/v1`,
  headers: {
    'x-clashmate-client-secret': process.env.CLASH_API_CLIENT_SECRET,
  },
});
```

Just make sure you do not create URLs like `/v1/v1/...`.

## Recommended bot environment variables

Suggested bot-side configuration:

```env
CLASH_API_BASE_URL=https://your-proxy.example.com
CLASH_API_CLIENT_SECRET=replace-with-the-shared-client-secret
```

Optional explicit naming if you want to keep both old and new during migration:

```env
CLASH_PROXY_BASE_URL=https://your-proxy.example.com
CLASH_PROXY_CLIENT_SECRET=replace-with-the-shared-client-secret
```

## Migration checklist

- deploy `clashmate-proxy`
- confirm `GET /health` returns `200`
- confirm `GET /ready` returns `200`
- update the bot base URL to the proxy origin
- replace the old official API token usage with the shared client secret
- verify one clan lookup and one player lookup through the bot
- monitor proxy logs and `GET /admin/status`

## Compatibility assumptions checked against the current proxy

These assumptions were checked against the current implementation in this repository:

- proxy routes are exposed under `/v1` and `/v1/*`
- the proxy supports the common Clash API HTTP methods: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, and `OPTIONS`
- the proxy forwards query strings and request bodies to the upstream API
- the proxy removes incoming auth headers before forwarding and injects a managed upstream key internally
- the proxy accepts bot auth via `x-clashmate-client-secret`, `x-client-secret`, or `Authorization: Bearer <secret>`
- GET requests may be cached briefly, but response payload shape remains unchanged

## Operational notes for the bot

- treat `401` as a bad or missing proxy client secret
- treat `503` as temporary proxy unavailability, usually meaning no healthy managed upstream keys are currently available
- keep retry/backoff behavior for transient upstream-style failures
- never use admin endpoints from the bot
- never log the client secret in bot logs

## Troubleshooting

### 401 Unauthorized from the proxy

Check:
- the bot is sending `x-clashmate-client-secret` or another supported auth format
- the value matches `CLIENT_API_SECRET` configured on the proxy
- the bot is not accidentally still sending the old official API key as the bearer token

### 404 or malformed route errors

Check:
- the bot still uses `/v1/...` paths
- the bot did not duplicate `/v1`
- tags such as `#ABCD1234` are URL-encoded as `%23ABCD1234`

### 503 from the proxy

Check:
- `GET /ready`
- `GET /admin/status`
- recent proxy logs for unhealthy accounts or managed key regeneration failures
