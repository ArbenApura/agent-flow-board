// PICTURES: A PERSON'S AVATAR AND A PROJECT'S LOGO, KEPT AS SMALL DATA ADDRESSES AND SERVED FROM /pictures (ADR 1 OF AFB-20261017-1202)
// Reads never carry the picture. They carry a version number, and the page asks /pictures/{kind}/{id}?v=<version> for the bytes.

// -- TYPES -- //
import type { DbHandle } from '../db/client';
import type { Actor, Ctx } from './context';
// -- DEP-MODULES -- //
import { and, eq, sql } from 'drizzle-orm';
// -- MODULES -- //
import { appendEvent } from '../db/events';
import { member, project, user } from '../db/schema';
import { withTenant } from '../db/tenant';
import { listMyOrgs } from '../orgs/orgs';
import { OpError, requireCap, run } from './context';
import { actorFields } from './items';
import { findProject } from './resolve';

// -- CONSTANTS -- //

export const MAX_PICTURE_BYTES = 200 * 1024;
/** A 200 KB picture as a base64 data address, with room for the prefix. The same cap as userPictureV. */
const MAX_STORED_LENGTH = 300_000;
const PICTURE_TYPES: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp'
};

// -- FUNCTIONS -- //

/**
 * Checks a picture and returns it as a data address. The type must be PNG, JPEG or WebP, the size 200 KB at most, and the
 * first bytes must be that type's own signature, so a renamed file is not taken for a picture.
 */
export function pictureDataAddress(bytes: Uint8Array, mime: string, what = 'picture'): string {
	if (!PICTURE_TYPES[mime])
		throw new OpError('INVALID', `The ${what} must be a PNG, JPEG or WebP picture.`);
	if (bytes.byteLength === 0 || bytes.byteLength > MAX_PICTURE_BYTES)
		throw new OpError(
			'INVALID',
			`The ${what} must be smaller than ${MAX_PICTURE_BYTES / 1024} KB.`
		);
	const head = Buffer.from(bytes.subarray(0, 12));
	const ok =
		(mime === 'image/png' &&
			head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
		(mime === 'image/jpeg' && head[0] === 0xff && head[1] === 0xd8) ||
		(mime === 'image/webp' &&
			head.subarray(0, 4).toString() === 'RIFF' &&
			head.subarray(8, 12).toString() === 'WEBP');
	if (!ok) throw new OpError('INVALID', 'That file is not the kind of picture it says it is.');
	return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

/** The type and bytes of a stored data address, or null for anything else (an empty value, an address on another site). */
export function decodePicture(value: string | null | undefined) {
	// A column that Better Auth's own update-user can write is not trusted for size: anything over the cap is no picture
	if ((value?.length ?? 0) > MAX_STORED_LENGTH) return null;
	const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value ?? '');
	if (!m) return null;
	return { mime: m[1], bytes: new Uint8Array(Buffer.from(m[2], 'base64')) };
}

// -- PROJECT LOGO -- //

/** Sets a project's logo. Needs the manage right on that project, like every other project setting. */
export async function setProjectLogo(
	ctx: Ctx,
	projectKey: string,
	bytes: Uint8Array,
	mime: string
) {
	const logo = pictureDataAddress(bytes, mime, 'logo');
	return run(ctx, async (tx) => {
		const p = await findProject(tx, ctx, projectKey);
		await requireCap(tx, ctx, 'manage', p.id);
		await writeProjectLogo(tx, ctx, p.id, logo, { logo: `${bytes.byteLength} bytes` }, {});
		return { size: bytes.byteLength };
	});
}

export async function clearProjectLogo(ctx: Ctx, projectKey: string) {
	return run(ctx, async (tx) => {
		const p = await findProject(tx, ctx, projectKey);
		await requireCap(tx, ctx, 'manage', p.id);
		await writeProjectLogo(tx, ctx, p.id, null, { logo: null }, { logo: 'set' });
		return { cleared: true };
	});
}

async function writeProjectLogo(
	tx: Parameters<Parameters<typeof run>[1]>[0],
	ctx: Ctx,
	projectId: string,
	logo: string | null,
	after: Record<string, unknown>,
	before: Record<string, unknown>
) {
	await tx
		.update(project)
		.set({ logo, updatedAt: sql`now()`, version: sql`${project.version} + 1` })
		.where(eq(project.id, projectId));
	// The event also tells every open page of the project that something changed, so they ask for the new picture
	await appendEvent(tx, {
		orgId: ctx.orgId,
		projectId,
		...actorFields(ctx),
		verb: 'project.update',
		targetType: 'project',
		targetId: projectId,
		before: before as never,
		after: after as never,
		undoable: false
	});
}

// -- AVATAR -- //

/** Only the signed in person themselves may change their picture: not a token, not an agent session. */
function requireSelf(actor: Actor) {
	if (actor.kind !== 'person' || actor.tokenId)
		throw new OpError('FORBIDDEN', 'Only the signed in person can change their own picture.');
}

/** Sets the avatar of the acting person. It belongs to the person, not to an organisation, so no org is involved. */
export async function setMyAvatar(handle: DbHandle, actor: Actor, bytes: Uint8Array, mime: string) {
	requireSelf(actor);
	const image = pictureDataAddress(bytes, mime, 'picture');
	await withTenant(handle, { userId: actor.userId }, (tx) =>
		tx
			.update(user)
			.set({ image, updatedAt: sql`now()` })
			.where(eq(user.id, actor.userId))
	);
	return { size: bytes.byteLength };
}

/** Removes the avatar, whatever it holds (an uploaded picture, or an address a sign in provider put there). */
export async function clearMyAvatar(handle: DbHandle, actor: Actor) {
	requireSelf(actor);
	await withTenant(handle, { userId: actor.userId }, (tx) =>
		tx
			.update(user)
			.set({ image: null, updatedAt: sql`now()` })
			.where(eq(user.id, actor.userId))
	);
	return { cleared: true };
}

// -- READING A PICTURE -- //

export type Picture = { mime: string; bytes: Uint8Array; version: number };

/** A person's avatar for someone who may see it: themselves, or anyone who shares an organisation with them. */
export async function readUserPicture(
	handle: DbHandle,
	viewerId: string,
	targetId: string
): Promise<Picture | null> {
	if (viewerId !== targetId) {
		let shared = false;
		for (const o of await listMyOrgs(handle, viewerId)) {
			if (o.deletedAt) continue;
			shared = await withTenant(handle, { orgId: o.id, userId: viewerId }, async (tx) => {
				const [m] = await tx
					.select({ id: member.id })
					.from(member)
					.where(and(eq(member.orgId, o.id), eq(member.userId, targetId)));
				return Boolean(m);
			});
			if (shared) break;
		}
		if (!shared) return null;
	}
	const [row] = await withTenant(handle, { userId: viewerId }, (tx) =>
		tx
			.select({
				image: user.image,
				version: sql<number>`floor(extract(epoch from ${user.updatedAt}) * 1000)::float8`
			})
			.from(user)
			.where(eq(user.id, targetId))
	);
	const decoded = decodePicture(row?.image);
	return decoded ? { ...decoded, version: row.version } : null;
}

/** A project's logo for someone who may read that project. A project of another organisation answers null. */
export async function readProjectPicture(
	handle: DbHandle,
	viewerId: string,
	projectId: string
): Promise<Picture | null> {
	for (const o of await listMyOrgs(handle, viewerId)) {
		if (o.deletedAt) continue;
		const ctx: Ctx = { handle, orgId: o.id, actor: { userId: viewerId, kind: 'person' } };
		try {
			const row = await run(ctx, async (tx) => {
				const [p] = await tx
					.select({
						logo: project.logo,
						version: sql<number>`floor(extract(epoch from ${project.updatedAt}) * 1000)::float8`
					})
					.from(project)
					.where(and(eq(project.id, projectId), eq(project.orgId, o.id)));
				if (!p) return null;
				await requireCap(tx, ctx, 'read', projectId);
				return p;
			});
			if (!row) continue;
			const decoded = decodePicture(row.logo);
			return decoded ? { ...decoded, version: row.version } : null;
		} catch (e) {
			if (e instanceof OpError) continue;
			throw e;
		}
	}
	return null;
}
