import { beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => ({
	promise: vi.fn(async (work: Promise<unknown>) => work)
}));
const nav = vi.hoisted(() => ({
	goto: vi.fn(async () => {}),
	invalidateAll: vi.fn(async () => {})
}));
vi.mock('./toast.svelte.js', () => ({ toast }));
vi.mock('$app/navigation', () => nav);

import { signOut } from './signOut';

// The real browser navigation is not covered here, only what the handler asks for
const submit = () => {
	const preventDefault = vi.fn();
	const event = {
		preventDefault,
		currentTarget: { action: 'http://localhost/sign-out' }
	} as unknown as SubmitEvent;
	return { event, preventDefault };
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => ({ type: 'opaqueredirect', status: 0, ok: false }))
	);
});

describe('signOut', () => {
	it('posts to /sign-out, toasts and goes to the sign in page', async () => {
		const { event, preventDefault } = submit();
		await signOut(event);
		expect(preventDefault).toHaveBeenCalled();
		expect(fetch).toHaveBeenCalledWith('http://localhost/sign-out', {
			method: 'POST',
			redirect: 'manual'
		});
		expect(toast.promise).toHaveBeenCalledOnce();
		expect(nav.goto).toHaveBeenCalledWith('/sign-in', { invalidateAll: true });
	});

	it('stays on the page when the server fails', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ status: 500 }))
		);
		await signOut(submit().event);
		expect(nav.goto).not.toHaveBeenCalled();
	});
});
