import { setTimeout as delay } from 'node:timers/promises';

import { normalizeLookupDomain } from '../src/lib/whois-api/model.ts';
import { RegistrationProvider } from '../src/lib/whois-api/provider.ts';
import { UpstreamScheduler } from '../src/lib/whois-api/scheduler.ts';
import { WhoisService } from '../src/lib/whois-api/service.ts';

const inputs = process.argv.slice(2);
if (!inputs.length || inputs.length > 10) {
	console.error('Usage: pnpm whois:probe <domain> [domain ...] (1–10 individual lookups)');
	process.exitCode = 1;
} else {
	// This is an explicit, sequential diagnostic probe, not a bulk refresh job.
	// Normalize all inputs before making the first request.
	const domains = [...new Set(inputs.map(normalizeLookupDomain))];
	const provider = new RegistrationProvider(new UpstreamScheduler(1, 1));
	const service = new WhoisService((domain, signal) => provider.lookup(domain, signal));
	const results = [];
	for (const [index, domain] of domains.entries()) {
		if (index) await delay(1000);
		const result = await service.lookup(domain);
		results.push(result);
		if (!result.ok && result.error.code === 'UPSTREAM_RATE_LIMITED') break;
	}
	console.log(
		JSON.stringify(
			{
				generatedAt: new Date().toISOString(),
				requested: domains.length,
				completed: results.length,
				unprobed: domains.slice(results.length),
				results,
			},
			null,
			2,
		),
	);
}
