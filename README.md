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
the app and check protected and public modes against production servers.
