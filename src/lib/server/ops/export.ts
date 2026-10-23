// THE REFERENCE COPY: READABLE MARKDOWN AND A LOSSLESS JSON SNAPSHOT OF A PROJECT'S PUBLIC ITEMS (SPEC 8)
// Private items and every attachment are left out always. The files are the same on every run for the same data, so an
// unchanged project writes no commit. A file never carries a person's name beyond an assignee who is still a member.

// -- TYPES -- //
import type { Tx } from '../db/client';
// -- DEP-MODULES -- //
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
// -- MODULES -- //
import {
	attachment,
	decision,
	event,
	item,
	itemAlias,
	manualCheck,
	phase,
	project,
	section,
	step,
	user
} from '../db/schema';

// -- TYPES -- //

export type PublishItem = Awaited<ReturnType<typeof loadPublishable>>['items'][number];
export type Exported = {
	/** Path inside the publish folder to file text. */
	files: Record<string, string>;
	/** A hash of each item's own files by reference, to show what changed since the last publish. */
	hashes: Record<string, string>;
	itemCount: number;
};

// -- FUNCTIONS -- //

/** FNV-1a over the text, as 8 hex digits twice (different seeds), enough to tell two renderings apart. */
export function hashText(text: string): string {
	let a = 0x811c9dc5;
	let b = 0x1b873593;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		a = Math.imul(a ^ c, 0x01000193) >>> 0;
		b = Math.imul(b + c, 0x85ebca6b) >>> 0;
		b ^= b >>> 13;
	}
	return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** Everything the export needs, read inside one tenant transaction. Private items stay out, and are only counted. */
export async function loadPublishable(tx: Tx, projectId: string) {
	const [proj] = await tx.select().from(project).where(eq(project.id, projectId));
	const rows = await tx
		.select({ it: item, assignee: user.name })
		.from(item)
		.leftJoin(user, eq(user.id, item.assigneeId))
		.where(
			and(eq(item.projectId, projectId), isNull(item.deletedAt), eq(item.visibility, 'public'))
		)
		.orderBy(asc(item.number));
	const [priv] = await tx
		.select({ n: sql<number>`count(*)::int` })
		.from(item)
		.where(
			and(eq(item.projectId, projectId), isNull(item.deletedAt), eq(item.visibility, 'private'))
		);
	const [privFiles] = await tx
		.select({ n: sql<number>`count(*)::int` })
		.from(attachment)
		.where(
			and(
				eq(attachment.projectId, projectId),
				isNull(attachment.deletedAt),
				eq(attachment.visibility, 'private')
			)
		);
	const [last] = await tx
		.select({ id: sql<number>`coalesce(max(${event.id}), 0)::int` })
		.from(event)
		.where(eq(event.projectId, projectId));
	const phases = await tx
		.select()
		.from(phase)
		.where(eq(phase.projectId, projectId))
		.orderBy(asc(phase.position));
	const steps = await tx
		.select()
		.from(step)
		.where(eq(step.projectId, projectId))
		.orderBy(asc(step.position));
	const checks = await tx
		.select()
		.from(manualCheck)
		.where(eq(manualCheck.projectId, projectId))
		.orderBy(asc(manualCheck.position));
	const decisions = await tx
		.select()
		.from(decision)
		.where(eq(decision.projectId, projectId))
		.orderBy(asc(decision.kind), asc(decision.number));
	const sections = await tx
		.select()
		.from(section)
		.where(eq(section.projectId, projectId))
		.orderBy(asc(section.position));
	const aliases = await tx.select().from(itemAlias).where(eq(itemAlias.projectId, projectId));
	const items = rows.map(({ it, assignee }) => ({
		item: it,
		assignee: assignee ?? null,
		phases: phases
			.filter((p) => p.itemId === it.id)
			.map((p) => ({ ...p, steps: steps.filter((s) => s.phaseId === p.id) })),
		manualChecks: checks.filter((c) => c.itemId === it.id),
		decisions: decisions.filter((d) => d.itemId === it.id),
		sections: sections.filter((s) => s.itemId === it.id),
		aliases: aliases.filter((a) => a.itemId === it.id).map((a) => a.alias)
	}));
	return {
		project: proj,
		items,
		privateItems: priv?.n ?? 0,
		privateFiles: privFiles?.n ?? 0,
		lastEventId: last?.id ?? 0
	};
}

const cell = (v: unknown) =>
	String(v ?? '')
		.replace(/\r?\n/g, ' ')
		.replace(/\|/g, '\\|')
		.trim();
const line = (v: unknown) =>
	String(v ?? '')
		.replace(/\r?\n/g, ' ')
		.trim();

function planMarkdown(i: PublishItem): string {
	const it = i.item;
	const out: string[] = [
		`# ${it.ref} ${line(it.title)}`,
		'',
		`- Status: ${it.status}`,
		`- Progress: ${it.percent}% (${it.doneSteps} of ${it.totalSteps} steps)`,
		`- Area: ${it.stream} / ${it.scope}`
	];
	if (it.tabName) out.push(`- Tab name: ${it.tabName}`);
	if (i.assignee) out.push(`- Assignee: ${line(i.assignee)}`);
	if (it.branchNote) out.push(`- Branch: ${line(it.branchNote)}`);
	if (i.aliases.length) out.push(`- Also known as: ${i.aliases.map(line).join(', ')}`);
	for (const p of i.phases) {
		out.push('', `## Phase ${p.key} ${line(p.title)}`);
		for (const s of p.steps) {
			const mark =
				s.state === 'done'
					? 'x'
					: s.state === 'waived'
						? '-'
						: s.state === 'superseded'
							? '~'
							: ' ';
			out.push(`- [${mark}] ${s.key} ${line(s.text)}`);
			if (s.state === 'waived' && s.reason) out.push(`  - Waived: ${line(s.reason)}`);
		}
	}
	if (i.manualChecks.length) {
		out.push('', '## Manual checks');
		for (const c of i.manualChecks) {
			const mark =
				c.state === 'done'
					? 'x'
					: c.state === 'waived'
						? '-'
						: c.state === 'superseded'
							? '~'
							: ' ';
			out.push(`- [${mark}] ${c.key}${c.auto ? ' [auto]' : ''} ${line(c.text)}`);
			if (c.state === 'waived' && c.reason) out.push(`  - Waived: ${line(c.reason)}`);
		}
	}
	return out.join('\n') + '\n';
}

function decisionsMarkdown(i: PublishItem): string | null {
	if (!i.decisions.length) return null;
	const out: string[] = [`# Decisions of ${i.item.ref}`];
	for (const d of i.decisions.filter((x) => x.kind === 'adr')) {
		out.push('', `## ADR-${String(d.number).padStart(3, '0')} ${line(d.title)}`);
		for (const [label, text] of [
			['Context', d.context],
			['Decision', d.decision],
			['Alternatives', d.alternatives],
			['Consequences', d.consequences]
		] as const)
			if (text) out.push('', `**${label}.** ${text}`);
	}
	const settled = i.decisions.filter((x) => x.kind === 'settled');
	if (settled.length) {
		out.push(
			'',
			'## Settled without asking',
			'',
			'| Question | Answer | Source |',
			'|---|---|---|',
			...settled.map((d) => `| ${cell(d.title)} | ${cell(d.answer)} | ${cell(d.source)} |`)
		);
	}
	return out.join('\n') + '\n';
}

function progressMarkdown(i: PublishItem): string {
	const it = i.item;
	const open = i.phases.flatMap((p) =>
		p.steps.filter((s) => s.state === 'open').map((s) => `- ${s.key} ${line(s.text)}`)
	);
	const out = [
		`# Progress of ${it.ref}`,
		'',
		`- Status: ${it.status}`,
		`- Progress: ${it.percent}%`,
		`- Steps done: ${it.doneSteps} of ${it.totalSteps}`,
		`- Manual checks open: ${it.openManual}`
	];
	if (it.health.drift.length) out.push(`- Warnings: ${it.health.drift.join(', ')}`);
	out.push(
		'',
		open.length ? '## Open steps' : '## Open steps',
		'',
		...(open.length ? open : ['None.'])
	);
	return out.join('\n') + '\n';
}

/** One item's files, by path inside its folder. */
export function itemFiles(i: PublishItem): Record<string, string> {
	const dir = `items/${i.item.ref}`;
	const files: Record<string, string> = {
		[`${dir}/PLAN.md`]: planMarkdown(i),
		[`${dir}/PROGRESS.md`]: progressMarkdown(i)
	};
	const decisions = decisionsMarkdown(i);
	if (decisions) files[`${dir}/DECISIONS.md`] = decisions;
	for (const s of i.sections)
		files[`${dir}/docs/${s.slug}.md`] = `# ${line(s.title)}\n\n${s.body.trimEnd()}\n`;
	return files;
}

/** The lossless part of one item: everything that was published, as data. */
function snapshotItem(i: PublishItem) {
	const it = i.item;
	return {
		ref: it.ref,
		number: it.number,
		title: it.title,
		tabName: it.tabName,
		stream: it.stream,
		scope: it.scope,
		status: it.status,
		percent: it.percent,
		branchNote: it.branchNote,
		assignee: i.assignee,
		aliases: i.aliases,
		createdAt: it.createdAt.toISOString(),
		phases: i.phases.map((p) => ({
			key: p.key,
			title: p.title,
			steps: p.steps.map((s) => ({
				key: s.key,
				text: s.text,
				state: s.state,
				reason: s.reason,
				requiredTarget: s.requiredTarget
			}))
		})),
		manualChecks: i.manualChecks.map((c) => ({
			key: c.key,
			text: c.text,
			auto: c.auto,
			state: c.state,
			reason: c.reason
		})),
		decisions: i.decisions.map((d) => ({
			kind: d.kind,
			number: d.number,
			title: d.title,
			context: d.context,
			decision: d.decision,
			alternatives: d.alternatives,
			consequences: d.consequences,
			answer: d.answer,
			source: d.source
		})),
		sections: i.sections.map((s) => ({ slug: s.slug, title: s.title, body: s.body }))
	};
}

/** Renders the whole publish folder for a project from what `loadPublishable` read. */
export function renderExport(data: Awaited<ReturnType<typeof loadPublishable>>): Exported {
	const files: Record<string, string> = {};
	const hashes: Record<string, string> = {};
	for (const i of data.items) {
		const own = itemFiles(i);
		Object.assign(files, own);
		hashes[i.item.ref] = hashText(
			JSON.stringify(Object.entries(own).sort(([a], [b]) => (a < b ? -1 : 1)))
		);
	}
	const proj = data.project;
	files['registry.md'] =
		[
			`# ${line(proj.name)} (${proj.key})`,
			'',
			'A reference copy written by Agent Flow Board. Edit the plans in the app, not here: the next publish replaces these files.',
			'',
			`${data.items.length} public item${data.items.length === 1 ? '' : 's'}.`,
			'',
			'| Ref | Title | Status | Progress | Area |',
			'|---|---|---|---|---|',
			...data.items.map(
				(i) =>
					`| [${i.item.ref}](items/${i.item.ref}/PLAN.md) | ${cell(i.item.title)} | ${i.item.status} | ${i.item.percent}% | ${cell(`${i.item.stream} / ${i.item.scope}`)} |`
			)
		].join('\n') + '\n';
	files['README.md'] = files['registry.md'];
	files['snapshot.json'] =
		JSON.stringify(
			{
				format: 'agent-flow-board-snapshot',
				version: 1,
				project: { key: proj.key, name: proj.name, streams: proj.streams },
				items: data.items.map(snapshotItem)
			},
			null,
			2
		) + '\n';
	return { files, hashes, itemCount: data.items.length };
}
