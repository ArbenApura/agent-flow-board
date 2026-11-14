// SVELTEKIT use:enhance THAT SHOWS ONE TOAST FOR THE LIFE OF A FORM SUBMIT: LOADING, THEN SUCCESS (FADES) OR ERROR (STAYS)

// IMPORTED DEP-TYPES
import type { SubmitFunction } from '$app/forms';
// IMPORTED MODULES
import { toast } from './toast.svelte.js';

// -- TYPES -- //

export type ToastEnhanceOptions = {
	loading: string;
	/** The success text, or null for a form whose next page is the feedback (the loading toast is simply taken away). */
	success: string | null;
	/** The form shows a refusal itself (form.message), so a failure only takes the loading toast away. */
	inline?: boolean;
	/** Same as update({ reset }). The forms here keep what was typed, so it is false unless asked. */
	reset?: boolean;
	/** A stable toast id for this kind of form, so a repeated failure replaces the earlier toast. */
	id?: string;
	/** The form's own SubmitFunction (a confirm step). It runs first; when it cancels, no toast is made. */
	before?: SubmitFunction;
	/** The busy flag goes on here. */
	onStart?: () => void;
	/** The busy flag goes off here, after update has run. */
	onDone?: () => void;
};

// -- CONSTANTS -- //

/** A loading toast whose result callback never arrives goes away by itself after this long. */
export const LOADING_MS = 60_000;
export const GENERIC_ERROR = 'That did not work. Try again.';

/** The toast now showing for each form, so a second submit takes the first one away. */
const live = new WeakMap<HTMLFormElement, string | number>();

// -- FUNCTIONS -- //

function refusal(data: unknown): string {
	if (data && typeof data === 'object' && 'message' in data) {
		const message = (data as { message: unknown }).message;
		if (typeof message === 'string' && message) return message;
	}
	return GENERIC_ERROR;
}

/** Toasts fire only from the result callback, never from an effect on the form prop. */
export function toastEnhance(options: ToastEnhanceOptions): SubmitFunction {
	return async (input) => {
		// The confirm step goes first. When it cancels, nothing is shown and nothing is left behind
		let cancelled = false;
		const own = await options.before?.({
			...input,
			cancel: () => {
				cancelled = true;
				input.cancel();
			}
		});
		if (cancelled) return;

		const earlier = live.get(input.formElement);
		if (earlier !== undefined) toast.dismiss(earlier);
		const id = toast.loading(options.loading, { id: options.id, duration: LOADING_MS });
		live.set(input.formElement, id);
		options.onStart?.();

		return async (outcome) => {
			try {
				const { result } = outcome;
				if (result.type === 'success' || result.type === 'redirect') {
					// On a redirect the toast outlives the navigation, the Toaster sits in the root layout
					if (options.success === null) toast.dismiss(id);
					else toast.settle(id, 'success', options.success);
				} else if (result.type === 'failure') {
					if (options.inline) toast.dismiss(id);
					else toast.settle(id, 'error', refusal(result.data));
				} else toast.settle(id, 'error', GENERIC_ERROR);
				if (own) await own(outcome);
				else await outcome.update({ reset: options.reset ?? false });
			} finally {
				if (live.get(input.formElement) === id) live.delete(input.formElement);
				options.onDone?.();
			}
		};
	};
}
