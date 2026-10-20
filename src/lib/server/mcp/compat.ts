// THE COMPATIBILITY VERBS (L15, L32): THE HAPR BOARD'S TOOL NAMES AND SHAPES, RUNNING ON THE NEW OPERATIONS LAYER
// Sessions that already know flow_get, flow_record, flow_claim and the rest keep working when HAPR moves here. Old ids
// (FLOW-20261007-1441, FEAT-066) resolve through item_alias inside the caller's org. They have no sessionId field, so an
// implicit session per token and tool carries the claim.

// -- DEP-MODULES -- //
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
// -- MODULES -- //
import { event, item, project, section, session } from '../db/schema';
import { projectSummary, searchBoard } from '../ops/board';
import { mayView } from '../ops/resolve';
import { addAttachment } from '../ops/attachments';
import { OpError, run } from '../ops/context';
import { createTask, listTasks, updateTask } from '../ops/docs';
import { createItem, getItem, listItems } from '../ops/items';
import { listProjects } from '../ops/projects';
import { recordSteps } from '../ops/steps';
import { setStatus } from '../ops/status';
import { claim, implicitSession } from './sessions';
import { summarize, type ToolBuilder } from './tools';

// -- CONSTANTS -- //

const TOOL = 'hapr-board-compat';
const OPEN = ['PLANNED', 'IN PROGRESS', 'IN REVIEW', 'ON HOLD'] as const;
const stepMark = z.object({
	key: z.string(),
	mark: z.enum(['done', 'open', 'waived', 'superseded']),
	reason: z.string().optional(),
	supersededBy: z.string().optional()
});
const DOC_SECTION: Record<string, string> = {
	SPEC: 'spec',
	DECISIONS: 'decisions',
	VALIDATION: 'validation',
	REFERENCES: 'references',
	PROGRESS: 'resume-here'
};
const PAGE = 6000;

// -- FUNCTIONS -- //

export function registerCompat({ tool }: ToolBuilder) {
	const ro = { readOnly: true };

	tool(
		'board_brief',
		'Open items and open tasks of every project you can see, at most 25 rows each.',
		{},
		ro,
		async (_a, { ctx }) => {
			const projects = await listProjects(ctx);
			const items: {
				ref: string;
				title: string;
				status: string;
				percent: number;
				project: string;
			}[] = [];
			for (const p of projects) {
				const page = await listItems(ctx, {
					project: p.key,
					status: [...OPEN],
					limit: 25,
					order: 'desc',
					trashed: false
				});
				for (const i of page.items)
					items.push({
						ref: i.ref,
						title: i.title.slice(0, 70),
						status: i.status,
						percent: i.percent,
						project: p.key
					});
			}
			const tasks: { ref: string; title: string; status: string }[] = [];
			for (const p of projects)
				for (const t of await listTasks(ctx, p.key))
					if (t.status !== 'DONE' && t.status !== 'DROPPED')
						tasks.push({ ref: `T-${t.number}`, title: t.title.slice(0, 70), status: t.status });
			// Sessions that left finished work unrecorded, so progress is not hidden behind a clean list
			const notRecorded: { ref: string; project: string; minutes: number }[] = [];
			for (const p of projects)
				for (const r of (await projectSummary(ctx, p.key)).running)
					if (r.staleMinutes !== null)
						notRecorded.push({ ref: r.itemRef, project: p.key, minutes: r.staleMinutes });
			return {
				items: items.slice(0, 25),
				notRecorded,
				openItems: items.length,
				tasks: tasks.slice(0, 25),
				openTasks: tasks.length
			};
		}
	);

	tool(
		'board_validate',
		'Check items for drift: planned with done steps, complete but not in review, in review with open steps, ready for sign-off.',
		{ ids: z.array(z.string()).max(20).optional() },
		ro,
		async (a, { ctx }) => {
			const names = a.ids?.length ? a.ids : null;
			const out: { ref: string; warning: string }[] = [];
			const rows = names
				? await Promise.all(names.map(async (n) => (await getItem(ctx, n)).item))
				: await run(ctx, async (tx) => {
						const open = await tx
							.select()
							.from(item)
							.where(
								and(
									eq(item.orgId, ctx.orgId),
									inArray(item.status, [...OPEN]),
									sql`${item.deletedAt} is null`
								)
							)
							.limit(200);
						// Only what this caller may see: a private item, or a project they have no role in, stays out
						const seen: typeof open = [];
						for (const row of open) if (await mayView(tx, ctx, row)) seen.push(row);
						return seen;
					});
			for (const i of rows) for (const w of i.health.drift) out.push({ ref: i.ref, warning: w });
			// A plan going to review should say what it learned, so the next plan can use it (a warning, never an error)
			const inReview = rows.filter((i) => i.status === 'IN REVIEW');
			if (inReview.length) {
				const withLessons = new Set(
					(
						await run(ctx, (tx) =>
							tx
								.select({ itemId: section.itemId })
								.from(section)
								.where(
									and(
										eq(section.slug, 'lessons'),
										inArray(
											section.itemId,
											inReview.map((i) => i.id)
										)
									)
								)
						)
					).map((r) => r.itemId)
				);
				for (const i of inReview)
					if (!withLessons.has(i.id))
						out.push({ ref: i.ref, warning: 'in-review-without-lessons' });
			}
			return { checked: rows.length, errors: [], warnings: out };
		}
	);

	tool(
		'flow_get',
		'One item: status, percent, version, phases, open steps, resume and blockers notes. include adds more.',
		{
			id: z.string(),
			include: z
				.array(
					z.enum([
						'phases',
						'open',
						'blockers',
						'resume',
						'tasks',
						'attachments',
						'log',
						'history',
						'related'
					])
				)
				.max(9)
				.optional(),
			logLines: z.number().int().min(1).max(20).optional()
		},
		ro,
		async (a, { ctx }) => {
			const d = await getItem(ctx, a.id);
			const out = summarize(d, ['sections']);
			const res = summarize(d);
			const o: Record<string, unknown> = { ...res, rev: d.item.version };
			if (a.include?.includes('log') || a.include?.includes('history')) {
				const rows = await run(ctx, (tx) =>
					tx
						.select({
							id: event.id,
							verb: event.verb,
							label: event.actorLabel,
							at: event.createdAt,
							after: event.after
						})
						.from(event)
						.where(eq(event.itemId, d.item.id))
						.orderBy(sql`${event.id} desc`)
						.limit(a.logLines ?? 5)
				);
				o.log = rows.map((r) => ({
					id: r.id,
					verb: r.verb,
					by: r.label,
					at: r.at,
					...(r.after ? { after: r.after } : {})
				}));
			}
			if (a.include?.includes('phases')) o.sections = out.sections;
			return o;
		}
	);

	tool(
		'flow_doc',
		'One document of an item: SPEC, PLAN, DECISIONS, VALIDATION, REFERENCES, PROGRESS or LOG.',
		{
			id: z.string(),
			doc: z.enum(['SPEC', 'PLAN', 'DECISIONS', 'VALIDATION', 'REFERENCES', 'PROGRESS', 'LOG']),
			section: z.string().optional(),
			offset: z.number().int().min(0).optional()
		},
		ro,
		async (a, { ctx }) => {
			const d = await getItem(ctx, a.id);
			let text: string;
			if (a.doc === 'PLAN')
				text = d.phases
					.map(
						(p) =>
							`## Phase ${p.key} ${p.title}\n${p.steps.map((s) => `- [${s.state === 'done' ? 'x' : s.state === 'open' ? ' ' : '-'}] ${s.key} ${s.text}`).join('\n')}`
					)
					.join('\n\n');
			else if (a.doc === 'DECISIONS')
				text = d.decisions
					.map(
						(x) =>
							`## ${x.kind === 'adr' ? 'ADR' : 'Settled'}-${x.number} ${x.title}\n${x.decision || x.answer || ''}`
					)
					.join('\n\n');
			else if (a.doc === 'LOG') {
				const rows = await run(ctx, (tx) =>
					tx
						.select({ verb: event.verb, label: event.actorLabel, at: event.createdAt })
						.from(event)
						.where(eq(event.itemId, d.item.id))
						.orderBy(asc(event.id))
						.limit(200)
				);
				text = rows
					.map((r) => `- ${r.at.toISOString().slice(0, 16)} ${r.label ?? ''} ${r.verb}`)
					.join('\n');
			} else {
				const parts = [
					d.sections.find((s) => s.slug === DOC_SECTION[a.doc]),
					...(a.doc === 'PROGRESS' ? [d.sections.find((s) => s.slug === 'blockers')] : [])
				].filter(Boolean);
				text = parts.map((s) => `### ${s!.title}\n${s!.body}`).join('\n\n');
			}
			if (a.section) {
				const i = text.indexOf(a.section);
				text = i >= 0 ? text.slice(i) : '';
			}
			const off = a.offset ?? 0;
			return {
				doc: a.doc,
				total: text.length,
				text: text.slice(off, off + PAGE),
				next: off + PAGE < text.length ? off + PAGE : null
			};
		}
	);

	tool(
		'flow_search',
		'Search items, sections, decisions and tasks.',
		{ query: z.string().min(1) },
		ro,
		async (a, { ctx }) => ({ hits: await searchBoard(ctx, a.query, { limit: 15 }) })
	);

	tool(
		'flow_record',
		'Mark steps and add one log line in one call. Returns the percent, statusChanges and the next phase.',
		{
			id: z.string(),
			steps: z.array(stepMark).max(30).optional(),
			log: z.string().min(3).max(500).optional(),
			expectRev: z.number().int().optional(),
			dryRun: z.boolean().optional()
		},
		{},
		async (a, { ctx }) => {
			const s = await implicitSession(ctx, TOOL);
			const c = { ...ctx, actor: { ...ctx.actor, sessionId: s.id } };
			const r = await recordSteps(c, {
				item: a.id,
				marks: a.steps ?? [],
				log: a.log,
				expectVersion: a.expectRev,
				dryRun: a.dryRun
			});
			return {
				...r,
				lastPhase: r.finishedPhases.at(-1) ?? null,
				summary: `${a.id} ${r.changed.map((x) => `${x.key} ${x.to}`).join(', ') || 'no step change'}, ${r.percent}%`
			};
		}
	);

	tool(
		'flow_set_status',
		'Set a status with a short note. COMPLETED needs every counted step closed.',
		{
			id: z.string(),
			status: z.enum(['PLANNED', 'IN PROGRESS', 'IN REVIEW', 'ON HOLD', 'COMPLETED', 'REMOVED']),
			note: z.string().min(3).max(160),
			confirmed: z.boolean().optional()
		},
		{},
		async (a, { ctx }) => {
			const s = await implicitSession(ctx, TOOL);
			const r = await setStatus(
				{ ...ctx, actor: { ...ctx.actor, sessionId: s.id } },
				{ item: a.id, status: a.status, note: a.note, confirmed: a.confirmed }
			);
			return { ...r, summary: `${a.id} ${a.status}` } as never;
		}
	);

	tool(
		'flow_claim',
		'Bind this session to an item and phase, "none" for work outside any item, or null to release.',
		{
			id: z.union([z.string(), z.null()]),
			phase: z.string().optional(),
			label: z.string().optional()
		},
		{},
		async (a, { ctx }) => {
			const s = await implicitSession(ctx, TOOL);
			const c = { ...ctx, actor: { ...ctx.actor, sessionId: s.id } };
			if (a.id === null || a.id === 'none') {
				const r = await claim(c, s.id, null);
				// "none" is an answer to the question of which item this work belongs to, so the Stop hook does not ask it again
				if (a.id === 'none')
					await run(c, (tx) =>
						tx
							.update(session)
							.set({ askedAt: sql`now()` })
							.where(eq(session.id, s.id))
					);
				return { claim: { item: a.id === 'none' ? 'none' : null }, displayTitle: r.displayTitle };
			}
			const r = await claim(c, s.id, a.id, a.phase);
			return {
				claim: { item: r.item?.ref, phase: r.phase },
				displayTitle: r.displayTitle,
				nextOpen: r.nextOpen
			};
		}
	);

	tool(
		'flow_new',
		'Register a new item. path is stream/scope/name; the title is the item title.',
		{
			path: z.string().regex(/^[a-z]+\/[a-z]+\/[a-z0-9-]+$/),
			title: z.string().min(3),
			tabName: z.string().optional(),
			project: z.string().optional()
		},
		{},
		async (a, { ctx }) => {
			const [stream, scope] = a.path.split('/');
			const projects = await listProjects(ctx);
			const p = a.project
				? projects.find((x) => x.key.toUpperCase() === a.project!.toUpperCase())
				: projects[0];
			if (!p) throw new OpError('NOT_FOUND', 'No project to put the item in. Pass project.');
			const s = await implicitSession(ctx, TOOL);
			const made = await createItem(
				{ ...ctx, actor: { ...ctx.actor, sessionId: s.id } },
				{ project: p.key, title: a.title, tabName: a.tabName, stream, scope }
			);
			return { ref: made.ref, id: made.id, tabName: made.item.tabName, project: p.key };
		}
	);

	tool(
		'flow_attach',
		'Attach a file to an item, privately by default.',
		{
			id: z.string(),
			filename: z.string(),
			caption: z.string().min(1).max(200),
			contentBase64: z.string(),
			kind: z.string().optional(),
			refs: z.array(z.string()).optional()
		},
		{},
		async (a, { ctx }) => {
			const bytes = Uint8Array.from(atob(a.contentBase64), (c) => c.charCodeAt(0));
			const r = await addAttachment(
				ctx,
				{
					item: a.id,
					filename: a.filename,
					caption: a.caption,
					kind: a.kind ?? 'file',
					refs: a.refs ?? [],
					visibility: 'private'
				},
				bytes
			);
			return { id: r.attachment.id, visibility: r.attachment.visibility };
		}
	);

	tool(
		'tasks_list',
		'Tasks with their linked item status.',
		{ project: z.string().optional() },
		ro,
		async (a, { ctx }) => {
			const projects = a.project ? [{ key: a.project }] : await listProjects(ctx);
			const out: { ref: string; title: string; status: string; linked: string[] }[] = [];
			for (const p of projects) {
				for (const t of await listTasks(ctx, p.key)) {
					const linked = t.linkedItemIds.length
						? await run(ctx, async (tx) => {
								const rows = await tx.select().from(item).where(inArray(item.id, t.linkedItemIds));
								// A private item that is not the caller's stays out of the task's links
								const seen: typeof rows = [];
								for (const row of rows) if (await mayView(tx, ctx, row)) seen.push(row);
								return seen;
							})
						: [];
					out.push({
						ref: `T-${t.number}`,
						title: t.title,
						status: t.status,
						linked: linked.map((l) => `${l.ref} ${l.status}`)
					});
				}
			}
			return { tasks: out, rev: out.length };
		}
	);

	tool(
		'tasks_add',
		'Add a task, optionally linked to items.',
		{
			title: z.string().min(3),
			project: z.string().optional(),
			link: z.array(z.string()).optional(),
			body: z.string().max(20_000).optional(),
			group: z.string().max(120).optional(),
			priority: z.string().max(20).optional()
		},
		{},
		async (a, { ctx }) => {
			const projects = await listProjects(ctx);
			const key = a.project ?? projects[0]?.key;
			if (!key) throw new OpError('NOT_FOUND', 'No project to put the task in. Pass project.');
			const t = await createTask(ctx, {
				project: key,
				title: a.title,
				linkedItems: a.link ?? [],
				body: a.body,
				groupName: a.group,
				priority: a.priority
			} as never);
			return { id: t.task.id, ref: t.ref };
		}
	);

	tool(
		'tasks_update',
		'Change a task: status, title or linked items. DONE needs arbenConfirmed in the old tool; here any person with write access may set it.',
		{
			id: z.string(),
			status: z.enum(['TODO', 'IN PROGRESS', 'DONE', 'DROPPED', 'FUTURE']).optional(),
			title: z.string().optional(),
			link: z.array(z.string()).optional(),
			body: z.string().max(20_000).optional(),
			group: z.string().max(120).nullable().optional(),
			priority: z.string().max(20).nullable().optional(),
			expectRev: z.number().int().optional()
		},
		{},
		async (a, { ctx }) => {
			const projects = await listProjects(ctx);
			let id = a.id;
			if (/^T-\d+$/i.test(a.id)) {
				const n = Number(a.id.slice(2));
				const rows = await run(ctx, async (tx) =>
					tx
						.select({ id: project.id })
						.from(project)
						.where(
							inArray(
								project.id,
								projects.map((p) => p.id)
							)
						)
				);
				const found = await Promise.all(
					rows.map((r) =>
						run(ctx, (tx) =>
							tx.execute(
								sql`select id from task where project_id = ${r.id} and number = ${n} and deleted_at is null`
							)
						)
					)
				);
				const hit = found.flatMap((f) => (f as unknown as { rows: { id: string }[] }).rows)[0];
				if (!hit) throw new OpError('NOT_FOUND', `No task ${a.id}.`);
				id = hit.id;
			}
			const r = await updateTask(ctx, {
				task: id,
				status: a.status,
				title: a.title,
				linkedItems: a.link,
				body: a.body,
				groupName: a.group,
				priority: a.priority,
				expectVersion: a.expectRev
			});
			return { changed: r.changed, status: r.task.status };
		}
	);
}
