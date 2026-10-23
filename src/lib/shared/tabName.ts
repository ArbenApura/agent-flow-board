// THE TAB NAME RULES SHARED BY THE DATABASE VALIDATION, THE API AND THE MCP TOOLS (SPEC 5)

// -- CONSTANTS -- //

/** Tab names are 1 to 3 words, UPPERCASE with underscores, at most 30 characters (SPEC 5). */
export const TAB_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){0,2}$/;

// -- FUNCTIONS -- //

/** Turns a free title into a tab name (up to 3 words) when the author gave none. */
export function tabNameFromTitle(title: string): string {
	const words = title
		.toUpperCase()
		.replace(/[^A-Z0-9\s]/g, ' ')
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 3);
	let name = words.join('_');
	while (name.length > 30 && words.length > 1) {
		words.pop();
		name = words.join('_');
	}
	return (name || 'ITEM').slice(0, 30).replace(/_+$/, '') || 'ITEM';
}
