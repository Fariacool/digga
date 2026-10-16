![digga](./public/digga-background.svg)

<h1 align="center">digga · Domain & Infrastructure research</h1>

<p align="center">
  All in one toolkit for DNS, RDAP, WHOIS, and subdomain research.<br />
  Free for everyone at <a href="https://digga.dev">digga.dev</a>.
</p>

<p align="center">
  AGPL 3.0 with additional attribution terms, see <a href="./LICENSE">LICENSE</a>
</p>

## Optional API key protection

Set `API_KEY` in the server environment to require authentication for lookup pages,
domain OG images, Server Actions, and the existing APIs. Leave it unset or empty
to keep public access. Use a long random key, for example `openssl rand -hex 32`.
Keep `API_KEY` server-side; do not give it a `NEXT_PUBLIC_` prefix.

In the web UI, open **API key** in the navigation bar or run a search to reach the
unlock page. After a successful unlock, the key is saved as `digga.api-key` in
this browser's `localStorage`, and the server issues a signed, HttpOnly,
SameSite=Lax cookie valid for seven days. Cookies use Secure when served over
HTTPS. The saved key can restore an expired session automatically. The API key
dialog lets you replace the saved key; **Lock** clears both the saved key and the
cookie. Only save the key in browsers you trust.

Programmatic requests can send `Authorization: Bearer <key>` instead of a cookie:

```bash
curl 'https://your-domain.com/lookup/example.com/whois' \
  -H "Authorization: Bearer $API_KEY"
```

This URL returns the HTML report. Use `/api/whois` below for JSON.
Missing or invalid credentials return HTTP `401` for API/programmatic
requests. Browser navigation redirects to `/unlock` and returns to the requested
page after authentication. If an Authorization header is present, it takes
precedence over the cookie. Keys are never included in shared URLs.

Protected responses disable browser/CDN caching; existing server-side lookup
caches remain available after authentication. Changing `API_KEY` and restarting
or redeploying invalidates existing sessions. Update the saved key in each
browser after rotating it. Serve the instance over HTTPS outside local
development.

## WHOIS JSON API

The WHOIS API is independent of the other tools. It returns domain registration
data using RDAP first, with a WHOIS fallback. It does not run DNS, subdomain,
email, TLS or Overview queries. Those tools can have their own endpoints in
future; there is no generic `/api/lookup` endpoint.

Open `/docs` on your instance for the interactive Swagger UI. Download the
OpenAPI **3.1.2** contract from `/openapi.json`. Both are public; lookups require
the configured API key or browser session. Leave `API_KEY` empty for public
lookups. Credentials are checked before input validation or cache access.

```bash
# Omit the Authorization header on a public instance.
curl 'http://localhost:3000/api/whois?domain=example.com' \
  -H "Authorization: Bearer $API_KEY"

curl 'http://localhost:3000/api/whois/batch' \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"domains":["example.com","example.org"]}'
```

`GET /api/whois` accepts exactly one `domain` parameter. Provide a domain name,
including an IDN or subdomain, without a URL, port, IP address or ASN. The response
preserves `input` and returns the lowercase ASCII registrable `domain`; for
example, `www.Example.CO.UK.` becomes `example.co.uk`.

Success responses contain `ok: true`, normalized registration `data` and `meta`
with `cached`, `fetchedAt`, `expiresAt` and `durationMs`. `data` includes the
actual `source` (`rdap` or `whois`), responding `server`, registrar, registrant,
dates, events, status, nameservers and DNSSEC. Missing scalar values are `null`,
missing lists are empty, dates use UTC ISO 8601. Nameservers come from the
registration record, without querying DNS. WHOIS registrar records fill gaps
from the registry record. Redacted information may be absent.

`data.registrationStatus` is `registered` or `not_found`. The latter means the
upstream returned no registration record, **not a guarantee of availability**:
the name may still be reserved or restricted. Timeouts, refusals, empty responses
and rate limits return errors instead of an invented registration status.

Errors contain `ok: false`, `input`, `domain` (null when unresolved), and
`error: { code, message, retryable, retryAfterSeconds? }`. Single lookups use
HTTP 400 for invalid input, 401 for authentication, 422 for unsupported suffixes,
429 for upstream rate limits, 502 for upstream failures, 503 for a full queue,
and 504 for timeouts. Use `error.code`, not the human-readable message, in
clients. A `Retry-After` header accompanies retry delays on single requests.

`POST /api/whois/batch` accepts only `{ "domains": ["example.com", ...] }` with
`Content-Type: application/json` and a maximum 64 KiB body. Defaults allow 1–10
entries, counting duplicates. Invalid JSON, array shape or batch size rejects
the entire request; an invalid domain fails only that item. An accepted batch
returns HTTP 200, `ok: true`, `summary: { total, succeeded, failed }`, and
`results` in input order. Inspect each item's `ok` and `error`, including when
every item fails. Rate-limited items include their own `retryAfterSeconds`.

Single and batch API requests share the same process-wide cache, in-flight
deduplication and outbound scheduler. Successful records, including `not_found`,
are cached for one hour (up to 2,000 domains); errors are not cached. Joining an
in-flight lookup reports `cached: false`. HTTP responses use `no-store`, so
authentication is checked on every call. Restarting clears the in-memory state.

Runtime environment settings (restart after changing them):

| Setting                       | Default | Allowed range | Meaning                                       |
| ----------------------------- | ------- | ------------- | --------------------------------------------- |
| `WHOIS_BATCH_LIMIT`           | 10      | 1–100         | Maximum entries per batch                     |
| `WHOIS_MAX_CONCURRENT`        | 20      | 1–200         | Total outgoing registration connections       |
| `WHOIS_PER_SERVER_CONCURRENT` | 5       | 1–200         | Outgoing connections to one external hostname |

Invalid settings fall back to defaults. The limits apply to **digga requesting
external RDAP/WHOIS servers**, including discovery, redirects and referrals.
Cached results do not occupy a connection slot. One saturated host does not
block other hosts. Each outgoing request has a 5-second deadline; the full
lookup, including queueing, has a 30-second deadline. Admission is bounded to
200 unique in-flight domains and 200 queued upstream requests; overload returns
`BUSY` instead of growing the queue indefinitely. Upstream HTTP 429 honors
`Retry-After` (60 seconds if absent); requests to that host fail fast during
the cooldown, without bypassing its rate limit through WHOIS fallback.

These limits are per Node.js process, not distributed across replicas. Existing
UI reports retain their lookup behavior. The API does not accept an arbitrary
upstream host, resolver or port.

Run `pnpm test` for authentication, origin and WHOIS unit/contract tests, or
`pnpm test:auth` to also build the app and check protected/public modes, WHOIS
contracts and runtime deployment settings against production servers.
After a build, `pnpm test:http` reruns the HTTP checks using
the same build with different runtime configurations.

## Docker and GHCR deployment

Every push to `main` runs `.github/workflows/docker-build.yaml`, builds Linux
`amd64` and `arm64` images, and publishes them to `ghcr.io/<owner>/<repository>`.
For this repository the image is `ghcr.io/fariacool/digga`. Each successful build
publishes `latest`, `main`, and `sha-<full-commit-sha>` tags. You can also run the
workflow manually on `main` from GitHub Actions. Publishing uses the built-in
`GITHUB_TOKEN` with `packages: write`; no `ENABLE_DOCKER_PUBLISH` variable or
additional registry secret is required.

The image uses Node.js 24 and Next.js standalone output, runs as the non-root
`node` user, and includes the checksum-verified `subfinder` binary. A failed
subfinder installation or authentication unit test stops the image build.

### Runtime configuration

Build the image without application configuration. Set all deployment values in
the server's `.env`; no GitHub Actions application variables are needed. The
same image can run with different settings on different servers.

| Environment variable             | Purpose                                                                       | Default                               |
| -------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------- |
| `SITE_URL`                       | Optional public origin override for metadata, robots.txt, sitemaps, and links | Empty (detected from request headers) |
| `NEXT_PUBLIC_ANALYTICS_SCRIPT`   | Optional analytics script URL                                                 | Empty (analytics disabled)            |
| `NEXT_PUBLIC_ANALYTICS_ID`       | Optional analytics website ID                                                 | Empty (analytics disabled)            |
| `NEXT_PUBLIC_ANALYTICS_DOMAINS`  | Optional analytics domain filter                                              | Empty (no domain filter)              |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Optional Turnstile public site key                                            | Empty                                 |

Leave `SITE_URL` unset or empty to detect the external origin on each request.
The app reads the first `X-Forwarded-Host` value, falling back to `Host`, and
uses `X-Forwarded-Proto` for HTTP/HTTPS (HTTP when absent). A non-empty
`SITE_URL` overrides this detection. Supply an HTTP(S) origin without a path;
surrounding whitespace and a trailing slash are normalized.

Cloudflare Tunnel can forward to the container's internal HTTP address while
visitors use an external HTTPS hostname. Keep `SITE_URL` empty and pass the
public host and protocol headers through the proxy. Changing the Tunnel's
public hostname then requires no container or image change. Forwarded headers
are expected to come from your reverse proxy.

Pages and deployment metadata use the resolved origin at request time. The
existing `NEXT_PUBLIC_*` names are retained for
compatibility; the server reads them at runtime and passes the required public
values to the browser. Changing these values requires recreating the container,
without rebuilding the image.

Keep `API_KEY`, `TURNSTILE_SECRET`, `GOOGLE_SERVICE_KEY_B64`, and other
credentials in the server's `.env`. Environment files are excluded from the
Docker build context. For Turnstile, configure both its public site key and
matching `TURNSTILE_SECRET` in `.env`.

The manual `pnpm indexnow:submit` command has no incoming request to inspect;
provide `SITE_URL` in that command's environment when using it.

### Run with Docker Compose

Install Docker Engine and Docker Compose v2. Place `docker-compose.yml`,
`.env.example`, and the executable `compose` script together on your server
(or clone this repository), then run:

```bash
./compose init
# Edit .env if you need API_KEY or provider credentials; SITE_URL can stay empty.
./compose upgrade
./compose ps
./compose logs
```

The default image is `ghcr.io/fariacool/digga:latest` and the default HTTP port is
`3000`. Override `IMAGE_NAME`, `HOST_PORT`, or `HOST_BIND_ADDRESS` in `.env` as
needed. For a reverse proxy running on the host, use
`HOST_BIND_ADDRESS=127.0.0.1` and forward to `http://127.0.0.1:3000`.

The Compose stack sets `NODE_ENV` and `ENVIRONMENT` to `production`, uses the
public `/api/auth` status endpoint for its healthcheck, rotates logs, and
restarts unless stopped. Core lookups do not require a database or persistent
volume. BigQuery storage remains optional and uses runtime credentials.

```bash
./compose validate      # Check configuration without printing environment values
./compose up            # Start using the configured image
./compose upgrade       # Pull latest image and apply image/environment changes
./compose redeploy      # Force recreation with the current local image and .env
./compose restart app   # Restart app without applying changed environment values
./compose down          # Stop and remove the stack
```

New commits publish an image; update a running server with `./compose upgrade`.
For a rollback, set `IMAGE_NAME` to a previous `sha-<full-commit-sha>` tag and run
`./compose upgrade` again.

To build locally:

```bash
docker build -t digga:local .
IMAGE_NAME=digga:local ./compose up
```
