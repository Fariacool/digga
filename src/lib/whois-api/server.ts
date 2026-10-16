import 'server-only';

import { whoisConfig } from './config.ts';
import { RegistrationProvider } from './provider.ts';
import { UpstreamScheduler } from './scheduler.ts';
import { WhoisService } from './service.ts';

const processState = globalThis as typeof globalThis & { diggaWhoisApi?: WhoisService };

export function whoisService(): WhoisService {
	// Route handlers may be separate bundles: keep single and batch on one process-wide service.
	if (!processState.diggaWhoisApi) {
		const config = whoisConfig();
		const provider = new RegistrationProvider(
			new UpstreamScheduler(config.maxConcurrent, config.perServerConcurrent),
		);
		processState.diggaWhoisApi = new WhoisService((domain, signal) =>
			provider.lookup(domain, signal),
		);
	}
	return processState.diggaWhoisApi;
}
