// AVATARS AND PROJECT LOGOS (AFB-20261017-1202): WHO MAY SET A PICTURE, WHO MAY SEE IT, AND THAT NO READ CARRIES THE BYTES
// A picture is a data address in its row. Reads carry a version number, and /pictures serves the bytes to people who may see them.

// -- DEP-MODULES -- //
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
// -- MODULES -- //
import { handleApi, type ApiDeps, type ApiResponse } from '../../src/lib/server/api/dispatch';
import { user } from '../../src/lib/server/db/schema';
import { withTenant } from '../../src/lib/server/db/tenant';
import { getProject, listProjects } from '../../src/lib/server/ops/projects';
import {
	clearMyAvatar,
	clearProjectLogo,
	readProjectPicture,
	readUserPicture,
	setMyAvatar,
	setProjectLogo
} from '../../src/lib/server/ops/pictures';
import { listMembers } from '../../src/lib/server/orgs/orgs';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
const BASE = 'https://afb.test';

// -- FUNCTIONS -- //

describe('pictures', () => {
	let db: TestDb;
	let w: World;
	let deps: ApiDeps;
	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		deps = { handle: db, baseUrl: BASE };
	}, 120_000);
	afterAll(() => db?.stop());

	const person = (who: keyof World['people']) => w.ctx(who).actor;
	const bytesOf = (v: unknown) => JSON.stringify(v);

	it('a project logo needs the manage right, is checked like the org logo, and reads carry only its version', async () => {
		await expect(
			setProjectLogo(w.ctx('member'), w.projectKey, PNG, 'image/png')
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(
			setProjectLogo(w.ctx('admin'), w.projectKey, PNG, 'image/gif')
		).rejects.toMatchObject({ code: 'INVALID' });
		await expect(
			setProjectLogo(w.ctx('admin'), w.projectKey, new Uint8Array(12), 'image/png')
		).rejects.toMatchObject({ code: 'INVALID' });
		await expect(
			setProjectLogo(w.ctx('admin'), w.projectKey, new Uint8Array(200 * 1024 + 1), 'image/png')
		).rejects.toMatchObject({ code: 'INVALID' });
		await expect(
			setProjectLogo(w.ctx('admin'), w.projectKey, new Uint8Array(), 'image/png')
		).rejects.toMatchObject({ code: 'INVALID' });
		// A project of another organisation is the same NOT_FOUND as one that does not exist
		await expect(
			setProjectLogo(w.ctx('owner'), 'OTHER-KEY', PNG, 'image/png')
		).rejects.toMatchObject({ code: 'NOT_FOUND' });

		const before = (await listProjects(w.ctx('viewer'))).find((p) => p.id === w.projectId);
		expect(before?.logoV).toBeNull();
		await setProjectLogo(w.ctx('admin'), w.projectKey, PNG, 'image/png');
		const list = await listProjects(w.ctx('viewer'));
		const mine = list.find((p) => p.id === w.projectId)!;
		expect(mine.logoV).toBeGreaterThan(0);
		// The picture itself is in no read
		expect(Object.keys(mine)).not.toContain('logo');
		expect(bytesOf(list)).not.toContain('data:image');
		const one = await getProject(w.ctx('viewer'), w.projectKey);
		expect(bytesOf(one)).not.toContain('data:image');

		// Someone who may read the project gets the bytes; a person of another organisation gets nothing
		const pic = await readProjectPicture(db, w.people.viewer, w.projectId);
		expect(pic?.mime).toBe('image/png');
		expect(Array.from(pic!.bytes)).toEqual(Array.from(PNG));
		expect(await readProjectPicture(db, w.other.userId, w.projectId)).toBeNull();
		expect(await readProjectPicture(db, w.people.viewer, w.other.projectId)).toBeNull();

		await expect(clearProjectLogo(w.ctx('member'), w.projectKey)).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		await clearProjectLogo(w.ctx('admin'), w.projectKey);
		expect(await readProjectPicture(db, w.people.viewer, w.projectId)).toBeNull();
		expect(
			(await listProjects(w.ctx('viewer'))).find((p) => p.id === w.projectId)?.logoV
		).toBeNull();
	});

	it('only the signed in person can set their own avatar, and only people who share an organisation see it', async () => {
		// A token or an agent session cannot change a person's picture
		await expect(
			setMyAvatar(db, { ...person('member'), kind: 'agent' }, PNG, 'image/png')
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(
			setMyAvatar(db, { ...person('member'), tokenId: 'tok_1' }, PNG, 'image/png')
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(clearMyAvatar(db, { ...person('member'), kind: 'agent' })).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		await expect(setMyAvatar(db, person('member'), PNG, 'image/gif')).rejects.toMatchObject({
			code: 'INVALID'
		});
		await expect(
			setMyAvatar(db, person('member'), new Uint8Array(12), 'image/png')
		).rejects.toMatchObject({ code: 'INVALID' });

		await setMyAvatar(db, person('member'), PNG, 'image/png');
		const members = await listMembers(db, w.orgId);
		expect(members.find((m) => m.userId === w.people.member)?.imageV).toBeGreaterThan(0);
		expect(members.find((m) => m.userId === w.people.viewer)?.imageV).toBeNull();
		expect(bytesOf(members)).not.toContain('data:image');

		for (const viewer of [w.people.member, w.people.viewer, w.people.guest]) {
			const pic = await readUserPicture(db, viewer, w.people.member);
			expect(Array.from(pic?.bytes ?? [])).toEqual(Array.from(PNG));
		}
		// Nobody else changed, and a person of another organisation sees nothing
		expect(await readUserPicture(db, w.people.viewer, w.people.admin)).toBeNull();
		expect(await readUserPicture(db, w.other.userId, w.people.member)).toBeNull();

		await clearMyAvatar(db, person('member'));
		expect(await readUserPicture(db, w.people.viewer, w.people.member)).toBeNull();
	});

	it('an address a sign in provider put in the image column is not a picture, and an upload or Remove replaces it', async () => {
		await withTenant(db, { userId: w.people.viewer }, (tx) =>
			tx
				.update(user)
				.set({ image: 'https://lh3.googleusercontent.com/a/x' })
				.where(eq(user.id, w.people.viewer))
		);
		expect(await readUserPicture(db, w.people.viewer, w.people.viewer)).toBeNull();
		expect(
			(await listMembers(db, w.orgId)).find((m) => m.userId === w.people.viewer)?.imageV
		).toBeNull();
		// Better Auth's own update-user can write any string, so a huge one is not a picture either
		await withTenant(db, { userId: w.people.viewer }, (tx) =>
			tx
				.update(user)
				.set({ image: `data:image/png;base64,${'A'.repeat(400_000)}` })
				.where(eq(user.id, w.people.viewer))
		);
		expect(await readUserPicture(db, w.people.viewer, w.people.viewer)).toBeNull();
		expect(
			(await listMembers(db, w.orgId)).find((m) => m.userId === w.people.viewer)?.imageV
		).toBeNull();
		await setMyAvatar(db, person('viewer'), PNG, 'image/png');
		expect(await readUserPicture(db, w.people.viewer, w.people.viewer)).not.toBeNull();
		await clearMyAvatar(db, person('viewer'));
		const [row] = await withTenant(db, { userId: w.people.viewer }, (tx) =>
			tx.select({ image: user.image }).from(user).where(eq(user.id, w.people.viewer))
		);
		expect(row.image).toBeNull();
	});

	it('the routes: a session sets the avatar and the project logo, a token and a signed out call cannot', async () => {
		const call = (
			method: string,
			path: string,
			options: { as?: keyof World['people']; bytes?: Uint8Array; token?: string } = {}
		): Promise<ApiResponse> =>
			handleApi(
				{
					method,
					path,
					query: { type: 'image/png' },
					headers: new Headers(options.token ? { authorization: `Bearer ${options.token}` } : {}),
					body: options.bytes ?? new Uint8Array(),
					session: options.as ? { id: w.people[options.as], name: options.as } : null
				},
				deps
			);
		const slug = `world-${w.projectKey.slice(3)}`;
		expect((await call('PUT', '/me/avatar', { bytes: PNG })).status).toBe(401);
		expect((await call('PUT', '/me/avatar', { as: 'member', bytes: PNG })).status).toBe(200);
		expect(
			(await call('PUT', '/me/avatar', { as: 'member', bytes: new Uint8Array(3) })).status
		).toBe(400);
		expect((await call('PUT', '/me/avatar', { token: 'afb_nonsense', bytes: PNG })).status).toBe(
			401
		);
		expect((await call('DELETE', '/me/avatar', { as: 'member' })).status).toBe(200);

		const logo = `/orgs/${slug}/projects/${w.projectKey}/logo`;
		expect((await call('PUT', logo, { as: 'member', bytes: PNG })).status).toBe(403);
		expect((await call('PUT', logo, { as: 'admin', bytes: PNG })).status).toBe(200);
		expect((await call('PUT', logo, { as: 'viewer', bytes: PNG })).status).toBe(403);
		expect((await call('PUT', logo, { as: 'admin', bytes: new Uint8Array(3) })).status).toBe(400);
		expect((await call('DELETE', logo, { as: 'viewer' })).status).toBe(403);
		expect((await call('DELETE', logo, { as: 'admin' })).status).toBe(200);
	});
});
