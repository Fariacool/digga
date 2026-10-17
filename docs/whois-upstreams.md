# Registration upstream behavior

The JSON API contract remains `registered` / `not_found` on successful lookups.
A registered record with missing dates is a valid partial result: scalars are
`null`, lists are empty when unavailable. There is no synthetic `no_data`
registration status. Transport failures, malformed replies and rate limits
remain errors, including when a domain's dates are normally undisclosed.

## Routing and parsing

RDAP discovery uses the [IANA bootstrap](https://data.iana.org/rdap/dns.json).
WHOIS fallback discovers the registry through `whois.iana.org`. Subregistries
are checked before the TLD's RDAP server can incorrectly return `not_found`.

| Namespace | Route / handling | Date behavior |
| --- | --- | --- |
| `.ac.uk` | `whois.ja.net`, before Nominet | Parse `Entry created`, `Entry updated`, `Renewal date`, including multiline ordinal dates. |
| `.nhs.uk` | `UNSUPPORTED_TLD`; no configured public registration service | NHS manages this namespace. Neither Nominet's 404 nor Jisc's `No such domain` establishes non-registration. |
| `.pt` | IANA → `whois.dns.pt` | Parse `Creation Date` and `Expiration Date` as day/month/year, with optional time. |
| `.il`, including `.co.il` / `.org.il` | IANA → `whois.isoc.org.il` | `assigned` or domain-history `(Assigned)` supplies creation; `validity` supplies expiration. Only domain-history `(Changed)` supplies updates; contact records are excluded. |
| `.lv` | IANA → `whois.nic.lv` | Public WHOIS has no lifecycle dates. `[Whois] Updated` is a database refresh, and `RegNr` is an organisation number. |
| `.pe` and its public suffixes | IANA → `kero.yachay.pe` | Preserve genuine lifecycle fields if present. A WHOIS database footer is never a domain update. Sample replies have no lifecycle fields. |
| `.au` and its public suffixes | IANA RDAP, then discovered WHOIS for ordinary failures such as HTTP 403 | Public creation, renewal and expiry are undisclosed. Domain `Last Modified` is valid; database refresh timestamps are not lifecycle dates. |
| `.bg` | IANA → `whois.register.bg` | Accept the registry's `name.bg (name.bg)` identity and multiline nameservers. Do not invent dates when none are returned. |
| `.ee` | IANA → `whois.tld.ee` | Validate the `Domain:` section's name; use only its `registered`, `changed`, `expire`. Preserve explicit numeric UTC offsets; contact, registrar and nameserver changes are excluded. |
| `.cl` | IANA → `whois.nic.cl` | Validate the domain echoed in the NIC Chile footer query URL and the record structure. Interpret explicit CLST as UTC−03:00 and CLT as UTC−04:00; unknown/invalid dates remain null. Accept matching `<domain>: no entries found.` only from this registry. |

Only complete, valid calendar dates are normalized. Numeric organisation IDs,
bare years, arbitrary prose and impossible calendar days are rejected. WHOIS
timestamps that omit a timezone are interpreted as UTC, consistently with the
existing API convention. This does not establish their original local timezone.

## Limits and diagnostics

Each lookup retains its 30-second total deadline, 5-second upstream deadline,
two-hop WHOIS referral cap, scheduler limits, deduplication and bounded cache.
There is no retry loop inside a lookup.

The total deadline uses a monotonic clock as well as an abort signal. The
scheduler checks it at admission, on dequeue and immediately before task
execution, so a delayed abort callback cannot start an already expired request.
Queue timeouts report how many milliseconds were spent waiting for a permit.
Results completed after the total deadline are not returned as successes or
cached. Queueing still consumes the 30-second budget; this does not increase
capacity or guarantee that 100 simultaneous slow lookups can finish.

- HTTP 429 and explicit WHOIS quota/rate-limit responses return
  `UPSTREAM_RATE_LIMITED` with `retryAfterSeconds`. The responding host enters
  cooldown; queued and subsequent requests to it fail fast. There is no switch
  to WHOIS, another bootstrap server, a proxy or another IP after a 429.
- A bare WHOIS `Access denied` / refusal returns `LOOKUP_FAILED`, without
  inventing a rate limit or a cooldown. An RDAP HTTP 403 can still fall back to
  authoritative WHOIS, as before.
- NIC.CH's `Requests of this client are not permitted` is an access refusal,
  not a malformed registration record or a quota response. It has no invented
  `retryAfterSeconds` and does not put other queries into cooldown.
- Error messages identify the public upstream hostname and request/discovery
  stage. If RDAP and WHOIS both fail, the final message retains the RDAP failure
  too. Clients should continue using `error.code`, not parsing messages.
- An empty IANA `whois:` field means no discovered WHOIS service; the parser
  must not read the following `status:` line as a hostname.

Network access varies by source IP. On 2026-10-16 an individual `.pt` query
timed out locally but succeeded from the deployment host. The `.au` RDAP query
succeeded locally and returned HTTP 403 from the deployment host, where the
same domain's WHOIS query succeeded. These samples establish neither permanent
availability nor the cause of historical rate limits.

## IPv6 container networking

The Compose app attaches to the `dualstack` user-defined bridge. IPv4 stays
enabled and `enable_ipv6: true` adds IPv6. On Docker Engine 27+, Docker allocates
an IPv6 subnet from its pools, or a unique local `/64` when no IPv6 pool is
configured. No fixed subnet or default-bridge `daemon.json` change is required.
See [Docker IPv6 networking](https://docs.docker.com/engine/daemon/ipv6/) and
the [Engine 27 networking changes](https://docs.docker.com/engine/release-notes/27/).

WHOIS TCP connections use Node's `autoSelectFamily` with a 250 ms connection
attempt budget before trying the next address. All addresses belong to the
same upstream hostname and share the existing 5-second upstream deadline and
scheduler permit. This only falls back when establishing the connection; it
does not retry a connected server's response, bypass cooldowns, or solve slow
reads. IPv4-only hosts remain supported. See
[Node net connection options](https://nodejs.org/api/net.html#socketconnectoptions-connectlistener).

IPv6 Internet access also needs a working host IPv6 route, forwarding and
Docker-managed firewall/NAT rules. Enabling a Compose network alone cannot
guarantee these prerequisites. Docker's iptables backend normally manages
forwarding; its nftables backend requires forwarding to be enabled separately.
See [Docker packet filtering](https://docs.docker.com/engine/network/packet-filtering-firewalls/).
This repository does not change host sysctls, firewall rules or daemon settings.
Creating the network can cause Docker itself to enable forwarding and install
firewall rules; review those host effects before deploying.

On 2026-10-17 the deployment host reached `whois.dns.pt:43` over IPv6 in less
than one second, while its IPv4 connection timed out. The existing container's
IPv6 attempt returned `ENETUNREACH` and its IPv4 attempt also timed out. The
running network had `EnableIPv6=false`; host IPv6 forwarding was `0`. These
were read-only checks. At that point the dual-stack repository changes had
not been deployed to that server.

A subsequent read-only check after the operator deployed `ceac2ae` found the
new `digga_dualstack` network active and host IPv6 forwarding already enabled
by Docker. A forced-IPv6 query from the container to `whois.dns.pt` connected
in 323 ms and returned registration dates in 1,042 ms. No manual forwarding
change was needed. To decide on another host, inspect both forwarding and
actual container egress; an assigned IPv6 address alone does not prove routing.

For an older stack, copy the updated Compose file when deploying the new image.
The separate `<project>_dualstack` network avoids trying to change an existing
IPv4-only network in place. After a future deployment, these read-only checks
show network addresses and try the actual WHOIS transport without credentials:

```bash
docker network inspect "${COMPOSE_PROJECT_NAME:-digga}_dualstack" \
  --format '{{.EnableIPv6}} {{json .IPAM.Config}}'
docker compose exec -T app node -e '
const net = require("node:net");
const started = Date.now();
const socket = net.connect({
  host: "whois.dns.pt", port: 43, autoSelectFamily: true,
  autoSelectFamilyAttemptTimeout: 250, signal: AbortSignal.timeout(5000)
}, () => {
  console.log({family: socket.remoteFamily, elapsedMs: Date.now() - started});
  socket.destroy();
});
socket.on("error", error => { console.error(error.code); process.exitCode = 1; });
'
```

Connection success alone does not verify parsed registration data; follow it
with one fresh authenticated `/api/whois` request. An existing cache hit is not
evidence that the new network can reach the upstream.

## Verification

`pnpm test` includes minimized raw-response regression fixtures.
`pnpm build && pnpm test:http` exercises production HTTP responses and OpenAPI
validation in public and Bearer/cookie-protected modes. Fixtures cover discovery
and registry cooldowns, refusal classification, 403 fallback, routing and dates.

For an optional individual network probe, run from the repository on the
network where the service will operate:

```bash
pnpm whois:probe abdn.ac.uk 24kitchen.pt 019mobile.co.il
```

This CLI accepts at most ten domains, runs sequentially, performs no retry, and
stops at the first rate limit. It prints the same result model as the API; it
does not need an API key or modify stored data. Choose a few representative
queries and respect registry access policies. Historical consumer snapshots
cannot provide a verified post-fix status for every domain without fresh
responses; keep measured outcomes separate from rule coverage.

## Registry references

- [IANA .pt](https://www.iana.org/domains/root/db/pt.html),
  [IANA .il](https://www.iana.org/domains/root/db/il.html),
  [IANA .au](https://www.iana.org/domains/root/db/au.html),
  [IANA .bg](https://www.iana.org/domains/root/db/bg.html).
- [Jisc WHOIS documentation](https://community.jisc.ac.uk/library/janet-services-documentation/whois)
  documents `whois.ja.net` for `.ac.uk`; this is archived documentation, checked
  against current individual replies.
- [NHS networking addressing](https://digital.nhs.uk/services/networking-addressing)
  identifies the NHS England DNS team as the `.nhs.uk` namespace operator.
- [auDA WHOIS Policy, clause 4.5 and Schedule A](https://www.auda.org.au/au-domain-names/au-rules-and-policies/whois-policy-2025-11/)
  distinguishes undisclosed creation/renewal/expiry from public modification.
- [NIC.LV WHOIS Policy](https://www.nic.lv/en/nic-whois-policy)
  lists public fields and database refresh / query limitations.
- [DNS.PT glossary](https://www.pt.pt/en/glossary/) and
  [WHOIS Policy](https://www.pt.pt/en/data-protection/pt-whois-policy/)
  describe registration/expiry data and access restrictions.
- [EE registry system](https://www.internet.ee/registrar-portal/new-registry-system)
  documents the registry WHOIS endpoint. The EE and CL adapters use verified
  individual port 43 replies, including their section and identity formats.
- [IANA tz discussion with explicit CLST/CLT offsets](https://lists.iana.org/hyperkitty/list/tz%40iana.org/thread/LVE7XSNGYUME75KS6M527ROS3LZDU3MD/?sort=date)
  records CLST `gmtoff=-10800` and CLT `gmtoff=-14400`. The CL adapter honors
  the explicit marker, rather than inferring an offset from current seasonal
  rules for the date.
