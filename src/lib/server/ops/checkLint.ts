// A CHECK SCRIPT IS READ BEFORE IT IS SAVED (AFB-20261105-0653): WHAT THE AFB-CHECKS TOOL REFUSES AT RUN TIME IS REFUSED HERE IN SECONDS,
// NOT AFTER A BUILD OF THREE OR FOUR MINUTES. Only calls the tool is known to block are listed; the rest is left to the run.

// -- CONSTANTS -- //

/** A call the afb-checks tool blocks, how to spot it in the text, and what to do instead. */
const BLOCKED: { pattern: RegExp; what: string; fix: string }[] = [
	{
		pattern: /\.\s*addInitScript\s*\(/,
		what: 'addInitScript is blocked by the afb-checks tool',
		fix: 'set the state after the page has loaded with page.evaluate, or through the page itself'
	},
	{
		pattern: /\.\s*goto\s*\(\s*['"`]about:blank/i,
		what: 'navigating to about:blank is blocked by the afb-checks tool',
		fix: 'go straight to the page under test with page.goto(path) and wait for what you need'
	}
];

// -- FUNCTIONS -- //

/** The reasons a script cannot run in the tool, each with its fix. Empty when nothing known to be blocked is found. */
export function lintCheckScript(script: string): string[] {
	// Comment lines do not run, so a note that names a blocked call is not a finding
	const code = script
		.split('\n')
		.filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
		.join('\n');
	return BLOCKED.filter((b) => b.pattern.test(code)).map((b) => `${b.what}: ${b.fix}.`);
}
