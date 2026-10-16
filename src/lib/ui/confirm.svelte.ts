// ASK BEFORE A FINAL ACTION: ONE QUESTION AT A TIME, ANSWERED WITH A PROMISE, SHOWN BY ConfirmHost IN THE ROOT LAYOUT

// -- TYPES -- //

export type Question = {
	title: string;
	/** Says what will happen and who it affects. */
	body: string;
	confirmLabel: string;
	tone?: 'primary' | 'danger';
};

// -- STATES -- //

class ConfirmStore {
	question = $state<Question | null>(null);
	private resolve: ((yes: boolean) => void) | null = null;

	ask(q: Question): Promise<boolean> {
		// A second question while one is open answers the first with no
		this.resolve?.(false);
		this.question = q;
		return new Promise((resolve) => (this.resolve = resolve));
	}

	answer(yes: boolean) {
		this.question = null;
		this.resolve?.(yes);
		this.resolve = null;
	}
}

export const confirmStore = new ConfirmStore();

/** Resolves true when the person confirms. Use it before an action that cannot be taken back. */
export const askConfirm = (q: Question) => confirmStore.ask(q);
