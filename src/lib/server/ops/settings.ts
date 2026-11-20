// ORGANISATION SETTINGS: NAME, PALETTE AND LOGO, LIMITS, EMAIL SENDING, BACKUPS AND THE AUDIT LOG (SPEC 11, ADR-015)
// Each section saves on its own, so every verb here changes one group of fields. All of them need the manage capability,
// which admins and owners hold. The palette is generated and checked on the server, never taken as CSS from the browser.

// IMPORTED TYPES
import type { Ctx } from './context';
// IMPORTED DEP-MODULES
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
// IMPORTED MODULES
import { storedPalette } from '../../theme/css';
import { checkPalette, generatePalette } from '../../theme/palette';
import { DEFAULT_RETENTION, backupHealth, type BackupHealth } from '../backup/run';
import { appendEvent } from '../db/events';
import { backupRun, event, org, project } from '../db/schema';
import type { OrgSettings } from '../db/schema/core';
import { OpError, requireCap, run } from './context';
import { actorFields } from './items';
import { pictureDataAddress } from './pictures';

// -- CONSTANTS -- //

export const orgSettingsInput = z.object({
	name: z.string().min(2).max(80).optional(),
	/** A six digit colour, or null to go back to the default palette. */
	accent: z
		.string()
		.regex(/^#[0-9a-fA-F]{6}$/, 'Use a six digit colour that starts with a hash')
		.nullable()
		.optional(),
	tokenMaxDays: z.number().int().min(1).max(90).optional(),
	allowGuestInvites: z.boolean().optional(),
	/** Turns the nightly backup of this organisation on or off. */
	autoBackups: z.boolean().optional()
});
type Limits = Required<Pick<OrgSettings, 'tokenMaxDays' | 'allowGuestInvites' | 'autoBackups'>>;
export const DEFAULT_SETTINGS: Limits = {
	tokenMaxDays: 90,
	allowGuestInvites: true,
	autoBackups: true
};

// -- FUNCTIONS -- //

/** The org's limits with their defaults filled in. */
export const settingsOf = (s: OrgSettings | null | undefined): Limits => {
	const own: Record<string, unknown> = { ...(s ?? {}) };
	// The day's trash clean up leaves its mark in the same record, and no page or token needs to see it
	delete own.trashPurgedAt;
	// The per-person agent switch was removed (AFB-20261115-1229); old keys of it stay in the stored record and must never reach a page or a token
	delete own.autoApproveBy;
	delete own.boardApprovals;
	return { ...DEFAULT_SETTINGS, ...own } as Limits;
};

/** What the Organisation settings page needs. Readable by every member, changeable by admins and owners. */
export async function getOrgSettings(ctx: Ctx) {
	return run(ctx, async (tx) => {
		const [o] = await tx.select().from(org).where(eq(org.id, ctx.orgId));
		if (!o) throw new OpError('NOT_FOUND', 'No such organisation.');
		const { caps } = await requireCap(tx, ctx, 'read');
		const palette = o.palette ? generatePalette(o.palette.seed) : null;
		return {
			id: o.id,
			name: o.name,
			slug: o.slug,
			logo: o.logo,
			accent: o.palette?.seed ?? null,
			paletteChecks: palette ? checkPalette(palette) : [],
			paletteAdjusted: palette?.adjusted ?? false,
			settings: settingsOf(o.settings),
			canManage: caps.includes('manage'),
			version: o.version
		};
	});
}

/** Changes the name, the accent palette and the limits. Only what is sent changes. */
export async function updateOrgSettings(ctx: Ctx, raw: z.input<typeof orgSettingsInput>) {
	const input = orgSettingsInput.parse(raw);
	return run(ctx, async (tx) => {
		await requireCap(tx, ctx, 'manage');
		const [o] = await tx.select().from(org).where(eq(org.id, ctx.orgId));
		const set: Record<string, unknown> = {};
		const before: Record<string, unknown> = {};
		const after: Record<string, unknown> = {};
		if (input.name !== undefined && input.name !== o.name) {
			set.name = input.name;
			before.name = o.name;
			after.name = input.name;
		}
		if (input.accent !== undefined) {
			const next =
				input.accent === null ? null : storedPalette(generatePalette(input.accent.toLowerCase()));
			if (JSON.stringify(next) !== JSON.stringify(o.palette)) {
				set.palette = next;
				before.accent = o.palette?.seed ?? null;
				after.accent = next?.seed ?? null;
			}
		}
		const limits: OrgSettings = {};
		if (
			input.tokenMaxDays !== undefined &&
			input.tokenMaxDays !== settingsOf(o.settings).tokenMaxDays
		) {
			before.tokenMaxDays = settingsOf(o.settings).tokenMaxDays;
			after.tokenMaxDays = input.tokenMaxDays;
			limits.tokenMaxDays = input.tokenMaxDays;
		}
		if (
			input.allowGuestInvites !== undefined &&
			input.allowGuestInvites !== settingsOf(o.settings).allowGuestInvites
		) {
			before.allowGuestInvites = settingsOf(o.settings).allowGuestInvites;
			after.allowGuestInvites = input.allowGuestInvites;
			limits.allowGuestInvites = input.allowGuestInvites;
		}
		if (
			input.autoBackups !== undefined &&
			input.autoBackups !== settingsOf(o.settings).autoBackups
		) {
			before.autoBackups = settingsOf(o.settings).autoBackups;
			after.autoBackups = input.autoBackups;
			limits.autoBackups = input.autoBackups;
		}
		// Only the changed limits are merged into the stored object in the same statement, so keys stored beside them (an old autoApproveBy, the trash purge mark) are never overwritten
		if ('tokenMaxDays' in after || 'allowGuestInvites' in after || 'autoBackups' in after)
			set.settings = sql`coalesce(${org.settings}, '{}'::jsonb) || ${JSON.stringify(limits)}::jsonb`;
		if (!Object.keys(set).length) return { changed: false };
		await tx
			.update(org)
			.set({ ...set, updatedAt: sql`now()`, version: sql`${org.version} + 1` })
			.where(eq(org.id, ctx.orgId));
		await appendOrgEvent(tx, ctx, 'org.settings', before, after);
		return { changed: true };
	});
}

/** Org level changes are recorded against the org's first project, which is where the audit log reads them. */
export async function appendOrgEvent(
	tx: Parameters<Parameters<typeof run>[1]>[0],
	ctx: Ctx,
	verb: string,
	before: Record<string, unknown>,
	after: Record<string, unknown>
) {
	const [first] = await tx
		.select({ id: project.id })
		.from(project)
		.where(eq(project.orgId, ctx.orgId))
		.orderBy(project.key)
		.limit(1);
	// An org with no project yet has nowhere to hang the event, so the change simply is not logged
	if (!first) return;
	await appendEvent(tx, {
		orgId: ctx.orgId,
		projectId: first.id,
		...actorFields(ctx),
		verb,
		targetType: 'org',
		targetId: ctx.orgId,
		before: before as never,
		after: after as never,
		undoable: false
	});
}

/** The logo is a small picture kept with the org, as a data address, so every page can show it with no extra request. */
export async function setOrgLogo(ctx: Ctx, bytes: Uint8Array, mime: string) {
	// Type, size and the file's own signature are checked by the one helper that avatars and project logos use too
	const logo = pictureDataAddress(bytes, mime, 'logo');
	return run(ctx, async (tx) => {
		await requireCap(tx, ctx, 'manage');
		await tx
			.update(org)
			.set({
				logo,
				updatedAt: sql`now()`,
				version: sql`${org.version} + 1`
			})
			.where(eq(org.id, ctx.orgId));
		await appendOrgEvent(tx, ctx, 'org.settings', {}, { logo: `${bytes.byteLength} bytes` });
		return { size: bytes.byteLength };
	});
}

export async function clearOrgLogo(ctx: Ctx) {
	return run(ctx, async (tx) => {
		await requireCap(tx, ctx, 'manage');
		await tx
			.update(org)
			.set({ logo: null, updatedAt: sql`now()`, version: sql`${org.version} + 1` })
			.where(eq(org.id, ctx.orgId));
		await appendOrgEvent(tx, ctx, 'org.settings', { logo: 'set' }, { logo: null });
		return { cleared: true };
	});
}

export const auditInput = z.object({
	/** Only events of this project key. */
	project: z.string().max(10).optional(),
	/** Events with an id below this one, so the log pages by keyset. */
	before: z.number().int().optional(),
	limit: z.number().int().min(1).max(200).default(50)
});

/** The audit log of the whole organisation, newest first: who did what, in which project. Admins and owners only. */
export async function orgAuditLog(ctx: Ctx, raw: z.input<typeof auditInput>) {
	const input = auditInput.parse(raw);
	return run(ctx, async (tx) => {
		await requireCap(tx, ctx, 'manage');
		const keys = new Map(
			(
				await tx
					.select({ id: project.id, key: project.key })
					.from(project)
					.where(eq(project.orgId, ctx.orgId))
			).map((p) => [p.id, p.key])
		);
		const only = input.project
			? [...keys].find(([, k]) => k === input.project!.toUpperCase())?.[0]
			: undefined;
		if (input.project && !only) return { events: [], next: null };
		const rows = await tx
			.select({
				id: event.id,
				projectId: event.projectId,
				verb: event.verb,
				targetType: event.targetType,
				targetId: event.targetId,
				actorLabel: event.actorLabel,
				tool: event.tool,
				before: event.before,
				after: event.after,
				createdAt: event.createdAt
			})
			.from(event)
			.where(
				and(
					eq(event.orgId, ctx.orgId),
					// A private note's events (its title) show only to its creator, the same rule as the project history. An event
					// of a note that was purged is hidden too: nobody can tell any more whether it was private.
					sql`(${event.targetType} <> 'note' or exists (select 1 from note n where n.id::text = ${event.targetId} and (n.visibility = 'public' or n.created_by = ${ctx.actor.userId})))`,
					only ? eq(event.projectId, only) : undefined,
					input.before !== undefined ? lt(event.id, input.before) : undefined
				)
			)
			.orderBy(desc(event.id))
			.limit(input.limit + 1);
		const page = rows.slice(0, input.limit);
		return {
			events: page.map((e) => ({ ...e, project: keys.get(e.projectId) ?? '' })),
			next: rows.length > input.limit ? page[page.length - 1].id : null
		};
	});
}

/**
 * How the newest backup looks for an org that paused its nightly backup: it is never late, because nothing is expected, but a
 * failed latest run (one made by hand) is still reported.
 */
const pausedHealth = (h: BackupHealth): BackupHealth => ({
	...h,
	late: false,
	ok: !h.lastFailed,
	message: h.lastFailed ? h.message : null
});

/** The health of the newest backup as an admin or owner reads it, the same on the page and on the REST route. */
export async function orgBackupHealth(ctx: Ctx): Promise<BackupHealth> {
	const autoBackups = await run(ctx, async (tx) => {
		await requireCap(tx, ctx, 'manage');
		const [o] = await tx.select({ settings: org.settings }).from(org).where(eq(org.id, ctx.orgId));
		return settingsOf(o?.settings).autoBackups;
	});
	const health = await backupHealth(ctx.handle, ctx.orgId);
	return autoBackups ? health : pausedHealth(health);
}

/** Whether backups are on for this server, how the newest one went, and the recent runs. */
export async function orgBackups(ctx: Ctx) {
	await run(ctx, (tx) => requireCap(tx, ctx, 'manage'));
	const health = await backupHealth(ctx.handle, ctx.orgId);
	const { runs, stored, autoBackups } = await run(ctx, async (tx) => {
		const [o] = await tx.select({ settings: org.settings }).from(org).where(eq(org.id, ctx.orgId));
		const rows = await tx
			.select({
				id: backupRun.id,
				state: backupRun.state,
				size: backupRun.size,
				error: backupRun.error,
				location: backupRun.location,
				createdAt: backupRun.createdAt
			})
			.from(backupRun)
			.where(inArray(backupRun.state, ['done', 'failed']))
			.orderBy(desc(backupRun.createdAt))
			.limit(10);
		// What is kept in total, over every good copy and not only the ten shown
		const [total] = await tx
			.select({
				bytes: sql<string>`coalesce(sum(${backupRun.size}), 0)::text`,
				copies: sql<number>`count(*)::int`
			})
			.from(backupRun)
			.where(eq(backupRun.state, 'done'));
		return {
			// The stored location is a server path and is never sent to a page, only whether a file is there to download
			runs: rows.map(({ location, ...r }) => ({ ...r, hasFile: Boolean(location) })),
			stored: { bytes: Number(total?.bytes ?? 0), copies: total?.copies ?? 0 },
			autoBackups: settingsOf(o?.settings).autoBackups
		};
	});
	return {
		enabled: Boolean(ctx.services?.backups),
		/** True when this server can hand the stored files out, so the page shows the download buttons. */
		canDownload: Boolean(ctx.services?.backupStorage),
		/** Whether the nightly job takes a copy of this org. Off means paused: never late, no alert. */
		autoBackups,
		// A paused org is not unhealthy: the newest copy ages without a warning, and the page says Paused
		health: autoBackups ? health : pausedHealth(health),
		runs,
		stored,
		retention: DEFAULT_RETENTION
	};
}

export const backupDeleteInput = z.object({
	ids: z.array(z.string().uuid()).min(1).max(50)
});

/**
 * Opens one finished backup for download, as the encrypted file it is stored as. The file is never decrypted here: the key stays
 * with the operator. Admins and owners only, and only a backup of this organisation.
 */
export async function backupDownload(ctx: Ctx, id: string) {
	const storage = ctx.services?.backupStorage;
	return run(ctx, async (tx) => {
		await requireCap(tx, ctx, 'manage');
		if (!storage) throw new OpError('INVALID', 'Backups are not set up on this server.');
		const [r] = await tx
			.select({
				id: backupRun.id,
				state: backupRun.state,
				location: backupRun.location,
				createdAt: backupRun.createdAt
			})
			.from(backupRun)
			.where(and(eq(backupRun.id, id), eq(backupRun.orgId, ctx.orgId)));
		if (!r) throw new OpError('NOT_FOUND', 'No such backup.');
		if (r.state !== 'done' || !r.location)
			throw new OpError('INVALID', 'Only a finished backup can be downloaded.');
		const size = await storage.size(r.location);
		const stream = size === null ? null : await storage.getStream(r.location);
		if (size === null || !stream) throw new OpError('NOT_FOUND', 'The stored file is gone.');
		const [o] = await tx.select({ slug: org.slug }).from(org).where(eq(org.id, ctx.orgId));
		await appendOrgEvent(tx, ctx, 'backup.download', {}, { backup: r.id, bytes: size });
		return {
			stream,
			size,
			filename: `afb-${o?.slug ?? 'org'}-${r.createdAt.toISOString().slice(0, 10)}.afbbak`
		};
	});
}

/**
 * Deletes backups of this organisation: the stored file first, then the record, so a record never points at a file that is gone.
 * A backup that is still running is refused. A file that cannot be removed keeps its record and is counted in `failed`.
 */
export async function backupDelete(ctx: Ctx, raw: z.input<typeof backupDeleteInput>) {
	const { ids } = backupDeleteInput.parse(raw);
	const unique = [...new Set(ids)];
	const storage = ctx.services?.backupStorage;
	return run(ctx, async (tx) => {
		await requireCap(tx, ctx, 'manage');
		const rows = await tx
			.select({
				id: backupRun.id,
				state: backupRun.state,
				size: backupRun.size,
				location: backupRun.location,
				createdAt: backupRun.createdAt
			})
			.from(backupRun)
			.where(and(eq(backupRun.orgId, ctx.orgId), inArray(backupRun.id, unique)));
		if (rows.length !== unique.length) throw new OpError('NOT_FOUND', 'No such backup.');
		if (rows.some((r) => r.state === 'running'))
			throw new OpError('CONFLICT', 'A backup that is still running cannot be deleted.');
		if (rows.some((r) => r.location) && !storage)
			throw new OpError('INVALID', 'Backups are not set up on this server.');
		const gone: string[] = [];
		let failed = 0;
		let freed = 0;
		for (const r of rows) {
			if (r.location) {
				try {
					await storage!.delete(r.location);
					// Proof that the space is free: the file must be gone when it is looked up again. A file that is still
					// there keeps its record, so the person sees it and the next delete or prune tries again
					if ((await storage!.size(r.location)) !== null)
						throw new Error('The file is still in storage after the delete.');
					freed += r.size ?? 0;
				} catch (e) {
					console.error(`Backup file ${r.location} was not removed from storage`, e);
					failed += 1;
					continue;
				}
			}
			gone.push(r.id);
		}
		if (gone.length) {
			await tx
				.delete(backupRun)
				.where(and(eq(backupRun.orgId, ctx.orgId), inArray(backupRun.id, gone)));
			await appendOrgEvent(
				tx,
				ctx,
				'backup.delete',
				{
					backups: rows
						.filter((r) => gone.includes(r.id))
						.map((r) => ({
							id: r.id,
							state: r.state,
							bytes: r.size,
							at: r.createdAt.toISOString()
						}))
				},
				{ deleted: gone.length, failed, freedBytes: freed }
			);
		}
		return { deleted: gone.length, failed, freedBytes: freed };
	});
}

/** How mail leaves this server, and a test mail to the person asking. A refused send says why. */
export async function sendTestEmail(ctx: Ctx, to: string) {
	await run(ctx, (tx) => requireCap(tx, ctx, 'manage'));
	const mailer = ctx.services?.mailer;
	if (!mailer) throw new OpError('INVALID', 'This server has no way to send email.');
	await mailer.send({
		to,
		subject: 'A test email from Agent Flow Board',
		text: 'If you can read this, sending email works.',
		html: '<p>If you can read this, sending email works.</p>',
		tag: 'test'
	});
	return { sent: true, via: mailer.kind };
}

export const emailStatus = (ctx: Ctx) => ({
	configured: Boolean(ctx.services?.mailer),
	provider: ctx.services?.mailer?.kind ?? null
});
