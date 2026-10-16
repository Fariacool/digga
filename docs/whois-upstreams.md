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

Only complete, valid calendar dates are normalized. Numeric organisation IDs,
bare years, arbitrary prose and impossible calendar days are rejected. WHOIS
timestamps that omit a timezone are interpreted as UTC, consistently with the
existing API convention. This does not establish their original local timezone.

## Limits and diagnostics

Each lookup retains its 30-second total deadline, 5-second upstream deadline,
two-hop WHOIS referral cap, scheduler limits, deduplication and bounded cache.
There is no retry loop inside a lookup.

- HTTP 429 and explicit WHOIS quota/rate-limit responses return
  `UPSTREAM_RATE_LIMITED` with `retryAfterSeconds`. The responding host enters
  cooldown; queued and subsequent requests to it fail fast. There is no switch
  to WHOIS, another bootstrap server, a proxy or another IP after a 429.
- A bare WHOIS `Access denied` / refusal returns `LOOKUP_FAILED`, without
  inventing a rate limit or a cooldown. An RDAP HTTP 403 can still fall back to
  authoritative WHOIS, as before.
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
