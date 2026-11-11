// THE LIVE ENDPOINTS AS A TRANSPORT: HOW A FAILED CALL IS SORTED (AFB-20261111-0035, 8.6)

// -- DEP-MODULES -- //
import { afterEach, describe, expect, it, vi } from 'vitest';
// -- MODULES -- //
import { ApiError } from '../board/api';
import { httpTransport, sortFailure } from './noteTransport';
import { TransportError, toBase64 } from './noteProvider';

// -- FUNCTIONS -- //

const reply = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('sortFailure', () => {
	it('sorts a note that is gone, a full note, a dropped network and anything else', () => {
		expect(sortFailure(new ApiError(404, 'NOT_FOUND', 'x')).kind).toBe('gone');
		expect(sortFailure(new ApiError(403, 'FORBIDDEN', 'x')).kind).toBe('gone');
		expect(
			sortFailure(
				new ApiError(
					400,
					'INVALID',
					'This note has too much unsaved live text to take more typing.'
				)
			).kind
		).toBe('full');
		expect(sortFailure(new ApiError(400, 'INVALID', 'The update is not valid.')).kind).toBe('size');
		expect(sortFailure(new ApiError(500, 'ERROR', 'x')).kind).toBe('other');
		expect(sortFailure(new TypeError('Failed to fetch'), false).kind).toBe('offline');
		expect(sortFailure(new TypeError('Failed to fetch'), true).kind).toBe('other');
		const kept = new TransportError('full');
		expect(sortFailure(kept)).toBe(kept);
	});
});

describe('httpTransport', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('a person who lost access gets a stopped transport, not a retry', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => reply(404, { error: { code: 'NOT_FOUND', message: 'No such note.' } }))
		);
		const t = httpTransport('org', 'AFB', 'N-1');
		await expect(t.post(1, [new Uint8Array([1])])).rejects.toMatchObject({ kind: 'gone' });
		await expect(t.read(0)).rejects.toMatchObject({ kind: 'gone' });
	});

	it('posts base64, asks to outlive the page when told, and reads updates back as bytes', async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init: RequestInit) => {
				calls.push({ url, init });
				if (init.method === 'POST') return reply(200, { ok: true, epoch: 1, seqs: [4], last: 4 });
				return reply(200, {
					epoch: 1,
					markdown: 'm',
					last: 4,
					checkpointSeq: 2,
					updates: [{ seq: 4, update: toBase64(new Uint8Array([7, 8])) }]
				});
			})
		);
		const t = httpTransport('org', 'AFB', 'N-1');
		await t.post(1, [new Uint8Array([1, 2, 3])], { keepalive: true });
		expect(calls[0].url).toBe('/api/v1/orgs/org/projects/AFB/notes/N-1/live/updates');
		expect(JSON.parse(String(calls[0].init.body))).toEqual({ epoch: 1, updates: ['AQID'] });
		expect(calls[0].init.keepalive).toBe(true);
		const r = await t.read(3);
		expect(calls[1].url).toContain('/live/updates?after=3');
		expect(r.updates).toEqual([{ seq: 4, update: new Uint8Array([7, 8]) }]);
		expect(r.checkpointSeq).toBe(2);
	});
});
