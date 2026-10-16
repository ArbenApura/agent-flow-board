import { beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => ({
	loading: vi.fn(),
	settle: vi.fn(),
	dismiss: vi.fn()
}));
vi.mock('./toast.svelte.js', () => ({ toast }));

import { GENERIC_ERROR, LOADING_MS, toastEnhance } from './toastEnhance';

// The real enhance (abort, navigation) is not covered here, only the callbacks this helper returns
type Input = Parameters<ReturnType<typeof toastEnhance>>[0];
type Callback = Exclude<Awaited<ReturnType<ReturnType<typeof toastEnhance>>>, void>;
type Outcome = Parameters<Callback>[0];

let counter = 0;
const form = () => ({}) as HTMLFormElement;
const input = (formElement = form(), cancel = vi.fn()) =>
	({ formElement, cancel }) as unknown as Input;
const outcome = (result: unknown) =>
	({ result, update: vi.fn(async () => {}) }) as unknown as Outcome;

async function submit(
	options: Parameters<typeof toastEnhance>[0],
	result: unknown,
	formElement = form()
) {
	const callback = await toastEnhance(options)(input(formElement));
	const out = outcome(result);
	await (callback as (o: Outcome) => Promise<void>)(out);
	return out;
}

describe('toastEnhance', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		toast.loading.mockImplementation(() => `t${++counter}`);
	});

	it('shows loading with a finite life, then success, and runs update without a reset', async () => {
		const out = await submit({ loading: 'Working', success: 'Done.' }, { type: 'success' });
		expect(toast.loading).toHaveBeenCalledWith('Working', { id: undefined, duration: LOADING_MS });
		expect(toast.settle).toHaveBeenCalledWith(expect.any(String), 'success', 'Done.');
		expect((out as unknown as { update: ReturnType<typeof vi.fn> }).update).toHaveBeenCalledWith({
			reset: false
		});
	});

	it('shows the success toast on a redirect and lets update run', async () => {
		const out = await submit({ loading: 'Working', success: 'Created.' }, { type: 'redirect' });
		expect(toast.settle).toHaveBeenCalledWith(expect.any(String), 'success', 'Created.');
		expect((out as unknown as { update: ReturnType<typeof vi.fn> }).update).toHaveBeenCalled();
	});

	it('takes the loading toast away when success is null', async () => {
		await submit({ loading: 'Working', success: null }, { type: 'redirect' });
		expect(toast.dismiss).toHaveBeenCalled();
		expect(toast.settle).not.toHaveBeenCalled();
	});

	it('shows the server message on a failure', async () => {
		await submit(
			{ loading: 'Working', success: 'Done.' },
			{ type: 'failure', data: { message: 'Not allowed.' } }
		);
		expect(toast.settle).toHaveBeenCalledWith(expect.any(String), 'error', 'Not allowed.');
	});

	it('falls back to the generic text when a failure has no message', async () => {
		await submit({ loading: 'Working', success: 'Done.' }, { type: 'failure', data: {} });
		expect(toast.settle).toHaveBeenCalledWith(expect.any(String), 'error', GENERIC_ERROR);
	});

	it('only takes the loading toast away on an inline failure', async () => {
		await submit(
			{ loading: 'Working', success: 'Done.', inline: true },
			{ type: 'failure', data: { message: 'Bad name.' } }
		);
		expect(toast.dismiss).toHaveBeenCalled();
		expect(toast.settle).not.toHaveBeenCalled();
	});

	it('shows a generic error when the action throws', async () => {
		await submit(
			{ loading: 'Working', success: 'Done.' },
			{ type: 'error', error: new Error('x') }
		);
		expect(toast.settle).toHaveBeenCalledWith(expect.any(String), 'error', GENERIC_ERROR);
	});

	it('makes no toast when the confirm step cancels', async () => {
		const cancel = vi.fn();
		const before = vi.fn(({ cancel: c }: { cancel: () => void }) => c());
		const callback = await toastEnhance({ loading: 'Working', success: 'Done.', before })(
			input(form(), cancel)
		);
		expect(callback).toBeUndefined();
		expect(cancel).toHaveBeenCalled();
		expect(toast.loading).not.toHaveBeenCalled();
	});

	it('runs the confirm step first and then shows loading when it lets the submit go', async () => {
		const before = vi.fn(() => undefined);
		await submit({ loading: 'Working', success: 'Done.', before }, { type: 'success' });
		expect(before).toHaveBeenCalled();
		expect(toast.loading).toHaveBeenCalled();
	});

	it('takes the first toast of a form away when it is submitted again', async () => {
		const f = form();
		await toastEnhance({ loading: 'Working', success: 'Done.' })(input(f));
		const first = toast.loading.mock.results[0].value;
		await toastEnhance({ loading: 'Working', success: 'Done.' })(input(f));
		expect(toast.dismiss).toHaveBeenCalledWith(first);
	});

	it('runs the busy hooks and always ends with onDone, even when update throws', async () => {
		const onStart = vi.fn();
		const onDone = vi.fn();
		const callback = await toastEnhance({ loading: 'Working', success: 'Done.', onStart, onDone })(
			input()
		);
		const out = outcome({ type: 'success' });
		(out as unknown as { update: ReturnType<typeof vi.fn> }).update.mockRejectedValue(
			new Error('x')
		);
		await expect((callback as (o: Outcome) => Promise<void>)(out)).rejects.toThrow('x');
		expect(onStart).toHaveBeenCalled();
		expect(onDone).toHaveBeenCalled();
	});

	it('takes away the loading toast it made, by its id, on a null success and on an inline failure', async () => {
		toast.loading.mockReturnValueOnce('mine');
		await submit({ loading: 'Working', success: null }, { type: 'success' });
		expect(toast.dismiss).toHaveBeenCalledWith('mine');
		toast.loading.mockReturnValueOnce('mine2');
		await submit(
			{ loading: 'Working', success: 'Done.', inline: true },
			{ type: 'failure', data: {} }
		);
		expect(toast.dismiss).toHaveBeenCalledWith('mine2');
	});

	it('forgets a finished toast, so the next submit of the same form dismisses nothing', async () => {
		const f = form();
		await submit({ loading: 'Working', success: 'Done.' }, { type: 'success' }, f);
		toast.dismiss.mockClear();
		await toastEnhance({ loading: 'Working', success: 'Done.' })(input(f));
		expect(toast.dismiss).not.toHaveBeenCalled();
	});

	it('leaves the toast of another form alone', async () => {
		await toastEnhance({ loading: 'Working', success: 'Done.' })(input(form()));
		await toastEnhance({ loading: 'Working', success: 'Done.' })(input(form()));
		expect(toast.dismiss).not.toHaveBeenCalled();
	});

	it('passes reset through to update and runs onDone on a redirect', async () => {
		const onDone = vi.fn();
		const out = await submit(
			{ loading: 'Working', success: 'Done.', reset: true, onDone },
			{ type: 'redirect' }
		);
		expect((out as unknown as { update: ReturnType<typeof vi.fn> }).update).toHaveBeenCalledWith({
			reset: true
		});
		expect(onDone).toHaveBeenCalled();
	});

	it('hands the outcome to the callback the confirm step returned, instead of calling update', async () => {
		const own = vi.fn(async () => {});
		const before = vi.fn(() => own);
		const out = await submit({ loading: 'Working', success: 'Done.', before }, { type: 'success' });
		expect(own).toHaveBeenCalled();
		expect((out as unknown as { update: ReturnType<typeof vi.fn> }).update).not.toHaveBeenCalled();
	});
});
