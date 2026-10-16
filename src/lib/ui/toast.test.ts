import { beforeEach, describe, expect, it, vi } from 'vitest';

const sonner = vi.hoisted(() => ({
	success: vi.fn(() => 'id'),
	info: vi.fn(() => 'id'),
	warning: vi.fn(() => 'id'),
	error: vi.fn(() => 'id'),
	loading: vi.fn(() => 'load-id'),
	dismiss: vi.fn()
}));
vi.mock('svelte-sonner', () => ({ toast: sonner }));

import { ACTION_FADE_MS, FADE_MS, STAY, toast } from './toast.svelte';

describe('toast wrapper', () => {
	beforeEach(() => vi.clearAllMocks());

	it('fades a success but keeps an error and a warning until dismissed', () => {
		toast.success('Saved');
		toast.error('Could not save');
		toast.warning('Careful');
		expect(sonner.success).toHaveBeenCalledWith(
			'Saved',
			expect.objectContaining({ duration: FADE_MS })
		);
		expect(sonner.error).toHaveBeenCalledWith(
			'Could not save',
			expect.objectContaining({ duration: STAY })
		);
		expect(sonner.warning).toHaveBeenCalledWith(
			'Careful',
			expect.objectContaining({ duration: STAY })
		);
	});

	it('gives a notice with an Undo button a longer life', () => {
		toast.success('Deleted', { label: 'Undo', run: () => {} });
		expect(sonner.success).toHaveBeenCalledWith(
			'Deleted',
			expect.objectContaining({ duration: ACTION_FADE_MS })
		);
	});

	it('promise: loading first, then the success replaces it under the same id', async () => {
		const value = await toast.promise(Promise.resolve(3), {
			loading: 'Saving',
			success: (n) => `Saved ${n}`,
			error: 'Failed'
		});
		expect(value).toBe(3);
		expect(sonner.loading).toHaveBeenCalledWith('Saving', expect.anything());
		expect(sonner.success).toHaveBeenCalledWith(
			'Saved 3',
			expect.objectContaining({ id: 'load-id', duration: FADE_MS })
		);
	});

	it('promise: a success text of null takes the loading toast away', async () => {
		await toast.promise(Promise.resolve(1), {
			loading: 'Saving',
			success: () => null,
			error: 'Failed'
		});
		expect(sonner.dismiss).toHaveBeenCalledWith('load-id');
		expect(sonner.success).not.toHaveBeenCalled();
	});

	it('promise: a function that throws before it returns a promise is a rejection, so the loading toast is replaced', async () => {
		await expect(
			toast.promise(
				() => {
					throw new Error('sync');
				},
				{ loading: 'Saving', success: 'Saved', error: (e) => `Failed: ${(e as Error).message}` }
			)
		).rejects.toThrow('sync');
		expect(sonner.error).toHaveBeenCalledWith(
			'Failed: sync',
			expect.objectContaining({ id: 'load-id' })
		);
	});

	it('an action that fails says so instead of vanishing', async () => {
		toast.success('Deleted', {
			label: 'Undo',
			run: () => {
				throw new Error('no');
			}
		});
		const opts = sonner.success.mock.calls[0] as unknown as [
			string,
			{ action: { onClick: () => Promise<void> } }
		];
		await opts[1].action.onClick();
		expect(sonner.error).toHaveBeenCalledWith(
			'That did not work.',
			expect.objectContaining({ duration: STAY })
		);
	});

	it('promise: a refusal turns the loading toast into a staying error and rethrows', async () => {
		await expect(
			toast.promise(Promise.reject(new Error('no')), {
				loading: 'Saving',
				success: 'Saved',
				error: 'Not allowed'
			})
		).rejects.toThrow('no');
		expect(sonner.error).toHaveBeenCalledWith(
			'Not allowed',
			expect.objectContaining({ id: 'load-id', duration: STAY })
		);
	});
});
