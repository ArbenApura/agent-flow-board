// GOOGLE AVATAR (AFB-20261115-0905): THE SIGN IN PICTURE IS KEPT AS BYTES, AN UPLOAD ALWAYS WINS AND A REMOVED PICTURE STAYS REMOVED

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
// IMPORTED MODULES
import { adoptGooglePicture } from '../../src/lib/server/auth/profilePicture';
import { user } from '../../src/lib/server/db/schema';
import { withTenant } from '../../src/lib/server/db/tenant';
import {
	adoptProviderAvatar,
	clearMyAvatar,
	readUserPicture,
	setMyAvatar
} from '../../src/lib/server/ops/pictures';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const GOOGLE = 'https://lh3.googleusercontent.com/a/ACg8ocXYZ=s96-c';
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]);

// -- FUNCTIONS -- //

describe('google avatar', () => {
	let db: TestDb;
	let w: World;
	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
	}, 120_000);
	afterAll(() => db?.stop());

	const setImage = (id: string, image: string | null) =>
		withTenant(db, { userId: id }, (tx) => tx.update(user).set({ image }).where(eq(user.id, id)));
	const imageOf = async (id: string) =>
		(
			await withTenant(db, { userId: id }, (tx) =>
				tx.select({ image: user.image }).from(user).where(eq(user.id, id))
			)
		)[0].image;
	const fakeFetch = (bytes: Uint8Array) =>
		(async () => new Response(bytes as BodyInit, { status: 200 })) as never;

	it('the picture is stored in place of the Google address and then served like an upload', async () => {
		const id = w.people.member;
		await setImage(id, GOOGLE);
		expect(await adoptGooglePicture(db, id, { fetch: fakeFetch(JPEG) })).toBe(true);
		expect(await imageOf(id)).toMatch(/^data:image\/jpeg;base64,/);
		const picture = await readUserPicture(db, id, id);
		expect(picture?.mime).toBe('image/jpeg');
		expect(Array.from(picture?.bytes ?? [])).toEqual(Array.from(JPEG));
		// Replace and remove still work afterwards
		await setMyAvatar(db, w.ctx('member').actor, PNG, 'image/png');
		expect((await readUserPicture(db, id, id))?.mime).toBe('image/png');
		await clearMyAvatar(db, w.ctx('member').actor);
		expect(await imageOf(id)).toBeNull();
	});

	it('an uploaded picture is never replaced, and a removed one is never brought back', async () => {
		const id = w.people.viewer;
		await setMyAvatar(db, w.ctx('viewer').actor, PNG, 'image/png');
		const uploaded = await imageOf(id);
		expect(await adoptGooglePicture(db, id, { fetch: fakeFetch(JPEG) })).toBe(false);
		expect(await imageOf(id)).toBe(uploaded);
		await clearMyAvatar(db, w.ctx('viewer').actor);
		expect(await adoptGooglePicture(db, id, { fetch: fakeFetch(JPEG) })).toBe(false);
		expect(await imageOf(id)).toBeNull();
	});

	it('a picture uploaded while the download was running wins', async () => {
		const id = w.people.admin;
		await setImage(id, GOOGLE);
		await setMyAvatar(db, w.ctx('admin').actor, PNG, 'image/png');
		expect(await adoptProviderAvatar(db, id, GOOGLE, JPEG, 'image/jpeg')).toBe(false);
		expect((await readUserPicture(db, id, id))?.mime).toBe('image/png');
	});

	it('a failed download leaves the address and never throws', async () => {
		const id = w.people.member;
		await setImage(id, GOOGLE);
		const broken = (async () => {
			throw new Error('network down');
		}) as never;
		expect(await adoptGooglePicture(db, id, { fetch: broken })).toBe(false);
		expect(await imageOf(id)).toBe(GOOGLE);
		expect(await adoptGooglePicture(db, 'no-such-user')).toBe(false);
	});
});
