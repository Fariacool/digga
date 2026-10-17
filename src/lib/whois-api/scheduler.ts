import { deadlineExpired } from './deadline.ts';
import { LookupError } from './model.ts';

type Job = {
	server: string;
	signal: AbortSignal;
	start: () => void;
	reject: (error: Error) => void;
	onAbort: () => void;
	timeout: () => LookupError;
};

// A permit covers a real outgoing connection, including discovery and referrals.
export class UpstreamScheduler {
	private active = 0;
	private perServer = new Map<string, number>();
	private queue: Job[] = [];
	private cooldowns = new Map<string, number>();
	private maxConcurrent: number;
	private perServerConcurrent: number;
	private maxQueued: number;

	constructor(maxConcurrent: number, perServerConcurrent: number, maxQueued = 200) {
		this.maxConcurrent = maxConcurrent;
		this.perServerConcurrent = perServerConcurrent;
		this.maxQueued = maxQueued;
	}

	cooldown(server: string, seconds: number) {
		this.cooldowns.set(
			server,
			Math.max(this.cooldowns.get(server) ?? 0, Date.now() + seconds * 1000),
		);
		this.drain();
	}

	private rateLimit(server: string): LookupError | null {
		const until = this.cooldowns.get(server);
		if (!until) return null;
		if (until <= Date.now()) {
			this.cooldowns.delete(server);
			return null;
		}
		return new LookupError(
			'UPSTREAM_RATE_LIMITED',
			`The upstream registration server ${server} is rate limited. Retry later.`,
			Math.max(1, Math.ceil((until - Date.now()) / 1000)),
		);
	}

	run<T>(server: string, signal: AbortSignal, task: () => Promise<T>): Promise<T> {
		if (deadlineExpired(signal))
			return Promise.reject(new LookupError('LOOKUP_TIMEOUT', 'The lookup timed out.'));
		const limited = this.rateLimit(server);
		if (limited) return Promise.reject(limited);
		if (this.queue.length >= this.maxQueued) {
			return Promise.reject(new LookupError('BUSY', 'The lookup queue is full. Retry later.', 1));
		}
		return new Promise<T>((resolve, reject) => {
			const queuedAt = performance.now();
			const job: Job = {
				server,
				signal,
				reject,
				onAbort: () => {
					const index = this.queue.indexOf(job);
					if (index !== -1) this.queue.splice(index, 1);
					reject(job.timeout());
				},
				timeout: () =>
					new LookupError(
						'LOOKUP_TIMEOUT',
						`The lookup timed out while waiting for an upstream slot (${Math.max(0, Math.round(performance.now() - queuedAt))} ms queued).`,
					),
				start: () => {
					this.active++;
					this.perServer.set(server, (this.perServer.get(server) ?? 0) + 1);
					void Promise.resolve()
						.then(() => {
							// Recheck at execution too: the permit was assigned synchronously,
							// but this microtask may run after the total deadline.
							if (deadlineExpired(signal)) throw job.timeout();
							return task();
						})
						.then(resolve, reject)
						.finally(() => {
							this.active--;
							const count = (this.perServer.get(server) ?? 1) - 1;
							if (count) this.perServer.set(server, count);
							else this.perServer.delete(server);
							this.drain();
						});
				},
			};
			signal.addEventListener('abort', job.onAbort, { once: true });
			this.queue.push(job);
			this.drain();
		});
	}

	private drain() {
		// Skip saturated hosts so one busy registry cannot block other registries.
		for (let index = 0; index < this.queue.length;) {
			const job = this.queue[index];
			const expired = deadlineExpired(job.signal);
			const limited = expired ? null : this.rateLimit(job.server);
			if (limited || expired) {
				this.queue.splice(index, 1);
				job.signal.removeEventListener('abort', job.onAbort);
				job.reject(limited ?? job.timeout());
			} else if (
				this.active < this.maxConcurrent &&
				(this.perServer.get(job.server) ?? 0) < this.perServerConcurrent
			) {
				this.queue.splice(index, 1);
				job.signal.removeEventListener('abort', job.onAbort);
				job.start();
			} else {
				index++;
			}
		}
	}
}
