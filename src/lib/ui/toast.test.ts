import { describe, expect, it, vi } from 'vitest';
import { toast, toasts } from './toast.svelte';

describe('toast store', () => {
	it('fades a success but keeps an error until it is dismissed', () => {
		vi.useFakeTimers();
		const ok = toast.success('Saved');
		const bad = toast.error('Could not save');
		expect(toasts.items.map((t) => t.id)).toEqual([ok, bad]);
		vi.advanceTimersByTime(5000);
		expect(toasts.items.map((t) => t.id)).toEqual([bad]);
		toasts.dismiss(bad);
		expect(toasts.items).toHaveLength(0);
		vi.useRealTimers();
	});
});
