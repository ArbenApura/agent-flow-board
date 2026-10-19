// READING THE BOARD'S SKILLS FOR THE BRIDGE (AFB-20261018-0622): THE ORG, THE PAGES AND THE PLAIN ERROR

// -- DEP-MODULES -- //
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import { fetchSkills, resolveOrg, SkillSourceError } from './fetch';
import { skillHashOf } from './materialize';
import type { Fetch } from '../device.js';

// -- CONSTANTS -- //

const SERVER = 'https://board.example';

/** Answers each path from a table, and records what was asked. */
function fakeFetch(routes: Record<string, unknown>): { fetch: Fetch; asked: string[] } {
	const asked: string[] = [];
	const fetchImpl: Fetch = async (input) => {
		const path = input.replace(SERVER, '');
		asked.push(path);
		const key = Object.keys(routes).find((r) => path.startsWith(r));
		if (key === undefined)
			return new Response(JSON.stringify({ error: { message: 'No such endpoint.' } }), {
				status: 404
			});
		const value = routes[key];
		return new Response(JSON.stringify(value), { status: 200 });
	};
	return { fetch: fetchImpl, asked };
}

// -- TESTS -- //

describe('the bridge reads skills', () => {
	it('takes the only organisation, and asks which one when there are two', async () => {
		const one = fakeFetch({ '/api/v1/me': { orgs: [{ slug: 'acme' }] } });
		expect(await resolveOrg({ server: SERVER, token: 't', fetch: one.fetch })).toBe('acme');

		const two = fakeFetch({ '/api/v1/me': { orgs: [{ slug: 'a' }, { slug: 'b' }] } });
		await expect(resolveOrg({ server: SERVER, token: 't', fetch: two.fetch })).rejects.toThrow(
			'Name one with --org'
		);

		const none = fakeFetch({ '/api/v1/me': { orgs: [] } });
		await expect(resolveOrg({ server: SERVER, token: 't', fetch: none.fetch })).rejects.toThrow(
			'belongs to no organisation'
		);
	});

	it('reads every page of a long skill and joins them', async () => {
		const f = fakeFetch({
			'/api/v1/orgs/acme/projects/AFB/skills/release-notes?offset=0&revision=3': {
				text: 'first ',
				total: 12,
				next: 6,
				hash: 'h1'
			},
			'/api/v1/orgs/acme/projects/AFB/skills/release-notes?offset=6&revision=3': {
				text: 'second',
				total: 12,
				next: null,
				hash: 'h1'
			},
			'/api/v1/orgs/acme/projects/AFB/skills': [
				{ name: 'release-notes', summary: 'Notes', hash: 'h1', revision: 3 }
			]
		});
		const skills = await fetchSkills({
			server: SERVER,
			token: 't',
			fetch: f.fetch,
			org: 'acme',
			project: 'AFB'
		});
		expect(skills).toEqual([
			{ name: 'release-notes', summary: 'Notes', body: 'first second', hash: 'h1' }
		]);
		expect(f.asked).toContain(
			'/api/v1/orgs/acme/projects/AFB/skills/release-notes?offset=6&revision=3'
		);
	});

	it('reads the organisation skills when no project is named, and passes a refusal through', async () => {
		const ok = fakeFetch({
			'/api/v1/orgs/acme/skills/org-notes?offset=0&revision=1': {
				text: 'Organisation text.',
				total: 18,
				next: null,
				hash: 'h2'
			},
			'/api/v1/orgs/acme/skills': [{ name: 'org-notes', summary: 'Org', hash: 'h2', revision: 1 }]
		});
		await expect(
			fetchSkills({ server: SERVER, token: 't', fetch: ok.fetch, org: 'acme' })
		).resolves.toEqual([
			{ name: 'org-notes', summary: 'Org', body: 'Organisation text.', hash: 'h2' }
		]);

		const refused = fakeFetch({});
		await expect(
			fetchSkills({ server: SERVER, token: 't', fetch: refused.fetch, org: 'acme' })
		).rejects.toBeInstanceOf(SkillSourceError);
	});

	it('refuses a name that would escape the checkout', async () => {
		const f = fakeFetch({
			'/api/v1/orgs/acme/projects/AFB/skills': [
				{ name: '../../outside', summary: 'Bad', hash: 'h', revision: 1 }
			]
		});
		await expect(
			fetchSkills({ server: SERVER, token: 't', fetch: f.fetch, org: 'acme', project: 'AFB' })
		).rejects.toThrow('not a slug');
	});
});

describe('the bridge reads supporting files', () => {
	const files = [
		{ path: 'design-fit.md', size: 12 },
		{ path: 'refs/forms.md', size: 6 }
	];
	const hash = skillHashOf({ name: 'guide', summary: 'How we code', body: 'Read design-fit.md.' }, [
		{ path: 'design-fit.md', body: 'Design text.' },
		{ path: 'refs/forms.md', body: 'Forms.' }
	]);
	const routes = (over: Record<string, unknown> = {}) => ({
		'/api/v1/orgs/acme/projects/AFB/skills/guide?offset=0&revision=2&file=design-fit.md': {
			text: 'Design text.',
			total: 12,
			next: null,
			hash
		},
		'/api/v1/orgs/acme/projects/AFB/skills/guide?offset=0&revision=2&file=refs%2Fforms.md': {
			text: 'Forms.',
			total: 6,
			next: null,
			hash
		},
		'/api/v1/orgs/acme/projects/AFB/skills/guide?offset=0&revision=2': {
			text: 'Read design-fit.md.',
			total: 19,
			next: null,
			hash
		},
		'/api/v1/orgs/acme/projects/AFB/skills': [
			{ name: 'guide', summary: 'How we code', hash, revision: 2, files }
		],
		...over
	});

	it('reads each file under the pinned revision and checks the hash that covers them', async () => {
		const f = fakeFetch(routes());
		const skills = await fetchSkills({
			server: SERVER,
			token: 't',
			fetch: f.fetch,
			org: 'acme',
			project: 'AFB'
		});
		expect(skills).toEqual([
			{
				name: 'guide',
				summary: 'How we code',
				body: 'Read design-fit.md.',
				hash,
				files: [
					{ path: 'design-fit.md', body: 'Design text.' },
					{ path: 'refs/forms.md', body: 'Forms.' }
				]
			}
		]);
		expect(f.asked.filter((p) => p.includes('file='))).toHaveLength(2);
		expect(f.asked.every((p) => !p.includes('revision=2') || p.includes('offset='))).toBe(true);
	});

	it('refuses a skill whose files do not match the hash the board gave', async () => {
		const f = fakeFetch(
			routes({
				'/api/v1/orgs/acme/projects/AFB/skills/guide?offset=0&revision=2&file=refs%2Fforms.md': {
					text: 'Changed.',
					total: 8,
					next: null,
					hash
				}
			})
		);
		await expect(
			fetchSkills({ server: SERVER, token: 't', fetch: f.fetch, org: 'acme', project: 'AFB' })
		).rejects.toThrow('do not match');
	});

	it('refuses a file path that could leave the skill folder before reading anything', async () => {
		const f = fakeFetch(
			routes({
				'/api/v1/orgs/acme/projects/AFB/skills': [
					{
						name: 'guide',
						summary: 'How we code',
						hash,
						revision: 2,
						files: [{ path: '../../.git/hooks/x.md', size: 1 }]
					}
				]
			})
		);
		await expect(
			fetchSkills({ server: SERVER, token: 't', fetch: f.fetch, org: 'acme', project: 'AFB' })
		).rejects.toBeInstanceOf(SkillSourceError);
		expect(f.asked.some((p) => p.includes('file='))).toBe(false);
	});
});
