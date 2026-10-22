// THE REGISTRATIONS THE AFB-CHECKS TOOL HOLDS. A board project can be built from more than one folder on the tool's machine, each one a registration with its own repo and branch.
// The tool tells the board which it holds (one header on every call). The board uses that list to send a run that names a registration only to a tool that holds it, and to refuse
// a run that names none when the project has several. The list is text from whoever holds the token: every entry is checked against a plain pattern and anything else is dropped whole.

// -- TYPES -- //
import type { DbHandle, Tx } from '../db/client';
import type { ToolRegistration } from '../db/schema/integrations';
import type { RunnerAuth } from './environments';
// -- DEP-MODULES -- //
import { and, eq, sql } from 'drizzle-orm';
// -- MODULES -- //
import { runner } from '../db/schema';
import { withTenant } from '../db/tenant';
import { RUNNER_ONLINE_SECONDS } from './environments';

// -- CONSTANTS -- //

/** The header the afb-checks tool sends with every call: base64url of a short JSON list of its registrations. */
export const TOOL_REGISTRATIONS_HEADER = 'x-afb-tool-registrations';
const MAX_HEADER_CHARS = 6000;
const MAX_REGISTRATIONS = 16;
const PROJECT_KEY = /^[A-Z][A-Z0-9]{1,9}$/;
const NAME = /^[A-Za-z0-9_-]{1,32}$/;
const REPO = /^[A-Za-z0-9 ._-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;

// -- FUNCTIONS -- //

/**
 * Reads the registrations header. Returns null for a missing or damaged header, so the last good list is kept; an entry that is not plain text makes the whole header damaged.
 * The wire form is short (p, n, r, b) to keep the header small.
 */
export function parseToolRegistrations(header: string | null): ToolRegistration[] | null {
	if (!header || header.length > MAX_HEADER_CHARS || !/^[A-Za-z0-9_-]+$/.test(header)) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
	} catch {
		return null;
	}
	if (!Array.isArray(raw) || raw.length > MAX_REGISTRATIONS) return null;
	const out: ToolRegistration[] = [];
	for (const e of raw) {
		if (!e || typeof e !== 'object') return null;
		const { p, n, r, b } = e as Record<string, unknown>;
		if (typeof p !== 'string' || !PROJECT_KEY.test(p) || typeof n !== 'string' || !NAME.test(n))
			return null;
		if (r !== undefined && (typeof r !== 'string' || !REPO.test(r))) return null;
		if (b !== undefined && (typeof b !== 'string' || !BRANCH.test(b))) return null;
		out.push({ project: p, name: n, ...(r ? { repo: r } : {}), ...(b ? { branch: b } : {}) });
	}
	return out;
}

/** Keeps the registrations a tool reported. Only a tool's own token may; a header that is not in the form is ignored. A failure here must never stop a run. */
export async function recordToolRegistrations(
	handle: DbHandle,
	auth: RunnerAuth,
	header: string | null
): Promise<void> {
	if (auth.kind !== 'tool') return;
	const list = parseToolRegistrations(header);
	if (!list) return;
	await withTenant(handle, { orgId: auth.orgId }, async (tx) => {
		// Written only when it changed: this runs on every call of the tool
		await tx
			.update(runner)
			.set({ registrations: list })
			.where(
				and(
					eq(runner.id, auth.runnerId),
					sql`${runner.registrations} is distinct from ${JSON.stringify(list)}::jsonb`
				)
			);
	});
}

/** A runner's registrations as lower case `PROJECT:name` pairs (empty for an older tool that reports none). The project is part of the pair: a name held for one project is not held for another. */
export const registrationPairs = (regs: ToolRegistration[] | null | undefined): string[] => [
	...new Set((regs ?? []).map((r) => `${r.project}:${r.name}`.toLowerCase()))
];

/** The registrations the claiming runner holds, as pairs. Read inside the claim's own transaction. */
export async function runnerRegistrationPairs(tx: Tx, auth: RunnerAuth): Promise<string[]> {
	const [r] = await tx
		.select({ registrations: runner.registrations })
		.from(runner)
		.where(and(eq(runner.id, auth.runnerId), eq(runner.orgId, auth.orgId)));
	return registrationPairs(r?.registrations);
}

export type RegistrationFit = {
	ok: boolean;
	/** Why no online tool can serve the run, for the run's reason. */
	reason: string | null;
	/** The registrations of the project, when it has several and none was named. */
	choices: string[] | null;
};

/**
 * Can a run that names this registration (or none) be served by an online tool? An online tool must list the registration for the project; a tool that lists none is an older one.
 * With none named and a tool that holds several registrations of the project, the run must name one, and the choices are given.
 */
export async function registrationFit(
	tx: Tx,
	orgId: string,
	projectId: string,
	projectKey: string,
	wanted: string | null
): Promise<RegistrationFit> {
	const tools = await tx
		.select({ registrations: runner.registrations })
		.from(runner)
		.where(
			and(
				eq(runner.orgId, orgId),
				eq(runner.kind, 'tool'),
				sql`${projectId}::uuid = any(${runner.projectIds})`,
				sql`${runner.lastSeenAt} > now() - make_interval(secs => ${RUNNER_ONLINE_SECONDS})`
			)
		);
	// No tool is online: the ordinary availability check says so
	if (!tools.length) return { ok: true, reason: null, choices: null };
	const lists = tools.map((t) =>
		(t.registrations ?? []).filter((r) => r.project === projectKey).map((r) => r.name)
	);
	const all = [...new Set(lists.flat())].sort();
	if (wanted) {
		if (lists.some((l) => l.some((n) => n.toLowerCase() === wanted.toLowerCase())))
			return { ok: true, reason: null, choices: null };
		const old = tools.every((t) => t.registrations === null);
		return {
			ok: false,
			choices: all.length ? all : null,
			reason: old
				? `The afb-checks tool that is online is too old to run a named registration (${wanted}). Your agent upgrades it: node afb-checks.mjs upgrade <a folder with a newer template>.`
				: `No online afb-checks tool holds the registration ${wanted} for ${projectKey}.${all.length ? ` It holds: ${all.join(', ')}.` : ''}`
		};
	}
	// Two registrations of the project among the online tools (in one tool or across tools) mean a run must say which one
	if (all.length >= 2) return { ok: true, reason: null, choices: all };
	return { ok: true, reason: null, choices: null };
}
