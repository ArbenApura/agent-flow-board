// ADVISORY DEV-SERVER REGISTRATIONS ON THE BOARD (AFB-20261113-1008)
// Trust split (step A.1): the board holds only advisory display facts (dev URL, profile names, last status, reason code and fix line).
// Executable config (startCommand, allowWrites, writeAllowlist) lives ONLY in the bridge's local sealed registry and is refused here.

// IMPORTED TYPES
import type { Ctx } from './context';
import type { DbHandle } from '../db/client';
import type { RunnerAuth } from './environments';
// IMPORTED DEP-MODULES
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
// IMPORTED MODULES
import { appendEvent } from '../db/events';
import { DEV_STATUSES, devRegistration, member, org, project, runner } from '../db/schema';
import { withTenant } from '../db/tenant';
import { devRegistrationInput } from '../db/zod';
import { atLeast } from '../orgs/roles';
import { ORG_LOCKED_MESSAGE, OpError, requireCap, run } from './context';
import { actorFields } from './items';
import { findProject } from './resolve';

// -- CONSTANTS -- //

/** Fixed local ports that checks must never target or claim. */
export const FORBIDDEN_DEV_PORTS: ReadonlySet<number> = new Set([5180, 5190, 5433]);
export const DEV_WRITE_GUARD_NOTE =
	'Browser-layer only (service workers blocked, all HTTP methods, sendBeacon and WebSocket routed through the guard).';

export const DEV_STATUS_FIX_LINES: Record<string, string> = {
	DEV_URL_REACHABLE: 'Dev server is reachable.',
	DEV_URL_UNREACHABLE:
		'Start the local dev server or add a sealed --start command with dev approval.',
	DEV_CROSS_HOST_REDIRECT:
		'Point --dev-url at an origin that does not redirect to another host or port.',
	DEV_START_FAILED: 'Check the dev server command and dependencies, then run the check again.',
	DEV_START_TIMEOUT:
		'Confirm the dev server listens on the registered --dev-url port within the startup window.',
	DEV_OVERLAY_ERROR:
		'Fix the compiler or runtime error shown by the dev server overlay and re-run.',
	DEV_HMR_DISCONNECTED: 'Ensure the Vite dev server is running and reload the page.',
	DEV_HMR_PENDING: 'Wait for active Vite HMR updates to settle or fix the failing module update.',
	DEV_NETWORK_BUSY: 'Check for hanging API requests or continuous polling on the screen.',
	DEV_PROFILE_MISSING:
		'Save a dev sign-in with: agent-flow-board check login <NAME> --profile <PROFILE> --org <slug>.',
	DEV_PROFILE_EXPIRED:
		'Renew the expired sign-in with: agent-flow-board check login <NAME> --profile <PROFILE> --org <slug>.',
	DEV_DB_NOT_THROWAWAY:
		'Point the dev server .env at a throwaway test database rather than port 5433 or a hosted production database.',
	DEV_ALLOWLIST_GET_REFUSED:
		'Only write methods (POST, PUT, PATCH, DELETE) belong in --write-allowlist; GET is not covered by approval.',
	DEV_ALLOWLIST_HOST_NOT_REGISTERED:
		'A write-allowlist entry that names a host ("POST https://<host>/path") needs that host in --extra-hosts on the same registration.',
	DEV_WRITE_STOPPED:
		'A POST to a data host is stopped by the write guard. If it only reads (a stable RPC), allow it by name: --write-allowlist "POST https://<host>/rest/v1/rpc/<name>" with --extra-hosts <host> and --allow-writes, then approve the new dev hash.',
	DEV_APPROVAL_REQUIRED:
		'Approve the dev configuration with: agent-flow-board check approve --request --action dev --target <NAME>.',
	DEV_FALLBACK_READINESS:
		'Using load plus settle window because Vite HMR was not detected on the dev server.'
};

/** Resolves a canonical fixed fix line for a known dev status code (never untrusted raw text). */
export function devStatusFixLine(code: string | null | undefined): string | null {
	if (!code) return null;
	return (
		DEV_STATUS_FIX_LINES[code] ?? 'Run "agent-flow-board check doctor" to inspect the dev setup.'
	);
}

export type DevTargetSummary = {
	name: string;
	devUrl: string;
	reachable: boolean;
	status: string;
	signedIn: boolean;
	activeProfile: string | null;
	profiles: string[];
	code: string | null;
	fixLine: string | null;
	writeGuardNote: string;
	lastCheckedAt: string | null;
};
/** Hostnames allowed for a dev-server registration. */
const ALLOWED_DEV_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);
const PROFILE_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/i;
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,59}$/i;
const FORBIDDEN_LOCAL_KEYS = [
	'startCommand',
	'start_command',
	'allowWrites',
	'allow_writes',
	'writeAllowlist',
	'write_allowlist',
	'devApprovalHash'
] as const;

const DEV_REASON_CODES: ReadonlySet<string> = new Set(Object.keys(DEV_STATUS_FIX_LINES));
const reasonCodeSchema = z
	.string()
	.trim()
	.max(80)
	.refine((v) => DEV_REASON_CODES.has(v), 'Unknown dev status reason code.');

export const devRegistrationApiBody = devRegistrationInput.passthrough();

const saveSchema = devRegistrationInput.extend({
	project: z.string().trim().min(1).max(40),
	name: z
		.string()
		.trim()
		.regex(NAME_RE, 'A registration name uses letters, digits, dots, dashes or underscores.'),
	lastReasonCode: reasonCodeSchema.nullable().optional()
});

const runnerStatusSchema = z.object({
	project: z.string().trim().min(1).max(40),
	name: z
		.string()
		.trim()
		.regex(NAME_RE, 'A registration name uses letters, digits, dots, dashes or underscores.'),
	devUrl: z.string().trim().min(1).max(300),
	profiles: z.array(z.string().trim().regex(PROFILE_RE)).max(20).optional(),
	activeProfile: z.string().trim().regex(PROFILE_RE).nullable().optional(),
	status: z.enum(DEV_STATUSES),
	reasonCode: reasonCodeSchema.nullable().optional(),
	fixLine: z.string().trim().max(240).nullable().optional()
});

// -- TYPES -- //

export type DevRegistrationView = {
	id: string;
	name: string;
	devUrl: string;
	profiles: string[];
	activeProfile: string | null;
	lastStatus: string;
	lastReasonCode: string | null;
	lastFixLine: string | null;
	writeGuardNote: string;
	lastCheckedAt: string | null;
	updatedAt: string;
};

// -- FUNCTIONS -- //

/** Refuses local-only execution or write-policy fields if supplied through the board, MCP or API. */
export function assertNoLocalExecutionFields(raw: unknown): void {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
	const obj = raw as Record<string, unknown>;
	for (const key of FORBIDDEN_LOCAL_KEYS) {
		if (key in obj && obj[key] !== undefined) {
			throw new OpError(
				'INVALID',
				`${key} lives only in the bridge's local sealed registry and is never accepted or stored by the board.`
			);
		}
	}
}

/**
 * Validates and normalises a dev-server address. Accepts only http/https on localhost, 127.0.0.1 or [::1]
 * with an explicit port, and never 5180, 5190 or 5433.
 */
export function cleanDevUrl(raw: string): string {
	const text = String(raw ?? '').trim();
	let u: URL;
	try {
		u = new URL(text);
	} catch {
		throw new OpError(
			'INVALID',
			'Dev URL must be an http:// or https:// address with an explicit port.'
		);
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:')
		throw new OpError('INVALID', 'Dev URL must use http:// or https://.');
	if (u.username || u.password)
		throw new OpError('INVALID', 'Dev URL must not include a user name or password.');
	if (u.search || u.hash || (u.pathname && u.pathname !== '/'))
		throw new OpError('INVALID', 'Dev URL must be a plain origin with no path, query or hash.');
	const host = u.hostname.toLowerCase();
	if (!ALLOWED_DEV_HOSTS.has(host))
		throw new OpError('INVALID', 'Dev URL host must be localhost, 127.0.0.1 or [::1].');
	const portMatch = /^https?:\/\/[^/]+:(\d+)\/?$/i.exec(text);
	const portText = u.port || portMatch?.[1] || '';
	if (!/^\d+$/.test(portText))
		throw new OpError('INVALID', 'Dev URL must include an explicit port number.');
	const port = Number(portText);
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw new OpError('INVALID', 'Dev URL port must be between 1 and 65535.');
	if (FORBIDDEN_DEV_PORTS.has(port))
		throw new OpError(
			'FORBIDDEN',
			`Port ${port} is reserved by Agent Flow Board and cannot be used for dev checks.`
		);
	return `${u.protocol}//${host}:${port}`;
}

function cleanProfiles(list: string[] | undefined): string[] {
	if (!list) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of list) {
		const p = item.trim();
		if (!PROFILE_RE.test(p))
			throw new OpError(
				'INVALID',
				`Profile "${p.slice(0, 30)}" must use letters, digits, dots, dashes or underscores.`
			);
		const key = p.toLowerCase();
		if (!seen.has(key)) {
			seen.add(key);
			out.push(p);
		}
	}
	return out;
}

function formatFixLine(
	code: string | null | undefined,
	name: string,
	activeProfile: string | null | undefined,
	orgSlug?: string
): string | null {
	const raw = devStatusFixLine(code);
	if (!raw) return null;
	return raw
		.replace('<NAME>', name)
		.replace('<PROFILE>', activeProfile ?? 'default')
		.replace('<slug>', orgSlug ?? '<slug>');
}

function toView(row: typeof devRegistration.$inferSelect, orgSlug?: string): DevRegistrationView {
	const fixedLine = row.lastReasonCode
		? formatFixLine(row.lastReasonCode, row.name, row.activeProfile, orgSlug)
		: null;
	return {
		id: row.id,
		name: row.name,
		devUrl: row.devUrl,
		profiles: row.profiles,
		activeProfile: row.activeProfile,
		lastStatus: row.lastStatus,
		lastReasonCode: row.lastReasonCode,
		lastFixLine: fixedLine,
		writeGuardNote: DEV_WRITE_GUARD_NOTE,
		lastCheckedAt: row.lastCheckedAt ? row.lastCheckedAt.toISOString() : null,
		updatedAt: row.updatedAt.toISOString()
	};
}

/** Projects one dev registration row into the shared CLI/API/MCP dev-target status shape. */
export function devTargetSummary(
	row: typeof devRegistration.$inferSelect,
	orgSlug?: string
): DevTargetSummary {
	const code = row.lastReasonCode ?? null;
	return {
		name: row.name,
		devUrl: row.devUrl,
		reachable: row.lastStatus === 'reachable',
		status: row.lastStatus,
		signedIn: Boolean(row.activeProfile),
		activeProfile: row.activeProfile,
		profiles: row.profiles,
		code,
		fixLine: code ? formatFixLine(code, row.name, row.activeProfile, orgSlug) : null,
		writeGuardNote: DEV_WRITE_GUARD_NOTE,
		lastCheckedAt: row.lastCheckedAt ? row.lastCheckedAt.toISOString() : null
	};
}

/** Lists advisory dev registrations of one project. Caller must hold read access on the project. */
export async function listDevRegistrations(
	ctx: Ctx,
	projectKey: string
): Promise<DevRegistrationView[]> {
	return run(ctx, async (tx) => {
		const p = await findProject(tx, ctx, projectKey);
		await requireCap(tx, ctx, 'read', p.id);
		const [o] = await tx.select({ slug: org.slug }).from(org).where(eq(org.id, ctx.orgId));
		const rows = await tx
			.select()
			.from(devRegistration)
			.where(eq(devRegistration.projectId, p.id))
			.orderBy(asc(devRegistration.name));
		return rows.map((r) => toView(r, o?.slug));
	});
}

/** Saves advisory dev-registration metadata on the board. Manager role checked live; rejects local-only fields. */
export async function saveDevRegistration(
	ctx: Ctx,
	raw: Record<string, unknown>
): Promise<DevRegistrationView> {
	assertNoLocalExecutionFields(raw);
	const parsed = saveSchema.safeParse(raw);
	if (!parsed.success)
		throw new OpError('INVALID', parsed.error.issues[0]?.message ?? 'Invalid dev registration.');
	const input = parsed.data;
	const devUrl = cleanDevUrl(input.devUrl);
	const profiles = cleanProfiles(input.profiles);
	const activeProfile = input.activeProfile?.trim() || null;
	if (activeProfile && !PROFILE_RE.test(activeProfile))
		throw new OpError('INVALID', 'Active profile name is not valid.');
	return run(ctx, async (tx) => {
		const p = await findProject(tx, ctx, input.project);
		await requireCap(tx, ctx, 'manage', p.id);
		const [o] = await tx.select({ slug: org.slug }).from(org).where(eq(org.id, ctx.orgId));
		const actor = actorFields(ctx);
		const [existing] = await tx
			.select()
			.from(devRegistration)
			.where(and(eq(devRegistration.projectId, p.id), eq(devRegistration.name, input.name)));
		const now = new Date();
		const computedFixLine =
			input.lastReasonCode !== undefined
				? input.lastReasonCode
					? devStatusFixLine(input.lastReasonCode)
					: null
				: undefined;
		let saved: typeof devRegistration.$inferSelect;
		if (existing) {
			const [updated] = await tx
				.update(devRegistration)
				.set({
					devUrl,
					profiles,
					activeProfile,
					...(input.lastStatus ? { lastStatus: input.lastStatus } : {}),
					...(input.lastReasonCode !== undefined ? { lastReasonCode: input.lastReasonCode } : {}),
					...(computedFixLine !== undefined ? { lastFixLine: computedFixLine } : {}),
					updatedBy: ctx.actor.userId,
					updatedAt: now,
					version: sql`${devRegistration.version} + 1`
				})
				.where(eq(devRegistration.id, existing.id))
				.returning();
			if (!updated) throw new Error('Dev registration could not be saved.');
			saved = updated;
		} else {
			const [inserted] = await tx
				.insert(devRegistration)
				.values({
					orgId: ctx.orgId,
					projectId: p.id,
					name: input.name,
					devUrl,
					profiles,
					activeProfile,
					lastStatus: input.lastStatus ?? 'unknown',
					lastReasonCode: input.lastReasonCode ?? null,
					lastFixLine: computedFixLine ?? null,
					createdBy: ctx.actor.userId,
					updatedBy: ctx.actor.userId
				})
				.returning();
			if (!inserted) throw new Error('Dev registration could not be saved.');
			saved = inserted;
		}
		await appendEvent(tx, {
			orgId: ctx.orgId,
			projectId: p.id,
			...actor,
			verb: 'dev_registration.saved',
			targetType: 'dev_registration',
			targetId: saved.id,
			after: { name: saved.name, devUrl: saved.devUrl, profiles: saved.profiles }
		});
		return toView(saved, o?.slug);
	});
}

/** Removes an advisory dev registration of one project. Manager role checked live. */
export async function deleteDevRegistration(
	ctx: Ctx,
	projectKey: string,
	name: string
): Promise<{ ok: true }> {
	return run(ctx, async (tx) => {
		const p = await findProject(tx, ctx, projectKey);
		await requireCap(tx, ctx, 'manage', p.id);
		const [removed] = await tx
			.delete(devRegistration)
			.where(and(eq(devRegistration.projectId, p.id), eq(devRegistration.name, name)))
			.returning();
		if (!removed) throw new OpError('NOT_FOUND', `No dev registration named "${name}".`);
		await appendEvent(tx, {
			orgId: ctx.orgId,
			projectId: p.id,
			...actorFields(ctx),
			verb: 'dev_registration.deleted',
			targetType: 'dev_registration',
			targetId: removed.id,
			before: { name: removed.name, devUrl: removed.devUrl }
		});
		return { ok: true };
	});
}

/** Updates advisory dev-registration status from an authenticated bridge runner within its allowed projects. */
export async function reportDevRegistrationStatus(
	handle: DbHandle,
	runnerAuth: RunnerAuth,
	raw: unknown
): Promise<DevRegistrationView> {
	assertNoLocalExecutionFields(raw);
	const parsed = runnerStatusSchema.safeParse(raw);
	if (!parsed.success)
		throw new OpError('INVALID', parsed.error.issues[0]?.message ?? 'Invalid dev status update.');
	const input = parsed.data;
	const devUrl = cleanDevUrl(input.devUrl);
	const profiles = input.profiles ? cleanProfiles(input.profiles) : undefined;
	if (runnerAuth.kind === 'hosted')
		throw new OpError('FORBIDDEN', 'A hosted runner cannot report local dev targets.');
	return withTenant(handle, { orgId: runnerAuth.orgId }, async (tx) => {
		const [o] = await tx
			.select({ slug: org.slug, deletedAt: org.deletedAt })
			.from(org)
			.where(eq(org.id, runnerAuth.orgId));
		if (!o || o.deletedAt) throw new OpError('ORG_LOCKED', ORG_LOCKED_MESSAGE);
		const [r] = await tx
			.select({ id: runner.id, kind: runner.kind, ownerId: runner.ownerId })
			.from(runner)
			.where(and(eq(runner.id, runnerAuth.runnerId), eq(runner.orgId, runnerAuth.orgId)));
		if (!r) throw new OpError('FORBIDDEN', 'Runner registration is no longer active.');
		if (r.kind === 'tool') {
			const [m] = await tx
				.select({ role: member.role })
				.from(member)
				.where(and(eq(member.orgId, runnerAuth.orgId), eq(member.userId, r.ownerId ?? '')));
			if (!m || !atLeast(m.role, 'admin'))
				throw new OpError('FORBIDDEN', 'Tool runner owner no longer holds manage access.');
		}
		const [p] = await tx
			.select()
			.from(project)
			.where(
				and(eq(project.orgId, runnerAuth.orgId), eq(project.key, input.project.toUpperCase()))
			);
		if (!p) throw new OpError('NOT_FOUND', `No project "${input.project}" in this organisation.`);
		if (!runnerAuth.projectIds.includes(p.id))
			throw new OpError('FORBIDDEN', 'This runner does not serve that project.');
		const [existing] = await tx
			.select()
			.from(devRegistration)
			.where(and(eq(devRegistration.projectId, p.id), eq(devRegistration.name, input.name)));
		const fixedLine = input.reasonCode ? devStatusFixLine(input.reasonCode) : null;
		const now = new Date();
		if (existing) {
			const [updated] = await tx
				.update(devRegistration)
				.set({
					devUrl,
					...(profiles !== undefined ? { profiles } : {}),
					...(input.activeProfile !== undefined ? { activeProfile: input.activeProfile } : {}),
					lastStatus: input.status,
					lastReasonCode: input.reasonCode ?? null,
					lastFixLine: fixedLine,
					lastCheckedAt: now,
					updatedAt: now,
					version: sql`${devRegistration.version} + 1`
				})
				.where(eq(devRegistration.id, existing.id))
				.returning();
			if (!updated) throw new Error('Dev status could not be updated.');
			return toView(updated, o.slug);
		}
		const [inserted] = await tx
			.insert(devRegistration)
			.values({
				orgId: runnerAuth.orgId,
				projectId: p.id,
				name: input.name,
				devUrl,
				profiles: profiles ?? [],
				activeProfile: input.activeProfile ?? null,
				lastStatus: input.status,
				lastReasonCode: input.reasonCode ?? null,
				lastFixLine: fixedLine,
				lastCheckedAt: now
			})
			.returning();
		if (!inserted) throw new Error('Dev status could not be created.');
		return toView(inserted, o.slug);
	});
}
