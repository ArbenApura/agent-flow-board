// ORGANISATION SETTINGS: NAME, PALETTE AND LOGO, LIMITS, EMAIL SENDING, BACKUPS AND THE AUDIT LOG (SPEC 11, ADR-015)
// Each section saves on its own, so every verb here changes one group of fields. All of them need the manage capability,
// which admins and owners hold. The palette is generated and checked on the server, never taken as CSS from the browser.

// -- TYPES -- //
import type { Ctx } from './context';
// -- DEP-MODULES -- //
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
// -- MODULES -- //
import { storedPalette } from '../../theme/css';
import { checkPalette, generatePalette } from '../../theme/palette';
import { backupHealth } from '../backup/run';
import { appendEvent } from '../db/events';
import { backupRun, event, org, project } from '../db/schema';
import type { OrgSettings } from '../db/schema/core';
import { OpError, requireCap, run } from './context';
import { loadPublishable, renderExport } from '../github/export';
import { actorFields } from './items';
import { pictureDataAddress } from './pictures';
import { findProject } from './resolve';

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
	allowGuestInvites: z.boolean().optional()
});
export const DEFAULT_SETTINGS: Required<OrgSettings> = {
	tokenMaxDays: 90,
	allowGuestInvites: true
};

// -- FUNCTIONS -- //

/** The org's limits with their defaults filled in. */
export const settingsOf = (s: OrgSettings | null | undefined): Required<OrgSettings> => {
	const own: Record<string, unknown> = { ...(s ?? {}) };
	// The day's trash clean up leaves its mark in the same record, and no page or token needs to see it
	delete own.trashPurgedAt;
	return { ...DEFAULT_SETTINGS, ...own } as Required<OrgSettings>;
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
		const limits: OrgSettings = { ...(o.settings ?? {}) };
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
		if ('tokenMaxDays' in after || 'allowGuestInvites' in after) set.settings = limits;
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

/** Whether backups are on for this server, how the newest one went, and the recent runs. */
export async function orgBackups(ctx: Ctx) {
	await run(ctx, (tx) => requireCap(tx, ctx, 'manage'));
	const health = await backupHealth(ctx.handle, ctx.orgId);
	const runs = await run(ctx, (tx) =>
		tx
			.select({
				id: backupRun.id,
				state: backupRun.state,
				size: backupRun.size,
				error: backupRun.error,
				createdAt: backupRun.createdAt
			})
			.from(backupRun)
			.where(inArray(backupRun.state, ['done', 'failed']))
			.orderBy(desc(backupRun.createdAt))
			.limit(10)
	);
	return { enabled: Boolean(ctx.services?.backups), health, runs };
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

/** The public items of a project as the files a publish would write, for a download. Private items are never in it. */
export async function exportProject(ctx: Ctx, projectKey: string) {
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, projectKey);
		await requireCap(tx, ctx, 'read', proj.id);
		const exported = renderExport(await loadPublishable(tx, proj.id));
		return { key: proj.key, files: exported.files, itemCount: exported.itemCount };
	});
}

/** One Markdown file from the files of an export: the registry first, then each file under its own path. */
export function exportAsMarkdown(files: Record<string, string>): string {
	const order = Object.keys(files)
		.filter((p) => p !== 'snapshot.json' && p !== 'README.md')
		.sort((a, b) => (a === 'registry.md' ? -1 : b === 'registry.md' ? 1 : a < b ? -1 : 1));
	return order.map((p) => `<!-- ${p} -->\n\n${files[p].trimEnd()}\n`).join('\n---\n\n');
}
