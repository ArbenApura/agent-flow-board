// A TOOL THAT SIGNS IN WITH --ORG ASKS FOR ONE ORGANISATION (AFB-20261116-1440). The slug is only checked for its shape when the code starts, and it is enforced when
// a person approves at /device and when an agent approves through MCP. Every refusal reads the same, so slugs cannot be probed, and no tool that asks for nothing changes.

// IMPORTED DEP-MODULES
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { approveToolConnection } from '../../src/lib/server/ops/environments';
import {
	REQUESTED_ORG_REFUSAL,
	approveDevice,
	describeDevice,
	isOAuthError,
	startDevice
} from '../../src/lib/server/oauth/oauth';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- FUNCTIONS -- //

describe('a tool that asks for an organisation', () => {
	let db: TestDb;
	let w: World;
	let slug: string;
	let otherSlug: string;

	const start = async (org?: unknown, client = 'agent-flow-board bridge') => {
		const verifier = randomBytes(32).toString('base64url');
		const started = await startDevice(db, 'http://board.test', {
			client_name: client,
			code_challenge: createHash('sha256').update(verifier).digest('base64url'),
			code_challenge_method: 'S256',
			...(org === undefined ? {} : { org })
		});
		if (isOAuthError(started)) throw new Error(started.error_description);
		return { userCode: started.user_code, verifier };
	};
	const status = async (userCode: string) =>
		(
			await db.admin.query<{ status: string; requested_org: string | null }>(
				`select status, requested_org from device_code where user_code = '${userCode.replace('-', '')}'`
			)
		)[0];

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		slug = (
			await db.admin.query<{ slug: string }>(`select slug from org where id = '${w.orgId}'`)
		)[0].slug;
		otherSlug = (
			await db.admin.query<{ slug: string }>(`select slug from org where id = '${w.other.orgId}'`)
		)[0].slug;
	}, 240_000);
	afterAll(() => db?.stop());

	it('stores a lower cased slug, and never looks the organisation up', async () => {
		const t = await start('  World-Thing ');
		expect((await status(t.userCode)).requested_org).toBe('world-thing');
		// An organisation that does not exist is accepted at this point: an unauthenticated caller learns nothing about which ones do
		expect(isOAuthError(await startDevice(db, 'http://board.test', { org: 'no-such-org' }))).toBe(
			false
		);
	});

	it('refuses a requested organisation that is not a slug', async () => {
		for (const bad of ['A', '-x', 'has space', 'x'.repeat(60), 7, { a: 1 }, ['a-b'], 'ünï']) {
			const r = await startDevice(db, 'http://board.test', { org: bad });
			expect(isOAuthError(r) && r.error).toBe('invalid_request');
		}
	});

	it('a tool that asks for nothing is stored with nothing, as before', async () => {
		for (const none of [undefined, null, '']) {
			const r = await startDevice(db, 'http://board.test', { org: none });
			expect(isOAuthError(r)).toBe(false);
		}
		const t = await start();
		expect((await status(t.userCode)).requested_org).toBeNull();
		expect((await describeDevice(db, t.userCode))?.requestedOrg).toBeNull();
	});

	it('describeDevice returns the requested slug', async () => {
		const t = await start(slug);
		expect((await describeDevice(db, t.userCode))?.requestedOrg).toBe(slug);
	});

	it('a person approves for the requested organisation', async () => {
		const t = await start(slug);
		const r = await approveDevice(db, {
			userId: w.people.admin,
			typed: t.userCode,
			orgId: w.orgId,
			scopes: ['read']
		});
		expect(isOAuthError(r)).toBe(false);
		expect((await status(t.userCode)).status).toBe('approved');
	});

	it('a hand made post for another organisation, an empty one, a non member and a made up id all get the one refusal and leave the code pending', async () => {
		const t = await start(slug);
		const attempts = [
			{ userId: w.other.userId, orgId: w.other.orgId },
			{ userId: w.people.admin, orgId: '' },
			{ userId: w.other.userId, orgId: w.orgId },
			{ userId: w.people.admin, orgId: '00000000-0000-4000-8000-0000000000ff' }
		];
		for (const a of attempts) {
			const r = await approveDevice(db, { ...a, typed: t.userCode, scopes: ['read'] });
			expect(isOAuthError(r) && r.error_description).toBe(REQUESTED_ORG_REFUSAL);
		}
		// Not burned: the right person can still approve
		expect((await status(t.userCode)).status).toBe('pending');
		const ok = await approveDevice(db, {
			userId: w.people.admin,
			typed: t.userCode,
			orgId: w.orgId,
			scopes: ['read']
		});
		expect(isOAuthError(ok)).toBe(false);
	});

	it('a person in the other organisation cannot approve a code asked for a different one', async () => {
		const t = await start(otherSlug);
		const r = await approveDevice(db, {
			userId: w.people.admin,
			typed: t.userCode,
			orgId: w.orgId,
			scopes: ['read']
		});
		expect(isOAuthError(r) && r.error_description).toBe(REQUESTED_ORG_REFUSAL);
	});

	it('a code asked for no organisation still lets the person choose any of theirs', async () => {
		const t = await start();
		const r = await approveDevice(db, {
			userId: w.people.admin,
			typed: t.userCode,
			orgId: w.orgId,
			scopes: ['read']
		});
		expect(isOAuthError(r)).toBe(false);
	});

	it('a deleted organisation or a renamed slug reads the same refusal', async () => {
		const t = await start(slug);
		try {
			await db.admin.exec(`update org set slug = '${slug}-renamed' where id = '${w.orgId}'`);
			const renamed = await approveDevice(db, {
				userId: w.people.admin,
				typed: t.userCode,
				orgId: w.orgId,
				scopes: ['read']
			});
			expect(isOAuthError(renamed) && renamed.error_description).toBe(REQUESTED_ORG_REFUSAL);
			await db.admin.exec(
				`update org set slug = '${slug}', deleted_at = now() where id = '${w.orgId}'`
			);
			const deleted = await approveDevice(db, {
				userId: w.people.admin,
				typed: t.userCode,
				orgId: w.orgId,
				scopes: ['read']
			});
			expect(isOAuthError(deleted) && deleted.error_description).toBe(REQUESTED_ORG_REFUSAL);
		} finally {
			// The world is shared with the next tests, so it is put back even when an assertion above fails
			await db.admin.exec(
				`update org set slug = '${slug}', deleted_at = null where id = '${w.orgId}'`
			);
		}
	});

	it('an agent approves a code asked for its own organisation, and a code with no request as before', async () => {
		const asked = await start(slug, 'afb-checks');
		await expect(
			approveToolConnection(w.ctx('admin'), { userCode: asked.userCode, verifier: asked.verifier })
		).resolves.toMatchObject({ ok: true });
		const plain = await start(undefined, 'afb-checks');
		await expect(
			approveToolConnection(w.ctx('admin'), { userCode: plain.userCode, verifier: plain.verifier })
		).resolves.toMatchObject({ ok: true });
	});

	it("an agent on another organisation's connection is refused, told which connection to use, and the code stays pending", async () => {
		const t = await start(otherSlug, 'afb-checks');
		await expect(
			approveToolConnection(w.ctx('admin'), { userCode: t.userCode, verifier: t.verifier })
		).rejects.toMatchObject({
			code: 'FORBIDDEN',
			message: expect.stringContaining(`afb-${otherSlug}`)
		});
		expect((await status(t.userCode)).status).toBe('pending');
	});
});
