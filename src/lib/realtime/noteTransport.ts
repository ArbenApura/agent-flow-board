// THE NOTE'S LIVE ENDPOINTS AS A TRANSPORT FOR THE PROVIDER (AFB-20261111-0035, 8.3)
// The only place that knows the addresses and the base64 form. A failure is sorted into the few kinds the provider acts on.

// IMPORTED MODULES
import { ApiError, api } from '../board/api';
import {
	TransportError,
	fromBase64,
	toBase64,
	type CheckpointReply,
	type NoteTransport,
	type PostReply,
	type ReadReply
} from './noteProvider';

// -- CONSTANTS -- //

/** The start of the server's words when a note holds more live text than it takes. */
const FULL_TEXT = 'This note has too much unsaved live text';

// -- FUNCTIONS -- //

/** Sorts a failed call: no network, a note that is gone or closed to the person, a full note, or anything else. */
export function sortFailure(
	e: unknown,
	online = typeof navigator === 'undefined' || navigator.onLine !== false
): TransportError {
	if (e instanceof TransportError) return e;
	if (e instanceof ApiError) {
		if (e.status === 404 || e.status === 403) return new TransportError('gone', e.message);
		if (e.code === 'INVALID' && e.message.startsWith(FULL_TEXT))
			return new TransportError('full', e.message);
		// The server refused the content itself (too large, not a valid update): sending it again can never work
		if (e.code === 'INVALID') return new TransportError('size', e.message);
		return new TransportError('other', e.message);
	}
	// A fetch that never reached the server
	return new TransportError(online ? 'other' : 'offline');
}

/** The live endpoints of one note over the REST API. */
export function httpTransport(org: string, project: string, note: string): NoteTransport {
	const live = (suffix: string) => `/projects/${project}/notes/${note}/live${suffix}`;
	const call = async <T>(path: string, init?: Parameters<typeof api>[2]): Promise<T> => {
		if (typeof navigator !== 'undefined' && navigator.onLine === false)
			throw new TransportError('offline');
		try {
			return await api<T>(org, path, init);
		} catch (e) {
			throw sortFailure(e);
		}
	};
	return {
		read: async (after): Promise<ReadReply> => {
			const r = await call<
				Omit<ReadReply, 'updates'> & { updates: { seq: number; update: string }[] }
			>(live(`/updates?after=${after}`));
			return {
				epoch: r.epoch,
				markdown: r.markdown,
				last: r.last,
				checkpointSeq: r.checkpointSeq,
				updates: r.updates.map((u) => ({ seq: u.seq, update: fromBase64(u.update) }))
			};
		},
		post: (epoch, updates, opts) =>
			call<PostReply>(live('/updates'), {
				method: 'POST',
				body: {
					epoch,
					updates: updates.map(toBase64),
					...(opts?.seed ? { seed: true } : {})
				},
				keepalive: opts?.keepalive
			}),
		checkpoint: (req, opts) =>
			call<CheckpointReply>(live('/checkpoint'), {
				method: 'POST',
				body: req,
				keepalive: opts?.keepalive
			}),
		presence: async (data, opts) => {
			await call(live('/presence'), {
				method: 'POST',
				body: { data: toBase64(data) },
				keepalive: opts?.keepalive
			});
		}
	};
}
