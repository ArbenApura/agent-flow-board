// SENDS ONE SETTINGS SECTION TO ITS FORM ACTION FROM THE BROWSER AND READS THE ANSWER, SO EACH SECTION SAVES ON ITS OWN (ADR-015)

// -- ENVS -- //
import { deserialize } from '$app/forms';

// -- TYPES -- //

export type ActionAnswer = { ok: boolean; message: string; data: Record<string, unknown> };

// -- FUNCTIONS -- //

/** Posts fields to `?/name` of the current page and returns what the action answered. A failure carries its plain message. */
export async function postAction(
	name: string,
	fields: Record<string, string>
): Promise<ActionAnswer> {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.set(k, v);
	const res = await fetch(`?/${name}`, {
		method: 'POST',
		body,
		headers: { 'x-sveltekit-action': 'true' }
	});
	const result = deserialize(await res.text());
	if (result.type === 'success')
		return { ok: true, message: '', data: (result.data ?? {}) as Record<string, unknown> };
	const data = ((result.type === 'failure' ? result.data : null) ?? {}) as Record<string, unknown>;
	return {
		ok: false,
		message: typeof data.message === 'string' ? data.message : 'That was not saved.',
		data
	};
}
