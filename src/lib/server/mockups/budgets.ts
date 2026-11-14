// WHAT A PAGE COSTS TO READ, AND THE WARNINGS THAT KEEP IT SMALL (AFB-20261114-0409, B.4)
// The authored source has to be read by whoever builds from it, so its size is a cost. A page lists its parts and how many
// authored characters there are, and warns about the things that make it big without carrying design: pictures embedded in the
// page, hand-written CSS next to a kit, heavy script, markup repeated again and again, keyframes buried in generated CSS.

// IMPORTED MODULES
import { rangeChars, segmentMockupHtml } from './segments';

// -- TYPES -- //

export type MockupReadCost = {
	/** Characters in the page, then the part of it that has to be read and the part that does not. */
	totalChars: number;
	authoredChars: number;
	excludedChars: number;
	parts: number;
	/** About four characters to a token. A guide, not a promise. */
	estimatedTokens: number;
	/** Calls of 12,000 characters it takes to read the authored source once. */
	readCalls: number;
};

// -- CONSTANTS -- //

const PART_CHARS = 12_000;
const AUTHORED_CSS_WITH_KIT = 20_000;
const SCRIPT_LIMIT = 40_000;
const REPEAT_CHUNK = 120;
const REPEAT_TIMES = 12;
const REPEAT_COVER = 6_000;

// -- FUNCTIONS -- //

/** The cost of reading a page: the parts it is cut into and the authored characters in them. */
export function readCostOf(html: string): MockupReadCost {
	const { segments, excluded } = segmentMockupHtml(html);
	const excludedChars = rangeChars(excluded);
	const authoredChars = Math.max(0, html.length - excludedChars);
	return {
		totalChars: html.length,
		authoredChars,
		excludedChars,
		parts: segments.length,
		estimatedTokens: Math.round(authoredChars / 4),
		readCalls: Math.ceil(authoredChars / PART_CHARS)
	};
}

const sizeOf = (blocks: RegExpMatchArray[]) => blocks.reduce((n, m) => n + m[0].length, 0);

/** Warnings about what makes a page big without carrying design. `hasKit` is true when the project has a saved kit. */
export function lintMockupBudgets(html: string, hasKit: boolean): string[] {
	const out: string[] = [];
	const pictures = [...html.matchAll(/<img\b[^>]*\bsrc\s*=\s*"data:[^"]{400,}"/gi)];
	if (pictures.length)
		out.push(
			`${pictures.length} picture${pictures.length === 1 ? ' is' : 's are'} embedded in the page (${pictures.reduce((n, m) => n + m[0].length, 0).toLocaleString('en-US')} characters of picture data). Put them in the project kit as img.k-<name>{content:url(...)} rules and keep the img tags, so the page stays small.`
		);
	const authored = [
		...html.matchAll(/<style\b(?![^>]*data-afb-generated)[^>]*>[\s\S]*?<\/style>/gi)
	];
	const css = sizeOf(authored);
	if (hasKit && css > AUTHORED_CSS_WITH_KIT)
		out.push(
			`The page carries ${css.toLocaleString('en-US')} characters of its own CSS although the project has a kit. Use the project's classes, and compile only the missing ones with the project's own tool; keep custom keyframes, easing and the reduced-motion rule in one small style of their own.`
		);
	const scripts = sizeOf([...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi)]);
	if (scripts > SCRIPT_LIMIT)
		out.push(
			`The page script is ${scripts.toLocaleString('en-US')} characters. Keep behaviour to what the build must reproduce (the interactions and the motion) and move sample data into rows of markup or a small fixtures object.`
		);
	const generated = [...html.matchAll(/<style\b[^>]*data-afb-generated[^>]*>[\s\S]*?<\/style>/gi)];
	if (generated.some((m) => /@keyframes\b/i.test(m[0])))
		out.push(
			'Keyframes are inside generated CSS. Put @keyframes, easing tokens and the reduced-motion rule in an authored <style>, because generated CSS is not read and the motion would be lost.'
		);
	// The same stretch of markup again and again is a list that should be a template or fewer sample rows
	// Each tag start with the text after it, digits made alike: a list of rows gives the same stretch again and again
	const body = html
		.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
		.replace(/\s+/g, ' ')
		.replace(/\d+/g, '#');
	const seen = new Map<string, number>();
	for (const m of body.matchAll(/<[a-z]/gi)) {
		const chunk = body.slice(m.index, (m.index ?? 0) + REPEAT_CHUNK);
		if (chunk.length < REPEAT_CHUNK) continue;
		seen.set(chunk, (seen.get(chunk) ?? 0) + 1);
	}
	const repeated = [...seen.values()].filter((n) => n >= REPEAT_TIMES);
	const covered = repeated.reduce((n, v) => n + v * REPEAT_CHUNK, 0);
	if (covered >= REPEAT_COVER)
		out.push(
			`Markup repeats heavily (${repeated.length} stretches appear ${REPEAT_TIMES} times or more, about ${covered.toLocaleString('en-US')} characters). Show a few sample rows and name the rest in the notes, so the page stays readable.`
		);
	return out;
}
