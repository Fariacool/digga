import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { deadlineSignal } from '../src/lib/whois-api/deadline.ts';
import { emptyRecord, LookupError } from '../src/lib/whois-api/model.ts';
import { UpstreamScheduler } from '../src/lib/whois-api/scheduler.ts';
import { WhoisService } from '../src/lib/whois-api/service.ts';

const timeout = (error: unknown) => error instanceof LookupError && error.code === 'LOOKUP_TIMEOUT';

describe('lookup deadlines include upstream queues', () => {
	it('rejects overdue admission even before the abort timer callback runs', async t => {
		let now = 0;
		t.mock.method(performance, 'now', () => now);
		const signal = deadlineSignal(1000);
		const scheduler = new UpstreamScheduler(1, 1);
		now = 1001;
		assert.equal(signal.aborted, false);
		await assert.rejects(
			scheduler.run('a', signal, async () => assert.fail('expired admission')),
			timeout,
		);
		assert.equal(await scheduler.run('a', deadlineSignal(1000), async () => 'ok'), 'ok');
	});
	it('does not dispatch overdue queued work when a permit is released', async t => {
		let now = 0;
		t.mock.method(performance, 'now', () => now);
		const scheduler = new UpstreamScheduler(1, 1);
		let finish!: () => void;
		const active = scheduler.run(
			'a',
			deadlineSignal(10_000),
			() =>
				new Promise<void>(resolve => {
					finish = resolve;
				}),
		);
		await delay(0);
		const signal = deadlineSignal(1000);
		const queued = scheduler.run('a', signal, async () => assert.fail('expired queued request'));
		const rejected = assert.rejects(
			queued,
			error => timeout(error) && /1001 ms queued/.test((error as Error).message),
		);
		now = 1001;
		assert.equal(signal.aborted, false);
		finish();
		await Promise.all([active, rejected]);
		assert.equal(
			await scheduler.run('b', deadlineSignal(1000), async () => 'released'),
			'released',
		);
	});
	it('rechecks the deadline between synchronous permit assignment and the task microtask', async t => {
		let now = 0;
		t.mock.method(performance, 'now', () => now);
		const scheduler = new UpstreamScheduler(1, 1);
		const signal = deadlineSignal(1000);
		const pending = scheduler.run('a', signal, async () => assert.fail('overdue microtask'));
		now = 1001;
		assert.equal(signal.aborted, false);
		await assert.rejects(
			pending,
			error => timeout(error) && /waiting for an upstream slot/.test((error as Error).message),
		);
		assert.equal(
			await scheduler.run('a', deadlineSignal(1000), async () => 'released'),
			'released',
		);
	});
	it('cancels a live queued deadline and leaves no work to start later', async () => {
		const scheduler = new UpstreamScheduler(1, 1);
		let finish!: () => void;
		const active = scheduler.run(
			'a',
			deadlineSignal(1000),
			() =>
				new Promise<void>(resolve => {
					finish = resolve;
				}),
		);
		await delay(0);
		const queued = scheduler.run('a', deadlineSignal(20), async () =>
			assert.fail('cancelled queue'),
		);
		await Promise.all([assert.rejects(queued, timeout), delay(40)]);
		finish();
		await active;
		assert.equal(await scheduler.run('a', deadlineSignal(1000), async () => 'ok'), 'ok');
	});
	it('does not return or cache a provider success completed after the total deadline', async t => {
		let now = 0;
		t.mock.method(performance, 'now', () => now);
		let calls = 0;
		const service = new WhoisService(async () => {
			if (++calls === 1) now = 30_001;
			return emptyRecord('rdap', 'https://rdap.example');
		});
		const expired = await service.lookup('example.com');
		assert.equal(expired.ok, false);
		assert.equal(!expired.ok && expired.error.code, 'LOOKUP_TIMEOUT');
		const fresh = await service.lookup('example.com');
		assert.equal(fresh.ok && fresh.meta.cached, false);
		assert.equal(fresh.ok, true);
		const cached = await service.lookup('example.com');
		assert.equal(cached.ok && cached.meta.cached, true);
		assert.equal(calls, 2);
	});
});
