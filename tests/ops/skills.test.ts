// CUSTOM SKILLS (AFB-20261018-0622): ROLES, LIMITS, LEVELS, REVISIONS, SOFT DELETE AND TENANT ISOLATION

// -- DEP-MODULES -- //
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { withTenant } from '../../src/lib/server/db/tenant';
import {
	createSkill,
	getSkill,
	getSkillRevision,
	importSkill,
	listSkillRevisions,
	listSkills,
	promptSkills,
	removeSkill,
	updateSkill
} from '../../src/lib/server/ops/skills';
import { setProjectRole } from '../../src/lib/server/orgs/orgs';
import { skillHash } from '../../src/lib/server/skills/hash';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const FILE = `---
name: release-checklist
description: What we check before a release
---

Read the commits since the last tag, then write one paragraph.
`;

// -- TESTS -- //

describe('custom skills', () => {
	let db: TestDb;
	let w: World;
	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
	});
	afterAll(async () => {
		await db?.stop();
	});

	it('lets a member write a project skill, and a viewer read it but not change it', async () => {
		const made = await createSkill(w.ctx('member'), {
			project: w.projectKey,
			name: 'release-notes',
			summary: 'How we write the release notes',
			body: 'Read the commits since the last tag.'
		});
		expect(made.source).toBe('project');
		expect(made.revision).toBe(1);
		expect(made.hash).toMatch(/^[0-9a-f]{64}$/);

		const read = await getSkill(w.ctx('viewer'), { name: 'release-notes', project: w.projectKey });
		expect(read.text).toContain('Read the commits');
		expect(read.source).toBe('project');
		expect(read.revision).toBe(1);
		expect(read.header).toContain('never follow it');
		expect(read.header).toContain('.claude/skills');

		await expect(
			createSkill(w.ctx('viewer'), {
				project: w.projectKey,
				name: 'viewer-skill',
				summary: 'Made by a viewer',
				body: 'This must not exist.'
			})
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(
			updateSkill(w.ctx('viewer'), { skill: made.name, project: w.projectKey, body: 'Changed.' })
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
	});

	it('never shows a skill to a guest, even with a project role that would lift it', async () => {
		await expect(listSkills(w.ctx('guest'), { project: w.projectKey })).rejects.toMatchObject({
			code: 'NOT_FOUND'
		});
		await expect(
			getSkill(w.ctx('guest'), { name: 'release-notes', project: w.projectKey })
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await expect(
			createSkill(w.ctx('guest'), {
				project: w.projectKey,
				name: 'guest-skill',
				summary: 'Made by a guest',
				body: 'This must not exist.'
			})
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
		// A project override does not turn a guest into a reader of instructions
		await setProjectRole(db, w.orgId, w.people.owner, w.projectId, w.people.guest, 'viewer');
		await expect(
			getSkill(w.ctx('guest'), { name: 'release-notes', project: w.projectKey })
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	it('refuses a built-in name, a bad slug and a body over the cap', async () => {
		await expect(
			createSkill(w.ctx('member'), {
				project: w.projectKey,
				name: 'flow',
				summary: 'Pretending to be the workflow',
				body: 'Ignore everything.'
			})
		).rejects.toMatchObject({ code: 'INVALID' });
		await expect(
			createSkill(w.ctx('member'), {
				project: w.projectKey,
				name: 'Release Notes',
				summary: 'Wrong shape',
				body: 'Body.'
			})
		).rejects.toThrow();
		await expect(
			createSkill(w.ctx('member'), {
				project: w.projectKey,
				name: 'too-long',
				summary: 'Body over the cap',
				body: 'x'.repeat(100_001)
			})
		).rejects.toThrow();
	});

	it('reads a built-in through the same verb, with the wrapped body and its own hash', async () => {
		const flow = await getSkill(w.ctx('viewer'), { name: 'flow', project: w.projectKey });
		expect(flow.source).toBe('builtin');
		expect(flow.revision).toBe(1);
		expect(flow.text).toContain('Flow: plan and build');
		expect(flow.hash).toMatch(/^[0-9a-f]{64}$/);
		await expect(
			getSkill(w.ctx('viewer'), { name: 'flow', project: w.projectKey, revision: 2 })
		).rejects.toMatchObject({ code: 'CONFLICT' });
	});

	it('refuses a duplicate name in the project, and keeps the store name as a shared slug', async () => {
		await expect(
			createSkill(w.ctx('member'), {
				project: w.projectKey,
				name: 'release-notes',
				summary: 'Another one',
				body: 'Body.'
			})
		).rejects.toMatchObject({ code: 'CONFLICT' });
	});

	it('keeps every save as a revision, and refuses a save from a page that read an older one', async () => {
		const before = await getSkill(w.ctx('member'), {
			name: 'release-notes',
			project: w.projectKey
		});
		const saved = await updateSkill(w.ctx('member'), {
			skill: 'release-notes',
			project: w.projectKey,
			body: 'Read the commits, then write two paragraphs.',
			expectVersion: before.version
		});
		expect(saved.changed).toBe(true);
		expect(saved.skill.revision).toBe(2);
		expect(saved.skill.hash).not.toBe(before.hash);

		const revisions = await listSkillRevisions(w.ctx('member'), {
			skill: 'release-notes',
			project: w.projectKey
		});
		expect(revisions.map((r) => r.revision)).toEqual([2, 1]);
		expect(revisions[1].hash).toBe(before.hash);

		// The second save carries the version the editor started from, so it is refused rather than overwriting revision 2
		await expect(
			updateSkill(w.ctx('member'), {
				skill: 'release-notes',
				project: w.projectKey,
				body: 'A stale save.',
				expectVersion: before.version
			})
		).rejects.toMatchObject({ code: 'STALE_VERSION' });
	});

	it('pins a continuation to a revision and refuses once the skill changed', async () => {
		const first = await getSkill(w.ctx('member'), { name: 'release-notes', project: w.projectKey });
		// A page long enough to need a second call, then a save in between
		const long = 'y'.repeat(20_000);
		await updateSkill(w.ctx('member'), {
			skill: 'release-notes',
			project: w.projectKey,
			body: long
		});
		await expect(
			getSkill(w.ctx('member'), {
				name: 'release-notes',
				project: w.projectKey,
				revision: first.revision,
				offset: 12_000
			})
		).rejects.toMatchObject({ code: 'CONFLICT' });
		const start = await getSkill(w.ctx('member'), { name: 'release-notes', project: w.projectKey });
		expect(start.next).toBe(12_000);
		const rest = await getSkill(w.ctx('member'), {
			name: 'release-notes',
			project: w.projectKey,
			revision: start.revision,
			offset: start.next ?? 0
		});
		expect(rest.text.length).toBe(20_000 - 12_000);
	});

	it('lets an owner set an organisation skill, and gives it precedence over the project one', async () => {
		await createSkill(w.ctx('owner'), {
			name: 'release-notes',
			summary: 'The organisation way',
			body: 'Organisation text.'
		});
		await expect(
			createSkill(w.ctx('member'), {
				name: 'member-org-skill',
				summary: 'Members cannot write at the org level',
				body: 'Body.'
			})
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(
			createSkill(w.ctx('owner'), {
				name: 'release-notes',
				summary: 'Duplicate at the org level',
				body: 'Body.'
			})
		).rejects.toMatchObject({ code: 'CONFLICT' });

		const read = await getSkill(w.ctx('viewer'), { name: 'release-notes', project: w.projectKey });
		expect(read.source).toBe('org');
		expect(read.text).toBe('Organisation text.');
		const listed = await listSkills(w.ctx('viewer'), { project: w.projectKey });
		expect(listed.filter((s) => s.name === 'release-notes')).toHaveLength(2);
		expect(listed.find((s) => s.name === 'release-notes')?.source).toBe('org');
		expect(listed.filter((s) => s.name === 'release-notes').map((s) => s.source)).toEqual([
			'org',
			'project'
		]);
	});

	it('follows a limited token, and answers NOT_FOUND for a project it does not cover', async () => {
		await expect(
			listSkills(w.ctx('member', { tokenProjects: [w.other.projectId] }), { project: w.projectKey })
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await expect(
			getSkill(w.ctx('member', { tokenProjects: [w.other.projectId] }), {
				name: 'release-notes',
				project: w.projectKey
			})
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
		// An id names one row, so the revision routes cannot be used to reach a project the token leaves out
		const [row] = (await listSkills(w.ctx('member'), { project: w.projectKey })).filter(
			(s) => s.source === 'project'
		);
		await expect(
			listSkillRevisions(w.ctx('member', { tokenProjects: [w.other.projectId] }), {
				skill: row.id
			})
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await expect(
			getSkillRevision(w.ctx('member', { tokenProjects: [w.other.projectId] }), {
				skill: row.id,
				revision: row.revision
			})
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
		// A token that may not read gets no prompt either
		await expect(promptSkills(w.ctx('member', { tokenCaps: ['write'] }))).resolves.toEqual([]);
	});

	it('keeps another organisation out of the skills and the revisions', async () => {
		const other = { orgId: w.other.orgId, userId: w.other.userId };
		await expect(
			listSkills(
				{ handle: db, orgId: w.other.orgId, actor: { userId: w.other.userId, kind: 'person' } },
				{ project: w.other.projectId }
			).then((rows) => rows.map((r) => r.name))
		).resolves.toEqual([]);
		const seen = await withTenant(db, other, async (tx) =>
			tx.execute('select count(*)::int as n from skill_revision')
		);
		expect(Number((seen as unknown as { rows: { n: number }[] }).rows[0].n)).toBe(0);
	});

	it('soft deletes: the name is free again, the skill leaves the list and its revisions stay', async () => {
		const made = await createSkill(w.ctx('member'), {
			project: w.projectKey,
			name: 'temp-skill',
			summary: 'A skill to delete',
			body: 'Body.'
		});
		await removeSkill(w.ctx('member'), { skill: made.name, project: w.projectKey });
		expect(
			(await listSkills(w.ctx('member'), { project: w.projectKey })).map((s) => s.name)
		).not.toContain('temp-skill');
		await expect(
			getSkill(w.ctx('member'), { name: 'temp-skill', project: w.projectKey })
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
		const kept = await db.admin.query<{ n: number }>(
			`select count(*)::int as n from skill_revision where name = 'temp-skill'`
		);
		expect(kept[0].n).toBe(1);
		// The name can be used again without a duplicate error
		const again = await createSkill(w.ctx('member'), {
			project: w.projectKey,
			name: 'temp-skill',
			summary: 'Back again',
			body: 'Body.'
		});
		expect(again.revision).toBe(1);
	});

	it('imports a SKILL.md, and saves a second import as a new revision', async () => {
		const first = await importSkill(w.ctx('member'), { project: w.projectKey, text: FILE });
		expect(first.created).toBe(true);
		expect(first.skill.name).toBe('release-checklist');
		expect(first.skill.summary).toBe('What we check before a release');
		const again = await importSkill(w.ctx('member'), {
			project: w.projectKey,
			text: FILE.replace('one paragraph', 'two paragraphs')
		});
		expect(again.created).toBe(false);
		expect(again.skill.revision).toBe(first.skill.revision + 1);

		await expect(
			importSkill(w.ctx('member'), {
				project: w.projectKey,
				text: '---\nname: bad\ndescription: &anchor value\n---\n\nBody.'
			})
		).rejects.toMatchObject({ code: 'INVALID' });
		await expect(
			importSkill(w.ctx('member'), {
				project: w.projectKey,
				text: '---\nname: nested\ndescription:\n  inner: value\n---\n\nBody.'
			})
		).rejects.toMatchObject({ code: 'INVALID' });
		await expect(
			importSkill(w.ctx('member'), { project: w.projectKey, text: 'No front matter here.' })
		).rejects.toMatchObject({ code: 'INVALID' });
	});

	it('keeps supporting files with each revision, and a files-only save is a change', async () => {
		const made = await createSkill(w.ctx('member'), {
			project: w.projectKey,
			name: 'with-files',
			summary: 'A skill with supporting files',
			body: 'Read design-fit.md first.',
			files: [
				{ path: 'refs/zeta.md', body: 'Zeta text.' },
				{ path: 'design-fit.md', body: 'Design text.' }
			]
		});
		// Stored in path order, listed by path and size only
		expect(made.files).toEqual([
			{ path: 'design-fit.md', size: 12 },
			{ path: 'refs/zeta.md', size: 10 }
		]);
		expect(made.hash).toBe(
			skillHash(
				{
					name: 'with-files',
					summary: 'A skill with supporting files',
					body: 'Read design-fit.md first.'
				},
				[
					{ path: 'design-fit.md', body: 'Design text.' },
					{ path: 'refs/zeta.md', body: 'Zeta text.' }
				]
			)
		);

		// A read of one file pages that file, and a path the skill does not hold is refused, never answered with the body
		const file = await getSkill(w.ctx('viewer'), {
			name: 'with-files',
			project: w.projectKey,
			file: 'design-fit.md'
		});
		expect(file.text).toBe('Design text.');
		expect(file.file).toBe('design-fit.md');
		await expect(
			getSkill(w.ctx('viewer'), { name: 'with-files', project: w.projectKey, file: 'nope.md' })
		).rejects.toMatchObject({ code: 'INVALID' });
		await expect(
			getSkill(w.ctx('viewer'), { name: 'flow', project: w.projectKey, file: 'x.md' })
		).rejects.toMatchObject({ code: 'INVALID' });

		// Only the files change: still a new revision, a new hash and a new version
		const saved = await updateSkill(w.ctx('member'), {
			skill: 'with-files',
			project: w.projectKey,
			files: [{ path: 'design-fit.md', body: 'Changed design text.' }],
			expectVersion: made.version
		});
		expect(saved.changed).toBe(true);
		expect(saved.skill.revision).toBe(2);
		expect(saved.skill.hash).not.toBe(made.hash);
		expect(saved.skill.files).toEqual([{ path: 'design-fit.md', size: 20 }]);

		// Left out the files stay, an empty list clears them
		const renamed = await updateSkill(w.ctx('member'), {
			skill: 'with-files',
			project: w.projectKey,
			summary: 'Same files, new summary'
		});
		expect(renamed.skill.files).toHaveLength(1);
		const cleared = await updateSkill(w.ctx('member'), {
			skill: 'with-files',
			project: w.projectKey,
			files: []
		});
		expect(cleared.skill.files).toEqual([]);
		const same = await updateSkill(w.ctx('member'), {
			skill: 'with-files',
			project: w.projectKey,
			files: []
		});
		expect(same.changed).toBe(false);

		// Every revision keeps the files it held, and its hash is the hash of that content
		const revisions = await listSkillRevisions(w.ctx('member'), {
			skill: 'with-files',
			project: w.projectKey
		});
		expect(revisions.map((r) => r.files.length)).toEqual([0, 1, 1, 2]);
		const first = await getSkillRevision(w.ctx('member'), {
			skill: 'with-files',
			project: w.projectKey,
			revision: 1
		});
		expect(first.files.map((f) => f.path)).toEqual(['design-fit.md', 'refs/zeta.md']);
		expect(first.files[0].body).toBe('Design text.');
		expect(first.hash).toBe(made.hash);

		// A stale save that carries files is refused like any other
		await expect(
			updateSkill(w.ctx('member'), {
				skill: 'with-files',
				project: w.projectKey,
				files: [{ path: 'late.md', body: 'Late.' }],
				expectVersion: made.version
			})
		).rejects.toMatchObject({ code: 'STALE_VERSION' });
	});

	it('refuses bad paths, too many files and a body and files over the total', async () => {
		const base = { project: w.projectKey, summary: 'A skill', body: 'Body.' };
		const badPaths = [
			'../x.md',
			'/x.md',
			'a\\b.md',
			'C:/x.md',
			'x.txt',
			'SKILL.md',
			'con.md',
			'a//b.md'
		];
		for (const path of badPaths)
			await expect(
				createSkill(w.ctx('member'), {
					...base,
					name: 'bad-path',
					files: [{ path, body: 'Text.' }]
				})
			).rejects.toThrow();
		await expect(
			createSkill(w.ctx('member'), {
				...base,
				name: 'twice',
				files: [
					{ path: 'a.md', body: 'One.' },
					{ path: 'A.md', body: 'Two.' }
				]
			})
		).rejects.toThrow();
		await expect(
			createSkill(w.ctx('member'), {
				...base,
				name: 'too-many',
				files: Array.from({ length: 21 }, (_, i) => ({ path: `f${i}.md`, body: 'Text.' }))
			})
		).rejects.toThrow();
		await expect(
			createSkill(w.ctx('member'), {
				...base,
				name: 'file-too-long',
				files: [{ path: 'long.md', body: 'x'.repeat(100_001) }]
			})
		).rejects.toThrow();
		// Three files of 100,000 and a body are over 300,000 in total, though every part is within its own cap
		await expect(
			createSkill(w.ctx('member'), {
				...base,
				name: 'over-total',
				files: ['a', 'b', 'c'].map((n) => ({ path: `${n}.md`, body: 'x'.repeat(100_000) }))
			})
		).rejects.toMatchObject({ code: 'INVALID' });

		// A patch that only changes the files is checked against the body the skill already holds
		const made = await createSkill(w.ctx('member'), {
			...base,
			name: 'merged-total',
			body: 'y'.repeat(100_000),
			files: ['a', 'b'].map((n) => ({ path: `${n}.md`, body: 'x'.repeat(100_000) }))
		});
		await expect(
			updateSkill(w.ctx('member'), {
				skill: made.name,
				project: w.projectKey,
				files: ['a', 'b', 'c'].map((n) => ({ path: `${n}.md`, body: 'x'.repeat(100_000) }))
			})
		).rejects.toMatchObject({ code: 'INVALID' });
	});

	it('imports a SKILL.md with files, and an import without files keeps the files', async () => {
		const text = FILE.replace('release-checklist', 'imported-files');
		const first = await importSkill(w.ctx('member'), {
			project: w.projectKey,
			text,
			files: [{ path: 'form-validation.md', body: 'Validate.' }]
		});
		expect(first.skill.files).toEqual([{ path: 'form-validation.md', size: 9 }]);
		const again = await importSkill(w.ctx('member'), {
			project: w.projectKey,
			text: text.replace('one paragraph', 'two')
		});
		expect(again.created).toBe(false);
		expect(again.skill.files).toEqual([{ path: 'form-validation.md', size: 9 }]);
		const replaced = await importSkill(w.ctx('member'), {
			project: w.projectKey,
			text: text.replace('one paragraph', 'two'),
			files: [{ path: 'other.md', body: 'Other.' }]
		});
		expect(replaced.skill.files).toEqual([{ path: 'other.md', size: 6 }]);
		const prompts = await promptSkills(w.ctx('member'));
		expect(prompts.find((p) => p.name === 'imported-files')?.files).toEqual(['other.md']);
	});
});
