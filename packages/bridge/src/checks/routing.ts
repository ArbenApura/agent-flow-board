// WHICH REGISTRATION A RUN USES. Never a guess. In order: (1) the one named on the run, (2) the one saved on the check, (3) a "// afb-registration: NAME" line in the first 12 lines of
// the script, (4) the only registration of the board project. Otherwise a refusal with a code an agent can act on and the list of choices.

// -- TYPES -- //
import type { Registration } from './types.js';
// -- MODULES -- //
import { REGISTRATION_NAME, listRegistrations } from './registry.js';

// -- TYPES -- //

export type RegistrationCode =
	'REGISTRATION_REQUIRED' | 'REGISTRATION_MISMATCH' | 'REGISTRATION_UNKNOWN';

// -- CONSTANTS -- //

const HEADER_LINES = 12;
const HEADER = /^\s*\/\/\s*afb-registration:\s*([A-Za-z0-9_-]{1,32})\s*$/;

// -- FUNCTIONS -- //

/** A refusal that carries a code and the names the agent can choose from. */
export class RegistrationError extends Error {
	constructor(
		readonly code: RegistrationCode,
		message: string,
		readonly registrations: string[] = []
	) {
		super(message);
		this.name = 'RegistrationError';
	}
}

/** The registration a check script names in a "// afb-registration: NAME" line among its first 12 lines, or null. */
export function registrationHeader(source: string): string | null {
	for (const line of String(source ?? '')
		.split(/\r?\n/)
		.slice(0, HEADER_LINES)) {
		const m = HEADER.exec(line);
		if (m?.[1]) return m[1];
	}
	return null;
}

const PROFILE_HEADER = /^\s*\/\/\s*afb-profile:\s*([a-z0-9-]{1,32})\s*$/;

/** The saved sign-in a check script asks for in a "// afb-profile: NAME" line among its first 12 lines (same rule as the registration), or null. */
export function profileHeader(source: string): string | null {
	for (const line of String(source ?? '')
		.split(/\r?\n/)
		.slice(0, HEADER_LINES)) {
		const m = PROFILE_HEADER.exec(line);
		if (m?.[1]) return m[1];
	}
	return null;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The registration for a board project. `named` is the name a run, a check or a script header gave (or null). A name may carry its organisation (org/NAME), and then it
 * must be this one. `all` is every registration of the organisation (the registry by default).
 */
export function pickRegistration(
	org: string,
	boardProject: string,
	named: string | null | undefined,
	all: Registration[] = listRegistrations(org)
): Registration {
	const ofOrg = all.filter((r) => r.org === org);
	const serving = ofOrg.filter((r) => same(r.boardProject, boardProject));
	const list = serving.map((r) => r.name);
	const choices = list.length
		? `Registrations of ${boardProject}: ${list.join(', ')}.`
		: `${boardProject} has no registration here.`;
	if (named) {
		const parts = String(named).split('/');
		if (parts.length > 2 || (parts.length === 2 && !same(parts[0] ?? '', org)))
			throw new RegistrationError(
				'REGISTRATION_UNKNOWN',
				`"${String(named).slice(0, 60)}" is not a registration name of ${org}. Write NAME or ${org}/NAME. ${choices}`,
				list
			);
		const bare = parts[parts.length - 1] ?? '';
		if (!REGISTRATION_NAME.test(bare))
			throw new RegistrationError(
				'REGISTRATION_UNKNOWN',
				`"${bare.slice(0, 40)}" is not a registration name. ${choices}`,
				list
			);
		const hit = serving.find((r) => same(r.name, bare));
		if (hit) return hit;
		const other = ofOrg.find((r) => same(r.name, bare));
		if (other)
			throw new RegistrationError(
				'REGISTRATION_MISMATCH',
				`The registration ${other.name} serves the board project ${other.boardProject}, not ${boardProject}. ${choices}`,
				list
			);
		throw new RegistrationError(
			'REGISTRATION_UNKNOWN',
			`This machine has no registration ${bare} in ${org}. ${choices}`,
			list
		);
	}
	if (serving.length === 1 && serving[0]) return serving[0];
	if (!serving.length)
		throw new RegistrationError(
			'REGISTRATION_UNKNOWN',
			`No registration serves ${boardProject} in ${org}. Register one: agent-flow-board check project <NAME> --org ${org} --repo <folder> --board-project ${boardProject}.`,
			[]
		);
	throw new RegistrationError(
		'REGISTRATION_REQUIRED',
		`${boardProject} has ${serving.length} registrations (${list.join(', ')}) and none was named. Name one on the run, save one on the check, or put a "// afb-registration: <name>" line at the top of the check script.`,
		list
	);
}

/** Routes one run: the name on the run, else the name saved on the check, else the script's header, else the only registration. */
export function routeRun(opts: {
	org: string;
	boardProject: string;
	run?: string | null;
	check?: string | null;
	script?: string | null;
	all?: Registration[];
}): Registration {
	const named = opts.run || opts.check || (opts.script ? registrationHeader(opts.script) : null);
	return pickRegistration(opts.org, opts.boardProject, named, opts.all);
}
