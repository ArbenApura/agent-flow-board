// READING ONE DOCUMENT OF AN ITEM: A SECTION, A PHASE OR A DECISION, WITHOUT LOADING THE WHOLE ITEM
// The item is found and checked exactly as getItem does (same visibility and read rules); only the requested rows are read after that.

// -- TYPES -- //
import type { Ctx } from './context';
// -- DEP-MODULES -- //
import { and, asc, eq } from 'drizzle-orm';
// -- MODULES -- //
import { decision, phase, section, step } from '../db/schema';
import { OpError, requireCap, run } from './context';
import { canSeeItem, findItem } from './resolve';

// -- FUNCTIONS -- //

const mark = (state: string) => (state === 'done' ? '[x]' : state === 'open' ? '[ ]' : '[-]');

/** The text of `section:<slug>`, `phase:<key>` or `decision:<adr|settled>-<number>` on one item. NOT_FOUND when there is none. */
export async function readItemDoc(
	ctx: Ctx,
	nameOrId: string,
	doc: string
): Promise<{ ref: string; text: string }> {
	return run(ctx, async (tx) => {
		const it = await findItem(tx, ctx, nameOrId);
		const { role } = await requireCap(tx, ctx, 'read', it.projectId);
		if (!canSeeItem(role, it, ctx.actor.userId))
			throw new OpError('NOT_FOUND', `No item named "${nameOrId}".`);
		const [kind, key] = doc.split(':');
		let text: string | null = null;
		if (kind === 'section') {
			const [s] = await tx
				.select({ body: section.body })
				.from(section)
				.where(and(eq(section.itemId, it.id), eq(section.slug, key ?? '')));
			text = s?.body ?? null;
		} else if (kind === 'phase') {
			const [p] = await tx
				.select({ id: phase.id, title: phase.title })
				.from(phase)
				.where(and(eq(phase.itemId, it.id), eq(phase.key, key ?? '')));
			if (p) {
				const steps = await tx
					.select({ key: step.key, state: step.state, text: step.text })
					.from(step)
					.where(eq(step.phaseId, p.id))
					.orderBy(asc(step.position));
				text = `${p.title}\n${steps.map((s) => `${mark(s.state)} ${s.key} ${s.text}`).join('\n')}`;
			}
		} else if (kind === 'decision') {
			const [k, n] = (key ?? '').split('-');
			const number = Number(n);
			if ((k === 'adr' || k === 'settled') && Number.isInteger(number)) {
				const [x] = await tx
					.select()
					.from(decision)
					.where(
						and(eq(decision.itemId, it.id), eq(decision.kind, k), eq(decision.number, number))
					);
				text = x
					? [
							`${x.title}`,
							x.context && `Context: ${x.context}`,
							x.decision && `Decision: ${x.decision}`,
							x.alternatives && `Alternatives: ${x.alternatives}`,
							x.consequences && `Consequences: ${x.consequences}`,
							x.answer && `Answer: ${x.answer} (${x.source ?? 'no source'})`
						]
							.filter(Boolean)
							.join('\n')
					: null;
			}
		}
		if (text === null) throw new OpError('NOT_FOUND', `No document "${doc}" on ${it.ref}.`);
		return { ref: it.ref, text };
	});
}
