// PHASE 7: THE BOARD READ VERBS, THE REALTIME HUB (NOTIFY), AND WHAT A VIEWER MAY NOT SEE

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import {
	itemCore,
	itemExtras,
	latestEventId,
	mayReceive,
	orgOverview,
	projectSummary,
	refsFor,
	searchBoard
} from '../../src/lib/server/ops/board';
import { createItem, listItems, getItem } from '../../src/lib/server/ops/items';
import { recordSteps } from '../../src/lib/server/ops/steps';
import { setStatus } from '../../src/lib/server/ops/status';
import { removeMember } from '../../src/lib/server/orgs/orgs';
import { claim, startSession } from '../../src/lib/server/mcp/sessions';
import { getHub } from '../../src/lib/server/realtime/hub';
import type { Change } from '../../src/lib/server/realtime/notify';
import { makePostgres, type TestDb } from '../support/db';
import { PLAN, makeWorld, type World } from '../support/ops';

// -- FUNCTIONS -- //

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('board verbs and realtime', () => {
	const make = makePostgres;
	let db: TestDb;
	let w: World;
	beforeAll(async () => {
		db = await make();
		w = await makeWorld(db);
	});
	afterAll(async () => {
		await (await getHub(db)).close();
		await db.stop();
	});

	it('counts items by status and area, and leaves private items out for people who may not see them', async () => {
		const pub = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Public board item',
			stream: 'features',
			scope: 'core',
			...PLAN
		});
		await createItem(w.ctx('owner'), {
			project: w.projectKey,
			title: 'Private board item',
			visibility: 'private',
			stream: 'fixes',
			scope: 'routine'
		});
		const owner = await projectSummary(w.ctx('owner'), w.projectKey);
		const viewer = await projectSummary(w.ctx('viewer'), w.projectKey);
		expect(owner.total).toBe(2);
		expect(viewer.total).toBe(1);
		expect(viewer.byStatus.PLANNED).toBe(1);
		expect(viewer.areas).toEqual([{ stream: 'features', scope: 'core', n: 1 }]);
		expect(owner.areas.length).toBe(2);
		expect(viewer.caps).toEqual(['read', 'comment']);
		// The overview agrees
		const overview = await orgOverview(w.ctx('viewer'));
		expect(overview.find((o) => o.project.id === w.projectId)?.total).toBe(1);
		// The first page of a list says how many match, later pages do not repeat the count
		const first = await listItems(w.ctx('owner'), { project: w.projectKey, limit: 1 });
		expect(first.total).toBe(2);
		const next = await listItems(w.ctx('owner'), {
			project: w.projectKey,
			limit: 1,
			cursor: first.nextCursor!
		});
		expect(next.total).toBeUndefined();
		// The filters narrow it, and a percent sign in the box is text, not a wildcard
		expect(
			(await listItems(w.ctx('owner'), { project: w.projectKey, stream: 'fixes' })).items.length
		).toBe(1);
		expect(
			(await listItems(w.ctx('owner'), { project: w.projectKey, q: 'public' })).items.length
		).toBe(1);
		expect((await listItems(w.ctx('owner'), { project: w.projectKey, q: '%' })).items.length).toBe(
			0
		);
		expect(pub.ref).toBeTruthy();
	});

	it('search, references and the item page answer NOT_FOUND-style for a private item the viewer may not see', async () => {
		const secret = await createItem(w.ctx('owner'), {
			project: w.projectKey,
			title: 'Quokka private plan',
			visibility: 'private'
		});
		const shared = await createItem(w.ctx('owner'), {
			project: w.projectKey,
			title: 'Quokka shared plan'
		});
		const asOwner = await searchBoard(w.ctx('owner'), 'quokka');
		const asViewer = await searchBoard(w.ctx('viewer'), 'quokka');
		expect(asOwner.map((h) => h.itemRef).sort()).toEqual([secret.ref, shared.ref].sort());
		expect(asViewer.map((h) => h.itemRef)).toEqual([shared.ref]);
		expect(asViewer[0].projectKey).toBe(w.projectKey);
		// Another org sees nothing at all
		const stranger = {
			...w.ctx('owner'),
			orgId: w.other.orgId,
			actor: { userId: w.other.userId, kind: 'person' as const }
		};
		expect(await searchBoard(stranger, 'quokka')).toEqual([]);
		// References
		const refs = await refsFor(w.ctx('viewer'), w.projectKey, [secret.id, shared.id]);
		expect(refs).toEqual({ [shared.id]: shared.ref });
		// The page core refuses the private one
		await expect(itemCore(w.ctx('viewer'), secret.ref)).rejects.toMatchObject({
			code: 'NOT_FOUND'
		});
		const core = await itemCore(w.ctx('viewer'), shared.ref);
		expect(core.caps).toEqual(['read', 'comment']);
		const extras = await itemExtras(w.ctx('viewer'), core.item);
		expect(extras.events.length).toBeGreaterThan(0);
		expect(Object.values(core.people)).toContain('owner');
	});

	it('a change in a project reaches only that project, once the transaction commits', async () => {
		const hub = await getHub(db);
		const mine: (Change | null)[] = [];
		const theirs: (Change | null)[] = [];
		const offMine = hub.subscribe(w.projectId, (c) => mine.push(c));
		const offTheirs = hub.subscribe(w.other.projectId, (c) => theirs.push(c));
		const made = await createItem(w.ctx('member'), { project: w.projectKey, title: 'Live item' });
		await wait(300);
		expect(mine.length).toBeGreaterThan(0);
		const c = mine.find((x) => x?.v === 'item.create')!;
		expect(c).toMatchObject({ o: w.orgId, p: w.projectId, k: 'event', i: made.id });
		expect(typeof c.e).toBe('number');
		expect(theirs).toEqual([]);
		offMine();
		offTheirs();
	});

	it('a claim and a release announce themselves, and the running list follows them', async () => {
		const hub = await getHub(db);
		const seen: (Change | null)[] = [];
		const off = hub.subscribe(w.projectId, (c) => seen.push(c));
		const made = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Claimed item',
			...PLAN
		});
		const agent = w.ctx('member', { kind: 'agent', tool: 'Claude Code' });
		const s = await startSession(agent, { tool: 'Claude Code' });
		seen.length = 0;
		await claim(agent, s.sessionId, made.ref, '1');
		await wait(300);
		expect(seen.some((c) => c?.k === 'claim' && c.i === made.id)).toBe(true);
		const running = (await projectSummary(w.ctx('viewer'), w.projectKey)).running;
		expect(running).toHaveLength(1);
		expect(running[0]).toMatchObject({ itemRef: made.ref, phase: '1', tool: 'Claude Code' });
		expect(running[0].title.endsWith(`: ${made.ref}`)).toBe(true);
		seen.length = 0;
		await claim(agent, s.sessionId, null);
		await wait(300);
		expect(seen.some((c) => c?.k === 'claim')).toBe(true);
		expect((await projectSummary(w.ctx('viewer'), w.projectKey)).running).toEqual([]);
		off();
	});

	it('a stream is told to stop for a removed member and for a private item they may not see', async () => {
		const priv = await createItem(w.ctx('owner'), {
			project: w.projectKey,
			title: 'Hidden from the viewer',
			visibility: 'private'
		});
		expect(await mayReceive(w.ctx('viewer'), w.projectId)).toBe(true);
		expect(await mayReceive(w.ctx('viewer'), w.projectId, priv.id)).toBe(false);
		expect(await mayReceive(w.ctx('owner'), w.projectId, priv.id)).toBe(true);
		expect(await latestEventId(w.ctx('viewer'), w.projectId)).toBeGreaterThan(0);
		await removeMember(db, w.orgId, w.people.owner, w.people.viewer);
		expect(await mayReceive(w.ctx('viewer'), w.projectId)).toBe(false);
	});

	it('the drift warning follows the status the moment it changes', async () => {
		const made = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Drift item',
			...PLAN
		});
		await recordSteps(w.ctx('member'), {
			item: made.ref,
			marks: ['1.1', '1.2', '2.1', '2.2'].map((key) => ({ key, mark: 'done' as const }))
		});
		let d = (await getItem(w.ctx('member'), made.ref)).item;
		expect(d.status).toBe('IN REVIEW');
		expect(d.health.drift).not.toContain('complete-not-in-review');
		await recordSteps(w.ctx('member'), { item: made.ref, marks: [{ key: '2.2', mark: 'open' }] });
		d = (await getItem(w.ctx('member'), made.ref)).item;
		expect(d.health.drift).toContain('in-review-with-open-steps');
		await setStatus(w.ctx('member'), {
			item: made.ref,
			status: 'IN PROGRESS',
			note: 'More work is coming'
		});
		d = (await getItem(w.ctx('member'), made.ref)).item;
		expect(d.status).toBe('IN PROGRESS');
		expect(d.health.drift).toEqual([]);
	});
});
