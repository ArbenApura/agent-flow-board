// COMPOSING A MOCKUP PAGE FROM ITS PARTS (AFB-20261114-0409, D.2)
// A bundle is a skeleton (the app's shell, with named slots) and parts. The server joins them into the one HTML page that is stored,
// served and read as before. Markup parts (screens, sheets, head) go in as they are; styles, motion and behaviour are wrapped in their
// own tag; the contract is stored with the version and never goes into the page. Pure functions, no database.

// -- TYPES -- //

export type ComposePart = {
	kind:
		| 'skeleton'
		| 'head'
		| 'style'
		| 'motion'
		| 'screen'
		| 'surface'
		| 'fixtures'
		| 'behavior'
		| 'contract'
		| 'shell';
	key: string;
	content: string;
};

// -- CONSTANTS -- //

/** The slot of each kind of part in a skeleton. Style and motion share one slot. */
export const SLOTS = {
	head: '<!--afb-part:head-->',
	styles: '<!--afb-part:styles-->',
	screens: '<!--afb-part:screens-->',
	surfaces: '<!--afb-part:surfaces-->',
	fixtures: '<!--afb-part:fixtures-->',
	behavior: '<!--afb-part:behavior-->'
} as const;

const SLOT_OF: Partial<Record<ComposePart['kind'], keyof typeof SLOTS>> = {
	head: 'head',
	style: 'styles',
	motion: 'styles',
	screen: 'screens',
	surface: 'surfaces',
	fixtures: 'fixtures',
	behavior: 'behavior'
};

export const PART_KEY = /^[a-z0-9][a-z0-9_-]{0,59}$/i;
/** The key of the style part the bridge compiles from the project's Tailwind. It is excluded from the read. */
export const GENERATED_STYLE_KEY = 'generated';
/** The key of the style part whose @apply rules the bridge compiles into the generated style. It stays in the page, inert. */
export const APPLY_STYLE_KEY = 'apply';

// -- FUNCTIONS -- //

const safeScript = (text: string) => text.replace(/<\/(script)/gi, '<\\/$1');
const safeStyle = (text: string) => text.replace(/<\/(style)/gi, '<\\/$1');

/** What one part becomes inside the page. */
export function renderPart(part: ComposePart): string {
	switch (part.kind) {
		case 'style':
			// The style the bridge compiled from the project's Tailwind is machine output: marked, so nobody has to read it
			if (part.key === APPLY_STYLE_KEY)
				// The source of the rules the bridge compiled into the generated style: readable, but not applied itself
				return `<style media="not all" data-afb-part="style:${part.key}">\n${safeStyle(part.content)}\n</style>`;
			return part.key === GENERATED_STYLE_KEY
				? `<style data-afb-generated data-afb-part="style:${part.key}">\n${safeStyle(part.content)}\n</style>`
				: `<style data-afb-part="style:${part.key}">\n${safeStyle(part.content)}\n</style>`;
		case 'motion':
			return `<style data-afb-part="motion:${part.key}">\n${safeStyle(part.content)}\n</style>`;
		case 'behavior':
			return `<script data-afb-part="behavior:${part.key}">\n${safeScript(part.content)}\n</script>`;
		case 'fixtures':
			return `<script type="application/json" id="fixtures-${part.key}" data-afb-part="fixtures:${part.key}">\n${safeScript(part.content)}\n</script>`;
		default:
			return part.content;
	}
}

/**
 * Joins a skeleton and its parts into one page. The parts keep the order they were given in. A part whose slot the skeleton does
 * not have is refused by name, so nothing a person wrote is dropped without a word; a slot with no part is left empty.
 */
export function composeMockup(
	skeleton: string,
	parts: ComposePart[]
): { html: string; slots: string[] } {
	const grouped = new Map<keyof typeof SLOTS, string[]>();
	for (const p of parts) {
		const slot = SLOT_OF[p.kind];
		if (!slot) continue;
		const list = grouped.get(slot) ?? [];
		list.push(renderPart(p));
		grouped.set(slot, list);
	}
	let html = skeleton;
	const used: string[] = [];
	for (const [slot, marker] of Object.entries(SLOTS) as [keyof typeof SLOTS, string][]) {
		const list = grouped.get(slot);
		if (list?.length && !html.includes(marker))
			throw new Error(
				`The skeleton has no ${marker}, so its ${slot === 'styles' ? 'style and motion' : slot} parts have nowhere to go. Add the marker to the skeleton where they belong.`
			);
		if (html.includes(marker)) used.push(marker);
		html = html.split(marker).join(list?.length ? list.join('\n') : '');
	}
	return { html, slots: used };
}

/** The Keep and Free notes a contract implies, for a version pushed without notes of its own. */
export function notesFromContract(contract: {
	refs?: { ref: string; binding: 'bound' | 'free' | 'keep'; reason?: string }[];
}): { keep: string; free: string } {
	const refs = contract.refs ?? [];
	const keep = refs.filter((r) => r.binding === 'keep');
	const free = refs.filter((r) => r.binding === 'free');
	return {
		keep: keep.length
			? `Keep (from the contract): ${keep.map((r) => `${r.ref}${r.reason ? ` (${r.reason})` : ''}`).join('; ')}.`
			: '',
		free: free.length
			? `Free (from the contract): ${free.map((r) => `${r.ref}${r.reason ? ` (${r.reason})` : ''}`).join('; ')}. Everything not listed is built as drawn.`
			: ''
	};
}
