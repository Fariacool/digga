// AbortSignal.timeout fires on the event loop, so a queued task can reach its
// deadline before the abort callback runs. Keep a monotonic deadline as well.
const deadlines = new WeakMap<AbortSignal, number>();

export function deadlineSignal(timeoutMs: number): AbortSignal {
	const deadline = performance.now() + timeoutMs;
	const signal = AbortSignal.timeout(timeoutMs);
	deadlines.set(signal, deadline);
	return signal;
}

export function deadlineExpired(signal: AbortSignal): boolean {
	const deadline = deadlines.get(signal);
	return signal.aborted || (deadline !== undefined && performance.now() >= deadline);
}
