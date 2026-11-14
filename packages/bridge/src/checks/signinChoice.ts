// WHICH SAVED SIGN-IN A RUN OPENS WITH, AND WHEN IT REFUSES TO RUN WITHOUT ONE
// The profile is chosen in order: --profile, a "// afb-profile: NAME" line in the script, the default. A repo registration's sign-in is bound to the loopback and to the
// sealed test project host it was made on, so a run on any preview port finds it and a run on another project does not. A named profile (a role proof) is never replaced
// by another sign-in: when it is missing, damaged, expired or made on another project the run does not start. The default profile only says why it was not used.

// IMPORTED TYPES
import type { Registration } from './types.js';
// IMPORTED MODULES
import {
	bindBaseFor,
	DEFAULT_PROFILE,
	expiryNote,
	loadProfileChecked,
	profileKey,
	retargetOrigins
} from './profiles.js';

// -- TYPES -- //

export type SigninChoice = {
	/** The browser state to open with, or null for a signed out run. */
	state: unknown;
	/** One plain line for the run log (an expired default sign-in, one made on another project). */
	note: string | null;
	/** One plain sentence when the run must not start (a named profile that cannot be used). */
	failure: string | null;
	profile: string;
};

// -- FUNCTIONS -- //

/** The sealed test project a preview talks to, as one plain key (its hosts, sorted), or null when it has none. */
export const sealedKey = (hosts?: string[]): string | null =>
	hosts && hosts.length ? [...hosts].sort().join(',') : null;

const loginCommand = (registration: string, profile: string) =>
	`agent-flow-board check login ${registration}${profile === DEFAULT_PROFILE ? '' : ` --as ${profile}`} --org <slug>`;

/**
 * The sign-in for one run. `sealedHost` is the sealed test project host of the preview, `null` when it has none, and `undefined` when the preview has not started yet
 * (the check before the preview only looks at whether the profile exists and opens). `named` is true when the person or the script named the registration or the profile.
 */
export function chooseSignin(input: {
	org: string;
	registration: Pick<Registration, 'name' | 'repo'>;
	scriptRegistration: string | null | undefined;
	profile?: string | null;
	named: boolean;
	previewBaseUrl: string;
	sealedHost?: string | null;
	throwawayDatabase?: boolean;
}): SigninChoice {
	const profile = input.profile || DEFAULT_PROFILE;
	const isNamed = profile !== DEFAULT_PROFILE;
	const none = (note: string | null = null): SigninChoice => ({
		state: null,
		note,
		failure: null,
		profile
	});
	const fail = (failure: string): SigninChoice => ({ state: null, note: null, failure, profile });
	const name = input.registration.name;
	// A run only opens signed in as a registration its script names, unless the person named the registration or the profile on the run
	if (!input.named && input.scriptRegistration?.toLowerCase() !== name.toLowerCase()) return none();
	if (input.registration.repo && input.throwawayDatabase)
		return isNamed
			? fail(
					`The preview of ${name} runs on a throwaway database, so the saved sign-in "${profile}" would not exist in it. Seal the registration's test project (check secrets import) first.`
				)
			: none();
	const key = profileKey(
		bindBaseFor(input.registration, new URL(input.previewBaseUrl).origin),
		profile
	);
	const { profile: saved, damaged } = loadProfileChecked(input.org, name, key);
	if (damaged)
		return isNamed
			? fail(
					`The saved sign-in "${profile}" of ${name} is damaged. Make it again: ${loginCommand(name, profile)}`
				)
			: none(`The saved sign-in is damaged, make it again (${loginCommand(name, profile)}).`);
	if (!saved)
		return isNamed
			? fail(
					`There is no saved sign-in named "${profile}" for ${name}. Make it with: ${loginCommand(name, profile)}`
				)
			: none();
	if (
		input.registration.repo &&
		input.sealedHost !== undefined &&
		(saved.sealedHost ?? null) !== input.sealedHost
	) {
		const made = saved.sealedHost ?? 'no test project';
		const now = input.sealedHost ?? 'no test project';
		return isNamed
			? fail(
					`The saved sign-in "${profile}" of ${name} was made on ${made}, but this run uses ${now}. Make it again: ${loginCommand(name, profile)}`
				)
			: none(`A saved sign-in was made on ${made}, but this run uses ${now}, so it was not used.`);
	}
	const expired = expiryNote(saved);
	if (expired && isNamed)
		return fail(
			`The saved sign-in "${profile}" of ${name} has expired. Make it again: ${loginCommand(name, profile)}`
		);
	const state = input.registration.repo
		? retargetOrigins(saved.state, input.previewBaseUrl)
		: saved.state;
	return { state, note: expired, failure: null, profile };
}
