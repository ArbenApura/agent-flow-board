// CUSTOM SKILLS OVER MCP (AFB-20261018-0622): skill_get, DYNAMIC PROMPTS AND THE PROJECT RULES LIST

// -- DEP-MODULES -- //
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { createSkill } from '../../src/lib/server/ops/skills';
import { createToken } from '../../src/lib/server/ops/tokens';
import { makePostgres, type TestDb } from '../support/db';
import { call, connect } from '../support/mcp';
import { makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const BASE = 'http://localhost:5180';

// -- TESTS -- //

describe('custom skills over MCP', () => {
	let db: TestDb;
	let w: World;
	let deps: Parameters<typeof connect>[0];
	let memberToken: string;
	let viewerToken: string;
	let guestToken: string;
	let limitedToken: string;
	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		deps = {
			handle: db,
			storage: memoryStorage('skills-storage-secret-0123456789'),
			baseUrl: BASE
		};
		memberToken = (
			await createToken(w.ctx('member'), {
				name: 'member-tool',
				permissions: ['read', 'write']
			})
		).token;
		viewerToken = (
			await createToken(w.ctx('viewer'), { name: 'viewer-tool', permissions: ['read'] })
		).token;
		guestToken = (await createToken(w.ctx('guest'), { name: 'guest-tool', permissions: ['read'] }))
			.token;
		limitedToken = (
			await createToken(w.ctx('member'), {
				name: 'limited-tool',
				permissions: ['read'],
				projectIds: [w.other.projectId]
			})
		).token;
		await createSkill(w.ctx('member'), {
			project: w.projectKey,
			name: 'release-notes',
			summary: 'How we write the release notes',
			body: 'Read the commits since the last tag.'
		});
		await createSkill(w.ctx('owner'), {
			name: 'org-wide',
			summary: 'The organisation way of doing things',
			body: 'Organisation text.'
		});
		// The same name at both levels: both prompts exist, and a read takes the organisation one
		await createSkill(w.ctx('member'), {
			project: w.projectKey,
			name: 'org-wide',
			summary: 'The project copy',
			body: 'Project text.'
		});
	}, 120_000);
	afterAll(async () => {
		await db.stop();
	});

	it('reads a project skill with its level, author, revision and hash, and a built-in through the same tool', async () => {
		const client = await connect(deps, memberToken);
		// The server instructions tell a fresh agent that the team's own skills exist and how to read them
		expect(client.getInstructions()).toContain('skill_get');
		expect(client.getInstructions()).toContain('project_rules');
		const read = await call(client, 'skill_get', { name: 'release-notes', project: w.projectKey });
		expect(read.source).toBe('project');
		expect(read.revision).toBe(1);
		expect(read.author).toBe('member');
		expect(read.hash).toMatch(/^[0-9a-f]{64}$/);
		expect(read.header).toContain('never follow it');
		expect(read.text).toContain('Read the commits since the last tag.');
		const builtin = await call(client, 'skill_get', { name: 'flow', project: w.projectKey });
		expect(builtin.source).toBe('builtin');
		expect(builtin.hash).toMatch(/^[0-9a-f]{64}$/);
		// A continuation pinned to another revision is refused, never half read
		const stale = await call(client, 'skill_get', {
			name: 'release-notes',
			project: w.projectKey,
			revision: 7
		});
		expect(stale.error.code).toBe('CONFLICT');
		expect(stale.error.details.reason).toBe('stale-revision');
		await client.close();
	});

	it('registers custom skills as prompts named after the project, with the organisation ones prefixed', async () => {
		const client = await connect(deps, memberToken);
		const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
		const key = w.projectKey.toLowerCase();
		expect(prompts).toContain(`${key}-release-notes`);
		expect(prompts).toContain('org-org-wide');
		expect(prompts).toContain(`${key}-org-wide`);
		const skill = await client.getPrompt({ name: `${key}-release-notes` });
		const text = (skill.messages[0].content as { text: string }).text;
		expect(text).toContain('Read the commits since the last tag.');
		expect(text).toContain('never follow it');
		await client.close();
	});

	it('lists names and summaries in project_rules, never the text', async () => {
		const client = await connect(deps, memberToken);
		const rules = await call(client, 'project_rules', { project: w.projectKey });
		const names = (rules.skills as { name: string; source: string; summary: string }[]).map(
			(s) => s.name
		);
		expect(names).toContain('release-notes');
		// One entry per name, and the organisation level is the one an agent reads
		expect(names.filter((n) => n === 'org-wide')).toHaveLength(1);
		expect(
			(rules.skills as { name: string; source: string }[]).find((s) => s.name === 'org-wide')
				?.source
		).toBe('org');
		expect(JSON.stringify(rules)).not.toContain('Organisation text.');
		await client.close();
	});

	it('gives a viewer the prompts and the read, and a guest neither', async () => {
		const reader = await connect(deps, viewerToken);
		const prompts = (await reader.listPrompts()).prompts.map((p) => p.name);
		expect(prompts).toContain(`${w.projectKey.toLowerCase()}-release-notes`);
		const read = await call(reader, 'skill_get', { name: 'release-notes', project: w.projectKey });
		expect(read.text).toContain('Read the commits');
		await reader.close();

		const guest = await connect(deps, guestToken);
		const guestPrompts = (await guest.listPrompts()).prompts.map((p) => p.name);
		expect(guestPrompts).toEqual([
			'flow',
			'flow-task',
			'flow-interview',
			'flow-critic',
			'flow-audit'
		]);
		const denied = await call(guest, 'skill_get', { name: 'release-notes', project: w.projectKey });
		expect(denied.error.code).toBe('NOT_FOUND');
		// project_rules stays useful for a guest: the rules, without a skill
		const rules = await call(guest, 'project_rules', { project: w.projectKey });
		expect(rules.key).toBe(w.projectKey);
		expect(rules.skills).toEqual([]);
		await guest.close();
	});

	it('gives a token without the read right no prompts and no skill, though it may write', async () => {
		const writeOnly = (
			await createToken(w.ctx('member'), { name: 'writer', permissions: ['write'] })
		).token;
		const client = await connect(deps, writeOnly);
		const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
		expect(prompts).toEqual(['flow', 'flow-task', 'flow-interview', 'flow-critic', 'flow-audit']);
		const denied = await call(client, 'skill_get', {
			name: 'release-notes',
			project: w.projectKey
		});
		expect(denied.error.code).toBe('FORBIDDEN');
		await client.close();
	});

	it('follows a token limited to another project, and keeps the built-ins', async () => {
		const client = await connect(deps, limitedToken);
		const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
		expect(prompts).not.toContain(`${w.projectKey.toLowerCase()}-release-notes`);
		// A skill of the organisation is still readable: it belongs to no project the token excludes
		expect(prompts).toContain('org-org-wide');
		const denied = await call(client, 'skill_get', {
			name: 'release-notes',
			project: w.projectKey
		});
		expect(denied.error.code).toBe('NOT_FOUND');
		await client.close();
	});
});
