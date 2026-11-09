// THE BOARD OF A LOCAL RUN: NOTHING
// `check run --local` runs a script with the same sandbox, preview, sign-in and guard rails as a board run, and makes no board call at all: no request, claim, heartbeat,
// upload or finish. The run is written against this stand-in, which has no address and no token and so cannot reach a network, whatever path the run takes (a signal, a
// sandbox error, a thrown error). A run that exists on the board is never touched.

// -- TYPES -- //
import type { RunnerBoard } from './board.js';

// -- TYPES -- //

/** The calls a run makes on its board. A real RunnerBoard has them, and so does a local run's stand-in. */
export type BoardLike = Pick<RunnerBoard, 'claim' | 'release' | 'beat' | 'finish' | 'upload'>;

// -- FUNCTIONS -- //

/** A board that does nothing and answers nothing. */
export class LocalSink implements BoardLike {
	claim(): Promise<null> {
		return Promise.resolve(null);
	}
	release(): Promise<number> {
		return Promise.resolve(0);
	}
	beat(): Promise<{ ok: boolean }> {
		return Promise.resolve({ ok: true });
	}
	finish(): Promise<unknown> {
		return Promise.resolve(undefined);
	}
	upload(): Promise<string> {
		return Promise.resolve('');
	}
}
