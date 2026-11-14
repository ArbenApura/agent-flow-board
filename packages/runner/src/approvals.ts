// THE OWNER'S APPROVAL OF COMMANDS AND SCRIPTS A LOCAL RUNNER WOULD RUN (SPEC 10, L1)
// A check script or a build, start or dev-server command is code. On a local runner it runs on its owner's machine, so a new or
// changed one waits for the owner's yes. The approval is kept for the exact text: change one character and it asks again.
// A hosted runner runs in a throwaway isolated container, so it needs no approval. `--trust-all` is for tests and CI only.

// IMPORTED DEP-MODULES
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// -- TYPES -- //

export type Kind = 'command' | 'script';
type Entry = { kind: Kind; label: string; text: string; at: string };
type Book = { approved: Record<string, Entry>; pending: Record<string, Entry> };

export class NeedsApproval extends Error {
	constructor(
		readonly kind: Kind,
		readonly label: string
	) {
		super(
			`The ${kind} "${label}" is new or changed, so it needs its owner's approval before this runner runs it. Run "afb-runner approve" on the machine this runner runs on.`
		);
		this.name = 'NeedsApproval';
	}
}

// -- FUNCTIONS -- //

const keyOf = (project: string, kind: Kind, text: string) =>
	createHash('sha256').update(`${project}\n${kind}\n${text}`).digest('hex');

export class Approvals {
	constructor(
		private readonly file: string,
		private readonly mode: 'local' | 'hosted' | 'trust-all'
	) {}

	private read(): Book {
		if (!existsSync(this.file)) return { approved: {}, pending: {} };
		try {
			return JSON.parse(readFileSync(this.file, 'utf8')) as Book;
		} catch {
			return { approved: {}, pending: {} };
		}
	}

	private write(book: Book) {
		mkdirSync(dirname(this.file), { recursive: true });
		writeFileSync(this.file, JSON.stringify(book, null, 2));
	}

	/** Returns when the text may run; throws NeedsApproval and remembers it as pending when it may not. */
	require(project: string, kind: Kind, label: string, text: string): void {
		if (this.mode !== 'local') return;
		const book = this.read();
		const key = keyOf(project, kind, text);
		if (book.approved[key]) return;
		book.pending[key] = { kind, label, text, at: new Date().toISOString() };
		this.write(book);
		throw new NeedsApproval(kind, label);
	}

	pending(): ({ key: string } & Entry)[] {
		return Object.entries(this.read().pending).map(([key, e]) => ({ key, ...e }));
	}

	approve(key: string): boolean {
		const book = this.read();
		const e = book.pending[key];
		if (!e) return false;
		delete book.pending[key];
		book.approved[key] = e;
		this.write(book);
		return true;
	}

	reject(key: string): boolean {
		const book = this.read();
		if (!book.pending[key]) return false;
		delete book.pending[key];
		this.write(book);
		return true;
	}
}
