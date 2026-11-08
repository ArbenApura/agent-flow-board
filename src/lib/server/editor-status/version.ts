// WHEN A PERSON'S COPY OF THE EDITOR STATUS MOD IS OLDER THAN THE ONE THE BOARD SERVES (AFB-20261108-0856)
// The bridge reports the version it finds in the installed mod and the board decides here, so the rule and the wording live in one
// place. The text is a constant template: only the two version numbers are put in, and both passed the version check first.

// -- CONSTANTS -- //

const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

// -- FUNCTIONS -- //

/** The three numbers of a plain major.minor.patch version, or null for anything else (a tag, a range, a long number). */
function parts(version: string | undefined): [number, number, number] | null {
	const found = version ? VERSION.exec(version) : null;
	return found ? [Number(found[1]), Number(found[2]), Number(found[3])] : null;
}

/** True only when both are plain versions and `installed` is lower than `served`. */
export function isOlder(installed: string | undefined, served: string): boolean {
	const a = parts(installed);
	const b = parts(served);
	if (!a || !b) return false;
	for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
	return false;
}

/** The one line shown at the start of a conversation, or null when the mod is current, newer, missing or not a version. */
export function updateNotice(installed: string | undefined, served: string): string | null {
	return isOlder(installed, served)
		? `Agent Flow Board editor status: mod ${served} is available (you have ${installed}). Re-run the setup prompt from Connect a tool.`
		: null;
}
