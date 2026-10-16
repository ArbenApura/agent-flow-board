// TOAST STORE: SHORT NOTICES THAT FADE, AND FAILURES THAT STAY UNTIL DISMISSED

// -- TYPES -- //

export type ToastTone = 'success' | 'info' | 'warning' | 'danger';
export type Toast = {
	id: number;
	tone: ToastTone;
	text: string;
	action?: { label: string; run: () => void | Promise<void> };
};

// -- CONSTANTS -- //

const FADE_MS = 4500;
/** A notice with a button (Undo) stays long enough to be used. */
const ACTION_FADE_MS = 10_000;

// -- STATES -- //

class ToastStore {
	items = $state<Toast[]>([]);
	private next = 1;
	private timers = new Map<number, ReturnType<typeof setTimeout>>();
	private fades = new Map<number, number>();

	private arm(id: number) {
		clearTimeout(this.timers.get(id));
		this.timers.set(
			id,
			setTimeout(() => this.dismiss(id), this.fades.get(id) ?? FADE_MS)
		);
	}

	add(tone: ToastTone, text: string, action?: Toast['action']): number {
		const id = this.next++;
		this.items = [...this.items, { id, tone, text, action }];
		// Errors and warnings stay until the person dismisses them, so a failure is never missed
		if (tone === 'success' || tone === 'info') {
			this.fades.set(id, action ? ACTION_FADE_MS : FADE_MS);
			this.arm(id);
		}
		return id;
	}

	/** The pointer or the keyboard is on the notice: it stays while it is being read or used. */
	hold(id: number) {
		clearTimeout(this.timers.get(id));
		this.timers.delete(id);
	}

	/** The pointer left: the notice fades again after its time. */
	release(id: number) {
		if (this.fades.has(id)) this.arm(id);
	}

	dismiss(id: number) {
		clearTimeout(this.timers.get(id));
		this.timers.delete(id);
		this.fades.delete(id);
		this.items = this.items.filter((t) => t.id !== id);
	}
}

export const toasts = new ToastStore();
export const toast = {
	success: (text: string, action?: Toast['action']) => toasts.add('success', text, action),
	info: (text: string, action?: Toast['action']) => toasts.add('info', text, action),
	warning: (text: string, action?: Toast['action']) => toasts.add('warning', text, action),
	error: (text: string, action?: Toast['action']) => toasts.add('danger', text, action)
};
