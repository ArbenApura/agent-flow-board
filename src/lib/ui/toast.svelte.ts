// TOAST WRAPPER OVER svelte-sonner: SHORT NOTICES THAT FADE, FAILURES THAT STAY UNTIL DISMISSED, AND PROMISE TOASTS FOR AWAITED ACTIONS

// -- DEP-MODULES -- //
import { toast as sonner } from 'svelte-sonner';

// -- TYPES -- //

export type ToastAction = { label: string; run: () => void | Promise<void> };
export type PromiseText<T> = {
	loading: string;
	/** A text, or null to take the loading toast away (the person is shown something else, such as a dialog). */
	success: string | ((value: T) => string | null);
	error: string | ((error: unknown) => string);
	action?: ToastAction;
};

// -- CONSTANTS -- //

export const FADE_MS = 4500;
/** A notice with a button (Undo) stays long enough to be used. */
export const ACTION_FADE_MS = 10_000;
/** Errors and warnings stay until the person dismisses them, so a failure is never missed. */
export const STAY = Number.POSITIVE_INFINITY;

// -- FUNCTIONS -- //

/** Sonner's action button shape from ours; a failed action says so instead of vanishing with the notice. */
export function actionOf(action?: ToastAction) {
	if (!action) return undefined;
	return {
		label: action.label,
		onClick: async () => {
			try {
				await action.run();
			} catch {
				sonner.error('That did not work.', { duration: STAY });
			}
		}
	};
}

export const toast = {
	success: (text: string, action?: ToastAction) =>
		sonner.success(text, { duration: action ? ACTION_FADE_MS : FADE_MS, action: actionOf(action) }),
	info: (text: string, action?: ToastAction) =>
		sonner.info(text, { duration: action ? ACTION_FADE_MS : FADE_MS, action: actionOf(action) }),
	warning: (text: string, action?: ToastAction) =>
		sonner.warning(text, { duration: STAY, action: actionOf(action) }),
	error: (text: string, action?: ToastAction) =>
		sonner.error(text, { duration: STAY, action: actionOf(action) }),
	/** One toast for the whole life of a request: loading, then success (fades) or error (stays). Resolves or rejects like the promise. */
	promise: <T>(work: Promise<T> | (() => Promise<T>), text: PromiseText<T>): Promise<T> => {
		const id = sonner.loading(text.loading, { duration: STAY });
		// A function that throws before it returns a promise is a rejection too, so the loading toast never sticks
		const run = typeof work === 'function' ? Promise.resolve().then(work) : work;
		return run.then(
			(value) => {
				const said = typeof text.success === 'function' ? text.success(value) : text.success;
				if (said === null) sonner.dismiss(id);
				else
					sonner.success(said, {
						id,
						duration: text.action ? ACTION_FADE_MS : FADE_MS,
						action: actionOf(text.action)
					});
				return value;
			},
			(error: unknown) => {
				sonner.error(typeof text.error === 'function' ? text.error(error) : text.error, {
					id,
					duration: STAY
				});
				throw error;
			}
		);
	},
	dismiss: (id?: string | number) => sonner.dismiss(id)
};
