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

This URL returns the existing HTML report; this change does not add a JSON lookup
API. Missing or invalid credentials return HTTP `401` for API/programmatic
requests. Browser navigation redirects to `/unlock` and returns to the requested
page after authentication. If an Authorization header is present, it takes
precedence over the cookie. Keys are never included in shared URLs.

Protected responses disable browser/CDN caching; existing server-side lookup
caches remain available after authentication. Changing `API_KEY` and restarting
or redeploying invalidates existing sessions. Update the saved key in each
browser after rotating it. Serve the instance over HTTPS outside local
development.

Run `pnpm test` for authentication unit tests, or `pnpm test:auth` to also build
the app and check protected/public modes and runtime deployment settings against
production servers. After a build, `pnpm test:http` reruns the HTTP checks using
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

| Environment variable             | Purpose                                                                     | Default                    |
| -------------------------------- | --------------------------------------------------------------------------- | -------------------------- |
| `SITE_URL`                       | Public origin for this instance's metadata, robots.txt, sitemaps, and links | `http://localhost:3000`    |
| `NEXT_PUBLIC_ANALYTICS_SCRIPT`   | Optional analytics script URL                                               | Empty (analytics disabled) |
| `NEXT_PUBLIC_ANALYTICS_ID`       | Optional analytics website ID                                               | Empty (analytics disabled) |
| `NEXT_PUBLIC_ANALYTICS_DOMAINS`  | Optional analytics domain filter                                            | Empty (no domain filter)   |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Optional Turnstile public site key                                          | Empty                      |

Set `SITE_URL` to this instance's deployed origin. Pages and deployment metadata
read it at runtime. The existing `NEXT_PUBLIC_*` names are retained for
compatibility; the server reads them at runtime and passes the required public
values to the browser. Changing these values requires recreating the container,
without rebuilding the image.

Keep `API_KEY`, `TURNSTILE_SECRET`, `GOOGLE_SERVICE_KEY_B64`, and other
credentials in the server's `.env`. Environment files are excluded from the
Docker build context. For Turnstile, configure both its public site key and
matching `TURNSTILE_SECRET` in `.env`.

### Run with Docker Compose

Install Docker Engine and Docker Compose v2. Place `docker-compose.yml`,
`.env.example`, and the executable `compose` script together on your server
(or clone this repository), then run:

```bash
./compose init
# Edit .env: set SITE_URL and optionally API_KEY or provider credentials.
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
