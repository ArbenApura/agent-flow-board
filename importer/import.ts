// WRITES A READ HAPR BOARD INTO A DATABASE AS AN ORGANISATION WITH ONE PROJECT (SPEC 13, ADR-018)
// Items, their plans, decisions, documents, history, log lines, attachments, UI changes and the attached run results become rows
// of the product's own tables, with their old dates. Nothing under the source board is written. Running it again skips every
// item that already has its FLOW id as an alias, so a half finished import can simply be started again.

// -- TYPES -- //
import type { Storage } from '../src/lib/server/adapters/storage';
import type { DbHandle } from '../src/lib/server/db/client';
import type { ShotResult, UiFlag } from '../src/lib/server/db/schema/integrations';
import type { ItemJson, RemovedRow, SourceAttachment, SourceBoard, SourceItem } from './read';
// -- DEP-MODULES -- //
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
// -- MODULES -- //
import { recalcItem } from '../src/lib/server/db/calc';
import {
	attachment,
	check,
	checkRun,
	decision,
	event,
	item,
	itemAlias,
	manualCheck,
	phase,
	project,
	projectCounter,
	section,
	step,
	task,
	uiChange,
	uiShotRun
} from '../src/lib/server/db/schema';
import { freeRefs, insertItemWithFreshRef } from '../src/lib/server/db/flowId';
import { withTenant } from '../src/lib/server/db/tenant';
import { legacyMoment } from '../src/lib/shared/ref';
import { createOrg, listMyOrgs } from '../src/lib/server/orgs/orgs';
import { attachmentBytes } from './read';
import { readBytes, sha256 } from './fsro';
import {
	dateOfId,
	dayStart,
	documentsOf,
	eventsOf,
	flowIdOf,
	removedSources,
	type Source
} from './shape';
import { parseDecisions, parsePlan, parseUiChanges, type ParsedTask } from './parse';

// -- TYPES -- //

export type ImportOptions = {
	handle: DbHandle;
	storage: Storage;
	org: { slug: string; name: string };
	project: { key: string; name: string };
	/** The id of an existing user who becomes the owner of the organisation. */
	ownerUserId: string;
	themes: { key: string; label: string }[];
	log?: (line: string) => void;
};
export type ImportSummary = {
	orgId: string;
	projectId: string;
	imported: number;
	skipped: number;
	removedRows: number;
	tasks: number;
	attachments: number;
	checkRuns: number;
	uiShotRuns: number;
	/** Things that did not map one to one and were kept another way, or could not be kept. */
	notes: string[];
};

// -- CONSTANTS -- //

const MIME: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	webp: 'image/webp',
	gif: 'image/gif',
	pdf: 'application/pdf',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	csv: 'text/csv',
	tsv: 'text/tab-separated-values',
	json: 'application/json',
	txt: 'text/plain',
	md: 'text/markdown',
	html: 'text/html',
	mp4: 'video/mp4',
	webm: 'video/webm',
	zip: 'application/zip'
};
const STREAMS = [
	{ stream: 'features', scopes: ['core', 'routes', 'components'] },
	{ stream: 'refactors', scopes: ['core', 'routes', 'components'] },
	{ stream: 'fixes', scopes: ['critical', 'routine'] },
	{ stream: 'investigations', scopes: ['integrations', 'schemas'] }
];
const ACTOR = { actorLabel: 'HAPR import', tool: 'importer' };
const FLOW_ID = /FLOW-\d{8}-\d{4}(?:-[a-z])?/g;

// -- FUNCTIONS: SMALL HELPERS -- //

const targetOf = (t: string | undefined): 'dev' | 'preview' | 'deployed' =>
	t === 'local' || t === 'preview' ? 'preview' : t === 'dev' ? 'dev' : 'deployed';

// -- FUNCTIONS: THE RUN RESULTS -- //

type Measure = {
	levels?: Record<
		string,
		{ fontSize?: number; fontWeight?: number; height?: number; width?: number; radius?: number }[]
	>;
};
const firstOf = (m: Measure | undefined) =>
	Object.fromEntries(
		Object.entries(m?.levels ?? {}).map(([k, v]) => {
			const e = v?.[0];
			return [
				k,
				e
					? {
							fontSize: e.fontSize ?? 0,
							fontWeight: e.fontWeight ?? 0,
							height: e.height ?? 0,
							width: e.width ?? 0,
							radius: e.radius ?? 0
						}
					: null
			];
		})
	);

// -- THE IMPORT -- //

/** Creates the organisation and project when they are not there yet, and returns their ids. Every write goes through row level security. */
async function ensureOrgAndProject(o: ImportOptions) {
	const mine = await listMyOrgs(o.handle, o.ownerUserId);
	let orgId = mine.find((m) => m.slug === o.org.slug)?.id;
	if (!orgId) {
		orgId = (await createOrg(o.handle, o.ownerUserId, { name: o.org.name, slug: o.org.slug })).id;
	}
	return withTenant(o.handle, { orgId, userId: o.ownerUserId }, async (tx) => {
		let [proj] = await tx
			.select({ id: project.id })
			.from(project)
			.where(and(eq(project.orgId, orgId), eq(project.key, o.project.key)));
		if (!proj)
			[proj] = await tx
				.insert(project)
				.values({
					orgId,
					key: o.project.key,
					name: o.project.name,
					webApp: true,
					streams: STREAMS,
					themes: o.themes,
					agentsMayComplete: false,
					staleDays: 3,
					defaultTarget: 'preview'
				})
				.returning({ id: project.id });
		await tx
			.insert(projectCounter)
			.values({ projectId: proj.id, orgId, next: 1, nextTask: 1 })
			.onConflictDoNothing();
		return { orgId, projectId: proj.id };
	});
}

type Ids = { orgId: string; projectId: string };

/** One item of the source board, written in one transaction. Returns what it added for the summary. */
async function writeItem(
	o: ImportOptions,
	ids: Ids,
	number: number,
	src: SourceItem | { removed: RemovedRow; title: string },
	idMap: SourceBoard['idMap'],
	notes: string[]
) {
	const removed = 'removed' in src ? src.removed : null;
	const full = 'removed' in src ? null : src;
	const j: ItemJson | null = full ? full.json : null;
	const flowId = j?.id ?? removed!.id;
	const legacyId = j ? j.legacyId : removed!.legacyId;
	// Set when the item is inserted: its reference is the project key and the real moment of its legacy id, in UTC
	let ref = '';
	const itemId = randomUUID();
	const created = dayStart(j?.created ?? dateOfId(flowId));
	const updated = j ? new Date(j.updated) : dayStart(removed!.updated.slice(0, 10));
	const counts = { checkRuns: 0, uiShotRuns: 0, attachments: 0 };
	await withTenant(
		o.handle,
		{ orgId: ids.orgId, projectId: ids.projectId, userId: o.ownerUserId },
		async (tx) => {
			// The reference comes from the legacy id's own date and time (+08:00, read as UTC), with the same candidate rules and
			// savepoint retry as a new item, so importing into an org that already has items never stops halfway. An id without a valid time
			// falls back to the creation day and is listed.
			const moment = legacyMoment(flowId);
			if (!moment)
				notes.push(
					`${flowId}: no valid time in the id, so its reference came from its creation day`
				);
			const free = await freeRefs(
				tx,
				ids.orgId,
				o.project.key,
				moment?.at ?? created,
				moment?.suffix ?? ''
			);
			const oldRef = `${o.project.key}-${number}`;
			// More than 26 in one minute is not expected; the old form keeps the item reachable and is listed
			if (!free.length)
				notes.push(`${flowId}: every suffix of its minute is taken, so it kept ${oldRef}`);
			const row = await insertItemWithFreshRef(tx, free.length ? free : [oldRef], {
				id: itemId,
				orgId: ids.orgId,
				projectId: ids.projectId,
				number,
				title: j?.title ?? ('removed' in src ? src.title : flowId),
				tabName: j?.tabName ?? null,
				stream: j?.stream ?? removed!.stream,
				scope: j?.scope ?? removed!.scope,
				status: (j?.status ?? removed!.status) as never,
				visibility: j?.visibility ?? 'public',
				branchNote: (j?.branch ?? removed!.branch).replace(/`/g, ''),
				legacyPercent: j ? j.legacyPercent : removed!.percent,
				createdBy: o.ownerUserId,
				createdAt: created,
				updatedAt: updated,
				lastActivityAt: updated
			});
			ref = row.ref;
			// The old reference stays as an alias too, so anything that used HAPR-2 keeps finding the item
			const aliases = new Set<string>(
				[flowId, oldRef].filter((a) => a.toUpperCase() !== ref.toUpperCase())
			);
			if (legacyId) aliases.add(legacyId);
			for (const m of idMap) if (m.flow === flowId) aliases.add(m.legacy);
			for (const alias of aliases)
				await tx
					.insert(itemAlias)
					.values({ orgId: ids.orgId, projectId: ids.projectId, itemId, alias })
					.onConflictDoNothing();

			// The plan: phases, steps and manual checks
			const plan = full?.docs.plan ? parsePlan(full.docs.plan) : null;
			if (plan) {
				const seenPhase = new Set<string>();
				const seenStep = new Set<string>();
				let pos = 0;
				for (const [pi, ph] of plan.phases.entries()) {
					if (seenPhase.has(ph.key)) {
						notes.push(`${flowId}: phase ${ph.key} appears twice, the second was not imported`);
						continue;
					}
					seenPhase.add(ph.key);
					const [prow] = await tx
						.insert(phase)
						.values({
							orgId: ids.orgId,
							projectId: ids.projectId,
							itemId,
							key: ph.key,
							title: ph.title,
							position: pi + 1
						})
						.returning({ id: phase.id });
					for (const st of ph.steps) {
						if (seenStep.has(st.key)) {
							notes.push(`${flowId}: step ${st.key} appears twice, the second was not imported`);
							continue;
						}
						seenStep.add(st.key);
						await tx.insert(step).values({
							orgId: ids.orgId,
							projectId: ids.projectId,
							itemId,
							phaseId: prow.id,
							key: st.key,
							text: st.text,
							state: st.state,
							reason:
								st.state === 'waived' || st.state === 'superseded'
									? st.notes.join('\n') || null
									: null,
							position: ++pos,
							doneAt: st.state === 'done' ? updated : null
						});
					}
				}
				const seenCheck = new Set<string>();
				for (const [ci, c] of plan.checks.entries()) {
					if (seenCheck.has(c.key)) continue;
					seenCheck.add(c.key);
					await tx.insert(manualCheck).values({
						orgId: ids.orgId,
						projectId: ids.projectId,
						itemId,
						key: c.key,
						text: c.text,
						auto: c.auto,
						state: c.state,
						reason:
							c.state === 'waived' || c.state === 'superseded' ? c.notes.join('\n') || null : null,
						position: ci + 1
					});
				}
				for (const u of plan.unplaced)
					notes.push(
						`${flowId}: a checklist line did not fit the grammar and stays in the plan document: ${u.slice(0, 80)}`
					);
			}

			// Documents
			const docs = documentsOf(src);

			// Decisions
			const dec = full?.docs.decisions ? parseDecisions(full.docs.decisions) : null;
			if (dec) {
				const used = new Set<number>();
				let nextFree = Math.max(0, ...dec.adrs.map((a) => a.number)) + 1;
				for (const [i, a] of dec.adrs.entries()) {
					let n = a.number;
					if (used.has(n)) {
						n = nextFree++;
						notes.push(`${flowId}: ADR-${a.number} appears twice, the second was numbered ${n}`);
					}
					used.add(n);
					await tx.insert(decision).values({
						orgId: ids.orgId,
						projectId: ids.projectId,
						itemId,
						kind: 'adr',
						number: n,
						title: a.title || `ADR-${a.number}`,
						context: a.context,
						decision: a.decision,
						alternatives: a.alternatives,
						consequences: a.consequences,
						position: i + 1
					});
				}
				for (const [i, s] of dec.settled.entries())
					await tx.insert(decision).values({
						orgId: ids.orgId,
						projectId: ids.projectId,
						itemId,
						kind: 'settled',
						number: s.number,
						title: s.question,
						answer: s.answer,
						source: s.source,
						position: i + 1
					});
			}
			for (const [i, d] of docs.entries())
				await tx.insert(section).values({
					orgId: ids.orgId,
					projectId: ids.projectId,
					itemId,
					slug: d.slug,
					title: d.title,
					body: d.body,
					position: i + 1
				});

			// History and log lines become events with their old dates
			for (const e of eventsOf(src))
				await tx.insert(event).values({
					orgId: ids.orgId,
					projectId: ids.projectId,
					itemId,
					actorUserId: o.ownerUserId,
					...ACTOR,
					verb: e.verb,
					targetType: 'item',
					targetId: itemId,
					before: (e.before ?? null) as never,
					after: (e.verb === 'item.create' ? { ...e.after, ref } : e.after) as never,
					undoable: false,
					createdAt: e.at
				});

			// UI changes table
			if (full?.docs.validation) {
				const uiRows = parseUiChanges(
					full.docs.validation,
					o.themes.map((t) => t.key)
				).rows;
				for (const [i, r] of uiRows.entries())
					await tx.insert(uiChange).values({
						orgId: ids.orgId,
						projectId: ids.projectId,
						itemId,
						page: r.page,
						stateRecipe: r.stateRecipe,
						themes: r.themes,
						accounts: r.accounts,
						siblings: r.siblings,
						levels: r.levels,
						viewports: r.viewports,
						position: i
					});
			}

			// Attachments, and the run results some of them carry
			const stored = new Map<string, string>();
			for (const a of full?.attachments ?? []) {
				const { bytes, actual, matches } = attachmentBytes(a);
				if (!matches)
					notes.push(`${flowId}: ${a.file} does not match the checksum its record gives`);
				const id = await putAttachment(
					tx,
					o,
					ids,
					itemId,
					a.file,
					a.caption,
					a.kind,
					a.visibility,
					a.refs,
					bytes,
					actual,
					dayStart(a.added)
				);
				stored.set(a.file, id);
				counts.attachments++;
			}
			for (const w of full?.workingFiles ?? []) {
				const bytes = readBytes(w.path);
				await putAttachment(
					tx,
					o,
					ids,
					itemId,
					w.rel.split('/').pop()!,
					w.rel,
					'working-file',
					'private',
					[],
					bytes,
					sha256(bytes),
					created
				);
				counts.attachments++;
			}
			for (const a of full?.attachments ?? []) {
				if (!/\.json$/i.test(a.file)) continue;
				if (/^Browser check run/i.test(a.caption))
					counts.checkRuns += await importCheckRun(
						tx,
						ids,
						itemId,
						a,
						stored.get(a.file)!,
						notes,
						flowId
					);
				else if (/^UI shots run/i.test(a.caption))
					counts.uiShotRuns += await importShotsRun(
						tx,
						o,
						ids,
						itemId,
						a,
						notes,
						flowId,
						(n) => (counts.attachments += n)
					);
			}

			// Calculated values, then the old dates back
			await recalcItem(tx, itemId);
			await tx
				.update(item)
				.set({ updatedAt: updated, lastActivityAt: updated, version: 1 })
				.where(eq(item.id, itemId));
		}
	);
	return counts;
}

async function putAttachment(
	tx: Parameters<Parameters<typeof withTenant>[2]>[0],
	o: ImportOptions,
	ids: Ids,
	itemId: string,
	file: string,
	caption: string,
	kind: string,
	visibility: 'public' | 'private',
	refs: string[],
	bytes: Uint8Array,
	sha: string,
	added: Date
) {
	const ext = file.split('.').pop()?.toLowerCase() ?? '';
	const key = `${ids.orgId}/${ids.projectId}/${randomUUID()}-${file.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120)}`;
	await o.storage.put(key, bytes, MIME[ext] ?? 'application/octet-stream');
	const [row] = await tx
		.insert(attachment)
		.values({
			orgId: ids.orgId,
			projectId: ids.projectId,
			itemId,
			visibility,
			caption,
			kind,
			refs,
			filename: file,
			mime: MIME[ext] ?? 'application/octet-stream',
			size: bytes.byteLength,
			checksum: sha,
			storageKey: key,
			createdAt: added
		})
		.returning({ id: attachment.id });
	return row.id;
}

type Tx = Parameters<Parameters<typeof withTenant>[2]>[0];

/** A kit browser check result becomes one run for each manual check it covers. */
async function importCheckRun(
	tx: Tx,
	ids: Ids,
	itemId: string,
	a: SourceAttachment,
	evidenceId: string,
	notes: string[],
	flowId: string
) {
	let j: {
		run_id?: string;
		check?: string;
		target?: string;
		deployed_commit?: string;
		git?: { commit?: string; dirty_hash?: string | null };
		started?: string;
		ended?: string;
		checks?: Record<string, { steps?: { status?: string }[] }>;
		run?: { status?: string; error?: string | null };
	};
	try {
		j = JSON.parse(attachmentBytes(a).bytes.toString('utf8'));
	} catch {
		notes.push(`${flowId}: ${a.file} is not valid JSON, so it stays an attachment only`);
		return 0;
	}
	let n = 0;
	for (const key of Object.keys(j.checks ?? {})) {
		const target = targetOf(j.target);
		let [chk] = await tx
			.select()
			.from(check)
			.where(eq(check.itemId, itemId))
			.then((r) => r.filter((x) => x.manualKey === key));
		if (!chk)
			[chk] = await tx
				.insert(check)
				.values({
					orgId: ids.orgId,
					projectId: ids.projectId,
					itemId,
					manualKey: key,
					script: `// Imported from the HAPR board. The kit check "${j.check ?? key}" ran this; its script is not imported.`,
					coveredPaths: [],
					requiredTarget: target
				})
				.returning();
		const steps = j.checks![key].steps ?? [];
		const failed = steps.some((s) => s.status && s.status !== 'pass');
		const result =
			j.run?.status === 'error'
				? 'error'
				: failed || (steps.length === 0 && j.run?.status !== 'pass')
					? 'fail'
					: 'pass';
		const started = j.started ? new Date(j.started) : dayStart(a.added);
		const ended = j.ended ? new Date(j.ended) : started;
		await tx.insert(checkRun).values({
			orgId: ids.orgId,
			projectId: ids.projectId,
			checkId: chk.id,
			target,
			requestedTarget: target,
			result,
			commit: j.deployed_commit ?? j.git?.commit ?? null,
			diffHash: j.git?.dirty_hash ?? null,
			durationMs: Math.max(0, ended.getTime() - started.getTime()),
			evidence: [evidenceId],
			reason: `Imported from HAPR run ${j.run_id ?? a.file}${j.run?.error ? `: ${j.run.error}` : ''}`,
			startedAt: started,
			finishedAt: ended,
			createdAt: started
		});
		n++;
	}
	return n;
}

/** A kit UI shots result becomes a finished shots run, with its pictures kept as private attachments. */
async function importShotsRun(
	tx: Tx,
	o: ImportOptions,
	ids: Ids,
	itemId: string,
	a: SourceAttachment,
	notes: string[],
	flowId: string,
	addAttachments: (n: number) => void
) {
	type Shot = {
		role?: string;
		route?: string;
		viewport?: string;
		image?: string;
		brand?: string;
		measure?: Measure;
	};
	let j: {
		run_id?: string;
		target?: string;
		git?: { commit?: string; dirty_hash?: string | null; changed_paths?: string[] };
		siblings?: Record<string, Shot>;
		rows?: {
			page?: string;
			state?: string;
			brands?: string[];
			shots?: Shot[];
			flags?: Record<string, unknown>[];
		}[];
	};
	try {
		j = JSON.parse(attachmentBytes(a).bytes.toString('utf8'));
	} catch {
		notes.push(`${flowId}: ${a.file} is not valid JSON, so it stays an attachment only`);
		return 0;
	}
	const results: ShotResult[] = [];
	const flags: UiFlag[] = [];
	const imageIds: string[] = [];
	const storeImage = async (data: string | undefined, caption: string) => {
		const m = /^data:image\/jpeg;base64,(.+)$/.exec(data ?? '');
		if (!m) return undefined;
		const bytes = Buffer.from(m[1], 'base64');
		const id = await putAttachment(
			tx,
			o,
			ids,
			itemId,
			`${(j.run_id ?? 'run').replace(/[^\w-]/g, '')}-${imageIds.length + 1}.jpg`,
			caption,
			'ui-shot',
			'private',
			[j.run_id ?? ''],
			bytes,
			createHash('sha256').update(bytes).digest('hex'),
			dayStart(a.added)
		);
		imageIds.push(id);
		addAttachments(1);
		return id;
	};
	for (const r of j.rows ?? []) {
		for (const s of r.shots ?? []) {
			const image = await storeImage(
				s.image,
				`${s.role} ${s.route} ${s.brand ?? ''} ${s.viewport}`
			);
			results.push({
				page: s.route ?? r.page ?? '',
				state: r.state === 'none' ? '' : (r.state ?? ''),
				theme: s.brand ?? r.brands?.[0] ?? '',
				viewport: Number(s.viewport) || 0,
				side: s.role === 'before' ? 'before' : s.role === 'sibling' ? 'sibling' : 'after',
				values: firstOf(s.measure) as never,
				image,
				of: s.role === 'sibling' ? r.page : undefined
			});
		}
		for (const f of r.flags ?? [])
			flags.push({
				level: String(f.level ?? ''),
				kind: `imported-${String(f.severity ?? 'note').toLowerCase()}`,
				text: String(f.message ?? ''),
				page: f.route ? String(f.route) : undefined,
				theme: f.brand ? String(f.brand) : undefined,
				viewport: f.viewport ? Number(f.viewport) : undefined
			});
	}
	for (const [k, s] of Object.entries(j.siblings ?? {})) {
		const [brand, vp] = k.split('|');
		const image = await storeImage(s.image, `sibling ${s.route} ${brand} ${vp}`);
		results.push({
			page: s.route ?? '',
			state: '',
			theme: brand,
			viewport: Number(vp) || 0,
			side: 'sibling',
			values: {},
			image
		});
	}
	const started = dayStart(a.added);
	await tx.insert(uiShotRun).values({
		orgId: ids.orgId,
		projectId: ids.projectId,
		itemId,
		kind: 'shots',
		state: 'done',
		target: targetOf(j.target),
		afterCommit: j.git?.commit ?? null,
		diffHash: j.git?.dirty_hash ?? null,
		changedPaths: j.git?.changed_paths ?? [],
		results,
		flags,
		imageAttachmentIds: imageIds,
		reason: `Imported from HAPR run ${j.run_id ?? a.file}. The result file is attached as ${a.file}.`,
		startedAt: started,
		finishedAt: started,
		createdAt: started
	});
	return 1;
}

// -- TASKS -- //

const TASK_STATUS: Record<string, string> = {
	TODO: 'TODO',
	'IN PROGRESS': 'IN PROGRESS',
	DONE: 'DONE',
	DROPPED: 'DROPPED',
	FUTURE: 'FUTURE'
};

async function writeTasks(o: ImportOptions, ids: Ids, tasks: ParsedTask[], notes: string[]) {
	if (!tasks.length) return 0;
	return withTenant(
		o.handle,
		{ orgId: ids.orgId, projectId: ids.projectId, userId: o.ownerUserId },
		async (tx) => {
			const aliasRows = await tx
				.select({ alias: itemAlias.alias, itemId: itemAlias.itemId })
				.from(itemAlias);
			const byAlias = new Map(aliasRows.map((r) => [r.alias, r.itemId]));
			let n = 0;
			for (const t of tasks) {
				const [exists] = await tx
					.select({ id: task.id })
					.from(task)
					.where(eq(task.number, t.number));
				if (exists) continue;
				const linked = [
					...new Set(
						(t.links.match(FLOW_ID) ?? [])
							.map((id) => byAlias.get(id))
							.filter((x): x is string => Boolean(x))
					)
				];
				if (!(t.status in TASK_STATUS))
					notes.push(`T-${t.number}: the status ${t.status} was kept as TODO`);
				await tx.insert(task).values({
					orgId: ids.orgId,
					projectId: ids.projectId,
					number: t.number,
					title: t.title,
					status: TASK_STATUS[t.status] ?? 'TODO',
					body: [
						t.task && `Task: ${t.task}`,
						t.links && `Links: ${t.links}`,
						t.notes && `Notes: ${t.notes}`,
						t.updated && `Updated: ${t.updated}`
					]
						.filter(Boolean)
						.join('\n\n'),
					groupName: t.group || null,
					priority: t.priority && t.priority !== '-' ? t.priority : null,
					linkedItemIds: linked,
					createdAt: t.updated ? dayStart(t.updated.slice(0, 10)) : new Date()
				});
				n++;
			}
			return n;
		}
	);
}

/** Imports a read board. Safe to run again: items that already have their FLOW id as an alias are skipped. */
export async function importBoard(board: SourceBoard, o: ImportOptions): Promise<ImportSummary> {
	const log = o.log ?? (() => undefined);
	const ids = await ensureOrgAndProject(o);
	const notes = [...board.notes];
	const tenant = { orgId: ids.orgId, projectId: ids.projectId, userId: o.ownerUserId };
	const [counter] = await withTenant(o.handle, tenant, (tx) =>
		tx.select().from(projectCounter).where(eq(projectCounter.projectId, ids.projectId))
	);
	let next = counter.next;
	type Entry = { id: string; src: Source };
	const entries: Entry[] = [
		...board.items.map((i) => ({ id: i.json.id, src: i as Source })),
		...removedSources(board).map((src) => ({ id: flowIdOf(src), src }))
	].sort((a, b) => a.id.localeCompare(b.id, 'en'));
	const summary: ImportSummary = {
		...ids,
		imported: 0,
		skipped: 0,
		removedRows: 0,
		tasks: 0,
		attachments: 0,
		checkRuns: 0,
		uiShotRuns: 0,
		notes
	};
	for (const e of entries) {
		const [have] = await withTenant(o.handle, tenant, (tx) =>
			tx.select({ itemId: itemAlias.itemId }).from(itemAlias).where(eq(itemAlias.alias, e.id))
		);
		if (have) {
			summary.skipped++;
			continue;
		}
		const c = await writeItem(o, ids, next++, e.src, board.idMap, notes);
		summary.imported++;
		if ('removed' in e.src) summary.removedRows++;
		summary.attachments += c.attachments;
		summary.checkRuns += c.checkRuns;
		summary.uiShotRuns += c.uiShotRuns;
		log(`${e.id} imported (${summary.imported}/${entries.length - summary.skipped})`);
	}
	await withTenant(o.handle, tenant, (tx) =>
		tx
			.update(projectCounter)
			.set({ next: sql`greatest(${projectCounter.next}, ${next})` })
			.where(eq(projectCounter.projectId, ids.projectId))
	);
	summary.tasks = await writeTasks(o, ids, board.tasks, notes);
	const maxTask = Math.max(0, ...board.tasks.map((t) => t.number));
	await withTenant(o.handle, tenant, (tx) =>
		tx
			.update(projectCounter)
			.set({ nextTask: sql`greatest(${projectCounter.nextTask}, ${maxTask + 1})` })
			.where(eq(projectCounter.projectId, ids.projectId))
	);
	return summary;
}
