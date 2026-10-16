// THE "UI CHANGES" ROW RULES SHARED BY THE DATABASE VALIDATION, THE API AND THE RUNNER (SPEC 10.1)
// The local `yarn ui-shots` and the runner read these same lists, so there is one copy of the vocabulary.

// -- CONSTANTS -- //

/** The fixed level vocabulary. A level may carry its own selector, written level=css:<selector>. */
export const UI_LEVELS = [
	'title',
	'section',
	'body',
	'label',
	'button-primary',
	'button',
	'button-icon',
	'input',
	'card',
	'row',
	'icon',
	'image'
] as const;
export const UI_VIEWPORTS = [1440, 390] as const;
export const UI_THEMES = ['light', 'dark'] as const;

/** One state step: click:, wait: or scroll: followed by a selector or a text locator. Opening only, never submitting. */
export const STATE_STEP = /^(click|wait|scroll):\S.*$/;

/** Tab names are 1 to 3 words, UPPERCASE with underscores, at most 30 characters (SPEC 5). */
export const TAB_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){0,2}$/;

// -- FUNCTIONS -- //

/** The level name of a spec such as button-primary=css:.save-bar button. */
export const levelName = (spec: string) => spec.split('=')[0];

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
