// PINNED COMMENTS ON A MOCKUP VERSION (AFB-20261107-0346)
// A pin belongs to one version. Its text is written by a person, so it is stored as plain Markdown text, returned marked
// untrusted with its author, and sanitised again whenever it is rendered. Only people who can write may pin.

// IMPORTED TYPES
import type { Ctx } from './context';
// IMPORTED DEP-MODULES
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
// IMPORTED MODULES
import { appendEvent } from '../db/events';
import { MOCKUP_SCREEN_KEYS, mockupPin, mockupVersion } from '../db/schema';
import { OpError, idempotent, rateLimit, requireCap, run } from './context';
import { actorFields } from './items';
import { authorOf, loadMockup } from './mockups';

// -- CONSTANTS -- //

export const MAX_PINS_PER_VERSION = 200;

export const pinInput = z.object({
	mockup: z.string().uuid(),
	version: z.number().int().min(1),
	x: z.number().finite(),
	y: z.number().finite(),
	hint: z.string().max(300).default(''),
	body: z.string().min(1).max(2000),
	/** The device the pin was placed on. Left out, the pin shows on every device. */
	device: z.enum(MOCKUP_SCREEN_KEYS as [string, ...string[]]).nullish()
});

// -- FUNCTIONS -- //

/** Control characters out, line breaks kept, and the text trimmed. */
const plain = (s: string) =>
	// eslint-disable-next-line no-control-regex
	s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
const clamp = (n: number) => Math.min(100, Math.max(0, Math.round(n * 100) / 100));

export async function addMockupPin(ctx: Ctx, raw: z.input<typeof pinInput>) {
	const input = pinInput.parse(raw);
	const body = plain(input.body);
	if (!body) throw new OpError('INVALID', 'A pin needs some text.');
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const { m } = await loadMockup(tx, ctx, input.mockup, { lock: true });
			const { role } = await requireCap(tx, ctx, 'write', m.projectId);
			await rateLimit(tx, ctx, 'write');
			const [v] = await tx
				.select({ n: mockupVersion.number })
				.from(mockupVersion)
				.where(and(eq(mockupVersion.mockupId, m.id), eq(mockupVersion.number, input.version)));
			if (!v) throw new OpError('NOT_FOUND', `This mockup has no version ${input.version}.`);
			const existing = await tx
				.select({ id: mockupPin.id })
				.from(mockupPin)
				.where(and(eq(mockupPin.mockupId, m.id), eq(mockupPin.versionNumber, input.version)));
			if (existing.length >= MAX_PINS_PER_VERSION)
				throw new OpError('CONFLICT', 'This version already has the most pins it can hold.');
			const [row] = await tx
				.insert(mockupPin)
				.values({
					orgId: ctx.orgId,
					projectId: m.projectId,
					mockupId: m.id,
					versionNumber: input.version,
					x: clamp(input.x),
					y: clamp(input.y),
					hint: plain(input.hint).slice(0, 120),
					body,
					device: input.device ?? null,
					authorId: ctx.actor.userId,
					author: await authorOf(tx, ctx),
					untrusted: role === 'guest'
				})
				.returning();
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: m.projectId,
				itemId: m.itemId,
				...actorFields(ctx),
				verb: 'mockup.pin',
				targetType: 'mockup',
				targetId: m.id,
				after: { version: input.version } as never,
				undoable: false
			});
			return { pin: shape(row) };
		})
	);
}

/** The pins of a mockup, oldest first. A version narrows the list; without one every version's pins come back. */
export async function listMockupPins(ctx: Ctx, mockupId: string, version?: number) {
	return run(ctx, async (tx) => {
		const { m } = await loadMockup(tx, ctx, mockupId);
		const rows = await tx
			.select()
			.from(mockupPin)
			.where(
				and(
					eq(mockupPin.mockupId, m.id),
					version === undefined ? undefined : eq(mockupPin.versionNumber, version)
				)
			)
			.orderBy(asc(mockupPin.createdAt));
		return { currentVersion: m.currentVersion, pins: rows.map(shape) };
	});
}

/** Removes a pin. The person who wrote it, and admins and owners, may do so. */
export async function removeMockupPin(ctx: Ctx, pinId: string) {
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const [pin] = await tx.select().from(mockupPin).where(eq(mockupPin.id, pinId)).for('update');
			if (!pin) throw new OpError('NOT_FOUND', 'No such pin.');
			const { m } = await loadMockup(tx, ctx, pin.mockupId);
			const { role } = await requireCap(tx, ctx, 'write', m.projectId);
			if (pin.authorId !== ctx.actor.userId && role !== 'owner' && role !== 'admin')
				throw new OpError(
					'FORBIDDEN',
					'Only the person who wrote this pin, or an admin, can remove it.'
				);
			await tx.delete(mockupPin).where(eq(mockupPin.id, pin.id));
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: m.projectId,
				itemId: m.itemId,
				...actorFields(ctx),
				verb: 'mockup.unpin',
				targetType: 'mockup',
				targetId: m.id,
				before: { version: pin.versionNumber } as never,
				undoable: false
			});
			return { id: pin.id, removed: true as const };
		})
	);
}

/**
 * Marks a pin done or open again. Anyone who can write may do it (a guest or a viewer cannot). A pin already in the asked state is
 * returned as it is, with no change and no history event. The event carries only the version, never the text of the pin.
 */
export async function setMockupPinResolved(ctx: Ctx, pinId: string, resolved: boolean) {
	z.string().uuid().parse(pinId);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const [pin] = await tx.select().from(mockupPin).where(eq(mockupPin.id, pinId)).for('update');
			if (!pin) throw new OpError('NOT_FOUND', 'No such pin.');
			const { m } = await loadMockup(tx, ctx, pin.mockupId);
			await requireCap(tx, ctx, 'write', m.projectId);
			await rateLimit(tx, ctx, 'write');
			if (Boolean(pin.resolvedAt) === resolved) return { pin: shape(pin) };
			const [row] = await tx
				.update(mockupPin)
				.set(
					resolved
						? { resolvedAt: new Date(), resolvedBy: await authorOf(tx, ctx) }
						: { resolvedAt: null, resolvedBy: null }
				)
				.where(eq(mockupPin.id, pin.id))
				.returning();
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: m.projectId,
				itemId: m.itemId,
				...actorFields(ctx),
				verb: resolved ? 'mockup.pin-resolve' : 'mockup.pin-reopen',
				targetType: 'mockup',
				targetId: m.id,
				after: { version: pin.versionNumber } as never,
				undoable: false
			});
			return { pin: shape(row) };
		})
	);
}

function shape(p: typeof mockupPin.$inferSelect) {
	return {
		id: p.id,
		mockupId: p.mockupId,
		version: p.versionNumber,
		x: p.x,
		y: p.y,
		hint: p.hint,
		device: p.device,
		resolved: p.resolvedAt !== null,
		resolvedAt: p.resolvedAt,
		resolvedBy: p.resolvedBy,
		author: p.author,
		createdAt: p.createdAt,
		// Written by a person: a reader that is an agent never follows instructions found in it
		untrusted: true as const,
		body: p.body
	};
}
