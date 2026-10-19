// THE STANDARD STREAMS A NEW PROJECT STARTS WITH, AND THE RULES A LIST OF STREAMS MUST KEEP ON CREATE AND ON UPDATE

// -- DEP-MODULES -- //
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
import {
	MAX_SCOPES,
	MAX_STREAMS,
	STANDARD_STREAMS,
	standardStreams,
	streamsProblem
} from '../../src/lib/board/streams';
import { createProject, projectInput, updateProject } from '../../src/lib/server/ops/projects';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- FUNCTIONS -- //

describe('the standard streams', () => {
	it('fit the project limits and name no stream or scope twice', () => {
		const parsed = projectInput.parse({
			key: 'ABC',
			name: 'Alpha project',
			streams: STANDARD_STREAMS
		});
		expect(parsed.streams).toEqual(STANDARD_STREAMS);
		expect(STANDARD_STREAMS.length).toBeLessThanOrEqual(MAX_STREAMS);
		expect(STANDARD_STREAMS.every((s) => s.scopes.length <= MAX_SCOPES)).toBe(true);
		expect(streamsProblem(STANDARD_STREAMS)).toBeNull();
		expect(STANDARD_STREAMS.map((s) => s.stream)).toEqual([
			'features',
			'refactors',
			'fixes',
			'investigations'
		]);
	});

	it('are a fresh copy each time, so editing one project never changes the shared set', () => {
		const a = standardStreams();
		a[0].scopes.push('extra');
		a.pop();
		expect(standardStreams()).toEqual(STANDARD_STREAMS);
		expect(STANDARD_STREAMS[0].scopes).not.toContain('extra');
	});

	it('a project made without streams gets a copy of them, and an explicit empty list stays empty', () => {
		const a = projectInput.parse({ key: 'ABC', name: 'Alpha project' });
		const b = projectInput.parse({ key: 'ABD', name: 'Beta project' });
		expect(a.streams).toEqual(STANDARD_STREAMS);
		expect(a.streams).not.toBe(b.streams);
		a.streams[0].scopes.push('extra');
		expect(b.streams[0].scopes).not.toContain('extra');
		expect(projectInput.parse({ key: 'ABE', name: 'Gamma project', streams: [] }).streams).toEqual(
			[]
		);
	});
});

describe('what the server saves from a list of streams', () => {
	const parse = (streams: { stream: string; scopes: string[] }[]) =>
		projectInput.parse({ key: 'ABC', name: 'Alpha project', streams }).streams;

	it('trims names and drops a blank stream or scope', () => {
		expect(
			parse([
				{ stream: ' fixes ', scopes: [' core ', '  '] },
				{ stream: '   ', scopes: ['lost'] }
			])
		).toEqual([{ stream: 'fixes', scopes: ['core'] }]);
	});

	it('refuses a name over 40 characters, more than 20 streams or more than 20 scopes', () => {
		expect(() => parse([{ stream: 'x'.repeat(41), scopes: [] }])).toThrow();
		expect(() => parse([{ stream: 'x', scopes: ['y'.repeat(41)] }])).toThrow();
		const many = Array.from({ length: MAX_STREAMS + 1 }, (_, i) => ({
			stream: `s${i}`,
			scopes: []
		}));
		expect(() => parse(many)).toThrow();
		const scopes = Array.from({ length: MAX_SCOPES + 1 }, (_, i) => `c${i}`);
		expect(() => parse([{ stream: 'x', scopes }])).toThrow();
	});
});

describe('the rules for a list of streams', () => {
	it('refuse a stream or a scope named twice, without caring about case or spaces', () => {
		expect(
			streamsProblem([
				{ stream: 'fixes', scopes: [] },
				{ stream: ' Fixes ', scopes: [] }
			])
		).toMatch(/listed twice/);
		expect(streamsProblem([{ stream: 'fixes', scopes: ['core', ' CORE'] }])).toMatch(
			/listed twice in fixes/
		);
		// The same scope in two different streams is normal
		expect(
			streamsProblem([
				{ stream: 'features', scopes: ['core'] },
				{ stream: 'fixes', scopes: ['core'] }
			])
		).toBeNull();
	});

	it('ignore blank rows, and name the limits in plain words', () => {
		expect(streamsProblem([{ stream: '  ', scopes: [] }])).toBeNull();
		const many = Array.from({ length: MAX_STREAMS + 1 }, (_, i) => ({
			stream: `s${i}`,
			scopes: []
		}));
		expect(streamsProblem(many)).toMatch(/at most 20 streams/);
		expect(streamsProblem([{ stream: 'x'.repeat(41), scopes: [] }])).toMatch(/at most 40/);
	});
});

describe('project streams through the operations', () => {
	let db: TestDb;
	let w: World;

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
	}, 240_000);
	afterAll(() => db?.stop());

	it('createProject starts a project with the standard set, or with the list it is given, or with none', async () => {
		const plain = await createProject(w.ctx('admin'), { key: 'STD', name: 'Standard project' });
		expect(plain.streams).toEqual(STANDARD_STREAMS);
		const own = await createProject(w.ctx('admin'), {
			key: 'OWN',
			name: 'Own project',
			streams: [{ stream: 'ideas', scopes: ['core'] }]
		});
		expect(own.streams).toEqual([{ stream: 'ideas', scopes: ['core'] }]);
		const none = await createProject(w.ctx('admin'), {
			key: 'NON',
			name: 'Plain project',
			streams: []
		});
		expect(none.streams).toEqual([]);
	});

	it('create and update both refuse a duplicate, and the list that was saved is kept', async () => {
		await expect(
			createProject(w.ctx('admin'), {
				key: 'DUP',
				name: 'Duplicate project',
				streams: [
					{ stream: 'fixes', scopes: [] },
					{ stream: 'FIXES', scopes: [] }
				]
			})
		).rejects.toThrow(/listed twice/);
		await expect(
			updateProject(w.ctx('admin'), {
				project: w.projectKey,
				streams: [{ stream: 'fixes', scopes: ['a', 'A '] }]
			})
		).rejects.toThrow(/listed twice/);
		const saved = await updateProject(w.ctx('admin'), {
			project: w.projectKey,
			streams: standardStreams()
		});
		expect(saved.project.streams).toEqual(STANDARD_STREAMS);
		// Resetting to an empty list is still allowed
		const cleared = await updateProject(w.ctx('admin'), { project: w.projectKey, streams: [] });
		expect(cleared.project.streams).toEqual([]);
	});
});
