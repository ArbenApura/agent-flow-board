// ONE SHARED READER OF THE COMMAND-LINE LIST FLAGS (rule R2, AFB-20261114-0611), USED BY cli.ts AND checks/command.ts
// The harmless lists (--widths, --render-states, --screens, --states) take a comma list ("408,1280"), one
// quoted list ("408 1280" as one word) or separate words ("408 1280" as two words): PowerShell turns an
// unquoted comma list into separate words, which used to keep only the first. The lists whose value
// widens what a check may reach or seal (--write-allowlist, --extra-hosts, --keys, connect --project) are
// NOT converted: they take the comma form or one quoted list and refuse a stray extra word.

// -- CONSTANTS -- //

/** A host name of the usual shape (labels of letters, digits and dashes, no scheme, no path). */
export const HOSTNAME_PATTERN =
	/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;

// -- FUNCTIONS -- //

/** The value of a flag: the word right after it, or undefined when the flag is absent. */
export function flagValue(args: readonly string[], name: string): string | undefined {
	if (!args.includes(name)) return undefined;
	return args[args.indexOf(name) + 1];
}

/** The comma list of a harmless flag: "a,b", "a b" (one word) and separate words all join to "a,b". */
export function listFlag(args: readonly string[], name: string): string | undefined {
	const first = flagValue(args, name);
	if (first === undefined) return undefined;
	const rest: string[] = [];
	for (let i = args.indexOf(name) + 2; i < args.length && !args[i].startsWith('--'); i++)
		rest.push(args[i] ?? '');
	return [first, ...rest].join(',').trim().replace(/\s+/g, ',');
}

/**
 * A strict list (rule R2): comma form or one quoted list only. A word after the value that is not a
 * flag is refused in one plain sentence, never swallowed. Every entry must match the pattern.
 */
export function strictList(
	args: readonly string[],
	name: string,
	pattern: RegExp,
	what: string
): string[] | undefined {
	const first = flagValue(args, name);
	if (first === undefined) return undefined;
	const next = args[args.indexOf(name) + 2];
	if (next !== undefined && !next.startsWith('--'))
		throw new Error(
			`${name} takes one comma list or one quoted list ("${name} a,b"), not the extra word "${next.slice(0, 40)}".`
		);
	const list = first
		.split(',')
		.map((v) => v.trim())
		.filter(Boolean);
	for (const v of list)
		if (!pattern.test(v)) throw new Error(`${name} takes ${what}, not "${v.slice(0, 40)}".`);
	return list;
}
