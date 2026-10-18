// READ THE SKILLS A CHECKOUT SHOULD CARRY, OVER THE BOARD'S OWN REST API (AFB-20261018-0622)
// The bridge holds no tool code and no schema of its own, so it reads the same routes a person's browser does.

// -- TYPES -- //
import type { Fetch } from '../device.js';
import type { RemoteSkill } from './materialize.js';

// -- TYPES -- //

export type SkillSourceOptions = {
	server: string;
	token: string;
	fetch: Fetch;
	/** The organisation slug. Left out, the token's only organisation is used, and two or more ask for it. */
	org?: string;
	/** The project key. Left out, only the organisation's skills are read. */
	project?: string;
};

export class SkillSourceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SkillSourceError';
	}
}

// -- FUNCTIONS -- //

/** One GET that returns JSON, with the server's plain error message when it refuses. */
async function getJson<T>(o: SkillSourceOptions, path: string): Promise<T> {
	const res = await o.fetch(`${o.server}${path}`, {
		headers: { authorization: `Bearer ${o.token}`, accept: 'application/json' }
	});
	const body = (await res.json().catch(() => null)) as
		(T & { error?: { message?: string } }) | null;
	if (!res.ok)
		throw new SkillSourceError(
			body?.error?.message ?? `The board answered ${res.status} for ${path}.`
		);
	return body as T;
}

/** The organisation the token belongs to, by slug. */
export async function resolveOrg(o: SkillSourceOptions): Promise<string> {
	if (o.org) return o.org;
	const me = await getJson<{ orgs: { slug: string }[] }>(o, '/api/v1/me');
	if (me.orgs.length === 1) return me.orgs[0].slug;
	if (!me.orgs.length) throw new SkillSourceError('This token belongs to no organisation.');
	throw new SkillSourceError(
		`This token reaches ${me.orgs.length} organisations. Name one with --org.`
	);
}

/** Every skill of the project (and its organisation), with the whole text, read page by page. */
export async function fetchSkills(o: SkillSourceOptions): Promise<RemoteSkill[]> {
	const org = await resolveOrg(o);
	const base = `/api/v1/orgs/${org}${o.project ? `/projects/${o.project}` : ''}/skills`;
	const list = await getJson<{ name: string; summary: string; hash: string; revision: number }[]>(
		o,
		base
	);
	const out: RemoteSkill[] = [];
	for (const s of list) {
		// The name becomes a path in the checkout, so anything that is not a plain slug is refused before it is written
		if (!/^[a-z][a-z0-9-]{0,63}$/.test(s.name))
			throw new SkillSourceError(
				`The board returned a skill name that is not a slug: "${s.name}".`
			);
		let offset = 0;
		let body = '';
		let hash = s.hash;
		for (;;) {
			// The revision pins every page, so a save in the middle answers CONFLICT instead of joining two versions
			const page = await getJson<{
				text: string;
				total: number;
				next: number | null;
				hash: string;
			}>(o, `${base}/${encodeURIComponent(s.name)}?offset=${offset}&revision=${s.revision}`);
			body += page.text;
			hash = page.hash ?? hash;
			if (page.next === null) break;
			offset = page.next;
		}
		out.push({ name: s.name, summary: s.summary, body, hash });
	}
	return out;
}
