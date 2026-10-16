# Registry format fixtures

These are minimized, anonymized fixtures based on individual authoritative port
43 responses captured on 2026-10-16, locally and from the deployment network.
They retain field labels, date syntax, section boundaries and nameserver layout.
Domains, contacts, organisations and identifiers are synthetic. `il-legacy.txt`
exercises the older domain-history format without an explicit `assigned` field;
the future contact changes in both IL fixtures are deliberate regression traps.

- PT: `whois.dns.pt`; day/month/year timestamps.
- Jisc: `whois.ja.net`; `.ac.uk`, multiline fields and ordinal English dates.
- IL: `whois.isoc.org.il`; assignment, validity and scoped change history.
- PE: `kero.yachay.pe`; database footer with no domain dates.
- LV: `whois.nic.lv`; `[Whois] Updated` and organisation `RegNr` values.
- BG: `whois.register.bg`; repeated domain identity and multiline nameservers.
- AU: `whois.auda.org.au`; domain modification without creation or expiration.

The HTTP preload uses the same fixtures, so tests exercise actual `whoiser`
parsing, discovery, fallback, normalization and the production HTTP contract.
No fixture switch is available in the production application.
