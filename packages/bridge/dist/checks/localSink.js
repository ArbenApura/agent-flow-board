// THE BOARD OF A LOCAL RUN: NOTHING
// `check run --local` runs a script with the same sandbox, preview, sign-in and guard rails as a board run, and makes no board call at all: no request, claim, heartbeat,
// upload or finish. The run is written against this stand-in, which has no address and no token and so cannot reach a network, whatever path the run takes (a signal, a
// sandbox error, a thrown error). A run that exists on the board is never touched.
// -- FUNCTIONS -- //
/** A board that does nothing and answers nothing. */
export class LocalSink {
    claim() {
        return Promise.resolve(null);
    }
    release() {
        return Promise.resolve(0);
    }
    beat() {
        return Promise.resolve({ ok: true });
    }
    finish() {
        return Promise.resolve(undefined);
    }
    upload() {
        return Promise.resolve('');
    }
}
