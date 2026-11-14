// THE CONTRACT OF A MOCKUP: WHAT IS BOUND, KEPT OR FREE, HOW ITS PARTS PAIR WITH THE APP, AND WHICH WIDTHS AND STATES MATTER (AFB-20261114-0409, D.5)
// One file replaces three places that held the same facts: the Keep and Free notes, the design brief's Free list and the compare manifest.
// It is stored with the version as a part and never goes into the page.

// -- DEP-MODULES -- //
import { z } from 'zod';

// -- CONSTANTS -- //

const REF = z
	.string()
	.min(1)
	.max(100)
	.regex(/^[A-Za-z0-9][A-Za-z0-9_:.-]*$/);

export const mockupContract = z.object({
	/** Every region the build must care about: bound (built as drawn), keep (matters most) or free (may differ, with a reason). */
	refs: z
		.array(
			z.object({
				ref: REF,
				binding: z.enum(['bound', 'free', 'keep']),
				/** For free: which property may differ (omitted means any), and why. */
				property: z.string().max(60).optional(),
				reason: z.string().max(300).optional()
			})
		)
		.max(500)
		.default([]),
	/** The app selector that pairs with each data-ref, for check compare. */
	pairs: z
		.array(
			z.object({
				ref: REF,
				appSelector: z.string().min(1).max(300),
				screen: z.string().max(80).optional(),
				states: z.array(z.string().max(40)).max(12).optional()
			})
		)
		.max(500)
		.default([]),
	widths: z.array(z.number().int().min(200).max(4000)).max(12).optional(),
	/** The states a screen can be opened in and how (the URL hook, or manual). */
	states: z
		.array(
			z.object({
				name: z.string().min(1).max(40),
				hook: z.enum(['query', 'hash', 'manual']).default('query')
			})
		)
		.max(24)
		.optional()
});
export type MockupContract = z.infer<typeof mockupContract>;

// -- FUNCTIONS -- //

/** Reads a contract from JSON text, with one plain sentence when it is not valid. */
export function parseContract(text: string): MockupContract {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error('The contract is not valid JSON.');
	}
	const parsed = mockupContract.safeParse(raw);
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		throw new Error(
			`The contract is not valid: ${first?.path.join('.') || 'it'} ${first?.message ?? ''}`.trim()
		);
	}
	return parsed.data;
}

/** What is wrong between a contract and the page it belongs to: refs that the page does not have, and free rules with no reason. */
export function contractProblems(contract: MockupContract, html: string): string[] {
	const out: string[] = [];
	const have = new Set(
		[...html.matchAll(/\bdata-ref\s*=\s*["']([^"']{1,100})["']/gi)].map((m) => m[1])
	);
	const missing = [
		...new Set([...contract.refs.map((r) => r.ref), ...contract.pairs.map((p) => p.ref)])
	].filter((r) => !have.has(r));
	if (missing.length)
		out.push(
			`The contract names ${missing.length} data-ref${missing.length === 1 ? '' : 's'} the page does not have (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', ...' : ''}).`
		);
	const noReason = contract.refs.filter((r) => r.binding === 'free' && !r.reason?.trim());
	if (noReason.length)
		out.push(
			`${noReason.length} free line${noReason.length === 1 ? ' has' : 's have'} no reason (${noReason
				.slice(0, 5)
				.map((r) => r.ref)
				.join(', ')}). A free difference needs one.`
		);
	return out;
}

/** The structured Free rules of a contract in the form check compare reads: ref, property and reason. */
export function freeRulesOf(
	contract: MockupContract
): { ref: string; property: string; reason: string }[] {
	return contract.refs
		.filter((r) => r.binding === 'free')
		.map((r) => ({ ref: r.ref, property: r.property ?? '*', reason: r.reason ?? '' }));
}
