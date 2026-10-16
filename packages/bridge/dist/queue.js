// THE OFFLINE WRITE QUEUE (SPEC 6.3). A WRITE WHILE THE BOARD IS UNREACHABLE IS QUEUED AND SAID TO BE QUEUED, NEVER ANSWERED WITH A MADE UP RESULT.
// Replay keeps the original order. A write that fails on replay holds the later writes for the same item; other items continue.
// -- DEP-MODULES -- //
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
// -- FUNCTIONS -- //
export class Queue {
	file;
	constructor(file) {
		this.file = file;
	}
	read() {
		if (!existsSync(this.file)) return [];
		try {
			return JSON.parse(readFileSync(this.file, 'utf8'));
		} catch {
			return [];
		}
	}
	write(list) {
		mkdirSync(dirname(this.file), { recursive: true });
		writeFileSync(this.file, JSON.stringify(list, null, 1), { mode: 0o600 });
	}
	list = () => this.read();
	enqueue(name, args) {
		const list = this.read();
		const id = `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		const key = String(args.item ?? args.id ?? args.sessionId ?? 'none');
		// The id doubles as the request id, so replaying after a half finished send can never write twice
		const entry = {
			id,
			at: new Date().toISOString(),
			name,
			args: {
				...args,
				requestId: typeof args.requestId === 'string' ? args.requestId : `afb-${id}`
			},
			key,
			state: 'queued'
		};
		list.push(entry);
		this.write(list);
		return entry;
	}
	drop(id) {
		const list = this.read();
		const next = list.filter((e) => e.id !== id);
		if (next.length === list.length) return false;
		this.write(next);
		return true;
	}
	/** Puts a held write back in the line so the next replay tries it again. */
	retry(id) {
		const list = this.read();
		const e = list.find((x) => x.id === id);
		if (!e) return false;
		e.state = 'queued';
		delete e.reason;
		this.write(list);
		return true;
	}
	/** Sends queued writes in order. Stops at the first sign the board is still unreachable. */
	async replay(send) {
		const list = this.read();
		const heldKeys = new Set(list.filter((e) => e.state === 'held').map((e) => e.key));
		let sent = 0;
		let held = 0;
		const keep = [];
		let offline = false;
		for (const e of list) {
			if (offline || e.state === 'held' || heldKeys.has(e.key)) {
				keep.push(e.state === 'held' || offline ? e : { ...e, state: 'queued' });
				if (!offline && e.state !== 'held') held++;
				continue;
			}
			const r = await send(e);
			if (r.kind === 'ok') {
				sent++;
			} else if (r.kind === 'refused') {
				keep.push({ ...e, state: 'held', reason: r.reason });
				heldKeys.add(e.key);
				held++;
			} else {
				offline = true;
				keep.push(e);
			}
		}
		this.write(keep);
		return { sent, held, offline };
	}
}
